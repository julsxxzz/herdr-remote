import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { startServer } from '../src/main.js';
import { createHc } from '../src/hc.js';
import { hashPin } from '../src/auth.js';
import { generateVapidKeys } from '../src/push.js';
import { saveConfig, saveState, DEFAULT_STATE } from '../src/config.js';

const fakeHcPath = fileURLToPath(new URL('./fixtures/fake-hc.mjs', import.meta.url));
const ORIGIN = 'http://127.0.0.1:4780';
const silent = { log() {}, warn() {}, error() {}, info() {} };
const lines = (...objs) => objs.map((o) => JSON.stringify(o)).join('\n') + '\n';
const snapshot = (status) => ({
  channel: null,
  seq: 1,
  terminals: [
    { address: 't1', state: 'live', status: { app: 'claude-code', state: status }, turn: 1, cols: 80, rows: 24, labels: { where: 'demo / 1' }, foreground: { name: 'claude' }, argv: [], cwd: 'C:\\work\\demo' },
    { address: 't2', state: 'finished', status: null, turn: 0, labels: { where: 'demo / 2' } },
  ],
});
const statusEvent = (state) => ({ jsonrpc: '2.0', method: 'event', params: { type: 'status', terminal: 't1', seq: 2, data: { status: { app: 'claude-code', state } } } });

let dirs = [];
let running = null;
let sockets = [];

afterEach(async () => {
  for (const s of sockets) s.terminate();
  sockets = [];
  await running?.stop();
  running = null;
  await new Promise((r) => setTimeout(r, 150));
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  dirs = [];
});

const waitFor = async (fn, ms = 2000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail('condition not met in time');
};

function mkdirs() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'main-home-'));
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'main-fake-'));
  dirs.push(home, fake);
  return { home, fake };
}

const validConfig = () => ({
  access: 'proxy',
  publicOrigin: ORIGIN,
  port: 0,
  bind: '127.0.0.1',
  pinHash: hashPin('123456'),
  vapid: generateVapidKeys(),
});

const makeHc = (fake) => createHc({ command: process.execPath, prefixArgs: [fakeHcPath], env: { ...process.env, FAKE_HC_DIR: fake } });

async function boot({ events, state, webpush } = {}) {
  const { home, fake } = mkdirs();
  fs.writeFileSync(path.join(fake, 'events.jsonl'), events ?? lines(snapshot('working')));
  saveConfig(home, validConfig());
  if (state) saveState(home, { ...structuredClone(DEFAULT_STATE), ...state });
  running = await startServer({ home, log: silent, hcOverride: makeHc(fake), webpushOverride: webpush });
  return { home, fake };
}

function req(method, p, { cookie, body } = {}) {
  return new Promise((resolve, reject) => {
    const h = {};
    if (cookie) h.cookie = cookie;
    let payload;
    if (method !== 'GET') {
      h.origin = ORIGIN;
      h['content-type'] = 'application/json';
      payload = JSON.stringify(body ?? {});
      h['content-length'] = Buffer.byteLength(payload);
    }
    const r = http.request({ host: '127.0.0.1', port: running.port, method, path: p, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data;
        try { data = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, text, data });
      });
    });
    r.on('error', reject);
    if (payload !== undefined) r.write(payload);
    r.end();
  });
}

async function login() {
  const r = await req('POST', '/api/login', { body: { pin: '123456' } });
  assert.equal(r.status, 204);
  return r.headers['set-cookie'][0].split(';')[0];
}

function openList(cookie) {
  const ws = new WebSocket(`ws://127.0.0.1:${running.port}/ws/list`, { headers: { cookie, origin: ORIGIN } });
  sockets.push(ws);
  const info = { ws, msgs: [], closed: null };
  ws.on('message', (d) => info.msgs.push(JSON.parse(d.toString())));
  ws.on('close', (code) => { info.closed = code; });
  ws.on('error', () => {});
  return info;
}

test('empty home rejects with setup hint', async () => {
  const { home } = mkdirs();
  await assert.rejects(startServer({ home, log: silent }), (e) => e.message.startsWith('Run "npm run setup" first:'));
});

test('starts, serves /, logs in, lists the fake terminals', async () => {
  await boot();
  assert.ok(running.port > 0);
  assert.equal((await req('GET', '/')).status, 200);
  const cookie = await login();
  const items = await waitFor(async () => {
    const r = await req('GET', '/api/terminals', { cookie });
    return r.data?.items?.length ? r.data.items : null;
  });
  assert.deepEqual(items.map((i) => i.address), ['t1']);
});

test('working -> done transition reaches the fake webpush', async () => {
  const sent = [];
  const webpush = {
    setVapidDetails() {},
    sendNotification: async (sub, body) => { sent.push({ sub, payload: JSON.parse(body) }); },
  };
  const sub = { endpoint: 'https://push.example/abc', keys: { p256dh: 'p', auth: 'a' } };
  await boot({
    events: lines(snapshot('working'), statusEvent('done')),
    state: { subscriptions: [sub] },
    webpush,
  });
  await waitFor(() => sent.length >= 1);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.title, 'Claude Code in demo finished — waiting for you');
  assert.equal(sent[0].sub.endpoint, sub.endpoint);
});

test('settings change is broadcast to open list sockets (R10)', async () => {
  await boot();
  const cookie = await login();
  const l = openList(cookie);
  await waitFor(() => l.msgs.length >= 1);
  assert.equal(l.msgs.at(-1).type, 'list');
  assert.equal((await req('PUT', '/api/settings', { cookie, body: { deskMode: true } })).status, 200);
  await waitFor(() => l.msgs.at(-1)?.deskMode === true);
});

test('logout-everywhere closes open sockets with 4401 (R11)', async () => {
  await boot();
  const cookie = await login();
  const l = openList(cookie);
  await waitFor(() => l.msgs.length >= 1);
  assert.equal((await req('POST', '/api/logout-everywhere', { cookie })).status, 204);
  await waitFor(() => l.closed !== null);
  assert.equal(l.closed, 4401);
});

test('stop() closes the port and kills the events child', async () => {
  const { fake } = await boot();
  const callsFile = path.join(fake, 'calls.jsonl');
  await waitFor(() => fs.existsSync(callsFile));
  const port = running.port;
  await running.stop();
  running = null;
  await assert.rejects(new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => { s.destroy(); resolve(); });
    s.on('error', reject);
  }));
  // A live child would hold the fake dir (Windows); removal succeeding means it exited.
  await waitFor(() => {
    try { fs.rmSync(fake, { recursive: true, force: true }); } catch { return false; }
    return !fs.existsSync(fake);
  });
});

async function occupyPort() {
  const blocker = net.createServer((s) => s.destroy());
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
  return blocker;
}
const IN_USE = (p) => `port ${p} already in use — is herdr-remote already running?`;

test('M5: a second instance on a busy port rejects with PORT_IN_USE', async () => {
  const { home, fake } = mkdirs();
  const blocker = await occupyPort();
  const port = blocker.address().port;
  try {
    saveConfig(home, { ...validConfig(), port });
    await assert.rejects(startServer({ home, log: silent, hcOverride: makeHc(fake) }),
      (e) => e.code === 'PORT_IN_USE' && e.message === IN_USE(port));
  } finally {
    await new Promise((r) => blocker.close(r));
  }
});

test('M5: cli start --foreground exits 78 with a clear line when the port is busy', async () => {
  const { home } = mkdirs();
  const blocker = await occupyPort();
  const port = blocker.address().port;
  try {
    // hcPath points at nothing, so no real hc is ever run.
    saveConfig(home, { ...validConfig(), port, hcPath: path.join(home, 'no-such-hc.exe') });
    const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
    const child = spawn(process.execPath, [cli, 'start', '--foreground', '--home', home], { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdout.resume();
    const code = await new Promise((r) => child.on('exit', r));
    assert.equal(code, 78);
    assert.ok(stderr.includes(IN_USE(port)), stderr);
  } finally {
    await new Promise((r) => blocker.close(r));
  }
});
