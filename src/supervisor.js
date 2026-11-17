import fs from 'node:fs';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const EXIT_SETUP_REQUIRED = 78; // sysexits EX_CONFIG
const CLI = fileURLToPath(new URL('./cli.js', import.meta.url));

// The running supervisor's pid, and the file "herdr-remote stop" drops to ask it to stop.
// A request file (not a signal) because Windows cannot deliver a catchable signal to another process.
export const pidFilePath = (home) => path.join(home, 'server.pid');
const stopRequestPath = (home) => path.join(home, 'server.stop');
const rmQuiet = (file) => { try { fs.rmSync(file, { force: true }); } catch { /* best effort */ } };

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
} = {}) {
  const log = createLog(path.join(home, 'logs'), maxLogBytes);
  const note = (m) => log.write(`[supervisor ${new Date().toISOString()}] ${m}\n`);
  let child = null;
  let timer = null;
  let stopped = false;
  let attempt = 0;
  let settle;
  const done = new Promise((r) => { settle = r; });

  const pidFile = pidFilePath(home);
  const stopFile = stopRequestPath(home);
  rmQuiet(stopFile); // a leftover request must not stop this run
  fs.writeFileSync(pidFile, String(process.pid));
  const control = setInterval(() => { if (fs.existsSync(stopFile)) { rmQuiet(stopFile); stop(); } }, controlPollMs);
  control.unref?.();
  const finish = (result) => {
    clearInterval(control);
    try { if (fs.readFileSync(pidFile, 'utf8').trim() === String(process.pid)) rmQuiet(pidFile); } catch { /* already gone */ }
    settle(result);
  };

  const launch = () => {
    const startedAt = Date.now();
    child = fork(entry, args, { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
    child.stdout.on('data', (d) => log.write(String(d)));
    child.stderr.on('data', (d) => log.write(String(d)));
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
    child.on('error', (err) => { note(`child error: ${err.message}`); onEnd(null, null); });
    child.on('exit', onEnd);
  };
  launch();

  const stop = async () => {
    if (stopped) return done;
    stopped = true;
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

const processAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
};

// Asks the supervisor recorded in <home>/server.pid to stop, and waits for it.
// Resolves 'stopped', 'not running' (no or stale pid file) or 'timeout'.
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
  return 'timeout';
}
