import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDir, loadConfig, saveConfig, loadState, saveState, validateConfig } from './config.js';
import { hashPin, isAcceptablePin } from './auth.js';
import { generateVapidKeys } from './push.js';
import { runCommand, installTask as realInstallTask } from './startup-task.js';

export function parseTailscaleStatus(json) {
  const selfId = json?.Self?.UserID;
  const dns = json?.Self?.DNSName;
  return {
    running: json?.BackendState === 'Running',
    loginName: json?.User?.[selfId]?.LoginName ?? null,
    dnsName: typeof dns === 'string' && dns ? dns.replace(/\.$/, '') : null,
    httpsReady: Array.isArray(json?.CertDomains) && json.CertDomains.length > 0,
  };
}

// True when something accepts a TCP connection on 127.0.0.1:<port> (e.g. a running server).
export function portAnswers(port, { timeoutMs = 1000 } = {}) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    const done = (answer) => { sock.destroy(); resolve(answer); };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

export const originFromDnsName = (dnsName) => 'https://' + dnsName;

const isYes = (answer, dflt) => {
  const a = String(answer ?? '').trim().toLowerCase();
  return a === '' ? dflt : a.startsWith('y');
};

async function hcRuns(exec, cmd) {
  try {
    return (await exec(cmd, ['--version'])).code === 0;
  } catch {
    return false;
  }
}

async function findHc({ cfg, exec, prompt, log }) {
  let cmd = cfg.hcPath ?? 'hc';
  while (!(await hcRuns(exec, cmd))) {
    log(`Could not run "${cmd}". Is Herdr installed and "hc" on PATH?`);
    const p = String(await prompt('Path to hc (leave empty to abort): ')).trim();
    if (!p) throw new Error('hc not found. Install Herdr, or re-run setup and give the path to hc.');
    cmd = p;
  }
  cfg.hcPath = cmd === 'hc' ? null : cmd;
  try {
    const r = await exec(cmd, ['ls', '--json']);
    const n = JSON.parse(r.stdout).terminals?.length ?? 0;
    log(`hc works: ${n} terminal(s) visible.`);
  } catch {
    log('hc is installed, but "hc ls" did not return terminals (is Herdr running?). Continuing.');
  }
}

async function askPin({ prompt, log, existing }) {
  if (existing && isYes(await prompt('Keep current PIN? [Y/n] '), true)) return existing;
  for (;;) {
    const pin = await prompt('PIN (at least 6 characters): ', { secret: true });
    if (!isAcceptablePin(pin)) { log('PIN must be at least 6 characters.'); continue; }
    const again = await prompt('Confirm PIN: ', { secret: true });
    if (pin !== again) { log('PINs did not match.'); continue; }
    return hashPin(pin);
  }
}

export async function runSetup({
  home, proxy = false, prompt, exec = runCommand, log = console.log,
  installTask = realInstallTask,
  isServerRunning = portAnswers,
  cliPath = fileURLToPath(new URL('./cli.js', import.meta.url)),
}) {
  const dir = configDir({ home });
  const prev = loadConfig(dir);
  // A running server keeps its config/state in memory and would undo this setup.
  if (await isServerRunning(prev.port)) throw new Error('remote-for-herdr is running — stop it first: remote-for-herdr stop');
  const cfg = { ...prev };
  const state = loadState(dir);
  const ask = async (q, dflt = '') => {
    const a = String(await prompt(q)).trim();
    return a || dflt;
  };

  await findHc({ cfg, exec, prompt, log });

  if (proxy) {
    log('WARNING: proxy mode is unsupported. You are responsible for putting a TLS-terminating,');
    log('authenticating reverse proxy in front of this server; remote-for-herdr cannot verify it.');
    cfg.access = 'proxy';
    const dfltOrigin = prev.publicOrigin ?? '';
    cfg.publicOrigin = await ask(`Public origin (e.g. https://remote.example.com)${dfltOrigin ? ` [${dfltOrigin}]` : ''}: `, dfltOrigin);
    if (cfg.publicOrigin.startsWith('http:')) log('WARNING: plain http:// origin. Only use this for localhost testing; phones need https for push and install.');
    if (!/^https?:\/\/[^/\s]+$/.test(cfg.publicOrigin)) throw new Error('Public origin must look like https://host (no path).');
    const header = await ask('Identity header name (optional, empty = none): ');
    cfg.proxyIdentityHeader = header || null;
    cfg.proxyIdentityValue = header ? await ask('Identity header value (the login your proxy sends for you): ') : null;
  } else {
    const r = await exec('tailscale', ['status', '--json']).catch(() => ({ code: 127, stdout: '' }));
    let ts = null;
    try { ts = parseTailscaleStatus(JSON.parse(r.stdout)); } catch { /* not JSON */ }
    if (r.code === 127) throw new Error('Tailscale CLI not found. Install Tailscale (and make sure "tailscale" is on PATH), then re-run setup.');
    if (!ts?.running) throw new Error('Tailscale is not running. Start Tailscale and sign in, then re-run setup.');
    if (!ts.httpsReady) throw new Error('Tailscale HTTPS is not ready. Enable HTTPS certificates in the Tailscale admin console → DNS, then re-run setup.');
    cfg.access = 'tailscale';
    const dflt = prev.allowedLogin ?? ts.loginName ?? '';
    cfg.allowedLogin = await ask(`Allowed Tailscale login${dflt ? ` [${dflt}]` : ''}: `, dflt);
    if (!cfg.allowedLogin) throw new Error('An allowed login is required.');
    cfg.publicOrigin = originFromDnsName(ts.dnsName);
  }

  cfg.pinHash = await askPin({ prompt, log, existing: prev.pinHash });
  if (!cfg.vapid) cfg.vapid = generateVapidKeys();

  const errs = validateConfig(cfg);
  if (errs.length) {
    errs.forEach((e) => log(`Invalid config: ${e}`));
    throw new Error('Refusing to save an invalid config: ' + errs.join('; '));
  }

  const identityChanged = proxy && (prev.proxyIdentityHeader !== cfg.proxyIdentityHeader || prev.proxyIdentityValue !== cfg.proxyIdentityValue);
  if (identityChanged) state.sessions = {};
  if (prev.pinHash && prev.pinHash !== cfg.pinHash) state.sessions = {}; // R18: new PIN signs everyone out
  if (prev.publicOrigin !== cfg.publicOrigin || prev.allowedLogin !== cfg.allowedLogin) {
    state.subscriptions = [];
    state.sessions = {};
    if (prev.publicOrigin) log('Re-open the new URL on your phone and enable notifications again.');
  }

  saveConfig(dir, cfg);
  saveState(dir, state);

  if (!proxy && isYes(await prompt(`Run "tailscale serve --bg ${cfg.port}" now? [y/N] `), false)) {
    const r = await exec('tailscale', ['serve', '--bg', String(cfg.port)]);
    log(r.code === 0 ? 'tailscale serve is configured.' : `tailscale serve failed: ${(r.stderr || r.stdout).trim()}`);
  }
  if (isYes(await prompt('Start at login (Windows scheduled task)? [y/N] '), false)) {
    try { await installTask({ home: dir, cliPath }); log('Start-at-login task installed.'); }
    catch (err) { log(`Could not install the task: ${err.message}`); }
  }

  log(`Config saved in ${path.resolve(dir)}`);
  log(`Open on your phone: ${cfg.publicOrigin}`);
  return cfg;
}
