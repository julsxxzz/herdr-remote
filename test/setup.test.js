import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { parseTailscaleStatus, originFromDnsName, runSetup, portAnswers } from '../src/setup.js';
import { loadConfig, loadState, saveState, validateConfig } from '../src/config.js';
import { verifyPin } from '../src/auth.js';

const notRunning = async () => false;
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
  await runSetup({ isServerRunning: notRunning, home, prompt: s1.prompt, exec, log: out.log, installTask: async () => assert.fail('no') });
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
  await runSetup({ isServerRunning: notRunning, home, prompt: s2.prompt, exec, log: out2.log });
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
    runSetup({ isServerRunning: notRunning, home, prompt: scripted([]).prompt, exec, log: () => {} }),
    /Enable HTTPS certificates in the Tailscale admin console/,
  );
  assert.equal(fs.existsSync(path.join(home, 'config.json')), false);
});

test('runSetup tailscale: stops when not running', async () => {
  const { exec } = stubExec({ ts: { BackendState: 'Stopped' } });
  await assert.rejects(
    runSetup({ isServerRunning: notRunning, home: tmp(), prompt: scripted([]).prompt, exec, log: () => {} }),
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
  await runSetup({ isServerRunning: notRunning, home, proxy: true, prompt: s.prompt, exec, log: out.log });
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
  await runSetup({ isServerRunning: notRunning, home, prompt: s.prompt, exec, log: () => {} });
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
  await runSetup({ isServerRunning: notRunning, home, prompt: s.prompt, exec, log: () => {} });
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
  await runSetup({ isServerRunning: notRunning, home, prompt: s.prompt, exec, log: () => {}, installTask: async () => { installed++; }, waitUntilRunning: async () => true });
  assert.ok(calls.some((c) => c.join(' ') === 'tailscale serve --bg 4780'));
  assert.equal(installed, 1);
});

test('runSetup tailscale: missing CLI reports not installed', async () => {
  const exec = async (cmd) => (cmd === 'tailscale'
    ? { code: 127, stdout: '', stderr: 'ENOENT' }
    : { code: 0, stdout: '{"terminals":[]}', stderr: '' });
  await assert.rejects(runSetup({ isServerRunning: notRunning, home: tmp(), prompt: scripted([]).prompt, exec, log: () => {} }), /Tailscale CLI not found/);
});

test('runSetup proxy: warns on http origin; identity change clears sessions; invalid config not saved', async () => {
  const home = tmp();
  const { exec } = stubExec();
  const out = quiet();
  const run = (origin, header, value) => runSetup({ isServerRunning: notRunning,
    home, proxy: true, exec, log: out.log,
    prompt: scripted([
      [/public origin/i, [origin]],
      [/identity header name/i, [header]],
      [/identity header value/i, [value]],
      [/^PIN/, ['hunter22']],
      [/^Confirm PIN/, ['hunter22']],
      [/keep current PIN/i, ['y']],
      [/start at login/i, ['n']],
    ]).prompt,
  });
  await run('http://localhost:4780', 'X-Auth-User', 'owner@example.com');
  assert.ok(out.lines.some((l) => /plain http/i.test(l)));
  const st = loadState(home);
  st.sessions = { abc: { createdAt: 1 } };
  saveState(home, st);
  await run('http://localhost:4780', 'X-Auth-User', 'other@example.com');
  assert.deepEqual(loadState(home).sessions, {});

  const bad = tmp();
  await assert.rejects(runSetup({ isServerRunning: notRunning,
    home: bad, proxy: true, exec, log: () => {},
    prompt: scripted([[/public origin/i, ['']]]).prompt,
  }), /Public origin/);
  assert.equal(fs.existsSync(path.join(bad, 'config.json')), false);
});

test('R18: changing the PIN clears sessions; keeping it does not', async () => {
  const home = tmp();
  const { exec } = stubExec();
  const answers = (pinAnswers) => scripted([
    [/allowed.*login/i, ['']],
    ...pinAnswers,
    [/tailscale serve/i, ['n']],
    [/start at login/i, ['n']],
  ]).prompt;
  await runSetup({ isServerRunning: notRunning, home, exec, log: () => {}, prompt: answers([[/^PIN/, ['hunter22']], [/^Confirm PIN/, ['hunter22']]]) });
  const seed = () => { const st = loadState(home); st.sessions = { abc: { createdAt: 1 } }; st.subscriptions = [{ endpoint: 'https://push.example/x' }]; saveState(home, st); };

  seed();
  await runSetup({ isServerRunning: notRunning, home, exec, log: () => {}, prompt: answers([[/keep current PIN/i, ['y']]]) });
  assert.deepEqual(Object.keys(loadState(home).sessions), ['abc']);

  await runSetup({ isServerRunning: notRunning, home, exec, log: () => {}, prompt: answers([[/keep current PIN/i, ['n']], [/^PIN/, ['newpin99']], [/^Confirm PIN/, ['newpin99']]]) });
  const st = loadState(home);
  assert.deepEqual(st.sessions, {});
  assert.equal(st.subscriptions.length, 1);
  assert.ok(verifyPin('newpin99', loadConfig(home).pinHash));
});

test('I3: setup refuses while remote-for-herdr answers on the configured port; nothing written', async () => {
  const home = tmp();
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ port: 4999 }));
  const before = fs.readFileSync(path.join(home, 'config.json'), 'utf8');
  const probed = [];
  const { exec, calls } = stubExec();
  await assert.rejects(
    runSetup({ home, exec, log: () => {}, prompt: scripted([]).prompt, isServerRunning: async (port) => { probed.push(port); return true; } }),
    { message: 'remote-for-herdr is running — stop it first: remote-for-herdr stop' },
  );
  assert.deepEqual(probed, [4999]);
  assert.equal(calls.length, 0);
  assert.equal(fs.readFileSync(path.join(home, 'config.json'), 'utf8'), before);
  assert.equal(fs.existsSync(path.join(home, 'state.json')), false);
});

test('portAnswers: true when something listens on 127.0.0.1:<port>, false otherwise', async () => {
  const srv = net.createServer((s) => s.destroy());
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  let answered;
  try { answered = await portAnswers(port, { timeoutMs: 1000 }); } finally { await new Promise((r) => srv.close(r)); }
  assert.equal(answered, true);
  assert.equal(await portAnswers(port, { timeoutMs: 1000 }), false);
});

const answers = (atLogin) => scripted([
  [/allowed.*login/i, ['']],
  [/^PIN/, ['hunter22']],
  [/^Confirm PIN/, ['hunter22']],
  [/tailscale serve/i, ['n']],
  [/start at login/i, [atLogin]],
]);
// A global npm install layout in a temp dir: <prefix>\remote-for-herdr.cmd next to <prefix>\node_modules.
function installLayout({ global }) {
  const prefix = tmp();
  const cli = path.join(prefix, 'node_modules', 'remote-for-herdr', 'src', 'cli.js');
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.writeFileSync(cli, '');
  if (global) fs.writeFileSync(path.join(prefix, 'remote-for-herdr.cmd'), '');
  return cli;
}
const GLOBAL_CLI = installLayout({ global: true });
const LOCAL_CLI = installLayout({ global: false });
const NPX_CLI = 'C:\\Users\\me\\AppData\\Local\\npm-cache\\_npx\\ab12\\node_modules\\remote-for-herdr\\src\\cli.js';

test('npm: accepting start-at-login runs the new task right away, then prints the phone URL and its QR code', async () => {
  const home = tmp();
  const { exec, calls } = stubExec();
  const out = quiet();
  const waited = [];
  await runSetup({
    isServerRunning: notRunning, home, prompt: answers('y').prompt, exec, log: out.log, cliPath: GLOBAL_CLI,
    installTask: async () => {}, startDetached: () => assert.fail('the task is installed'),
    waitUntilRunning: async (o) => { waited.push(o); return true; }, qr: (url) => `QR<${url}>`,
  });
  // /End first: a launcher in its restart pause would make Task Scheduler ignore the /Run.
  assert.deepEqual(calls.filter((c) => c[0] === 'schtasks'), [['schtasks', '/End', '/TN', 'remote-for-herdr'], ['schtasks', '/Run', '/TN', 'remote-for-herdr']]);
  assert.equal(waited.length, 1);
  assert.equal(waited[0].home, home);
  assert.equal(waited[0].port, 4780);
  assert.equal(typeof waited[0].since, 'number'); // its server must have written server.pid after the /Run
  assert.deepEqual(out.lines.slice(-3), [
    'remote-for-herdr is running (start-at-login task).',
    'Open on your phone: https://box.example.ts.net',
    'QR<https://box.example.ts.net>',
  ]);
});

test('npm: a task launcher that ignores the first /Run (still finishing) gets a second one', async () => {
  const { exec, calls } = stubExec();
  const out = quiet();
  let n = 0;
  await runSetup({
    isServerRunning: notRunning, home: tmp(), prompt: answers('y').prompt, exec, log: out.log, cliPath: GLOBAL_CLI,
    installTask: async () => {}, waitUntilRunning: async () => ++n === 2, qr: () => '',
  });
  assert.equal(calls.filter((c) => c[0] === 'schtasks' && c[1] === '/Run').length, 2);
  assert.ok(out.lines.includes('remote-for-herdr is running (start-at-login task).'), out.lines.join('\n'));
});

test('npm: from the npx cache, no task is installed (global install hint) and the server is started detached', async () => {
  const home = tmp();
  const { exec, calls } = stubExec();
  const out = quiet();
  const detached = [];
  const { installTask } = await import('../src/startup-task.js');
  await runSetup({
    isServerRunning: notRunning, home, prompt: answers('y').prompt, exec, log: out.log, cliPath: NPX_CLI,
    installTask, startDetached: (o) => detached.push(o), waitUntilRunning: async () => true, qr: () => 'QR',
  });
  assert.equal(calls.filter((c) => c[0] === 'schtasks').length, 0); // the real installTask refused before schtasks
  assert.ok(out.lines.some((l) => l.includes('npm i -g remote-for-herdr')), out.lines.join('\n'));
  assert.deepEqual(detached, [{ home, cliPath: NPX_CLI }]);
  assert.ok(out.lines.includes('remote-for-herdr is running.'));
  assert.equal(out.lines.at(-1), 'QR');
});

test('npm: declining start-at-login prints the exact start command for how it was installed', async () => {
  const cases = [
    [GLOBAL_CLI, 'remote-for-herdr start'],
    [NPX_CLI, 'npx remote-for-herdr start'],
    [LOCAL_CLI, 'npx remote-for-herdr start'],
    ['C:\\src\\rfh\\src\\cli.js', 'node "C:\\src\\rfh\\src\\cli.js" start'],
  ];
  for (const [cliPath, cmd] of cases) {
    const { exec, calls } = stubExec();
    const out = quiet();
    await runSetup({
      isServerRunning: notRunning, home: tmp(), prompt: answers('n').prompt, exec, log: out.log, cliPath,
      installTask: async () => assert.fail('no'), startDetached: () => assert.fail('no'),
      waitUntilRunning: async () => assert.fail('no'), qr: () => 'QR',
    });
    assert.equal(calls.filter((c) => c[0] === 'schtasks').length, 0);
    assert.ok(out.lines.includes(`Start it with: ${cmd}`), out.lines.join('\n'));
    assert.deepEqual(out.lines.slice(-2), ['Open on your phone: https://box.example.ts.net', 'QR']);
  }
});

test('npm: a server that does not come up is reported with the log path and the start command', async () => {
  const home = tmp();
  const { exec } = stubExec();
  const out = quiet();
  await runSetup({
    isServerRunning: notRunning, home, prompt: answers('y').prompt, exec, log: out.log, cliPath: GLOBAL_CLI,
    installTask: async () => {}, waitUntilRunning: async () => false, qr: () => '',
  });
  assert.ok(out.lines.some((l) => l.startsWith('remote-for-herdr did not start:')
    && l.includes(path.join(home, 'logs', 'server.log')) && l.endsWith('remote-for-herdr start')), out.lines.join('\n'));
});

test('owner decision: start-at-login defaults to yes (empty answer installs and starts it)', async () => {
  const { exec } = stubExec();
  let installed = 0;
  let asked = '';
  const base = answers('');
  const prompt = async (q) => { if (/start at login/i.test(q)) asked = q; return base.prompt(q); };
  await runSetup({
    isServerRunning: notRunning, home: tmp(), prompt, exec, log: () => {}, cliPath: GLOBAL_CLI,
    installTask: async () => { installed++; }, waitUntilRunning: async () => true, qr: () => '',
  });
  assert.match(asked, /\[Y\/n\] $/);
  assert.equal(installed, 1);
});

test('fix: a detached start waits for the pid it started (not just any program on the port)', async () => {
  const { exec } = stubExec();
  const waited = [];
  const { installTask } = await import('../src/startup-task.js');
  await runSetup({
    isServerRunning: notRunning, home: tmp(), prompt: answers('y').prompt, exec, log: () => {}, cliPath: NPX_CLI,
    installTask, startDetached: () => ({ pid: 4321 }), waitUntilRunning: async (o) => { waited.push(o); return true; }, qr: () => '',
  });
  assert.equal(waited.length, 1);
  assert.equal(waited[0].pid, 4321);
});
