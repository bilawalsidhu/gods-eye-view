import {
  cellCenter,
  cellLonLat,
  formatCameraCount,
  mergeCountCells,
  withoutLoneCameras,
} from '../../data/cctvCellCounts.js';
import { WORLD_OVERLAY_STYLE } from '../../overlays/worldOverlayTokens.js';
import {
  CAMERA_GREEN,
  COUNT_CAMERA_ICON,
  CAMERA_ICON_PX,
  COUNT_MERGE_GAP_PX,
} from './policy.js';
import { liftedForHorizon } from '../../geo/horizon.js';

// Diameter at one camera before applying the size limits, in CSS pixels.
const COUNT_BASE_PX = 38;

// Extra diameter for each tenfold increase in camera count.
const COUNT_PX_PER_DECADE = 5;

// Minimum height of a count marker in CSS pixels.
const COUNT_MIN_HEIGHT_PX = 40;

// Maximum height of a count marker in CSS pixels.
const COUNT_MAX_HEIGHT_PX = 58;

// Clear fill between the count and the inside of the ring, in CSS pixels.
const COUNT_TEXT_PADDING_PX = 6;

// Height of the camera glyph in the smallest and the largest marker.
const COUNT_GLYPH_MIN_PX = 7.5;
const COUNT_GLYPH_MAX_PX = 10;

// Clear fill above the glyph in the smallest and the largest marker.
const COUNT_GLYPH_TOP_MIN_PX = 3;
const COUNT_GLYPH_TOP_MAX_PX = 4;

// Clear fill between the glyph's top corners and the inside of the ring.
const COUNT_GLYPH_PADDING_PX = 2;

// The middle of the digits sits this share of the inner radius below the
// marker's centre, which leaves the glyph clear of the count.
const COUNT_LABEL_DROP = 0.2;

// Merge passes per view. A merged centre and wider label can reach a further
// marker. The cap bounds work on motion ticks.
const COUNT_MERGE_PASSES = 3;
const FONT = WORLD_OVERLAY_STYLE.fontTitle;
// Reserve the camera's landscape slot even while the map sprite is loading.
const GLYPH_ASPECT = 1.5;
const RING_PX = 2;
const RIM_PX = 1;
const STROKE_INSET = RIM_PX + RING_PX / 2;
// Painted bounds of the camera art, scaled from its viewBox to source pixels.
const GLYPH_SOURCE = [3.4, 13.4, 28.1, 19.5].map((v) => (v * 48) / 36);
const GLYPH_SOURCE_ASPECT = 28.1 / 19.5;

/** Merged camera groups and their last painted hit rectangles in CSS pixels. */
export function createCountMarkers(
  registerPaintLane,
  id,
  refreshView,
  keyholeAlpha,
) {
  let hardUi = null;
  let sprite = null;
  let spriteReady = false;
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
  function loadSprite() {
    if (sprite || typeof Image === 'undefined') return;
    sprite = new Image();
    sprite.onload = () => {
      spriteReady = true;
      if (markers.length) lane?.requestPaint();
    };
    sprite.src = COUNT_CAMERA_ICON;
  }
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
      measureCtx ??= globalThis.document
        .createElement('canvas')
        .getContext('2d');
      measureCtx.font = FONT;
      measureCtx.textBaseline = 'middle';
      metrics = measureCtx.measureText(text);
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
    const ascent = metrics.actualBoundingBoxAscent;
    const descent = metrics.actualBoundingBoxDescent;
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

  /** Keep covered icons in the restored count if its new label clears the HUD. */
  function retainCoveredCameras(group, core, project) {
    const anchor = cellCenter(core);
    const at = project(anchor);
    if (!at) return core;
    const { x, y } = at; // The projector reuses its result.
    const size = sizeFor(core.count);
    const halfSegment = (size.width - size.height) / 2;
    const covered = group.lone.filter((lone) => {
      const p = project(cellCenter(lone));
      if (!p) return false;
      // The pill outline that merging measures, without its gap.
      const dx = Math.max(
        0,
        Math.abs(p.x + (lone.offsetPx ?? 0) - x) - halfSegment,
      );
      const reach = (size.height + (lone.iconPx ?? CAMERA_ICON_PX)) / 2;
      return dx * dx + (p.y - y) ** 2 < reach * reach;
    });
    if (!covered.length) return core;
    const { width, height } = sizeFor(core.count + covered.length);
    if (hardUi({ x: x - width / 2, y: y - height / 2, w: width, h: height }))
      return core;
    const held = withoutLoneCameras(group, covered);
    held.anchor = anchor;
    held.groundM = core.groundM;
    for (const lone of covered) lone.absorbed = true;
    return held;
  }

  /**
   * Reuse marker slots in ground-key order, and invalidate only changed frames.
   * `groundHeight(lon, lat)` gives the drawn terrain in metres, or a non-finite
   * value where it has not loaded. A count stands on that ground when available
   * and otherwise uses its cameras' mean mount height.
   */
  function update(cells, project, groundHeight = null) {
    // Lone cameras take part so that one beside a count joins it.
    let visible = cells.slice().sort((a, b) => a.key.localeCompare(b.key));
    const footprint = (count, cell) => {
      if (count > 1) return sizeFor(count);
      const px = cell.iconPx ?? CAMERA_ICON_PX;
      return { width: px, height: px };
    };
    /** A lone camera keeps its icon's own position; a count goes to ground. */
    const ground = (list) => {
      if (!groundHeight) return;
      for (const cell of list) {
        if (cell.count === 1 || cell.groundM !== undefined) continue;
        const { lon, lat } = cellLonLat(cell);
        const height = groundHeight(lon, lat);
        cell.groundM = Number.isFinite(height) ? Math.round(height) : null;
      }
    };
    for (
      let pass = 0;
      pass < COUNT_MERGE_PASSES &&
      visible.length > 1 &&
      visible.some((cell) => cell.count > 1);
      pass++
    ) {
      ground(visible);
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
    ground(visible);
    let changed = visible.length !== markers.length;
    for (let i = 0; i < visible.length; i++) {
      let cell = visible[i];
      // If the merged count is under the HUD, restore the count and its lone icons.
      if (hardUi && cell.lone?.length) {
        const at = project(cellCenter(cell));
        const { width, height } = sizeFor(cell.count);
        const rect = at && {
          x: at.x - width / 2,
          y: at.y - height / 2,
          w: width,
          h: height,
        };
        if (rect && hardUi(rect)) {
          for (const lone of cell.lone) lone.absorbed = false;
          const core = withoutLoneCameras(cell);
          if (core) {
            ground([core]);
            cell = retainCoveredCameras(cell, core, project);
            cell.releasedAt = rect;
          }
        }
      }
      const marker = (markers[i] ??= { focus: 1 });
      const last = marker.cell;
      const size = sizeFor(cell.count);
      if (
        !last ||
        last.count !== cell.count ||
        last.latSum !== cell.latSum ||
        last.lonSum !== cell.lonSum ||
        last.heightSum !== cell.heightSum ||
        last.groundM !== cell.groundM ||
        last.anchor?.x !== cell.anchor?.x ||
        last.anchor?.y !== cell.anchor?.y ||
        last.anchor?.z !== cell.anchor?.z
      ) {
        marker.pos = cell.anchor ?? cellCenter(cell);
        marker.cullPos = liftedForHorizon(marker.pos);
        marker.hudHidden = undefined;
        changed = true;
      }
      changed ||=
        size.text !== marker.text ||
        size.width !== marker.width ||
        size.glyphBottom !== marker.glyphBottom ||
        size.labelY !== marker.labelY;
      marker.cell = cell;
      Object.assign(marker, size);
      // Paint never grows the hit buffer, even when a pan reveals every group.
      hits[i] ??= {};
    }
    markers.length = visible.length;
    if (markers.length) loadSprite();
    // Keep the last frame pickable until the host clears its pixels.
    lane?.setActive(markers.length > 0 || hitCount > 0);
    if (changed) lane?.requestPaint();
  }

  /** Draw at device density using the host's CSS-pixel transform and projection. */
  function paint(frame) {
    hardUi = frame.overlapsHardUi ?? hardUi;
    if (!markers.length) {
      // Deactivating invalidates the host, so finish the shared frame first.
      if (hitCount) queueMicrotask(deactivateIfEmpty);
      hitCount = 0;
      return;
    }
    hitCount = 0;
    const { ctx, occluder, viewProjectionMatrix: m } = frame;
    let refresh = false;
    ctx.save();
    try {
      ctx.font = FONT;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (let i = 0; i < markers.length; i++) {
        const marker = markers[i];
        // The core can stay visible while the HUD uncovers the merged count.
        if (marker.cell.releasedAt) refresh ||= !hardUi(marker.cell.releasedAt);
        const { height } = marker;
        const { x: px, y: py, z: pz } = marker.pos;
        const w = m[3] * px + m[7] * py + m[11] * pz + m[15];
        if (!(w > 0) || (occluder && !occluder.isPointVisible(marker.cullPos)))
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
          rect.y + rect.h <= 0
        )
          continue;
        const hidden = Boolean(hardUi?.(rect));
        const previous = marker.hudHidden;
        if (previous !== hidden) {
          marker.hudHidden = hidden;
          // The active icon steps aside only for visible counts beside it.
          refresh ||=
            ((hidden || previous !== undefined) && marker.besideActive) ||
            marker.cell.lone?.some((cell) => cell.absorbed === hidden);
        }
        if (hidden) continue;
        const fade =
          frame.keyhole && keyholeAlpha ? keyholeAlpha(x, y, frame.keyhole) : 1;
        if (!(fade > 0)) continue;
        ctx.globalAlpha = marker.focus * fade;
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
        if (spriteReady) {
          const width = marker.glyphHeight * GLYPH_SOURCE_ASPECT;
          ctx.drawImage(
            sprite,
            ...GLYPH_SOURCE,
            x - width / 2,
            y + marker.glyphBottom - marker.glyphHeight,
            width,
            marker.glyphHeight,
          );
        }
        ctx.fillText(marker.text, x, y + marker.labelY);
        rect.cell = marker.cell;
        hitCount++;
      }
    } finally {
      ctx.restore();
    }
    if (refresh) queueMicrotask(refreshView);
  }

  /** Resolve the topmost group actually painted at this screen position. */
  function pickedCell(point) {
    if (!point) return null;
    for (let i = hitCount - 1; i >= 0; i--) {
      const rect = hits[i];
      const radius = rect.h / 2;
      // Distance from the pill's horizontal centre segment.
      const dx = Math.max(
        0,
        Math.abs(point.x - (rect.x + rect.w / 2)) - (rect.w - rect.h) / 2,
      );
      const dy = point.y - (rect.y + radius);
      if (dx * dx + dy * dy <= radius * radius) return rect.cell;
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
    hide();
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
