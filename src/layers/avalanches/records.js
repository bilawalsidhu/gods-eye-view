/**
 * @module avalanches/records
 * @description Pure normalizers from the upstream avalanche feeds to the one
 * shape the layer draws. Shared by the server proxy (which trims the payloads)
 * and the browser (which re-validates them), so it imports nothing.
 *
 * - Varsom / NVE forecast regions (Norway): danger level per region per day.
 * - SLF bulletins (Switzerland): danger level per warning region per day.
 * - regObs avalanche observations: release and runout points, time, size,
 *   trigger and elevations.
 * - EAWS micro-regions (Norway) and SLF warning regions (Switzerland):
 *   forecast region polygons.
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
      provider: 'varsom',
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
    if (polygons.length) regions.push({ id, provider: 'varsom', polygons });
  }
  return regions;
}

const polygonsOf = (geometry) => {
  const parts =
    geometry?.type === 'Polygon'
      ? [geometry.coordinates]
      : geometry?.type === 'MultiPolygon'
        ? geometry.coordinates
        : [];
  return parts
    .map((rings) => rings.map(roundRing).filter((ring) => ring.length >= 4))
    .filter((rings) => rings.length);
};

/** SLF danger words to the shared 1–5 scale; `no_rating` and `no_snow` are 0. */
const SLF_LEVELS = Object.freeze({
  low: 1,
  moderate: 2,
  considerable: 3,
  high: 4,
  very_high: 5,
});

/** SLF refines a level into lower, middle and upper thirds. */
const SLF_SUBDIVISION = Object.freeze({ minus: '−', neutral: '=', plus: '+' });

/**
 * One day's SLF bulletins as a rating per warning region.
 *
 * A bulletin can rate by elevation or by morning and afternoon; the region
 * takes its highest rating, the one a traveller has to plan for. The summary
 * is the SLF's own one-line core-zone text for the bulletin's worst problem.
 * @param {{bulletins:Array<object>}} payload CAAMLv6 JSON for one instant.
 * @returns {Map<string, {name:?string, level:number, sub:?string, text:?string}>}
 */
export function slfDayRatings(payload) {
  if (!Array.isArray(payload?.bulletins))
    throw new TypeError('invalid_bulletin');
  const ratings = new Map();
  for (const bulletin of payload.bulletins) {
    let best = null;
    for (const rating of bulletin?.dangerRatings ?? []) {
      const level = SLF_LEVELS[rating?.mainValue] ?? 0;
      if (!best || level > best.level) best = { level, rating };
    }
    const level = best?.level ?? 0;
    const sub =
      SLF_SUBDIVISION[best?.rating?.customData?.CH?.subdivision] ?? null;
    const problems = [...(bulletin?.avalancheProblems ?? [])].sort(
      (a, b) =>
        (SLF_LEVELS[b?.dangerRatingValue] ?? 0) -
        (SLF_LEVELS[a?.dangerRatingValue] ?? 0),
    );
    const summary = text(problems[0]?.customData?.CH?.coreZoneText);
    for (const region of bulletin?.regions ?? []) {
      const id = region?.regionID;
      if (typeof id !== 'string' || !/^CH-\d+$/.test(id)) continue;
      const previous = ratings.get(id);
      if (previous && previous.level >= level) continue;
      ratings.set(id, {
        name: text(region.name, 80),
        level,
        sub: level ? sub : null,
        text: level ? summary : null,
      });
    }
  }
  return ratings;
}

/**
 * SLF bulletins for a run of days, as forecast regions with their days.
 * @param {Array<{date:string, payload:object}>} days One CAAMLv6 payload per date.
 * @returns {Array<{id:string, provider:string, name:string, days:Array<object>}>}
 */
export function normalizeSlfForecast(days) {
  const regions = new Map();
  for (const { date, payload } of days) {
    if (!isIsoDate(date)) continue;
    for (const [id, rating] of slfDayRatings(payload)) {
      const region = regions.get(id) ?? {
        id,
        provider: 'slf',
        name: rating.name || id,
        days: [],
      };
      region.days.push({
        date,
        level: rating.level,
        text: rating.text,
        sub: rating.sub,
      });
      regions.set(id, region);
    }
  }
  return [...regions.values()]
    .map((region) => ({
      ...region,
      days: region.days.sort((a, b) => a.date.localeCompare(b.date)),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * SLF warning-region polygons, keyed the way its bulletins name them.
 * @param {object} geojson Current warning-region definition.
 * @returns {Array<{id:string, provider:string, name:?string, polygons:Array}>}
 */
export function normalizeSlfRegions(geojson) {
  if (!Array.isArray(geojson?.features)) throw new TypeError('invalid_regions');
  const regions = [];
  for (const feature of geojson.features) {
    const sector = String(feature?.properties?.sector_id ?? '');
    if (!/^\d+$/.test(sector)) continue;
    const polygons = polygonsOf(feature.geometry);
    if (!polygons.length) continue;
    regions.push({
      id: `CH-${sector}`,
      provider: 'slf',
      name: text(
        feature.properties.sector_names?.en ?? feature.properties.sector_name,
        80,
      ),
      polygons,
    });
  }
  return regions;
}
