import { randomBytes, createHash, scryptSync, timingSafeEqual } from 'node:crypto';

const SCRYPT = { N: 16384, r: 8, p: 1 };
const KEY_LEN = 32;
const SALT_LEN = 16;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SAVE_INTERVAL_MS = 60 * 60 * 1000;
const COOKIE_NAME = 'hr_session';

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

export function hashPin(pin) {
  if (typeof pin !== 'string') throw new TypeError('PIN must be a string');
  const salt = randomBytes(SALT_LEN);
  const hash = scryptSync(pin.normalize('NFC'), salt, KEY_LEN, SCRYPT);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPin(pin, stored) {
  if (typeof pin !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'base64');
  const expected = Buffer.from(parts[2], 'base64');
  if (salt.length === 0 || expected.length !== KEY_LEN) return false;
  const actual = scryptSync(pin.normalize('NFC'), salt, KEY_LEN, SCRYPT);
  return timingSafeEqual(actual, expected);
}

export function isAcceptablePin(pin) {
  return typeof pin === 'string' && pin.length >= 6;
}

export function checkIdentity(headers, cfg) {
  if (cfg.access === 'proxy') {
    if (!cfg.proxyIdentityHeader) return { ok: true, login: null };
    const got = headers[String(cfg.proxyIdentityHeader).toLowerCase()];
    const ok = typeof got === 'string' && typeof cfg.proxyIdentityValue === 'string'
      && safeEqual(got, cfg.proxyIdentityValue);
    return { ok, login: null };
  }
  const login = headers['tailscale-user-login'];
  if (typeof login !== 'string' || !login || typeof cfg.allowedLogin !== 'string' || !cfg.allowedLogin) {
    return { ok: false, login: null };
  }
  const ok = login.toLowerCase() === cfg.allowedLogin.toLowerCase();
  return { ok, login: ok ? login : null };
}

export function checkOrigin(headers, cfg) {
  return typeof headers.origin === 'string' && headers.origin === cfg.publicOrigin;
}

const sha256hex = (s) => createHash('sha256').update(s).digest('hex');

const isExpired = (entry, t) => !Number.isFinite(entry?.lastSeen) || !(t - entry.lastSeen < SESSION_TTL_MS);

export function createSessions({ state, save, now = Date.now }) {
  if (!state.sessions) state.sessions = {};
  return {
    create() {
      const token = randomBytes(32).toString('base64url');
      const t = now();
      // Devices that never come back are otherwise never pruned; the save below covers the sweep.
      for (const [key, entry] of Object.entries(state.sessions)) if (isExpired(entry, t)) delete state.sessions[key];
      state.sessions[sha256hex(token)] = { created: t, lastSeen: t };
      save();
      return token;
    },
    check(token) {
      if (typeof token !== 'string' || !token) return false;
      const key = sha256hex(token);
      if (!Object.hasOwn(state.sessions, key)) return false;
      const entry = state.sessions[key];
      const t = now();
      if (isExpired(entry, t)) {
        delete state.sessions[key];
        save();
        return false;
      }
      if (t - entry.lastSeen >= SAVE_INTERVAL_MS) {
        entry.lastSeen = t;
        save();
      }
      return true;
    },
    revokeAll() {
      state.sessions = {};
      save();
    },
  };
}

export function createRateLimiter({ max = 5, windowMs = 900000, now = Date.now } = {}) {
  const entries = new Map();
  const live = (key) => {
    const e = entries.get(key);
    if (e && now() - e.start >= windowMs) { entries.delete(key); return undefined; }
    return e;
  };
  return {
    check(key) {
      const e = live(key);
      if (e && e.count >= max) return { allowed: false, retryAfterMs: e.start + windowMs - now() };
      return { allowed: true, retryAfterMs: 0 };
    },
    fail(key) {
      const e = live(key);
      if (e) e.count++;
      else entries.set(key, { count: 1, start: now() });
    },
    succeed(key) {
      entries.delete(key);
    },
  };
}

export function sessionCookie(token) {
  return `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=2592000`;
}

export function readSessionToken(cookieHeader) {
  if (typeof cookieHeader !== 'string') return null;
  for (const part of cookieHeader.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === COOKIE_NAME) {
      const v = part.slice(i + 1).trim();
      return v || null;
    }
  }
  return null;
}
