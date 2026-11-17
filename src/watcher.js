import readline from 'node:readline';
import { lsToTerminal } from './terminals.js';

const HEALTHY_MS = 60_000;

export function startWatcher({
  hc,
  store,
  log = console,
  backoffMs = [1000, 2000, 5000, 10000, 30000],
  pollMs = 5000,
  stallMs = 45000, // hc sends a heartbeat every 15 s; silence this long means a hung feed
}) {
  let stopped = false;
  let child = null;
  let restartTimer = null;
  let pollTimer = null;
  let step = 0;
  let haveData = false; // any snapshot (events or ls) applied yet
  let snapshots = 0; // bumped on every events snapshot, to drop stale ls results

  function spawnEvents() {
    restartTimer = null;
    if (stopped) return;
    // ls polling (if any) continues until this child delivers its snapshot.
    const startedAt = Date.now();
    const proc = hc.events();
    child = proc;
    let gotSnapshot = false;
    let ended = false;
    let stallTimer = null;
    const armStall = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        log.warn?.(`hc events silent for ${stallMs} ms; restarting`);
        proc.kill(); // normal restart path via 'close'
      }, stallMs);
    };
    armStall();

    const onEnd = (why) => {
      if (ended) return;
      ended = true;
      clearTimeout(stallTimer);
      lines.close();
      if (child === proc) child = null;
      if (stopped) return;
      if (Date.now() - startedAt > HEALTHY_MS) step = 0;
      const delay = backoffMs[Math.min(step, backoffMs.length - 1)];
      step += 1;
      log.warn?.(`hc events ended (${why}); restarting in ${delay} ms`);
      startPolling();
      restartTimer = setTimeout(spawnEvents, delay);
    };

    const lines = readline.createInterface({ input: proc.stdout });
    lines.on('line', (line) => {
      armStall();
      if (!line.trim()) return;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        log.warn?.('hc events: unparseable line skipped');
        return;
      }
      if (!gotSnapshot && Array.isArray(msg?.terminals)) {
        gotSnapshot = true;
        stopPolling();
        snapshots += 1;
        store.reset(msg, { emitTransitions: haveData });
        haveData = true;
      } else if (msg?.method === 'event' && msg.params) {
        if (msg.params.type === 'missed') proc.kill(); // restart yields a fresh snapshot
        else store.apply(msg.params);
      }
    });
    proc.stderr?.resume();
    proc.on('error', (err) => onEnd(`error: ${err.message}`));
    proc.on('close', (code) => onEnd(`exit ${code}`));
  }

  async function pollOnce() {
    const seen = snapshots;
    try {
      const items = await hc.ls();
      if (stopped || seen !== snapshots) return;
      store.reset(
        { seq: store.seq, terminals: items.map(lsToTerminal) },
        { emitTransitions: haveData },
      );
      haveData = true;
    } catch (err) {
      log.warn?.(`hc ls failed: ${err.message}`);
    }
  }

  function startPolling() {
    stopPolling();
    pollOnce();
    pollTimer = setInterval(pollOnce, pollMs);
  }

  function stopPolling() {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  spawnEvents();

  return {
    stop() {
      stopped = true;
      clearTimeout(restartTimer);
      stopPolling();
      child?.kill();
      child = null;
    },
  };
}
