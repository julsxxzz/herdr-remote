import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taskCommands } from '../src/startup-task.js';

test('taskCommands: argv arrays and vbs content', () => {
  const t = taskCommands({ nodePath: 'C:\\node\\node.exe', cliPath: 'C:\\app\\src\\cli.js', home: 'C:\\h' });
  assert.equal(t.vbs, 'CreateObject("WScript.Shell").Run """C:\\node\\node.exe"" ""C:\\app\\src\\cli.js"" start", 0, False\n');
  assert.deepEqual(t.create, [
    'schtasks', '/Create', '/F', '/SC', 'ONLOGON', '/RL', 'LIMITED', '/TN', 'herdr-remote',
    '/TR', 'wscript.exe "C:\\h\\start-hidden.vbs"',
  ]);
  assert.deepEqual(t.remove, ['schtasks', '/Delete', '/F', '/TN', 'herdr-remote']);
});

test('taskCommands: paths with spaces stay quoted', () => {
  const t = taskCommands({ nodePath: 'C:\\Program Files\\nodejs\\node.exe', cliPath: 'C:\\My App\\cli.js', home: 'C:\\Users\\A B\\herdr' });
  assert.ok(t.vbs.includes('"""C:\\Program Files\\nodejs\\node.exe"" ""C:\\My App\\cli.js"" start"'));
  assert.equal(t.create.at(-1), 'wscript.exe "C:\\Users\\A B\\herdr\\start-hidden.vbs"');
});
