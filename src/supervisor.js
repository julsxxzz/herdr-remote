import fs from 'node:fs';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const EXIT_SETUP_REQUIRED = 78; // sysexits EX_CONFIG
const CLI = fileURLToPath(new URL('./cli.js', import.meta.url));

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
} = {}) {
  const log = createLog(path.join(home, 'logs'), maxLogBytes);
  const note = (m) => log.write(`[supervisor ${new Date().toISOString()}] ${m}\n`);
  let child = null;
  let timer = null;
  let stopped = false;
  let attempt = 0;
  let finish;
  const done = new Promise((r) => { finish = r; });

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
        note('server needs setup; not restarting. Run "npm run setup".');
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
      c.kill();
      await exited;
    }
    finish({ reason: 'stopped' });
    return done;
  };
  return { stop, done };
}
