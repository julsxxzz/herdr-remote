import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { loadConfig } from './config.js';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const EXIT_SETUP_REQUIRED = 78; // sysexits EX_CONFIG
const CLI = fileURLToPath(new URL('./cli.js', import.meta.url));

// The running server's pid (supervisor, or a standalone --foreground run), and the file
// "herdr-remote stop" drops to ask it to stop.
// A request file (not a signal) because Windows cannot deliver a catchable signal to another process.
export const pidFilePath = (home) => path.join(home, 'server.pid');
const stopRequestPath = (home) => path.join(home, 'server.stop');
const rmQuiet = (file) => { try { fs.rmSync(file, { force: true }); } catch { /* best effort */ } };

const processAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
};

function readPid(file) {
  try {
    const pid = Number(fs.readFileSync(file, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch { return null; }
}

// The port the server of this home listens on, or null when unknown (0 / unreadable config).
function configuredPort(home) {
  try {
    const port = loadConfig(home).port;
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch { return null; }
}

// True when something accepts a TCP connection on 127.0.0.1:<port> within timeoutMs.
export function probePort(port, { timeoutMs = 500 } = {}) {
  if (!port) return Promise.resolve(false);
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

const FRESH_MS = 30000;
const CLAIM_ATTEMPTS = 5;

// Claims <home>/server.pid for this process (exclusive create) and starts watching for stop requests.
// An existing file blocks the claim only if its pid is alive AND (the server port answers, or the file
// was written in the last FRESH_MS — another start that has not bound its port yet). Anything else is a
// stale file (logoff/shutdown skips cleanup, and Windows reuses pids after a reboot) and is replaced.
// Returns { ok: false, pid } when blocked (nothing is touched then),
// else { ok: true, release } — release() stops watching and removes the pid file only if it is still ours.
export async function claimPidFile(home, {
  onStopRequest, pollMs = 500, isAlive = processAlive, portAnswers = probePort,
  port = configuredPort(home), freshMs = FRESH_MS, log = () => {},
} = {}) {
  const pidFile = pidFilePath(home);
  const stopFile = stopRequestPath(home);
  fs.mkdirSync(home, { recursive: true });
  let claimed = false;
  for (let attempt = 0; attempt < CLAIM_ATTEMPTS && !claimed; attempt++) {
    try {
      fs.writeFileSync(pidFile, String(process.pid), { flag: 'wx' });
      claimed = true;
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    const holder = readPid(pidFile);
    if (holder === process.pid) { fs.writeFileSync(pidFile, String(process.pid)); claimed = true; break; }
    let mtime = 0;
    try { mtime = fs.statSync(pidFile).mtimeMs; } catch { continue; } // vanished: retry the create
    const fresh = Date.now() - mtime < freshMs;
    if (holder === null && fresh && attempt < CLAIM_ATTEMPTS - 1) {
      await new Promise((r) => setTimeout(r, 50)); // another start is mid-write
      continue;
    }
    if (holder !== null && isAlive(holder) && (fresh || await portAnswers(port))) return { ok: false, pid: holder };
    if (readPid(pidFile) !== holder) continue; // changed while we looked: decide again
    log(`stale pid file replaced (pid ${holder ?? 'unreadable'})`);
    rmQuiet(pidFile);
  }
  if (!claimed) throw new Error(`could not claim ${pidFile}`);
  rmQuiet(stopFile); // a leftover request must not stop this run
  const control = setInterval(() => {
    if (fs.existsSync(stopFile)) { rmQuiet(stopFile); onStopRequest?.(); }
  }, pollMs);
  control.unref?.();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    clearInterval(control);
    if (readPid(pidFile) === process.pid) rmQuiet(pidFile);
  };
  return { ok: true, release };
}

const staleHint = (home) => `If herdr-remote isn't actually running, delete ${path.resolve(pidFilePath(home))}`;

export const alreadyRunningMessage = (pid, home) =>
  `herdr-remote is already running (pid ${pid}) — use "herdr-remote stop" first. `
  + `${staleHint(home).replace(/^If/, 'if')}.`;

function createLog(dir, maxBytes) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'server.log');
  let size = fs.existsSync(file) ? fs.statSync(file).size : 0;
  return {
    write(text) {
      const len = Buffer.byteLength(text);
      if (size > 0 && size + len > maxBytes) {
        fs.renameSync(file, `${file}.1`); // replaces any previous .1
        size = 0;
      }
      fs.appendFileSync(file, text);
      size += len;
    },
  };
}

// Runs the server in a child process, restarting it when it crashes.
// `entry`/`args`/`backoffMs`/`maxLogBytes` are overridable for tests.
export function superviseServer({
  home,
  entry = CLI,
  args = ['start', '--foreground', '--home', home],
  backoffMs = [1000, 2000, 5000, 10000, 30000],
  stableMs = 60000,
  maxLogBytes = 5 * 1024 * 1024,
  killAfterMs = 5000,
  controlPollMs = 500,
  isAlive = processAlive,
  portAnswers = probePort,
  port, // default: the configured port of this home
  forkImpl = fork,
} = {}) {
  const log = createLog(path.join(home, 'logs'), maxLogBytes);
  const note = (m) => log.write(`[supervisor ${new Date().toISOString()}] ${m}\n`);
  let child = null;
  let timer = null;
  let stopped = false;
  let attempt = 0;
  let settle;
  const done = new Promise((r) => { settle = r; });

  let claim = null;
  const finish = (result) => {
    claim?.release();
    settle(result);
  };

  const launch = () => {
    const startedAt = Date.now();
    const c = forkImpl(entry, args, { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
    child = c;
    c.stdout.on('data', (d) => log.write(String(d)));
    c.stderr.on('data', (d) => log.write(String(d)));
    let ended = false;
    const onEnd = (code, signal) => {
      if (ended) return;
      ended = true;
      child = null;
      if (stopped) return;
      if (code === 0) {
        note('server exited cleanly; not restarting.');
        finish({ reason: 'exited' });
        return;
      }
      if (code === EXIT_SETUP_REQUIRED) {
        note('server cannot start (needs setup, or its port is already in use; see above); not restarting.');
        finish({ reason: 'setup-required' });
        return;
      }
      if (Date.now() - startedAt >= stableMs) attempt = 0;
      const delay = backoffMs[Math.min(attempt, backoffMs.length - 1)];
      attempt += 1;
      note(`server exited (code ${code}, signal ${signal}); restarting in ${delay} ms`);
      timer = setTimeout(launch, delay);
    };
    let killing = false;
    c.on('error', (err) => {
      note(`child error: ${err.message}`);
      // e.g. a failed kill(): the child may still be running. Restarting now would run two servers,
      // so kill it and let its 'exit' drive the restart. No pid means it never started.
      if (c.pid !== undefined && c.exitCode === null && c.signalCode === null) {
        // A failing kill() emits 'error' synchronously: never re-kill from inside that (no loop).
        if (killing || err.syscall === 'kill') return;
        killing = true;
        try { c.kill(); } catch { /* 'exit' still decides */ } finally { killing = false; }
        return;
      }
      onEnd(null, null);
    });
    c.on('exit', onEnd);
  };

  // Claim the pid file (async: it may probe the port), then launch unless refused or already stopped.
  const started = (async () => {
    try {
      claim = await claimPidFile(home, {
        onStopRequest: () => stop(), pollMs: controlPollMs, isAlive, portAnswers, port, log: note,
      });
    } catch (err) {
      note(`not starting: ${err.message}`);
      settle({ reason: 'error', message: err.message });
      return false;
    }
    if (!claim.ok) {
      note(`not starting: ${alreadyRunningMessage(claim.pid, home)}`);
      const { pid } = claim;
      claim = null;
      settle({ reason: 'already-running', pid });
      return false;
    }
    if (stopped) {
      note('stopped.');
      finish({ reason: 'stopped' });
      return false;
    }
    launch();
    return true;
  })();

  const stop = async () => {
    if (stopped) return done;
    stopped = true;
    if (!(await started)) return done; // refused, failed, or stopped before launch (already settled)
    clearTimeout(timer);
    if (child) {
      const c = child;
      const exited = new Promise((r) => c.once('exit', r));
      // The server shuts down cleanly when its IPC channel closes (cli.js); kill only if it hangs.
      const killer = setTimeout(() => c.kill(), killAfterMs);
      if (c.connected) c.disconnect();
      else c.kill();
      await exited;
      clearTimeout(killer);
    }
    note('stopped.');
    finish({ reason: 'stopped' });
    return done;
  };
  return { stop, done };
}

// Asks the server recorded in <home>/server.pid to stop, and waits for it (never kills it).
// Resolves 'stopped', 'not running' (no or stale pid file) or 'timeout — <pid> did not stop'.
export async function stopRunning({ home, waitMs = 15000, pollMs = 100, isAlive = processAlive }) {
  const pidFile = pidFilePath(home);
  let pid;
  try { pid = Number(fs.readFileSync(pidFile, 'utf8').trim()); } catch { return 'not running'; }
  if (!Number.isInteger(pid) || pid <= 0 || !isAlive(pid)) {
    rmQuiet(pidFile);
    return 'not running';
  }
  fs.writeFileSync(stopRequestPath(home), 'stop');
  const end = Date.now() + waitMs;
  while (Date.now() < end) {
    if (!fs.existsSync(pidFile) || !isAlive(pid)) return 'stopped';
    await new Promise((r) => setTimeout(r, pollMs));
  }
  rmQuiet(stopRequestPath(home)); // don't let the stale request stop a later run by surprise
  return `timeout — ${pid} did not stop. ${staleHint(home)}`;
}
