import { readResponseTextCapped } from './common/http.js';

/**
 * GDACS tropical cyclones for the basins NHC/CPHC do not cover: the North
 * Indian Ocean, the western North Pacific and the Southern Hemisphere. GDACS
 * redraws JTWC advisories automatically; its products are estimates, not
 * official warnings.
 */

const API = 'https://www.gdacs.org/gdacsapi/api';
const HOUR = 3600_000;
const DAY = 24 * HOUR;
// The same advisory clock tolerances the NHC status uses.
const EARLY_MS = 90 * 60_000;
const MAX_AGE_MS = 12 * HOUR;
export const GDACS_MAX_STORMS = 12;
const LIST_CAP = 256 * 1024;
const GEOMETRY_CAP = 2 * 1024 * 1024;
const DETAILS_CAP = 256 * 1024;
const TIMELINE_CAP = 2 * 1024 * 1024;
// Timeline wind speeds are metres per second.
const KT_PER_MS = 1.943844;
// One episode's downloads may outlive a refresh, but not this.
const EPISODE_TIMEOUT_MS = 30_000;
// Track-point markers are small circles around a track vertex.
const MARKER_TOLERANCE_DEG = 0.3;

function invalid() {
  return new Error('invalid_gdacs_cyclone_data');
}
function eventNumber(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 999_999_999)
    throw invalid();
  return value;
}
function finite(value, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw invalid();
  if (value < min || value > max) throw invalid();
  return value;
}
function pair(value) {
  if (!Array.isArray(value) || value.length !== 2) throw invalid();
  return [finite(value[0], -180, 180), finite(value[1], -90, 90)];
}
const key = ([longitude, latitude]) => `${longitude},${latitude}`;
const position = ([longitude, latitude]) => ({ longitude, latitude });

/** GDACS times are UTC without a zone designator. */
function utc(value) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/.test(value)
  )
    throw invalid();
  const ms = Date.parse(`${value}Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 19) !== value)
    throw invalid();
  return ms;
}

/**
 * The basin a GDACS position falls in, or null inside NHC/CPHC water (the
 * northern hemisphere west of the prime meridian), which NOAA covers.
 * @param {{longitude:number, latitude:number}} value
 * @returns {?('IO'|'WP'|'SH')}
 */
export function gdacsBasin({ longitude, latitude }) {
  if (latitude < 0) return 'SH';
  if (longitude < 0) return null;
  return longitude < 100 ? 'IO' : 'WP';
}

/** "MURASU-26" becomes "Murasu"; the year suffix is GDACS's, not the name's. */
function stormName(value) {
  if (
    typeof value !== 'string' ||
    !/^[A-Z0-9][A-Z0-9 '.-]{0,40}$/i.test(value.trim())
  )
    throw invalid();
  return value
    .trim()
    .replace(/-\d{2}$/, '')
    .toLowerCase()
    .replace(
      /(^|[ '-])([a-z])/g,
      (_, gap, letter) => gap + letter.toUpperCase(),
    );
}

/**
 * Current GDACS cyclones outside NHC/CPHC water, from the event search.
 * @param {object} payload GeoJSON FeatureCollection of centroids.
 * @returns {Array<{eventId:number, episodeId:number, name:string, basin:string, position:object, issuedAt:number}>}
 */
export function parseGdacsCycloneList(payload) {
  if (
    payload?.type !== 'FeatureCollection' ||
    !Array.isArray(payload.features) ||
    payload.features.length > 200
  )
    throw invalid();
  const seen = new Set();
  const events = [];
  for (const feature of payload.features) {
    const p = feature?.properties;
    if (p?.eventtype !== 'TC' || feature.geometry?.type !== 'Point')
      throw invalid();
    const eventId = eventNumber(p.eventid);
    if (seen.has(eventId)) throw invalid();
    seen.add(eventId);
    if (p.iscurrent !== 'true') continue;
    const at = position(pair(feature.geometry.coordinates));
    const basin = gdacsBasin(at);
    if (!basin) continue;
    events.push({
      eventId,
      episodeId: eventNumber(p.episodeid),
      name: stormName(p.eventname),
      basin,
      position: at,
      // The episode's advisory time: GDACS ends an event's range there.
      issuedAt: utc(p.todate),
    });
  }
  return events.slice(0, GDACS_MAX_STORMS);
}

/** Track-point labels carry day and month only; the year is the advisory's. */
function labelTime(label, issuedAt) {
  const match =
    typeof label === 'string' &&
    /^(\d\d)\/(\d\d) (\d\d):(\d\d) UTC$/.exec(label);
  if (!match) throw invalid();
  const [day, month, hour, minute] = match.slice(1).map(Number);
  const year = new Date(issuedAt).getUTCFullYear();
  let best = null;
  for (const candidate of [year - 1, year, year + 1]) {
    const ms = Date.UTC(candidate, month - 1, day, hour, minute);
    const date = new Date(ms);
    if (
      date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day ||
      hour > 23 ||
      minute > 59
    )
      throw invalid();
    if (best === null || Math.abs(ms - issuedAt) < Math.abs(best - issuedAt))
      best = ms;
  }
  if (Math.abs(best - issuedAt) > 30 * DAY) throw invalid();
  return best;
}

function ring(value, budget, closed = true) {
  if (!Array.isArray(value) || value.length < 4 || value.length > 5000)
    throw invalid();
  const result = value.map((item) => {
    if (++budget.count > 25_000) throw invalid();
    return pair(item);
  });
  if (closed && key(result[0]) !== key(result.at(-1))) throw invalid();
  return result;
}

/** Centre of a track-point marker circle, unwrapped across the antimeridian. */
function markerCenter(geometry, budget) {
  if (geometry?.type !== 'Polygon' || !Array.isArray(geometry.coordinates))
    throw invalid();
  const vertices = ring(geometry.coordinates[0], budget).slice(0, -1);
  const lons = vertices.map(([longitude]) => longitude);
  const wraps = Math.max(...lons) - Math.min(...lons) > 180;
  let lon = 0,
    lat = 0;
  for (const [longitude, latitude] of vertices) {
    lon += wraps && longitude < 0 ? longitude + 360 : longitude;
    lat += latitude;
  }
  lon /= vertices.length;
  return [lon > 180 ? lon - 360 : lon, lat / vertices.length];
}

function cone(geometry, budget) {
  const polygon = (rings) => {
    if (!Array.isArray(rings) || !rings.length || rings.length > 64)
      throw invalid();
    return rings.map((item) => ring(item, budget));
  };
  if (geometry?.type === 'Polygon')
    return { type: 'Polygon', coordinates: polygon(geometry.coordinates) };
  if (
    geometry?.type === 'MultiPolygon' &&
    Array.isArray(geometry.coordinates) &&
    geometry.coordinates.length &&
    geometry.coordinates.length <= 64
  )
    return {
      type: 'MultiPolygon',
      coordinates: geometry.coordinates.map(polygon),
    };
  throw invalid();
}

/** Order two-point track segments into one path from the first fix. */
function chain(segments) {
  const byStart = new Map();
  const ends = new Set();
  for (const segment of segments) {
    const start = key(segment.from);
    if (byStart.has(start)) throw invalid();
    byStart.set(start, segment);
    ends.add(key(segment.to));
  }
  const first = segments.filter((segment) => !ends.has(key(segment.from)));
  if (first.length !== 1) throw invalid();
  const path = [first[0].from];
  const ordered = [];
  for (let at = first[0]; at; at = byStart.get(key(at.to))) {
    if (ordered.length === segments.length) throw invalid();
    ordered.push(at);
    path.push(at.to);
  }
  if (ordered.length !== segments.length) throw invalid();
  return { path, ordered };
}

/**
 * Track, lead-hour points and cone from one GDACS episode's geometry. Track
 * points carry times, track segments carry exact positions; both must agree.
 * @param {object} payload GeoJSON FeatureCollection from polygons/getgeometry.
 * @param {{eventId:number, episodeId:number}} event
 * @returns {{issuedAt:number, position:object, classification:?string, forecastPoints:Array<object>, track:?object, cone:?object}}
 */
export function parseGdacsCycloneGeometry(payload, { eventId, episodeId }) {
  if (
    payload?.type !== 'FeatureCollection' ||
    !Array.isArray(payload.features) ||
    payload.features.length > 600
  )
    throw invalid();
  const budget = { count: 0 };
  const markers = [];
  const segments = [];
  let issuedAt = null,
    shape = null;
  for (const feature of payload.features) {
    const p = feature?.properties;
    if (
      p?.eventtype !== 'TC' ||
      p.eventid !== eventId ||
      p.episodeid !== episodeId ||
      typeof p.Class !== 'string'
    )
      throw invalid();
    const track = /^Point_Polygon_Point_\d{1,3}$/.test(p.Class)
      ? 'marker'
      : /^Line_Line_\d{1,3}$/.test(p.Class)
        ? 'segment'
        : p.Class === 'Poly_Cones'
          ? 'cone'
          : null;
    // Centroids and wind-speed swaths are not drawn by this layer.
    if (!track) continue;
    const at = utc(p.polygondate);
    if (issuedAt === null) issuedAt = at;
    else if (issuedAt !== at) throw invalid();
    if (track === 'marker')
      markers.push({
        label: p.polygonlabel,
        center: markerCenter(feature.geometry, budget),
      });
    else if (track === 'segment') {
      const line = feature.geometry;
      if (
        line?.type !== 'LineString' ||
        !Array.isArray(line.coordinates) ||
        line.coordinates.length !== 2 ||
        typeof p.forecast !== 'boolean' ||
        typeof p.polygonlabel !== 'string' ||
        !/^[A-Z]{2,3}$/.test(p.polygonlabel)
      )
        throw invalid();
      budget.count += 2;
      segments.push({
        from: pair(line.coordinates[0]),
        to: pair(line.coordinates[1]),
        forecast: p.forecast,
        category: p.polygonlabel,
      });
    } else {
      if (shape) throw invalid();
      shape = cone(feature.geometry, budget);
    }
  }
  if (issuedAt === null || !markers.length || markers.length > 200)
    throw invalid();
  const { path, ordered } = segments.length
    ? chain(segments)
    : { path: [markers[0].center], ordered: [] };
  if (path.length !== markers.length) throw invalid();
  const fixes = markers
    .map((marker) => ({
      at: labelTime(marker.label, issuedAt),
      center: marker.center,
    }))
    .sort((a, b) => a.at - b.at);
  fixes.forEach((fix, index) => {
    if (index && fix.at === fixes[index - 1].at) throw invalid();
    const [lon, lat] = path[index];
    const dLon = Math.abs(fix.center[0] - lon) % 360;
    if (
      Math.min(dLon, 360 - dLon) > MARKER_TOLERANCE_DEG ||
      Math.abs(fix.center[1] - lat) > MARKER_TOLERANCE_DEG
    )
      throw invalid();
  });
  const current = fixes.findIndex((fix) => fix.at === issuedAt);
  if (current < 0) throw invalid();
  ordered.forEach((segment, index) => {
    if (segment.forecast !== index >= current) throw invalid();
  });
  const forecastPoints = fixes.slice(current).map((fix, index) => {
    const tauHours = (fix.at - issuedAt) / HOUR;
    if (!Number.isInteger(tauHours) || tauHours > 168) throw invalid();
    return {
      position: position(path[current + index]),
      tauHours,
      windKt: null,
      gustKt: null,
    };
  });
  return {
    issuedAt,
    position: position(path[current]),
    // A segment's category is the intensity at its end point.
    classification: current > 0 ? ordered[current - 1].category : null,
    forecastPoints,
    track:
      forecastPoints.length > 1
        ? { type: 'LineString', coordinates: path.slice(current) }
        : null,
    cone: shape,
  };
}

/** The JTWC timeline export id named in an event's details. */
export function parseGdacsTimelineId(payload, eventId) {
  const p = payload?.properties ?? payload;
  if (p?.eventtype !== 'TC' || p.eventid !== eventId) throw invalid();
  if (!Array.isArray(p.impacts) || p.impacts.length > 16) throw invalid();
  for (const impact of p.impacts) {
    const match =
      typeof impact?.resource?.timeline === 'string' &&
      /^https:\/\/www\.gdacs\.org\/gdacsapi\/api\/export\/gettimeline\?id=(\d{1,12})$/.exec(
        impact.resource.timeline,
      );
    if (match) return match[1];
  }
  return null;
}

function speedKt(value) {
  const ms = Number(value);
  if (typeof value !== 'string' || !Number.isFinite(ms) || ms < 0 || ms > 150)
    throw invalid();
  return Math.round(ms * KT_PER_MS);
}
function pressure(value) {
  const hpa = Number(value);
  if (typeof value !== 'string' || !Number.isFinite(hpa)) throw invalid();
  // GDACS reports an unknown pressure as 0.
  return hpa >= 800 && hpa <= 1100 ? hpa : null;
}

/**
 * Winds by position for the latest advisory in a GDACS timeline. The current
 * fix must sit where the geometry's current position is, so winds from an
 * older or newer advisory never label this track.
 * @returns {Map<string, {windKt:number, gustKt:number, pressureHpa:?number}>}
 */
export function parseGdacsTimeline(payload, { eventId, position: at }) {
  const items = payload?.channel?.item;
  if (!Array.isArray(items) || !items.length || items.length > 500)
    throw invalid();
  const current = items.filter((item) => item?.current === 'true');
  if (current.length !== 1) throw invalid();
  const advisory = current[0].advisory_number;
  if (typeof advisory !== 'string' || !/^\d{1,4}$/.test(advisory))
    throw invalid();
  const winds = new Map();
  for (const item of items) {
    if (item?.storm_id !== String(eventId)) throw invalid();
    if (item.advisory_number !== advisory) continue;
    if (item.current !== 'true' && item.actual !== 'False') continue;
    const fix = pair([Number(item.longitude), Number(item.latitude)]);
    winds.set(key(fix), {
      windKt: speedKt(item.wind_speed),
      gustKt: speedKt(item.wind_gusts),
      pressureHpa: pressure(item.pressure),
    });
  }
  if (
    key([Number(current[0].longitude), Number(current[0].latitude)]) !==
    key([at.longitude, at.latitude])
  )
    throw invalid();
  return winds;
}

const reportUrl = ({ eventId, episodeId }) =>
  `https://www.gdacs.org/report.aspx?eventid=${eventId}&episodeid=${episodeId}&eventtype=TC`;

function classification(code, windKt, basin) {
  const category =
    code ??
    (windKt === null ? null : windKt >= 64 ? 'HU' : windKt >= 34 ? 'TS' : 'TD');
  // GDACS uses the Atlantic word; the same strength is a typhoon in the
  // western Pacific and a cyclone elsewhere.
  if (category === 'HU') return basin === 'WP' ? 'TY' : 'CY';
  return category ?? 'TC';
}

function current(issuedAt, now) {
  return issuedAt <= now + EARLY_MS && now - issuedAt <= MAX_AGE_MS;
}

const query = (path, params) =>
  `${API}/${path}?${new URLSearchParams(params).toString()}`;

function record(event, shape, winds) {
  const result = {
    id: `gdacs-${event.eventId}`,
    provider: 'gdacs',
    name: event.name,
    classification: classification(null, null, event.basin),
    basin: event.basin,
    position: event.position,
    positionAt: new Date(event.issuedAt).toISOString(),
    advisoryNumber: String(event.episodeId),
    issuedAt: new Date(event.issuedAt).toISOString(),
    windKt: null,
    pressureHpa: null,
    movement: { directionDegrees: null, speedKt: null },
    advisoryUrl: reportUrl(event),
    outlookUrl: null,
    // Without geometry the event's centroid still marks the storm honestly.
    geometryStatus: shape.status === 'pending' ? 'pending' : 'unavailable',
    geometryAdvisoryNumber: null,
    forecastPoints: [],
    track: null,
    cone: null,
    // Winds still downloading when the refresh ended; a later one has them.
    windsPending: winds.status === 'pending',
  };
  if (shape.status !== 'done') return result;
  const geometry = shape.value;
  const table = winds.status === 'done' ? winds.value : null;
  const wind = (at) => table?.get(key([at.longitude, at.latitude])) ?? null;
  const fix = wind(geometry.position);
  Object.assign(result, {
    classification: classification(
      geometry.classification,
      fix?.windKt ?? null,
      event.basin,
    ),
    position: geometry.position,
    windKt: fix?.windKt ?? null,
    pressureHpa: fix?.pressureHpa ?? null,
  });
  if (geometry.track)
    Object.assign(result, {
      geometryStatus: 'current',
      geometryAdvisoryNumber: result.advisoryNumber,
      forecastPoints: geometry.forecastPoints.map((point) => {
        const at = wind(point.position);
        return {
          ...point,
          windKt: at?.windKt ?? null,
          gustKt: at?.gustKt ?? null,
        };
      }),
      track: geometry.track,
      cone: geometry.cone,
    });
  return result;
}

const settle = (promise) =>
  promise.then(
    (value) => ({ status: 'done', value }),
    () => ({ status: 'failed' }),
  );

/**
 * A GDACS cyclone source that remembers episodes. An episode's geometry and
 * winds never change once GDACS publishes them, so each is downloaded once.
 * GDACS is slow (seconds per request), so a download still running at a
 * refresh's deadline carries on under its own deadline and the next refresh
 * uses it; meanwhile the storm shows its centroid with geometry pending.
 * @param {{fetchImpl?:Function}} [options]
 * @returns {(options:{now?:number, signal:AbortSignal, timeoutMs?:number}) => Promise<Array<object>>}
 *   Current GDACS cyclones outside NHC/CPHC water, as Cyclones-layer storm records.
 */
export function createGdacsCyclones({ fetchImpl = fetch } = {}) {
  const episodes = new Map();
  async function request(url, cap, signal, { empty = false } = {}) {
    signal.throwIfAborted();
    const response = await fetchImpl(url, {
      signal,
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Gods Eye View (public GDACS cyclone context)',
      },
    });
    // GDACS answers a search with no events with a 404 problem document.
    if (
      empty &&
      response.status === 404 &&
      /problem\+json/.test(response.headers.get('content-type') || '')
    ) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('gdacs_upstream_unavailable');
    }
    const result = JSON.parse(
      await readResponseTextCapped(response, cap, signal),
    );
    signal.throwIfAborted();
    return result;
  }
  function download(event) {
    const id = `${event.eventId}:${event.episodeId}`;
    const known = episodes.get(id);
    if (known) return known;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EPISODE_TIMEOUT_MS);
    timer.unref?.();
    const ids = { eventtype: 'TC', eventid: String(event.eventId) };
    const geometry = request(
      query('polygons/getgeometry', {
        ...ids,
        episodeid: String(event.episodeId),
      }),
      GEOMETRY_CAP,
      controller.signal,
    ).then((payload) => parseGdacsCycloneGeometry(payload, event));
    // Winds need the details for the timeline id and the geometry for the
    // current position the timeline must match.
    const winds = Promise.all([
      geometry,
      request(
        query('events/geteventdata', ids),
        DETAILS_CAP,
        controller.signal,
      ).then((payload) => parseGdacsTimelineId(payload, event.eventId)),
    ]).then(([shape, timeline]) =>
      timeline
        ? request(
            query('export/gettimeline', { id: timeline }),
            TIMELINE_CAP,
            controller.signal,
          ).then((payload) =>
            parseGdacsTimeline(payload, {
              eventId: event.eventId,
              position: shape.position,
            }),
          )
        : null,
    );
    const entry = { geometry: settle(geometry), winds: settle(winds) };
    episodes.set(id, entry);
    // A failed download is forgotten, so a later refresh tries again.
    Promise.allSettled([geometry, winds]).then((results) => {
      clearTimeout(timer);
      if (
        results.some((result) => result.status === 'rejected') &&
        episodes.get(id) === entry
      )
        episodes.delete(id);
    });
    return entry;
  }
  return async function fetchGdacs({
    now = Date.now(),
    signal,
    timeoutMs = 11_000,
  }) {
    signal.throwIfAborted();
    // The refresh deadline: GDACS never holds the NHC snapshot past it.
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const deadline = new Promise((resolve) =>
      controller.signal.addEventListener(
        'abort',
        () => resolve({ status: 'pending' }),
        { once: true },
      ),
    );
    try {
      const day = (ms) => new Date(ms).toISOString().slice(0, 10);
      const search = await request(
        query('events/geteventlist/SEARCH', {
          eventlist: 'TC',
          fromDate: day(now - 7 * DAY),
          toDate: day(now + DAY),
        }),
        LIST_CAP,
        controller.signal,
        { empty: true },
      );
      const events = (
        search === null ? [] : parseGdacsCycloneList(search)
      ).filter((event) => current(event.issuedAt, now));
      const listed = new Set(
        events.map((event) => `${event.eventId}:${event.episodeId}`),
      );
      for (const id of episodes.keys())
        if (!listed.has(id)) episodes.delete(id);
      const storms = await Promise.all(
        events.map(async (event) => {
          const entry = download(event);
          const [shape, winds] = await Promise.all([
            Promise.race([entry.geometry, deadline]),
            Promise.race([entry.winds, deadline]),
          ]);
          // Geometry dated for another episode never relabels this one;
          // forget it so a later refresh asks again.
          if (
            shape.status === 'done' &&
            shape.value.issuedAt !== event.issuedAt
          ) {
            episodes.delete(`${event.eventId}:${event.episodeId}`);
            return record(event, { status: 'pending' }, winds);
          }
          return record(event, shape, winds);
        }),
      );
      signal.throwIfAborted();
      return storms;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    }
  };
}

/**
 * One GDACS refresh without episode memory, for callers that refresh once.
 * @param {{fetchImpl?:Function, now?:number, signal:AbortSignal, timeoutMs?:number}} options
 * @returns {Promise<Array<object>>}
 */
export function fetchGdacsCyclones({ fetchImpl = fetch, ...options }) {
  return createGdacsCyclones({ fetchImpl })(options);
}
