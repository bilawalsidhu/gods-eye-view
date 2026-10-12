import * as Cesium from 'cesium';
import { destinationPointDeg } from './model.js';
import {
  DIRECTION_CONE_M,
  DIRECTION_CONE_HALF_ANGLE_DEG,
  MARKER_SCALE_BY_DISTANCE,
} from './policy.js';
import { t } from '../../i18n/index.js';

/**
 * Badge scale at a camera distance, matching Cesium's NearFarScalar for the
 * native badges (linear between near and far, clamped outside).
 * @param {number} distanceM Camera-to-marker distance.
 * @returns {number} Scale factor.
 */
export function markerScale(distanceM) {
  const [near, nearScale, far, farScale] = MARKER_SCALE_BY_DISTANCE;
  if (!Number.isFinite(distanceM) || distanceM <= near) return nearScale;
  if (distanceM >= far) return farScale;
  return (
    nearScale + ((distanceM - near) / (far - near)) * (farScale - nearScale)
  );
}

// Camera artwork and visual treatment contributed by Manjunath (@manjunath22466).
// Module-relative assets also resolve when the layer is consumed by another app.
export const MARKER_IMAGE = new URL(
  './assets/alpr-marker-normal.png',
  import.meta.url,
).href;
export const SELECTED_IMAGE = new URL(
  './assets/alpr-marker-selected.png',
  import.meta.url,
).href;
export const BRACKETS_IMAGE = new URL(
  './assets/alpr-marker-selected-brackets.png',
  import.meta.url,
).href;

/** Compact display label; selection identity always uses the full record id. */
export function alprDisplayId(record) {
  if (!Number.isSafeInteger(record.osmId))
    return t('sensors.alpr.displayFallback');
  // The ALPR-<osm tail> form is selection identity shorthand; it stays tokens.
  return `ALPR-${String(record.osmId).slice(-4).padStart(4, '0')}`;
}

/** Show only supplied metadata, with the actual source named for custom adapters. */
export function alprLabelDetails(record, source) {
  const sourceName =
    source.attribution?.name ||
    source.label ||
    t('sensors.alpr.sourceFallback');
  const details = [
    sourceName === 'OpenStreetMap'
      ? t('sensors.alpr.osmMapped')
      : t('sensors.alpr.sourceNamed', { name: sourceName }),
  ];
  if (Number.isFinite(record.directionDeg))
    details.push(
      t('sensors.alpr.direction', { deg: Math.round(record.directionDeg) }),
    );
  const equipment = [
    ...new Set(
      [record.manufacturer, record.operator, record.cameraType]
        .map((value) =>
          String(value || '')
            .trim()
            .toUpperCase(),
        )
        .filter(Boolean),
    ),
  ];
  if (equipment.length) details.push(equipment.join(' · '));
  if (sourceName === 'OpenStreetMap')
    details.push(t('sensors.alpr.publicMapData'));
  return details;
}

/**
 * Illustrative bearing wedge, not measured field of view or operating range.
 * @param {object} record Camera record.
 * @param {number} [heightM] Apex height.
 * @param {function(number, number): (number|null)} [heightAt] Optional height
 *   for the two far corners (degrees lat, lon), so the wedge follows a slope
 *   instead of floating level from the apex; falls back to the apex height.
 * @returns {Array<Cesium.Cartesian3>|null} Apex, left and right corners.
 */
export function directionWedgePositions(record, heightM = 0, heightAt = null) {
  if (!Number.isFinite(record.directionDeg)) return null;
  const left = destinationPointDeg(
    record.latitude,
    record.longitude,
    record.directionDeg - DIRECTION_CONE_HALF_ANGLE_DEG,
    DIRECTION_CONE_M,
  );
  const right = destinationPointDeg(
    record.latitude,
    record.longitude,
    record.directionDeg + DIRECTION_CONE_HALF_ANGLE_DEG,
    DIRECTION_CONE_M,
  );
  const corner = (point) => {
    const height = heightAt?.(point.latitude, point.longitude);
    return Number.isFinite(height) ? height : heightM;
  };
  return [
    Cesium.Cartesian3.fromDegrees(record.longitude, record.latitude, heightM),
    Cesium.Cartesian3.fromDegrees(left.longitude, left.latitude, corner(left)),
    Cesium.Cartesian3.fromDegrees(
      right.longitude,
      right.latitude,
      corner(right),
    ),
  ];
}

/** Paint the original cyan/coral gradient with a crisp V-shaped boundary. */
export function paintDirectionWedge(ctx, origin, left, right, selected) {
  const rgb = selected ? '255, 100, 116' : '82, 212, 255';
  const gradient = ctx.createLinearGradient(
    origin.x,
    origin.y,
    (left.x + right.x) / 2,
    (left.y + right.y) / 2,
  );
  const alpha = selected ? [0.8, 0.48, 0.22, 0.06] : [0.34, 0.2, 0.09, 0.025];
  [0, 0.36, 0.72, 1].forEach((stop, i) =>
    gradient.addColorStop(stop, `rgba(${rgb}, ${alpha[i]})`),
  );
  ctx.beginPath();
  ctx.moveTo(origin.x, origin.y);
  ctx.lineTo(left.x, left.y);
  ctx.lineTo(right.x, right.y);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(left.x, left.y);
  ctx.lineTo(origin.x, origin.y);
  ctx.lineTo(right.x, right.y);
  ctx.strokeStyle = `rgba(${rgb}, ${selected ? 0.98 : 0.76})`;
  ctx.lineWidth = selected ? 2.5 : 1.5;
  ctx.lineJoin = 'round';
  ctx.stroke();
}

/** Reject transient tile/terrain samples outside plausible mapped ground heights. */
export function validAlprGroundHeight(height) {
  return Number.isFinite(height) && height >= -500 && height <= 10000;
}
