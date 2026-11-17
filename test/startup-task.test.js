import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { taskCommands, taskXml, defaultUserId, installTask, uninstallTask } from '../src/startup-task.js';
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
  assert.deepEqual(calls, [['schtasks', '/Create', '/F', '/TN', 'remote-for-herdr', '/XML', path.win32.resolve(xmlPath)]]);
  const bytes = fs.readFileSync(xmlPath);
  assert.deepEqual([...bytes.subarray(0, 2)], [0xff, 0xfe]);
  const text = bytes.subarray(2).toString('utf16le');
  assert.ok(text.startsWith('<?xml version="1.0" encoding="UTF-16"?>'));
  assert.ok(text.includes('<UserId>DEMO-PC\\demo</UserId>'));
  assert.ok(text.includes('R&amp;D home'));
  const vbs = fs.readFileSync(path.join(home, 'start-hidden.vbs'));
  assert.deepEqual([...vbs.subarray(0, 2)], [0xff, 0xfe]); // wscript reads BOM-less files as ANSI
  assert.equal(vbs.subarray(2).toString('utf16le'), taskCommands({ nodePath: 'C:\\n\\node.exe', cliPath: 'C:\\a\\cli.js', home, userId: USER }).vbs);
  await uninstallTask({ home, cliPath: 'C:\\a\\cli.js', exec });
  assert.deepEqual(calls.at(-1), ['schtasks', '/Delete', '/F', '/TN', 'remote-for-herdr']);
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
  ]);
  assert.equal(fs.existsSync(path.join(home, 'start-hidden.vbs')), false);
});
