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

export function configDir({ env = process.env, platform = process.platform, home } = {}) {
  if (home) return home;
  if (env.HERDR_REMOTE_HOME) return env.HERDR_REMOTE_HOME;
  if (platform === 'win32') return path.join(env.APPDATA, 'herdr-remote');
  return path.join(env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'herdr-remote');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
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
