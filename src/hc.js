import { spawn } from 'node:child_process';

const ADDRESS_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/;
const KEY_RE = /^[a-z0-9][a-z0-9+_-]{0,19}$/i;

// Terminal identity vars: if inherited, hc treats our send/keys as agent-to-agent messages.
export const HC_IDENTITY_ENV = ['HC_TERMINAL_ID', 'HC_TERMINAL_SOCKET', 'HC_SCOPE'];

function cleanEnv(env = process.env) {
  const out = { ...env };
  for (const k of HC_IDENTITY_ENV) delete out[k];
  return out;
}

export const isValidAddress = (s) => typeof s === 'string' && ADDRESS_RE.test(s);
export const isValidKeyName = (s) => typeof s === 'string' && KEY_RE.test(s);

function assertAddress(address) {
  if (!isValidAddress(address)) throw new TypeError('invalid terminal address');
}

// hc's JSON error kind (e.g. "blocked"), 'timeout' when we killed it, else null.
function errorKind({ stderr, timedOut }) {
  if (timedOut) return 'timeout';
  try {
    const kind = JSON.parse(stderr.trim())?.error?.kind;
    return typeof kind === 'string' && kind ? kind : null;
  } catch {
    return null;
  }
}

function errorMessage({ code, stderr, timedOut }) {
  if (timedOut) return 'hc timed out (the command may or may not have been delivered)';
  const text = stderr.trim();
  try {
    const message = JSON.parse(text)?.error?.message;
    if (typeof message === 'string' && message) return message;
  } catch {
    // not JSON; fall through to plain text
  }
  return text || `hc exited with code ${code}`;
}

export function createHc({
  command = 'hc', prefixArgs = [], env, timeoutMs: defaultTimeoutMs = 15000,
  killGraceMs = 2000, spawnImpl = spawn, // overridable for tests
} = {}) {
  // Always an argv array, never a shell.
  const spawnHc = (args, stdio, signal) =>
    spawnImpl(command, [...prefixArgs, ...args], { env: cleanEnv(env), stdio, windowsHide: true, signal });

  // `signal` aborts the command: the child is killed and the promise rejects with an AbortError.
  function run(args, { timeoutMs = defaultTimeoutMs, signal } = {}) {
    return new Promise((resolve, reject) => {
      const child = spawnHc(args, ['ignore', 'pipe', 'pipe'], signal);
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;
      let graceTimer = null;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(graceTimer);
        fn(value);
      };
      const result = (code) => ({ code: timedOut ? -1 : (code ?? -1), stdout, stderr, timedOut });
      child.stdout.setEncoding('utf8').on('data', (d) => (stdout += d));
      child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
        // A grandchild holding the pipes can keep 'close' from ever firing: don't wait forever.
        graceTimer = setTimeout(() => finish(resolve, result(-1)), killGraceMs);
      }, timeoutMs);
      child.on('error', (err) => finish(reject, err));
      child.on('close', (code) => finish(resolve, result(code)));
    });
  }

  async function runJson(args, opts) {
    const r = await run(args, opts);
    if (r.code !== 0) throw new Error(errorMessage(r));
    return JSON.parse(r.stdout);
  }

  async function runAction(args) {
    const r = await run(args);
    return r.code === 0 ? { ok: true } : { ok: false, error: errorMessage(r), kind: errorKind(r) };
  }

  return {
    run,
    async ls({ signal } = {}) {
      return (await runJson(['ls', '--json'], { signal }))?.terminals ?? [];
    },
    async get(address) {
      assertAddress(address);
      return runJson(['get', address, '--json']);
    },
    // force: also type while the terminal shows a dialog (hc refuses that by default).
    async send(address, text, { force = false } = {}) {
      assertAddress(address);
      if (typeof text !== 'string') throw new TypeError('text must be a string');
      return runAction(['send', address, ...(force === true ? ['--force'] : []), '--', text]);
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
