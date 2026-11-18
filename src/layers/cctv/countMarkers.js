import {
  cellCenter,
  formatCameraCount,
  mergeCountCells,
} from '../../data/cctvCellCounts.js';
import { WORLD_OVERLAY_STYLE } from '../../overlays/worldOverlayTokens.js';
import {
  CAMERA_GREEN,
  IDLE_CAMERA_ICON,
  COUNT_BASE_PX,
  COUNT_PX_PER_DECADE,
  COUNT_MIN_HEIGHT_PX,
  COUNT_MAX_HEIGHT_PX,
  COUNT_TEXT_PADDING_PX,
  COUNT_GLYPH_MIN_PX,
  COUNT_GLYPH_MAX_PX,
  COUNT_GLYPH_TOP_MIN_PX,
  COUNT_GLYPH_TOP_MAX_PX,
  COUNT_GLYPH_PADDING_PX,
  COUNT_LABEL_DROP,
  COUNT_MERGE_GAP_PX,
  COUNT_SINGLE_ICON_PX,
  COUNT_MERGE_PASSES,
} from './policy.js';

const FONT = WORLD_OVERLAY_STYLE.fontTitle;
// Reserve the camera's landscape slot even while the map sprite is loading.
const GLYPH_ASPECT = 1.5;
const RING_PX = 2;
const RIM_PX = 1;
const STROKE_INSET = RIM_PX + RING_PX / 2;
const SINGLE_ICON = Object.freeze({
  width: COUNT_SINGLE_ICON_PX,
  height: COUNT_SINGLE_ICON_PX,
});

/** Apply the billboard's RGB tint to the sprite and find its painted bounds. */
function rasterizeGlyph(canvas, image, size, dpr, color) {
  if (!canvas) return null;
  // The artwork occupies just over half the height of the square SVG viewport.
  const side = 2 * Math.ceil(size * dpr);
  canvas.width = canvas.height = side;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(image, 0, 0, side, side);
  const pixels = ctx.getImageData(0, 0, side, side);
  const { data } = pixels;
  const rgb = Number.parseInt(color.slice(1), 16);
  const red = (rgb >> 16) / 255;
  const green = ((rgb >> 8) & 255) / 255;
  const blue = (rgb & 255) / 255;
  let left = side,
    top = side,
    right = -1,
    bottom = -1;
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const i = (y * side + x) * 4;
      if (!data[i + 3]) continue;
      data[i] *= red;
      data[i + 1] *= green;
      data[i + 2] *= blue;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = y;
    }
  }
  if (right < 0) return null;
  ctx.putImageData(pixels, 0, 0);
  const width = right - left + 1;
  const height = bottom - top + 1;
  const scale = Math.min(size / height, (size * GLYPH_ASPECT) / width);
  return {
    canvas,
    left,
    top,
    width,
    height,
    drawWidth: width * scale,
    drawHeight: height * scale,
  };
}

/** Load the map artwork once, then share each tinted device-density raster. */
export function createCameraGlyphCache(createCanvas, source, onLoad) {
  const glyphs = new Map();
  let image;
  let ready = false;
  return (size, dpr, color) => {
    if (!image && typeof Image !== 'undefined') {
      image = new Image();
      image.onload = () => {
        ready = true;
        onLoad?.();
      };
      image.src = source;
    }
    if (!ready) return null;
    const key = `${size}:${dpr}:${color}`;
    if (!glyphs.has(key)) {
      glyphs.set(key, rasterizeGlyph(createCanvas(), image, size, dpr, color));
    }
    return glyphs.get(key);
  };
}

/** Merged camera groups and their last painted hit rectangles in CSS pixels. */
export function createCountMarkers(
  registerPaintLane,
  id,
  refreshView,
  createCanvas = () => globalThis.document?.createElement('canvas'),
) {
  let dpr = Math.max(1, Number(globalThis.window?.devicePixelRatio) || 1);
  const markers = [];
  const hits = [];
  const textMetrics = new Map();
  const fonts = globalThis.document?.fonts;
  let measureCtx;
  let hitCount = 0;
  const lane = registerPaintLane?.('ambient-label', paint, {
    id,
    active: false,
    target: 'shared',
  });
  const glyphFor = createCameraGlyphCache(
    createCanvas,
    IDLE_CAMERA_ICON,
    () => {
      if (!markers.length) return;
      refreshGlyphs();
      lane?.requestPaint();
    },
  );
  fonts?.addEventListener?.('loadingdone', fontsLoaded);

  /** Font changes can widen a pill enough to merge it with its neighbor. */
  function fontsLoaded() {
    textMetrics.clear();
    if (!markers.length) return;
    refreshView();
    lane?.requestPaint();
  }

  /** Seat the glyph under the top of the ring and the count just below centre. */
  function sizeFor(count) {
    const text = formatCameraCount(count);
    let metrics = textMetrics.get(text);
    if (!metrics) {
      measureCtx ??= createCanvas()?.getContext('2d');
      if (measureCtx) {
        measureCtx.font = FONT;
        measureCtx.textBaseline = 'middle';
        metrics = measureCtx.measureText(text);
      } else {
        metrics = { width: text.length * 8 };
      }
      textMetrics.set(text, metrics);
    }
    const diameter = COUNT_BASE_PX + COUNT_PX_PER_DECADE * Math.log10(count);
    const clamped = Math.max(
      COUNT_MIN_HEIGHT_PX,
      Math.min(COUNT_MAX_HEIGHT_PX, diameter),
    );
    const height = 2 * Math.round(clamped / 2);
    const grown =
      (height - COUNT_MIN_HEIGHT_PX) /
      (COUNT_MAX_HEIGHT_PX - COUNT_MIN_HEIGHT_PX);
    const glyphHeight =
      COUNT_GLYPH_MIN_PX + (COUNT_GLYPH_MAX_PX - COUNT_GLYPH_MIN_PX) * grown;
    const radius = height / 2 - RIM_PX - RING_PX;
    const glyphTop =
      COUNT_GLYPH_TOP_MIN_PX +
      (COUNT_GLYPH_TOP_MAX_PX - COUNT_GLYPH_TOP_MIN_PX) * grown -
      radius;
    // Width-only metrics use half the 12 px type size on each side of the baseline.
    const ascent = metrics.actualBoundingBoxAscent ?? 6;
    const descent = metrics.actualBoundingBoxDescent ?? 6;
    const labelY = COUNT_LABEL_DROP * radius + (ascent - descent) / 2;
    // Each row must clear the ring at the edge where the circle is narrowest.
    const chordAt = (y) => 2 * Math.sqrt(Math.max(0, radius ** 2 - y ** 2));
    const extra = Math.max(
      0,
      Math.ceil(
        Math.max(
          metrics.width + 2 * COUNT_TEXT_PADDING_PX - chordAt(labelY + descent),
          glyphHeight * GLYPH_ASPECT +
            2 * COUNT_GLYPH_PADDING_PX -
            chordAt(glyphTop),
        ),
      ),
    );
    return {
      text,
      width: height + extra,
      height,
      glyphHeight,
      glyphBottom: glyphTop + glyphHeight,
      labelY,
    };
  }

  /** Reuse marker slots in ground-key order, and invalidate only changed frames. */
  function update(cells, project) {
    // Lone cameras take part so that one beside a count joins it.
    let visible = cells.slice().sort((a, b) => a.key.localeCompare(b.key));
    const footprint = (count) => (count > 1 ? sizeFor(count) : SINGLE_ICON);
    for (
      let pass = 0;
      pass < COUNT_MERGE_PASSES && visible.length > 1;
      pass++
    ) {
      const merged = mergeCountCells(
        visible,
        project,
        footprint,
        COUNT_MERGE_GAP_PX,
      );
      if (merged.length === visible.length) break;
      visible = merged;
    }
    // A lone camera that is no longer its own entry now counts in a marker.
    const apart = new Set(visible);
    for (const cell of cells)
      if (cell.count === 1) cell.absorbed = !apart.has(cell);
    visible = visible.filter((cell) => cell.count > 1);
    let changed = visible.length !== markers.length;
    for (let i = 0; i < visible.length; i++) {
      const cell = visible[i];
      const marker = markers[i] ?? (markers[i] = { focus: 1 });
      const last = marker.cell;
      const size = sizeFor(cell.count);
      if (
        !last ||
        last.count !== cell.count ||
        last.latSum !== cell.latSum ||
        last.lonSum !== cell.lonSum ||
        last.heightSum !== cell.heightSum
      ) {
        marker.pos = cellCenter(cell);
        changed = true;
      } else if (
        last.west !== cell.west ||
        last.east !== cell.east ||
        last.south !== cell.south ||
        last.north !== cell.north ||
        last.low !== cell.low ||
        last.high !== cell.high
      ) {
        changed = true;
      }
      changed ||=
        size.text !== marker.text ||
        size.width !== marker.width ||
        size.glyphBottom !== marker.glyphBottom ||
        size.labelY !== marker.labelY;
      marker.cell = cell;
      Object.assign(marker, size);
      marker.glyph = glyphFor(size.glyphHeight, dpr, CAMERA_GREEN);
      // Paint never grows the hit buffer, even when a pan reveals every group.
      hits[i] ??= {};
    }
    markers.length = visible.length;
    // Keep the last frame pickable until the host clears its pixels.
    lane?.setActive(markers.length > 0 || hitCount > 0);
    if (changed) lane?.requestPaint();
  }

  /** Attach the raster for the current overlay density to each visible group. */
  function refreshGlyphs() {
    for (const marker of markers)
      marker.glyph = glyphFor(marker.glyphHeight, dpr, CAMERA_GREEN);
  }

  /** Draw at device density using the host's CSS-pixel transform and projection. */
  function paint(frame) {
    if (!markers.length) {
      // Deactivating invalidates the host, so finish the shared frame first.
      if (hitCount) queueMicrotask(deactivateIfEmpty);
      hitCount = 0;
      return;
    }
    hitCount = 0;
    const { ctx, occluder, viewProjectionMatrix: m } = frame;
    if (dpr !== frame.dpr) {
      dpr = frame.dpr;
      refreshGlyphs();
    }
    ctx.save();
    try {
      ctx.font = FONT;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (let i = 0; i < markers.length; i++) {
        const marker = markers[i];
        const { height } = marker;
        const { x: px, y: py, z: pz } = marker.pos;
        const w = m[3] * px + m[7] * py + m[11] * pz + m[15];
        if (!(w > 0) || (occluder && !occluder.isPointVisible(marker.pos)))
          continue;
        const x =
          (0.5 + (0.5 * (m[0] * px + m[4] * py + m[8] * pz + m[12])) / w) *
          frame.width;
        const y =
          (0.5 - (0.5 * (m[1] * px + m[5] * py + m[9] * pz + m[13])) / w) *
          frame.height;
        const rect = hits[hitCount];
        rect.x = x - marker.width / 2;
        rect.y = y - height / 2;
        rect.w = marker.width;
        rect.h = height;
        if (
          rect.x >= frame.width ||
          rect.y >= frame.height ||
          rect.x + rect.w <= 0 ||
          rect.y + rect.h <= 0 ||
          frame.overlapsHardUi(rect)
        )
          continue;
        ctx.globalAlpha = marker.focus;
        ctx.beginPath();
        ctx.roundRect(
          rect.x + STROKE_INSET,
          rect.y + STROKE_INSET,
          rect.w - 2 * STROKE_INSET,
          height - 2 * STROKE_INSET,
          height / 2 - STROKE_INSET,
        );
        ctx.strokeStyle = 'rgba(8, 14, 20, 0.85)';
        ctx.lineWidth = RING_PX + 2 * RIM_PX;
        ctx.stroke();
        ctx.fillStyle = '#0e1720';
        ctx.fill();
        ctx.strokeStyle = CAMERA_GREEN;
        ctx.lineWidth = RING_PX;
        ctx.stroke();
        ctx.fillStyle = CAMERA_GREEN;
        const glyph = marker.glyph;
        if (glyph) {
          ctx.drawImage(
            glyph.canvas,
            glyph.left,
            glyph.top,
            glyph.width,
            glyph.height,
            x - glyph.drawWidth / 2,
            y + marker.glyphBottom - glyph.drawHeight,
            glyph.drawWidth,
            glyph.drawHeight,
          );
        }
        ctx.fillText(marker.text, x, y + marker.labelY);
        rect.cell = marker.cell;
        hitCount++;
      }
    } finally {
      ctx.restore();
    }
  }

  /** Resolve the topmost group actually painted at this screen position. */
  function pickedCell(point) {
    if (!point) return null;
    for (let i = hitCount - 1; i >= 0; i--) {
      const rect = hits[i];
      if (
        point.x >= rect.x &&
        point.x <= rect.x + rect.w &&
        point.y >= rect.y &&
        point.y <= rect.y + rect.h
      )
        return rect.cell;
    }
    return null;
  }

  /** A new group may already have arrived since the empty frame. */
  function deactivateIfEmpty() {
    if (!markers.length) lane?.setActive(false);
  }

  /** Release the visible groups and clear their hit targets immediately. */
  function hide() {
    markers.length = hits.length = hitCount = 0;
    lane?.setActive(false);
  }

  /** Unhook this viewer's painter and its font listener. */
  function dispose() {
    markers.length = hits.length = hitCount = 0;
    fonts?.removeEventListener?.('loadingdone', fontsLoaded);
    lane?.unregister();
  }

  return {
    markers,
    update,
    pickedCell,
    hide,
    dispose,
    requestPaint: () => lane?.requestPaint(),
  };
}
