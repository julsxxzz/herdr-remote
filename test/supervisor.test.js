import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { superviseServer, EXIT_SETUP_REQUIRED } from '../src/supervisor.js';

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
