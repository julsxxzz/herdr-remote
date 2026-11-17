import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
