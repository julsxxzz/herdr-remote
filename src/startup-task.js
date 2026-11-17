import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { SERVER_NODE_FLAGS, EXIT_SETUP_REQUIRED } from './supervisor.js';

export const TASK_NAME = 'remote-for-herdr';
const VBS_NAME = 'start-hidden.vbs';
const STOP_NAME = 'server.stop'; // the stop request file, see stopRunning in supervisor.js
const XML_NAME = 'remote-for-herdr-task.xml';
// The task and its XML file as herdr-remote (the project's old name) created them.
export const LEGACY_TASK_NAME = 'herdr-remote';
const LEGACY_XML_NAME = 'herdr-remote-task.xml';

// True when cliPath lies in npx's temporary package cache (<npm-cache>\_npx\<hash>\...), which npm
// may delete at any time: a start-at-login task pointing there would break later.
export const isNpxCachePath = (p) => /[\\/]_npx[\\/]/i.test(String(p ?? ''));

export const NPX_CACHE_HINT = 'remote-for-herdr is running from npx\'s temporary cache, which npm may delete, '
  + 'so start-at-login is not installed from here. To keep it, install it and add the task (your setup is kept; '
  + 'restart stops the copy started from npx and starts it through the task):\n'
  + '  npm i -g remote-for-herdr\n'
  + '  remote-for-herdr install-task\n'
  + '  remote-for-herdr restart';

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
// 72 h time limit or on battery. There is no supervisor process at login (it cost a whole Node
// process): the task's launcher runs the server itself and runs it again after a crash (launcherVbs);
// <RestartOnFailure> is only a backstop in case the launcher itself fails.
export function taskXml({ home, userId }) {
  const user = xmlEscape(userId);
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>remote-for-herdr (start at log on)</Description>
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
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
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

// The hidden launcher, and the server's restarter at login (there is no supervisor process there). It
// waits for the server and runs it again after a crash or a kill: 1 s, then 2, 4, 8, 16, 30 s between
// tries, back to 1 s after a run that lasted a minute. Exit 0 (stopped with "remote-for-herdr stop") and
// 78 (needs setup, port in use, already running: a restart would not help) end it, and so does a
// "remote-for-herdr stop" made during the pause (it leaves <home>\server.stop, checked before each
// relaunch; not before the first run, where a leftover file is cleared by the server's claim). If
// node cannot be started at all (moved or upgraded), it quits with 1 instead of showing a WSH error
// box. The loop lives here because Task Scheduler's "restart on failure" is not reliably triggered by
// a non-zero exit code; the task's <RestartOnFailure> is only a backstop for the launcher itself.
function launcherVbs({ nodePath, cliPath, absHome }) {
  const flags = SERVER_NODE_FLAGS.map((f) => `${f} `).join('');
  const cmd = `""${nodePath}"" ${flags}""${cliPath}"" start --foreground --log --home ""${absHome}""`;
  const stopFile = path.win32.join(absHome, STOP_NAME);
  return [
    'Set sh = CreateObject("WScript.Shell")',
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    `stopFile = "${stopFile}"`,
    'pause = 1',
    'Do',
    '  started = Now',
    '  On Error Resume Next',
    `  rc = sh.Run("${cmd}", 0, True)`,
    '  If Err.Number <> 0 Then WScript.Quit 1',
    '  On Error GoTo 0',
    `  If rc = 0 Or rc = ${EXIT_SETUP_REQUIRED} Then WScript.Quit 0`,
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
  ].join('\r\n');
}

export function taskCommands({ nodePath, cliPath, home, userId = defaultUserId() }) {
  const absHome = path.win32.resolve(home);
  const xmlPath = path.win32.join(absHome, XML_NAME);
  return {
    vbs: launcherVbs({ nodePath, cliPath, absHome }),
    vbsPath: vbsPathFor(absHome),
    xml: taskXml({ home: absHome, userId }),
    xmlPath,
    create: ['schtasks', '/Create', '/F', '/TN', TASK_NAME, '/XML', xmlPath],
    end: ['schtasks', '/End', '/TN', TASK_NAME],
    remove: ['schtasks', '/Delete', '/F', '/TN', TASK_NAME],
    run: ['schtasks', '/Run', '/TN', TASK_NAME],
    query: ['schtasks', '/Query', '/TN', TASK_NAME],
    legacyEnd: ['schtasks', '/End', '/TN', LEGACY_TASK_NAME],
    legacyRemove: ['schtasks', '/Delete', '/F', '/TN', LEGACY_TASK_NAME],
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

// Removes what herdr-remote (the old name) installed: its task (its launcher ended first) and its
// launcher files in each given folder. Errors are ignored (usually: there is no old task).
async function removeLegacyTask({ t, exec, dirs }) {
  await exec(t.legacyEnd[0], t.legacyEnd.slice(1));
  const r = await exec(t.legacyRemove[0], t.legacyRemove.slice(1));
  for (const dir of dirs.filter(Boolean)) {
    fs.rmSync(path.join(dir, LEGACY_XML_NAME), { force: true });
  }
  return r.code === 0;
}

// legacyHome: the old herdr-remote config folder, if it still exists (its launcher files are removed).
export async function installTask({
  home, nodePath = process.execPath, cliPath, exec = runCommand, userId, legacyHome = null,
}) {
  if (isNpxCachePath(cliPath)) throw Object.assign(new Error(NPX_CACHE_HINT), { code: 'NPX_CACHE' });
  const t = taskCommands({ nodePath, cliPath, home, userId });
  fs.mkdirSync(home, { recursive: true });
  await removeLegacyTask({ t, exec, dirs: [home, legacyHome] });
  if (legacyHome && path.resolve(legacyHome) !== path.resolve(home)) {
    fs.rmSync(path.join(legacyHome, VBS_NAME), { force: true });
  }
  // Both as UTF-16LE with BOM: schtasks /XML requires it, and wscript would read a BOM-less .vbs in
  // the ANSI codepage (breaking a non-ASCII home or node path).
  fs.writeFileSync(path.join(home, VBS_NAME), utf16le(t.vbs));
  fs.writeFileSync(path.join(home, XML_NAME), utf16le(t.xml));
  const r = await exec(t.create[0], t.create.slice(1));
  if (r.code !== 0) throw new Error(`schtasks create failed: ${(r.stderr || r.stdout).trim()}`);
}

// Removes the task under both names (remote-for-herdr and the old herdr-remote). Fails only when
// neither could be deleted.
export async function uninstallTask({ home, nodePath = process.execPath, cliPath, exec = runCommand, legacyHome = null }) {
  const t = taskCommands({ nodePath, cliPath, home, userId: '' });
  // End the running launcher first, so no hidden restarter outlives the task. It ends only the
  // launcher: a running server stays up until "remote-for-herdr stop". Fails when not running: ignored.
  await exec(t.end[0], t.end.slice(1));
  const r = await exec(t.remove[0], t.remove.slice(1));
  const legacyRemoved = await removeLegacyTask({ t, exec, dirs: [home, legacyHome] });
  fs.rmSync(path.join(home, VBS_NAME), { force: true });
  fs.rmSync(path.join(home, XML_NAME), { force: true });
  if (legacyHome && path.resolve(legacyHome) !== path.resolve(home)) {
    fs.rmSync(path.join(legacyHome, VBS_NAME), { force: true });
  }
  if (r.code !== 0 && !legacyRemoved) throw new Error(`schtasks delete failed: ${(r.stderr || r.stdout).trim()}`);
}

// True when the start-at-login task exists (schtasks /Query succeeds).
export async function isTaskInstalled({ exec = runCommand } = {}) {
  const r = await exec('schtasks', ['/Query', '/TN', TASK_NAME]);
  return r.code === 0;
}

// Starts the start-at-login task now (its launcher runs the server). Resolves { ok, message }.
export async function runTask({ exec = runCommand } = {}) {
  const r = await exec('schtasks', ['/Run', '/TN', TASK_NAME]);
  return { ok: r.code === 0, message: (r.stderr || r.stdout || '').trim() };
}
