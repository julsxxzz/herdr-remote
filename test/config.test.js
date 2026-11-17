import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  configDir, loadConfig, saveConfig, loadState, saveState,
  DEFAULT_CONFIG, DEFAULT_STATE, validateConfig, legacyConfigDir, migrateLegacyHome,
} from '../src/config.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hr-cfg-'));

test('configDir: win32 uses APPDATA', () => {
  assert.equal(
    configDir({ env: { APPDATA: 'C:\\A' }, platform: 'win32' }),
    path.join('C:\\A', 'remote-for-herdr'),
  );
});

test('configDir: HERDR_REMOTE_HOME overrides, home arg wins over both', () => {
  const env = { APPDATA: 'C:\\A', HERDR_REMOTE_HOME: 'C:\\H' };
  assert.equal(configDir({ env, platform: 'win32' }), 'C:\\H');
  assert.equal(configDir({ env, platform: 'win32', home: 'C:\\X' }), 'C:\\X');
});

test('configDir: non-windows uses XDG_CONFIG_HOME or ~/.config', () => {
  assert.equal(
    configDir({ env: { XDG_CONFIG_HOME: '/x' }, platform: 'linux' }),
    path.join('/x', 'remote-for-herdr'),
  );
  assert.equal(
    configDir({ env: {}, platform: 'linux' }),
    path.join(os.homedir(), '.config', 'remote-for-herdr'),
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

test('B4: configDir on win32 without APPDATA falls back to ~/AppData/Roaming', () => {
  assert.equal(
    configDir({ env: {}, platform: 'win32' }),
    path.join(os.homedir(), 'AppData', 'Roaming', 'remote-for-herdr'),
  );
});

test('B5: loadConfig/loadState reject non-object JSON with an error naming the file', () => {
  for (const text of ['[]', '"x"', 'null', '5']) {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'config.json'), text);
    fs.writeFileSync(path.join(dir, 'state.json'), text);
    assert.throws(() => loadConfig(dir), (e) => e.message.includes(path.join(dir, 'config.json')) && /object/.test(e.message), text);
    assert.throws(() => loadState(dir), (e) => e.message.includes(path.join(dir, 'state.json')) && /object/.test(e.message), text);
  }
});

test('npm: REMOTE_FOR_HERDR_HOME is preferred over HERDR_REMOTE_HOME; --home wins over both', () => {
  const env = { APPDATA: 'C:\A', HERDR_REMOTE_HOME: 'C:\Old', REMOTE_FOR_HERDR_HOME: 'C:\New' };
  assert.equal(configDir({ env, platform: 'win32' }), 'C:\New');
  assert.equal(configDir({ env: { ...env, REMOTE_FOR_HERDR_HOME: '' }, platform: 'win32' }), 'C:\Old');
  assert.equal(configDir({ env, platform: 'win32', home: 'C:\X' }), 'C:\X');
});

test('npm: legacyConfigDir is the old herdr-remote folder next to the new one', () => {
  assert.equal(legacyConfigDir({ env: { APPDATA: 'C:\A' }, platform: 'win32' }), path.join('C:\A', 'herdr-remote'));
  assert.equal(legacyConfigDir({ env: { XDG_CONFIG_HOME: '/x' }, platform: 'linux' }), path.join('/x', 'herdr-remote'));
});

// A fake APPDATA in a temp dir: never the real one.
function appData() {
  const root = tmp();
  const env = { APPDATA: root, XDG_CONFIG_HOME: root };
  const oldDir = path.join(root, 'herdr-remote');
  const newDir = path.join(root, 'remote-for-herdr');
  return { root, env, oldDir, newDir };
}

test('npm: migrateLegacyHome moves the old folder (contents intact) and logs once', () => {
  const { env, oldDir, newDir } = appData();
  fs.mkdirSync(path.join(oldDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(oldDir, 'config.json'), '{"port":4781}');
  fs.writeFileSync(path.join(oldDir, 'logs', 'server.log'), 'x');
  const lines = [];
  const r = migrateLegacyHome({ env, log: (m) => lines.push(m) });
  assert.deepEqual(r, { from: oldDir, to: newDir, mode: 'moved' });
  assert.equal(fs.existsSync(oldDir), false);
  assert.equal(loadConfig(newDir).port, 4781);
  assert.equal(fs.readFileSync(path.join(newDir, 'logs', 'server.log'), 'utf8'), 'x');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /Moved/);
  // Second run: the new folder exists, nothing happens and nothing is logged.
  assert.equal(migrateLegacyHome({ env, log: (m) => lines.push(m) }), null);
  assert.equal(lines.length, 1);
});

test('npm: migrateLegacyHome copies and keeps the old folder when the rename fails', () => {
  const { env, oldDir, newDir } = appData();
  fs.mkdirSync(oldDir);
  fs.writeFileSync(path.join(oldDir, 'config.json'), '{"port":4782}');
  const fsImpl = { ...fs, renameSync: () => { throw Object.assign(new Error('busy'), { code: 'EPERM' }); } };
  const lines = [];
  const r = migrateLegacyHome({ env, log: (m) => lines.push(m), fsImpl });
  assert.equal(r.mode, 'copied');
  assert.equal(loadConfig(newDir).port, 4782);
  assert.equal(loadConfig(oldDir).port, 4782);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /Copied.*EPERM.*old folder is kept/);
});

test('npm: migrateLegacyHome does nothing with --home, an env home, an existing new folder, or no old folder', () => {
  const { env, oldDir, newDir } = appData();
  assert.equal(migrateLegacyHome({ env }), null); // no old folder
  fs.mkdirSync(oldDir);
  assert.equal(migrateLegacyHome({ env, home: path.join(oldDir, 'x') }), null);
  assert.equal(migrateLegacyHome({ env: { ...env, REMOTE_FOR_HERDR_HOME: 'C:\h' } }), null);
  assert.equal(migrateLegacyHome({ env: { ...env, HERDR_REMOTE_HOME: 'C:\h' } }), null);
  fs.mkdirSync(newDir);
  assert.equal(migrateLegacyHome({ env }), null);
  assert.equal(fs.existsSync(oldDir), true);
});
