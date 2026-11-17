// Starting, restarting and inspecting an installed server: "status", "restart", the start at the end
// of setup, and the one-time move from herdr-remote (the project's old name).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { renderUnicodeCompact } from 'uqr';
import { configDir, explicitHome, legacyConfigDir, loadConfig, migrateLegacyHome, validateConfig } from './config.js';
import {
  pidFilePath, probePort, processAlive, readPid, stopRunning, SERVER_NODE_FLAGS,
} from './supervisor.js';
import {
  installTask as realInstallTask, isNpxCachePath, isTaskInstalled, runCommand, runTask,
} from './startup-task.js';

export const CLI_PATH = fileURLToPath(new URL('./cli.js', import.meta.url));

// How the user runs this copy: "npx remote-for-herdr" from npx's cache, "remote-for-herdr" from an npm
// install (global or local, the bin is on PATH), "node <path>\cli.js" from a source checkout.
export function cliCommand(cliPath = CLI_PATH) {
  if (isNpxCachePath(cliPath)) return 'npx remote-for-herdr';
  if (/[\\/]node_modules[\\/]/i.test(cliPath)) return 'remote-for-herdr';
  return `node "${cliPath}"`;
}

// The phone URL as a QR code drawn with block characters (light modules are filled, for a dark terminal;
// phone scanners also read it on a light one).
export const qrText = (url) => renderUnicodeCompact(url, { border: 2 });

// Resolves true once something answers on 127.0.0.1:<port>, false after timeoutMs.
export async function waitForPort(port, { portAnswers = probePort, timeoutMs = 10000, pollMs = 250 } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (await portAnswers(port)) return true;
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
  child.on?.('error', () => {}); // reported by the port check that follows
  child.unref?.();
  return child;
}

// Starts the task and waits for the server's port. A task whose launcher is still finishing (just
// stopped) ignores a /Run (MultipleInstancesPolicy IgnoreNew), so one more /Run if it does not come up.
export async function runTaskAndWait({ exec, port, waitUntilRunning }) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await runTask({ exec });
    if (!r.ok) return { ok: false, message: r.message };
    if (await waitUntilRunning(port)) return { ok: true };
  }
  return { ok: false, message: `nothing answers on port ${port} yet (see logs\\server.log)` };
}

// Starts the server the way it is installed: the start-at-login task if it exists, else (when
// allowed) a detached foreground server. Resolves { how: 'task' | 'detached' | 'none', ok, message }.
export async function startInstalled({
  home, port, exec = runCommand, cliPath = CLI_PATH, allowDetached = true,
  waitUntilRunning = (p) => waitForPort(p), startDetachedImpl = startDetached,
}) {
  if (await isTaskInstalled({ exec })) {
    return { how: 'task', ...(await runTaskAndWait({ exec, port, waitUntilRunning })) };
  }
  if (!allowDetached) return { how: 'none', ok: false };
  startDetachedImpl({ home, cliPath });
  const ok = await waitUntilRunning(port);
  return { how: 'detached', ok, message: ok ? '' : `nothing answers on port ${port} yet (see logs\\server.log)` };
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

// "restart": stop the running server, then start it the way it is installed (the start-at-login task).
// Without a task it says how to start it instead. Resolves { stopped, how, ok }.
export async function restart({
  home, exec = runCommand, log = console.log, stop = stopRunning, cliPath = CLI_PATH,
  waitUntilRunning = (p) => waitForPort(p),
}) {
  const stopped = await stop({ home });
  if (stopped.startsWith('timeout')) throw new Error(`remote-for-herdr did not stop in time: ${stopped}`);
  log(stopped === 'stopped' ? 'Stopped.' : 'It was not running.');
  let port = null;
  try { port = loadConfig(home).port; } catch { /* reported by the start */ }
  const r = await startInstalled({ home, port, exec, cliPath, allowDetached: false, waitUntilRunning });
  const cmd = cliCommand(cliPath);
  if (r.how === 'task') {
    log(r.ok ? 'Started (start-at-login task).' : `Could not start the start-at-login task: ${r.message}`);
  } else {
    log(`No start-at-login task is installed. Start it with: ${cmd} start`);
    log(`(or install the task, which also starts it at every login: ${cmd} install-task, then ${cmd} restart)`);
  }
  return { stopped, ...r };
}

// The one-time move from herdr-remote, run before any command. Only for the default config folder
// (no --home, no environment variable). A server still running from the old folder is stopped first
// (it holds files there open and would keep using that folder); if herdr-remote had a start-at-login
// task, it is replaced by the remote-for-herdr one pointing at this install. Resolves null when there
// was nothing to move.
export async function migrateFromHerdrRemote({
  env = process.env, platform = process.platform, home, log = console.log, exec = runCommand,
  stop = stopRunning, installTask = realInstallTask, cliPath = CLI_PATH, fsImpl = fs,
}) {
  if (explicitHome({ env, home })) return null;
  const from = legacyConfigDir({ env, platform });
  const to = configDir({ env, platform });
  if (fsImpl.existsSync(to) || !fsImpl.existsSync(from)) return null;
  const hadTask = fsImpl.existsSync(path.join(from, 'start-hidden.vbs'));
  const wasRunning = fsImpl.existsSync(pidFilePath(from)) && (await stop({ home: from })) === 'stopped';
  if (wasRunning) log('Stopped herdr-remote (running from the old config folder) to move its config.');
  const moved = migrateLegacyHome({ env, platform, log, fsImpl });
  if (!moved) return null;
  const cmd = cliCommand(cliPath);
  if (hadTask) {
    try {
      await installTask({ home: to, cliPath, exec, legacyHome: moved.mode === 'copied' ? from : null });
      log('Replaced the old "herdr-remote" start-at-login task with "remote-for-herdr".');
    } catch (err) {
      log(`Could not move the start-at-login task: ${err.message}`);
    }
  }
  if (wasRunning) log(`Start it again with: ${cmd} ${hadTask ? 'restart' : 'start'}`);
  return { ...moved, hadTask, wasRunning };
}
