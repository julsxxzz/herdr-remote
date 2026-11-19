// Starting, restarting and inspecting an installed server: "status", "restart", the start at the end
// of setup, and the one-time move from herdr-remote (the project's old name).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { renderUnicodeCompact } from 'uqr';
import { configDir, explicitHome, legacyConfigDir, loadConfig, migrateLegacyHome, validateConfig } from './config.js';
import {
  pidAlive, pidFilePath, probePort, processAlive, readPid, stopRunning, SERVER_NODE_FLAGS,
} from './supervisor.js';
import {
  installTask as realInstallTask, isNpxCachePath, isTaskInstalled, runCommand, runTask, TASK_NAME,
} from './startup-task.js';

export const CLI_PATH = fileURLToPath(new URL('./cli.js', import.meta.url));

const isFileSync = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

// True when cliPath is <prefix>\node_modules\remote-for-herdr\src\cli.js of a global npm install: the
// bin shim sits next to that node_modules (Windows), or in <prefix>/bin for <prefix>/lib/node_modules.
function isGlobalInstall(cliPath, isFile) {
  const nm = path.dirname(path.dirname(path.dirname(cliPath)));
  if (path.basename(nm).toLowerCase() !== 'node_modules') return false;
  const parent = path.dirname(nm);
  if (isFile(path.join(parent, 'remote-for-herdr.cmd'))) return true;
  return path.basename(parent) === 'lib' && isFile(path.join(path.dirname(parent), 'bin', 'remote-for-herdr'));
}

// How the user runs this copy: "remote-for-herdr" from a global npm install (on PATH), "npx
// remote-for-herdr" from npx's cache or a local (project) install, "node <path>\cli.js" from a source
// checkout.
export function cliCommand(cliPath = CLI_PATH, { isFile = isFileSync } = {}) {
  if (isNpxCachePath(cliPath)) return 'npx remote-for-herdr';
  if (/[\\/]node_modules[\\/]/i.test(cliPath)) {
    return isGlobalInstall(cliPath, isFile) ? 'remote-for-herdr' : 'npx remote-for-herdr';
  }
  return `node "${cliPath}"`;
}

// The phone URL as a QR code drawn with block characters (light modules are filled, for a dark terminal;
// phone scanners also read it on a light one), with the standard 4-module quiet zone.
export const qrText = (url) => renderUnicodeCompact(url, { border: 4 });

// Resolves true once the server is up: <home>\server.pid names a live process that is the one we
// started (pid, when known) or was written after `since` (a task's server: pid unknown), AND the port
// answers. A port answered by some other program is not "running". False after timeoutMs.
// Liveness only (pidAlive, no image check): a pid we started, or a file written after `since`, is never
// one left behind by an earlier run, and this polls (the image check costs a few tenths of a second).
export async function waitForServer({
  home, port, pid = null, since = 0, portAnswers = probePort, isAlive = pidAlive, timeoutMs = 10000, pollMs = 250,
}) {
  const ours = () => {
    const file = pidFilePath(home);
    const holder = readPid(file);
    if (holder === null || !isAlive(holder)) return false;
    if (pid) return holder === pid;
    try { return fs.statSync(file).mtimeMs >= since - 2000; } catch { return false; }
  };
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (ours() && await portAnswers(port)) return true;
    if (Date.now() >= end) return false;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

// Runs "start --foreground --log" in its own hidden, detached process (it outlives this one). Used when
// no start-at-login task is installed: no restart after a crash, but the app is up now.
export function startDetached({ home, cliPath = CLI_PATH, nodePath = process.execPath, spawnImpl = spawn } = {}) {
  const child = spawnImpl(nodePath, [...SERVER_NODE_FLAGS, cliPath, 'start', '--foreground', '--log', '--home', home], {
    detached: true, stdio: 'ignore', windowsHide: true,
  });
  child.on?.('error', () => {}); // reported by the wait that follows
  child.unref?.();
  return child;
}

const notUp = (port) => `it did not come up on port ${port} (see logs\\server.log)`;

// Starts the task and waits for its server. A launcher still in its restart pause (or still finishing
// after a stop) makes Task Scheduler ignore a /Run (MultipleInstancesPolicy IgnoreNew), so it is ended
// first (/End, errors ignored: usually nothing runs); one more /Run if it still does not come up.
export async function runTaskAndWait({ exec, home, port, waitUntilRunning = waitForServer }) {
  await exec('schtasks', ['/End', '/TN', TASK_NAME]);
  for (let attempt = 0; attempt < 2; attempt++) {
    const since = Date.now();
    const r = await runTask({ exec });
    if (!r.ok) return { ok: false, message: r.message };
    if (await waitUntilRunning({ home, port, since })) return { ok: true };
  }
  return { ok: false, message: notUp(port) };
}

// Starts a detached server and waits for it (its pid must be the one in server.pid).
export async function startDetachedAndWait({
  home, port, cliPath = CLI_PATH, startDetachedImpl = startDetached, waitUntilRunning = waitForServer,
}) {
  const since = Date.now();
  const child = startDetachedImpl({ home, cliPath });
  const ok = await waitUntilRunning({ home, port, pid: child?.pid ?? null, since });
  return { ok, message: ok ? '' : notUp(port) };
}

export async function getStatus({ home, exec = runCommand, isAlive = processAlive, portAnswers = probePort }) {
  let cfg = null;
  try { cfg = loadConfig(home); } catch { /* unreadable: reported as not set up */ }
  const pid = readPid(pidFilePath(home));
  const alive = pid !== null && isAlive(pid);
  const port = Number.isInteger(cfg?.port) && cfg.port > 0 ? cfg.port : null;
  return {
    home: path.resolve(home),
    configured: cfg !== null && validateConfig(cfg).length === 0,
    running: alive,
    pid: alive ? pid : null,
    port,
    answering: port !== null && await portAnswers(port),
    url: cfg?.publicOrigin ?? null,
    taskInstalled: await isTaskInstalled({ exec }),
  };
}

export function formatStatus(s, { cmd = cliCommand() } = {}) {
  const running = s.running
    ? `yes (pid ${s.pid}${s.port ? `, port ${s.port}${s.answering ? '' : ' not answering yet'}` : ''})`
    : `no${s.answering ? ` (but something else answers on port ${s.port})` : ''}`;
  return [
    `Running:        ${running}`,
    `Phone URL:      ${s.configured ? s.url : `not set up yet (run: ${cmd} setup)`}`,
    `Start at login: ${s.taskInstalled ? 'installed' : `not installed (${cmd} install-task)`}`,
    `Config folder:  ${s.home}`,
  ].join('\n');
}

// "restart": stop the running server, then start it the way it is installed: through the start-at-login
// task, or (no task) as a detached background server, so it is never left down. Resolves
// { stopped, how: 'task' | 'detached', ok, message }.
export async function restart({
  home, exec = runCommand, log = console.log, stop = stopRunning, cliPath = CLI_PATH,
  waitUntilRunning = waitForServer, startDetachedImpl = startDetached,
}) {
  const task = await isTaskInstalled({ exec });
  const stopped = await stop({ home });
  if (stopped.startsWith('timeout')) throw new Error(`remote-for-herdr did not stop in time: ${stopped}`);
  log(stopped === 'stopped' ? 'Stopped.' : 'It was not running.');
  let port = null;
  try { port = loadConfig(home).port; } catch { /* reported by the start */ }
  if (task) {
    const r = await runTaskAndWait({ exec, home, port, waitUntilRunning });
    log(r.ok ? 'Started (start-at-login task).' : `Could not start the start-at-login task: ${r.message}`);
    return { stopped, how: 'task', ...r };
  }
  const cmd = cliCommand(cliPath);
  const r = await startDetachedAndWait({ home, port, cliPath, startDetachedImpl, waitUntilRunning });
  log(r.ok ? 'Started in the background.' : `Could not start it: ${r.message}`);
  log(`No start-at-login task is installed, so it will not start again after a crash or at login. To add it: ${cmd} install-task, then ${cmd} restart`);
  return { stopped, how: 'detached', ...r };
}

// True when the old herdr-remote folder still waits to be moved (default config folder only).
export function legacyPending({ env = process.env, platform = process.platform, home, fsImpl = fs } = {}) {
  if (explicitHome({ env, home })) return false;
  return !fsImpl.existsSync(configDir({ env, platform })) && fsImpl.existsSync(legacyConfigDir({ env, platform }));
}

export const MIGRATE_NPX_HINT = 'Found a herdr-remote start-at-login task. It cannot be moved from npx\'s temporary '
  + 'cache (the new task would point at a copy npm may delete), so nothing was changed. Install remote-for-herdr '
  + 'first, then run it from there:\n'
  + '  npm i -g remote-for-herdr\n'
  + '  remote-for-herdr restart';

// The one-time move from herdr-remote, run before setup/start/restart/install-task. Only for the
// default config folder (no --home, no environment variable). A server still running from the old
// folder is stopped first (it holds files there open and would keep using that folder); if it does not
// stop, nothing is moved. If herdr-remote had a start-at-login task, it is replaced by the
// remote-for-herdr one pointing at this install; from npx's cache that cannot be done, so then nothing
// is moved at all (the old task keeps working) and the user is told to install globally first.
// restartFollows: the command starts the server itself (no "start it again" hint). Resolves null when
// there was nothing to move; throws when it must not move.
export async function migrateFromHerdrRemote({
  env = process.env, platform = process.platform, home, log = console.log, exec = runCommand,
  stop = stopRunning, installTask = realInstallTask, cliPath = CLI_PATH, fsImpl = fs, restartFollows = false,
}) {
  if (!legacyPending({ env, platform, home, fsImpl })) return null;
  const from = legacyConfigDir({ env, platform });
  const to = configDir({ env, platform });
  const hadTask = fsImpl.existsSync(path.join(from, 'start-hidden.vbs'));
  if (hadTask && isNpxCachePath(cliPath)) throw new Error(MIGRATE_NPX_HINT);
  let wasRunning = false;
  if (fsImpl.existsSync(pidFilePath(from))) {
    const oldPid = readPid(pidFilePath(from));
    const r = await stop({ home: from });
    if (r.startsWith('timeout')) {
      throw new Error(`Could not stop the old herdr-remote server (pid ${oldPid ?? 'unknown'}); stop it (Task Manager), then run this again. Nothing was moved.`);
    }
    wasRunning = r === 'stopped';
  }
  if (wasRunning) log('Stopped herdr-remote (running from the old config folder) to move its config.');
  const moved = migrateLegacyHome({ env, platform, log, fsImpl });
  if (!moved) return null;
  if (hadTask) {
    try {
      await installTask({ home: to, cliPath, exec, legacyHome: moved.mode === 'copied' ? from : null });
      log('Replaced the old "herdr-remote" start-at-login task with "remote-for-herdr".');
    } catch (err) {
      log(`Could not move the start-at-login task: ${err.message}`);
    }
  }
  if (wasRunning && !restartFollows) log(`Start it again with: ${cliCommand(cliPath)} ${hadTask ? 'restart' : 'start'}`);
  return { ...moved, hadTask, wasRunning };
}
