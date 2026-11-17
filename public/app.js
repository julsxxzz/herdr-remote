// App shell: sign-in, hash routing (#/ list, #/t/<address> live view), one list feed, visibility reports.

import { api, setSignedOutHandler } from './api.js';
import { el, renderList, createListFeed } from './list.js';
import { openTermView } from './term.js';
import { openSettings, syncPushSubscription } from './settings.js';

const app = document.getElementById('app');

let feed = null;
let termView = null;
let items = [];
let deskMode = false;
let connected = false;
let shell = null;

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
  // The service worker asks an open page to show a notification's terminal.
  navigator.serviceWorker.addEventListener('message', (ev) => {
    const url = ev.data?.type === 'open' && typeof ev.data.url === 'string' ? ev.data.url : null;
    if (url) location.hash = new URL(url, location.origin).hash || '#/';
  });
}

function routeAddress() {
  const m = /^#\/t\/(.+)$/.exec(location.hash);
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return null; }
}

function reportVisibility() {
  const address = termView && document.visibilityState === 'visible' ? termView.address : null;
  feed?.setVisible(address);
}

// ---------- sign in ----------

function stopAll() {
  feed?.close();
  feed = null;
  termView?.close();
  termView = null;
  shell = null;
  items = [];
  document.querySelector('dialog.sheet')?.close();
}

function showLogin(message) {
  stopAll();
  const pin = el('input', {
    type: 'password', id: 'pin', inputmode: 'numeric', autocomplete: 'current-password',
    required: true, minlength: '6', 'aria-describedby': 'login-msg',
  });
  const msg = el('p', { id: 'login-msg', class: 'login-msg', role: 'alert', text: message ?? '' });
  const submit = el('button', { type: 'submit', class: 'btn btn-primary btn-wide', text: 'Sign in' });
  const form = el('form', { class: 'login' },
    el('img', { src: '/icon.svg', alt: '', class: 'login-icon', width: '56', height: '56' }),
    el('h1', { text: 'herdr-remote' }),
    el('p', { class: 'login-lead', text: 'Enter the PIN you chose during setup. This phone stays signed in for 30 days.' }),
    el('label', { for: 'pin', text: 'PIN' }),
    pin, msg, submit);

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    submit.disabled = true;
    msg.textContent = '';
    const r = await api('/api/login', { method: 'POST', body: { pin: pin.value } });
    submit.disabled = false;
    if (r.ok) return startApp();
    pin.select();
    if (r.status === 401) msg.textContent = 'Wrong PIN. Try again.';
    else if (r.status === 429) {
      const mins = Math.max(1, Math.ceil((r.data?.retryAfterMs ?? 60000) / 60000));
      msg.textContent = `Too many wrong tries. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`;
    } else if (r.status === 0) msg.textContent = 'Couldn’t reach your computer. Check the connection and try again.';
    else msg.textContent = `Sign-in failed (HTTP ${r.status}).`;
  });

  app.replaceChildren(el('main', { class: 'view view-login' }, form));
  pin.focus();
}

setSignedOutHandler(() => showLogin('You were signed out. Enter the PIN to continue.'));

// ---------- list shell ----------

function buildShell() {
  const conn = el('span', { class: 'conn', role: 'status' });
  const list = el('main', { class: 'list', id: 'list' });
  const desk = el('input', { type: 'checkbox', role: 'switch', id: 'desk', class: 'switch' });
  const deskHelp = el('span', { class: 'setting-help', id: 'desk-help' });
  desk.addEventListener('change', async () => {
    desk.disabled = true;
    const r = await api('/api/settings', { method: 'PUT', body: { deskMode: desk.checked } });
    desk.disabled = false;
    if (r.ok) setDeskMode(Boolean(r.data?.deskMode));
    else desk.checked = deskMode;
  });
  const settingsBtn = el('button', { type: 'button', class: 'btn', text: 'Settings' });
  settingsBtn.addEventListener('click', () => openSettings());

  const view = el('div', { class: 'view view-list' },
    el('header', { class: 'app-head' }, el('h1', { text: 'herdr-remote' }), conn),
    list,
    el('footer', { class: 'app-foot' },
      el('div', { class: 'setting desk' },
        el('label', { for: 'desk', class: 'setting-text' }, el('span', { class: 'setting-label', text: 'Desk mode' }), deskHelp),
        desk),
      settingsBtn));
  return { view, conn, list, desk, deskHelp };
}

function setDeskMode(on) {
  deskMode = on;
  if (!shell) return;
  shell.desk.checked = on;
  shell.deskHelp.textContent = on ? 'Notifications paused' : 'Notifications on';
}

function renderConn() {
  if (!shell) return;
  shell.conn.className = `conn ${connected ? 'conn-live' : 'conn-off'}`;
  shell.conn.textContent = connected ? '● live' : '○ offline';
}

function renderListView() {
  if (shell && !termView) renderList(shell.list, items, { connected });
}

// ---------- routing ----------

function route() {
  if (!shell) return;
  const address = routeAddress();
  if (address && termView?.address === address) return;
  termView?.close();
  termView = null;
  if (address) {
    const holder = el('div', { class: 'term-holder' });
    app.replaceChildren(holder);
    termView = openTermView({ root: holder, address, item: items.find((i) => i.address === address) ?? null });
  } else {
    app.replaceChildren(shell.view);
    renderListView();
  }
  reportVisibility();
}

function startApp() {
  stopAll();
  shell = buildShell();
  setDeskMode(deskMode);
  renderConn();
  feed = createListFeed({
    onList(next, desk, ready) {
      items = next;
      setDeskMode(desk);
      renderListView();
      if (termView) {
        const item = items.find((i) => i.address === termView.address);
        // Absent from a ready, non-empty list = it finished or was removed. An empty or not-ready
        // list (e.g. right after a server restart) proves nothing; the term socket's ended/4404 decides.
        if (item) termView.update(item);
        else if (ready && items.length > 0) termView.update(null);
      }
    },
    onConnection(on) {
      connected = on;
      renderConn();
      renderListView();
    },
    onSignedOut: () => showLogin('You were signed out. Enter the PIN to continue.'),
  });
  route();
  syncPushSubscription();
}

window.addEventListener('hashchange', route);
document.addEventListener('visibilitychange', reportVisibility);

async function boot() {
  const r = await api('/api/session');
  if (r.ok && r.data?.signedIn) startApp();
  else if (r.status === 0 || r.status === 403) {
    const text = r.status === 403
      ? 'This account or network isn’t allowed to open herdr-remote.'
      : 'Couldn’t reach your computer. Check that it’s awake and online.';
    app.replaceChildren(el('main', { class: 'view view-login' },
      el('div', { class: 'login' },
        el('h1', { text: 'herdr-remote' }),
        el('p', { class: 'login-msg', role: 'alert', text }),
        el('button', { type: 'button', class: 'btn btn-primary btn-wide', text: 'Try again', onclick: boot }))));
  } else showLogin();
}

boot();
