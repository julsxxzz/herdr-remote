import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const TASK_NAME = 'herdr-remote';
const VBS_NAME = 'start-hidden.vbs';
const XML_NAME = 'herdr-remote-task.xml';

const xmlEscape = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]
));

// The Windows account the task belongs to, computed on the user's machine at install time.
export function defaultUserId({ env = process.env, userInfo = os.userInfo } = {}) {
  if (env.USERDOMAIN && env.USERNAME) return `${env.USERDOMAIN}\\${env.USERNAME}`;
  return userInfo().username;
}

const vbsPathFor = (home) => path.win32.join(path.win32.resolve(home), VBS_NAME);

// Task Scheduler definition (schema 1.2). An XML task instead of /SC ONLOGON flags so the trigger is
// limited to this user's logon, it runs without elevation, and it is never stopped after the default
// 72 h time limit or on battery.
export function taskXml({ home, userId }) {
  const user = xmlEscape(userId);
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>herdr-remote (start at log on)</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${user}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${user}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>wscript.exe</Command>
      <Arguments>${xmlEscape(`"${vbsPathFor(home)}"`)}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

export function taskCommands({ nodePath, cliPath, home, userId = defaultUserId() }) {
  const absHome = path.win32.resolve(home);
  const xmlPath = path.win32.join(absHome, XML_NAME);
  return {
    vbs: `CreateObject("WScript.Shell").Run """${nodePath}"" ""${cliPath}"" start --home ""${absHome}""", 0, False\n`,
    vbsPath: vbsPathFor(absHome),
    xml: taskXml({ home: absHome, userId }),
    xmlPath,
    create: ['schtasks', '/Create', '/F', '/TN', TASK_NAME, '/XML', xmlPath],
    remove: ['schtasks', '/Delete', '/F', '/TN', TASK_NAME],
  };
}

// Runs argv without a shell. Never rejects: a missing binary resolves with code 127.
export function runCommand(cmd, args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      resolve({ code: 127, stdout: '', stderr: String(err.message) });
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => resolve({ code: 127, stdout, stderr: stderr + err.message }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

const utf16le = (text) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);

export async function installTask({ home, nodePath = process.execPath, cliPath, exec = runCommand, userId }) {
  const t = taskCommands({ nodePath, cliPath, home, userId });
  fs.mkdirSync(home, { recursive: true });
  // Both as UTF-16LE with BOM: schtasks /XML requires it, and wscript would read a BOM-less .vbs in
  // the ANSI codepage (breaking a non-ASCII home or node path).
  fs.writeFileSync(path.join(home, VBS_NAME), utf16le(t.vbs));
  fs.writeFileSync(path.join(home, XML_NAME), utf16le(t.xml));
  const r = await exec(t.create[0], t.create.slice(1));
  if (r.code !== 0) throw new Error(`schtasks create failed: ${(r.stderr || r.stdout).trim()}`);
}

export async function uninstallTask({ home, nodePath = process.execPath, cliPath, exec = runCommand }) {
  const t = taskCommands({ nodePath, cliPath, home, userId: '' });
  const r = await exec(t.remove[0], t.remove.slice(1));
  fs.rmSync(path.join(home, VBS_NAME), { force: true });
  fs.rmSync(path.join(home, XML_NAME), { force: true });
  if (r.code !== 0) throw new Error(`schtasks delete failed: ${(r.stderr || r.stdout).trim()}`);
}
