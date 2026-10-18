import { buildWaterfallPalette } from './palette.js';
import { WATERFALL_BINS, fractionOfFrequency } from './protocol.js';

/**
 * Scrolling waterfall plus a tuning marker, drawn to two canvases.
 *
 * Rows arrive as one byte per bin (dB + 255). The display range follows the
 * data (a slow percentile tracker) so the picture is usable on any receiver
 * without the user hunting for min/max dB.
 */
const DRAG_THRESHOLD_PX = 4;
const WHEEL_INTERVAL_MS = 120;
const PAN_INTERVAL_MS = 100;

export function createWaterfall({
  canvas,
  overlay,
  onTune,
  onZoom,
  onPan,
  onHover,
  now = () => Date.now(),
}) {
  canvas.width = WATERFALL_BINS;
  overlay.width = WATERFALL_BINS;
  // The canvas is scrolled and rewritten row by row, so keep it on the CPU:
  // GPU-backed canvases make every putImageData wait on the shared GPU, which
  // stalls the page whenever the globe is also rendering.
  const ctx = canvas.getContext('2d', {
    alpha: false,
    willReadFrequently: true,
  });
  const palette = buildWaterfallPalette();
  const row = ctx.createImageData(WATERFALL_BINS, 1);
  let floorDb = -110;
  let ceilDb = -40;
  let tuning = null; // { freqKhz, low, high }
  let view = { zoom: 0, centerKhz: 15000, fullKhz: 30000 };
  let hasData = false;
  let hoverFraction = null;

  ctx.fillStyle = '#000004';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  function track(bins) {
    // 10th percentile ~ noise floor, 99th ~ strong signals; eased so the
    // colours do not flicker from row to row.
    const sorted = Uint8Array.from(bins).sort();
    const lo = sorted[Math.floor(sorted.length * 0.1)] - 255;
    const hi = sorted[Math.floor(sorted.length * 0.99)] - 255;
    floorDb += (lo - 3 - floorDb) * 0.05;
    ceilDb += (Math.max(hi, lo + 25) + 3 - ceilDb) * 0.05;
  }

  function drawMarker() {
    const o = overlay.getContext('2d');
    o.clearRect(0, 0, overlay.width, overlay.height);
    if (!tuning) return;
    const x = fractionOfFrequency(tuning.freqKhz, view);
    if (x === null) return;
    const span = view.fullKhz / 2 ** view.zoom;
    const px = x * overlay.width;
    const lowPx = (tuning.low / 1000 / span) * overlay.width;
    const highPx = (tuning.high / 1000 / span) * overlay.width;
    const left = px + Math.min(lowPx, highPx);
    const width = Math.max(2, Math.abs(highPx - lowPx));
    o.fillStyle = 'rgba(255, 255, 255, 0.18)';
    o.fillRect(left, 0, width, overlay.height);
    o.fillStyle = '#ffffff';
    o.fillRect(Math.round(px) - 1, 0, 2, overlay.height);
  }

  function drawHover() {
    drawMarker();
    if (hoverFraction === null) return;
    const o = overlay.getContext('2d');
    const px = Math.round(hoverFraction * overlay.width);
    o.fillStyle = 'rgba(255, 214, 10, 0.9)';
    o.fillRect(px, 0, 1, overlay.height);
  }

  const fractionOf = (event) => {
    const rect = overlay.getBoundingClientRect();
    if (!rect.width) return null;
    return Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
  };

  // Pointer handling: a press that barely moves is a click (tune); a press
  // that moves is a drag (pan the zoomed view).
  let press = null; // { x, lastX, dragging, pendingPan, lastFlush }
  function flushPan(force = false) {
    if (!press || !press.pendingPan) return;
    if (!force && now() - press.lastFlush < PAN_INTERVAL_MS) return;
    const delta = press.pendingPan;
    press.pendingPan = 0;
    press.lastFlush = now();
    onPan?.(delta);
  }
  function onPointerDown(event) {
    if (event.button !== undefined && event.button !== 0) return;
    press = {
      x: event.clientX,
      lastX: event.clientX,
      dragging: false,
      pendingPan: 0,
      lastFlush: 0,
    };
    try {
      overlay.setPointerCapture?.(event.pointerId);
    } catch {
      /* synthetic or already released pointer */
    }
  }
  function onPointerMove(event) {
    const fraction = fractionOf(event);
    if (fraction === null) return;
    if (press) {
      if (
        !press.dragging &&
        Math.abs(event.clientX - press.x) >= DRAG_THRESHOLD_PX
      ) {
        press.dragging = true;
        overlay.classList.add('is-dragging');
      }
      if (press.dragging) {
        const rect = overlay.getBoundingClientRect();
        press.pendingPan += (event.clientX - press.lastX) / rect.width;
        press.lastX = event.clientX;
        flushPan();
        return;
      }
    }
    hoverFraction = fraction;
    drawHover();
    onHover?.(fraction);
  }
  function onPointerUp(event) {
    if (!press) return;
    const wasDrag = press.dragging;
    if (wasDrag) flushPan(true);
    press = null;
    overlay.classList.remove('is-dragging');
    try {
      overlay.releasePointerCapture?.(event.pointerId);
    } catch {
      /* already released */
    }
    if (!wasDrag) {
      const fraction = fractionOf(event);
      if (fraction !== null) onTune?.(fraction);
    }
  }
  function onPointerCancel() {
    press = null;
    overlay.classList.remove('is-dragging');
  }
  function onLeave() {
    if (press) return;
    hoverFraction = null;
    drawMarker();
    onHover?.(null);
  }
  let lastWheelAt = 0;
  function onWheel(event) {
    const fraction = fractionOf(event);
    if (fraction === null || !onZoom) return;
    event.preventDefault();
    const t = now();
    if (t - lastWheelAt < WHEEL_INTERVAL_MS) return;
    lastWheelAt = t;
    onZoom(fraction, event.deltaY < 0 ? 1 : -1);
  }
  overlay.addEventListener('pointerdown', onPointerDown);
  overlay.addEventListener('pointermove', onPointerMove);
  overlay.addEventListener('pointerup', onPointerUp);
  overlay.addEventListener('pointercancel', onPointerCancel);
  overlay.addEventListener('pointerleave', onLeave);
  overlay.addEventListener('wheel', onWheel, { passive: false });

  return {
    addRow(bins) {
      if (!bins?.length) return;
      track(bins);
      const range = Math.max(10, ceilDb - floorDb);
      const w = row.width;
      for (let x = 0; x < w; x++) {
        const src = Math.min(
          bins.length - 1,
          Math.floor((x * bins.length) / w),
        );
        const db = bins[src] - 255;
        const level = Math.max(
          0,
          Math.min(255, ((db - floorDb) / range) * 255),
        );
        const p = Math.round(level) * 3;
        const o = x * 4;
        row.data[o] = palette[p];
        row.data[o + 1] = palette[p + 1];
        row.data[o + 2] = palette[p + 2];
        row.data[o + 3] = 255;
      }
      // Scroll down one pixel and paint the newest row on top.
      ctx.drawImage(
        canvas,
        0,
        0,
        canvas.width,
        canvas.height - 1,
        0,
        1,
        canvas.width,
        canvas.height - 1,
      );
      ctx.putImageData(row, 0, 0);
      hasData = true;
    },
    setView(next) {
      view = { ...next };
      // A new zoom/centre invalidates the old history.
      ctx.fillStyle = '#000004';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      drawHover();
    },
    setTuning(next) {
      tuning = next;
      drawHover();
    },
    get hasData() {
      return hasData;
    },
    destroy() {
      overlay.removeEventListener('pointerdown', onPointerDown);
      overlay.removeEventListener('pointermove', onPointerMove);
      overlay.removeEventListener('pointerup', onPointerUp);
      overlay.removeEventListener('pointercancel', onPointerCancel);
      overlay.removeEventListener('pointerleave', onLeave);
      overlay.removeEventListener('wheel', onWheel);
    },
  };
}
