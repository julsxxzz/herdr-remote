import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  taskCommands, taskXml, defaultUserId, installTask, uninstallTask, isNpxCachePath, isTaskInstalled, runTask,
} from '../src/startup-task.js';
import { SERVER_NODE_FLAGS, EXIT_SETUP_REQUIRED } from '../src/supervisor.js';

const USER = 'DEMO-PC\\demo';

test('taskCommands: argv arrays and vbs content', () => {
  const t = taskCommands({ nodePath: 'C:\\node\\node.exe', cliPath: 'C:\\app\\src\\cli.js', home: 'C:\\h', userId: USER });
  const flags = SERVER_NODE_FLAGS.map((f) => `${f} `).join('');
  assert.equal(t.vbs, [
    'Set sh = CreateObject("WScript.Shell")',
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    'stopFile = "C:\\h\\server.stop"',
    'pause = 1',
    'Do',
    '  started = Now',
    '  On Error Resume Next',
    `  rc = sh.Run("""C:\\node\\node.exe"" ${flags}""C:\\app\\src\\cli.js"" start --foreground --log --home ""C:\\h""", 0, True)`,
    '  If Err.Number <> 0 Then WScript.Quit 1',
    '  On Error GoTo 0',
    '  If rc = 0 Or rc = 78 Then WScript.Quit 0',
    '  If DateDiff("s", started, Now) >= 60 Then pause = 1',
    '  WScript.Sleep pause * 1000',
    '  pause = pause * 2',
    '  If pause > 30 Then pause = 30',
    '  If fso.FileExists(stopFile) Then',
    '    On Error Resume Next',
    '    fso.DeleteFile stopFile',
    '    WScript.Quit 0',
    '  End If',
    'Loop',
    '',
  ].join('\r\n'));
  assert.equal(t.vbsPath, 'C:\\h\\start-hidden.vbs');
  assert.equal(t.xmlPath, 'C:\\h\\remote-for-herdr-task.xml');
  assert.deepEqual(t.create, ['schtasks', '/Create', '/F', '/TN', 'remote-for-herdr', '/XML', 'C:\\h\\remote-for-herdr-task.xml']);
  assert.deepEqual(t.end, ['schtasks', '/End', '/TN', 'remote-for-herdr']);
  assert.deepEqual(t.remove, ['schtasks', '/Delete', '/F', '/TN', 'remote-for-herdr']);
  assert.equal(t.xml, taskXml({ home: 'C:\\h', userId: USER }));
});

test('taskCommands: paths with spaces stay quoted', () => {
  const t = taskCommands({ nodePath: 'C:\\Program Files\\nodejs\\node.exe', cliPath: 'C:\\My App\\cli.js', home: 'C:\\Users\\A B\\herdr', userId: USER });
  assert.ok(t.vbs.includes('"""C:\\Program Files\\nodejs\\node.exe"" '));
  assert.ok(t.vbs.includes(' ""C:\\My App\\cli.js"" start --foreground --log --home ""C:\\Users\\A B\\herdr"""'));
  assert.ok(t.xml.includes('<Arguments>&quot;C:\\Users\\A B\\herdr\\start-hidden.vbs&quot;</Arguments>'));
});

test('taskCommands: home is made absolute', () => {
  const t = taskCommands({ nodePath: 'C:\\n\\node.exe', cliPath: 'C:\\a\\cli.js', home: 'C:\\x\\y\\..\\h', userId: USER });
  assert.ok(t.vbs.includes('--home ""C:\\x\\h""'));
  assert.equal(t.vbsPath, 'C:\\x\\h\\start-hidden.vbs');
});

test('lighter: the launcher runs the server itself (no supervisor), with the server flags', () => {
  const t = taskCommands({ nodePath: 'C:\\n\\node.exe', cliPath: 'C:\\a\\cli.js', home: 'C:\\h', userId: USER });
  const run = t.vbs.split('\r\n').map((l) => l.trim()).find((l) => l.startsWith('rc = sh.Run('));
  const exe = ['""C:\\n\\node.exe""', ...SERVER_NODE_FLAGS, '""C:\\a\\cli.js""'].join(' ');
  assert.ok(run.startsWith(`rc = sh.Run("${exe} start --foreground --log --home `), run);
});

test('lighter: the launcher waits for the server and runs it again after a crash, but not after exit 0 or 78', () => {
  const { vbs } = taskCommands({ nodePath: 'C:\\n\\node.exe', cliPath: 'C:\\a\\cli.js', home: 'C:\\h', userId: USER });
  const lines = vbs.split('\r\n').map((l) => l.trim());
  const at = (l) => lines.indexOf(l);
  const quit = `If rc = 0 Or rc = ${EXIT_SETUP_REQUIRED} Then WScript.Quit 0`;
  const sleep = 'WScript.Sleep pause * 1000';
  const run = lines.findIndex((l) => l.startsWith('rc = sh.Run('));
  assert.match(lines[run], /, 0, True\)$/); // hidden window, waits for the exit code
  assert.ok(at('Do') >= 0 && at('Do') < run && run < at(quit), vbs);
  assert.ok(at(quit) < at(sleep) && at(sleep) < at('Loop'), vbs);
  assert.ok(at('If pause > 30 Then pause = 30') > at(sleep)); // backoff 1, 2, 4 ... 30 s
  assert.ok(at('If DateDiff("s", started, Now) >= 60 Then pause = 1') > run); // back to 1 s after a minute-long run
  // A node that cannot be started (moved, upgraded) ends it with 1 instead of a modal WSH error box.
  assert.equal(lines[run - 1], 'On Error Resume Next');
  assert.equal(lines[run + 1], 'If Err.Number <> 0 Then WScript.Quit 1');
  assert.equal(lines[run + 2], 'On Error GoTo 0');
  // A "remote-for-herdr stop" during the pause (server.stop) is honoured before the next run.
  assert.ok(lines.includes('stopFile = "C:\\h\\server.stop"'));
  const check = at('If fso.FileExists(stopFile) Then');
  assert.ok(check > at(sleep) && check < at('Loop'), vbs);
  assert.deepEqual(lines.slice(check + 1, check + 5), ['On Error Resume Next', 'fso.DeleteFile stopFile', 'WScript.Quit 0', 'End If']);
  // Nothing else ends it.
  assert.deepEqual(lines.filter((l) => l.includes('WScript.Quit')), ['If Err.Number <> 0 Then WScript.Quit 1', quit, 'WScript.Quit 0']);
  assert.equal(lines.at(-2), 'Loop');
});

const tag = (xml, name) => [...xml.matchAll(new RegExp(`<${name}>([^<]*)</${name}>`, 'g'))].map((m) => m[1]);

test('B24: taskXml triggers on this user\'s logon only and never times out', () => {
  const xml = taskXml({ home: 'C:\\h', userId: USER });
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-16"\?>/);
  assert.match(xml, /<Task version="1\.2" xmlns="http:\/\/schemas\.microsoft\.com\/windows\/2004\/02\/mit\/task">/);
  assert.match(xml, /<LogonTrigger>\s*<Enabled>true<\/Enabled>\s*<UserId>DEMO-PC\\demo<\/UserId>\s*<\/LogonTrigger>/);
  assert.match(xml, /<Principal id="Author">\s*<UserId>DEMO-PC\\demo<\/UserId>\s*<LogonType>InteractiveToken<\/LogonType>\s*<RunLevel>LeastPrivilege<\/RunLevel>/);
  assert.deepEqual(tag(xml, 'Description'), ['remote-for-herdr (start at log on)']);
  assert.deepEqual(tag(xml, 'MultipleInstancesPolicy'), ['IgnoreNew']);
  assert.deepEqual(tag(xml, 'DisallowStartIfOnBatteries'), ['false']);
  assert.deepEqual(tag(xml, 'StopIfGoingOnBatteries'), ['false']);
  assert.deepEqual(tag(xml, 'ExecutionTimeLimit'), ['PT0S']);
  // Backstop only (the launcher restarts the server itself): if the launcher fails, run the task again.
  assert.match(xml, /<RestartOnFailure>\s*<Interval>PT1M<\/Interval>\s*<Count>999<\/Count>\s*<\/RestartOnFailure>/);
  assert.deepEqual(tag(xml, 'Interval'), ['PT1M']);
  assert.deepEqual(tag(xml, 'Count'), ['999']);
  assert.deepEqual(tag(xml, 'AllowHardTerminate'), ['true']);
  assert.deepEqual(tag(xml, 'StartWhenAvailable'), ['true']);
  assert.deepEqual(tag(xml, 'Hidden'), ['false']);
  assert.deepEqual(tag(xml, 'Command'), ['wscript.exe']);
  assert.deepEqual(tag(xml, 'Arguments'), ['&quot;C:\\h\\start-hidden.vbs&quot;']);
  assert.match(xml, /<Actions Context="Author">/);
});

test('B24: every interpolated value is XML-escaped', () => {
  const xml = taskXml({ home: 'C:\\R&D <x> \'q\'\\h', userId: 'D&D\\<o\'"x>' });
  assert.deepEqual(tag(xml, 'Arguments'), ['&quot;C:\\R&amp;D &lt;x&gt; &apos;q&apos;\\h\\start-hidden.vbs&quot;']);
  assert.deepEqual(tag(xml, 'UserId'), ['D&amp;D\\&lt;o&apos;&quot;x&gt;', 'D&amp;D\\&lt;o&apos;&quot;x&gt;']);
  assert.ok(!/&(?!amp;|lt;|gt;|quot;|apos;)/.test(xml));
});

test('B24: defaultUserId is DOMAIN\\user, falling back to the OS user name', () => {
  assert.equal(defaultUserId({ env: { USERDOMAIN: 'BOX', USERNAME: 'me' } }), 'BOX\\me');
  assert.equal(defaultUserId({ env: { USERNAME: 'me' }, userInfo: () => ({ username: 'osuser' }) }), 'osuser');
  assert.equal(defaultUserId({ env: { USERDOMAIN: 'BOX' }, userInfo: () => ({ username: 'osuser' }) }), 'osuser');
});

test('B24: installTask writes the vbs and a UTF-16LE (BOM) xml, then runs schtasks /XML; uninstall removes both', async () => {
  const home = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hr-task-')), 'R&D home');
  const calls = [];
  const exec = async (cmd, args) => { calls.push([cmd, ...args]); return { code: 0, stdout: '', stderr: '' }; };
  await installTask({ home, nodePath: 'C:\\n\\node.exe', cliPath: 'C:\\a\\cli.js', exec, userId: USER });
  const xmlPath = path.join(home, 'remote-for-herdr-task.xml');
  assert.deepEqual(calls, [
    ['schtasks', '/End', '/TN', 'herdr-remote'],
    ['schtasks', '/Delete', '/F', '/TN', 'herdr-remote'],
    ['schtasks', '/Create', '/F', '/TN', 'remote-for-herdr', '/XML', path.win32.resolve(xmlPath)],
  ]);
  const bytes = fs.readFileSync(xmlPath);
  assert.deepEqual([...bytes.subarray(0, 2)], [0xff, 0xfe]);
  const text = bytes.subarray(2).toString('utf16le');
  assert.ok(text.startsWith('<?xml version="1.0" encoding="UTF-16"?>'));
  assert.ok(text.includes('<UserId>DEMO-PC\\demo</UserId>'));
  assert.ok(text.includes('R&amp;D home'));
  const vbs = fs.readFileSync(path.join(home, 'start-hidden.vbs'));
  assert.deepEqual([...vbs.subarray(0, 2)], [0xff, 0xfe]); // wscript reads BOM-less files as ANSI
  assert.equal(vbs.subarray(2).toString('utf16le'), taskCommands({ nodePath: 'C:\\n\\node.exe', cliPath: 'C:\\a\\cli.js', home, userId: USER }).vbs);
  calls.length = 0;
  await uninstallTask({ home, cliPath: 'C:\\a\\cli.js', exec });
  assert.deepEqual(calls[1], ['schtasks', '/Delete', '/F', '/TN', 'remote-for-herdr']);
  assert.equal(fs.existsSync(xmlPath), false);
  assert.equal(fs.existsSync(path.join(home, 'start-hidden.vbs')), false);
});

test('lighter: uninstallTask ends the running launcher (/End, exit code ignored) before deleting the task', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-task-'));
  const calls = [];
  // /End fails when the task is not running: that must not stop the delete or the cleanup.
  const exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    return args[0] === '/End' ? { code: 1, stdout: '', stderr: 'not running' } : { code: 0, stdout: '', stderr: '' };
  };
  fs.writeFileSync(path.join(home, 'start-hidden.vbs'), 'x');
  await uninstallTask({ home, cliPath: 'C:\\a\\cli.js', exec });
  assert.deepEqual(calls, [
    ['schtasks', '/End', '/TN', 'remote-for-herdr'],
    ['schtasks', '/Delete', '/F', '/TN', 'remote-for-herdr'],
    ['schtasks', '/End', '/TN', 'herdr-remote'],
    ['schtasks', '/Delete', '/F', '/TN', 'herdr-remote'],
  ]);
  assert.equal(fs.existsSync(path.join(home, 'start-hidden.vbs')), false);
});

test('npm: taskCommands has run/query and the old herdr-remote task commands', () => {
  const t = taskCommands({ nodePath: 'C:\\n\\node.exe', cliPath: 'C:\\a\\cli.js', home: 'C:\\h', userId: USER });
  assert.deepEqual(t.run, ['schtasks', '/Run', '/TN', 'remote-for-herdr']);
  assert.deepEqual(t.query, ['schtasks', '/Query', '/TN', 'remote-for-herdr']);
  assert.deepEqual(t.legacyEnd, ['schtasks', '/End', '/TN', 'herdr-remote']);
  assert.deepEqual(t.legacyRemove, ['schtasks', '/Delete', '/F', '/TN', 'herdr-remote']);
});

// exec stub: failing commands are listed as "<verb> <task name>".
function fakeExec(failing = []) {
  const calls = [];
  const exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    const key = `${args[0]} ${args[args.indexOf('/TN') + 1]}`;
    return failing.includes(key) ? { code: 1, stdout: '', stderr: `ERROR: ${key}` } : { code: 0, stdout: '', stderr: '' };
  };
  return { exec, calls };
}
const verbAndName = (c) => `${c[1]} ${c[c.indexOf('/TN') + 1]}`;

test('npm: installTask removes the old herdr-remote task (errors ignored) and its launcher files, old folder included', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-task-'));
  const home = path.join(root, 'remote-for-herdr');
  const legacyHome = path.join(root, 'herdr-remote');
  fs.mkdirSync(home);
  fs.mkdirSync(legacyHome);
  fs.writeFileSync(path.join(home, 'herdr-remote-task.xml'), 'old'); // a moved folder brings the old files along
  fs.writeFileSync(path.join(legacyHome, 'herdr-remote-task.xml'), 'old');
  fs.writeFileSync(path.join(legacyHome, 'start-hidden.vbs'), 'old');
  fs.writeFileSync(path.join(legacyHome, 'config.json'), '{}');
  const { exec, calls } = fakeExec(['/End herdr-remote', '/Delete herdr-remote']); // no old task: still installs
  await installTask({ home, nodePath: 'C:\\n\\node.exe', cliPath: 'C:\\a\\cli.js', exec, userId: USER, legacyHome });
  assert.deepEqual(calls.map(verbAndName), ['/End herdr-remote', '/Delete herdr-remote', '/Create remote-for-herdr']);
  assert.equal(fs.existsSync(path.join(home, 'herdr-remote-task.xml')), false);
  assert.equal(fs.existsSync(path.join(legacyHome, 'herdr-remote-task.xml')), false);
  assert.equal(fs.existsSync(path.join(legacyHome, 'start-hidden.vbs')), false);
  assert.equal(fs.existsSync(path.join(legacyHome, 'config.json')), true); // only launcher files go
  assert.equal(fs.existsSync(path.join(home, 'start-hidden.vbs')), true);
  assert.equal(fs.existsSync(path.join(home, 'remote-for-herdr-task.xml')), true);
});

test('npm: uninstallTask removes both task names; fails only when neither existed', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hr-task-'));
  // Only the old task exists: still a success.
  let f = fakeExec(['/Delete remote-for-herdr']);
  await uninstallTask({ home, cliPath: 'C:\\a\\cli.js', exec: f.exec });
  assert.deepEqual(f.calls.map(verbAndName), ['/End remote-for-herdr', '/Delete remote-for-herdr', '/End herdr-remote', '/Delete herdr-remote']);
  // Neither exists: the new name's error is reported.
  f = fakeExec(['/Delete remote-for-herdr', '/Delete herdr-remote']);
  await assert.rejects(uninstallTask({ home, cliPath: 'C:\\a\\cli.js', exec: f.exec }), /schtasks delete failed: ERROR: \/Delete remote-for-herdr/);
});

test('npm: installTask refuses a cli inside the npx cache, before touching anything', async () => {
  const home = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hr-task-')), 'h');
  const { exec, calls } = fakeExec();
  const cliPath = 'C:\\Users\\me\\AppData\\Local\\npm-cache\\_npx\\1a2b3c\\node_modules\\remote-for-herdr\\src\\cli.js';
  await assert.rejects(
    installTask({ home, cliPath, exec, userId: USER }),
    // Not "setup" (it refuses while the server started from npx runs): install-task, then restart.
    (e) => e.code === 'NPX_CACHE'
      && e.message.endsWith('\n  npm i -g remote-for-herdr\n  remote-for-herdr install-task\n  remote-for-herdr restart'),
  );
  assert.deepEqual(calls, []);
  assert.equal(fs.existsSync(home), false);
});

test('npm: isNpxCachePath', () => {
  assert.equal(isNpxCachePath('C:\\Users\\me\\AppData\\Local\\npm-cache\\_npx\\1a2b\\node_modules\\remote-for-herdr\\src\\cli.js'), true);
  assert.equal(isNpxCachePath('/home/me/.npm/_npx/1a2b/node_modules/remote-for-herdr/src/cli.js'), true);
  assert.equal(isNpxCachePath('C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\remote-for-herdr\\src\\cli.js'), false);
  assert.equal(isNpxCachePath('C:\\code\\remote-for-herdr\\src\\cli.js'), false);
  assert.equal(isNpxCachePath('C:\\code\\my_npx_tools\\cli.js'), false);
  assert.equal(isNpxCachePath(undefined), false);
});

test('npm: isTaskInstalled / runTask use schtasks /Query and /Run on the new name', async () => {
  let f = fakeExec();
  assert.equal(await isTaskInstalled({ exec: f.exec }), true);
  assert.deepEqual(await runTask({ exec: f.exec }), { ok: true, message: '' });
  assert.deepEqual(f.calls, [['schtasks', '/Query', '/TN', 'remote-for-herdr'], ['schtasks', '/Run', '/TN', 'remote-for-herdr']]);
  f = fakeExec(['/Query remote-for-herdr', '/Run remote-for-herdr']);
  assert.equal(await isTaskInstalled({ exec: f.exec }), false);
  assert.deepEqual(await runTask({ exec: f.exec }), { ok: false, message: 'ERROR: /Run remote-for-herdr' });
});
