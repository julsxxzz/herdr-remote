import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { superviseServer, stopRunning, pidFilePath, EXIT_SETUP_REQUIRED } from '../src/supervisor.js';

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
  assert.equal(fs.readFileSync(pidFilePath(home), 'utf8').trim(), String(process.pid));
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

test('I3: pid file is removed when the supervisor finishes on its own', async () => {
  const home = tmp();
  const script = path.join(home, 'ok.mjs');
  fs.writeFileSync(script, '');
  const sup = superviseServer({ home, entry: script, args: [] });
  assert.equal((await sup.done).reason, 'exited');
  assert.equal(fs.existsSync(pidFilePath(home)), false);
});

test('I3: "herdr-remote stop" prints "not running" when nothing runs', async () => {
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
  const sup = superviseServer({ home, entry: script, args: [], isAlive: (pid) => pid === 424242 });
  const r = await sup.done;
  assert.deepEqual(r, { reason: 'already-running', pid: 424242 });
  assert.equal(fs.readFileSync(pidFilePath(home), 'utf8'), '424242');
  assert.equal(fs.existsSync(stopFilePath(home)), true);
  assert.equal(fs.existsSync(marker), false);
});

test('B1: "herdr-remote start" exits 78 with a clear line when another live process owns server.pid', () => {
  const home = tmp();
  const foreign = String(process.pid); // the test runner: alive, and not the CLI process
  fs.writeFileSync(pidFilePath(home), foreign);
  const r = spawnSync(process.execPath, [CLI, 'start', '--home', home], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  assert.equal(r.status, EXIT_SETUP_REQUIRED, r.stderr);
  assert.ok(r.stderr.includes(`already running (pid ${foreign})`), r.stderr);
  assert.ok(r.stderr.includes('herdr-remote stop'), r.stderr);
  assert.equal(fs.readFileSync(pidFilePath(home), 'utf8'), foreign);
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
  assert.equal(r, 'timeout — 424242 did not stop');
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

test('B21: a spawn error (no pid) is still treated as an end and retried', async () => {
  const home = tmp();
  const children = [];
  const forkImpl = () => { const c = stubChild({ exitOnKill: true }); children.push(c); return c; };
  const sup = superviseServer({ home, entry: 'x', args: [], backoffMs: [20], forkImpl });
  try {
    children[0].pid = undefined;
    children[0].emit('error', new Error('spawn ENOENT'));
    assert.ok(await until(() => children.length === 2));
  } finally {
    await sup.stop();
  }
});
