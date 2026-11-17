import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { createServer } from '../src/server.js';
import { attachWebSockets, parseHistory } from '../src/live.js';
import { createHc } from '../src/hc.js';
import { TerminalStore } from '../src/terminals.js';
import { hashPin, createSessions, createRateLimiter } from '../src/auth.js';
import { DEFAULT_STATE } from '../src/config.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const fakeHcPath = fileURLToPath(new URL('./fixtures/fake-hc.mjs', import.meta.url));
const ORIGIN = 'https://box.example.ts.net';
const LOGIN = 'owner@example.com';
const SCREEN = Buffer.from('\x1b[2Jhello\r\n');

let dir, srv, port, store, state, sessions, token, live, children, visible, sockets;

const waitFor = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail('condition not met in time');
};

async function start({ hcOverride, emptyStore = false, terminal = {}, ...opts } = {}) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-test-'));
  fs.writeFileSync(path.join(dir, 'screen.bin'), SCREEN);
  state = structuredClone(DEFAULT_STATE);
  store = new TerminalStore();
  if (!emptyStore) store.reset({
    seq: 1,
    terminals: [{
      address: 't1', state: 'live', status: { app: 'claude-code', state: 'working' }, turn: 1,
      cols: 80, rows: 24, labels: { where: 'demo / 1' }, foreground: { name: 'claude' }, argv: [], cwd: 'C:\\work\\demo',
      ...terminal,
    }],
  }, { emitTransitions: false });
  sessions = createSessions({ state, save: () => {} });
  token = sessions.create();
  const inner = createHc({ command: process.execPath, prefixArgs: [fakeHcPath], env: { ...process.env, FAKE_HC_DIR: dir } });
  children = [];
  const hc = hcOverride ?? { ...inner, observe: (...a) => { const c = inner.observe(...a); children.push(c); return c; } };
  const config = { access: 'tailscale', allowedLogin: LOGIN, publicOrigin: ORIGIN, pinHash: hashPin('123456') };
  srv = createServer({
    config, state, saveState: () => {}, hc, store, sessions, limiter: createRateLimiter(),
    push: { publicKey: 'K' }, publicDir: path.join(root, 'public'),
    vendorDir: path.join(root, 'node_modules', '@xterm', 'xterm'), log: () => {},
  });
  visible = [];
  live = attachWebSockets(srv, {
    config, state, store, hc, sessions, log: () => {},
    notifier: { setVisible: (id, a) => visible.push([id, a]) }, ...opts,
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  port = srv.address().port;
  sockets = [];
}

async function stop() {
  for (const s of sockets) s.terminate();
  live.close();
  srv.closeAllConnections?.();
  await new Promise((r) => srv.close(r));
  for (const c of children) c.kill();
  fs.rmSync(dir, { recursive: true, force: true });
}

beforeEach(() => start());
afterEach(stop);

async function restart(opts) {
  await stop();
  await start(opts);
}

function open(p, wsOpts = {}) {
  const headers = { cookie: `hr_session=${token}`, origin: ORIGIN, 'tailscale-user-login': LOGIN };
  const ws = new WebSocket(`ws://127.0.0.1:${port}${p}`, { headers, ...wsOpts });
  sockets.push(ws);
  const msgs = [];
  const info = { ws, msgs, closed: null };
  ws.on('message', (d, isBinary) => msgs.push(isBinary ? d : JSON.parse(d.toString())));
  ws.on('close', (code) => { info.closed = code; });
  ws.on('error', () => {});
  return info;
}

const rejected = (p, headers) => new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${p}`, { headers });
  sockets.push(ws);
  ws.on('unexpected-response', (_q, res) => { res.resume(); resolve(res.statusCode); });
  ws.on('error', () => {});
  ws.on('open', () => resolve('open'));
});

test('upgrade refused without session cookie, with wrong Origin, or wrong identity', async () => {
  const good = { cookie: `hr_session=${token}`, origin: ORIGIN, 'tailscale-user-login': LOGIN };
  assert.equal(await rejected('/ws/list', { origin: ORIGIN, 'tailscale-user-login': LOGIN }), 401);
  assert.equal(await rejected('/ws/list', { ...good, origin: 'https://evil.example' }), 403);
  assert.equal(await rejected('/ws/list', { ...good, 'tailscale-user-login': 'x@example.com' }), 403);
  assert.equal(await rejected('/ws/other', good), 404);
  assert.equal(await rejected('/ws/list', { cookie: good.cookie, 'tailscale-user-login': LOGIN }), 403);
});

test('/ws/list sends list, re-sends on change, relays visible, clears on close', async () => {
  const c = open('/ws/list');
  await waitFor(() => c.msgs.length === 1);
  assert.equal(c.msgs[0].type, 'list');
  assert.equal(c.msgs[0].items.length, 1);
  assert.equal(c.msgs[0].deskMode, state.deskMode);
  store.apply({ type: 'turn', terminal: 't1', seq: 2, data: { turn: 2 } });
  await waitFor(() => c.msgs.length === 2);
  assert.equal(c.msgs[1].items[0].turn, 2);
  c.ws.send(JSON.stringify({ type: 'visible', address: 't1' }));
  await waitFor(() => visible.length === 1);
  assert.equal(visible[0][1], 't1');
  c.ws.close();
  await waitFor(() => visible.length === 2);
  assert.equal(visible[1][1], null);
  assert.equal(visible[1][0], visible[0][0]);
});

test('/ws/list throttles bursts and still delivers the final state', async () => {
  const c = open('/ws/list');
  await waitFor(() => c.msgs.length === 1);
  for (let i = 0; i < 5; i++) store.apply({ type: 'turn', terminal: 't1', seq: 2 + i, data: { turn: 10 + i } });
  await waitFor(() => c.msgs.at(-1).items[0].turn === 14);
  assert.ok(c.msgs.length <= 3);
});

test('/ws/term sends size then binary screen', async () => {
  const c = open('/ws/term?address=t1&history=10');
  await waitFor(() => c.msgs.length >= 2);
  assert.deepEqual(c.msgs[0], { type: 'size', cols: 80, rows: 24 });
  assert.ok(Buffer.isBuffer(c.msgs[1]));
  assert.deepEqual(c.msgs[1], SCREEN);
});

test('/ws/term re-sends size when the terminal is resized', async () => {
  const c = open('/ws/term?address=t1');
  await waitFor(() => c.msgs.length >= 1);
  store.apply({ type: 'size', terminal: 't1', seq: 2, data: { cols: 100, rows: 30 } });
  await waitFor(() => c.msgs.some((m) => m.type === 'size' && m.cols === 100));
  assert.deepEqual(c.msgs.filter((m) => m.type === 'size').pop(), { type: 'size', cols: 100, rows: 30 });
});

test('closing the socket kills the observe child', async () => {
  const c = open('/ws/term?address=t1');
  await waitFor(() => c.msgs.length >= 2);
  assert.equal(children.length, 1);
  c.ws.close();
  await waitFor(() => children[0].exitCode !== null || children[0].signalCode !== null, 2000);
});

test('M3: attach exit while the terminal is still live closes 1011 without ended', async () => {
  fs.writeFileSync(path.join(dir, 'attach-exit'), '');
  const c = open('/ws/term?address=t1');
  await waitFor(() => c.closed !== null);
  assert.equal(c.closed, 1011);
  assert.ok(!c.msgs.some((m) => m.type === 'ended'));
});

test('M3: attach exit after the terminal is gone sends ended and closes 1000', async () => {
  fs.writeFileSync(path.join(dir, 'attach-exit'), '');
  await restart({
    hcOverride: {
      observe: () => {
        const e = new EventEmitter();
        e.kill = () => {};
        setImmediate(() => {
          store.reset({ seq: 5, terminals: [] }, { emitTransitions: false });
          e.emit('close', 0);
        });
        return e;
      },
    },
  });
  const c = open('/ws/term?address=t1');
  await waitFor(() => c.closed !== null);
  assert.equal(c.closed, 1000);
  assert.ok(c.msgs.some((m) => m.type === 'ended'));
});

test('M2: before the first snapshot /ws/term closes 1013 (retry), not 4404', async () => {
  await restart({ emptyStore: true });
  const a = open('/ws/term?address=t1');
  await waitFor(() => a.closed !== null);
  assert.equal(a.closed, 1013);
  store.reset({ seq: 1, terminals: [] }, { emitTransitions: false });
  const b = open('/ws/term?address=t1');
  await waitFor(() => b.closed !== null);
  assert.equal(b.closed, 4404);
});

test('M7: a terminal without cols/rows gets its size from hc get', async () => {
  await restart({ terminal: { cols: undefined, rows: undefined } });
  fs.writeFileSync(path.join(dir, 'get.json'), JSON.stringify({ address: 't1', state: 'live', cols: 132, rows: 50 }));
  const c = open('/ws/term?address=t1');
  await waitFor(() => c.msgs.length >= 2);
  assert.deepEqual(c.msgs[0], { type: 'size', cols: 132, rows: 50 });
  assert.deepEqual(c.msgs[1], SCREEN);
  const calls = fs.readFileSync(path.join(dir, 'calls.jsonl'), 'utf8');
  assert.ok(calls.includes('["get","t1","--json"]'));
  store.apply({ type: 'turn', terminal: 't1', seq: 2, data: { turn: 2 } });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(c.msgs.filter((m) => m.type === 'size').length, 1);
});

test('M7: falls back to 120x40 when hc get fails', async () => {
  await restart({ terminal: { cols: undefined, rows: undefined } });
  const c = open('/ws/term?address=t1');
  await waitFor(() => c.msgs.length >= 2);
  assert.deepEqual(c.msgs[0], { type: 'size', cols: 120, rows: 40 });
});

test('unknown or invalid address closes 4404; incoming messages are ignored', async () => {
  const a = open('/ws/term?address=nope');
  await waitFor(() => a.closed !== null);
  assert.equal(a.closed, 4404);
  const b = open('/ws/term?address=' + encodeURIComponent('t1; rm'));
  await waitFor(() => b.closed !== null);
  assert.equal(b.closed, 4404);
  const c = open('/ws/term?address=t1');
  await waitFor(() => c.msgs.length >= 2);
  c.ws.send('hello');
  c.ws.send(JSON.stringify({ type: 'send', text: 'x' }));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(c.closed, null);
  const calls = fs.readFileSync(path.join(dir, 'calls.jsonl'), 'utf8');
  assert.ok(!calls.includes('"send"') && !calls.includes('"keys"'));
});

test('observer limit closes 4429', async () => {
  await restart({ maxObservers: 1 });
  const a = open('/ws/term?address=t1');
  await waitFor(() => a.msgs.length >= 2);
  const b = open('/ws/term?address=t1');
  await waitFor(() => b.closed !== null);
  assert.equal(b.closed, 4429);
});

test('spawn error ends the stream instead of crashing', async () => {
  await restart({
    hcOverride: {
      observe: () => {
        const e = new EventEmitter();
        e.kill = () => {};
        setImmediate(() => e.emit('error', new Error('ENOENT')));
        return e;
      },
    },
  });
  const c = open('/ws/term?address=t1');
  await waitFor(() => c.closed !== null);
  assert.equal(c.closed, 1000);
  assert.ok(c.msgs.some((m) => m.type === 'ended'));
});

test('heartbeat terminates a /ws/term client that stops ponging and kills its child', async () => {
  await restart({ heartbeatMs: 100 });
  const c = open('/ws/term?address=t1', { autoPong: false });
  await waitFor(() => c.msgs.length >= 2);
  assert.equal(children.length, 1);
  await waitFor(() => children[0].exitCode !== null || children[0].signalCode !== null, 3000);
  await waitFor(() => c.closed !== null);
});

test('heartbeat terminates a silent /ws/list client and clears visibility; live clients survive', async () => {
  await restart({ heartbeatMs: 100 });
  const dead = open('/ws/list', { autoPong: false });
  const alive = open('/ws/list');
  await waitFor(() => dead.msgs.length === 1 && alive.msgs.length === 1);
  await waitFor(() => dead.closed !== null);
  assert.ok(visible.some(([, a]) => a === null));
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(alive.closed, null);
});

const dead = (c) => c.exitCode !== null || c.signalCode !== null;

test('finished terminal while watched: ended, close 1000, child killed', async () => {
  const c = open('/ws/term?address=t1');
  await waitFor(() => c.msgs.length >= 2);
  store.apply({ type: 'finished', terminal: 't1', seq: 2, data: { exit_code: 0, finished_ms: 1, reason: 'exit', signal: null } });
  await waitFor(() => c.closed !== null);
  assert.equal(c.closed, 1000);
  assert.ok(c.msgs.some((m) => m.type === 'ended'));
  await waitFor(() => dead(children[0]), 3000);
});

test('removed terminal while watched: ended, close 1000, child killed', async () => {
  const c = open('/ws/term?address=t1');
  await waitFor(() => c.msgs.length >= 2);
  store.apply({ type: 'removed', terminal: 't1', seq: 2, data: {} });
  await waitFor(() => c.closed !== null);
  assert.equal(c.closed, 1000);
  assert.ok(c.msgs.some((m) => m.type === 'ended'));
  await waitFor(() => dead(children[0]), 3000);
});

test('broadcastList immediately re-sends the list with current deskMode', async () => {
  const c = open('/ws/list');
  await waitFor(() => c.msgs.length === 1);
  state.deskMode = !state.deskMode;
  live.broadcastList();
  await waitFor(() => c.msgs.length === 2);
  assert.equal(c.msgs[1].deskMode, state.deskMode);
});

test('disconnectAll closes list and term sockets with 4401 and kills the child', async () => {
  const l = open('/ws/list');
  const t = open('/ws/term?address=t1');
  await waitFor(() => l.msgs.length === 1 && t.msgs.length >= 2);
  live.disconnectAll();
  await waitFor(() => l.closed !== null && t.closed !== null);
  assert.equal(l.closed, 4401);
  assert.equal(t.closed, 4401);
  await waitFor(() => dead(children[0]), 3000);
  assert.equal(visible.at(-1)[1], null);
});

test('B22: parseHistory accepts only plain digit strings', () => {
  assert.equal(parseHistory('10'), 10);
  assert.equal(parseHistory('99999'), 2000);
  assert.equal(parseHistory(null), 200);
  for (const raw of ['1e3', '0x10', '-5', ' 7', '7.0', '+7']) assert.equal(parseHistory(raw), 200, raw);
});

test('B20: list messages say whether the store has its first snapshot (ready)', async () => {
  await restart({ emptyStore: true });
  const c = open('/ws/list');
  await waitFor(() => c.msgs.length >= 1);
  assert.equal(c.msgs[0].ready, false);
  store.reset({ seq: 1, terminals: [] }, { emitTransitions: false });
  await waitFor(() => c.msgs.length >= 2);
  assert.equal(c.msgs.at(-1).ready, true);
});
