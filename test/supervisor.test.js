import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
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
