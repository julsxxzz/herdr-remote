import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  cliCommand, qrText, waitForServer, startDetached, runTaskAndWait, getStatus, formatStatus, restart,
  migrateFromHerdrRemote, legacyPending,
} from '../src/control.js';
import { saveConfig, DEFAULT_CONFIG, loadConfig } from '../src/config.js';
import { pidFilePath, SERVER_NODE_FLAGS } from '../src/supervisor.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hr-ctl-'));
const quiet = () => { const lines = []; return { log: (m) => lines.push(m), lines }; };
const good = {
  ...DEFAULT_CONFIG, port: 4791, pinHash: 'h', publicOrigin: 'https://box.example.ts.net',
  vapid: { publicKey: 'p', privateKey: 'k' }, allowedLogin: 'owner@example.com',
};
const NPX_CLI = 'C:\\c\\npm-cache\\_npx\\ab\\node_modules\\remote-for-herdr\\src\\cli.js';
const GLOBAL_CLI = 'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\remote-for-herdr\\src\\cli.js';
const globalShim = (p) => p === path.join('C:\\Users\\me\\AppData\\Roaming\\npm', 'remote-for-herdr.cmd');

// schtasks stub: `tasks` are the existing task names; /Run, /Query, /End fail unless the task exists.
function fakeSchtasks(tasks = []) {
  const calls = [];
  const exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    const name = args[args.indexOf('/TN') + 1];
    return tasks.includes(name) ? { code: 0, stdout: '', stderr: '' } : { code: 1, stdout: '', stderr: `ERROR: no task ${name}` };
  };
  return { exec, calls };
}
const verbs = (calls) => calls.map((c) => c[1]);

test('cliCommand: npx cache and local installs use npx; a global install the bare name; a checkout node', () => {
  assert.equal(cliCommand(NPX_CLI), 'npx remote-for-herdr');
  assert.equal(cliCommand(GLOBAL_CLI, { isFile: globalShim }), 'remote-for-herdr');
  assert.equal(cliCommand(GLOBAL_CLI, { isFile: () => false }), 'npx remote-for-herdr'); // no shim: a local install
  assert.equal(cliCommand('C:\\proj\\node_modules\\remote-for-herdr\\src\\cli.js', { isFile: () => false }), 'npx remote-for-herdr');
  assert.equal(
    cliCommand('/usr/lib/node_modules/remote-for-herdr/src/cli.js', { isFile: (p) => p === path.join('/usr', 'bin', 'remote-for-herdr') }),
    'remote-for-herdr',
  );
  assert.equal(cliCommand('C:\\src\\rfh\\src\\cli.js'), 'node "C:\\src\\rfh\\src\\cli.js"');
});

test('qrText draws a QR code of the URL with a 4-module quiet zone', () => {
  const rows = qrText('https://box.example.ts.net').split('\n');
  assert.ok(rows.length > 10);
  assert.ok(rows.every((r) => r.length === rows[0].length));
  // Compact rendering: 2 modules per text row, light = full block. 4 light modules = 2 full rows and 4 full columns.
  assert.ok(rows.slice(0, 2).every((r) => /^█+$/.test(r)), rows.slice(0, 3).join('\n'));
  assert.ok(rows.slice(2, -2).every((r) => r.startsWith('████') && r.endsWith('████')));
});

test('waitForServer: needs a live pid in server.pid that is ours AND the port answering', async () => {
  const home = tmp();
  const fast = { timeoutMs: 30, pollMs: 5 };
  const alive = (p) => p === 111 || p === 222;
  // Another program on the port, no server.pid: not running.
  assert.equal(await waitForServer({ home, port: 1, pid: 111, portAnswers: async () => true, isAlive: alive, ...fast }), false);
  fs.writeFileSync(pidFilePath(home), '222');
  // Someone else's server.pid (not the pid we started): not ours.
  assert.equal(await waitForServer({ home, port: 1, pid: 111, portAnswers: async () => true, isAlive: alive, ...fast }), false);
  fs.writeFileSync(pidFilePath(home), '111');
  assert.equal(await waitForServer({ home, port: 1, pid: 111, portAnswers: async () => false, isAlive: alive, ...fast }), false);
  assert.equal(await waitForServer({ home, port: 1, pid: 111, portAnswers: async () => true, isAlive: alive, ...fast }), true);
  assert.equal(await waitForServer({ home, port: 1, pid: 111, portAnswers: async () => true, isAlive: () => false, ...fast }), false);
  // Task start (pid unknown): the pid file must have been written since the /Run.
  const since = Date.now();
  assert.equal(await waitForServer({ home, port: 1, since: since - 60000, portAnswers: async () => true, isAlive: alive, ...fast }), true);
  const old = new Date(since - 600000);
  fs.utimesSync(pidFilePath(home), old, old);
  assert.equal(await waitForServer({ home, port: 1, since, portAnswers: async () => true, isAlive: alive, ...fast }), false);
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

test('runTaskAndWait: /End (a launcher in its backoff pause) before /Run; one more /Run if it does not come up', async () => {
  let f = fakeSchtasks(['remote-for-herdr']);
  const waited = [];
  let r = await runTaskAndWait({ exec: f.exec, home: 'h', port: 4791, waitUntilRunning: async (o) => { waited.push(o); return true; } });
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(verbs(f.calls), ['/End', '/Run']);
  assert.equal(waited[0].home, 'h');
  assert.equal(waited[0].port, 4791);
  f = fakeSchtasks(['remote-for-herdr']);
  let n = 0;
  r = await runTaskAndWait({ exec: f.exec, home: 'h', port: 4791, waitUntilRunning: async () => ++n === 2 });
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(verbs(f.calls), ['/End', '/Run', '/Run']);
  r = await runTaskAndWait({ exec: f.exec, home: 'h', port: 4791, waitUntilRunning: async () => false });
  assert.equal(r.ok, false);
  assert.match(r.message, /did not come up on port 4791/);
  // /End failing (nothing running) is ignored.
  f = fakeSchtasks([]);
  r = await runTaskAndWait({ exec: f.exec, home: 'h', port: 4791, waitUntilRunning: async () => true });
  assert.equal(r.ok, false); // the /Run itself failed: no such task
  assert.deepEqual(verbs(f.calls), ['/End', '/Run']);
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
  const text = formatStatus(s, { cmd: 'remote-for-herdr' });
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
  assert.match(formatStatus(s, { cmd: 'x' }), /^Running: +no \(but something else answers on port 4791\)$/m);
});

test('restart with the task: looks the task up first, stops, then /End + /Run and waits for its server', async () => {
  const home = tmp();
  saveConfig(home, good);
  const order = [];
  const f = fakeSchtasks(['remote-for-herdr']);
  const exec = async (cmd, args) => { order.push(args[0]); return f.exec(cmd, args); };
  const out = quiet();
  const waited = [];
  const r = await restart({
    home, exec, log: out.log, cliPath: GLOBAL_CLI,
    stop: async (o) => { order.push(['stop', o.home]); return 'stopped'; },
    waitUntilRunning: async (o) => { waited.push(o); return true; },
    startDetachedImpl: () => assert.fail('the task is installed'),
  });
  assert.deepEqual(order, ['/Query', ['stop', home], '/End', '/Run']);
  assert.equal(waited[0].port, 4791);
  assert.equal(waited[0].home, home);
  assert.deepEqual(out.lines, ['Stopped.', 'Started (start-at-login task).']);
  assert.equal(r.how, 'task');
  assert.equal(r.ok, true);
});

test('fix: the npx hint sequence works: a server started from npx (detached), then install-task, then restart', async () => {
  // After "npm i -g" and "install-task", restart must stop the detached server (it owns server.pid, so
  // stop reaches it) and start the server through the task: nothing left running from the npx cache.
  const home = tmp();
  saveConfig(home, good);
  fs.writeFileSync(pidFilePath(home), '999'); // the detached npx server
  const { stopRunning } = await import('../src/supervisor.js');
  const f = fakeSchtasks(['remote-for-herdr']);
  let alive = true;
  const stop = (o) => {
    // The detached server honours server.stop: simulate it noticing the request and exiting.
    const t = setInterval(() => {
      if (fs.existsSync(path.join(home, 'server.stop'))) { fs.rmSync(pidFilePath(home)); alive = false; clearInterval(t); }
    }, 5);
    return stopRunning({ ...o, isAlive: () => alive, pollMs: 5 });
  };
  const out = quiet();
  const r = await restart({ home, exec: f.exec, log: out.log, cliPath: GLOBAL_CLI, stop, waitUntilRunning: async () => true, startDetachedImpl: () => assert.fail('no') });
  assert.equal(r.stopped, 'stopped');
  assert.deepEqual(verbs(f.calls), ['/Query', '/End', '/Run']);
  assert.equal(r.how, 'task');
  assert.equal(r.ok, true);
});

test('fix: restart without a task starts it again in the background (never left down)', async () => {
  const home = tmp();
  saveConfig(home, good);
  const f = fakeSchtasks();
  const out = quiet();
  const started = [];
  const waited = [];
  const r = await restart({
    home, exec: f.exec, log: out.log, cliPath: GLOBAL_CLI, stop: async () => 'stopped',
    startDetachedImpl: (o) => { started.push(o); return { pid: 5150 }; },
    waitUntilRunning: async (o) => { waited.push(o); return true; },
  });
  assert.deepEqual(verbs(f.calls), ['/Query']);
  assert.deepEqual(started, [{ home, cliPath: GLOBAL_CLI }]);
  assert.equal(waited[0].pid, 5150);
  assert.equal(out.lines[0], 'Stopped.');
  assert.equal(out.lines[1], 'Started in the background.');
  assert.match(out.lines[2], /No start-at-login task is installed.*install-task, then .* restart$/);
  assert.equal(r.how, 'detached');
  assert.equal(r.ok, true);
});

test('restart: a stop that times out fails before starting anything', async () => {
  const f = fakeSchtasks(['remote-for-herdr']);
  await assert.rejects(
    restart({ home: tmp(), exec: f.exec, log: () => {}, stop: async () => 'timeout — 1 did not stop.', startDetachedImpl: () => assert.fail('no') }),
    /did not stop in time/,
  );
  assert.deepEqual(verbs(f.calls), ['/Query']);
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
  assert.match(out.lines.at(-1), /^Start it again with: .*restart$/);
});

test('fix: migrate as part of restart does not say "start it again"', async () => {
  const { env, from } = appData();
  fs.mkdirSync(from);
  fs.writeFileSync(pidFilePath(from), '4242');
  const out = quiet();
  await migrateFromHerdrRemote({
    env, log: out.log, restartFollows: true,
    stop: async ({ home }) => { fs.rmSync(pidFilePath(home)); return 'stopped'; }, installTask: async () => assert.fail('no task'),
  });
  assert.ok(!out.lines.some((l) => l.startsWith('Start it again')), out.lines.join('\n'));
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
  assert.equal(legacyPending({ env }), false);
  fs.mkdirSync(from);
  assert.equal(legacyPending({ env }), true);
  assert.equal(legacyPending({ env, home: tmp() }), false);
  assert.equal(await migrateFromHerdrRemote({ env, home: tmp(), ...never }), null);
  assert.equal(await migrateFromHerdrRemote({ env: { ...env, REMOTE_FOR_HERDR_HOME: tmp() }, ...never }), null);
  assert.equal(await migrateFromHerdrRemote({ env: { ...env, HERDR_REMOTE_HOME: tmp() }, ...never }), null);
  fs.mkdirSync(to);
  assert.equal(legacyPending({ env }), false);
  assert.equal(await migrateFromHerdrRemote({ env, ...never }), null);
});

test('fix: an old server that does not stop: throws with its pid and moves nothing', async () => {
  const { env, from, to } = appData();
  fs.mkdirSync(from);
  saveConfig(from, good);
  fs.writeFileSync(pidFilePath(from), '4242');
  await assert.rejects(
    migrateFromHerdrRemote({ env, log: () => {}, stop: async () => 'timeout — 4242 did not stop.', installTask: async () => assert.fail('no') }),
    /Could not stop the old herdr-remote server \(pid 4242\); stop it .*then run this again/,
  );
  assert.equal(fs.existsSync(to), false);
  assert.equal(loadConfig(from).port, 4791);
});

test('fix: from the npx cache with an old task: nothing is moved or stopped; says to install globally first', async () => {
  const { env, from, to } = appData();
  fs.mkdirSync(from);
  fs.writeFileSync(path.join(from, 'start-hidden.vbs'), 'old');
  fs.writeFileSync(pidFilePath(from), '4242');
  await assert.rejects(
    migrateFromHerdrRemote({
      env, log: () => assert.fail('no'), cliPath: NPX_CLI,
      stop: async () => assert.fail('must not stop'), installTask: async () => assert.fail('must not install'), exec: async () => assert.fail('no schtasks'),
    }),
    (e) => e.message.includes('npm i -g remote-for-herdr\n  remote-for-herdr restart'),
  );
  assert.equal(fs.existsSync(to), false);
  assert.deepEqual(fs.readdirSync(from).sort(), ['server.pid', 'start-hidden.vbs']); // the old task still works
});

test('migrate: from the npx cache without an old task the folder moves (no task involved)', async () => {
  const { env, from, to } = appData();
  fs.mkdirSync(from);
  const r = await migrateFromHerdrRemote({ env, log: () => {}, cliPath: NPX_CLI, installTask: async () => assert.fail('no') });
  assert.equal(r.mode, 'moved');
  assert.ok(fs.existsSync(to));
});
