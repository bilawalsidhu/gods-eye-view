import * as Cesium from 'cesium';
import {
  appendCornerBracket,
  measureLabelCard,
  nearFarScale,
  rectIntersectsAny,
} from '../../data/detectionDraw.js';
import { keyholeLabelAlphaFromGeometry } from '../../celestialRing.js';
import {
  DETECTION_STYLE,
  DETECTION_THEME_MAP,
} from '../../overlays/worldOverlayTokens.js';
import { citsSpeedBucket } from './model.js';

/**
 * Always-on detection brackets for C-ITS trams.
 *
 * Draws the same corner brackets, mono callout cards, theme colours and
 * keyhole fade as the global detect mode, but only for this layer's
 * trams and with a richer two-line card (line and destination on top;
 * vehicle number, speed, heading and report age below). Private vehicles are
 * anonymous dots and never get a bracket or card. Stands down while the global detect
 * mode is on, which already brackets these vehicles via getDetectableObjects.
 */

/** Station kinds that get a bracket by default. */
export const CITS_BRACKET_KINDS = Object.freeze(new Set(['tram']));
/** Brackets beyond this camera distance would only clutter the view. */
export const CITS_BRACKET_MAX_DISTANCE_M = 5_000;
/** Callout cards per frame, nearest first. */
export const CITS_BRACKET_MAX_CARDS = 24;

const BASE_HALF = Object.freeze({ tram: { w: 16, h: 9 } });

/** Detection tier key for a vehicle record. */
export function citsBracketTier(record) {
  if (record.kind === 'tram') return 'transit_tram';
  const bucket = citsSpeedBucket(record.speedKmh);
  return bucket ? `veh_${bucket}` : 'veh_nodata';
}

/** Two-line card text for one vehicle. */
export function citsBracketCard(record, now = Date.now()) {
  const primary = `TRAM ${record.line || '?'}${record.destination ? ` → ${record.destination}` : ''}`;
  const parts = [];
  if (record.vehicleNumber) parts.push(`#${record.vehicleNumber}`);
  parts.push(
    record.speedKmh != null ? `${Math.round(record.speedKmh)} km/h` : '– km/h',
  );
  if (record.heading != null) parts.push(`${Math.round(record.heading)}°`);
  const age = now - Date.parse(record.lastSeen || '');
  if (Number.isFinite(age))
    parts.push(
      age < 90_000
        ? `${Math.max(0, Math.round(age / 1000))}s`
        : `${Math.round(age / 60_000)}m`,
    );
  return { primary, secondary: parts.join(' · ') };
}

/**
 * Create the painter for one layer instance.
 * @param {{viewer:function():Cesium.Viewer|null, dots:function():Iterable<{point:Cesium.PointPrimitive, record:object}>, style:function():string}} deps
 */
export function createCitsBracketPainter({
  viewer,
  dots,
  style,
  maxDistance = () => CITS_BRACKET_MAX_DISTANCE_M,
}) {
  const scratch = new Cesium.Cartesian2();
  let charWidth = 0;

  return function paint(frame) {
    const scene = viewer()?.scene;
    const ctx = frame?.ctx;
    if (!scene || !ctx) return;
    const width = frame.width;
    const height = frame.height;
    const camera = scene.camera.positionWC;
    const theme = DETECTION_THEME_MAP[style()] || DETECTION_THEME_MAP._default;
    const tiers = theme.tiers || {};
    const now = Date.now();
    ctx.font = DETECTION_STYLE.font;
    if (!charWidth) charWidth = ctx.measureText('0000000000').width / 10 || 6;

    const visible = [];
    for (const { point, record } of dots()) {
      if (!CITS_BRACKET_KINDS.has(record.kind) || record.anonymous) continue;
      const position = point.position;
      const distance = Cesium.Cartesian3.distance(camera, position);
      if (distance > maxDistance()) continue;
      if (frame.occluder && !frame.occluder.isPointVisible(position)) continue;
      const win = Cesium.SceneTransforms.worldToWindowCoordinates(
        scene,
        position,
        scratch,
      );
      if (!win || win.x < -40 || win.y < -40) continue;
      if (win.x > width + 40 || win.y > height + 40) continue;
      const alpha = frame.keyhole
        ? keyholeLabelAlphaFromGeometry(win.x, win.y, frame.keyhole)
        : 1;
      if (alpha <= 0.02) continue;
      const scale = nearFarScale(distance, 300, 1.6, 4_000, 0.7);
      const base = BASE_HALF[record.kind];
      visible.push({
        record,
        sx: win.x,
        sy: win.y,
        halfW: base.w * scale,
        halfH: base.h * scale,
        alpha,
        distance,
        color: tiers[citsBracketTier(record)] || theme.line,
      });
    }
    if (!visible.length) return;

    // Brackets, batched by colour.
    ctx.lineWidth = 1.25;
    const byColor = new Map();
    for (const item of visible) {
      let path = byColor.get(item.color);
      if (!path) byColor.set(item.color, (path = new Path2D()));
      appendCornerBracket(path, item.sx, item.sy, item.halfW, item.halfH);
    }
    for (const [color, path] of byColor) {
      ctx.globalAlpha = 0.9;
      ctx.strokeStyle = color;
      ctx.stroke(path);
    }

    // Callout cards for the nearest vehicles, kept off each other and the UI.
    visible.sort((a, b) => a.distance - b.distance);
    const taken = [];
    const uiRects = frame.uiRects?.slice(0, frame.uiRectCount ?? 0) || [];
    let cards = 0;
    for (const item of visible) {
      if (cards >= CITS_BRACKET_MAX_CARDS) break;
      const { primary, secondary } = citsBracketCard(item.record, now);
      const card = measureLabelCard(primary, secondary, charWidth);
      const placements = [
        [item.sx + item.halfW + 6, item.sy - item.halfH - card.h - 4],
        [item.sx - item.halfW - 6 - card.w, item.sy - item.halfH - card.h - 4],
        [item.sx + item.halfW + 6, item.sy + item.halfH + 4],
        [item.sx - item.halfW - 6 - card.w, item.sy + item.halfH + 4],
      ];
      const spot = placements
        .map(([x, y]) => ({ x, y, w: card.w, h: card.h }))
        .find(
          (rect) =>
            rect.x >= 4 &&
            rect.y >= 4 &&
            rect.x + rect.w <= width - 4 &&
            rect.y + rect.h <= height - 4 &&
            !rectIntersectsAny(rect, taken, 2) &&
            !rectIntersectsAny(rect, uiRects),
        );
      if (!spot) continue;
      taken.push(spot);
      cards++;
      ctx.globalAlpha = item.alpha;
      ctx.fillStyle = theme.calloutPlate || theme.labelBg;
      ctx.fillRect(spot.x, spot.y, spot.w, spot.h);
      ctx.fillStyle = item.color;
      ctx.fillRect(spot.x, spot.y, 3, spot.h);
      ctx.strokeStyle = item.color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      const leadX = spot.x < item.sx ? spot.x + spot.w : spot.x;
      const leadY = spot.y < item.sy ? spot.y + spot.h : spot.y;
      ctx.moveTo(
        item.sx + (spot.x < item.sx ? -item.halfW : item.halfW),
        item.sy + (spot.y < item.sy ? -item.halfH : item.halfH),
      );
      ctx.lineTo(leadX, leadY);
      ctx.stroke();
      ctx.font = DETECTION_STYLE.font;
      ctx.fillStyle = theme.label;
      ctx.fillText(primary, spot.x + card.textX, spot.y + card.idBase);
      ctx.font = DETECTION_STYLE.microFont;
      ctx.fillStyle = theme.dim || theme.label;
      ctx.fillText(secondary, spot.x + card.textX, spot.y + card.subBase);
    }
    ctx.globalAlpha = 1;
  };
}
