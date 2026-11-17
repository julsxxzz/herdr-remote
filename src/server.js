import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { checkIdentity, checkOrigin, verifyPin, sessionCookie, readSessionToken } from './auth.js';
import { isValidAddress, isValidKeyName } from './hc.js';

const MAX_BODY = 16 * 1024;
const MAX_TEXT = 4000;
const MAX_KEYS = 16;
const SETTING_KEYS = ['deskMode', 'notifyBlocked', 'notifyDone'];

const CSP = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'";

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

class HttpError extends Error {
  constructor(status, body) {
    super(`HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

function sendJson(res, status, body, extraHeaders = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data), ...extraHeaders });
  res.end(data);
}

function sendText(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (declared > MAX_BODY) return reject(new HttpError(413, { error: 'too_large' }));
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (c) => {
      if (tooBig) return;
      size += c.length;
      if (size > MAX_BODY) {
        tooBig = true;
        chunks.length = 0;
        req.removeAllListeners('data');
        req.pause(); // stop reading; the 413 closes the connection
        reject(new HttpError(413, { error: 'too_large' }));
      } else chunks.push(c);
    });
    req.on('error', reject);
    req.on('end', () => {
      if (tooBig) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        const v = JSON.parse(raw);
        if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
        resolve(v);
      } catch {
        reject(new HttpError(400, { error: 'bad_json' }));
      }
    });
  });
}

const isBool = (v) => typeof v === 'boolean';
const settingsOf = (state) => ({ deskMode: state.deskMode, notifyBlocked: state.notifyBlocked, notifyDone: state.notifyDone });

function serveFile(res, file, method) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return sendText(res, 404, 'Not found');
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'content-length': st.size,
    });
    if (method === 'HEAD') return res.end();
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  });
}

export function createServer({ config, state, saveState, hc, store, sessions, limiter, push, publicDir, vendorDir, log = () => {}, onSettingsChanged = () => {}, onLogoutEverywhere = () => {} }) {
  const publicRoot = path.resolve(publicDir);
  const vendorFiles = {
    '/vendor/xterm.js': path.join(vendorDir, 'lib', 'xterm.js'),
    '/vendor/xterm.css': path.join(vendorDir, 'css', 'xterm.css'),
  };

  function staticFile(pathname) {
    if (Object.hasOwn(vendorFiles, pathname)) return vendorFiles[pathname];
    let rel;
    try { rel = decodeURIComponent(pathname); } catch { return null; }
    if (rel.includes('\0')) return null;
    if (rel === '/') rel = '/index.html';
    const file = path.resolve(publicRoot, `.${rel}`);
    return file.startsWith(publicRoot + path.sep) ? file : null;
  }

  async function sendToTerminal(res, address, run) {
    if (!store.get(address)) return sendJson(res, 404, { error: 'not_found' });
    const r = await run();
    if (!r.ok) return sendJson(res, 409, { error: r.error });
    res.writeHead(204);
    res.end();
  }

  async function api(req, res, pathname, body, identity) {
    const method = req.method;
    const token = readSessionToken(req.headers.cookie);
    const signedIn = sessions.check(token);

    if (pathname === '/api/session' && method === 'GET') {
      // R5: sliding cookie for a device that is in use.
      if (signedIn) res.setHeader('Set-Cookie', sessionCookie(token));
      return sendJson(res, 200, { signedIn });
    }

    if (pathname === '/api/login' && method === 'POST') {
      const key = identity.login ?? 'proxy'; // R6: never client-controlled
      const gate = limiter.check(key);
      if (!gate.allowed) return sendJson(res, 429, { error: 'too_many', retryAfterMs: gate.retryAfterMs });
      if (!verifyPin(body.pin, config.pinHash)) {
        limiter.fail(key);
        return sendJson(res, 401, { error: 'wrong_pin' });
      }
      limiter.succeed(key);
      res.writeHead(204, { 'Set-Cookie': sessionCookie(sessions.create()) });
      return res.end();
    }

    if (!signedIn) return sendJson(res, 401, { error: 'signin' });

    if (pathname === '/api/logout-everywhere' && method === 'POST') {
      sessions.revokeAll();
      // R18: devices re-register their push subscription after signing in again.
      state.subscriptions = [];
      saveState(state);
      onLogoutEverywhere();
      res.writeHead(204);
      return res.end();
    }

    if (pathname === '/api/terminals' && method === 'GET') {
      return sendJson(res, 200, { items: store.list(), deskMode: state.deskMode });
    }

    const m = /^\/api\/terminals\/([^/]+)\/(send|keys)$/.exec(pathname);
    if (m && method === 'POST') {
      let address;
      try { address = decodeURIComponent(m[1]); } catch { return sendJson(res, 404, { error: 'not_found' }); }
      if (!isValidAddress(address)) return sendJson(res, 404, { error: 'not_found' });
      if (m[2] === 'send') {
        const { text } = body;
        if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT) {
          return sendJson(res, 400, { error: 'bad_text' });
        }
        return sendToTerminal(res, address, () => hc.send(address, text));
      }
      const { keys } = body;
      if (!Array.isArray(keys) || keys.length < 1 || keys.length > MAX_KEYS || !keys.every(isValidKeyName)) {
        return sendJson(res, 400, { error: 'bad_keys' });
      }
      return sendToTerminal(res, address, () => hc.keys(address, keys));
    }

    if (pathname === '/api/settings') {
      if (method === 'GET') return sendJson(res, 200, settingsOf(state));
      if (method === 'PUT') {
        for (const k of SETTING_KEYS) {
          if (k in body && !isBool(body[k])) return sendJson(res, 400, { error: 'bad_settings' });
        }
        for (const k of SETTING_KEYS) if (k in body) state[k] = body[k];
        saveState(state);
        onSettingsChanged();
        return sendJson(res, 200, settingsOf(state));
      }
    }

    if (pathname === '/api/push/key' && method === 'GET') return sendJson(res, 200, { publicKey: push.publicKey });
    if (pathname === '/api/push/subscribe' && method === 'POST') {
      const s = body.subscription;
      if (!s || typeof s !== 'object' || typeof s.endpoint !== 'string' || !s.endpoint.startsWith('https://')
        || !s.keys || typeof s.keys.p256dh !== 'string' || typeof s.keys.auth !== 'string') {
        return sendJson(res, 400, { error: 'bad_subscription' });
      }
      const clean = { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } };
      if (s.expirationTime !== undefined) clean.expirationTime = s.expirationTime;
      push.subscribe(clean);
      res.writeHead(204);
      return res.end();
    }
    if (pathname === '/api/push/unsubscribe' && method === 'POST') {
      if (typeof body.endpoint !== 'string' || !body.endpoint) return sendJson(res, 400, { error: 'bad_endpoint' });
      push.unsubscribe(body.endpoint);
      res.writeHead(204);
      return res.end();
    }
    if (pathname === '/api/push/test' && method === 'POST') {
      return sendJson(res, 200, await push.sendAll({ title: 'herdr-remote', body: 'Test notification', address: null, tag: 'test', url: '/' }));
    }

    return sendJson(res, 404, { error: 'not_found' });
  }

  async function handle(req, res) {
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');

    if ((req.url ?? '').split('?')[0].startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');

    const identity = checkIdentity(req.headers, config);
    if (!identity.ok) return sendText(res, 403, 'Not allowed');

    const method = req.method;
    let body = {};
    if (method !== 'GET' && method !== 'HEAD') {
      const ctype = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      if (!checkOrigin(req.headers, config) || ctype !== 'application/json') return sendText(res, 403, 'Not allowed');
      try {
        body = await readJsonBody(req);
      } catch (err) {
        if (err instanceof HttpError) {
          return sendJson(res, err.status, err.body, err.status === 413 ? { connection: 'close' } : {});
        }
        throw err;
      }
    }

    const pathname = (req.url ?? '/').split('?')[0];
    if (pathname.startsWith('/api/')) {
      return api(req, res, pathname, body, identity);
    }
    if (method !== 'GET' && method !== 'HEAD') return sendText(res, 404, 'Not found');
    const file = staticFile(pathname);
    if (!file) return sendText(res, 404, 'Not found');
    return serveFile(res, file, method);
  }

  return http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      log('request failed', err);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal' });
      else res.destroy();
    });
  });
}
