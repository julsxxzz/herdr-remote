import { fileURLToPath } from 'node:url';
import { loadConfig, loadState, saveState, validateConfig } from './config.js';
import { createHc } from './hc.js';
import { TerminalStore } from './terminals.js';
import { startWatcher } from './watcher.js';
import { createSessions, createRateLimiter } from './auth.js';
import { createServer } from './server.js';
import { attachWebSockets } from './live.js';
import { createPush } from './push.js';
import { createNotifier } from './notifier.js';

const repo = new URL('..', import.meta.url);
const FALLBACK_SUBJECT = 'mailto:remote-for-herdr@example.invalid';

export async function startServer({ home, log = console, hcOverride, webpushOverride } = {}) {
  const cfg = loadConfig(home);
  const state = loadState(home);
  const errors = validateConfig(cfg);
  if (errors.length) {
    throw Object.assign(new Error('Run "remote-for-herdr setup" first: ' + errors.join('; ')), { code: 'SETUP_REQUIRED' });
  }

  const hc = hcOverride ?? createHc({ command: cfg.hcPath ?? 'hc' });
  const save = (s = state) => saveState(home, s);
  const logLine = (...a) => log.log?.(...a);
  const logWarn = (...a) => (log.warn ?? log.log)?.call(log, ...a);

  const store = new TerminalStore();
  const subject = typeof cfg.publicOrigin === 'string' && cfg.publicOrigin.startsWith('https:')
    ? cfg.publicOrigin : FALLBACK_SUBJECT; // R12
  const push = createPush({ vapid: cfg.vapid, subject, state, saveState: save, webpush: webpushOverride, log: logWarn });
  const notifier = createNotifier({ state, push, log: logWarn });
  store.on('transition', notifier.onTransition);

  const sessions = createSessions({ state, save });
  const limiter = createRateLimiter();

  let live = null;
  const server = createServer({
    config: cfg, state, saveState: save, hc, store, sessions, limiter, push,
    publicDir: fileURLToPath(new URL('public', repo)),
    vendorDir: fileURLToPath(new URL('node_modules/@xterm/xterm', repo)),
    log: logWarn,
    onSettingsChanged: () => live?.broadcastList(), // R10
    onLogoutEverywhere: () => live?.disconnectAll(), // R11
  });
  live = attachWebSockets(server, { config: cfg, state, store, hc, sessions, notifier, log: logWarn });
  const watcher = startWatcher({ hc, store, log });

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(cfg.port, cfg.bind, () => { server.off('error', reject); resolve(); });
    });
  } catch (err) {
    watcher.stop();
    live.close();
    if (err.code === 'EADDRINUSE') {
      throw Object.assign(new Error(`port ${cfg.port} already in use — is remote-for-herdr already running?`), { code: 'PORT_IN_USE' });
    }
    throw err;
  }
  const port = server.address().port;
  logLine(`listening on ${cfg.bind}:${port}`);

  let stopping = null;
  const stop = () => (stopping ??= (async () => {
    watcher.stop();
    live.close();
    await new Promise((r) => { server.close(r); server.closeAllConnections?.(); });
  })());

  return { server, port, stop };
}
