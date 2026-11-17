import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TerminalStore, toListItem, displayAgent, lsToTerminal, URGENCY } from '../src/terminals.js';

const claude = (address, state, where, extra = {}) => ({
  address,
  state: 'live',
  status: { app: 'claude-code', state },
  turn: 3,
  cols: 80,
  rows: 24,
  cwd: 'C:\\work\\demo',
  labels: { where },
  foreground: { name: 'claude' },
  argv: ['C:\\tools\\claude.exe'],
  ...extra,
});

function snapshot() {
  return {
    seq: 91,
    terminals: [
      claude('t1', 'done', 'demo / 1'),
      claude('t2', 'blocked', 'api / 1', { status: { app: 'codex', state: 'blocked', kind: 'permission' } }),
      claude('t3', 'done', 'demo / 2', { state: 'finished' }),
    ],
  };
}

function collect(store) {
  const out = [];
  store.on('transition', (e) => out.push(e));
  return out;
}

test('reset without transitions lists live terminals by urgency', () => {
  const s = new TerminalStore();
  const tr = collect(s);
  s.reset(snapshot(), { emitTransitions: false });
  assert.equal(tr.length, 0);
  assert.equal(s.seq, 91);
  assert.deepEqual(s.list().map((i) => i.address), ['t2', 't1']);
  assert.equal(s.get('t3'), null);
});

test('status events emit transitions with current turn', () => {
  const s = new TerminalStore();
  s.reset(snapshot(), { emitTransitions: false });
  const tr = collect(s);
  s.apply({ type: 'status', terminal: 't1', seq: 92, data: { status: { app: 'claude-code', state: 'working' } } });
  s.apply({ type: 'status', terminal: 't1', seq: 93, data: { status: { app: 'claude-code', state: 'done' } } });
  assert.deepEqual(tr.map((e) => [e.address, e.from, e.to, e.turn]), [
    ['t1', 'done', 'working', 3],
    ['t1', 'working', 'done', 3],
  ]);
  assert.equal(tr[0].item.status, 'working');
  assert.equal(s.seq, 93);
});

test('events with seq <= current are ignored', () => {
  const s = new TerminalStore();
  s.reset(snapshot(), { emitTransitions: false });
  const tr = collect(s);
  let changed = 0;
  s.on('changed', () => changed++);
  s.apply({ type: 'status', terminal: 't1', seq: 91, data: { status: { app: 'x', state: 'working' } } });
  s.apply({ type: 'status', terminal: 't1', seq: 50, data: { status: { app: 'x', state: 'working' } } });
  assert.equal(tr.length, 0);
  assert.equal(changed, 0);
  assert.equal(s.get('t1').status, 'done');
});

test('created, labels, size, finished, removed', () => {
  const s = new TerminalStore();
  s.reset(snapshot(), { emitTransitions: false });
  let changed = 0;
  s.on('changed', () => changed++);
  s.apply({ type: 'created', terminal: 't9', seq: 92, data: { address: 't9', state: 'live', status: null, cols: 80, rows: 24, labels: { where: 'x / 1', other: 'keep' }, foreground: { name: 'powershell.exe' } } });
  assert.equal(s.get('t9').status, 'idle');
  s.apply({ type: 'labels', terminal: 't9', seq: 93, data: { labels: { where: 'api / 2' } } });
  assert.deepEqual([s.get('t9').space, s.get('t9').tab], ['api', '2']);
  assert.equal(s._records.get('t9').labels.other, 'keep');
  s.apply({ type: 'size', terminal: 't9', seq: 94, data: { cols: 90, rows: 30 } });
  assert.deepEqual([s.get('t9').cols, s.get('t9').rows], [90, 30]);
  s.apply({ type: 'heartbeat', terminal: 't9', seq: 95, data: {} });
  s.apply({ type: 'finished', terminal: 't9', seq: 96, data: { exit_code: 0, finished_ms: 1, reason: 'exit', signal: null } });
  assert.equal(s.list().some((i) => i.address === 't9'), false);
  s.apply({ type: 'removed', terminal: 't1', seq: 97, data: {} });
  assert.equal(s.get('t1'), null);
  assert.ok(changed >= 5);
});

test('created live terminal that is working transitions from idle; finish/remove emit none', () => {
  const s = new TerminalStore();
  s.reset({ seq: 1, terminals: [] }, { emitTransitions: false });
  const tr = collect(s);
  s.apply({ type: 'created', terminal: 't5', seq: 2, data: { address: 't5', state: 'live', status: { app: 'codex', state: 'working' }, turn: 1 } });
  s.apply({ type: 'finished', terminal: 't5', seq: 3, data: { exit_code: 0, finished_ms: 1, reason: 'exit', signal: null } });
  s.apply({ type: 'removed', terminal: 't5', seq: 4, data: {} });
  assert.deepEqual(tr.map((e) => [e.from, e.to]), [['idle', 'working']]);
});

test('reset with transitions compares old and new, and sets seq unconditionally', () => {
  const s = new TerminalStore();
  s.reset(snapshot(), { emitTransitions: false });
  const tr = collect(s);
  const snap = snapshot();
  snap.seq = 10;
  snap.terminals[0].status.state = 'working';
  s.reset(snap);
  assert.equal(s.seq, 10);
  assert.deepEqual(tr.map((e) => [e.address, e.from, e.to]), [['t1', 'done', 'working']]);
});

test('toListItem for plain shell and displayAgent', () => {
  const item = toListItem({ address: 't4', state: 'live', status: null, foreground: { name: 'powershell.exe' } });
  assert.equal(item.status, 'idle');
  assert.equal(item.agent, 'powershell');
  assert.equal(item.space, 'Other');
  assert.equal(item.tab, '');
  assert.equal(item.kind, null);
  assert.equal(displayAgent({ argv: ['C:\\bin\\pwsh.exe'] }), 'pwsh');
  assert.equal(displayAgent({}), '?');
  assert.equal(displayAgent({ status: { app: 'codex' } }), 'Codex');
  assert.deepEqual(URGENCY, { blocked: 0, error: 0, working: 1, done: 2, idle: 3 });
});

test('lsToTerminal maps an hc ls item', () => {
  const t = lsToTerminal({ address: 't1', agent: 'claude-code', cwd: 'C:\\work\\demo', state: 'live', status: 'done', turn: 4, where: 'demo / 1' });
  const item = toListItem(t);
  assert.equal(item.status, 'done');
  assert.equal(item.agent, 'Claude Code');
  assert.equal(item.space, 'demo');
  assert.equal(item.tab, '1');
  assert.equal(item.turn, 4);
});
