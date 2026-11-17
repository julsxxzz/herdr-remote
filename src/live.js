import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { checkIdentity, checkOrigin, readSessionToken } from './auth.js';
import { isValidAddress } from './hc.js';

const LIST_THROTTLE_MS = 250;
const DEFAULT_HISTORY = 200;
const MAX_HISTORY = 2000;
const MAX_CLIENT_MESSAGE = 1024; // only tiny control messages are ever expected

function refuse(socket, status, text) {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function parseHistory(raw) {
  if (raw === null || raw === '') return DEFAULT_HISTORY;
  const n = Number(raw);
  if (!Number.isInteger(n)) return DEFAULT_HISTORY;
  return Math.min(MAX_HISTORY, Math.max(0, n));
}

export function attachWebSockets(server, {
  config, state, store, hc, sessions, notifier, log = () => {},
  maxObservers = 8, maxBufferedBytes = 4 * 1024 * 1024, heartbeatMs = 30000,
}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_CLIENT_MESSAGE });
  let observers = 0;
  const cleanups = new Set();

  function listSocket(ws) {
    const clientId = randomUUID();
    let lastSent = 0;
    let timer = null;

    const send = () => {
      timer = null;
      if (ws.readyState !== ws.OPEN) return;
      lastSent = Date.now();
      ws.send(JSON.stringify({ type: 'list', items: store.list(), deskMode: state.deskMode }));
    };
    const onChanged = () => {
      if (timer) return;
      const wait = Math.max(0, lastSent + LIST_THROTTLE_MS - Date.now());
      timer = setTimeout(send, wait);
    };

    send();
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
      clearTimeout(timer);
      notifier?.setVisible(clientId, null);
    });
  }

  function termSocket(ws, address, history) {
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
      if (!cur || ws.readyState !== ws.OPEN) return;
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

    sendSize();
    store.on('changed', onChanged);
    ws.on('close', release);
    ws.on('error', release);
    // Read-only: nothing arriving on a term socket is ever acted on.
    ws.on('message', () => {});

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
    child.on('close', end);
    child.stderr?.resume();
    child.stdout?.on('data', (chunk) => {
      if (ws.readyState !== ws.OPEN) return;
      ws.send(chunk, { binary: true });
      if (ws.bufferedAmount > maxBufferedBytes) {
        ws.close(1013, 'slow client');
        release();
      }
    });
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
    close() {
      clearInterval(heartbeat);
      server.off('upgrade', onUpgrade);
      for (const release of [...cleanups]) release();
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    },
  };
}
