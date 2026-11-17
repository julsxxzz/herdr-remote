import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNotifier } from '../src/notifier.js';

function setup(over = {}) {
  const state = { deskMode: false, notifyBlocked: true, notifyDone: true, ...over };
  const sent = [];
  const push = { sendAll: async (p) => { sent.push(p); return { sent: 1, removed: 0 }; } };
  const n = createNotifier({ state, push, log: () => {} });
  return { n, state, sent };
}
const tr = (from, to, over = {}) => ({
  address: 't1', from, to, turn: 3,
  item: { agent: 'Claude Code', space: 'api', title: 'SECRET', activity: 'SECRET', message: 'SECRET', progress: 5, cwd: 'SECRET' },
  ...over,
});

test('working->done notifies with exact title and payload keys', () => {
  const { n, sent } = setup();
  n.onTransition(tr('working', 'done'));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].title, 'Claude Code in api finished — waiting for you');
  assert.deepEqual(Object.keys(sent[0]).sort(), ['address', 'body', 'tag', 'title', 'url']);
  assert.deepEqual(sent[0], { title: sent[0].title, body: 'Tap to open', address: 't1', tag: 't1', url: '/#/t/t1' });
});

test('idle->blocked notifies', () => {
  const { n, sent } = setup();
  n.onTransition(tr('idle', 'blocked'));
  assert.equal(sent[0].title, 'Claude Code in api needs you');
});

test('non-notifying transitions are ignored', () => {
  const { n, sent } = setup();
  n.onTransition(tr('blocked', 'blocked'));
  n.onTransition(tr('done', 'idle'));
  n.onTransition(tr('idle', 'done'));
  assert.equal(sent.length, 0);
});

test('repeated identical transition sends one push', () => {
  const { n, sent } = setup();
  n.onTransition(tr('working', 'blocked'));
  n.onTransition(tr('working', 'blocked'));
  assert.equal(sent.length, 1);
  n.onTransition(tr('idle', 'blocked', { turn: 4 }));
  assert.equal(sent.length, 2);
});

test('blocked -> working -> blocked in one turn sends two pushes', () => {
  const { n, sent } = setup();
  n.onTransition(tr('idle', 'blocked'));
  n.onTransition(tr('blocked', 'working'));
  n.onTransition(tr('working', 'blocked'));
  assert.equal(sent.length, 2);
});

test('deskMode suppresses, read at transition time', () => {
  const { n, state, sent } = setup({ deskMode: true });
  n.onTransition(tr('idle', 'blocked'));
  assert.equal(sent.length, 0);
  state.deskMode = false;
  n.onTransition(tr('idle', 'blocked'));
  assert.equal(sent.length, 1);
});

test('notifyDone false ignores done but not blocked', () => {
  const { n, sent } = setup({ notifyDone: false });
  n.onTransition(tr('working', 'done'));
  n.onTransition(tr('idle', 'blocked'));
  assert.equal(sent.length, 1);
  assert.match(sent[0].title, /needs you/);
});

test('notifyBlocked false ignores blocked', () => {
  const { n, sent } = setup({ notifyBlocked: false });
  n.onTransition(tr('idle', 'blocked'));
  assert.equal(sent.length, 0);
});

test('visible client suppresses that address only', () => {
  const { n, sent } = setup();
  n.setVisible('c1', 't1');
  n.onTransition(tr('idle', 'blocked'));
  n.onTransition(tr('idle', 'blocked', { address: 't2' }));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].address, 't2');
  n.setVisible('c1', null);
  n.onTransition(tr('idle', 'blocked', { turn: 9 }));
  assert.equal(sent.length, 2);
});

test('never throws or rejects when sendAll fails', async () => {
  const state = { deskMode: false, notifyBlocked: true, notifyDone: true };
  const logs = [];
  const n = createNotifier({ state, push: { sendAll: async () => { throw new Error('x'); } }, log: (m) => logs.push(m) });
  n.onTransition(tr('idle', 'blocked'));
  const n2 = createNotifier({ state, push: { sendAll: () => { throw new Error('y'); } }, log: (m) => logs.push(m) });
  n2.onTransition(tr('idle', 'blocked'));
  n2.onTransition(null);
  await new Promise((r) => setImmediate(r));
  assert.equal(logs.length, 3);
});
