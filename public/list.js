// Terminal list: the /ws/list feed, status presentation shared with the live view, and list rendering.
// Server text (space, agent, title, activity, message) only ever reaches the DOM as textContent.

import { api } from './api.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const RECONNECT_MS = [1000, 2000, 5000];

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export const STATUS_LABEL = { blocked: 'Needs you', error: 'Error', working: 'Working', done: 'Done', idle: 'Idle' };
export const KIND_LABEL = { permission: 'Permission', question: 'Question', auth: 'Sign-in' };

const SECTIONS = [
  { title: 'Needs you', statuses: ['blocked', 'error'] },
  { title: 'Working', statuses: ['working'] },
  { title: 'Done', statuses: ['done'] },
  { title: 'Idle', statuses: ['idle'] },
];

// Each status has its own shape, so it reads without colour.
const ICONS = {
  blocked: [['path', { d: 'M8 1.2 15.2 14.4H.8z', class: 'ic-fill' }], ['path', { d: 'M7.2 5.6h1.6v4.6H7.2zM7.2 11.3h1.6v1.6H7.2z', class: 'ic-cut' }]],
  error: [['path', { d: 'M5.1 1h5.8L15 5.1v5.8L10.9 15H5.1L1 10.9V5.1z', class: 'ic-fill' }], ['path', { d: 'M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8', class: 'ic-cut-line' }]],
  working: [['circle', { cx: 8, cy: 8, r: 6, class: 'ic-ring' }], ['path', { d: 'M8 2a6 6 0 0 1 6 6', class: 'ic-arc' }], ['circle', { cx: 8, cy: 8, r: 1.8, class: 'ic-fill' }]],
  done: [['circle', { cx: 8, cy: 8, r: 7, class: 'ic-fill' }], ['path', { d: 'M4.6 8.3 7 10.6l4.5-5', class: 'ic-cut-line' }]],
  idle: [['circle', { cx: 8, cy: 8, r: 6, class: 'ic-ring' }], ['path', { d: 'M5.5 8h5', class: 'ic-line' }]],
};

export const statusKey = (status) => (Object.hasOwn(STATUS_LABEL, status) ? status : 'idle');

export function statusIcon(status) {
  const key = statusKey(status);
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('class', `icon icon-${key}`);
  svg.setAttribute('aria-hidden', 'true');
  for (const [tag, attrs] of ICONS[key]) {
    const shape = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) shape.setAttribute(k, v);
    svg.append(shape);
  }
  return svg;
}

export const itemName = (item) => `${item.space} · ${item.agent}`;

// The detail lines shared by list rows and the live-view header.
export function itemDetails(item) {
  const nodes = [];
  const kind = item.status === 'blocked' && KIND_LABEL[item.kind];
  const line = item.activity || item.title;
  if (kind || line) {
    nodes.push(el('div', { class: 'detail-line' },
      kind ? el('span', { class: 'kind', text: kind }) : null,
      line ? el('span', { class: 'activity', text: line }) : null));
  }
  if (item.message) nodes.push(el('div', { class: 'message', text: item.message }));
  if (typeof item.progress === 'number') {
    const bar = el('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(item.progress), 'aria-label': 'Progress' }, el('span'));
    bar.firstChild.style.width = `${item.progress}%`;
    nodes.push(bar);
  }
  return nodes;
}

export const termHash = (address) => `#/t/${encodeURIComponent(address)}`;

function row(item) {
  const key = statusKey(item.status);
  return el('li', {},
    el('a', { class: `row st-${key}`, href: termHash(item.address) },
      el('span', { class: 'rail', 'aria-hidden': 'true' }),
      el('div', { class: 'row-body' },
        el('div', { class: 'row-top' },
          statusIcon(key),
          el('span', { class: 'visually-hidden', text: `${STATUS_LABEL[key]}: ` }),
          el('span', { class: 'name', text: itemName(item) }),
          item.unread ? el('span', { class: 'unread', title: 'New since you last looked', 'aria-label': 'Unread' }) : null,
        ),
        itemDetails(item),
        el('div', { class: 'row-meta' },
          el('span', { class: 'tab', text: item.tab || '' }),
          el('span', { class: 'addr', text: item.address })),
      )));
}

export function renderList(root, items, { connected }) {
  const frag = document.createDocumentFragment();
  for (const s of SECTIONS) {
    const group = items.filter((i) => s.statuses.includes(statusKey(i.status)));
    if (!group.length) continue;
    const key = statusKey(s.statuses[0]);
    frag.append(el('section', { class: `group group-${key}` },
      el('h2', {}, statusIcon(key), el('span', { text: s.title }), el('span', { class: 'count', text: String(group.length) })),
      el('ul', { class: 'rows' }, group.map(row))));
  }
  if (!items.length) {
    frag.append(el('div', { class: 'empty' },
      el('p', { class: 'empty-title', text: connected ? 'No terminals are open in Herdr.' : 'Connecting to your computer…' }),
      el('p', { text: connected ? 'Start an agent in Herdr and it shows up here.' : 'The list appears as soon as the connection is back.' })));
  }
  root.replaceChildren(frag);
}

// One /ws/list socket for the whole app.
export function createListFeed({ onList, onConnection, onSignedOut }) {
  let ws = null;
  let attempt = 0;
  let timer = null;
  let stopped = false;
  let visible = null;

  const sendVisible = () => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'visible', address: visible }));
  };

  function connect() {
    clearTimeout(timer);
    timer = null;
    if (stopped) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let opened = false;
    const sock = new WebSocket(`${proto}//${location.host}/ws/list`);
    ws = sock;
    sock.onopen = () => {
      opened = true;
      attempt = 0;
      onConnection(true);
      sendVisible();
    };
    sock.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg?.type === 'list' && Array.isArray(msg.items)) onList(msg.items, Boolean(msg.deskMode), msg.ready !== false);
    };
    sock.onclose = async (ev) => {
      if (ws !== sock) return;
      ws = null;
      onConnection(false);
      if (stopped) return;
      if (ev.code === 4401) { stopped = true; onSignedOut(); return; }
      if (!opened) {
        // A refused upgrade carries no close code: ask whether the session is still valid.
        const r = await api('/api/session');
        if (stopped) return;
        if (r.ok && r.data?.signedIn === false) { stopped = true; onSignedOut(); return; }
      }
      const wait = RECONNECT_MS[Math.min(attempt, RECONNECT_MS.length - 1)];
      attempt++;
      timer = setTimeout(connect, wait);
    };
  }

  // Phones freeze background pages; reconnect straight away when the app comes back.
  const onVisibility = () => {
    if (document.visibilityState === 'visible' && !ws && !stopped) connect();
  };
  document.addEventListener('visibilitychange', onVisibility);

  connect();
  return {
    setVisible(address) {
      if (address === visible) return;
      visible = address;
      sendVisible();
    },
    close() {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      const sock = ws;
      ws = null;
      sock?.close();
    },
  };
}
