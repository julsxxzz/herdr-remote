import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hashPin, verifyPin, isAcceptablePin, checkIdentity, checkOrigin,
  createSessions, createRateLimiter, sessionCookie, readSessionToken,
} from '../src/auth.js';

const DAY = 24 * 60 * 60 * 1000;

test('hashPin/verifyPin round-trip', () => {
  const h = hashPin('123456');
  assert.match(h, /^scrypt\$[^$]+\$[^$]+$/);
  assert.equal(verifyPin('123456', h), true);
  assert.equal(verifyPin('654321', h), false);
});

test('two hashes of the same PIN differ', () => {
  assert.notEqual(hashPin('123456'), hashPin('123456'));
});

test('verifyPin rejects malformed stored values', () => {
  assert.equal(verifyPin('123456', ''), false);
  assert.equal(verifyPin('123456', 'bcrypt$a$b'), false);
  assert.equal(verifyPin('123456', 'scrypt$AAAA$AA'), false);
  assert.equal(verifyPin('123456', undefined), false);
});

test('isAcceptablePin requires at least 6 chars', () => {
  assert.equal(isAcceptablePin('12345'), false);
  assert.equal(isAcceptablePin('123456'), true);
  assert.equal(isAcceptablePin(undefined), false);
});

test('checkIdentity tailscale', () => {
  const cfg = { access: 'tailscale', allowedLogin: 'owner@example.com' };
  assert.deepEqual(checkIdentity({}, cfg), { ok: false, login: null });
  assert.deepEqual(checkIdentity({ 'tailscale-user-login': 'Owner@Example.com' }, cfg),
    { ok: true, login: 'Owner@Example.com' });
  assert.equal(checkIdentity({ 'tailscale-user-login': 'other@example.com' }, cfg).ok, false);
});

test('checkIdentity proxy', () => {
  assert.equal(checkIdentity({}, { access: 'proxy' }).ok, true);
  const cfg = { access: 'proxy', proxyIdentityHeader: 'X-Secret', proxyIdentityValue: 'abc' };
  assert.equal(checkIdentity({ 'x-secret': 'abc' }, cfg).ok, true);
  assert.equal(checkIdentity({ 'x-secret': 'nope' }, cfg).ok, false);
  assert.equal(checkIdentity({}, cfg).ok, false);
});

test('checkOrigin is exact match only', () => {
  const cfg = { publicOrigin: 'https://box.example.ts.net' };
  assert.equal(checkOrigin({ origin: 'https://box.example.ts.net' }, cfg), true);
  assert.equal(checkOrigin({ origin: 'http://box.example.ts.net' }, cfg), false);
  assert.equal(checkOrigin({}, cfg), false);
});

function mk(t0 = 1_000_000) {
  const state = { sessions: {} };
  let saves = 0;
  let t = t0;
  const s = createSessions({ state, save: () => { saves++; }, now: () => t });
  return { state, s, set: (v) => { t = v; }, saves: () => saves, t0 };
}

test('sessions: create/check/unknown', () => {
  const { s } = mk();
  const tok = s.create();
  assert.equal(s.check(tok), true);
  assert.equal(s.check('nope'), false);
  assert.equal(s.check(undefined), false);
});

test('sessions expire after 31 days unused and are deleted', () => {
  const { s, set, t0, state } = mk();
  const tok = s.create();
  set(t0 + 31 * DAY);
  assert.equal(s.check(tok), false);
  assert.deepEqual(state.sessions, {});
});

test('sessions slide when used every 20 days for 90 days', () => {
  const { s, set, t0 } = mk();
  const tok = s.create();
  for (let d = 20; d <= 90; d += 20) {
    set(t0 + d * DAY);
    assert.equal(s.check(tok), true);
  }
});

test('save at most once per hour per session', () => {
  const { s, set, t0, saves } = mk();
  const tok = s.create();
  const base = saves();
  set(t0 + 60_000);
  s.check(tok);
  set(t0 + 120_000);
  s.check(tok);
  assert.equal(saves(), base);
  set(t0 + 3_600_000 + 1);
  s.check(tok);
  assert.equal(saves(), base + 1);
});

test('revokeAll invalidates sessions and state never holds raw token', () => {
  const { s, state } = mk();
  const tok = s.create();
  assert.equal(JSON.stringify(state).includes(tok), false);
  s.revokeAll();
  assert.equal(s.check(tok), false);
  assert.deepEqual(state.sessions, {});
});

test('rate limiter blocks after max failures and recovers', () => {
  let t = 0;
  const rl = createRateLimiter({ now: () => t });
  for (let i = 0; i < 5; i++) { assert.equal(rl.check('k').allowed, true); rl.fail('k'); }
  const r = rl.check('k');
  assert.equal(r.allowed, false);
  assert.ok(r.retryAfterMs > 0);
  t = 900000;
  assert.equal(rl.check('k').allowed, true);
});

test('rate limiter succeed clears; keys independent', () => {
  const rl = createRateLimiter({ now: () => 0 });
  for (let i = 0; i < 5; i++) rl.fail('k');
  assert.equal(rl.check('k').allowed, false);
  assert.equal(rl.check('other').allowed, true);
  rl.succeed('k');
  assert.equal(rl.check('k').allowed, true);
});

test('sessionCookie and readSessionToken', () => {
  assert.equal(sessionCookie('tok'),
    'hr_session=tok; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=2592000');
  assert.equal(readSessionToken('a=1; hr_session=tok; b=2'), 'tok');
  assert.equal(readSessionToken('a=1'), null);
  assert.equal(readSessionToken(undefined), null);
});

test('hashPin rejects non-strings and NFC-normalizes', () => {
  assert.throws(() => hashPin(123456), TypeError);
  assert.throws(() => hashPin(undefined), TypeError);
  const h = hashPin('café123');
  assert.equal(verifyPin('café123', h), true);
});

test('session with missing/non-numeric lastSeen fails closed', () => {
  const { s, state } = mk();
  const tok = s.create();
  const key = Object.keys(state.sessions)[0];
  delete state.sessions[key].lastSeen;
  assert.equal(s.check(tok), false);
  assert.deepEqual(state.sessions, {});
  const tok2 = s.create();
  state.sessions[Object.keys(state.sessions)[0]].lastSeen = 'x';
  assert.equal(s.check(tok2), false);
});

test('tailscale rejects empty/missing allowedLogin; unknown access acts as tailscale', () => {
  const h = { 'tailscale-user-login': 'owner@example.com' };
  assert.equal(checkIdentity(h, { access: 'tailscale', allowedLogin: '' }).ok, false);
  assert.equal(checkIdentity(h, { access: 'tailscale' }).ok, false);
  assert.equal(checkIdentity({ 'tailscale-user-login': '' }, { access: 'tailscale', allowedLogin: '' }).ok, false);
  const cfg = { access: 'bogus', allowedLogin: 'owner@example.com' };
  assert.equal(checkIdentity(h, cfg).ok, true);
  assert.equal(checkIdentity({}, cfg).ok, false);
});

test('B17: create() sweeps expired sessions of devices never used again, saving once', () => {
  const { s, set, t0, state, saves } = mk();
  const old = s.create();
  s.create();
  set(t0 + 31 * DAY);
  const before = saves();
  const fresh = s.create();
  assert.equal(saves() - before, 1);
  assert.equal(Object.keys(state.sessions).length, 1);
  assert.equal(s.check(fresh), true);
  assert.equal(s.check(old), false);
});
