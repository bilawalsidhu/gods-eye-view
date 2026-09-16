/**
 * @file Pedestrian-counter records — pure, Cesium-free, network-free.
 *
 * All time math uses the UTC `sensing_datetime`; `sensing_date` and
 * `sensing_time` are Melbourne-local display strings (a different calendar
 * day at UTC+10) and must never be sorted or subtracted.
 *
 * The count window is anchored to the FEED's own latest reading, not to wall
 * clock. The council's "past hour" feed publishes in bursts and can sit an
 * hour or more behind real time; a now-anchored window would show an empty
 * map whenever it lags. Anchoring to the feed's latest timestamp always
 * yields the most recent real snapshot, and the layer surfaces how far
 * behind that snapshot is ("as of …") rather than hiding the delay.
 */

import { COUNT_WINDOW_MINUTES, INTENSITY_TIERS } from './policy.js';

/** Window start (UTC ISO) ending at `asOfMs`, for the counts `where` clause. */
export function windowStartIso(asOfMs, windowMinutes = COUNT_WINDOW_MINUTES) {
  return new Date(asOfMs - windowMinutes * 60000).toISOString();
}

/** UTC timestamp → epoch ms, or null. */
export function parseSensingMs(value) {
  const ms = Date.parse(String(value ?? ''));
  return Number.isFinite(ms) ? ms : null;
}

function textOrNull(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

/**
 * Sensor-location rows → Map(locationId → sensor). Only located sensors
 * survive; `status === 'A'` marks a sensor the council lists as active.
 */
export function normalizeSensors(rows) {
  const byId = new Map();
  for (const row of rows || []) {
    const id = Number(row?.location_id);
    const lat = Number(row?.latitude ?? row?.location?.lat);
    const lon = Number(row?.longitude ?? row?.location?.lon);
    if (
      !Number.isInteger(id) ||
      !Number.isFinite(lat) ||
      Math.abs(lat) > 90 ||
      !Number.isFinite(lon) ||
      Math.abs(lon) > 180
    )
      continue;
    byId.set(id, {
      locationId: id,
      lat,
      lon,
      description: textOrNull(row.sensor_description) || `Sensor ${id}`,
      direction1: textOrNull(row.direction_1),
      direction2: textOrNull(row.direction_2),
      listedActive: String(row.status ?? '').toUpperCase() === 'A',
    });
  }
  return byId;
}

/** Aggregate count rows ({location_id, total}) → Map(id → total). */
export function normalizeCounts(rows) {
  const byId = new Map();
  for (const row of rows || []) {
    const id = Number(row?.location_id);
    if (!Number.isInteger(id)) continue;
    const total = Number(row?.total);
    byId.set(id, Number.isFinite(total) ? total : null);
  }
  return byId;
}

/** Intensity tier for a window total; null total → null tier. */
export function intensityTier(total) {
  if (!Number.isFinite(total)) return null;
  return INTENSITY_TIERS.findIndex((tier) => total <= tier.max);
}

/**
 * Join sensors with their windowed counts into display records. Counts are
 * already limited (by the source query) to the window ending at the feed's
 * latest reading, so a listed-active sensor that appears in `counts` reported
 * in the window (`hasRecent: true`) and one that does not is unknown — a null
 * count, never a zero. Listed-inactive sensors are dropped (not running).
 *
 * @param {Map} sensors  normalizeSensors output
 * @param {Map} counts   normalizeCounts output (window totals)
 * @param {object} meta  { asOfMs, windowMinutes }
 * @returns {Array<object>}
 */
export function mergePedestrianRecords(
  sensors,
  counts,
  { asOfMs, windowMinutes = COUNT_WINDOW_MINUTES } = {},
) {
  const records = [];
  for (const sensor of sensors.values()) {
    if (!sensor.listedActive) continue;
    const hasRow = counts.has(sensor.locationId);
    const total = hasRow ? counts.get(sensor.locationId) : null;
    const hasRecent = hasRow && Number.isFinite(total);
    records.push({
      id: `ped:${sensor.locationId}`,
      locationId: sensor.locationId,
      lat: sensor.lat,
      lon: sensor.lon,
      description: sensor.description,
      direction1: sensor.direction1,
      direction2: sensor.direction2,
      windowMinutes,
      windowTotal: hasRecent ? total : null,
      hasRecent,
      tier: intensityTier(hasRecent ? total : null),
      asOfMs: Number.isFinite(asOfMs) ? asOfMs : null,
    });
  }
  return records;
}

/** One-line count readout that always names its window; never a bare number. */
export function pedestrianCountLabel(record) {
  if (!record.hasRecent) return 'NO RECENT COUNT';
  return `LAST ${record.windowMinutes} MIN · ${record.windowTotal}`;
}
