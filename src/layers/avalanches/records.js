/**
 * @module avalanches/records
 * @description Pure normalizers from the upstream avalanche feeds to the one
 * shape the layer draws. Shared by the server proxy (which trims the payloads)
 * and the browser (which re-validates them), so it imports nothing.
 *
 * - Varsom / NVE forecast regions: danger level per region per day.
 * - regObs avalanche observations: release and runout points, time, size,
 *   trigger and elevations.
 * - EAWS micro-regions: forecast region polygons.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** @param {*} value Candidate. @returns {boolean} Whether it is a `YYYY-MM-DD` calendar date. */
export function isIsoDate(value) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return (
    Number.isFinite(parsed) && new Date(parsed).toISOString().startsWith(value)
  );
}

/** @param {string} from ISO date. @param {string} to ISO date. @returns {number} Whole days from `from` to `to`. */
export function daySpan(from, to) {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS,
  );
}

const finite = (value) =>
  value === null || value === undefined || value === ''
    ? null
    : Number.isFinite(Number(value))
      ? Number(value)
      : null;

const text = (value, max = 600) => {
  const clean = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return clean ? clean.slice(0, max) : null;
};

const coordinate = (lat, lon) => {
  const latitude = finite(lat);
  const longitude = finite(lon);
  if (latitude === null || longitude === null) return null;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  if (latitude === 0 && longitude === 0) return null;
  return { lat: latitude, lon: longitude };
};

/**
 * Varsom forecast regions, one entry per region with its days in date order.
 *
 * Only type-A regions are kept: those are the ones forecasters rate daily and
 * the ones EAWS publishes polygons for. Type-B regions are coarse, rarely
 * rated and have no shape to draw.
 * @param {Array<object>} payload `RegionSummary/Simple` response.
 * @returns {Array<{id:string, name:string, days:Array<{date:string, level:number, text:?string}>}>}
 */
export function normalizeVarsomRegions(payload) {
  if (!Array.isArray(payload)) throw new TypeError('invalid_forecast');
  const regions = [];
  for (const region of payload) {
    if (region?.TypeName !== 'A') continue;
    const id = Number(region.Id);
    if (!Number.isInteger(id)) continue;
    const days = [];
    for (const warning of region.AvalancheWarningList ?? []) {
      const date = String(warning?.ValidFrom ?? '').slice(0, 10);
      const level = finite(warning?.DangerLevel);
      if (!isIsoDate(date) || level === null) continue;
      days.push({
        date,
        level: Math.min(5, Math.max(0, Math.round(level))),
        text: text(warning.MainText),
      });
    }
    days.sort((a, b) => a.date.localeCompare(b.date));
    regions.push({
      id: `NO-${id}`,
      name: text(region.Name, 80) || `NO-${id}`,
      days,
    });
  }
  return regions;
}

/** regObs spells "Naturally" with one l; the card should not. */
const tidy = (value) =>
  text(value, 80)?.replace(/^Naturaly\b/, 'Naturally') ?? null;

const unknown = (value) =>
  value && !/^(unknown|not given)$/i.test(value) ? value : null;

/**
 * regObs avalanche observations, newest first.
 *
 * The release point is the observation's anchor; the runout point is kept
 * when the observer drew one, so the path can be drawn. Observations without
 * a usable time or position are dropped rather than placed at a guess.
 * @param {Array<object>} rows `v5/Search` response.
 * @returns {Array<object>} Observations.
 */
export function normalizeRegobsObservations(rows) {
  if (!Array.isArray(rows)) throw new TypeError('invalid_observations');
  const observations = [];
  for (const row of rows) {
    const id = Number(row?.RegId);
    if (!Number.isInteger(id) || id <= 0) continue;
    const obs = row.AvalancheObs ?? {};
    const time = Date.parse(obs.DtAvalancheTime ?? row.DtObsTime ?? '');
    if (!Number.isFinite(time)) continue;
    const location = row.ObsLocation ?? {};
    const start =
      coordinate(obs.StartLat, obs.StartLong) ??
      coordinate(location.Latitude, location.Longitude);
    if (!start) continue;
    const sizeTid = finite(obs.DestructiveSizeTID);
    const regionTid = finite(location.ForecastRegionTID);
    observations.push({
      id: String(id),
      time: new Date(time).toISOString(),
      start,
      stop: coordinate(obs.StopLat, obs.StopLong),
      // Destructive size 1-5; regObs uses 9 and 0 for unknown.
      sizeClass: sizeTid >= 1 && sizeTid <= 5 ? sizeTid : null,
      size: unknown(tidy(obs.DestructiveSizeName)),
      trigger: unknown(tidy(obs.AvalancheTriggerName)),
      type: unknown(tidy(obs.AvalancheName)),
      startElevationM: finite(obs.HeightStartZone),
      stopElevationM: finite(obs.HeightStopZone),
      regionId: Number.isInteger(regionTid) ? `NO-${regionTid}` : null,
      region: text(location.ForecastRegionName, 80),
      observer: text(row.Observer?.NickName, 80),
      url: `https://www.regobs.no/registration/${id}`,
    });
  }
  observations.sort((a, b) => b.time.localeCompare(a.time));
  return observations;
}

const roundRing = (ring) =>
  ring
    .filter(
      (point) =>
        Array.isArray(point) &&
        Number.isFinite(point[0]) &&
        Number.isFinite(point[1]),
    )
    .map(([lon, lat]) => [
      Math.round(lon * 1e4) / 1e4,
      Math.round(lat * 1e4) / 1e4,
    ]);

/**
 * EAWS micro-region polygons for the currently valid regions.
 *
 * EAWS keeps retired outlines alongside current ones (`valid_until`); only
 * open-ended ones are kept. Coordinates are rounded to about 10 m, which is
 * far below what a regional fill can show and halves the payload.
 * @param {object} geojson EAWS micro-regions FeatureCollection.
 * @returns {Array<{id:string, polygons:Array<Array<Array<[number, number]>>>}>}
 */
export function normalizeEawsRegions(geojson) {
  if (!Array.isArray(geojson?.features)) throw new TypeError('invalid_regions');
  const regions = [];
  for (const feature of geojson.features) {
    const id = feature?.properties?.id;
    if (typeof id !== 'string' || !/^NO-\d+$/.test(id)) continue;
    if (feature.properties.valid_until) continue;
    const geometry = feature.geometry;
    const parts =
      geometry?.type === 'Polygon'
        ? [geometry.coordinates]
        : geometry?.type === 'MultiPolygon'
          ? geometry.coordinates
          : [];
    const polygons = parts
      .map((rings) => rings.map(roundRing).filter((ring) => ring.length >= 4))
      .filter((rings) => rings.length);
    if (polygons.length) regions.push({ id, polygons });
  }
  return regions;
}
