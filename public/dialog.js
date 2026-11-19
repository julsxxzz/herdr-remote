// The reply box's Send logic, including the two-tap confirm for typing into an open dialog.
// No DOM here, so it runs under `node --test` too: state + event → state + effect, with the
// time passed in (`now`, ms). term.js wires the DOM to it.
//
// While the terminal shows a dialog (status 'blocked'), hc only types into it with --force.
// The first tap (or Ctrl/⌘+Enter) arms and records the dialog the user saw; a second tap
// between MIN_CONFIRM_MS and CONFIRM_MS later sends with force + that dialog as `expect`,
// and the server refuses (409 dialog_changed) if it is no longer the same dialog.
//
// An empty Send (or Ctrl/⌘+Enter on an empty box) presses Enter, like the key bar's Enter key,
// dialog or not: no confirm, and it disarms one that is armed.

export const CONFIRM_MS = 2000; // the second tap must come within this window
export const MIN_CONFIRM_MS = 400; // ...but not sooner: a double tap or bounce is not a confirm
export const CLOSED_GUARD_MS = 1000; // after the dialog closes under an armed confirm, Send waits
export const SENT_MS = 1000; // "Sent ✓" shows this long
const MESSAGE_CHARS = 80;

export const TEXT = Object.freeze({
  dialogHint: 'Choose “Type something” first (its number key or ↓). Otherwise letters and digits act as key presses.',
  armedLive: 'Tap again within 2 seconds to type into the dialog',
  changed: 'The dialog changed — nothing was sent. Check it and try again.',
  closed: 'Dialog closed — Send now sends a normal reply.',
  wait: 'A dialog just opened — wait a moment, then tap Type into dialog',
  timeout: 'May or may not have been delivered — check the terminal before resending',
  sent: 'Sent',
});

// What the confirm cares about from a list item.
function snapshot(item) {
  if (!item) return null;
  return { status: item.status ?? null, kind: item.kind ?? null, message: item.message ?? null, turn: item.turn ?? null };
}

const isBlocked = (s) => s.dialog?.status === 'blocked';
const sameDialog = (a, b) => (a === null || b === null)
  ? a === b
  : a.status === b.status && a.kind === b.kind && a.message === b.message && a.turn === b.turn;

export function initialState(item) {
  return {
    dialog: snapshot(item),
    armed: null, // { at, expect: { kind, message, turn } }
    refused: false, // a plain send was refused as blocked before the list showed it
    guardUntil: 0,
    sending: false,
    enter: false, // the request in flight is an Enter press, not a text send
    sentUntil: 0,
    notice: null, // shown and announced until the next send
    announce: null, // announced only
  };
}

// Returns { state, effect }. effect is null, { type: 'arm' }, { type: 'send', force, expect? }
// or { type: 'enter' } (the caller posts it, then reports back with a 'result' event), or { type: 'notice' }
// (a result the hint now explains; the caller shows no generic error for it).
export function reduce(state, ev) {
  const s = { ...state };
  let effect = null;
  switch (ev.type) {
    case 'item': {
      const next = snapshot(ev.item);
      if (sameDialog(s.dialog, next)) break;
      const wasBlocked = isBlocked(s);
      if ((s.dialog?.status ?? null) !== (next?.status ?? null)) s.refused = false;
      s.dialog = next;
      if (s.armed) {
        s.armed = null;
        if (wasBlocked && !isBlocked(s)) {
          s.guardUntil = ev.now + CLOSED_GUARD_MS; // the would-be confirm must not send a plain reply
          s.notice = TEXT.closed;
        } else {
          s.notice = TEXT.changed;
        }
      }
      break;
    }
    case 'submit': {
      if (s.sending || ev.repeat || ev.now < s.guardUntil) break;
      if (!ev.hasText) {
        if (s.refused && !isBlocked(s)) break; // waiting for the list to show the dialog: Send is off
        s.armed = null; // a key press changes what the dialog shows
        effect = { type: 'enter' };
      } else if (isBlocked(s)) {
        const age = s.armed ? ev.now - s.armed.at : Infinity;
        if (age < MIN_CONFIRM_MS) break; // too soon: keep waiting for a deliberate second tap
        if (age >= CONFIRM_MS) {
          const { kind, message, turn } = s.dialog;
          s.armed = { at: ev.now, expect: { kind, message, turn } };
          s.notice = null;
          s.announce = null;
          effect = { type: 'arm' };
          break;
        }
        effect = { type: 'send', force: true, expect: s.armed.expect };
        s.armed = null;
      } else if (s.refused) {
        break; // a dialog opened but the list doesn't show it yet: nothing to confirm against
      } else {
        effect = { type: 'send', force: false };
      }
      s.sending = true;
      s.enter = effect.type === 'enter';
      s.sentUntil = 0;
      s.notice = null;
      s.announce = null;
      break;
    }
    case 'input':
      s.sentUntil = 0;
      s.armed = null;
      break;
    case 'key':
    case 'disarm':
      s.armed = null;
      break;
    case 'tick':
      if (s.armed && ev.now >= s.armed.at + CONFIRM_MS) s.armed = null;
      if (s.guardUntil && ev.now >= s.guardUntil) s.guardUntil = 0;
      if (s.sentUntil && ev.now >= s.sentUntil) s.sentUntil = 0;
      break;
    case 'result': {
      const enter = s.enter;
      s.sending = false;
      s.enter = false;
      if (ev.ok) {
        s.refused = false;
        s.sentUntil = ev.now + SENT_MS;
        s.announce = TEXT.sent;
      } else if (ev.status === 409 && ev.error === 'dialog_changed') {
        s.notice = TEXT.changed;
        effect = { type: 'notice' };
      } else if (ev.kind === 'timeout') {
        s.notice = TEXT.timeout;
        effect = { type: 'notice' };
      } else if (ev.status === 409 && ev.kind === 'blocked' && !ev.force && !enter) {
        s.refused = true;
        effect = { type: 'notice' };
      }
      break;
    }
    default:
      break;
  }
  return { state: s, effect };
}

function truncate(text, n) {
  return text.length > n ? `${text.slice(0, n - 1)}…` : text;
}

function typingInto(expect) {
  if (expect.message) return `Typing into: ${truncate(expect.message, MESSAGE_CHARS)}`;
  return expect.kind ? `Typing into the ${expect.kind} dialog` : 'Typing into the dialog';
}

// What the Send button and the hint show. engaged: the reply box has focus or text.
// hasText: the box holds more than whitespace (an empty Send presses Enter, so it reads plain "Send").
export function view(state, { now, engaged = false, hasText = true }) {
  const blocked = isBlocked(state);
  const dialog = blocked || state.refused;
  const waiting = state.refused && !blocked;
  let label = 'Send';
  if (state.sending) label = 'Sending…';
  else if (state.sentUntil && now < state.sentUntil) label = 'Sent ✓';
  else if (state.armed) label = 'Tap again to type';
  else if (dialog && hasText) label = 'Type into dialog';
  let hint = null;
  if (state.armed) hint = typingInto(state.armed.expect);
  else if (waiting) hint = TEXT.wait;
  else if (state.notice) hint = state.notice;
  else if (blocked && engaged) hint = TEXT.dialogHint;
  const live = state.armed ? TEXT.armedLive : (waiting ? TEXT.wait : (state.notice ?? state.announce ?? ''));
  return { label, dialog, armed: Boolean(state.armed), disabled: state.sending || waiting, hint, live };
}

// When the state next changes on its own (a 'tick' is due), or null.
export function nextWake(state) {
  const times = [state.armed ? state.armed.at + CONFIRM_MS : 0, state.guardUntil, state.sentUntil].filter((t) => t > 0);
  return times.length ? Math.min(...times) : null;
}

// Holds the state and stamps events with the clock.
export function createDialogConfirm({ item = null, now = () => performance.now() } = {}) {
  let state = initialState(item);
  return {
    dispatch(ev) {
      const r = reduce(state, { ...ev, now: now() });
      state = r.state;
      return r.effect;
    },
    view: (opts = {}) => view(state, { ...opts, now: now() }),
    nextWake: () => nextWake(state),
    get state() { return state; },
  };
}
