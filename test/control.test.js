import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  cliCommand, qrText, waitForPort, startDetached, startInstalled, getStatus, formatStatus, restart,
  migrateFromHerdrRemote,
} from '../src/control.js';
import { saveConfig, DEFAULT_CONFIG, loadConfig } from '../src/config.js';
import { pidFilePath, SERVER_NODE_FLAGS } from '../src/supervisor.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hr-ctl-'));
const quiet = () => { const lines = []; return { log: (m) => lines.push(m), lines }; };
const GLOBAL_CLI = 'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\remote-for-herdr\\src\\cli.js';
const good = {
  ...DEFAULT_CONFIG, port: 4791, pinHash: 'h', publicOrigin: 'https://box.example.ts.net',
  vapid: { publicKey: 'p', privateKey: 'k' }, allowedLogin: 'owner@example.com',
};

// schtasks stub: `tasks` are the existing task names; /Run fails unless the task exists.
function fakeSchtasks(tasks = []) {
  const calls = [];
  const exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    const name = args[args.indexOf('/TN') + 1];
    return tasks.includes(name) ? { code: 0, stdout: '', stderr: '' } : { code: 1, stdout: '', stderr: `ERROR: no task ${name}` };
  };
  return { exec, calls };
}

test('cliCommand: npx, npm install, source checkout', () => {
  assert.equal(cliCommand('C:\\c\\npm-cache\\_npx\\ab\\node_modules\\remote-for-herdr\\src\\cli.js'), 'npx remote-for-herdr');
  assert.equal(cliCommand(GLOBAL_CLI), 'remote-for-herdr');
  assert.equal(cliCommand('/usr/lib/node_modules/remote-for-herdr/src/cli.js'), 'remote-for-herdr');
  assert.equal(cliCommand('C:\\src\\rfh\\src\\cli.js'), 'node "C:\\src\\rfh\\src\\cli.js"');
});

test('qrText draws a QR code of the URL with block characters', () => {
  const q = qrText('https://box.example.ts.net');
  const rows = q.split('\n');
  assert.ok(rows.length > 10);
  assert.ok(rows.every((r) => r.length === rows[0].length));
  assert.match(q, /[█▀▄]/);
});

test('waitForPort: true once the port answers, false after the timeout', async () => {
  let n = 0;
  assert.equal(await waitForPort(1, { portAnswers: async () => ++n >= 3, pollMs: 1 }), true);
  assert.equal(n, 3);
  assert.equal(await waitForPort(1, { portAnswers: async () => false, timeoutMs: 20, pollMs: 5 }), false);
});

test('startDetached runs "start --foreground --log --home" hidden, detached and unref\'d', () => {
  const seen = [];
  const child = { on: () => {}, unref: () => seen.push('unref') };
  startDetached({
    home: 'C:\\h', cliPath: 'C:\\a\\cli.js', nodePath: 'C:\\n\\node.exe',
    spawnImpl: (cmd, args, opts) => { seen.push([cmd, args, opts]); return child; },
  });
  assert.deepEqual(seen, [
    ['C:\\n\\node.exe', [...SERVER_NODE_FLAGS, 'C:\\a\\cli.js', 'start', '--foreground', '--log', '--home', 'C:\\h'],
      { detached: true, stdio: 'ignore', windowsHide: true }],
    'unref',
  ]);
});

test('startInstalled: the task when installed, else detached (only when allowed)', async () => {
  let f = fakeSchtasks(['remote-for-herdr']);
  let r = await startInstalled({ home: 'h', port: 4791, exec: f.exec, waitUntilRunning: async () => true, startDetachedImpl: () => assert.fail('no') });
  assert.deepEqual(r, { how: 'task', ok: true });
  assert.deepEqual(f.calls.map((c) => c[1]), ['/Query', '/Run']);
  f = fakeSchtasks();
  const started = [];
  r = await startInstalled({ home: 'h', port: 4791, exec: f.exec, cliPath: 'C:\\a\\cli.js', waitUntilRunning: async () => true, startDetachedImpl: (o) => started.push(o) });
  assert.deepEqual(r, { how: 'detached', ok: true, message: '' });
  assert.deepEqual(started, [{ home: 'h', cliPath: 'C:\\a\\cli.js' }]);
  r = await startInstalled({ home: 'h', port: 4791, exec: f.exec, allowDetached: false, startDetachedImpl: () => assert.fail('no') });
  assert.deepEqual(r, { how: 'none', ok: false });
});

test('status: not set up, nothing running, no task', async () => {
  const home = tmp();
  const s = await getStatus({ home, exec: fakeSchtasks().exec, portAnswers: async () => false });
  assert.deepEqual(s, { home, configured: false, running: false, pid: null, port: 4780, answering: false, url: null, taskInstalled: false });
  const text = formatStatus(s, { cmd: 'remote-for-herdr' });
  assert.match(text, /^Running: +no$/m);
  assert.match(text, /^Phone URL: +not set up yet \(run: remote-for-herdr setup\)$/m);
  assert.match(text, /^Start at login: +not installed \(remote-for-herdr install-task\)$/m);
  assert.ok(text.includes(home));
});

test('status: running with pid, port, URL and the task', async () => {
  const home = tmp();
  saveConfig(home, good);
  fs.writeFileSync(pidFilePath(home), '4242');
  const s = await getStatus({ home, exec: fakeSchtasks(['remote-for-herdr']).exec, isAlive: (p) => p === 4242, portAnswers: async (p) => p === 4791 });
  assert.deepEqual(s, { home, configured: true, running: true, pid: 4242, port: 4791, answering: true, url: 'https://box.example.ts.net', taskInstalled: true });
  const text = formatStatus(s);
  assert.match(text, /^Running: +yes \(pid 4242, port 4791\)$/m);
  assert.match(text, /^Phone URL: +https:\/\/box\.example\.ts\.net$/m);
  assert.match(text, /^Start at login: +installed$/m);
});

test('status: a dead pid is not running; something else on the port is said so', async () => {
  const home = tmp();
  saveConfig(home, good);
  fs.writeFileSync(pidFilePath(home), '4242');
  const s = await getStatus({ home, exec: fakeSchtasks().exec, isAlive: () => false, portAnswers: async () => true });
  assert.equal(s.running, false);
  assert.equal(s.pid, null);
  assert.match(formatStatus(s), /^Running: +no \(but something else answers on port 4791\)$/m);
});

test('restart with the task installed: stop, then /Run the task and wait for the port', async () => {
  const home = tmp();
  saveConfig(home, good);
  const f = fakeSchtasks(['remote-for-herdr']);
  const out = quiet();
  const waited = [];
  const stops = [];
  const r = await restart({
    home, exec: f.exec, log: out.log, cliPath: GLOBAL_CLI,
    stop: async (o) => { stops.push(o); return 'stopped'; },
    waitUntilRunning: async (p) => { waited.push(p); return true; },
  });
  assert.deepEqual(stops, [{ home }]);
  assert.deepEqual(f.calls.map((c) => c.slice(1).join(' ')), ['/Query /TN remote-for-herdr', '/Run /TN remote-for-herdr']);
  assert.deepEqual(waited, [4791]);
  assert.deepEqual(out.lines, ['Stopped.', 'Started (start-at-login task).']);
  assert.equal(r.how, 'task');
  assert.equal(r.ok, true);
});

test('restart without a task: stops, then says how to start it (nothing started)', async () => {
  const home = tmp();
  saveConfig(home, good);
  const f = fakeSchtasks();
  const out = quiet();
  const r = await restart({ home, exec: f.exec, log: out.log, cliPath: GLOBAL_CLI, stop: async () => 'not running', waitUntilRunning: async () => assert.fail('no') });
  assert.deepEqual(f.calls.map((c) => c[1]), ['/Query']);
  assert.equal(out.lines[0], 'It was not running.');
  assert.equal(out.lines[1], 'No start-at-login task is installed. Start it with: remote-for-herdr start');
  assert.equal(r.how, 'none');
});

test('restart: a stop that times out fails before starting anything', async () => {
  const f = fakeSchtasks(['remote-for-herdr']);
  await assert.rejects(
    restart({ home: tmp(), exec: f.exec, log: () => {}, stop: async () => 'timeout — 1 did not stop.' }),
    /did not stop in time/,
  );
  assert.deepEqual(f.calls, []);
});

// A fake APPDATA in a temp dir: never the real one.
function appData() {
  const root = tmp();
  return { env: { APPDATA: root, XDG_CONFIG_HOME: root }, from: path.join(root, 'herdr-remote'), to: path.join(root, 'remote-for-herdr') };
}

test('migrate: moves the folder; a running old server is stopped first; an old task is replaced', async () => {
  const { env, from, to } = appData();
  fs.mkdirSync(from);
  saveConfig(from, good);
  fs.writeFileSync(path.join(from, 'start-hidden.vbs'), 'old launcher');
  fs.writeFileSync(pidFilePath(from), '4242');
  const out = quiet();
  const order = [];
  const r = await migrateFromHerdrRemote({
    env, log: out.log, cliPath: GLOBAL_CLI,
    stop: async ({ home }) => { order.push(['stop', home]); fs.rmSync(pidFilePath(home)); return 'stopped'; },
    installTask: async (o) => { order.push(['install', o]); },
  });
  assert.deepEqual(order, [['stop', from], ['install', { home: to, cliPath: GLOBAL_CLI, exec: order[1][1].exec, legacyHome: null }]]);
  assert.equal(r.mode, 'moved');
  assert.equal(r.hadTask, true);
  assert.equal(r.wasRunning, true);
  assert.equal(loadConfig(to).publicOrigin, 'https://box.example.ts.net'); // same phone link
  assert.equal(fs.existsSync(from), false);
  assert.ok(out.lines.some((l) => l.startsWith('Moved your herdr-remote config')));
  assert.ok(out.lines.includes('Replaced the old "herdr-remote" start-at-login task with "remote-for-herdr".'));
  assert.equal(out.lines.at(-1), 'Start it again with: remote-for-herdr restart');
});

test('migrate: nothing running and no task: only the move', async () => {
  const { env, from, to } = appData();
  fs.mkdirSync(from);
  saveConfig(from, good);
  const out = quiet();
  const r = await migrateFromHerdrRemote({
    env, log: out.log, stop: async () => assert.fail('nothing to stop'), installTask: async () => assert.fail('no task'),
  });
  assert.deepEqual(r, { from, to, mode: 'moved', hadTask: false, wasRunning: false });
  assert.equal(out.lines.length, 1);
});

test('migrate: skipped with --home or an env home, when the new folder exists, or with no old folder', async () => {
  const { env, from, to } = appData();
  const never = { stop: async () => assert.fail('no'), installTask: async () => assert.fail('no'), log: () => assert.fail('no') };
  assert.equal(await migrateFromHerdrRemote({ env, ...never }), null);
  fs.mkdirSync(from);
  assert.equal(await migrateFromHerdrRemote({ env, home: tmp(), ...never }), null);
  assert.equal(await migrateFromHerdrRemote({ env: { ...env, REMOTE_FOR_HERDR_HOME: tmp() }, ...never }), null);
  assert.equal(await migrateFromHerdrRemote({ env: { ...env, HERDR_REMOTE_HOME: tmp() }, ...never }), null);
  fs.mkdirSync(to);
  assert.equal(await migrateFromHerdrRemote({ env, ...never }), null);
});

test('migrate: a task that cannot be moved (npx cache) is reported, the folder still moves', async () => {
  const { env, from, to } = appData();
  fs.mkdirSync(from);
  fs.writeFileSync(path.join(from, 'start-hidden.vbs'), 'old');
  const out = quiet();
  const { installTask } = await import('../src/startup-task.js');
  const cliPath = 'C:\\c\\npm-cache\\_npx\\ab\\node_modules\\remote-for-herdr\\src\\cli.js';
  const r = await migrateFromHerdrRemote({ env, log: out.log, cliPath, installTask, exec: async () => assert.fail('no schtasks') });
  assert.equal(r.mode, 'moved');
  assert.ok(fs.existsSync(to));
  assert.ok(out.lines.some((l) => l.startsWith('Could not move the start-at-login task:') && l.includes('npm i -g remote-for-herdr')));
});

