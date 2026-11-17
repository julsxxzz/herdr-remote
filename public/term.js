// Live view: read-only xterm.js fed by /ws/term, plus the key bar and reply box.
// The terminal never takes input: disableStdin is on and term.onData is never wired.

import { api, terminalPath, signedOut } from './api.js';
import { el, statusIcon, statusKey, STATUS_LABEL, itemName, itemDetails } from './list.js';
import {
  MIN_ZOOM, MAX_ZOOM, effectiveScale, zoomIn, zoomOut, zoomLabel, zoomAriaLabel,
  pinchStep, anchoredScroll, wheelScale, readZoomPref, saveZoomPref,
} from './zoom.js';

const RECONNECT_MS = [1000, 2000, 5000];
const HISTORY = 200;
const CTRL_C_WINDOW_MS = 2000;
const WHEEL_SAVE_MS = 300; // Ctrl+wheel zoom is saved once the wheel goes quiet

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

function storage() {
  try { return window.localStorage; } catch { return null; }
}

export function openTermView({ root, address, item }) {
  let current = item;
  let gone = false;
  let socketSaidGone = false; // 'ended' or 4404 on the current socket: lists can't undo that
  let term = null;
  let ws = null;
  let closed = false;
  let ended = false;
  let attempt = 0;
  let reconnectTimer = null;
  let zoom = readZoomPref(storage()); // { mode: 'fit' | 'manual', zoom }
  let scale = 1; // scale applied to the terminal by the last layout()
  let resetOnSize = true;

  // ---- header ----
  const headTop = el('div', { class: 'head-top' });
  const headDetails = el('div', { class: 'head-details' });
  const headMeta = el('div', { class: 'row-meta' });
  const header = el('header', { class: 'term-head' },
    el('a', { class: 'icon-btn back', href: '#/', 'aria-label': 'Back to list' }, el('span', { 'aria-hidden': 'true', text: '‹' })),
    el('div', { class: 'head-body' }, headTop, headDetails, headMeta));

  // ---- zoom bar: its own row above the terminal, so the header keeps its full width ----
  const zoomOutBtn = el('button', { type: 'button', class: 'chip-btn', 'aria-label': 'Zoom out', text: '−' });
  const fitBtn = el('button', { type: 'button', class: 'chip-btn zoom-fit', 'aria-label': 'Fit to width' });
  const zoomInBtn = el('button', { type: 'button', class: 'chip-btn', 'aria-label': 'Zoom in', text: '+' });
  const zoomRow = el('div', { class: 'zoom-row' },
    el('div', { class: 'zoom', role: 'group', 'aria-label': 'Zoom' }, zoomOutBtn, fitBtn, zoomInBtn));

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

  // ---- zoom ----
  // Unscaled size of the rendered terminal (.xterm includes its padding, so a fitted width
  // matches the area exactly). CSS transforms don't change offsetWidth/Height.
  function naturalSize() {
    const w = term?.element?.offsetWidth || 0;
    const h = term?.element?.offsetHeight || 0;
    return w && h ? { w, h } : null;
  }

  function renderZoom() {
    fitBtn.textContent = zoomLabel(zoom);
    fitBtn.setAttribute('aria-label', zoomAriaLabel(zoom, scale));
    zoomOutBtn.disabled = scale <= MIN_ZOOM;
    zoomInBtn.disabled = scale >= MAX_ZOOM;
  }

  // Scales the terminal and sizes its wrapper; anything wider than the area pans
  // horizontally inside the area only (the page itself never scrolls sideways).
  function layout() {
    const size = naturalSize();
    if (size) {
      scale = effectiveScale(zoom, area.clientWidth, size.w);
      const width = Math.floor(size.w * scale);
      area.classList.toggle('scroll-x', width > area.clientWidth);
      host.style.transform = `scale(${scale})`;
      wrap.style.width = `${width}px`;
      wrap.style.height = `${Math.ceil(size.h * scale)}px`;
    }
    renderZoom();
  }

  // Applies a new zoom state and scrolls (from the live offsets) so the content at
  // (fromX, fromY) — area coordinates — stays there. Defaults to the area's centre.
  function applyZoom(next, { fromX = area.clientWidth / 2, fromY = area.clientHeight / 2 } = {}) {
    const fromScale = scale;
    const { scrollLeft, scrollTop } = area;
    zoom = next;
    layout();
    if (!naturalSize()) return;
    const pos = anchoredScroll({ fromScale, toScale: scale, scrollLeft, scrollTop, fromX, fromY, toX: fromX, toY: fromY });
    area.scrollLeft = pos.scrollLeft;
    area.scrollTop = pos.scrollTop;
  }

  const saveZoom = () => saveZoomPref(storage(), zoom);
  let saveTimer = null;
  function saveZoomSoon() {
    clearTimeout(saveTimer);
    // Flush first: a still-pending frame holds wheel input that isn't applied yet.
    saveTimer = setTimeout(() => { saveTimer = null; flushFrame(); saveZoom(); }, WHEEL_SAVE_MS);
  }

  function commitZoom(next) {
    applyZoom(next);
    saveZoom();
  }

  zoomOutBtn.addEventListener('click', () => commitZoom(zoomOut(scale)));
  zoomInBtn.addEventListener('click', () => commitZoom(zoomIn(scale)));
  fitBtn.addEventListener('click', () => commitZoom({ mode: 'fit', zoom: 1 }));

  const areaPoint = (x, y) => {
    const r = area.getBoundingClientRect();
    return { x: x - r.left, y: y - r.top };
  };

  // Gestures fire faster than frames: collect input, lay out at most once per frame.
  let frame = 0;
  let pendingWheel = null; // { delta, x, y }
  let pinch = null; // { ids: [id, id], last: { dist, x, y }, next: same | null }
  const scheduleFrame = () => { if (!frame) frame = requestAnimationFrame(runFrame); };
  function flushFrame() {
    if (!frame) return;
    cancelAnimationFrame(frame);
    runFrame();
  }
  function runFrame() {
    frame = 0;
    if (pendingWheel) {
      const w = pendingWheel;
      pendingWheel = null;
      applyZoom({ mode: 'manual', zoom: wheelScale(scale, w.delta) }, { fromX: w.x, fromY: w.y });
    }
    if (pinch?.next && naturalSize()) {
      const prev = pinch.last;
      pinch.last = pinch.next;
      pinch.next = null;
      // Incremental and from the live scroll offsets, so a native pan the browser made
      // meanwhile (non-cancelable touches) adds to the zoom instead of being overwritten.
      const step = pinchStep({ scale, scrollLeft: area.scrollLeft, scrollTop: area.scrollTop, prev, next: pinch.last });
      zoom = { mode: 'manual', zoom: step.scale };
      layout();
      area.scrollLeft = step.scrollLeft;
      area.scrollTop = step.scrollTop;
    }
  }

  // Desktop: Ctrl/⌘ + wheel (and trackpad pinch, which Chrome reports the same way).
  area.addEventListener('wheel', (ev) => {
    if (!(ev.ctrlKey || ev.metaKey)) return; // plain wheel keeps scrolling
    ev.preventDefault();
    const lines = ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? area.clientHeight : 1;
    const p = areaPoint(ev.clientX, ev.clientY);
    pendingWheel = { delta: (pendingWheel?.delta ?? 0) + ev.deltaY * lines, x: p.x, y: p.y };
    scheduleFrame();
    saveZoomSoon();
  }, { passive: false });

  // Phone: two-finger pinch. touch-action on .term-area leaves one-finger pan to the
  // browser and stops page zoom. The pinch follows two specific touches by identifier.
  function measure(a, b) {
    const p = areaPoint((a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2);
    return { dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), x: p.x, y: p.y };
  }
  function findTouch(list, id) {
    for (const t of list) if (t.identifier === id) return t;
    return null;
  }
  function pinchPair(list) {
    const a = findTouch(list, pinch.ids[0]);
    const b = findTouch(list, pinch.ids[1]);
    return a && b ? [a, b] : null;
  }
  // (Re)bases the pinch on the first two touches: nothing jumps, the next move is measured from here.
  function startPinch(list) {
    flushFrame();
    const [a, b] = list;
    pinch = { ids: [a.identifier, b.identifier], last: measure(a, b), next: null };
  }
  function endPinch() {
    flushFrame();
    pinch = null;
    saveZoom();
  }

  area.addEventListener('touchstart', (ev) => {
    if (ev.touches.length < 2) return;
    if (ev.cancelable) ev.preventDefault();
    if (pinch && pinchPair(ev.touches)) return; // an extra finger: keep following the pair
    startPinch(ev.touches);
  }, { passive: false });
  area.addEventListener('touchmove', (ev) => {
    if (!pinch) return;
    const pair = pinchPair(ev.touches);
    if (!pair) return;
    if (ev.cancelable) ev.preventDefault();
    pinch.next = measure(...pair);
    scheduleFrame();
  }, { passive: false });
  // On window: a finger may lift outside the area.
  const onTouchEnd = (ev) => {
    if (!pinch || pinchPair(ev.touches)) return;
    if (ev.touches.length >= 2) startPinch(ev.touches); // 3 → 2 fingers: re-base on the remaining pair
    else endPinch();
  };
  window.addEventListener('touchend', onTouchEnd);
  window.addEventListener('touchcancel', onTouchEnd);

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
    socketSaidGone = false;
    sock.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg?.type === 'size' && Number.isInteger(msg.cols) && Number.isInteger(msg.rows) && msg.cols > 0 && msg.rows > 0) {
          hideBanner();
          onSize(msg.cols, msg.rows);
        } else if (msg?.type === 'ended') {
          ended = true;
          gone = true;
          socketSaidGone = true;
          renderHeader();
          showBanner('Session ended', { tone: 'ended' });
          setControlsEnabled(false);
        }
        return;
      }
      attempt = 0; // screen data flows: a later drop starts the backoff over
      if (term) term.write(new Uint8Array(ev.data));
    };
    sock.onclose = (ev) => {
      if (ws !== sock) return;
      ws = null;
      if (closed || ended) return;
      if (ev.code === 4401) return signedOut();
      if (ev.code === 4404) {
        gone = true;
        socketSaidGone = true;
        renderHeader();
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
      // Anything else reconnects with backoff: 1013 (server not ready / slow client),
      // 1011 (observer stopped while the terminal still runs), network drops.
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
    header, banner, zoomRow, area,
    el('div', { class: 'controls' }, feedback, keybar, form));

  renderHeader();
  renderZoom();
  root.replaceChildren(view);
  connect();

  return {
    address,
    update(next) {
      if (next) { current = next; gone = socketSaidGone; } else gone = true;
      renderHeader();
    },
    close() {
      closed = true;
      clearTimeout(reconnectTimer);
      disarmCtrlC();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('touchend', onTouchEnd);
      window.removeEventListener('touchcancel', onTouchEnd);
      if (saveTimer) { clearTimeout(saveTimer); flushFrame(); saveZoom(); }
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      const sock = ws;
      ws = null;
      sock?.close();
      term?.dispose();
    },
  };
}
