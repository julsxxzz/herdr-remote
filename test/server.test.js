import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createServer } from '../src/server.js';
import { createHc } from '../src/hc.js';
import { TerminalStore } from '../src/terminals.js';
import { hashPin, createSessions, createRateLimiter } from '../src/auth.js';
import { DEFAULT_STATE } from '../src/config.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const fakeHcPath = fileURLToPath(new URL('./fixtures/fake-hc.mjs', import.meta.url));
const ORIGIN = 'https://box.example.ts.net';
const LOGIN = 'owner@example.com';
const PIN = '123456';

let pinHash;
let dir;
let srv;
let port;
let state;
let saves;
let store;
let limiter;
let pushCalls;
let hookCalls;

before(() => {
  pinHash = hashPin(PIN);
});

const ident = { 'tailscale-user-login': LOGIN };

async function start(configOverrides = {}) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-test-'));
  state = structuredClone(DEFAULT_STATE);
  saves = 0;
  pushCalls = [];
  hookCalls = [];
  const save = () => { saves++; };
  store = new TerminalStore();
  store.reset({
    seq: 1,
    terminals: [{
      address: 't1', state: 'live', status: { app: 'claude-code', state: 'working' }, turn: 1,
      cols: 80, rows: 24, labels: { where: 'demo / 1' }, foreground: { name: 'claude' }, argv: [], cwd: 'C:\\work\\demo',
    }],
  }, { emitTransitions: false });
  limiter = createRateLimiter();
  srv = createServer({
    config: { access: 'tailscale', allowedLogin: LOGIN, publicOrigin: ORIGIN, pinHash, ...configOverrides },
    state,
    saveState: save,
    hc: createHc({ command: process.execPath, prefixArgs: [fakeHcPath], env: { ...process.env, FAKE_HC_DIR: dir } }),
    store,
    sessions: createSessions({ state, save }),
    limiter,
    push: {
      publicKey: 'K',
      subscribe: (s) => pushCalls.push(['sub', s]),
      unsubscribe: (e) => pushCalls.push(['unsub', e]),
      sendAll: async (payload) => { pushCalls.push(['sendAll', payload]); return { sent: 1, removed: 0 }; },
    },
    publicDir: path.join(root, 'public'),
    vendorDir: path.join(root, 'node_modules', '@xterm', 'xterm'),
    log: () => {},
    onSettingsChanged: () => hookCalls.push('settings'),
    onLogoutEverywhere: () => hookCalls.push('logout'),
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  port = srv.address().port;
}

beforeEach(async () => {
  if (srv?.listening) await new Promise((r) => srv.close(r));
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  await start();
});

after(async () => {
  if (srv?.listening) await new Promise((r) => srv.close(r));
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

function req(method, p, { headers = {}, body, cookie, json = true, id = true, origin = true } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...(id ? ident : {}), ...headers };
    if (cookie) h.cookie = cookie;
    let payload;
    if (method !== 'GET') {
      if (origin && !('origin' in h)) h.origin = ORIGIN;
      if (json && !('content-type' in h)) h['content-type'] = 'application/json';
      payload = typeof body === 'string' ? body : JSON.stringify(body ?? {});
      h['content-length'] = Buffer.byteLength(payload);
    }
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data;
        try { data = JSON.parse(text); } catch { data = undefined; }
        resolve({ status: res.statusCode, headers: res.headers, text, data });
      });
    });
    r.on('error', reject);
    if (payload !== undefined) r.write(payload);
    r.end();
  });
}

async function login() {
  const r = await req('POST', '/api/login', { body: { pin: PIN } });
  assert.equal(r.status, 204);
  return r.headers['set-cookie'][0].split(';')[0];
}

const calls = () => {
  const p = path.join(dir, 'calls.jsonl');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};

test('missing or wrong identity is 403', async () => {
  for (const p of ['/', '/api/terminals']) {
    const r = await req('GET', p, { id: false });
    assert.equal(r.status, 403);
    assert.equal(r.text, 'Not allowed');
  }
  const wrong = await req('GET', '/', { headers: { 'tailscale-user-login': 'x@example.com' }, id: false });
  assert.equal(wrong.status, 403);
});

test('POST needs matching Origin and JSON content type', async () => {
  assert.equal((await req('POST', '/api/login', { body: { pin: PIN }, origin: false })).status, 403);
  assert.equal((await req('POST', '/api/login', { body: { pin: PIN }, headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await req('POST', '/api/login', { body: '{"pin":"x"}', headers: { 'content-type': 'text/plain' } })).status, 403);
});

test('oversized body is 413, bad JSON is 400', async () => {
  const big = await req('POST', '/api/login', { body: JSON.stringify({ pin: 'x'.repeat(17000) }) });
  assert.equal(big.status, 413);
  assert.equal(big.headers['cache-control'], 'no-store');
  const bigNoId = await req('POST', '/api/login', { body: JSON.stringify({ pin: 'x'.repeat(17000) }), id: false });
  assert.equal(bigNoId.status, 403);
  assert.equal(bigNoId.headers['cache-control'], 'no-store');
  const bad = await req('POST', '/api/login', { body: '{nope' });
  assert.equal(bad.status, 400);
});

test('api needs a session; session endpoint reports state', async () => {
  const r = await req('GET', '/api/terminals');
  assert.equal(r.status, 401);
  assert.deepEqual(r.data, { error: 'signin' });
  assert.deepEqual((await req('GET', '/api/session')).data, { signedIn: false });
  const cookie = await login();
  assert.deepEqual((await req('GET', '/api/session', { cookie })).data, { signedIn: true });
});

test('R5: authenticated GET /api/session re-sends the cookie; anonymous does not', async () => {
  const cookie = await login();
  const token = cookie.split('=')[1];
  const r = await req('GET', '/api/session', { cookie });
  assert.equal(r.headers['set-cookie'][0], `hr_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=2592000`);
  assert.equal((await req('GET', '/api/session')).headers['set-cookie'], undefined);
});

test('login: cookie flags, wrong PIN, rate limit after 5 failures', async () => {
  const ok = await req('POST', '/api/login', { body: { pin: PIN } });
  assert.equal(ok.status, 204);
  const c = ok.headers['set-cookie'][0];
  assert.match(c, /HttpOnly/);
  assert.match(c, /Secure/);
  assert.match(c, /SameSite=Strict/);
  for (let i = 0; i < 5; i++) {
    const r = await req('POST', '/api/login', { body: { pin: '000000' } });
    assert.equal(r.status, 401);
    assert.deepEqual(r.data, { error: 'wrong_pin' });
  }
  const r = await req('POST', '/api/login', { body: { pin: PIN } });
  assert.equal(r.status, 429);
  assert.equal(r.data.error, 'too_many');
  assert.ok(r.data.retryAfterMs > 0);
});

test('R6: limiter key is the identity login, or fixed "proxy"', async () => {
  const keys = [];
  const real = limiter.check;
  limiter.check = (k) => { keys.push(k); return real(k); };
  await req('POST', '/api/login', { body: { pin: '000000' }, headers: { 'x-forwarded-for': '9.9.9.9' } });
  assert.deepEqual(keys, [LOGIN]);
  await new Promise((r) => srv.close(r));
  await start({ access: 'proxy', allowedLogin: null });
  const keys2 = [];
  const real2 = limiter.check;
  limiter.check = (k) => { keys2.push(k); return real2(k); };
  await req('POST', '/api/login', { body: { pin: '000000' }, headers: { 'x-forwarded-for': '9.9.9.9' }, id: false });
  assert.deepEqual(keys2, ['proxy']);
});

test('terminals list and send', async () => {
  const cookie = await login();
  const list = await req('GET', '/api/terminals', { cookie });
  assert.equal(list.status, 200);
  assert.deepEqual(list.data.items, store.list());
  assert.equal(list.data.deskMode, false);

  assert.equal((await req('POST', '/api/terminals/t1/send', { cookie, body: { text: '--help' } })).status, 204);
  assert.deepEqual(calls().at(-1), ['send', 't1', '--', '--help']);
  assert.equal((await req('POST', '/api/terminals/t9/send', { cookie, body: { text: 'hi' } })).status, 404);
  assert.equal((await req('POST', '/api/terminals/t1/send', { cookie, body: { text: '  ' } })).status, 400);
  assert.equal((await req('POST', '/api/terminals/t1/send', { cookie, body: { text: 'x'.repeat(4001) } })).status, 400);
  assert.equal((await req('POST', '/api/terminals/t1/send', { cookie, body: { text: 5 } })).status, 400);

  fs.writeFileSync(path.join(dir, 'exit'), '1');
  fs.writeFileSync(path.join(dir, 'stderr'), '{"error":{"kind":"blocked","message":"showing a dialog"}}');
  const bad = await req('POST', '/api/terminals/t1/send', { cookie, body: { text: 'hi' } });
  assert.equal(bad.status, 409);
  assert.deepEqual(bad.data, { error: 'showing a dialog' });
});

const setStatus = (st) => store.reset({
  seq: 2,
  terminals: [{
    address: 't1', state: 'live', status: { app: 'claude-code', state: st }, turn: 1,
    cols: 80, rows: 24, labels: { where: 'demo / 1' }, foreground: { name: 'claude' }, argv: [], cwd: 'C:\work\demo',
  }],
}, { emitTransitions: false });

test('force send: --force only while the terminal is blocked', async () => {
  const cookie = await login();
  setStatus('blocked');
  assert.equal(store.get('t1').status, 'blocked');
  assert.equal((await req('POST', '/api/terminals/t1/send', { cookie, body: { text: 'green please', force: true } })).status, 204);
  assert.deepEqual(calls().at(-1), ['send', 't1', '--force', '--', 'green please']);
  // without force a blocked terminal still gets a plain send (hc decides)
  assert.equal((await req('POST', '/api/terminals/t1/send', { cookie, body: { text: 'hi' } })).status, 204);
  assert.deepEqual(calls().at(-1), ['send', 't1', '--', 'hi']);
  assert.equal((await req('POST', '/api/terminals/t1/send', { cookie, body: { text: 'hi', force: false } })).status, 204);
  assert.deepEqual(calls().at(-1), ['send', 't1', '--', 'hi']);

  for (const st of ['working', 'done', 'idle']) {
    setStatus(st);
    assert.equal((await req('POST', '/api/terminals/t1/send', { cookie, body: { text: `x-${st}`, force: true } })).status, 204);
    assert.deepEqual(calls().at(-1), ['send', 't1', '--', `x-${st}`]);
  }
});

test('force send: non-boolean force is 400 and nothing is sent; unknown terminal still 404', async () => {
  const cookie = await login();
  setStatus('blocked');
  for (const force of ['true', 1, null, {}]) {
    const r = await req('POST', '/api/terminals/t1/send', { cookie, body: { text: 'hi', force } });
    assert.equal(r.status, 400);
    assert.deepEqual(r.data, { error: 'bad_force' });
  }
  assert.deepEqual(calls(), []);
  assert.equal((await req('POST', '/api/terminals/t9/send', { cookie, body: { text: 'hi', force: true } })).status, 404);
  fs.writeFileSync(path.join(dir, 'exit'), '1');
  fs.writeFileSync(path.join(dir, 'stderr'), 'nope');
  const bad = await req('POST', '/api/terminals/t1/send', { cookie, body: { text: 'hi', force: true } });
  assert.equal(bad.status, 409);
  assert.deepEqual(bad.data, { error: 'nope' });
});

test('keys validation', async () => {
  const cookie = await login();
  assert.equal((await req('POST', '/api/terminals/t1/keys', { cookie, body: { keys: ['ctrl+c'] } })).status, 204);
  assert.deepEqual(calls().at(-1), ['keys', 't1', '--', 'ctrl+c']);
  assert.equal((await req('POST', '/api/terminals/t1/keys', { cookie, body: { keys: ['rm -rf'] } })).status, 400);
  assert.equal((await req('POST', '/api/terminals/t1/keys', { cookie, body: { keys: [] } })).status, 400);
  assert.equal((await req('POST', '/api/terminals/t1/keys', { cookie, body: { keys: Array(17).fill('a') } })).status, 400);
  assert.equal((await req('POST', '/api/terminals/t9/keys', { cookie, body: { keys: ['a'] } })).status, 404);
});

test('settings get/put', async () => {
  const cookie = await login();
  const before = saves;
  const put = await req('PUT', '/api/settings', { cookie, body: { deskMode: true } });
  assert.equal(put.status, 200);
  assert.deepEqual(put.data, { deskMode: true, notifyBlocked: true, notifyDone: true });
  assert.equal(state.deskMode, true);
  assert.ok(saves > before);
  assert.equal((await req('PUT', '/api/settings', { cookie, body: { deskMode: 'yes' } })).status, 400);
  assert.deepEqual((await req('GET', '/api/settings', { cookie })).data, put.data);
});

test('push endpoints', async () => {
  const cookie = await login();
  assert.deepEqual((await req('GET', '/api/push/key', { cookie })).data, { publicKey: 'K' });
  const sub = { endpoint: 'https://push.example/abc', keys: { p256dh: 'a', auth: 'b' } };
  assert.equal((await req('POST', '/api/push/subscribe', { cookie, body: { subscription: sub } })).status, 204);
  assert.equal((await req('POST', '/api/push/subscribe', { cookie, body: { subscription: {} } })).status, 400);
  const insecure = { ...sub, endpoint: 'http://push.example/abc' };
  assert.equal((await req('POST', '/api/push/subscribe', { cookie, body: { subscription: insecure } })).status, 400);
  const extra = await req('POST', '/api/push/subscribe', { cookie, body: { subscription: { ...sub, junk: 'x' } } });
  assert.equal(extra.status, 204);
  assert.deepEqual(pushCalls.pop(), ['sub', sub]);
  assert.equal((await req('POST', '/api/push/unsubscribe', { cookie, body: { endpoint: sub.endpoint } })).status, 204);
  assert.deepEqual(pushCalls.filter((c) => c[0] !== 'sendAll'), [['sub', sub], ['unsub', sub.endpoint]]);
  assert.deepEqual((await req('POST', '/api/push/test', { cookie, body: {} })).data, { sent: 1, removed: 0 });
  assert.deepEqual(pushCalls.at(-1), ['sendAll', { title: 'herdr-remote', body: 'Test notification', address: null, tag: 'test', url: '/' }]);
});

test('logout-everywhere invalidates the cookie', async () => {
  const cookie = await login();
  assert.equal((await req('POST', '/api/logout-everywhere', { cookie })).status, 204);
  assert.equal((await req('GET', '/api/terminals', { cookie })).status, 401);
});

test('R18: logout-everywhere also forgets push subscriptions and saves', async () => {
  const cookie = await login();
  state.subscriptions = [{ endpoint: 'https://push.example.com/a', keys: { p256dh: 'p', auth: 'a' } }];
  const before = saves;
  assert.equal((await req('POST', '/api/logout-everywhere', { cookie })).status, 204);
  assert.deepEqual(state.subscriptions, []);
  assert.ok(saves > before);
});

test('static files, vendor, traversal, headers', async () => {
  const index = await req('GET', '/');
  assert.equal(index.status, 200);
  assert.match(index.headers['content-type'], /text\/html/);
  assert.equal((await req('GET', '/vendor/xterm.js')).status, 200);
  assert.match((await req('GET', '/vendor/xterm.css')).headers['content-type'], /text\/css/);
  assert.equal((await req('GET', '/../package.json')).status, 404);
  assert.equal((await req('GET', '/%2e%2e/package.json')).status, 404);
  assert.equal((await req('GET', '/nope.txt')).status, 404);
  assert.equal(index.headers['content-security-policy'],
    "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'");
  assert.equal(index.headers['x-content-type-options'], 'nosniff');
  assert.equal(index.headers['referrer-policy'], 'no-referrer');
  assert.equal(index.headers['cache-control'], undefined);
  assert.equal((await req('GET', '/api/session')).headers['cache-control'], 'no-store');
  const denied = await req('GET', '/', { id: false });
  assert.equal(denied.headers['x-content-type-options'], 'nosniff');
});

test('onSettingsChanged fires after a successful PUT /api/settings only', async () => {
  const cookie = await login();
  assert.equal((await req('PUT', '/api/settings', { cookie, body: { deskMode: 'yes' } })).status, 400);
  assert.deepEqual(hookCalls, []);
  assert.equal((await req('PUT', '/api/settings', { cookie, body: { deskMode: true } })).status, 200);
  assert.deepEqual(hookCalls, ['settings']);
});

test('onLogoutEverywhere fires after POST /api/logout-everywhere', async () => {
  const cookie = await login();
  assert.equal((await req('POST', '/api/logout-everywhere', { cookie })).status, 204);
  assert.deepEqual(hookCalls, ['logout']);
});
