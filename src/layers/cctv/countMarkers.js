import {
  cellCenter,
  formatCameraCount,
  mergeCountCells,
} from '../../data/cctvCellCounts.js';
import { WORLD_OVERLAY_STYLE } from '../../overlays/worldOverlayTokens.js';
import {
  COUNT_MARKER_PX,
  COUNT_MERGE_DISTANCE_PX,
  COUNT_MERGE_PASSES,
} from './policy.js';

const FONT = WORLD_OVERLAY_STYLE.fontTitle;
const RING = '#75e7ff';

/** Merged camera groups and their last painted hit rectangles in CSS pixels. */
export function createCountMarkers(registerPaintLane, id, refreshView) {
  const markers = [];
  const hits = [];
  const widths = new Map();
  const fonts = globalThis.document?.fonts;
  let measureCtx;
  let hitCount = 0;
  const lane = registerPaintLane?.('ambient-label', paint, {
    id,
    active: false,
    target: 'shared',
  });
  fonts?.addEventListener?.('loadingdone', fontsLoaded);

  /** Font changes can widen a pill enough to merge it with its neighbor. */
  function fontsLoaded() {
    widths.clear();
    if (!markers.length) return;
    refreshView();
    lane?.requestPaint();
  }

  /** Short labels fit the circle. A longer label leaves room for rounded ends. */
  function widthForText(text) {
    if (text.length <= 3) return COUNT_MARKER_PX;
    let width = widths.get(text);
    if (width === undefined) {
      measureCtx ??= document.createElement('canvas').getContext('2d');
      measureCtx.font = FONT;
      width = Math.max(
        COUNT_MARKER_PX + 1,
        Math.ceil(measureCtx.measureText(text).width) + 20,
      );
      widths.set(text, width);
    }
    return width;
  }

  /** Reuse marker slots in ground-key order, and invalidate only changed frames. */
  function update(cells, project) {
    let visible = cells
      .filter((cell) => cell.count > 1)
      .sort((a, b) => a.key.localeCompare(b.key));
    for (
      let pass = 0;
      pass < COUNT_MERGE_PASSES && visible.length > 1;
      pass++
    ) {
      const merged = mergeCountCells(
        visible,
        project,
        (count) => widthForText(formatCameraCount(count)),
        COUNT_MARKER_PX,
        COUNT_MERGE_DISTANCE_PX,
      );
      if (merged.length === visible.length) break;
      visible = merged;
    }
    let changed = visible.length !== markers.length;
    for (let i = 0; i < visible.length; i++) {
      const cell = visible[i];
      const marker = markers[i] ?? (markers[i] = { focus: 1 });
      const last = marker.cell;
      const text = formatCameraCount(cell.count);
      const width = widthForText(text);
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
      changed ||= text !== marker.text || width !== marker.width;
      marker.cell = cell;
      marker.text = text;
      marker.width = width;
      // Paint never grows the hit buffer, even when a pan reveals every group.
      hits[i] ??= {};
    }
    markers.length = visible.length;
    // Keep the last frame pickable until the host clears its pixels.
    lane?.setActive(markers.length > 0 || hitCount > 0);
    if (changed) lane?.requestPaint();
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
    const height = COUNT_MARKER_PX;
    ctx.save();
    try {
      ctx.font = FONT;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (let i = 0; i < markers.length; i++) {
        const marker = markers[i];
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
          rect.x + 2,
          rect.y + 2,
          rect.w - 4,
          height - 4,
          height / 2 - 2,
        );
        ctx.strokeStyle = 'rgba(8, 14, 20, 0.85)';
        ctx.lineWidth = 4;
        ctx.stroke();
        ctx.fillStyle = '#0e1720';
        ctx.fill();
        ctx.strokeStyle = RING;
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.fillStyle = RING;
        ctx.fillText(marker.text, x, y);
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
