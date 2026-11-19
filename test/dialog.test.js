import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONFIRM_MS, MIN_CONFIRM_MS, CLOSED_GUARD_MS, SENT_MS, TEXT,
  initialState, reduce, view, nextWake, createDialogConfirm,
} from '../public/dialog.js';

const blocked = { status: 'blocked', kind: 'question', message: 'answer: Which colour? (Red · Blue)', turn: 3 };
const working = { status: 'working', kind: null, message: null, turn: 3 };
const EXPECT = { kind: 'question', message: 'answer: Which colour? (Red · Blue)', turn: 3 };

// Runs events in order from a start item; returns the final state and every effect.
function run(item, events) {
  let state = initialState(item);
  const effects = [];
  for (const ev of events) {
    const r = reduce(state, ev);
    state = r.state;
    effects.push(r.effect);
  }
  return { state, effects };
}
const tap = (now, extra = {}) => ({ type: 'submit', now, hasText: true, ...extra });

test('not blocked: Send sends a plain reply on the first tap', () => {
  const { state, effects } = run(working, [tap(0)]);
  assert.deepEqual(effects, [{ type: 'send', force: false }]);
  assert.equal(state.sending, true);
  assert.equal(view(state, { now: 0 }).label, 'Sending…');
  assert.equal(view(initialState(working), { now: 0 }).label, 'Send');
});

test('blocked: first tap arms with the dialog seen, second tap after 400 ms sends with expect', () => {
  const a = run(blocked, [tap(0)]);
  assert.deepEqual(a.effects, [{ type: 'arm' }]);
  assert.deepEqual(a.state.armed, { at: 0, expect: EXPECT });
  const v = view(a.state, { now: 10 });
  assert.equal(v.label, 'Tap again to type');
  assert.equal(v.armed, true);
  assert.equal(v.dialog, true);
  assert.equal(v.hint, `Typing into: ${blocked.message}`);
  assert.equal(v.live, 'Tap again within 2 seconds to type into the dialog');

  const b = run(blocked, [tap(0), tap(MIN_CONFIRM_MS)]);
  assert.deepEqual(b.effects[1], { type: 'send', force: true, expect: EXPECT });
  assert.equal(b.state.armed, null);
  assert.equal(b.state.sending, true);
});

test('a second tap sooner than 400 ms is ignored and stays armed', () => {
  const { state, effects } = run(blocked, [tap(0), tap(MIN_CONFIRM_MS - 1), tap(MIN_CONFIRM_MS + 50)]);
  assert.equal(effects[1], null);
  assert.deepEqual(effects[2], { type: 'send', force: true, expect: EXPECT });
  assert.equal(state.sending, true);
});

test('the confirm window closes after 2 s; a later tap arms again', () => {
  const t = run(blocked, [tap(0), { type: 'tick', now: CONFIRM_MS }]);
  assert.equal(t.state.armed, null);
  assert.equal(view(t.state, { now: CONFIRM_MS }).label, 'Type into dialog');
  // a tap that arrives late, before the tick, is a fresh first tap
  const late = run(blocked, [tap(0), tap(CONFIRM_MS + 1)]);
  assert.deepEqual(late.effects[1], { type: 'arm' });
  assert.equal(late.state.armed.at, CONFIRM_MS + 1);
});

test('nextWake asks for a tick when the confirm window ends', () => {
  assert.equal(nextWake(initialState(blocked)), null);
  assert.equal(nextWake(run(blocked, [tap(100)]).state), 100 + CONFIRM_MS);
});

test('editing the text or pressing a key disarms', () => {
  for (const type of ['input', 'key', 'disarm']) {
    const { state } = run(blocked, [tap(0), { type }]);
    assert.equal(state.armed, null, type);
  }
});

test('a held Ctrl+Enter (ev.repeat) never arms or confirms', () => {
  assert.deepEqual(run(blocked, [tap(0, { repeat: true })]).effects, [null]);
  const { effects, state } = run(blocked, [tap(0), tap(500, { repeat: true })]);
  assert.equal(effects[1], null);
  assert.ok(state.armed);
  assert.deepEqual(run(working, [tap(0, { repeat: true })]).effects, [null]);
});

const empty = (now, extra = {}) => tap(now, { hasText: false, ...extra });

test('no text: Send presses Enter, dialog or not, with no confirm', () => {
  for (const item of [working, blocked, null]) {
    const { state, effects } = run(item, [empty(0)]);
    assert.deepEqual(effects, [{ type: 'enter' }], JSON.stringify(item));
    assert.equal(state.sending, true);
    assert.equal(state.armed, null);
    assert.equal(view(state, { now: 0, hasText: false }).label, 'Sending…');
  }
});

test('no text: an armed confirm is disarmed by the Enter press', () => {
  const { state, effects } = run(blocked, [tap(0), empty(500)]);
  assert.deepEqual(effects[1], { type: 'enter' });
  assert.equal(state.armed, null);
});

test('no text: Sent ✓ after the Enter press, then back to Send', () => {
  const { state } = run(blocked, [empty(0), { type: 'result', now: 300, ok: true }]);
  assert.equal(state.sending, false);
  assert.equal(state.enter, false);
  assert.equal(view(state, { now: 300, hasText: false }).label, 'Sent ✓');
  assert.equal(view(state, { now: 300 }).live, 'Sent');
  const later = reduce(state, { type: 'tick', now: 300 + SENT_MS }).state;
  assert.equal(view(later, { now: 300 + SENT_MS, hasText: false }).label, 'Send');
});

test('no text: a held Ctrl+Enter, a send in flight or the closed-dialog guard press nothing', () => {
  assert.deepEqual(run(working, [empty(0, { repeat: true })]).effects, [null]);
  assert.deepEqual(run(blocked, [empty(0, { repeat: true })]).effects, [null]);
  assert.equal(run(working, [empty(0), empty(10)]).effects[1], null);
  assert.equal(run(working, [tap(0), empty(10)]).effects[1], null);
  const guarded = run(blocked, [tap(0), { type: 'item', item: working, now: 500 }, empty(600)]);
  assert.equal(guarded.effects[2], null);
});

test('no text: nothing while waiting for the list to show a refused dialog', () => {
  const { state } = run(working, [tap(0),
    { type: 'result', now: 300, ok: false, status: 409, error: 'blocked', kind: 'blocked', force: false }]);
  assert.equal(reduce(state, empty(400)).effect, null);
});

test('no text: a failed Enter press never switches to dialog mode; a timeout still says so', () => {
  const refused = run(working, [empty(0),
    { type: 'result', now: 300, ok: false, status: 409, error: 'blocked', kind: 'blocked' }]);
  assert.equal(refused.effects[1], null); // the caller shows its generic error
  assert.equal(refused.state.refused, false);
  const timedOut = run(working, [empty(0),
    { type: 'result', now: 300, ok: false, status: 409, error: 'hc timed out', kind: 'timeout' }]);
  assert.deepEqual(timedOut.effects[1], { type: 'notice' });
  assert.equal(view(timedOut.state, { now: 300 }).hint, TEXT.timeout);
});

test('in a dialog, an empty box reads Send (it presses Enter), with text Type into dialog', () => {
  const s = initialState(blocked);
  assert.equal(view(s, { now: 0, hasText: false }).label, 'Send');
  assert.equal(view(s, { now: 0, hasText: false }).dialog, true);
  assert.equal(view(s, { now: 0, hasText: true }).label, 'Type into dialog');
});

test('any change of status, kind, message or turn disarms', () => {
  const changes = [
    { ...blocked, kind: 'permission' },
    { ...blocked, message: 'answer: Which fruit?' },
    { ...blocked, turn: 4 },
  ];
  for (const item of changes) {
    const { state } = run(blocked, [tap(0), { type: 'item', item, now: 100 }]);
    assert.equal(state.armed, null, JSON.stringify(item));
    assert.equal(view(state, { now: 100 }).hint, TEXT.changed);
  }
  // the same dialog re-reported keeps the arm
  assert.ok(run(blocked, [tap(0), { type: 'item', item: { ...blocked }, now: 100 }]).state.armed);
});

test('dialog closed while armed: disarm, ignore Send for 1 s, then Send is a normal reply', () => {
  const { state, effects } = run(blocked, [
    tap(0),
    { type: 'item', item: working, now: 500 },
    tap(600), // the would-be confirm
    tap(500 + CLOSED_GUARD_MS - 1),
  ]);
  assert.equal(effects[2], null);
  assert.equal(effects[3], null);
  assert.equal(state.armed, null);
  const v = view(state, { now: 600 });
  assert.equal(v.label, 'Send');
  assert.equal(v.hint, 'Dialog closed — Send now sends a normal reply.');
  assert.equal(nextWake(state), 500 + CLOSED_GUARD_MS);
  const after = reduce(reduce(state, { type: 'tick', now: 500 + CLOSED_GUARD_MS }).state, tap(500 + CLOSED_GUARD_MS));
  assert.deepEqual(after.effect, { type: 'send', force: false });
  // gone (null item) while armed is a close too
  assert.equal(run(blocked, [tap(0), { type: 'item', item: null, now: 10 }, tap(500)]).effects[2], null);
});

test('a dialog closing while not armed needs no guard', () => {
  const { effects } = run(blocked, [{ type: 'item', item: working, now: 0 }, tap(10)]);
  assert.deepEqual(effects[1], { type: 'send', force: false });
});

test('success: Sent ✓ for a second, announced, then back to the normal label', () => {
  const { state } = run(working, [tap(0), { type: 'result', now: 300, ok: true, force: false }]);
  assert.equal(state.sending, false);
  assert.equal(view(state, { now: 300 }).label, 'Sent ✓');
  assert.equal(view(state, { now: 300 }).live, 'Sent');
  assert.equal(nextWake(state), 300 + SENT_MS);
  const later = reduce(state, { type: 'tick', now: 300 + SENT_MS }).state;
  assert.equal(view(later, { now: 300 + SENT_MS }).label, 'Send');
});

test('409 dialog_changed: nothing was sent, says so', () => {
  const { state, effects } = run(blocked, [tap(0), tap(500),
    { type: 'result', now: 700, ok: false, status: 409, error: 'dialog_changed', kind: null, force: true }]);
  assert.deepEqual(effects[2], { type: 'notice' });
  assert.equal(view(state, { now: 700 }).hint, 'The dialog changed — nothing was sent. Check it and try again.');
  assert.equal(view(state, { now: 700 }).live, TEXT.changed);
});

test('a plain send refused as blocked: dialog mode, disabled until the list shows blocked', () => {
  const { state, effects } = run(working, [tap(0),
    { type: 'result', now: 300, ok: false, status: 409, error: 't1 is blocked (question)', kind: 'blocked', force: false }]);
  assert.deepEqual(effects[1], { type: 'notice' });
  assert.equal(state.refused, true);
  const v = view(state, { now: 300 });
  assert.equal(v.dialog, true);
  assert.equal(v.disabled, true);
  assert.equal(v.label, 'Type into dialog');
  assert.equal(v.hint, 'A dialog just opened — wait a moment, then tap Type into dialog');
  // a tap does nothing while the list still says it isn't blocked (it can't arm)
  assert.equal(reduce(state, tap(400)).effect, null);
  // the list catches up: the status change clears the refusal and normal dialog mode takes over
  const caught = reduce(state, { type: 'item', item: blocked, now: 500 }).state;
  assert.equal(caught.refused, false);
  assert.equal(view(caught, { now: 500 }).disabled, false);
  assert.deepEqual(reduce(caught, tap(600)).effect, { type: 'arm' });
});

test('a refusal also clears after the next successful send', () => {
  let { state } = run(working, [tap(0), { type: 'result', now: 1, ok: false, status: 409, error: 'x', kind: 'blocked', force: false }]);
  state = { ...state, dialog: { ...blocked } }; // (blocked without a status event: just to send again)
  state = reduce(state, tap(10)).state;
  state = reduce(state, tap(500)).state;
  state = reduce(state, { type: 'result', now: 600, ok: true, force: true }).state;
  assert.equal(state.refused, false);
});

test('a 409 of another kind does not switch to dialog mode', () => {
  const { state, effects } = run(working, [tap(0), { type: 'result', now: 1, ok: false, status: 409, error: 'nope', kind: null, force: false }]);
  assert.equal(effects[1], null); // the caller shows its generic error
  assert.equal(state.refused, false);
  assert.equal(view(state, { now: 1 }).dialog, false);
});

test('a timeout: may or may not have been delivered, no mode switch', () => {
  for (const force of [false, true]) {
    const start = force ? [tap(0), tap(500)] : [tap(0)];
    const { state, effects } = run(force ? blocked : working, [...start,
      { type: 'result', now: 900, ok: false, status: 409, error: 'hc timed out (…)', kind: 'timeout', force }]);
    assert.deepEqual(effects.at(-1), { type: 'notice' });
    assert.equal(state.refused, false);
    assert.equal(view(state, { now: 900 }).hint, 'May or may not have been delivered — check the terminal before resending');
  }
});

test('while sending, taps are ignored', () => {
  const { effects } = run(working, [tap(0), tap(10)]);
  assert.equal(effects[1], null);
});

test('the dialog hint shows in dialog mode only while the reply box is engaged', () => {
  const s = initialState(blocked);
  assert.equal(view(s, { now: 0, engaged: false }).hint, null);
  assert.equal(view(s, { now: 0, engaged: true }).hint,
    'Choose “Type something” first (its number key or ↓). Otherwise letters and digits act as key presses.');
  assert.equal(view(initialState(working), { now: 0, engaged: true }).hint, null);
});

test('the armed hint truncates a long message and copes with none', () => {
  const long = { ...blocked, message: 'x'.repeat(200) };
  const hint = view(run(long, [tap(0)]).state, { now: 0 }).hint;
  assert.ok(hint.startsWith('Typing into: xxx'));
  assert.ok(hint.length <= 'Typing into: '.length + 80);
  assert.ok(hint.endsWith('…'));
  assert.equal(view(run({ ...blocked, message: null }, [tap(0)]).state, { now: 0 }).hint, 'Typing into the question dialog');
  assert.equal(view(run({ ...blocked, message: null, kind: null }, [tap(0)]).state, { now: 0 }).hint, 'Typing into the dialog');
});

test('createDialogConfirm wraps reduce with an injected clock', () => {
  let t = 0;
  const c = createDialogConfirm({ item: blocked, now: () => t });
  assert.deepEqual(c.dispatch({ type: 'submit', hasText: true }), { type: 'arm' });
  t = 100;
  assert.equal(c.dispatch({ type: 'submit', hasText: true }), null);
  t = 450;
  assert.deepEqual(c.dispatch({ type: 'submit', hasText: true }), { type: 'send', force: true, expect: EXPECT });
  assert.equal(c.view({ engaged: true }).label, 'Sending…');
  assert.equal(c.nextWake(), null);
});
