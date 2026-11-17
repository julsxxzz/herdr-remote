// Live view: read-only xterm.js fed by /ws/term, plus the key bar and reply box.
// The terminal never takes input: disableStdin is on and term.onData is never wired.

import { api, terminalPath, signedOut } from './api.js';
import { el, statusIcon, statusKey, STATUS_LABEL, itemName, itemDetails } from './list.js';

const RECONNECT_MS = [1000, 2000, 5000];
const HISTORY = 200;
const CTRL_C_WINDOW_MS = 2000;
// Fit never shrinks text below this; a wider terminal pans horizontally instead (ruling R14).
const MIN_FIT_SCALE = 0.5;

const KEYS = [
  ['1', '1'], ['2', '2'], ['3', '3'], ['Enter', 'enter'], ['Esc', 'esc'], ['Tab', 'tab'],
  ['⇧Tab', 'shift+tab', 'Shift+Tab'], ['↑', 'up', 'Up'], ['↓', 'down', 'Down'], ['←', 'left', 'Left'], ['→', 'right', 'Right'],
  ['Ctrl+C', 'ctrl+c'],
];

const THEME = {
  background: '#0e1318',
  foreground: '#d5dde4',
  cursor: '#d5dde4',
  selectionBackground: '#33506a',
};

function readFitPref() {
  try { return localStorage.getItem('hr.fit') !== '100'; } catch { return true; }
}
function saveFitPref(fit) {
  try { localStorage.setItem('hr.fit', fit ? 'fit' : '100'); } catch { /* storage unavailable */ }
}

export function openTermView({ root, address, item }) {
  let current = item;
  let gone = false;
  let term = null;
  let ws = null;
  let closed = false;
  let ended = false;
  let attempt = 0;
  let reconnectTimer = null;
  let fit = readFitPref();
  let resetOnSize = true;

  // ---- header ----
  const headTop = el('div', { class: 'head-top' });
  const headDetails = el('div', { class: 'head-details' });
  const headMeta = el('div', { class: 'row-meta' });
  const fitBtn = el('button', { type: 'button', class: 'chip-btn fit-toggle' });
  const header = el('header', { class: 'term-head' },
    el('a', { class: 'icon-btn back', href: '#/', 'aria-label': 'Back to list' }, el('span', { 'aria-hidden': 'true', text: '‹' })),
    el('div', { class: 'head-body' }, headTop, headDetails, headMeta),
    fitBtn);

  function renderHeader() {
    if (gone || !current) {
      header.className = `term-head ${gone ? 'st-gone' : 'st-idle'}`;
      headTop.replaceChildren(
        el('span', { class: 'name', text: current ? itemName(current) : address }),
        gone ? el('span', { class: 'status-tag', text: 'Not running' }) : null,
      );
      headDetails.replaceChildren();
      headMeta.replaceChildren(el('span', { class: 'tab', text: current?.tab || '' }), el('span', { class: 'addr', text: address }));
      return;
    }
    const key = statusKey(current.status);
    header.className = `term-head st-${key}`;
    headTop.replaceChildren(
      el('span', { class: 'name', text: itemName(current) }),
      el('span', { class: 'status-tag' }, statusIcon(key), el('span', { text: STATUS_LABEL[key] })),
    );
    headDetails.replaceChildren(...itemDetails(current));
    headMeta.replaceChildren(el('span', { class: 'tab', text: current.tab || '' }), el('span', { class: 'addr', text: current.address }));
  }

  // ---- terminal ----
  const banner = el('div', { class: 'banner', role: 'status', hidden: true });
  const host = el('div', { class: 'term-host' });
  const wrap = el('div', { class: 'term-wrap' }, host);
  const area = el('div', { class: 'term-area' }, wrap);

  function showBanner(text, { tone = 'info', action = null } = {}) {
    banner.replaceChildren(...[el('span', { text }), action].filter(Boolean));
    banner.className = `banner banner-${tone}`;
    banner.hidden = false;
  }
  const hideBanner = () => { banner.hidden = true; };

  function layout() {
    if (!term?.element) return;
    // .xterm includes its padding, so the fitted width matches the area exactly.
    const w = term.element.offsetWidth;
    const h = term.element.offsetHeight;
    if (!w || !h) return;
    area.classList.toggle('natural', !fit);
    if (fit) {
      const fitScale = area.clientWidth / w;
      const scale = Math.max(fitScale, MIN_FIT_SCALE);
      area.classList.toggle('scroll-x', scale > fitScale);
      host.style.transform = `scale(${scale})`;
      wrap.style.width = `${Math.floor(w * scale)}px`;
      wrap.style.height = `${Math.ceil(h * scale)}px`;
    } else {
      area.classList.add('scroll-x');
      host.style.transform = '';
      wrap.style.width = '';
      wrap.style.height = '';
    }
  }

  function renderFitBtn() {
    fitBtn.textContent = fit ? 'Fit' : '100%';
    fitBtn.setAttribute('aria-label', fit ? 'Fitted to width. Switch to 100% size' : 'Shown at 100%. Switch to fit width');
  }
  fitBtn.addEventListener('click', () => {
    fit = !fit;
    saveFitPref(fit);
    renderFitBtn();
    layout();
  });

  const resizeObserver = new ResizeObserver(() => layout());
  resizeObserver.observe(area);

  function onSize(cols, rows) {
    if (!term) {
      term = new window.Terminal({
        cols, rows, disableStdin: true, scrollback: 1000, fontSize: 14, cursorBlink: false,
        fontFamily: 'ui-monospace, "Cascadia Mono", Consolas, "Roboto Mono", "Droid Sans Mono", monospace',
        theme: THEME,
      });
      term.open(host);
      resizeObserver.observe(term.element);
    } else {
      if (resetOnSize) term.reset();
      if (term.cols !== cols || term.rows !== rows) term.resize(cols, rows);
    }
    resetOnSize = false;
    layout();
  }

  function connect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    if (closed) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const sock = new WebSocket(`${proto}//${location.host}/ws/term?address=${encodeURIComponent(address)}&history=${HISTORY}`);
    sock.binaryType = 'arraybuffer';
    ws = sock;
    resetOnSize = true;
    sock.onopen = () => { attempt = 0; };
    sock.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg?.type === 'size' && Number.isInteger(msg.cols) && Number.isInteger(msg.rows) && msg.cols > 0 && msg.rows > 0) {
          hideBanner();
          onSize(msg.cols, msg.rows);
        } else if (msg?.type === 'ended') {
          ended = true;
          showBanner('Session ended', { tone: 'ended' });
          setControlsEnabled(false);
        }
        return;
      }
      if (term) term.write(new Uint8Array(ev.data));
    };
    sock.onclose = (ev) => {
      if (ws !== sock) return;
      ws = null;
      if (closed || ended) return;
      if (ev.code === 4401) return signedOut();
      if (ev.code === 4404) {
        showBanner('This terminal is no longer running.', { tone: 'ended' });
        setControlsEnabled(false);
        return;
      }
      if (ev.code === 4429) {
        showBanner('Too many live views are open. Close one, then retry.', {
          tone: 'warn',
          action: el('button', { type: 'button', class: 'chip-btn', text: 'Retry', onclick: () => { hideBanner(); connect(); } }),
        });
        return;
      }
      const wait = RECONNECT_MS[Math.min(attempt, RECONNECT_MS.length - 1)];
      attempt++;
      showBanner('Connection lost. Reconnecting…', { tone: 'warn' });
      reconnectTimer = setTimeout(connect, wait);
    };
  }

  const onVisibility = () => {
    if (document.visibilityState === 'visible' && !ws && reconnectTimer && !closed && !ended) connect();
  };
  document.addEventListener('visibilitychange', onVisibility);

  // ---- feedback line shared by keys and reply ----
  const feedback = el('p', { class: 'feedback', role: 'alert' });
  const showError = (text, hint) => {
    feedback.replaceChildren(...[el('span', { text }), hint && el('span', { class: 'hint', text: hint })].filter(Boolean));
    feedback.hidden = false;
  };
  const clearError = () => { feedback.hidden = true; feedback.replaceChildren(); };
  clearError();

  function describeFailure(r) {
    if (r.status === 0) return 'Couldn’t reach your computer. Check the connection and try again.';
    if (r.status === 404) return 'This terminal is no longer running.';
    if (r.status === 409) return r.data?.error ? String(r.data.error) : 'Herdr refused the input.';
    if (r.status === 400) return 'That input was not accepted.';
    return `Something went wrong (HTTP ${r.status}).`;
  }

  // ---- key bar ----
  let ctrlCTimer = null;
  const keyButtons = KEYS.map(([label, key, aria]) => {
    const b = el('button', { type: 'button', class: `key${key === 'ctrl+c' ? ' key-danger' : ''}`, 'aria-label': aria ?? null, text: label });
    b.dataset.key = key;
    return b;
  });
  const ctrlC = keyButtons.find((b) => b.dataset.key === 'ctrl+c');

  function disarmCtrlC() {
    clearTimeout(ctrlCTimer);
    ctrlCTimer = null;
    ctrlC.classList.remove('armed');
    ctrlC.textContent = 'Ctrl+C';
  }

  async function sendKey(key, button) {
    clearError();
    button.classList.add('busy');
    const r = await api(terminalPath(address, 'keys'), { method: 'POST', body: { keys: [key] } });
    button.classList.remove('busy');
    if (!r.ok && r.status !== 401) showError(describeFailure(r));
  }

  const keybar = el('div', { class: 'keybar', role: 'group', 'aria-label': 'Keys' }, keyButtons);
  keybar.addEventListener('click', (ev) => {
    const b = ev.target.closest('button.key');
    if (!b || b.disabled) return;
    const key = b.dataset.key;
    if (key === 'ctrl+c') {
      if (!ctrlCTimer) {
        ctrlC.classList.add('armed');
        ctrlC.textContent = 'Tap again';
        ctrlCTimer = setTimeout(disarmCtrlC, CTRL_C_WINDOW_MS);
        return;
      }
      disarmCtrlC();
    }
    sendKey(key, b);
  });

  // ---- reply box ----
  const textarea = el('textarea', { rows: '1', placeholder: 'Reply to the agent', 'aria-label': 'Reply text', enterkeyhint: 'enter', maxlength: '4000' });
  const sendBtn = el('button', { type: 'submit', class: 'send', text: 'Send' });
  const form = el('form', { class: 'reply' }, textarea, sendBtn);

  const grow = () => {
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 132)}px`;
  };
  textarea.addEventListener('input', grow);
  textarea.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); form.requestSubmit(); }
  });
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const text = textarea.value;
    if (!text.trim() || sendBtn.disabled) return;
    clearError();
    sendBtn.disabled = true;
    sendBtn.textContent = 'Sending…';
    const r = await api(terminalPath(address, 'send'), { method: 'POST', body: { text } });
    sendBtn.disabled = ended;
    sendBtn.textContent = 'Send';
    if (r.ok) {
      if (textarea.value === text) textarea.value = '';
      grow();
    } else if (r.status !== 401) {
      showError(describeFailure(r), r.status === 409 ? 'Answer the dialog with the keys above.' : null);
    }
  });

  function setControlsEnabled(on) {
    for (const b of keyButtons) b.disabled = !on;
    sendBtn.disabled = !on;
    textarea.disabled = !on;
    if (!on) disarmCtrlC();
  }

  const view = el('section', { class: 'view view-term' },
    header, banner, area,
    el('div', { class: 'controls' }, feedback, keybar, form));

  renderHeader();
  renderFitBtn();
  root.replaceChildren(view);
  connect();

  return {
    address,
    update(next) {
      if (next) { current = next; gone = false; } else gone = true;
      renderHeader();
    },
    close() {
      closed = true;
      clearTimeout(reconnectTimer);
      disarmCtrlC();
      document.removeEventListener('visibilitychange', onVisibility);
      resizeObserver.disconnect();
      const sock = ws;
      ws = null;
      sock?.close();
      term?.dispose();
    },
  };
}
