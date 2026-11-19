import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import net from 'node:net';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  superviseServer, stopRunning, pidFilePath, claimPidFile, alreadyRunningMessage, EXIT_SETUP_REQUIRED,
  SERVER_NODE_FLAGS, processAlive, windowsImageName,
} from '../src/supervisor.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hr-sup-'));
const until = async (fn, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 25)); }
  return false;
};

test('restarts a crashing child and logs its output', async () => {
  const home = tmp();
  const script = path.join(home, 'crash.mjs');
  fs.writeFileSync(script, 'console.log("hello-out"); process.exit(1);');
  const sup = superviseServer({ home, entry: script, args: [], backoffMs: [20, 20] });
  const log = path.join(home, 'logs', 'server.log');
  assert.ok(await until(() => fs.existsSync(log) && (fs.readFileSync(log, 'utf8').match(/hello-out/g) ?? []).length >= 2));
  await sup.stop();
});

test('does not restart on setup-required exit code', async () => {
  const home = tmp();
  const script = path.join(home, 'setup.mjs');
  fs.writeFileSync(script, `console.error("need setup"); process.exit(${EXIT_SETUP_REQUIRED});`);
  const sup = superviseServer({ home, entry: script, args: [], backoffMs: [20] });
  const r = await sup.done;
  assert.equal(r.reason, 'setup-required');
  const text = fs.readFileSync(path.join(home, 'logs', 'server.log'), 'utf8');
  assert.equal((text.match(/need setup/g) ?? []).length, 1);
});

test('rotates the log at the size limit', async () => {
  const home = tmp();
  const script = path.join(home, 'noisy.mjs');
  fs.writeFileSync(script, 'setInterval(() => console.log("x".repeat(200)), 30);');
  const sup = superviseServer({ home, entry: script, args: [], maxLogBytes: 100 });
  try {
    assert.ok(await until(() => fs.existsSync(path.join(home, 'logs', 'server.log.1'))));
  } finally {
    await sup.stop();
  }
});

test('does not restart after a clean exit (code 0)', async () => {
  const home = tmp();
  const script = path.join(home, 'ok.mjs');
  fs.writeFileSync(script, 'console.log("bye-once");');
  const sup = superviseServer({ home, entry: script, args: [], backoffMs: [20] });
  assert.equal((await sup.done).reason, 'exited');
  await new Promise((r) => setTimeout(r, 150));
  const text = fs.readFileSync(path.join(home, 'logs', 'server.log'), 'utf8');
  assert.equal((text.match(/bye-once/g) ?? []).length, 1);
});

test('M4: stop() disconnects the child first so it can shut down cleanly', async () => {
  const home = tmp();
  const marker = path.join(home, 'clean.txt');
  const script = path.join(home, 'graceful.mjs');
  fs.writeFileSync(script, `import fs from 'node:fs';
setInterval(() => {}, 1000);
process.on('disconnect', () => { fs.writeFileSync(${JSON.stringify(marker)}, 'bye'); process.exit(0); });
console.log('ready');`);
  const sup = superviseServer({ home, entry: script, args: [] });
  const log = path.join(home, 'logs', 'server.log');
  assert.ok(await until(() => fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes('ready')));
  assert.equal((await sup.stop()).reason, 'stopped');
  assert.equal(fs.readFileSync(marker, 'utf8'), 'bye');
});

test('M4: stop() kills a child that ignores the disconnect after killAfterMs', async () => {
  const home = tmp();
  const script = path.join(home, 'stubborn.mjs');
  fs.writeFileSync(script, `setInterval(() => {}, 1000);
process.on('disconnect', () => {});
console.log('ready');`);
  const sup = superviseServer({ home, entry: script, args: [], killAfterMs: 200 });
  const log = path.join(home, 'logs', 'server.log');
  assert.ok(await until(() => fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes('ready')));
  const t0 = Date.now();
  assert.equal((await sup.stop()).reason, 'stopped');
  assert.ok(Date.now() - t0 < 3000);
});

test('I3: supervisor writes server.pid; stopRunning stops it and removes the file', async () => {
  const home = tmp();
  const script = path.join(home, 'graceful.mjs');
  fs.writeFileSync(script, `setInterval(() => {}, 1000);
process.on('disconnect', () => process.exit(0));`);
  const sup = superviseServer({ home, entry: script, args: [], controlPollMs: 50 });
  assert.ok(await until(() => fs.existsSync(pidFilePath(home)) && fs.readFileSync(pidFilePath(home), 'utf8').trim() === String(process.pid)));
  assert.equal(await stopRunning({ home, pollMs: 25 }), 'stopped');
  assert.equal((await sup.done).reason, 'stopped');
  assert.equal(fs.existsSync(pidFilePath(home)), false);
});

test('I3: stopRunning reports "not running" without a pid file, and removes a stale one', async () => {
  const home = tmp();
  assert.equal(await stopRunning({ home }), 'not running');
  fs.writeFileSync(pidFilePath(home), '424242');
  assert.equal(await stopRunning({ home, isAlive: () => false }), 'not running');
  assert.equal(fs.existsSync(pidFilePath(home)), false);
});

test('lighter: stopRunning leaves a stop request when nothing runs (for a launcher waiting to restart), and a later start clears it', async () => {
  const home = tmp();
  const stopFile = path.join(home, 'server.stop');
  assert.equal(await stopRunning({ home }), 'not running');
  assert.equal(fs.existsSync(stopFile), true);
  fs.rmSync(stopFile);
  fs.writeFileSync(pidFilePath(home), '424242');
  assert.equal(await stopRunning({ home, isAlive: () => false }), 'not running');
  assert.equal(fs.existsSync(stopFile), true);
  // A server that starts afterwards claims the pid file and drops the leftover request: it keeps running.
  let stopped = false;
  const claim = await claimPidFile(home, { onStopRequest: () => { stopped = true; }, pollMs: 20, portAnswers: async () => false });
  try {
    assert.equal(claim.ok, true);
    assert.equal(fs.existsSync(stopFile), false);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(stopped, false);
  } finally {
    claim.release();
  }
  // No home at all: still just "not running".
  assert.equal(await stopRunning({ home: path.join(home, 'missing') }), 'not running');
});

test('I3: pid file is removed when the supervisor finishes on its own', async () => {
  const home = tmp();
  const script = path.join(home, 'ok.mjs');
  fs.writeFileSync(script, '');
  const sup = superviseServer({ home, entry: script, args: [] });
  assert.equal((await sup.done).reason, 'exited');
  assert.equal(fs.existsSync(pidFilePath(home)), false);
});

test('I3: "remote-for-herdr stop" prints "not running" when nothing runs', async () => {
  const home = tmp();
  fs.writeFileSync(pidFilePath(home), '424242x');
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const out = execFileSync(process.execPath, [cli, 'stop', '--home', home], { encoding: 'utf8', windowsHide: true });
  assert.equal(out.trim(), 'not running');
  assert.equal(fs.existsSync(pidFilePath(home)), false);
});

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const stopFilePath = (home) => path.join(home, 'server.stop');

test('B1: a second supervisor refuses while server.pid holds a live foreign pid, leaving it untouched', async () => {
  const home = tmp();
  const script = path.join(home, 'never.mjs');
  const marker = path.join(home, 'launched.txt');
  fs.writeFileSync(script, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'x');`);
  fs.writeFileSync(pidFilePath(home), '424242');
  fs.writeFileSync(stopFilePath(home), 'stop'); // a pending request for the running one must survive too
  const sup = superviseServer({ home, entry: script, args: [], isAlive: (pid) => pid === 424242, portAnswers: async () => true });
  const r = await sup.done;
  assert.deepEqual(r, { reason: 'already-running', pid: 424242 });
  assert.equal(fs.readFileSync(pidFilePath(home), 'utf8'), '424242');
  assert.equal(fs.existsSync(stopFilePath(home)), true);
  assert.equal(fs.existsSync(marker), false);
});

// Makes a pid file look like it was left behind long ago (e.g. before a reboot).
const age = (file) => { const old = new Date(Date.now() - 3600_000); fs.utimesSync(file, old, old); };

test('R21: a live foreign pid whose port does not answer is a stale file: taken over and logged', async () => {
  const home = tmp();
  const script = path.join(home, 'ok.mjs');
  fs.writeFileSync(script, '');
  fs.writeFileSync(pidFilePath(home), '424242');
  age(pidFilePath(home));
  const probed = [];
  const sup = superviseServer({
    home, entry: script, args: [], port: 4999,
    isAlive: () => true, portAnswers: async (p) => { probed.push(p); return false; },
  });
  assert.equal((await sup.done).reason, 'exited');
  assert.deepEqual(probed, [4999]);
  assert.match(fs.readFileSync(path.join(home, 'logs', 'server.log'), 'utf8'), /stale pid file replaced \(pid 424242\)/);
});

test('R21: a live foreign pid whose port answers is refused with an actionable message', async () => {
  const home = tmp();
  fs.writeFileSync(pidFilePath(home), '424242');
  age(pidFilePath(home));
  const r = await claimPidFile(home, { isAlive: () => true, portAnswers: async () => true, port: 4999 });
  assert.deepEqual(r, { ok: false, pid: 424242 });
  assert.equal(fs.readFileSync(pidFilePath(home), 'utf8'), '424242');
  const msg = alreadyRunningMessage(424242, home);
  assert.ok(msg.includes('remote-for-herdr stop'), msg);
  assert.ok(msg.includes(`if remote-for-herdr isn't actually running, delete ${pidFilePath(home)}`), msg);
});

test('R21: a freshly written pid file of a live process is respected even before its port answers', async () => {
  const home = tmp();
  fs.writeFileSync(pidFilePath(home), '424242'); // another start that just claimed it
  const r = await claimPidFile(home, { isAlive: () => true, portAnswers: async () => false, port: 4999 });
  assert.deepEqual(r, { ok: false, pid: 424242 });
});

test('R21: claimPidFile creates the file exclusively and releases only its own', async () => {
  const home = tmp();
  const r = await claimPidFile(home, { port: 4999, portAnswers: async () => assert.fail('no probe without a holder') });
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(pidFilePath(home), 'utf8'), String(process.pid));
  fs.writeFileSync(pidFilePath(home), '424242'); // someone else took over
  r.release();
  assert.equal(fs.readFileSync(pidFilePath(home), 'utf8'), '424242');
});

test('B1/R21: "remote-for-herdr start" exits 78 with a clear line when a live process owns server.pid and the port answers', async () => {
  const home = tmp();
  const blocker = net.createServer((s) => s.destroy());
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
  try {
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ port: blocker.address().port }));
    const foreign = String(process.pid); // the test runner: alive, and not the CLI process
    fs.writeFileSync(pidFilePath(home), foreign);
    age(pidFilePath(home));
    const r = await new Promise((resolve) => {
      execFile(process.execPath, [CLI, 'start', '--home', home], { encoding: 'utf8', windowsHide: true, timeout: 20000 },
        (err, stdout, stderr) => resolve({ status: err ? err.code : 0, stderr }));
    });
    assert.equal(r.status, EXIT_SETUP_REQUIRED, r.stderr);
    assert.ok(r.stderr.includes(`already running (pid ${foreign})`), r.stderr);
    assert.ok(r.stderr.includes('remote-for-herdr stop'), r.stderr);
    assert.ok(r.stderr.includes(`delete ${pidFilePath(home)}`), r.stderr);
    assert.equal(fs.readFileSync(pidFilePath(home), 'utf8'), foreign);
  } finally {
    await new Promise((r) => blocker.close(r));
  }
});

test('B1: a stale pid file (dead pid) does not block a start', async () => {
  const home = tmp();
  const script = path.join(home, 'ok.mjs');
  fs.writeFileSync(script, '');
  fs.writeFileSync(pidFilePath(home), '424242');
  const sup = superviseServer({ home, entry: script, args: [], isAlive: () => false });
  assert.equal((await sup.done).reason, 'exited');
});

test('B3: stopRunning timeout removes the stop request and names the pid', async () => {
  const home = tmp();
  fs.writeFileSync(pidFilePath(home), '424242');
  const r = await stopRunning({ home, waitMs: 100, pollMs: 20, isAlive: () => true });
  assert.equal(r, `timeout — 424242 did not stop. If remote-for-herdr isn't actually running, delete ${pidFilePath(home)}`);
  assert.equal(fs.existsSync(stopFilePath(home)), false);
  assert.equal(fs.readFileSync(pidFilePath(home), 'utf8'), '424242'); // never killed, never touched
});

// A forked child stand-in; kill() only works when `exitOnKill` is set.
function stubChild({ exitOnKill = false } = {}) {
  const c = new EventEmitter();
  c.stdout = new PassThrough();
  c.stderr = new PassThrough();
  c.pid = 4000 + Math.floor(Math.random() * 1000);
  c.exitCode = null;
  c.signalCode = null;
  c.connected = false;
  c.kills = 0;
  c.exit = (code, signal = null) => { c.exitCode = code; c.signalCode = signal; c.emit('exit', code, signal); };
  c.kill = () => { c.kills++; if (exitOnKill) setImmediate(() => c.exit(null, 'SIGTERM')); return true; };
  return c;
}

test('B21: a child error while it is still alive kills it and restarts only after it exits', async () => {
  const home = tmp();
  const children = [];
  const forkImpl = () => { const c = stubChild({ exitOnKill: children.length > 0 }); children.push(c); return c; };
  const sup = superviseServer({ home, entry: 'x', args: [], backoffMs: [20], forkImpl });
  try {
    assert.ok(await until(() => children.length === 1));
    children[0].emit('error', new Error('kill EPERM'));
    assert.equal(children[0].kills, 1);
    await new Promise((r) => setTimeout(r, 200)); // well past the 20 ms backoff
    assert.equal(children.length, 1, 'restarted while the old child was alive');
    children[0].exit(1);
    assert.ok(await until(() => children.length === 2));
  } finally {
    await sup.stop();
  }
});

test('lighter: the supervisor forks the server with the server flags (and nothing inherited)', async () => {
  const home = tmp();
  const calls = [];
  const forkImpl = (entry, args, opts) => { calls.push({ entry, args, opts }); return stubChild({ exitOnKill: true }); };
  const sup = superviseServer({ home, forkImpl, execArgv: ['--max-old-space-size=128'] });
  const sup2 = superviseServer({ home: tmp(), forkImpl });
  try {
    assert.ok(await until(() => calls.length === 2));
    const mine = calls.find((c) => c.args.includes(home));
    const other = calls.find((c) => c !== mine);
    assert.deepEqual(mine.opts.execArgv, ['--max-old-space-size=128']);
    assert.deepEqual(mine.args, ['start', '--foreground', '--home', home]);
    // The default is SERVER_NODE_FLAGS, never the supervisor's own execArgv (e.g. --inspect).
    assert.deepEqual(other.opts.execArgv, [...SERVER_NODE_FLAGS]);
  } finally {
    await sup.stop();
    await sup2.stop();
  }
});

test('lighter: npm start and npm run dev pass the same server flags to node', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  for (const name of ['start', 'dev']) {
    assert.ok(pkg.scripts[name].startsWith(['node', ...SERVER_NODE_FLAGS, 'src/cli.js start'].join(' ')), `${name}: ${pkg.scripts[name]}`);
  }
  assert.ok(pkg.scripts.dev.includes('--foreground'));
  assert.ok(!pkg.scripts.start.includes('--foreground')); // manual start keeps the quick-restart supervisor
});

test('B21: a spawn error (no pid) is still treated as an end and retried', async () => {
  const home = tmp();
  const children = [];
  const forkImpl = () => { const c = stubChild({ exitOnKill: true }); children.push(c); return c; };
  const sup = superviseServer({ home, entry: 'x', args: [], backoffMs: [20], forkImpl });
  try {
    assert.ok(await until(() => children.length === 1));
    children[0].pid = undefined;
    children[0].emit('error', new Error('spawn ENOENT'));
    assert.ok(await until(() => children.length === 2));
  } finally {
    await sup.stop();
  }
});

test('round1: a kill() that fails with a synchronous error is not retried in a loop', async () => {
  const home = tmp();
  const children = [];
  const forkImpl = () => {
    const c = stubChild({ exitOnKill: children.length > 0 });
    if (children.length === 0) {
      // Like Node on EPERM: kill() emits 'error' synchronously (syscall 'kill').
      c.kill = () => { c.kills++; c.emit('error', Object.assign(new Error('kill EPERM'), { code: 'EPERM', syscall: 'kill' })); return false; };
    }
    children.push(c);
    return c;
  };
  const sup = superviseServer({ home, entry: 'x', args: [], backoffMs: [20], forkImpl });
  try {
    await until(() => children.length === 1);
    children[0].emit('error', new Error('pipe broke'));
    assert.ok(children[0].kills >= 1 && children[0].kills <= 2, `kills: ${children[0].kills}`);
    const log = fs.readFileSync(path.join(home, 'logs', 'server.log'), 'utf8');
    assert.ok((log.match(/child error/g) ?? []).length <= 2, log);
    assert.equal(children.length, 1); // still alive: no second server
    children[0].exit(1);
    assert.ok(await until(() => children.length === 2));
  } finally {
    await sup.stop();
  }
});

test('the stale-pid hint prints an absolute path even for a relative --home', () => {
  const msg = alreadyRunningMessage(424242, 'rel-home');
  assert.ok(msg.includes(`delete ${path.resolve('rel-home', 'server.pid')}`), msg);
});

// A live pid that Windows reused for another program after the server died without removing
// server.pid (seen: LockApp.exe after a logoff). process.pid is alive; the image name is injected.
const lockApp = (pid) => processAlive(pid, { platform: 'win32', imageName: () => 'LockApp.exe' });

test('stale pid: windowsImageName reads the image of the pid from tasklist CSV output', () => {
  const calls = [];
  const run = (args) => { calls.push(args); return '"LockApp.exe","15732","Console","1","51,200 K"\r\n'; };
  assert.equal(windowsImageName(15732, { run }), 'LockApp.exe');
  assert.deepEqual(calls, [['/FI', 'PID eq 15732', '/FO', 'CSV', '/NH']]);
  // A row for another pid, or tasklist's (localized) "no tasks" line: no such process.
  assert.equal(windowsImageName(15732, { run: () => '"node.exe","157320","Console","1","1 K"\r\n' }), '');
  assert.equal(windowsImageName(15732, { run: () => 'INFO: No tasks are running which match the specified criteria.\r\n' }), '');
  assert.equal(windowsImageName(15732, { run: () => { throw new Error('ENOENT'); } }), null);
});

test('stale pid: processAlive on Windows counts a live pid only when it is node', () => {
  const win = (imageName) => processAlive(process.pid, { platform: 'win32', imageName });
  assert.equal(win(() => 'node.exe'), true);
  assert.equal(win(() => 'NODE.EXE'), true);
  assert.equal(win(() => 'LockApp.exe'), false);
  assert.equal(win(() => null), true); // tasklist failed: as before, alive
  assert.equal(win(() => ''), true); // not listed (just exited?): as before, alive
  // Elsewhere, and for a dead pid, the image is never asked for.
  const never = () => assert.fail('no image check');
  assert.equal(processAlive(process.pid, { platform: 'linux', imageName: never }), true);
  assert.equal(processAlive(2 ** 22 + 1, { platform: 'win32', imageName: never }), false);
});

test('stale pid: stopRunning treats a pid held by a non-node process as not running and removes the file', async () => {
  const home = tmp();
  fs.writeFileSync(pidFilePath(home), String(process.pid));
  const t0 = Date.now();
  assert.equal(await stopRunning({ home, isAlive: lockApp }), 'not running');
  assert.ok(Date.now() - t0 < 1000); // no 15 s wait for LockApp to exit
  assert.equal(fs.existsSync(pidFilePath(home)), false);
});

test('stale pid: claimPidFile replaces a fresh pid file held by a non-node process', async () => {
  const home = tmp();
  fs.writeFileSync(pidFilePath(home), String(process.ppid)); // a live pid, fresh, and the port answers
  const r = await claimPidFile(home, { isAlive: lockApp, portAnswers: async () => true, port: 4999 });
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(pidFilePath(home), 'utf8'), String(process.pid));
  r.release();
});
