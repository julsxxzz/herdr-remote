// Scroll maths for the live view: no DOM here, so it runs under `node --test` too.
// The vertical scroll range is one line: xterm's scrollback (above) followed by the
// CSS-scaled terminal area's own scroll (below). A pan walks along it without a dead zone.

export const FRAME_MS = 1000 / 60;
export const FLING_DECAY = 0.95; // velocity kept per 60 Hz frame
export const FLING_STOP = 0.5; // px per frame
export const VELOCITY_WINDOW_MS = 100;
export const MAX_VELOCITY = 6; // px/ms: a hard flick; bursty or coalesced events can't exceed it

// delta: px to scroll, positive = towards the bottom (like wheel deltaY).
// scrollTop/maxScrollTop: the area's own scroll. linesAbove/linesBelow: xterm scrollback
// lines above/below its viewport (viewportY, baseY - viewportY). lineHeight: one row in
// screen px at the current zoom. carry: fractional scrollback px from the previous call.
// Returns the new area scrollTop, the whole lines to hand to term.scrollLines() (negative
// = up), the new carry, and the px that hit an end and went unused.
export function splitPan({ delta, scrollTop, maxScrollTop, linesAbove, linesBelow, lineHeight, carry = 0 }) {
  const max = Math.max(0, maxScrollTop);
  let top = Math.min(max, Math.max(0, scrollTop));
  let rem = delta;
  let lines = 0;
  let c = 0;
  const lh = lineHeight > 0 ? lineHeight : 0;

  if (rem < 0) {
    // Up: the area's scroll first, then into the scrollback.
    const take = Math.max(rem, -top);
    top += take;
    rem -= take;
    if (rem < 0 && lh && linesAbove > 0) {
      const px = carry + rem;
      let n = Math.trunc(px / lh);
      if (n < -linesAbove) {
        n = -linesAbove;
        rem = px - n * lh;
      } else {
        c = px - n * lh;
        rem = 0;
      }
      lines = n;
    }
  } else if (rem > 0) {
    // Down: back out of the scrollback first, then the area's scroll.
    if (lh && linesBelow > 0) {
      const px = carry + rem;
      let n = Math.trunc(px / lh);
      if (n >= linesBelow) {
        n = linesBelow;
        rem = px - n * lh;
      } else {
        c = px - n * lh;
        rem = 0;
      }
      lines = n;
    }
    const take = Math.min(rem, max - top);
    if (take > 0) {
      top += take;
      rem -= take;
    }
  }
  return { scrollTop: top, lines, carry: c, rest: rem };
}

// Browsers snap scrollTop/scrollLeft to device pixels, so a very slow drag (a fraction of a
// px per event) would never move. Carry what was dropped into the next pan; a difference of
// a pixel or more is real (clamped at an end, or scrolled by something else) and is not carried.
export function snapCarry(desired, actual) {
  const d = desired - actual;
  return Number.isFinite(d) && Math.abs(d) < 1 ? d : 0;
}

// Finger velocity (px/ms) over the last VELOCITY_WINDOW_MS of samples [{ t, x, y }].
// Zero if the finger stopped moving before it lifted.
export function releaseVelocity(samples, now, windowMs = VELOCITY_WINDOW_MS) {
  const recent = samples.filter((s) => s.t >= now - windowMs);
  if (recent.length < 2) return { vx: 0, vy: 0 };
  const a = recent[0];
  const b = recent[recent.length - 1];
  const dt = b.t - a.t;
  if (!(dt > 0)) return { vx: 0, vy: 0 };
  const cap = (v) => Math.max(-MAX_VELOCITY, Math.min(MAX_VELOCITY, v));
  return { vx: cap((b.x - a.x) / dt), vy: cap((b.y - a.y) / dt) };
}

// One fling frame: decays velocity v (px per frame) for an elapsed dt; 0 once it is slow.
export function flingStep(v, dt = FRAME_MS) {
  const next = v * FLING_DECAY ** (dt / FRAME_MS);
  return Math.abs(next) < FLING_STOP ? 0 : next;
}
