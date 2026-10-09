/**
 * Marker and ambient-label presentation for the Alpine station layer.
 *
 * Deliberately free of Cesium, for two reasons. The band colours have to be
 * the same values the rail legend renders, so they stay CSS strings and the
 * renderer converts; and everything here is then testable under `node --test`
 * without a WebGL context.
 */

import {
  formatParameter,
  parameterBand,
  parameterProminence,
  parameterValue,
  windCompass,
} from './parameters.js';
import { isReporting, isStale } from './records.js';

export const ALPINE_OVERLAY_SOURCE_ID = 'alpine-stations';

/**
 * Ambient labels are dropped past this distance.
 *
 * Pulled back over half of Europe, several hundred numbers is not a picture of
 * the weather. The markers themselves keep rendering, so the network stays
 * visible as a network; only the readings stop competing for space.
 */
export const ALPINE_OVERLAY_MAX_DISTANCE_M = 420_000;

/** Labels the allocator will place, and how many may collide for a slot. */
export const ALPINE_OVERLAY_COHORT_LIMIT = 96;
export const ALPINE_OVERLAY_COLLISION_CAPACITY = 48;

/** Marker size in pixels, from the view's neutral band to its extreme. */
export const MARKER_MIN_PX = 6;
export const MARKER_MAX_PX = 15;

/**
 * Wind arrows run larger than the dots they replace: a head has to show its
 * direction, which a disc of the same area does not have to do.
 */
export const ARROW_MIN_PX = 16;
export const ARROW_MAX_PX = 30;

/**
 * Below this the arrow is dropped and the station draws as a dot.
 *
 * A vane in still air is reporting noise, and pointing an arrow with it would
 * assert a direction the station never really measured. 2 km/h is inside the
 * reporting resolution of all three networks.
 */
export const WIND_ARROW_CALM_FLOOR_MS = 0.6;

/** A station that is reporting, but not the parameter currently selected. */
export const UNMEASURED_ACCENT = '#55636d';

/** A station that is silent, or whose newest reading is too old to present. */
export const OFFLINE_ACCENT = '#3f484f';

/**
 * How a station draws under one parameter view.
 *
 * Three states are kept apart on purpose, because they mean different things
 * and collapsing them would assert readings that do not exist:
 *
 *   `value`       a current reading for the selected parameter
 *   `unmeasured`  the station is reporting, but not this parameter
 *   `offline`     the station is silent, or its newest reading is stale
 */
export function stationMarker(station, view, { now = Date.now() } = {}) {
  if (!isReporting(station) || isStale(station, now)) {
    return {
      state: 'offline',
      accent: OFFLINE_ACCENT,
      pixelSize: MARKER_MIN_PX,
      value: null,
      band: null,
    };
  }
  const value = parameterValue(station, view);
  if (value === null) {
    return {
      state: 'unmeasured',
      accent: UNMEASURED_ACCENT,
      pixelSize: MARKER_MIN_PX,
      value: null,
      band: null,
    };
  }
  const band = parameterBand(value, view);
  const prominence = parameterProminence(value, view);
  return {
    state: 'value',
    accent: band?.accent ?? UNMEASURED_ACCENT,
    pixelSize: Math.round(
      MARKER_MIN_PX + prominence * (MARKER_MAX_PX - MARKER_MIN_PX),
    ),
    value,
    band,
  };
}

/**
 * The ambient label for a station: the reading, and nothing else.
 *
 * One card per station was the first cut of this and it buried the map — at
 * Alpine zoom the detail boxes covered the country. The reading alone is what
 * the map is for; the rest of a station belongs on the rail card.
 */
export function stationLabel(station, view, marker) {
  if (marker.state !== 'value') return null;
  const text = formatParameter(marker.value, view);
  if (!text) return null;
  if (view.id !== 'wind') return text;
  const compass = windCompass(station.windDirDeg);
  return compass ? `${text} ${compass}` : text;
}

/**
 * How a station's wind arrow draws, or null when it should stay a dot.
 *
 * `bearingDeg` is where the wind is GOING. Every one of these networks
 * publishes the direction the wind blows FROM, per the WMO convention, so the
 * arrow is the reverse of the published figure; the card and the label keep
 * the meteorological reading ("22 km/h W" is wind FROM the west).
 *
 * Four things must all hold, and each omission is deliberate: this is the wind
 * view, the station has a current reading, it has a working vane, and the air
 * is actually moving.
 */
export function stationArrow(station, view, marker) {
  if (view.id !== 'wind' || marker.state !== 'value') return null;
  if (!Number.isFinite(station?.windDirDeg)) return null;
  if (!Number.isFinite(station.windSpeedMs)) return null;
  if (station.windSpeedMs < WIND_ARROW_CALM_FLOOR_MS) return null;
  return {
    bearingDeg: (station.windDirDeg + 180) % 360,
    pixelSize: Math.round(
      ARROW_MIN_PX +
        parameterProminence(marker.value, view) * (ARROW_MAX_PX - ARROW_MIN_PX),
    ),
  };
}

/**
 * Build one ambient-label overlay entry.
 *
 * `interactive: false`: these are readouts that surface by proximity, not
 * click targets. Station selection is the rail card's list, which is also the
 * only place that can show a station the camera is not pointed at.
 */
export function createStationOverlayEntry({
  station,
  position,
  title,
  accent,
  prominence = 0,
}) {
  return {
    id: station.id,
    source: ALPINE_OVERLAY_SOURCE_ID,
    position,
    variant: 'label',
    title,
    accent,
    // A remarkable reading wins the collision budget over an ordinary one.
    priority: Math.round(prominence * 1000),
    collisionGroup: 'ambient-label',
    paintLane: 'ambient-label',
    interactive: false,
    maxDistance: ALPINE_OVERLAY_MAX_DISTANCE_M,
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
    gapPx: 14,
    verticalOnly: true,
    placement: 'above',
  };
}

/** Keep the most remarkable readings, with stable identity as the tie-break. */
export function selectOverlayCohort(
  entries,
  limit = ALPINE_OVERLAY_COHORT_LIMIT,
) {
  const cap = Math.max(
    0,
    Math.min(ALPINE_OVERLAY_COHORT_LIMIT, Math.floor(Number(limit) || 0)),
  );
  if (!Array.isArray(entries) || cap === 0) return [];
  return [...entries]
    .sort(
      (a, b) =>
        b.priority - a.priority || String(a.id).localeCompare(String(b.id)),
    )
    .slice(0, cap);
}

/**
 * Map one station to a JSON-safe analyst record.
 *
 * The analyst seam answers questions like "how cold is it in the Alps" from
 * the records already in memory, so this is on demand only and carries plain
 * values with no Cesium types.
 */
export function mapAnalystRecord(station) {
  const num = (value) => (Number.isFinite(value) ? value : null);
  return {
    id: station.id,
    name: station.label,
    network: station.networkId,
    country: station.country || null,
    region: station.region || null,
    lat: num(station.lat),
    lon: num(station.lon),
    elevationM: num(station.elevationM),
    airTempC: num(station.airTempC),
    snowDepthCm: num(station.snowDepthCm),
    precipMm: num(station.precipMm),
    pressureQffHpa: num(station.pressureQffHpa),
    humidityPct: num(station.humidityPct),
    windSpeedMs: num(station.windSpeedMs),
    windGustMs: num(station.windGustMs),
    windDirDeg: num(station.windDirDeg),
    // Epoch milliseconds, like every other analyst time field, rather than the
    // ISO string the record carries for display.
    measuredAtMs: num(Date.parse(station.measuredAt ?? '')),
  };
}
