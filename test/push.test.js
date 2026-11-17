import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPush, generateVapidKeys } from '../src/push.js';

const sub = (n) => ({ endpoint: `https://push.example.com/${n}`, keys: { p256dh: `p${n}`, auth: `a${n}` } });

function setup(sendNotification) {
  const calls = [];
  const detailsSet = [];
  const webpush = {
    setVapidDetails: (...a) => detailsSet.push(a),
    sendNotification: async (s, body, opts) => {
      calls.push({ s, body, opts });
      return sendNotification ? sendNotification(s, body, opts) : {};
    },
    generateVAPIDKeys: () => ({ publicKey: 'pub', privateKey: 'priv' }),
  };
  const state = { subscriptions: [] };
  let saves = 0;
  const logs = [];
  const push = createPush({
    vapid: { publicKey: 'pub', privateKey: 'priv' },
    subject: 'https://demo.example.com',
    state,
    saveState: () => { saves++; },
    webpush,
    log: (m) => logs.push(m),
  });
  return { push, state, calls, detailsSet, logs, saves: () => saves };
}

test('exposes public key and sets vapid details', () => {
  const { push, detailsSet } = setup();
  assert.equal(push.publicKey, 'pub');
  assert.deepEqual(detailsSet[0], ['https://demo.example.com', 'pub', 'priv']);
});

test('subscribe dedupes by endpoint', () => {
  const { push, state } = setup();
  push.subscribe(sub('a'));
  push.subscribe(sub('a'));
  assert.equal(state.subscriptions.length, 1);
});

test('unsubscribe removes and saves', () => {
  const { push, state, saves } = setup();
  push.subscribe(sub('a'));
  push.unsubscribe(sub('a').endpoint);
  assert.equal(state.subscriptions.length, 0);
  assert.ok(saves() >= 2);
});

test('sendAll stringifies the object, uses TTL/urgency, prunes 410', async () => {
  const A = sub('a');
  const B = sub('b');
  const { push, state, calls, saves } = setup(async (s) => {
    if (s.endpoint === A.endpoint) throw Object.assign(new Error('gone'), { statusCode: 410 });
    return {};
  });
  push.subscribe(A);
  push.subscribe(B);
  const before = saves();
  const r = await push.sendAll({ title: 't', body: 'b' });
  assert.deepEqual(r, { sent: 1, removed: 1 });
  assert.deepEqual(state.subscriptions.map((s) => s.endpoint), [B.endpoint]);
  assert.ok(saves() > before);
  assert.equal(calls[0].body, JSON.stringify({ title: 't', body: 'b' }));
  assert.deepEqual(calls[0].opts, { TTL: 3600, urgency: 'high' });
});

test('404 also removes; other errors are logged and kept', async () => {
  const { push, state, logs } = setup(async (s) => {
    if (s.endpoint.endsWith('/a')) throw Object.assign(new Error('nf'), { statusCode: 404 });
    throw Object.assign(new Error('boom'), { statusCode: 500 });
  });
  push.subscribe(sub('a'));
  push.subscribe(sub('b'));
  const r = await push.sendAll({ title: 't' });
  assert.deepEqual(r, { sent: 0, removed: 1 });
  assert.equal(state.subscriptions.length, 1);
  assert.ok(logs.length >= 1);
});

test('generateVapidKeys wraps webpush', () => {
  const k = generateVapidKeys();
  assert.ok(k.publicKey && k.privateKey);
});
