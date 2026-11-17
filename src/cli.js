#!/usr/bin/env node
import path from 'node:path';
import readline from 'node:readline';
import { Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { configDir } from './config.js';
import { startServer } from './main.js';
import { runSetup } from './setup.js';
import {
  superviseServer, stopRunning, claimPidFile, alreadyRunningMessage, createLog, EXIT_SETUP_REQUIRED,
} from './supervisor.js';
import { installTask, uninstallTask } from './startup-task.js';

const CLI_PATH = fileURLToPath(import.meta.url);

const HELP = `remote-for-herdr - remote web view for Herdr terminals

Usage:
  remote-for-herdr start [--foreground [--log]] [--home <dir>]
                                                     run the server (restarts on crash unless --foreground;
                                                     --log writes its output to <home>\\logs\\server.log)
  remote-for-herdr stop [--home <dir>]                   stop the running server
  remote-for-herdr setup [--proxy] [--home <dir>]        interactive setup (stop the server first)
  remote-for-herdr install-task [--home <dir>]           start at Windows login (Task Scheduler)
  remote-for-herdr uninstall-task [--home <dir>]         remove the login task
  remote-for-herdr --help
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

// Sends everything the process prints (fatal errors included) to <home>/logs/server.log. For the
// start-at-login task, whose hidden console nobody can read.
function logToFile(home) {
  const log = createLog(path.join(home, 'logs'));
  const write = (text) => { try { log.write(text); } catch { /* never crash over the log */ } };
  const sink = (chunk, encoding, cb) => {
    write(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
    (typeof encoding === 'function' ? encoding : cb)?.();
    return true;
  };
  process.stdout.write = sink;
  process.stderr.write = sink;
  process.on('uncaughtExceptionMonitor', (err) => write(`${err?.stack ?? err}\n`));
  write(`[server ${new Date().toISOString()}] starting (pid ${process.pid})\n`);
}

async function foreground(home, { log = false } = {}) {
  if (log) logToFile(home);
  // Under the supervisor (IPC channel present) the supervisor owns server.pid and stop requests;
  // a standalone --foreground run owns them itself so "remote-for-herdr stop" works for it too.
  const supervised = typeof process.send === 'function';
  let shutdown = null;
  let stopRequested = false; // a stop request that arrived before the server was up
  if (!supervised) {
    const claim = await claimPidFile(home, {
      onStopRequest: () => (shutdown ? shutdown() : (stopRequested = true)),
      log: (m) => console.log(m),
    });
    if (!claim.ok) {
      console.error(alreadyRunningMessage(claim.pid, home));
      process.exit(EXIT_SETUP_REQUIRED);
    }
    process.on('exit', claim.release);
  }
  let running;
  try {
    running = await startServer({ home, log: console });
  } catch (err) {
    console.error(err.message);
    // Neither is fixed by restarting: the supervisor stops on this code instead of looping.
    process.exit(err.code === 'SETUP_REQUIRED' || err.code === 'PORT_IN_USE' ? EXIT_SETUP_REQUIRED : 1);
  }
  let stopping = false;
  shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await running.stop();
    process.exit(0); // the 'exit' hook releases the pid file
  };
  if (supervised) process.on('disconnect', shutdown); // supervisor gone: don't hold the port
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  if (stopRequested) shutdown();
}

async function main(argv) {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(HELP);
    return;
  }
  const { values } = parseArgs({
    args: rest,
    options: { foreground: { type: 'boolean' }, log: { type: 'boolean' }, proxy: { type: 'boolean' }, home: { type: 'string' } },
  });
  const home = configDir({ home: values.home });

  switch (command) {
    case 'start': {
      if (values.foreground) return foreground(home, { log: values.log });
      const sup = superviseServer({ home });
      const quit = () => sup.stop();
      process.once('SIGINT', quit);
      process.once('SIGTERM', quit);
      const r = await sup.done;
      if (r.reason === 'already-running') {
        console.error(alreadyRunningMessage(r.pid, home));
        process.exitCode = EXIT_SETUP_REQUIRED;
      } else if (r.reason === 'error') {
        console.error(`remote-for-herdr could not start: ${r.message}`);
        process.exitCode = 1;
      } else if (r.reason === 'setup-required') {
        console.error('remote-for-herdr could not start: it needs setup ("remote-for-herdr setup") or its port is already in use (see logs/server.log).');
        process.exitCode = EXIT_SETUP_REQUIRED;
      }
      return;
    }
    case 'stop': {
      const r = await stopRunning({ home });
      if (r.startsWith('timeout')) {
        console.error(`remote-for-herdr did not stop in time: ${r} (see logs/server.log).`);
        process.exitCode = 1;
      } else console.log(r);
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
      console.log('Installed the "remote-for-herdr" start-at-login task.');
      return;
    case 'uninstall-task':
      await uninstallTask({ home, cliPath: CLI_PATH });
      console.log('Removed the "remote-for-herdr" start-at-login task.');
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
