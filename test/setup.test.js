import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseTailscaleStatus, originFromDnsName, runSetup } from '../src/setup.js';
import { loadConfig, loadState, saveState, validateConfig } from '../src/config.js';
import { verifyPin } from '../src/auth.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hr-setup-'));

const tsJson = (over = {}) => ({
  BackendState: 'Running',
  Self: { UserID: 7, DNSName: 'box.example.ts.net.' },
  User: { 7: { LoginName: 'owner@example.com' } },
  CertDomains: ['box.example.ts.net'],
  ...over,
});

test('parseTailscaleStatus: HTTPS not enabled', () => {
  const r = parseTailscaleStatus(tsJson({ CertDomains: [] }));
  assert.deepEqual(r, { running: true, loginName: 'owner@example.com', dnsName: 'box.example.ts.net', httpsReady: false });
});

test('parseTailscaleStatus: stopped / missing fields', () => {
  const r = parseTailscaleStatus({ BackendState: 'Stopped' });
  assert.deepEqual(r, { running: false, loginName: null, dnsName: null, httpsReady: false });
});

test('originFromDnsName', () => {
  assert.equal(originFromDnsName('box.example.ts.net'), 'https://box.example.ts.net');
});

// scripted prompt: entries = [[regex, [answers...]], ...]
function scripted(entries) {
  const prompt = async (q) => {
    for (const [re, queue] of entries) {
      if (re.test(q)) {
        if (!queue.length) throw new Error('script exhausted for: ' + q);
        return queue.shift();
      }
    }
    throw new Error('unexpected prompt: ' + q);
  };
  return { prompt };
}

function stubExec({ ts = tsJson() } = {}) {
  const calls = [];
  const exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'hc' && args[0] === '--version') return { code: 0, stdout: 'hc 0.1.21\n', stderr: '' };
    if (cmd === 'hc' && args[0] === 'ls') return { code: 0, stdout: JSON.stringify({ terminals: [{}, {}] }), stderr: '' };
    if (cmd === 'tailscale' && args[0] === 'status') return { code: 0, stdout: JSON.stringify(ts), stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  return { exec, calls };
}

const quiet = () => { const lines = []; return { log: (...a) => lines.push(a.join(' ')), lines }; };

test('runSetup tailscale: valid config; re-run with new login clears subscriptions/sessions, keeps VAPID', async () => {
  const home = tmp();
  const { exec, calls } = stubExec();
  const out = quiet();
  const s1 = scripted([
    [/allowed.*login/i, ['']],
    [/^PIN/, ['hunter22']],
    [/^Confirm PIN/, ['hunter22']],
    [/tailscale serve/i, ['n']],
    [/start at login/i, ['n']],
  ]);
  await runSetup({ home, prompt: s1.prompt, exec, log: out.log, installTask: async () => assert.fail('no') });
  const cfg = loadConfig(home);
  assert.deepEqual(validateConfig(cfg), []);
  assert.equal(cfg.allowedLogin, 'owner@example.com');
  assert.equal(cfg.publicOrigin, 'https://box.example.ts.net');
  assert.ok(verifyPin('hunter22', cfg.pinHash));
  assert.ok(cfg.vapid.publicKey);
  assert.ok(calls.some((c) => c.join(' ') === 'hc ls --json'));
  assert.ok(out.lines.some((l) => l.includes('https://box.example.ts.net')));

  const st = loadState(home);
  st.subscriptions = [{ endpoint: 'https://push.example/x' }];
  st.sessions = { abc: { createdAt: 1 } };
  saveState(home, st);

  const s2 = scripted([
    [/allowed.*login/i, ['other@example.com']],
    [/keep current PIN/i, ['y']],
    [/tailscale serve/i, ['n']],
    [/start at login/i, ['n']],
  ]);
  const out2 = quiet();
  await runSetup({ home, prompt: s2.prompt, exec, log: out2.log });
  const cfg2 = loadConfig(home);
  assert.equal(cfg2.allowedLogin, 'other@example.com');
  assert.deepEqual(cfg2.vapid, cfg.vapid);
  assert.equal(cfg2.pinHash, cfg.pinHash);
  const st2 = loadState(home);
  assert.deepEqual(st2.subscriptions, []);
  assert.deepEqual(st2.sessions, {});
  assert.ok(out2.lines.some((l) => l.includes('Re-open the new URL on your phone and enable notifications again')));
});

test('runSetup tailscale: stops when HTTPS certs not enabled', async () => {
  const home = tmp();
  const { exec } = stubExec({ ts: tsJson({ CertDomains: [] }) });
  await assert.rejects(
    runSetup({ home, prompt: scripted([]).prompt, exec, log: () => {} }),
    /Enable HTTPS certificates in the Tailscale admin console/,
  );
  assert.equal(fs.existsSync(path.join(home, 'config.json')), false);
});

test('runSetup tailscale: stops when not running', async () => {
  const { exec } = stubExec({ ts: { BackendState: 'Stopped' } });
  await assert.rejects(
    runSetup({ home: tmp(), prompt: scripted([]).prompt, exec, log: () => {} }),
    /not running/i,
  );
});

test('runSetup proxy: empty/short PIN re-prompts; warns; stores origin and identity header', async () => {
  const home = tmp();
  const { exec, calls } = stubExec();
  const out = quiet();
  const s = scripted([
    [/public origin/i, ['https://remote.example.com']],
    [/identity header name/i, ['X-Auth-User']],
    [/identity header value/i, ['owner@example.com']],
    [/^PIN/, ['', 'short', 'hunter22']],
    [/^Confirm PIN/, ['hunter22']],
    [/start at login/i, ['n']],
  ]);
  await runSetup({ home, proxy: true, prompt: s.prompt, exec, log: out.log });
  const cfg = loadConfig(home);
  assert.equal(cfg.access, 'proxy');
  assert.equal(cfg.publicOrigin, 'https://remote.example.com');
  assert.equal(cfg.proxyIdentityHeader, 'X-Auth-User');
  assert.equal(cfg.proxyIdentityValue, 'owner@example.com');
  assert.deepEqual(validateConfig(cfg), []);
  assert.ok(verifyPin('hunter22', cfg.pinHash));
  assert.ok(out.lines.some((l) => /unsupported/i.test(l)));
  assert.ok(!calls.some((c) => c[0] === 'tailscale'));
});

test('runSetup: PIN mismatch re-asks', async () => {
  const home = tmp();
  const { exec } = stubExec();
  const s = scripted([
    [/allowed.*login/i, ['']],
    [/^PIN/, ['hunter22', 'hunter22']],
    [/^Confirm PIN/, ['hunter23', 'hunter22']],
    [/tailscale serve/i, ['n']],
    [/start at login/i, ['n']],
  ]);
  await runSetup({ home, prompt: s.prompt, exec, log: () => {} });
  assert.ok(verifyPin('hunter22', loadConfig(home).pinHash));
});

test('runSetup: missing hc offers hcPath override', async () => {
  const home = tmp();
  const alt = 'C:\\tools\\hc.exe';
  const exec = async (cmd, args) => {
    if (cmd === 'hc') throw Object.assign(new Error('spawn hc ENOENT'), { code: 'ENOENT' });
    if (cmd === alt) return { code: 0, stdout: args[0] === 'ls' ? '{"terminals":[]}' : 'hc 0.1.21', stderr: '' };
    if (cmd === 'tailscale') return { code: 0, stdout: JSON.stringify(tsJson()), stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const s = scripted([
    [/path to hc/i, [alt]],
    [/allowed.*login/i, ['']],
    [/^PIN/, ['hunter22']],
    [/^Confirm PIN/, ['hunter22']],
    [/tailscale serve/i, ['n']],
    [/start at login/i, ['n']],
  ]);
  await runSetup({ home, prompt: s.prompt, exec, log: () => {} });
  assert.equal(loadConfig(home).hcPath, alt);
});

test('runSetup: accepting serve and start-at-login runs them', async () => {
  const home = tmp();
  const { exec, calls } = stubExec();
  let installed = 0;
  const s = scripted([
    [/allowed.*login/i, ['']],
    [/^PIN/, ['hunter22']],
    [/^Confirm PIN/, ['hunter22']],
    [/tailscale serve/i, ['y']],
    [/start at login/i, ['y']],
  ]);
  await runSetup({ home, prompt: s.prompt, exec, log: () => {}, installTask: async () => { installed++; } });
  assert.ok(calls.some((c) => c.join(' ') === 'tailscale serve --bg 4780'));
  assert.equal(installed, 1);
});
