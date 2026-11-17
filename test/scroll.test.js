import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitPan, releaseVelocity, flingStep, FLING_DECAY, FLING_DECAY_REDUCED, FLING_STOP, FRAME_MS, MAX_VELOCITY, snapCarry, latestVisible,
} from '../public/scroll.js';

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} !~ ${b}`);
const base = { maxScrollTop: 200, linesAbove: 50, linesBelow: 0, lineHeight: 20, carry: 0 };

test('splitPan: moves inside the area first', () => {
  assert.deepEqual(splitPan({ ...base, delta: -40, scrollTop: 100 }), { scrollTop: 60, lines: 0, carry: 0, rest: 0 });
  assert.deepEqual(splitPan({ ...base, delta: 40, scrollTop: 100 }), { scrollTop: 140, lines: 0, carry: 0, rest: 0 });
});

test('splitPan: scrolling up past the area top continues into scrollback with a fractional carry', () => {
  const r = splitPan({ ...base, delta: -100, scrollTop: 30 });
  assert.equal(r.scrollTop, 0);
  assert.equal(r.lines, -3);
  near(r.carry, -10);
  assert.equal(r.rest, 0);
  const r2 = splitPan({ ...base, delta: -15, scrollTop: 0, carry: r.carry });
  assert.equal(r2.lines, -1);
  near(r2.carry, -5);
});

test('splitPan: scrolling down leaves the scrollback first, then moves the area (no dead zone)', () => {
  const r = splitPan({ ...base, delta: 70, scrollTop: 0, linesAbove: 48, linesBelow: 2 });
  assert.equal(r.lines, 2);
  assert.equal(r.scrollTop, 30);
  assert.equal(r.carry, 0);
});

test('splitPan: small moves accumulate into whole lines', () => {
  let carry = 0;
  let lines = 0;
  for (let i = 0; i < 10; i++) {
    const r = splitPan({ ...base, delta: -7, scrollTop: 0, carry });
    carry = r.carry;
    lines += r.lines;
  }
  assert.equal(lines, -3); // 70 px = 3 lines + 10 px carried
  near(carry, -10);
});

test('splitPan: a round trip comes back to the same place', () => {
  const up = splitPan({ ...base, delta: -150, scrollTop: 50, linesAbove: 10, linesBelow: 0 });
  assert.deepEqual(up, { scrollTop: 0, lines: -5, carry: 0, rest: 0 });
  const down = splitPan({ ...base, delta: 150, scrollTop: up.scrollTop, linesAbove: 5, linesBelow: 5, carry: up.carry });
  assert.equal(down.lines, 5);
  assert.equal(down.scrollTop, 50);
});

test('splitPan: edges report the unused rest', () => {
  const top = splitPan({ ...base, delta: -100, scrollTop: 0, linesAbove: 2 });
  assert.equal(top.lines, -2);
  near(top.rest, -60);
  assert.equal(top.carry, 0);
  const bottom = splitPan({ ...base, delta: 80, scrollTop: 170, linesBelow: 0 });
  assert.equal(bottom.scrollTop, 200);
  near(bottom.rest, 50);
  const none = splitPan({ ...base, delta: -10, scrollTop: 0, linesAbove: 0 });
  assert.deepEqual(none, { scrollTop: 0, lines: 0, carry: 0, rest: -10 });
  const noLines = splitPan({ ...base, delta: -10, scrollTop: 0, lineHeight: 0 });
  assert.equal(noLines.lines, 0);
  assert.equal(noLines.rest, -10);
});

test('releaseVelocity uses only the last ~100 ms of moves', () => {
  const samples = [
    { t: 0, x: 0, y: 0 }, // too old
    { t: 900, x: 0, y: 500 },
    { t: 950, x: 10, y: 450 },
    { t: 1000, x: 20, y: 400 },
  ];
  const v = releaseVelocity(samples, 1000);
  near(v.vx, 0.2);
  near(v.vy, -1);
  assert.deepEqual(releaseVelocity(samples.slice(0, 1), 1000), { vx: 0, vy: 0 });
  assert.deepEqual(releaseVelocity(samples, 1300), { vx: 0, vy: 0 }); // finger held still before lifting
  assert.deepEqual(releaseVelocity([], 0), { vx: 0, vy: 0 });
});

test('snapCarry keeps the sub-pixel the browser dropped when it snapped scrollTop', () => {
  near(snapCarry(10.3, 10), 0.3);
  near(snapCarry(10.3, 10.8), -0.5);
  assert.equal(snapCarry(12, 12), 0);
  assert.equal(snapCarry(50, 40), 0); // a real difference (clamped, or moved elsewhere): no carry
  assert.equal(snapCarry(NaN, 3), 0);
});

test('a very slow drag still moves once the carried sub-pixels add up', () => {
  // A browser that only lands on whole px (floors), and a drag of 0.3 px per event.
  let actual = 100;
  let carry = 0;
  for (let i = 0; i < 10; i++) {
    const r = splitPan({ ...base, delta: 0.3, scrollTop: actual + carry, linesBelow: 0 });
    const desired = r.scrollTop;
    actual = Math.floor(desired);
    carry = snapCarry(desired, actual);
  }
  near(actual + carry, 103); // without the carry it would still sit at 100
  assert.ok(actual >= 102, `${actual}`); // it really moved, the remainder is carried
});

test('releaseVelocity is capped, so bursty events cannot launch a runaway fling', () => {
  const v = releaseVelocity([{ t: 1000, x: 0, y: 0 }, { t: 1000.5, x: -300, y: 200 }], 1000.5);
  near(v.vx, -MAX_VELOCITY);
  near(v.vy, MAX_VELOCITY);
});

test('flingStep decays and stops under the threshold', () => {
  near(flingStep(10), 10 * FLING_DECAY);
  near(flingStep(-10), -10 * FLING_DECAY);
  near(flingStep(10, FRAME_MS * 2), 10 * FLING_DECAY ** 2); // a late frame decays more
  assert.equal(flingStep(FLING_STOP), 0);
  assert.equal(flingStep(0), 0);
  let v = 40;
  let frames = 0;
  while (v) { v = flingStep(v); frames++; }
  assert.ok(frames > 10 && frames < 200, `${frames} frames`);
});

test('C1: splitPan drops the carry when the pan reverses (no dead zone)', () => {
  // 10 px carried from scrolling up; a 5 px move down must move 5 px down, not cancel out
  const down = splitPan({ ...base, delta: 5, scrollTop: 0, linesAbove: 40, linesBelow: 10, carry: -10 });
  assert.equal(down.lines, 0);
  near(down.carry, 5);
  const down2 = splitPan({ ...base, delta: 15, scrollTop: 0, linesAbove: 40, linesBelow: 10, carry: down.carry });
  assert.equal(down2.lines, 1);
  // and the other way round
  const up = splitPan({ ...base, delta: -5, scrollTop: 0, linesAbove: 40, linesBelow: 10, carry: 15 });
  near(up.carry, -5);
  // same direction keeps accumulating
  near(splitPan({ ...base, delta: -5, scrollTop: 0, carry: -10 }).carry, -15);
});

test('splitPan: with nothing to scroll the whole delta comes back unused', () => {
  const flat = { maxScrollTop: 0, linesAbove: 0, linesBelow: 0, lineHeight: 20, carry: 0, scrollTop: 0 };
  assert.deepEqual(splitPan({ ...flat, delta: -30 }), { scrollTop: 0, lines: 0, carry: 0, rest: -30 });
  assert.deepEqual(splitPan({ ...flat, delta: 30 }), { scrollTop: 0, lines: 0, carry: 0, rest: 30 });
});

test('flingStep with dt <= 0 (or junk) neither moves nor grows', () => {
  assert.equal(flingStep(10, 0), 10);
  assert.equal(flingStep(10, -50), 10);
  assert.equal(flingStep(-10, -1e6), -10);
  assert.equal(flingStep(10, NaN), 10);
});

test('B10: reduced motion decays faster', () => {
  assert.ok(FLING_DECAY_REDUCED < FLING_DECAY);
  near(flingStep(10, FRAME_MS, FLING_DECAY_REDUCED), 10 * FLING_DECAY_REDUCED);
  const frames = (decay) => { let v = 40; let n = 0; while (v) { v = flingStep(v, FRAME_MS, decay); n++; } return n; };
  assert.ok(frames(FLING_DECAY_REDUCED) < frames(FLING_DECAY) / 2);
});

test('B8: latestVisible when xterm is in its history or the area is scrolled up', () => {
  const atEnd = { viewportY: 100, baseY: 100, scrollTop: 600, scrollHeight: 1000, clientHeight: 400 };
  assert.equal(latestVisible(atEnd), false);
  assert.equal(latestVisible({ ...atEnd, viewportY: 90 }), true);
  assert.equal(latestVisible({ ...atEnd, scrollTop: 300 }), true); // zoomed in, area scrolled up
  assert.equal(latestVisible({ ...atEnd, scrollTop: 599.5 }), false); // sub-pixel short of the end
  assert.equal(latestVisible({ ...atEnd, scrollHeight: 400, scrollTop: 0 }), false); // nothing to scroll
});
