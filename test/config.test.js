import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  configDir, loadConfig, saveConfig, loadState, saveState,
  DEFAULT_CONFIG, DEFAULT_STATE, validateConfig,
} from '../src/config.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hr-cfg-'));

test('configDir: win32 uses APPDATA', () => {
  assert.equal(
    configDir({ env: { APPDATA: 'C:\A' }, platform: 'win32' }),
    path.join('C:\A', 'herdr-remote'),
  );
});

test('configDir: HERDR_REMOTE_HOME overrides, home arg wins over both', () => {
  const env = { APPDATA: 'C:\A', HERDR_REMOTE_HOME: 'C:\H' };
  assert.equal(configDir({ env, platform: 'win32' }), 'C:\H');
  assert.equal(configDir({ env, platform: 'win32', home: 'C:\X' }), 'C:\X');
});

test('configDir: non-windows uses XDG_CONFIG_HOME or ~/.config', () => {
  assert.equal(
    configDir({ env: { XDG_CONFIG_HOME: '/x' }, platform: 'linux' }),
    path.join('/x', 'herdr-remote'),
  );
  assert.equal(
    configDir({ env: {}, platform: 'linux' }),
    path.join(os.homedir(), '.config', 'herdr-remote'),
  );
});

test('loadConfig on empty dir returns defaults', () => {
  assert.deepEqual(loadConfig(tmp()), DEFAULT_CONFIG);
});

test('saveConfig/loadConfig round-trip, creates dir, leaves no tmp', () => {
  const dir = path.join(tmp(), 'nested');
  const cfg = { ...DEFAULT_CONFIG, port: 5000, pinHash: 'h' };
  saveConfig(dir, cfg);
  assert.deepEqual(loadConfig(dir), cfg);
  assert.deepEqual(fs.readdirSync(dir), ['config.json']);
});

test('loadState merges defaults into partial file', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'state.json'), '{"deskMode":true}');
  assert.deepEqual(loadState(dir), { ...DEFAULT_STATE, deskMode: true });
});

test('saveState/loadState round-trip; missing file gives defaults', () => {
  const dir = tmp();
  assert.deepEqual(loadState(dir), DEFAULT_STATE);
  const st = { ...DEFAULT_STATE, notifyDone: false, sessions: { a: 1 } };
  saveState(dir, st);
  assert.deepEqual(loadState(dir), st);
});

const good = {
  ...DEFAULT_CONFIG, pinHash: 'h', publicOrigin: 'https://pc.example.ts.net',
  vapid: { publicKey: 'p', privateKey: 'k' }, allowedLogin: 'owner@example.com',
};

test('validateConfig: complete config is OK', () => {
  assert.deepEqual(validateConfig(good), []);
});

test('validateConfig: missing required fields', () => {
  for (const k of ['pinHash', 'publicOrigin', 'vapid', 'allowedLogin']) {
    const errs = validateConfig({ ...good, [k]: null });
    assert.ok(errs.some((e) => e.includes(k)), k);
  }
});

test('validateConfig: tailscale refuses non-loopback bind', () => {
  assert.ok(validateConfig({ ...good, bind: '0.0.0.0' }).some((e) => e.includes('bind')));
});

test('validateConfig: proxy allows explicit bind', () => {
  assert.deepEqual(
    validateConfig({ ...good, access: 'proxy', bind: '0.0.0.0', allowedLogin: null }),
    [],
  );
});

test('validateConfig: unknown access value', () => {
  assert.ok(validateConfig({ ...good, access: 'open' }).some((e) => e.includes('access')));
});
