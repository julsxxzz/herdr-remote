import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const TASK_NAME = 'herdr-remote';

export function taskCommands({ nodePath, cliPath, home }) {
  const absHome = path.win32.resolve(home);
  const vbsPath = path.win32.join(absHome, 'start-hidden.vbs');
  return {
    vbs: `CreateObject("WScript.Shell").Run """${nodePath}"" ""${cliPath}"" start --home ""${absHome}""", 0, False\n`,
    create: [
      'schtasks', '/Create', '/F', '/SC', 'ONLOGON', '/RL', 'LIMITED', '/TN', TASK_NAME,
      '/TR', `wscript.exe "${vbsPath}"`,
    ],
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

export async function installTask({ home, nodePath = process.execPath, cliPath, exec = runCommand }) {
  const t = taskCommands({ nodePath, cliPath, home });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'start-hidden.vbs'), t.vbs);
  const r = await exec(t.create[0], t.create.slice(1));
  if (r.code !== 0) throw new Error(`schtasks create failed: ${(r.stderr || r.stdout).trim()}`);
}

export async function uninstallTask({ home, nodePath = process.execPath, cliPath, exec = runCommand }) {
  const t = taskCommands({ nodePath, cliPath, home });
  const r = await exec(t.remove[0], t.remove.slice(1));
  fs.rmSync(path.join(home, 'start-hidden.vbs'), { force: true });
  if (r.code !== 0) throw new Error(`schtasks delete failed: ${(r.stderr || r.stdout).trim()}`);
}
