import * as geo from '../../geo/index.js';
import { msg } from '../../i18n/index.js';
import { boxContains } from './model.js';
import {
  LAYER_ID,
  MAX_RENDERED,
  MAX_VIEWPORT_DEGREES,
  SELECTED_MARKER_ICON_SIZE,
} from './policy.js';
import { alprDisplayId, alprLabelDetails } from './visuals.js';

/**
 * Bounded nearby coverage around the ground point at the centre of the view.
 * The horizon rectangle is unstable during low-angle orbits and can exclude
 * that point; the camera-to-ground range keeps zoom-out queries capped.
 * @param {{latitude:number, longitude:number}} location Focus, radians.
 * @param {number} range Camera-to-focus distance in metres.
 * @returns {{south:number, west:number, north:number, east:number}|null}
 */
export function alprFocusBox(location, range) {
  const radius = Math.max(1000, 2 * range);
  const latitude = geo.math.toDegrees(location.latitude);
  const longitude = geo.math.toDegrees(location.longitude);
  const latSpan = radius / 111000;
  const lonSpan = latSpan / Math.cos(location.latitude);
  if (
    !Number.isFinite(latSpan + lonSpan) ||
    2 * Math.max(latSpan, lonSpan) > MAX_VIEWPORT_DEGREES ||
    Math.abs(latitude) + latSpan > 90 ||
    Math.abs(longitude) + lonSpan > 180
  )
    return null;
  return {
    south: latitude - latSpan,
    west: longitude - lonSpan,
    north: latitude + latSpan,
    east: longitude + lonSpan,
  };
}

/**
 * Records a view box would display, nearest the box centre first when over
 * the render cap.
 * @param {Array<object>} records Candidate records.
 * @param {object|null} box Viewport box in degrees.
 * @returns {{visible: Array<object>, capped: boolean}}
 */
export function alprViewRecords(records, box) {
  if (!box) return { visible: [], capped: false };
  let visible = records.filter((record) =>
    boxContains(box, {
      south: record.latitude,
      north: record.latitude,
      west: record.longitude,
      east: record.longitude,
    }),
  );
  const capped = visible.length > MAX_RENDERED;
  if (capped) {
    const lat = (box.south + box.north) / 2;
    const lon = (box.west + box.east) / 2;
    const scale = Math.cos((lat * Math.PI) / 180);
    const distance = (record) =>
      (record.latitude - lat) ** 2 + ((record.longitude - lon) * scale) ** 2;
    visible = visible
      .map((record) => ({ record, d: distance(record) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, MAX_RENDERED)
      .map((item) => item.record);
  }
  return { visible, capped };
}

/** The selected-camera card shown beside a marker. */
export function alprLabelModel(record, source, { accent, startedAt }) {
  return {
    title: alprDisplayId(record),
    details: alprLabelDetails(record, source),
    accent,
    cardStyle: 'tactical',
    selected: true,
    leaderStyle: 'elbow',
    leaderAnimationMs: 440,
    leaderAnimationStartedAt: startedAt,
    leaderDrawRatio: 0.68,
    anchorRadiusPx: SELECTED_MARKER_ICON_SIZE / 2,
    anchorRadiusScale: null,
  };
}

/** Entity-context fields for one camera record. */
export function alprEntityContext(record, source) {
  return {
    id: record.id,
    layerId: LAYER_ID,
    layerName: 'ALPR Cameras',
    source: source.attribution?.description || source.label || 'Camera source',
    label: msg('ALPR camera'),
    latitude: record.latitude,
    longitude: record.longitude,
    properties: {
      operator: record.operator,
      manufacturer: record.manufacturer,
      cameraType: record.cameraType,
      zone: record.zone,
      directionDeg: record.directionDeg,
      ref: record.ref,
      lastVerified: record.lastVerified,
      osmId: record.osmId,
      sourceTag: record.source,
    },
  };
}
