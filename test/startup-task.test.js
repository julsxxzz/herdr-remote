import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taskCommands } from '../src/startup-task.js';

test('taskCommands: argv arrays and vbs content', () => {
  const t = taskCommands({ nodePath: 'C:\\node\\node.exe', cliPath: 'C:\\app\\src\\cli.js', home: 'C:\\h' });
  assert.equal(t.vbs, 'CreateObject("WScript.Shell").Run """C:\\node\\node.exe"" ""C:\\app\\src\\cli.js"" start --home ""C:\\h""", 0, False\n');
  assert.deepEqual(t.create, [
    'schtasks', '/Create', '/F', '/SC', 'ONLOGON', '/RL', 'LIMITED', '/TN', 'herdr-remote',
    '/TR', 'wscript.exe "C:\\h\\start-hidden.vbs"',
  ]);
  assert.deepEqual(t.remove, ['schtasks', '/Delete', '/F', '/TN', 'herdr-remote']);
});

test('taskCommands: paths with spaces stay quoted', () => {
  const t = taskCommands({ nodePath: 'C:\\Program Files\\nodejs\\node.exe', cliPath: 'C:\\My App\\cli.js', home: 'C:\\Users\\A B\\herdr' });
  assert.ok(t.vbs.includes('"""C:\\Program Files\\nodejs\\node.exe"" ""C:\\My App\\cli.js"" start --home ""C:\\Users\\A B\\herdr"""'));
  assert.equal(t.create.at(-1), 'wscript.exe "C:\\Users\\A B\\herdr\\start-hidden.vbs"');
});

test('taskCommands: home is made absolute', () => {
  const t = taskCommands({ nodePath: 'C:\\n\\node.exe', cliPath: 'C:\\a\\cli.js', home: 'C:\\x\\y\\..\\h' });
  assert.ok(t.vbs.includes('--home ""C:\\x\\h""'));
  assert.equal(t.create.at(-1), 'wscript.exe "C:\\x\\h\\start-hidden.vbs"');
});
