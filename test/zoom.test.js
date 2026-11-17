import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_ZOOM, MAX_ZOOM, ZOOM_STEP, MIN_FIT_SCALE,
  clampZoom, fitScale, effectiveScale, zoomIn, zoomOut, zoomLabel,
  pinchScale, anchoredScroll, wheelScale, readZoomPref, saveZoomPref,
} from '../public/zoom.js';

// In-memory stand-in for localStorage; `fail` makes every call throw like a blocked storage.
function memStorage(init = {}, { fail = false } = {}) {
  const data = new Map(Object.entries(init));
  return {
    data,
    getItem(k) { if (fail) throw new Error('blocked'); return data.has(k) ? data.get(k) : null; },
    setItem(k, v) { if (fail) throw new Error('blocked'); data.set(k, String(v)); },
    removeItem(k) { if (fail) throw new Error('blocked'); data.delete(k); },
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

test('zoomLabel shows Fit or a whole percentage', () => {
  assert.equal(zoomLabel({ mode: 'fit', zoom: 1 }, 0.62), 'Fit');
  assert.equal(zoomLabel({ mode: 'manual', zoom: 0.85 }), '85%');
  assert.equal(zoomLabel({ mode: 'manual', zoom: 0.625 }), '63%');
  assert.equal(zoomLabel({ mode: 'manual', zoom: 2 }), '200%');
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
