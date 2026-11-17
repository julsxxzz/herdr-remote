import { EventEmitter } from 'node:events';

export const URGENCY = { blocked: 0, error: 0, working: 1, done: 2, idle: 3 };

const AGENT_NAMES = { 'claude-code': 'Claude Code', codex: 'Codex' };

export function displayAgent(t) {
  const first = t.argv?.[0];
  const base = first ? first.split(/[\\/]/).pop() : '?';
  const raw = t.status?.app ?? t.foreground?.name ?? base;
  const name = String(raw).replace(/\.exe$/i, '');
  return AGENT_NAMES[name] ?? name;
}

function toProgress(p) {
  if (!Number.isFinite(p)) return null;
  return Math.min(100, Math.max(0, Math.round(p)));
}

function isUnread(t) {
  const seen = String(t.labels?.['herdr.seen'] ?? '').trim();
  if (seen === '') return false;
  return Number(seen) < t.turn;
}

export function toListItem(t) {
  const where = t.labels?.where;
  let space = 'Other';
  let tab = '';
  if (where) {
    const i = where.indexOf(' / ');
    if (i === -1) space = where;
    else {
      space = where.slice(0, i);
      tab = where.slice(i + 3);
    }
  }
  return {
    address: t.address,
    agent: displayAgent(t),
    space,
    tab,
    status: t.status?.state ?? 'idle',
    kind: t.status?.kind ?? null,
    title: t.title || null,
    activity: t.status?.title || Object.values(t.records ?? {}).find((r) => r?.title)?.title || null,
    message: t.status?.msg || null,
    progress: toProgress(t.status?.progress),
    unread: isUnread(t),
    turn: t.turn,
    cols: t.cols,
    rows: t.rows,
  };
}

export function lsToTerminal(item) {
  return {
    address: item.address,
    state: item.state,
    status: item.status ? { state: item.status, app: item.agent } : null,
    turn: item.turn,
    cwd: item.cwd,
    labels: { where: item.where },
    foreground: { name: item.agent },
  };
}

const isLive = (t) => t?.state === 'live';

export class TerminalStore extends EventEmitter {
  constructor() {
    super();
    this.seq = 0;
    this.ready = false; // true once a first snapshot (events or ls) was applied
    this._records = new Map();
  }

  reset({ seq, terminals }, { emitTransitions = true } = {}) {
    const old = this._records;
    this._records = new Map(terminals.map((t) => [t.address, t]));
    this.seq = seq;
    this.ready = true;
    // 'changed' fires even if a transition listener throws; that error still propagates afterwards.
    try {
      if (emitTransitions) {
        for (const t of terminals) {
          if (!isLive(t)) continue;
          const prev = old.get(t.address);
          if (prev && !isLive(prev)) continue;
          this._transition(prev ? toListItem(prev).status : 'idle', t);
        }
      }
    } finally {
      this.emit('changed');
    }
  }

  apply({ type, terminal, seq, data }) {
    if (!Number.isFinite(seq) || !(seq > this.seq)) return; // also drops missing/garbage seqs
    this.seq = seq;
    if (type === 'heartbeat') return;
    const prev = this._records.get(terminal);
    let from = null; // status to transition from, when both old and new records are live
    if (type === 'created') {
      this._records.set(terminal, data);
      if (isLive(data)) from = isLive(prev) ? toListItem(prev).status : 'idle'; // a duplicate merges
    } else if (type === 'removed') {
      if (!prev) return;
      this._records.delete(terminal);
    } else if (prev) {
      // The lifecycle `state` is only set by created/reset/finished. In other events data.state is
      // something else (e.g. the agent status in `turn`), so it must never reach the record.
      const { state: _ignored, ...rest } = data ?? {};
      const patch = type === 'turn' ? { turn: rest.turn } : rest;
      const next = { ...prev, ...patch };
      if (type === 'labels') next.labels = { ...prev.labels, ...rest.labels };
      if (type === 'finished') next.state = 'finished';
      this._records.set(terminal, next);
      if (isLive(prev) && isLive(next)) from = toListItem(prev).status;
    } else {
      return;
    }
    try {
      if (from !== null) this._transition(from, this._records.get(terminal));
    } finally {
      this.emit('changed');
    }
  }

  _transition(from, t) {
    const item = toListItem(t);
    if (item.status !== from) {
      this.emit('transition', { address: t.address, from, to: item.status, turn: item.turn, item });
    }
  }

  get(address) {
    const t = this._records.get(address);
    return isLive(t) ? toListItem(t) : null;
  }

  list() {
    return [...this._records.values()]
      .filter(isLive)
      .map(toListItem)
      .sort(
        (a, b) =>
          (URGENCY[a.status] ?? 3) - (URGENCY[b.status] ?? 3) ||
          a.space.localeCompare(b.space, undefined, { numeric: true }) ||
          a.address.localeCompare(b.address, undefined, { numeric: true }),
      );
  }
}
