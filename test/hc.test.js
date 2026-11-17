import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createHc, HC_IDENTITY_ENV, isValidAddress, isValidKeyName } from '../src/hc.js';

const fakeHcPath = fileURLToPath(new URL('./fixtures/fake-hc.mjs', import.meta.url));
let dir;
let hc;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-hc-'));
  hc = createHc({
    command: process.execPath,
    prefixArgs: [fakeHcPath],
    env: { ...process.env, FAKE_HC_DIR: dir },
  });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const calls = () => {
  const p = path.join(dir, 'calls.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
};
const put = (name, content) => fs.writeFileSync(path.join(dir, name), content);

test('send passes text verbatim after --', async () => {
  const text = '--force "a" & b\nline2';
  const r = await hc.send('t3', text);
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(calls().at(-1), ['send', 't3', '--', text]);
});

test('send with force puts --force before --; default and force:false are unchanged', async () => {
  assert.deepEqual(await hc.send('t3', 'green please', { force: true }), { ok: true });
  assert.deepEqual(calls().at(-1), ['send', 't3', '--force', '--', 'green please']);
  await hc.send('t3', 'hi', { force: false });
  assert.deepEqual(calls().at(-1), ['send', 't3', '--', 'hi']);
  await hc.send('t3', 'hi', {});
  assert.deepEqual(calls().at(-1), ['send', 't3', '--', 'hi']);
});

test('send failure uses JSON stderr message', async () => {
  put('exit', '1');
  put('stderr', '{"error":{"kind":"blocked","message":"it is showing a dialog"}}');
  assert.deepEqual(await hc.send('t3', 'hi'), { ok: false, error: 'it is showing a dialog' });
});

test('send failure falls back to plain stderr, then exit code', async () => {
  put('exit', '1');
  put('stderr', 'oops\n');
  assert.deepEqual(await hc.send('t3', 'hi'), { ok: false, error: 'oops' });
  put('stderr', '');
  assert.deepEqual(await hc.send('t3', 'hi'), { ok: false, error: 'hc exited with code 1' });
});

test('keys passes names after --', async () => {
  const r = await hc.keys('t3', ['shift+tab', 'enter']);
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(calls().at(-1), ['keys', 't3', '--', 'shift+tab', 'enter']);
});

test('invalid input throws TypeError and spawns nothing', async () => {
  await assert.rejects(hc.send('-x', 'hi'), TypeError);
  await assert.rejects(hc.keys('t3', ['--force']), TypeError);
  await assert.rejects(hc.keys('t3', 'enter'), TypeError);
  await assert.rejects(hc.get('../x/'.repeat(30)), TypeError);
  assert.deepEqual(calls(), []);
});

test('validators', () => {
  assert.equal(isValidAddress('t3'), true);
  assert.equal(isValidAddress('a/b.c-d_e'), true);
  assert.equal(isValidAddress('-x'), false);
  assert.equal(isValidAddress(''), false);
  assert.equal(isValidAddress('a'.repeat(65)), false);
  assert.equal(isValidAddress(5), false);
  assert.equal(isValidKeyName('shift+tab'), true);
  assert.equal(isValidKeyName('Enter'), true);
  assert.equal(isValidKeyName('--force'), false);
  assert.equal(isValidKeyName('+a'), false);
});

test('ls returns the terminals array', async () => {
  put('ls.json', JSON.stringify({ hidden_finished: 0, terminals: [{ address: 't1' }, { address: 't2' }] }));
  assert.deepEqual(await hc.ls(), [{ address: 't1' }, { address: 't2' }]);
  assert.deepEqual(calls().at(-1), ['ls', '--json']);
});

test('get returns the parsed terminal', async () => {
  put('get.json', JSON.stringify({ address: 't3', turn: 4 }));
  assert.deepEqual(await hc.get('t3'), { address: 't3', turn: 4 });
  assert.deepEqual(calls().at(-1), ['get', 't3', '--json']);
});

test('run kills on timeout with code -1', async () => {
  const slow = createHc({
    command: process.execPath,
    prefixArgs: ['-e', 'setInterval(()=>{},1000)'],
  });
  const r = await slow.run([], { timeoutMs: 200 });
  assert.equal(r.code, -1);
});

test('observe streams screen bytes until killed', async () => {
  const bytes = Buffer.from([0x1b, 0x5b, 0x32, 0x4a, 0x68, 0x69]);
  put('screen.bin', bytes);
  const child = hc.observe('t3', { history: 200 });
  try {
    const chunks = [];
    await new Promise((resolve) => {
      child.stdout.on('data', (c) => {
        chunks.push(c);
        if (Buffer.concat(chunks).length >= bytes.length) resolve();
      });
    });
    assert.deepEqual(Buffer.concat(chunks), bytes);
    assert.deepEqual(calls().at(-1), ['attach', 't3', '--observe', '--history', '200']);
  } finally {
    const closed = new Promise((r) => child.once('close', r));
    child.kill();
    await closed;
  }
});

test('events spawns hc events --json and stays alive', async () => {
  put('events.jsonl', '{"seq":1}\n');
  const child = hc.events();
  try {
    const line = await new Promise((resolve) => child.stdout.once('data', resolve));
    assert.equal(line.toString(), '{"seq":1}\n');
    assert.deepEqual(calls().at(-1), ['events', '--json']);
  } finally {
    const closed = new Promise((r) => child.once('close', r));
    child.kill();
    await closed;
  }
});

test('B6: a timed-out send/keys reports "hc timed out", not an exit code', async () => {
  const slow = createHc({ command: process.execPath, prefixArgs: ['-e', 'setInterval(()=>{},1000)'], timeoutMs: 200 });
  const s = await slow.send('t3', 'hi');
  assert.equal(s.ok, false);
  assert.match(s.error, /^hc timed out/);
  assert.match(s.error, /may or may not/);
  const k = await slow.keys('t3', ['enter']);
  assert.match(k.error, /^hc timed out/);
});

test('B7: ls returns [] when the JSON has no terminals, and still throws on non-JSON', async () => {
  put('ls.json', JSON.stringify({ hidden_finished: 0 }));
  assert.deepEqual(await hc.ls(), []);
  put('ls.json', 'not json');
  await assert.rejects(hc.ls(), SyntaxError);
});

// A child whose kill() does nothing and whose pipes never close (a grandchild holding them).
function stuckChild() {
  const c = new EventEmitter();
  c.stdout = new PassThrough();
  c.stderr = new PassThrough();
  c.kills = 0;
  c.kill = () => { c.kills++; return true; };
  return c;
}

test('B8: run settles with code -1 after the kill grace even if close never fires', async () => {
  const child = stuckChild();
  const stub = createHc({ spawnImpl: () => child, killGraceMs: 100 });
  const t0 = Date.now();
  const r = await stub.run([], { timeoutMs: 50 });
  assert.equal(r.code, -1);
  assert.equal(r.timedOut, true);
  assert.equal(child.kills, 1);
  assert.ok(Date.now() - t0 < 1500);
});

test('B8: a late close after the grace does not settle twice', async () => {
  const child = stuckChild();
  const stub = createHc({ spawnImpl: () => child, killGraceMs: 50 });
  const r = await stub.run([], { timeoutMs: 20 });
  assert.equal(r.code, -1);
  child.emit('close', 0); // must be ignored, not throw
  child.emit('error', new Error('late'));
});

const identity = { HC_TERMINAL_ID: 't9', HC_TERMINAL_SOCKET: 'sock', HC_SCOPE: 'scope' };
const envSeen = (cmd) => fs.readFileSync(path.join(dir, 'env.jsonl'), 'utf8').split('\n').filter(Boolean)
  .map((l) => JSON.parse(l)).find((e) => e.argv[0] === cmd);
const waitFor = async (fn) => { for (let i = 0; i < 100; i++) { try { return fn(); } catch { await new Promise((r) => setTimeout(r, 50)); } } return fn(); };

for (const source of ['option', 'process.env']) {
  test(`children never inherit hc terminal identity (${source})`, async () => {
    const saved = { ...process.env };
    const base = { ...process.env, FAKE_HC_DIR: dir, HERDR_TEST_KEEP: 'yes' };
    let h;
    if (source === 'option') {
      h = createHc({ command: process.execPath, prefixArgs: [fakeHcPath], env: { ...base, ...identity } });
    } else {
      Object.assign(process.env, base, identity);
      h = createHc({ command: process.execPath, prefixArgs: [fakeHcPath] });
    }
    put('events.jsonl', '{"seq":1}\n');
    put('screen.bin', 'x');
    const kids = [];
    try {
      await h.send('t3', 'hi');
      kids.push(h.observe('t3'), h.events());
      for (const cmd of ['send', 'attach', 'events']) {
        const seen = await waitFor(() => { const e = envSeen(cmd); assert.ok(e); return e; });
        assert.deepEqual(seen.hcEnv, {});
        assert.equal(seen.keep, 'yes');
      }
    } finally {
      for (const k of kids) k.kill();
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
    assert.deepEqual(HC_IDENTITY_ENV, ['HC_TERMINAL_ID', 'HC_TERMINAL_SOCKET', 'HC_SCOPE']);
  });
}
