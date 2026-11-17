import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { taskCommands, taskXml, defaultUserId, installTask, uninstallTask } from '../src/startup-task.js';

const USER = 'DEMO-PC\\demo';

test('taskCommands: argv arrays and vbs content', () => {
  const t = taskCommands({ nodePath: 'C:\\node\\node.exe', cliPath: 'C:\\app\\src\\cli.js', home: 'C:\\h', userId: USER });
  assert.equal(t.vbs, 'CreateObject("WScript.Shell").Run """C:\\node\\node.exe"" ""C:\\app\\src\\cli.js"" start --home ""C:\\h""", 0, False\n');
  assert.equal(t.vbsPath, 'C:\\h\\start-hidden.vbs');
  assert.equal(t.xmlPath, 'C:\\h\\herdr-remote-task.xml');
  assert.deepEqual(t.create, ['schtasks', '/Create', '/F', '/TN', 'herdr-remote', '/XML', 'C:\\h\\herdr-remote-task.xml']);
  assert.deepEqual(t.remove, ['schtasks', '/Delete', '/F', '/TN', 'herdr-remote']);
  assert.equal(t.xml, taskXml({ home: 'C:\\h', userId: USER }));
});

test('taskCommands: paths with spaces stay quoted', () => {
  const t = taskCommands({ nodePath: 'C:\\Program Files\\nodejs\\node.exe', cliPath: 'C:\\My App\\cli.js', home: 'C:\\Users\\A B\\herdr', userId: USER });
  assert.ok(t.vbs.includes('"""C:\\Program Files\\nodejs\\node.exe"" ""C:\\My App\\cli.js"" start --home ""C:\\Users\\A B\\herdr"""'));
  assert.ok(t.xml.includes('<Arguments>&quot;C:\\Users\\A B\\herdr\\start-hidden.vbs&quot;</Arguments>'));
});

test('taskCommands: home is made absolute', () => {
  const t = taskCommands({ nodePath: 'C:\\n\\node.exe', cliPath: 'C:\\a\\cli.js', home: 'C:\\x\\y\\..\\h', userId: USER });
  assert.ok(t.vbs.includes('--home ""C:\\x\\h""'));
  assert.equal(t.vbsPath, 'C:\\x\\h\\start-hidden.vbs');
});

const tag = (xml, name) => [...xml.matchAll(new RegExp(`<${name}>([^<]*)</${name}>`, 'g'))].map((m) => m[1]);

test('B24: taskXml triggers on this user\'s logon only and never times out', () => {
  const xml = taskXml({ home: 'C:\\h', userId: USER });
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-16"\?>/);
  assert.match(xml, /<Task version="1\.2" xmlns="http:\/\/schemas\.microsoft\.com\/windows\/2004\/02\/mit\/task">/);
  assert.match(xml, /<LogonTrigger>\s*<Enabled>true<\/Enabled>\s*<UserId>DEMO-PC\\demo<\/UserId>\s*<\/LogonTrigger>/);
  assert.match(xml, /<Principal id="Author">\s*<UserId>DEMO-PC\\demo<\/UserId>\s*<LogonType>InteractiveToken<\/LogonType>\s*<RunLevel>LeastPrivilege<\/RunLevel>/);
  assert.deepEqual(tag(xml, 'Description'), ['herdr-remote (start at log on)']);
  assert.deepEqual(tag(xml, 'MultipleInstancesPolicy'), ['IgnoreNew']);
  assert.deepEqual(tag(xml, 'DisallowStartIfOnBatteries'), ['false']);
  assert.deepEqual(tag(xml, 'StopIfGoingOnBatteries'), ['false']);
  assert.deepEqual(tag(xml, 'ExecutionTimeLimit'), ['PT0S']);
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
  const xmlPath = path.join(home, 'herdr-remote-task.xml');
  assert.deepEqual(calls, [['schtasks', '/Create', '/F', '/TN', 'herdr-remote', '/XML', path.win32.resolve(xmlPath)]]);
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
  assert.deepEqual(calls.at(-1), ['schtasks', '/Delete', '/F', '/TN', 'herdr-remote']);
  assert.equal(fs.existsSync(xmlPath), false);
  assert.equal(fs.existsSync(path.join(home, 'start-hidden.vbs')), false);
});
