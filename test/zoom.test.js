import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_ZOOM, MAX_ZOOM, ZOOM_STEP, MIN_FIT_SCALE,
  clampZoom, fitScale, effectiveScale, zoomIn, zoomOut, zoomLabel,
  pinchScale, anchoredScroll, wheelScale, readZoomPref, saveZoomPref,
  pinchStep, zoomAriaLabel,
} from '../public/zoom.js';

// In-memory stand-in for localStorage; `fail` makes every call throw like a blocked storage,
// `failRemove` only removeItem.
function memStorage(init = {}, { fail = false, failRemove = false } = {}) {
  const data = new Map(Object.entries(init));
  return {
    data,
    getItem(k) { if (fail) throw new Error('blocked'); return data.has(k) ? data.get(k) : null; },
    setItem(k, v) { if (fail) throw new Error('blocked'); data.set(k, String(v)); },
    removeItem(k) { if (fail || failRemove) throw new Error('blocked'); data.delete(k); },
  };
}

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} !~ ${b}`);

test('constants match the design', () => {
  assert.equal(MIN_ZOOM, 0.25);
  assert.equal(MAX_ZOOM, 2);
  assert.equal(ZOOM_STEP, 1.25);
  assert.equal(MIN_FIT_SCALE, 0.5);
});

test('clampZoom keeps zoom inside the manual range and rejects junk', () => {
  assert.equal(clampZoom(0.1), MIN_ZOOM);
  assert.equal(clampZoom(5), MAX_ZOOM);
  assert.equal(clampZoom(0.8), 0.8);
  assert.equal(clampZoom(NaN), 1);
  assert.equal(clampZoom('2'), 1);
  assert.equal(clampZoom(Infinity), 1);
});

test('fitScale fits the width with a 0.5 floor', () => {
  assert.equal(fitScale(400, 800), 0.5);
  assert.equal(fitScale(300, 1600), MIN_FIT_SCALE); // would be 0.1875, clamped
  assert.equal(fitScale(1000, 500), 2); // narrow terminal grows to fill the width
  assert.equal(fitScale(0, 800), 1); // not laid out yet
  assert.equal(fitScale(400, 0), 1);
});

test('effectiveScale: fit computes, manual keeps its zoom', () => {
  assert.equal(effectiveScale({ mode: 'fit', zoom: 1 }, 400, 800), 0.5);
  assert.equal(effectiveScale({ mode: 'manual', zoom: 0.3 }, 400, 800), 0.3);
  assert.equal(effectiveScale({ mode: 'manual', zoom: 9 }, 400, 800), MAX_ZOOM);
});

test('zoomIn/zoomOut step by 1.25 from the current scale, clamped, and switch to manual', () => {
  assert.deepEqual(zoomIn(0.5), { mode: 'manual', zoom: 0.625 });
  assert.deepEqual(zoomOut(0.5), { mode: 'manual', zoom: 0.4 });
  assert.deepEqual(zoomIn(1.9), { mode: 'manual', zoom: MAX_ZOOM });
  assert.deepEqual(zoomOut(0.3), { mode: 'manual', zoom: MIN_ZOOM });
  assert.deepEqual(zoomIn(MAX_ZOOM), { mode: 'manual', zoom: MAX_ZOOM });
  // Repeated steps land back on round numbers (no 0.9999999 drift).
  assert.equal(zoomOut(zoomIn(1).zoom).zoom, 1);
  assert.equal(zoomIn(zoomIn(zoomOut(zoomOut(1).zoom).zoom).zoom).zoom, 1);
});

test('zoomLabel shows Fit, or a whole percentage with a Fit reminder', () => {
  assert.equal(zoomLabel({ mode: 'fit', zoom: 1 }), 'Fit');
  assert.equal(zoomLabel({ mode: 'manual', zoom: 0.85 }), '85% · Fit');
  assert.equal(zoomLabel({ mode: 'manual', zoom: 0.625 }), '63% · Fit');
  assert.equal(zoomLabel({ mode: 'manual', zoom: 2 }), '200% · Fit');
});

test('pinchScale scales by the finger-distance ratio, clamped', () => {
  near(pinchScale(1, 100, 150), 1.5);
  near(pinchScale(0.5, 200, 100), 0.25);
  assert.equal(pinchScale(1, 100, 1000), MAX_ZOOM);
  assert.equal(pinchScale(1, 100, 1), MIN_ZOOM);
  assert.equal(pinchScale(0.8, 0, 50), 0.8); // degenerate start distance
});

test('anchoredScroll keeps the content point under the anchor in place', () => {
  // Point under the finger: content x = (100 + 50) / 1 = 150; after 2x it sits at 300, so scroll 250.
  assert.deepEqual(
    anchoredScroll({ fromScale: 1, toScale: 2, scrollLeft: 100, scrollTop: 40, fromX: 50, fromY: 60, toX: 50, toY: 60 }),
    { scrollLeft: 250, scrollTop: 140 },
  );
  // The anchor moving (two-finger drag) pans with it.
  assert.deepEqual(
    anchoredScroll({ fromScale: 1, toScale: 1, scrollLeft: 100, scrollTop: 0, fromX: 50, fromY: 10, toX: 80, toY: 10 }),
    { scrollLeft: 70, scrollTop: 0 },
  );
  // Never negative.
  assert.deepEqual(
    anchoredScroll({ fromScale: 2, toScale: 0.5, scrollLeft: 0, scrollTop: 0, fromX: 10, fromY: 10, toX: 10, toY: 10 }),
    { scrollLeft: 0, scrollTop: 0 },
  );
});

test('wheelScale zooms in on wheel up and out on wheel down, clamped', () => {
  assert.ok(wheelScale(1, -100) > 1);
  assert.ok(wheelScale(1, 100) < 1);
  assert.equal(wheelScale(1, 0), 1);
  assert.equal(wheelScale(MAX_ZOOM, -1000), MAX_ZOOM);
  assert.equal(wheelScale(MIN_ZOOM, 1000), MIN_ZOOM);
  near(wheelScale(wheelScale(1, -100), 100), 1); // symmetric
});

test('readZoomPref defaults to fit', () => {
  assert.deepEqual(readZoomPref(memStorage()), { mode: 'fit', zoom: 1 });
  assert.deepEqual(readZoomPref(null), { mode: 'fit', zoom: 1 });
});

test('readZoomPref reads and validates hr.zoom', () => {
  assert.deepEqual(readZoomPref(memStorage({ 'hr.zoom': '{"mode":"manual","zoom":0.8}' })), { mode: 'manual', zoom: 0.8 });
  assert.deepEqual(readZoomPref(memStorage({ 'hr.zoom': '{"mode":"manual","zoom":7}' })), { mode: 'manual', zoom: MAX_ZOOM });
  assert.deepEqual(readZoomPref(memStorage({ 'hr.zoom': '{"mode":"fit","zoom":0.8}' })), { mode: 'fit', zoom: 1 });
  assert.deepEqual(readZoomPref(memStorage({ 'hr.zoom': 'not json' })), { mode: 'fit', zoom: 1 });
  assert.deepEqual(readZoomPref(memStorage({ 'hr.zoom': '{"mode":"weird"}' })), { mode: 'fit', zoom: 1 });
  assert.deepEqual(readZoomPref(memStorage({ 'hr.zoom': 'null' })), { mode: 'fit', zoom: 1 });
});

test('readZoomPref migrates the old hr.fit value and removes it', () => {
  const s100 = memStorage({ 'hr.fit': '100' });
  assert.deepEqual(readZoomPref(s100), { mode: 'manual', zoom: 1 });
  assert.equal(s100.data.has('hr.fit'), false);
  assert.deepEqual(JSON.parse(s100.data.get('hr.zoom')), { mode: 'manual', zoom: 1 });

  const sFit = memStorage({ 'hr.fit': 'fit' });
  assert.deepEqual(readZoomPref(sFit), { mode: 'fit', zoom: 1 });
  assert.equal(sFit.data.has('hr.fit'), false);
  assert.deepEqual(JSON.parse(sFit.data.get('hr.zoom')), { mode: 'fit', zoom: 1 });

  // hr.zoom wins over a leftover hr.fit.
  const both = memStorage({ 'hr.fit': '100', 'hr.zoom': '{"mode":"fit","zoom":1}' });
  assert.deepEqual(readZoomPref(both), { mode: 'fit', zoom: 1 });
});

test('storage that throws never breaks reading or saving', () => {
  const s = memStorage({ 'hr.fit': '100' }, { fail: true });
  assert.deepEqual(readZoomPref(s), { mode: 'fit', zoom: 1 });
  assert.doesNotThrow(() => saveZoomPref(s, { mode: 'manual', zoom: 1.5 }));
  assert.doesNotThrow(() => saveZoomPref(null, { mode: 'manual', zoom: 1.5 }));
});

test('saveZoomPref round-trips through readZoomPref', () => {
  const s = memStorage();
  saveZoomPref(s, { mode: 'manual', zoom: 1.5625 });
  assert.deepEqual(readZoomPref(s), { mode: 'manual', zoom: 1.5625 });
  saveZoomPref(s, { mode: 'fit', zoom: 1 });
  assert.deepEqual(readZoomPref(s), { mode: 'fit', zoom: 1 });
});

// Content coordinate (unscaled px) currently under area point (x, y).
const contentAt = (st, x, y) => [(st.scrollLeft + x) / st.scale, (st.scrollTop + y) / st.scale];

test('pinchStep: over a sequence of frames the content under the midpoint stays put', () => {
  const frames = [
    { dist: 100, x: 200, y: 300 },
    { dist: 120, x: 210, y: 300 },
    { dist: 150, x: 220, y: 310 },
    { dist: 140, x: 215, y: 305 },
    { dist: 200, x: 220, y: 310 },
  ];
  let st = { scale: 1, scrollLeft: 100, scrollTop: 50 };
  const origin = contentAt(st, frames[0].x, frames[0].y);
  for (let i = 1; i < frames.length; i++) {
    st = pinchStep({ ...st, prev: frames[i - 1], next: frames[i] });
    const [cx, cy] = contentAt(st, frames[i].x, frames[i].y);
    near(cx, origin[0]);
    near(cy, origin[1]);
  }
  near(st.scale, 2);
});

test('pinchStep: clamps at the limits and keeps the anchor at the effective ratio', () => {
  const prev = { dist: 100, x: 100, y: 100 };
  const st = pinchStep({ scale: 1.9, scrollLeft: 300, scrollTop: 300, prev, next: { dist: 200, x: 100, y: 100 } });
  assert.equal(st.scale, MAX_ZOOM);
  near(contentAt(st, 100, 100)[0], (300 + 100) / 1.9);
  // Spreading further at the limit only follows the midpoint.
  const at = pinchStep({ ...st, prev: { dist: 200, x: 100, y: 100 }, next: { dist: 400, x: 120, y: 100 } });
  assert.equal(at.scale, MAX_ZOOM);
  near(at.scrollLeft, st.scrollLeft - 20);
  const low = pinchStep({ scale: 0.3, scrollLeft: 0, scrollTop: 0, prev, next: { dist: 10, x: 100, y: 100 } });
  assert.equal(low.scale, MIN_ZOOM);
});

test('pinchStep: a native scroll between frames is kept, not overwritten', () => {
  const prev = { dist: 100, x: 150, y: 150 };
  const same = { dist: 100, x: 150, y: 150 };
  const a = pinchStep({ scale: 1, scrollLeft: 200, scrollTop: 100, prev, next: same });
  const b = pinchStep({ scale: 1, scrollLeft: 230, scrollTop: 110, prev, next: same }); // browser panned 30/10
  near(b.scrollLeft - a.scrollLeft, 30);
  near(b.scrollTop - a.scrollTop, 10);
  const bigger = { dist: 200, x: 150, y: 150 };
  const c = pinchStep({ scale: 1, scrollLeft: 200, scrollTop: 100, prev, next: bigger });
  const d = pinchStep({ scale: 1, scrollLeft: 230, scrollTop: 100, prev, next: bigger });
  near(d.scrollLeft - c.scrollLeft, 60); // the delta scales with the zoom
});

test('pinchStep native: the browser owns the pan, so a pure two-finger translation leaves our scroll alone', () => {
  const st = pinchStep({
    scale: 1, scrollLeft: 230, scrollTop: 110, native: true, // browser already scrolled for the move
    prev: { dist: 100, x: 150, y: 150 }, next: { dist: 100, x: 180, y: 160 },
  });
  assert.equal(st.scale, 1);
  near(st.scrollLeft, 230);
  near(st.scrollTop, 110);
});

test('pinchStep native: a spread zooms about the CURRENT midpoint with no translation of ours', () => {
  const live = { scale: 1, scrollLeft: 230, scrollTop: 110 };
  const next = { dist: 200, x: 180, y: 160 };
  const st = pinchStep({ ...live, native: true, prev: { dist: 100, x: 150, y: 150 }, next });
  near(st.scale, 2);
  const [bx, by] = contentAt(live, next.x, next.y);
  const [ax, ay] = contentAt(st, next.x, next.y);
  near(ax, bx);
  near(ay, by);
});

test('pinchStep non-native (default) still follows the midpoint from prev to next', () => {
  const args = { scale: 1, scrollLeft: 200, scrollTop: 100, prev: { dist: 100, x: 150, y: 150 }, next: { dist: 100, x: 180, y: 160 } };
  const st = pinchStep(args);
  near(st.scrollLeft, 170);
  near(st.scrollTop, 90);
  assert.deepEqual(pinchStep({ ...args, native: false }), st);
});

test('pinchStep: a degenerate distance leaves the scale alone', () => {
  const st = pinchStep({ scale: 0.8, scrollLeft: 10, scrollTop: 10, prev: { dist: 0, x: 0, y: 0 }, next: { dist: 50, x: 0, y: 0 } });
  assert.equal(st.scale, 0.8);
});

test('zoomAriaLabel names the current zoom and the action', () => {
  assert.equal(zoomAriaLabel({ mode: 'manual', zoom: 0.8 }, 0.8), 'Zoom 80%, fit to width');
  assert.equal(zoomAriaLabel({ mode: 'fit', zoom: 1 }, 0.5), 'Zoom 50%, fitted to width');
  assert.equal(zoomAriaLabel({ mode: 'fit', zoom: 1 }, 2.6), 'Zoom 260%, fitted to width'); // narrow terminal, wide screen
});

test('migration still returns the migrated value when removeItem throws', () => {
  const s = memStorage({ 'hr.fit': '100' }, { failRemove: true });
  assert.deepEqual(readZoomPref(s), { mode: 'manual', zoom: 1 });
  assert.deepEqual(JSON.parse(s.data.get('hr.zoom')), { mode: 'manual', zoom: 1 });
});

test('C2: gestures from a Fit scale above MAX_ZOOM start from MAX_ZOOM', () => {
  // − from a 300% fit steps down from 200%, not to 200%
  assert.deepEqual(zoomOut(3), { mode: 'manual', zoom: tidyStep(MAX_ZOOM / ZOOM_STEP) });
  // a pinch-in at 300% fit continues from 200%, a pinch-out stays at the max
  const prev = { dist: 100, x: 50, y: 50 };
  near(pinchStep({ scale: 3, scrollLeft: 0, scrollTop: 0, prev, next: { dist: 90, x: 50, y: 50 } }).scale, MAX_ZOOM * 0.9);
  assert.equal(pinchStep({ scale: 3, scrollLeft: 0, scrollTop: 0, prev, next: { dist: 110, x: 50, y: 50 } }).scale, MAX_ZOOM);
  // the content under the fingers is still anchored from the real starting scale
  const st = pinchStep({ scale: 3, scrollLeft: 300, scrollTop: 0, prev, next: { dist: 90, x: 50, y: 50 } });
  near(st.scrollLeft, (300 + 50) * (MAX_ZOOM * 0.9 / 3) - 50);
  // Ctrl+wheel out from 300% fit
  near(wheelScale(3, 300), MAX_ZOOM / 2);
  assert.equal(wheelScale(3, -300), MAX_ZOOM);
  // ordinary scales are unchanged
  near(pinchScale(1.5, 100, 90), 1.35);
});

const tidyStep = (n) => Math.round(n * 1e6) / 1e6;
