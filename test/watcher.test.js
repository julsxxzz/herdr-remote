import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createHc } from '../src/hc.js';
import { TerminalStore } from '../src/terminals.js';
import { startWatcher } from '../src/watcher.js';

const fakeHcPath = fileURLToPath(new URL('./fixtures/fake-hc.mjs', import.meta.url));
const silent = { error() {}, warn() {}, log() {}, info() {} };
let dir;
let hc;
let watcher;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-hc-'));
  hc = createHc({
    command: process.execPath,
    prefixArgs: [fakeHcPath],
    env: { ...process.env, FAKE_HC_DIR: dir },
  });
});

afterEach(async () => {
  watcher?.stop();
  watcher = null;
  await sleep(150); // let killed children go away before removing the dir
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const put = (name, content) => fs.writeFileSync(path.join(dir, name), content);
const calls = () => {
  const p = path.join(dir, 'calls.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
};
const eventsCalls = () => calls().filter((c) => c[0] === 'events').length;
const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await sleep(10);
  }
  assert.fail('condition not met in time');
};
const term = (address, status) => ({
  address,
  state: 'live',
  status: { app: 'claude-code', state: status },
  turn: 1,
  labels: { where: 'demo / 1' },
});
const lines = (...objs) => objs.map((o) => JSON.stringify(o)).join('\n') + '\n';
const ev = (type, terminal, seq, data = {}) => ({ jsonrpc: '2.0', method: 'event', params: { type, terminal, seq, data } });
const start = (store, opts = {}) =>
  (watcher = startWatcher({ hc, store, log: silent, backoffMs: [50], pollMs: 50, ...opts }));

test('snapshot then events reach the store; initial snapshot emits no transitions', async () => {
  put('events.jsonl', lines(
    { channel: null, seq: 10, terminals: [term('t1', 'working')] },
    ev('status', 't1', 11, { status: { app: 'claude-code', state: 'blocked', kind: 'permission' } }),
  ));
  const store = new TerminalStore();
  const transitions = [];
  store.on('transition', (t) => transitions.push(t));
  start(store);
  await until(() => store.get('t1')?.status === 'blocked');
  assert.equal(store.seq, 11);
  assert.equal(transitions.length, 1);
  assert.deepEqual([transitions[0].from, transitions[0].to], ['working', 'blocked']);
});

test('unparseable lines are logged and skipped', async () => {
  put('events.jsonl', 'garbage\n' + lines({ channel: null, seq: 1, terminals: [term('t1', 'idle')] }));
  const store = new TerminalStore();
  let logged = 0;
  start(store, { log: { ...silent, warn: () => logged++, error: () => logged++ } });
  await until(() => store.get('t1'));
  assert.ok(logged >= 1);
});

test('when events exits, store is refreshed from ls and events is respawned', async () => {
  put('events.jsonl', '');
  put('events-exit', '');
  put('ls.json', JSON.stringify({ hidden_finished: 0, terminals: [{ address: 't7', agent: 'Codex', state: 'live', status: 'working', turn: 2, where: 'demo / 1' }] }));
  const store = new TerminalStore();
  start(store);
  await until(() => store.get('t7')?.status === 'working', 1500);
  await until(() => eventsCalls() >= 2, 1500);
});

test('a missed event kills the child and a fresh one is spawned', async () => {
  put('events.jsonl', lines(
    { channel: null, seq: 1, terminals: [term('t1', 'idle')] },
    ev('missed', null, 2),
  ));
  const store = new TerminalStore();
  start(store);
  await until(() => eventsCalls() >= 2);
});

test('stop() ends all activity', async () => {
  put('events.jsonl', lines({ channel: null, seq: 1, terminals: [term('t1', 'idle')] }));
  const store = new TerminalStore();
  start(store);
  await until(() => store.get('t1'));
  watcher.stop();
  await sleep(100);
  const n = calls().length;
  await sleep(250);
  assert.equal(calls().length, n);
});

test('a missing hc binary is treated like an exit and retried', async () => {
  const bad = createHc({ command: path.join(dir, 'no-such-hc'), env: process.env });
  const store = new TerminalStore();
  let errors = 0;
  watcher = startWatcher({ hc: { ...bad, ls: async () => { errors++; throw new Error('x'); } }, store, log: silent, backoffMs: [20], pollMs: 20 });
  await until(() => errors >= 2);
});

const lsCalls = () => calls().filter((c) => c[0] === 'ls').length;
const LS_ONE = JSON.stringify({ hidden_finished: 0, terminals: [{ address: 't7', agent: 'Codex', state: 'live', status: 'working', turn: 2, where: 'demo / 1' }] });

test('M1: a silent events child (no line for stallMs) is killed and respawned', async () => {
  put('events.jsonl', lines({ channel: null, seq: 1, terminals: [term('t1', 'idle')] }));
  put('ls.json', LS_ONE);
  const store = new TerminalStore();
  start(store, { stallMs: 150 });
  await until(() => eventsCalls() >= 2, 2000);
});

test('M1: a healthy feed (lines within stallMs) is not restarted', async () => {
  put('events.jsonl', lines({ channel: null, seq: 1, terminals: [term('t1', 'idle')] }));
  const store = new TerminalStore();
  start(store, { stallMs: 5000 });
  await until(() => store.get('t1'));
  await sleep(300);
  assert.equal(eventsCalls(), 1);
});

test('M1: ls polling keeps running after a respawn until the first snapshot line', async () => {
  put('events.jsonl', ''); // children stay up but never send a snapshot
  put('ls.json', LS_ONE);
  const store = new TerminalStore();
  start(store, { stallMs: 400, backoffMs: [20], pollMs: 30 });
  await until(() => eventsCalls() >= 2, 3000); // first child stalled, second spawned
  const before = lsCalls();
  await sleep(250); // second child still silent, within stallMs
  assert.ok(lsCalls() - before >= 3, `ls polled ${lsCalls() - before} times`);
  assert.equal(store.get('t7')?.status, 'working');
});

// An in-process stand-in for an `hc events` child.
function fakeProc() {
  const p = new EventEmitter();
  p.stdout = new PassThrough();
  p.stderr = new PassThrough();
  p.exitCode = null;
  p.signalCode = null;
  p.kills = 0;
  p.kill = () => { p.kills++; return true; };
  return p;
}

test('B14: hc.events() throwing synchronously is retried instead of crashing', async () => {
  const store = new TerminalStore();
  let tries = 0;
  const warnings = [];
  const stub = { events: () => { tries++; throw Object.assign(new Error('spawn EINVAL'), { code: 'EINVAL' }); }, ls: async () => [] };
  watcher = startWatcher({ hc: stub, store, log: { ...silent, warn: (m) => warnings.push(m) }, backoffMs: [20], pollMs: 1000 });
  await until(() => tries >= 3);
  assert.ok(warnings.some((m) => m.includes('EINVAL')), warnings.join(' | '));
});

test('B15: an error on a still-alive events child kills it before restarting', async () => {
  const store = new TerminalStore();
  const procs = [];
  const stub = { events: () => { const p = fakeProc(); procs.push(p); return p; }, ls: async () => [] };
  watcher = startWatcher({ hc: stub, store, log: silent, backoffMs: [20], pollMs: 1000 });
  procs[0].emit('error', new Error('pipe broke'));
  assert.equal(procs[0].kills, 1);
  await until(() => procs.length >= 2);
});

test('B16: stop() aborts an in-flight hc ls and no callbacks run after stop', async () => {
  const store = new TerminalStore();
  const signals = [];
  let resolveLs;
  const warnings = [];
  const stub = {
    events: () => { const p = fakeProc(); setImmediate(() => p.emit('close', 1)); return p; },
    ls: ({ signal } = {}) => { signals.push(signal); return new Promise((r, reject) => { resolveLs = r; signal?.addEventListener('abort', () => reject(new Error('aborted'))); }); },
  };
  let changed = 0;
  store.on('changed', () => changed++);
  watcher = startWatcher({ hc: stub, store, log: { ...silent, warn: (m) => warnings.push(m) }, backoffMs: [5000], pollMs: 5000 });
  await until(() => signals.length >= 1);
  const warned = warnings.length;
  watcher.stop();
  assert.equal(signals[0]?.aborted, true);
  resolveLs([]);
  await sleep(50);
  assert.equal(changed, 0);
  assert.equal(warnings.length, warned);
});

test('B16: hc.ls passes its abort signal to the spawned child', async () => {
  put('ls.json', LS_ONE);
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(hc.ls({ signal: ac.signal }), (e) => e.name === 'AbortError');
});

test('B16: stop() clears the current child\'s stall timer even if it never closes', async () => {
  const store = new TerminalStore();
  const procs = [];
  const warnings = [];
  const stub = { events: () => { const p = fakeProc(); procs.push(p); return p; }, ls: async () => [] };
  watcher = startWatcher({ hc: stub, store, log: { ...silent, warn: (m) => warnings.push(m) }, stallMs: 100 });
  watcher.stop();
  assert.equal(procs[0].kills, 1);
  await sleep(300);
  assert.equal(procs[0].kills, 1); // the stall timer did not fire after stop
  assert.deepEqual(warnings, []);
});
