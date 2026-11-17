// Live view: read-only xterm.js fed by /ws/term, plus the key bar and reply box.
// The terminal never takes input: disableStdin is on and term.onData is never wired.

import { api, terminalPath, signedOut } from './api.js';
import { el, statusIcon, statusKey, STATUS_LABEL, itemName, itemDetails } from './list.js';
import {
  MIN_ZOOM, MAX_ZOOM, effectiveScale, zoomIn, zoomOut, zoomLabel, zoomAriaLabel,
  pinchStep, anchoredScroll, wheelScale, readZoomPref, saveZoomPref,
} from './zoom.js';
import { splitPan, snapCarry, releaseVelocity, flingStep, FRAME_MS, FLING_STOP, VELOCITY_WINDOW_MS } from './scroll.js';

const RECONNECT_MS = [1000, 2000, 5000];
const HISTORY = 1000; // lines of scrollback replayed on connect (server clamps to 0..2000)
const SCROLLBACK = 2000; // xterm keeps history + what arrives live
const WHEEL_SAVE_MS = 300; // Ctrl+wheel zoom is saved once the wheel goes quiet
const CONFIRM_MS = 2000; // a dialog send needs a second tap within this window
const DIALOG_HINT = 'Pick the dialog’s “Type something” option with its number key first, then type here.';

const KEYS = [
  ['1', '1'], ['2', '2'], ['3', '3'], ['Enter', 'enter'], ['Esc', 'esc'], ['Tab', 'tab'],
  ['⇧Tab', 'shift+tab', 'Shift+Tab'], ['↑', 'up', 'Up'], ['↓', 'down', 'Down'], ['←', 'left', 'Left'], ['→', 'right', 'Right'],
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
  // Scale applied by the last layout(); before the first one only a manual zoom is known.
  let scale = zoom.mode === 'manual' ? zoom.zoom : 1;
  let laidOut = false;
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
    // Fit's scale is unknown until the terminal is laid out: don't announce a made-up 100%.
    const known = laidOut || zoom.mode === 'manual';
    fitBtn.setAttribute('aria-label', known ? zoomAriaLabel(zoom, scale) : 'Fit to width');
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
      laidOut = true;
    } else if (zoom.mode === 'manual') {
      scale = zoom.zoom; // not laid out yet, but a manual zoom is still known
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
    stopFling(); // + / − / Fit taps stop a running fling
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
      // Incremental and from the live scroll offsets. When the touchmove wasn't cancelable the
      // browser has already panned by the midpoint's movement: zoom about the current midpoint only.
      const step = pinchStep({
        scale, scrollLeft: area.scrollLeft, scrollTop: area.scrollTop, prev, next: pinch.last, native: pinch.native,
      });
      zoom = { mode: 'manual', zoom: step.scale };
      layout();
      area.scrollLeft = step.scrollLeft;
      area.scrollTop = step.scrollTop;
    }
  }

  // ---- scrolling: one range, xterm scrollback above + the area's own scroll below ----
  let lineCarry = 0; // fractional scrollback px not yet worth a whole line
  let topCarry = 0; // sub-pixel of the area's own scroll lost to scroll snapping
  let leftCarry = 0;
  function resetCarries() { lineCarry = 0; topCarry = 0; leftCarry = 0; }
  function rowHeightPx() { // one terminal row in screen px at the current zoom
    const screen = term?.element?.querySelector('.xterm-screen');
    return screen && term.rows ? (screen.offsetHeight / term.rows) * scale : 0;
  }
  // Scrolls the view by (dx, dy) screen px, positive = towards right/bottom.
  // Returns whether anything moved (a fling stops at the ends).
  function panBy(dx, dy) {
    let moved = false;
    if (dx) {
      const before = area.scrollLeft;
      const max = area.scrollWidth - area.clientWidth;
      const desired = Math.min(max, Math.max(0, before + leftCarry + dx));
      area.scrollLeft = desired;
      leftCarry = snapCarry(desired, area.scrollLeft);
      moved = desired !== before;
    }
    if (dy) {
      const buf = term?.buffer.active;
      const r = splitPan({
        delta: dy, scrollTop: area.scrollTop + topCarry, maxScrollTop: area.scrollHeight - area.clientHeight,
        linesAbove: buf ? buf.viewportY : 0, linesBelow: buf ? buf.baseY - buf.viewportY : 0,
        lineHeight: rowHeightPx(), carry: lineCarry,
      });
      lineCarry = r.carry;
      area.scrollTop = r.scrollTop;
      topCarry = snapCarry(r.scrollTop, area.scrollTop); // the sub-pixel Chrome's snapping dropped
      if (r.lines) term.scrollLines(r.lines); // scrolling up keeps xterm from following new output
      moved = moved || Math.abs(r.rest) < Math.abs(dy);
    }
    return moved;
  }

  // Fling: keeps panning after a quick swipe, slowing down each frame.
  let fling = null; // { vx, vy, t } in px per frame
  let flingFrame = 0;
  function stopFling() {
    cancelAnimationFrame(flingFrame);
    flingFrame = 0;
    fling = null;
  }
  function startFling(vx, vy) {
    stopFling();
    if (Math.abs(vx) < FLING_STOP && Math.abs(vy) < FLING_STOP) return;
    fling = { vx, vy, t: null };
    flingFrame = requestAnimationFrame(flingTick);
  }
  function flingTick(now) {
    flingFrame = 0;
    if (!fling) return;
    const dt = fling.t === null ? FRAME_MS : Math.min(100, Math.max(0, now - fling.t));
    fling.t = now;
    const k = dt / FRAME_MS;
    const moved = panBy(fling.vx * k, fling.vy * k);
    fling.vx = flingStep(fling.vx, dt);
    fling.vy = flingStep(fling.vy, dt);
    if (!moved || (!fling.vx && !fling.vy)) return stopFling();
    flingFrame = requestAnimationFrame(flingTick);
  }

  // Wheel, in the capture phase so xterm doesn't also scroll its scrollback on its own.
  // Plain wheel walks the same range as a touch pan; Ctrl/⌘ + wheel (and a trackpad
  // pinch, which Chrome reports the same way) zooms.
  area.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    stopFling();
    if (ev.ctrlKey || ev.metaKey) {
      const lines = ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? area.clientHeight : 1;
      const p = areaPoint(ev.clientX, ev.clientY);
      pendingWheel = { delta: (pendingWheel?.delta ?? 0) + ev.deltaY * lines, x: p.x, y: p.y };
      scheduleFrame();
      saveZoomSoon();
      return;
    }
    const unit = ev.deltaMode === 1 ? (rowHeightPx() || 16) : ev.deltaMode === 2 ? area.clientHeight : 1;
    let dx = ev.deltaX * unit;
    let dy = ev.deltaY * unit;
    if (ev.shiftKey && !dx) { dx = dy; dy = 0; }
    panBy(dx, dy);
  }, { capture: true, passive: false });

  // Touch: .term-area has touch-action: none, so we own every gesture on it (no native
  // scroll, no page zoom, no pull-to-refresh). One finger pans + flings; two fingers pinch,
  // following two specific touches by identifier.
  let pan = null; // { id, x, y, samples: [{ t, x, y }] }
  function startPan(t) {
    const now = performance.now();
    pan = { id: t.identifier, x: t.clientX, y: t.clientY, samples: [{ t: now, x: t.clientX, y: t.clientY }] };
  }
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
    pinch = { ids: [a.identifier, b.identifier], last: measure(a, b), next: null, native: false };
  }
  function endPinch() {
    flushFrame();
    pinch = null;
    saveZoom();
  }

  // Capture phase + stopPropagation: xterm's own touch scrolling never sees these.
  area.addEventListener('touchstart', (ev) => {
    ev.stopPropagation();
    stopFling(); // any new touch stops a fling
    if (ev.touches.length >= 2) {
      if (ev.cancelable) ev.preventDefault();
      pan = null;
      if (pinch && pinchPair(ev.touches)) return; // an extra finger: keep following the pair
      startPinch(ev.touches);
    } else if (!pinch) {
      startPan(ev.touches[0]);
    }
  }, { capture: true, passive: false });
  area.addEventListener('touchmove', (ev) => {
    ev.stopPropagation();
    if (ev.cancelable) ev.preventDefault();
    if (pinch) {
      const pair = pinchPair(ev.touches);
      if (!pair) return;
      // With touch-action: none our moves are cancelable, so this stays false in practice.
      pinch.native = !ev.cancelable;
      pinch.next = measure(...pair);
      scheduleFrame();
      return;
    }
    const t = pan && findTouch(ev.touches, pan.id);
    if (!t) return;
    panBy(pan.x - t.clientX, pan.y - t.clientY); // content follows the finger
    const now = performance.now();
    pan.x = t.clientX;
    pan.y = t.clientY;
    pan.samples.push({ t: now, x: t.clientX, y: t.clientY });
    while (pan.samples.length > 2 && pan.samples[0].t < now - 2 * VELOCITY_WINDOW_MS) pan.samples.shift();
  }, { capture: true, passive: false });
  // Window, capture phase: sees every lift, even though the area stops propagation.
  const onTouchEnd = (ev) => {
    if (pinch) {
      if (pinchPair(ev.touches)) return;
      if (ev.touches.length >= 2) { startPinch(ev.touches); return; } // 3 → 2 fingers: re-base
      endPinch();
      if (ev.touches.length === 1) startPan(ev.touches[0]); // the remaining finger keeps panning
      return;
    }
    if (!pan || findTouch(ev.touches, pan.id)) return;
    const { vx, vy } = releaseVelocity(pan.samples, performance.now());
    pan = null;
    if (ev.type === 'touchend') startFling(-vx * FRAME_MS, -vy * FRAME_MS);
  };
  window.addEventListener('touchend', onTouchEnd, true);
  window.addEventListener('touchcancel', onTouchEnd, true);

  // ---- "↓ Latest": shown while xterm is scrolled up into its history ----
  const latestBtn = el('button', { type: 'button', class: 'latest', 'aria-label': 'Jump to latest output', hidden: true },
    el('span', { 'aria-hidden': 'true', text: '↓ Latest' }));
  function updateLatest() {
    const b = term?.buffer.active;
    latestBtn.hidden = !b || b.viewportY >= b.baseY;
  }
  latestBtn.addEventListener('click', () => {
    stopFling();
    resetCarries();
    term?.scrollToBottom();
    area.scrollTop = area.scrollHeight;
    updateLatest();
  });
  const stage = el('div', { class: 'term-stage' }, area, latestBtn);

  const resizeObserver = new ResizeObserver(() => layout());
  resizeObserver.observe(area);

  function onSize(cols, rows) {
    if (!term) {
      term = new window.Terminal({
        cols, rows, disableStdin: true, scrollback: SCROLLBACK, fontSize: 14, cursorBlink: false,
        fontFamily: 'ui-monospace, "Cascadia Mono", Consolas, "Roboto Mono", "Droid Sans Mono", monospace',
        theme: THEME,
      });
      term.open(host);
      resizeObserver.observe(term.element);
      // While scrolled up, xterm keeps the position as output arrives; only the button changes.
      term.onScroll(updateLatest);
      term.onWriteParsed(updateLatest);
    } else {
      if (resetOnSize) term.reset();
      if (term.cols !== cols || term.rows !== rows) term.resize(cols, rows);
    }
    resetOnSize = false;
    resetCarries();
    layout();
    updateLatest();
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
  const keyButtons = KEYS.map(([label, key, aria]) => {
    const b = el('button', { type: 'button', class: 'key', 'aria-label': aria ?? null, text: label });
    b.dataset.key = key;
    return b;
  });
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
    sendKey(key, b);
  });

  // ---- reply box ----
  // While the terminal shows a dialog (status 'blocked'), hc only types into it with --force.
  // That is "dialog mode": the first tap (or Ctrl/⌘+Enter) arms, a second one within
  // CONFIRM_MS sends with force: true. Otherwise Send behaves as a plain send.
  const textarea = el('textarea', {
    rows: '1', placeholder: 'Reply to the agent', 'aria-label': 'Reply text', enterkeyhint: 'enter', maxlength: '4000',
    'aria-describedby': 'reply-hint',
  });
  const sendBtn = el('button', { type: 'submit', class: 'send', text: 'Send' });
  const form = el('form', { class: 'reply' }, textarea, sendBtn);
  const replyHint = el('p', { class: 'reply-hint', id: 'reply-hint', text: DIALOG_HINT, hidden: true });

  let sending = false;
  let armed = false;
  let armTimer = null;
  let refusedAsDialog = false; // a plain send got a 409: treat as a dialog until the status changes
  const dialogMode = () => current?.status === 'blocked' || refusedAsDialog;

  function renderSend() {
    const dialog = dialogMode();
    sendBtn.textContent = sending ? 'Sending…' : armed ? 'Tap again to type' : dialog ? 'Type into dialog' : 'Send';
    sendBtn.classList.toggle('dialog', dialog);
    sendBtn.classList.toggle('armed', armed);
    replyHint.hidden = !dialog || gone || ended;
  }
  function disarm() {
    clearTimeout(armTimer);
    armTimer = null;
    if (!armed) return;
    armed = false;
    renderSend();
  }
  function arm() {
    armed = true;
    clearTimeout(armTimer);
    armTimer = setTimeout(disarm, CONFIRM_MS);
    renderSend();
  }

  const grow = () => {
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 132)}px`;
  };
  textarea.addEventListener('input', () => { disarm(); grow(); });
  textarea.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); form.requestSubmit(); }
  });
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const text = textarea.value;
    if (!text.trim() || sendBtn.disabled) return;
    const force = dialogMode();
    if (force && !armed) { arm(); return; }
    disarm();
    clearError();
    sending = true;
    sendBtn.disabled = true;
    renderSend();
    const body = force ? { text, force: true } : { text };
    const r = await api(terminalPath(address, 'send'), { method: 'POST', body });
    sending = false;
    sendBtn.disabled = ended || gone;
    if (r.ok) {
      if (textarea.value === text) textarea.value = '';
      grow();
    } else if (r.status !== 401) {
      // A plain send refused with 409: the terminal most likely just opened a dialog.
      if (r.status === 409 && !force) refusedAsDialog = true;
      showError(describeFailure(r), r.status === 409 && !force ? 'The terminal is showing a dialog.' : null);
    }
    renderSend();
  });

  function setControlsEnabled(on) {
    for (const b of keyButtons) b.disabled = !on;
    sendBtn.disabled = !on;
    textarea.disabled = !on;
    if (!on) disarm();
    renderSend();
  }

  const view = el('section', { class: 'view view-term' },
    header, banner, zoomRow, stage,
    el('div', { class: 'controls' }, feedback, keybar, form, replyHint));

  renderHeader();
  renderZoom();
  renderSend();
  root.replaceChildren(view);
  connect();

  return {
    address,
    update(next) {
      const before = gone ? null : current?.status;
      if (next) { current = next; gone = socketSaidGone; } else gone = true;
      const after = gone ? null : current?.status;
      if (after !== before) { refusedAsDialog = false; disarm(); }
      renderHeader();
      renderSend();
    },
    close() {
      closed = true;
      clearTimeout(reconnectTimer);
      clearTimeout(armTimer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('touchend', onTouchEnd, true);
      window.removeEventListener('touchcancel', onTouchEnd, true);
      stopFling();
      if (pinch) endPinch(); // flushes and saves a pinch still in progress
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
