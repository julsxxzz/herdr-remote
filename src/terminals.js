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
  if (typeof p !== 'number' || Number.isNaN(p)) return null;
  return Math.min(100, Math.max(0, Math.round(p)));
}

function isUnread(t) {
  const seen = t.labels?.['herdr.seen'];
  if (seen === undefined || seen === null || seen === '') return false;
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
    if (emitTransitions) {
      for (const t of terminals) {
        if (!isLive(t)) continue;
        const prev = old.get(t.address);
        if (prev && !isLive(prev)) continue;
        this._transition(prev ? toListItem(prev).status : 'idle', t);
      }
    }
    this.emit('changed');
  }

  apply({ type, terminal, seq, data }) {
    if (seq <= this.seq) return;
    this.seq = seq;
    if (type === 'heartbeat') return;
    const prev = this._records.get(terminal);
    if (type === 'created') {
      this._records.set(terminal, data);
      if (isLive(data)) this._transition('idle', data);
    } else if (type === 'removed') {
      this._records.delete(terminal);
    } else if (prev) {
      const next = { ...prev, ...data };
      if (type === 'labels') next.labels = { ...prev.labels, ...data.labels };
      if (type === 'finished') next.state = 'finished';
      this._records.set(terminal, next);
      if (isLive(prev) && isLive(next)) this._transition(toListItem(prev).status, next);
    } else {
      return;
    }
    this.emit('changed');
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
          a.space.localeCompare(b.space) ||
          a.address.localeCompare(b.address),
      );
  }
}
