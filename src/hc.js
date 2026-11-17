import { spawn } from 'node:child_process';

const ADDRESS_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/;
const KEY_RE = /^[a-z0-9][a-z0-9+_-]{0,19}$/i;

export const isValidAddress = (s) => typeof s === 'string' && ADDRESS_RE.test(s);
export const isValidKeyName = (s) => typeof s === 'string' && KEY_RE.test(s);

function assertAddress(address) {
  if (!isValidAddress(address)) throw new TypeError('invalid terminal address');
}

function errorMessage({ code, stderr }) {
  const text = stderr.trim();
  try {
    const message = JSON.parse(text)?.error?.message;
    if (typeof message === 'string' && message) return message;
  } catch {
    // not JSON; fall through to plain text
  }
  return text || `hc exited with code ${code}`;
}

export function createHc({ command = 'hc', prefixArgs = [], env } = {}) {
  // Always an argv array, never a shell.
  const spawnHc = (args, stdio) =>
    spawn(command, [...prefixArgs, ...args], { env, stdio, windowsHide: true });

  function run(args, { timeoutMs = 15000 } = {}) {
    return new Promise((resolve, reject) => {
      const child = spawnHc(args, ['ignore', 'pipe', 'pipe']);
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      child.stdout.setEncoding('utf8').on('data', (d) => (stdout += d));
      child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeoutMs);
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code: timedOut ? -1 : (code ?? -1), stdout, stderr });
      });
    });
  }

  async function runJson(args) {
    const r = await run(args);
    if (r.code !== 0) throw new Error(errorMessage(r));
    return JSON.parse(r.stdout);
  }

  async function runAction(args) {
    const r = await run(args);
    return r.code === 0 ? { ok: true } : { ok: false, error: errorMessage(r) };
  }

  return {
    run,
    async ls() {
      return (await runJson(['ls', '--json'])).terminals;
    },
    async get(address) {
      assertAddress(address);
      return runJson(['get', address, '--json']);
    },
    async send(address, text) {
      assertAddress(address);
      if (typeof text !== 'string') throw new TypeError('text must be a string');
      return runAction(['send', address, '--', text]);
    },
    async keys(address, names) {
      assertAddress(address);
      if (!Array.isArray(names) || names.length === 0 || !names.every(isValidKeyName)) {
        throw new TypeError('invalid key names');
      }
      return runAction(['keys', address, '--', ...names]);
    },
    observe(address, { history = 0 } = {}) {
      assertAddress(address);
      if (!Number.isInteger(history) || history < 0) throw new TypeError('invalid history');
      return spawnHc(['attach', address, '--observe', '--history', String(history)], ['ignore', 'pipe', 'pipe']);
    },
    events() {
      return spawnHc(['events', '--json'], ['ignore', 'pipe', 'pipe']);
    },
  };
}
