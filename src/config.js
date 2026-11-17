import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_CONFIG = Object.freeze({
  port: 4780,
  bind: '127.0.0.1',
  hcPath: null,
  access: 'tailscale',
  allowedLogin: null,
  publicOrigin: null,
  pinHash: null,
  vapid: null,
  proxyIdentityHeader: null,
  proxyIdentityValue: null,
});

export const DEFAULT_STATE = Object.freeze({
  deskMode: false,
  notifyBlocked: true,
  notifyDone: true,
  subscriptions: [],
  sessions: {},
});

const ACCESS_MODES = ['tailscale', 'proxy'];

export const APP_NAME = 'remote-for-herdr';
export const LEGACY_APP_NAME = 'herdr-remote'; // the project's name before it moved to npm

// The per-user folder that holds <name> (config/state folders live in it).
function appDataRoot({ env, platform }) {
  if (platform === 'win32') return env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
}

// The folder given by --home or an environment variable, or null for the default location.
// REMOTE_FOR_HERDR_HOME is preferred; HERDR_REMOTE_HOME (the old name) still works.
export function explicitHome({ env = process.env, home } = {}) {
  return home || env.REMOTE_FOR_HERDR_HOME || env.HERDR_REMOTE_HOME || null;
}

export function configDir({ env = process.env, platform = process.platform, home } = {}) {
  return explicitHome({ env, home }) ?? path.join(appDataRoot({ env, platform }), APP_NAME);
}

// Where herdr-remote kept its config before the rename (%APPDATA%\herdr-remote, XDG equivalent).
export const legacyConfigDir = ({ env = process.env, platform = process.platform } = {}) =>
  path.join(appDataRoot({ env, platform }), LEGACY_APP_NAME);

// Moves the old herdr-remote folder to the new default location, once: only when no --home or
// environment variable picks the folder, the new one does not exist yet and the old one does. A
// rename first (instant, keeps everything); if that fails (e.g. a file is held open) the folder is
// copied and the old one kept. Returns null when there was nothing to do, else
// { from, to, mode: 'moved' | 'copied' }.
export function migrateLegacyHome({ env = process.env, platform = process.platform, home, log = () => {}, fsImpl = fs, pid = process.pid } = {}) {
  if (explicitHome({ env, home })) return null;
  const to = configDir({ env, platform });
  const from = legacyConfigDir({ env, platform });
  if (fsImpl.existsSync(to) || !fsImpl.existsSync(from)) return null;
  fsImpl.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fsImpl.renameSync(from, to);
    log(`Moved your herdr-remote config from ${from} to ${to}.`);
    return { from, to, mode: 'moved' };
  } catch (err) {
    // Copy next to it, then rename into place: a copy that fails half-way must never become the
    // config folder (it would be used from then on, with files missing). The old folder is untouched.
    const tmp = `${to}.migrating-${pid}`;
    try {
      fsImpl.rmSync(tmp, { recursive: true, force: true });
      fsImpl.cpSync(from, tmp, { recursive: true });
      fsImpl.renameSync(tmp, to);
    } catch (copyErr) {
      try { fsImpl.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
      throw copyErr;
    }
    log(`Copied your herdr-remote config from ${from} to ${to} (could not move it: ${err.code ?? err.message}; the old folder is kept, delete it when you like).`);
    return { from, to, mode: 'copied' };
  }
}

function readJson(file) {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${file} must contain a JSON object`);
  }
  return value;
}

function writeJsonAtomic(dir, name, value) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

const clone = (v) => structuredClone(v);

export const loadConfig = (dir) => ({ ...clone(DEFAULT_CONFIG), ...readJson(path.join(dir, 'config.json')) });
export const saveConfig = (dir, cfg) => writeJsonAtomic(dir, 'config.json', cfg);
export const loadState = (dir) => ({ ...clone(DEFAULT_STATE), ...readJson(path.join(dir, 'state.json')) });
export const saveState = (dir, state) => writeJsonAtomic(dir, 'state.json', state);

export function validateConfig(cfg) {
  const errs = [];
  if (!ACCESS_MODES.includes(cfg.access)) {
    errs.push(`access must be one of: ${ACCESS_MODES.join(', ')}`);
  }
  if (!cfg.pinHash) errs.push('pinHash is missing (run setup)');
  if (!cfg.publicOrigin) errs.push('publicOrigin is missing (run setup)');
  if (!cfg.vapid) errs.push('vapid keys are missing (run setup)');
  if (cfg.access === 'tailscale') {
    if (!cfg.allowedLogin) errs.push('allowedLogin is required when access is "tailscale"');
    if (cfg.bind !== '127.0.0.1') errs.push('bind must be 127.0.0.1 when access is "tailscale"');
  }
  return errs;
}
