#!/usr/bin/env node
import readline from 'node:readline';
import { Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { configDir } from './config.js';
import { startServer } from './main.js';
import { runSetup } from './setup.js';
import { superviseServer, EXIT_SETUP_REQUIRED } from './supervisor.js';
import { installTask, uninstallTask } from './startup-task.js';

const CLI_PATH = fileURLToPath(import.meta.url);

const HELP = `herdr-remote - remote web view for Herdr terminals

Usage:
  herdr-remote start [--foreground] [--home <dir>]   run the server (restarts on crash unless --foreground)
  herdr-remote setup [--proxy] [--home <dir>]        interactive setup
  herdr-remote install-task [--home <dir>]           start at Windows login (Task Scheduler)
  herdr-remote uninstall-task [--home <dir>]         remove the login task
  herdr-remote --help
`;

// Line prompt; with {secret:true} the typed characters are not echoed.
// Lines are queued so piped input (EOF right after the last line) still works.
function createPrompt() {
  let muted = false;
  const output = new Writable({
    write(chunk, _enc, cb) { if (!muted) process.stdout.write(chunk); cb(); },
  });
  const rl = readline.createInterface({ input: process.stdin, output, terminal: Boolean(process.stdin.isTTY) });
  const queue = [];
  let waiter = null;
  let closed = false;
  rl.on('line', (line) => {
    if (waiter) { const w = waiter; waiter = null; w.resolve(line); } else queue.push(line);
  });
  rl.on('close', () => {
    closed = true;
    if (waiter) { const w = waiter; waiter = null; w.reject(new Error('Input closed before setup finished.')); }
  });
  const prompt = (question, { secret = false } = {}) => new Promise((resolve, reject) => {
    process.stdout.write(question);
    muted = secret;
    const settle = (fn) => (v) => { muted = false; if (secret) process.stdout.write('\n'); fn(v); };
    if (queue.length) return settle(resolve)(queue.shift());
    if (closed) return settle(reject)(new Error('Input closed before setup finished.'));
    waiter = { resolve: settle(resolve), reject: settle(reject) };
  });
  return { prompt, close: () => rl.close() };
}

async function foreground(home) {
  let running;
  try {
    running = await startServer({ home, log: console });
  } catch (err) {
    console.error(err.message);
    process.exit(String(err.message).startsWith('Run "npm run setup"') ? EXIT_SETUP_REQUIRED : 1);
  }
  const shutdown = async () => { await running.stop(); process.exit(0); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

async function main(argv) {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(HELP);
    return;
  }
  const { values } = parseArgs({
    args: rest,
    options: { foreground: { type: 'boolean' }, proxy: { type: 'boolean' }, home: { type: 'string' } },
  });
  const home = configDir({ home: values.home });

  switch (command) {
    case 'start': {
      if (values.foreground) return foreground(home);
      const sup = superviseServer({ home });
      const quit = () => sup.stop();
      process.once('SIGINT', quit);
      process.once('SIGTERM', quit);
      const r = await sup.done;
      if (r.reason === 'setup-required') {
        console.error('herdr-remote needs setup. Run "npm run setup" (see logs/server.log).');
        process.exitCode = EXIT_SETUP_REQUIRED;
      }
      return;
    }
    case 'setup': {
      const p = createPrompt();
      try {
        await runSetup({ home: values.home, proxy: values.proxy, prompt: p.prompt, log: console.log });
      } finally {
        p.close();
      }
      return;
    }
    case 'install-task':
      await installTask({ home, cliPath: CLI_PATH });
      console.log('Installed the "herdr-remote" start-at-login task.');
      return;
    case 'uninstall-task':
      await uninstallTask({ home, cliPath: CLI_PATH });
      console.log('Removed the "herdr-remote" start-at-login task.');
      return;
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
      process.exitCode = 2;
  }
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err.message);
  process.exit(1);
});
