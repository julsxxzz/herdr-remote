// Zoom maths for the live view: no DOM here, so it runs under `node --test` too.
// A zoom state is { mode: 'fit' | 'manual', zoom: number }; fit follows the screen width,
// manual keeps a fixed scale the user picked with the buttons, a pinch or Ctrl+wheel.

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 2;
export const ZOOM_STEP = 1.25;
// Fit never shrinks text below this; a wider terminal pans horizontally instead (ruling R14).
export const MIN_FIT_SCALE = 0.5;

const STORAGE_KEY = 'hr.zoom';
const OLD_STORAGE_KEY = 'hr.fit'; // before zoom: 'fit' or '100'
const DEFAULT_STATE = Object.freeze({ mode: 'fit', zoom: 1 });

// Rounds away float drift so 1 → ×1.25 → ÷1.25 lands on 1 again.
const tidy = (n) => Math.round(n * 1e6) / 1e6;

export function clampZoom(z) {
  if (typeof z !== 'number' || !Number.isFinite(z)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

export function fitScale(containerWidth, naturalWidth) {
  if (!(containerWidth > 0) || !(naturalWidth > 0)) return 1;
  return Math.max(containerWidth / naturalWidth, MIN_FIT_SCALE);
}

export function effectiveScale(state, containerWidth, naturalWidth) {
  return state.mode === 'fit' ? fitScale(containerWidth, naturalWidth) : clampZoom(state.zoom);
}

// Fit can exceed MAX_ZOOM (a narrow terminal on a wide screen). A zoom gesture starting
// there starts from MAX_ZOOM, so − or a pinch-in steps down from 200% instead of landing on it.
const gestureBase = (scale) => Math.min(scale, MAX_ZOOM);

export const zoomIn = (scale) => ({ mode: 'manual', zoom: clampZoom(tidy(gestureBase(scale) * ZOOM_STEP)) });
export const zoomOut = (scale) => ({ mode: 'manual', zoom: clampZoom(tidy(gestureBase(scale) / ZOOM_STEP)) });

// The middle chip: 'Fit' when fitted, else the percentage plus a reminder that a tap fits.
export function zoomLabel(state) {
  return state.mode === 'fit' ? 'Fit' : `${Math.round(clampZoom(state.zoom) * 100)}% · Fit`;
}

// New scale for a pinch that started at startScale with the fingers startDist apart.
export function pinchScale(startScale, startDist, dist) {
  if (!(startDist > 0) || !(dist > 0)) return clampZoom(startScale);
  return clampZoom(gestureBase(startScale) * (dist / startDist));
}

// Scroll offsets that put the content that was under (fromX, fromY) at fromScale under
// (toX, toY) at toScale. Coordinates are relative to the scroll container's top-left.
export function anchoredScroll({ fromScale, toScale, scrollLeft, scrollTop, fromX, fromY, toX, toY }) {
  const ratio = toScale / fromScale;
  return {
    scrollLeft: Math.max(0, (scrollLeft + fromX) * ratio - toX),
    scrollTop: Math.max(0, (scrollTop + fromY) * ratio - toY),
  };
}

// One pinch frame, incremental: the zoom ratio comes from the previous frame's finger
// distance and the anchor is the previous → current midpoint, applied to the LIVE scroll
// offsets, so a native scroll the browser did between frames combines with the zoom.
// prev/next: { dist, x, y } with x, y relative to the scroll container.
// native: the touchmove couldn't be cancelled, so the browser already panned by the
// midpoint's movement; then we only zoom about the current midpoint (no translation of
// our own, or the movement would count twice).
export function pinchStep({ scale, scrollLeft, scrollTop, prev, next, native = false }) {
  const toScale = pinchScale(scale, prev.dist, next.dist);
  const from = native ? next : prev;
  return {
    scale: toScale,
    ...anchoredScroll({ fromScale: scale, toScale, scrollLeft, scrollTop, fromX: from.x, fromY: from.y, toX: next.x, toY: next.y }),
  };
}

export function zoomAriaLabel(state, scale) {
  const pct = Math.round((Number.isFinite(scale) && scale > 0 ? scale : 1) * 100); // Fit may exceed MAX_ZOOM
  return state.mode === 'fit' ? `Zoom ${pct}%, fitted to width` : `Zoom ${pct}%, fit to width`;
}

// Ctrl/⌘ + wheel: deltaY < 0 (wheel up / trackpad spread) zooms in. 300 px of delta doubles the scale.
export function wheelScale(scale, deltaY) {
  if (!Number.isFinite(deltaY)) return clampZoom(scale);
  return clampZoom(gestureBase(scale) * 2 ** (-deltaY / 300));
}

function parseState(raw) {
  let v;
  try { v = JSON.parse(raw); } catch { return null; }
  if (!v || typeof v !== 'object') return null;
  if (v.mode === 'fit') return { ...DEFAULT_STATE };
  if (v.mode === 'manual') return { mode: 'manual', zoom: clampZoom(v.zoom) };
  return null;
}

// Reads the per-device choice; migrates the old Fit/100% toggle once. Never throws.
export function readZoomPref(storage) {
  if (!storage) return { ...DEFAULT_STATE };
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (raw !== null) return parseState(raw) ?? { ...DEFAULT_STATE };
    const old = storage.getItem(OLD_STORAGE_KEY);
    if (old === null) return { ...DEFAULT_STATE };
    const state = old === '100' ? { mode: 'manual', zoom: 1 } : { ...DEFAULT_STATE };
    saveZoomPref(storage, state);
    try { storage.removeItem(OLD_STORAGE_KEY); } catch { /* the migrated value still stands */ }
    return state;
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export function saveZoomPref(storage, state) {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(state.mode === 'manual' ? { mode: 'manual', zoom: clampZoom(state.zoom) } : DEFAULT_STATE));
  } catch { /* storage unavailable */ }
}
