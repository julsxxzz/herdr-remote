import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { checkIdentity, checkOrigin, readSessionToken } from './auth.js';
import { isValidAddress } from './hc.js';

const LIST_THROTTLE_MS = 250;
const DEFAULT_HISTORY = 200;
const MAX_HISTORY = 2000;
const MAX_CLIENT_MESSAGE = 1024; // only tiny control messages are ever expected
const FALLBACK_COLS = 120;
const FALLBACK_ROWS = 40;
const isSize = (n) => Number.isInteger(n) && n > 0;

function refuse(socket, status, text) {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

export function parseHistory(raw) {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return DEFAULT_HISTORY; // no 1e3 / 0x10 / -5
  return Math.min(MAX_HISTORY, Number(raw));
}

export function attachWebSockets(server, {
  config, state, store, hc, sessions, notifier, log = () => {},
  maxObservers = 8, maxBufferedBytes = 4 * 1024 * 1024, heartbeatMs = 30000,
}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_CLIENT_MESSAGE });
  let observers = 0;
  const cleanups = new Set();
  const listSenders = new Set();

  function listSocket(ws) {
    const clientId = randomUUID();
    let lastSent = 0;
    let timer = null;

    const send = () => {
      timer = null;
      if (ws.readyState !== ws.OPEN) return;
      lastSent = Date.now();
      // ready: false until the first snapshot, so clients don't read an empty list as "nothing runs".
      ws.send(JSON.stringify({ type: 'list', items: store.list(), deskMode: state.deskMode, ready: store.ready }));
    };
    const onChanged = () => {
      if (timer) return;
      const wait = Math.max(0, lastSent + LIST_THROTTLE_MS - Date.now());
      timer = setTimeout(send, wait);
    };

    send();
    const sendNow = () => { clearTimeout(timer); send(); };
    listSenders.add(sendNow);
    store.on('changed', onChanged);
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg?.type !== 'visible') return;
      const a = msg.address;
      if (a === null || isValidAddress(a)) notifier?.setVisible(clientId, a);
    });
    ws.on('close', () => {
      store.off('changed', onChanged);
      listSenders.delete(sendNow);
      clearTimeout(timer);
      notifier?.setVisible(clientId, null);
    });
  }

  function termSocket(ws, address, history) {
    // Before the first snapshot nothing is known yet: ask the client to retry (it reconnects on 1013).
    if (!store.ready) return ws.close(1013, 'not ready');
    const item = store.get(address);
    if (!item) return ws.close(4404, 'not found');
    if (observers >= maxObservers) return ws.close(4429, 'too many');

    observers++;
    let released = false;
    let finished = false;
    let lastCols = item.cols;
    let lastRows = item.rows;
    const sendSize = () => ws.send(JSON.stringify({ type: 'size', cols: lastCols, rows: lastRows }));

    let child;
    const onChanged = () => {
      const cur = store.get(address);
      if (!cur) return end(); // finished or removed while watched
      if (ws.readyState !== ws.OPEN) return;
      if (!isSize(cur.cols) || !isSize(cur.rows)) return; // ls fallback carries no size
      if (cur.cols !== lastCols || cur.rows !== lastRows) {
        lastCols = cur.cols;
        lastRows = cur.rows;
        sendSize();
      }
    };

    const release = () => {
      if (released) return;
      released = true;
      observers--;
      store.off('changed', onChanged);
      cleanups.delete(release);
      try { child?.kill(); } catch { /* already gone */ }
    };
    cleanups.add(release);

    const end = () => {
      if (finished) return;
      finished = true;
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'ended' }));
        ws.close(1000, 'ended');
      }
      release();
    };

    // The observer stopped but the terminal is still there: let the client reconnect.
    const onChildExit = () => {
      if (finished) return;
      if (!store.get(address)) return end();
      finished = true;
      if (ws.readyState === ws.OPEN) ws.close(1011, 'observer stopped');
      release();
    };

    ws.on('close', release);
    ws.on('error', release);
    // Read-only: nothing arriving on a term socket is ever acted on.
    ws.on('message', () => {});

    const begin = () => {
      if (released || ws.readyState !== ws.OPEN) return release();
      sendSize();
      store.on('changed', onChanged);
      try {
        child = hc.observe(address, { history });
      } catch (err) {
        log('observe failed', err);
        return end();
      }
      child.on('error', (err) => {
        log('observe error', err);
        end();
      });
      child.on('close', onChildExit);
      child.stderr?.resume();
      child.stdout?.on('data', (chunk) => {
        if (ws.readyState !== ws.OPEN) return;
        ws.send(chunk, { binary: true });
        if (ws.bufferedAmount > maxBufferedBytes) {
          ws.close(1013, 'slow client');
          release();
        }
      });
    };

    if (isSize(lastCols) && isSize(lastRows)) return begin();
    // Started from the ls fallback, which has no size: ask hc for it.
    Promise.resolve()
      .then(() => hc.get(address))
      .then((t) => {
        if (!isSize(t?.cols) || !isSize(t?.rows)) throw new Error('no size');
        lastCols = t.cols;
        lastRows = t.rows;
      })
      .catch(() => {
        lastCols = FALLBACK_COLS;
        lastRows = FALLBACK_ROWS;
      })
      .then(begin);
  }

  function onUpgrade(req, socket, head) {
    socket.on('error', () => {});
    if (!checkIdentity(req.headers, config).ok) return refuse(socket, 403, 'Forbidden');
    let url;
    try { url = new URL(req.url ?? '/', 'http://localhost'); } catch { return refuse(socket, 400, 'Bad Request'); }
    const route = url.pathname;
    if (route !== '/ws/list' && route !== '/ws/term') return refuse(socket, 404, 'Not Found');
    if (!checkOrigin(req.headers, config)) return refuse(socket, 403, 'Forbidden');
    if (!sessions.check(readSessionToken(req.headers.cookie))) return refuse(socket, 401, 'Unauthorized');

    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.isAlive = true;
      ws.on('pong', () => { ws.isAlive = true; });
      ws.on('error', () => {});
      if (route === '/ws/list') return listSocket(ws);
      const address = url.searchParams.get('address');
      if (!isValidAddress(address)) return ws.close(4404, 'not found');
      termSocket(ws, address, parseHistory(url.searchParams.get('history')));
    });
  }

  // Phones drop off networks without a close frame: ping, and terminate sockets that never pong.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, heartbeatMs);
  heartbeat.unref?.();

  server.on('upgrade', onUpgrade);

  return {
    broadcastList() {
      for (const sendNow of listSenders) sendNow();
    },
    disconnectAll() {
      for (const ws of wss.clients) ws.close(4401, 'signed out');
    },
    close() {
      clearInterval(heartbeat);
      server.off('upgrade', onUpgrade);
      for (const release of [...cleanups]) release();
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    },
  };
}
