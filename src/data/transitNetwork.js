/**
 * @module transitNetwork
 * @description Route geometry and service alerts for feeds that publish them.
 *
 * Vehicle positions say where a bus IS. This module adds the two facts a
 * reader needs to make sense of that: where its route GOES, and whether the
 * service on that route is disrupted right now.
 *
 *  - Routes come from an operator's route-pattern catalog. For MBTA that is
 *    the V3 API's `/route_patterns`, one request carrying every pattern, its
 *    representative trip's shape, and its route (colour, names, GTFS type).
 *    Only the operator's TYPICAL pattern per route and direction is kept
 *    (typicality 1). Diversions, deviations and the rail-replacement shuttle
 *    catalog are other typicalities, and drawing them as permanent routes
 *    would put a shuttle bus on the map every day of the year.
 *  - Alerts come from a GTFS-Realtime Alerts feed in its JSON rendering
 *    (MBTA publishes `Alerts_enhanced.json`, which adds `effect_detail`,
 *    `service_effect_text` and `timeframe_text` to the standard fields).
 *
 * Both are normalized SERVER-side into a small, bounded JSON shape, so the
 * browser never parses an operator's raw payload. Shapes stay in Google's
 * encoded-polyline form on the wire (roughly a fifth of the size of decoded
 * coordinates) and are validated here by decoding them once.
 *
 * Every string is bounded and stripped of control characters, every list is
 * capped, and anything malformed is dropped rather than repaired. Nothing in
 * an alert is ever rendered as HTML: the card host draws text.
 *
 * Pure: safe to import from the browser layer, the proxy, and node:test.
 */

/** Longest route id, pattern id or shape id accepted. GTFS ids are short. */
export const NETWORK_MAX_ID_CHARS = 128;
/** Longest route name accepted (long names such as "Forest Hills - Back Bay"). */
export const NETWORK_MAX_NAME_CHARS = 120;
/** Routes kept from one catalog. MBTA has ~180 typical routes. */
export const NETWORK_MAX_ROUTES = 2_000;
/** Shapes kept per route (one per direction is typical; a few branch). */
export const NETWORK_MAX_SHAPES_PER_ROUTE = 8;
/** Longest encoded polyline accepted, in characters. */
export const NETWORK_MAX_POLYLINE_CHARS = 200_000;
/** Total decoded points across a whole catalog. MBTA is ~90k. */
export const NETWORK_MAX_TOTAL_POINTS = 600_000;

/** Alerts kept from one feed. MBTA carries ~150. */
export const ALERTS_MAX = 2_000;
/** Active periods kept per alert. */
export const ALERTS_MAX_PERIODS = 32;
/** Routes kept per alert. */
export const ALERTS_MAX_ROUTES = 64;
/** Longest alert header kept. MBTA headers are ≤ ~250 characters. */
export const ALERTS_MAX_HEADER_CHARS = 400;
/** Longest short effect / timeframe line kept. */
export const ALERTS_MAX_SHORT_CHARS = 160;
/** Stops kept per alert. A station closure names its platforms and parent. */
export const ALERTS_MAX_STOPS = 32;
/** Stops looked up for one alert snapshot. MBTA needs a few dozen. */
export const ALERT_STOPS_MAX_LOOKUP = 400;

/** GTFS `route_type` → the Transit layer's mode vocabulary. */
export const GTFS_ROUTE_TYPE_MODE = Object.freeze({
  0: 'tram',
  1: 'subway',
  2: 'rail',
  3: 'bus',
  4: 'ferry',
  5: 'tram',
  6: 'unknown',
  7: 'rail',
  11: 'bus',
  12: 'rail',
});

/**
 * Alert kinds, in the order a reader cares about them.
 *  - `service`: the trip itself is affected (delay, suspension, shuttle,
 *    detour, closed stop). These mark the route on the map.
 *  - `facility`: the trip runs, but a station facility does not (elevator,
 *    escalator, parking). Counted on the card, not drawn.
 *  - `other`: notices and anything unclassified.
 */
export const ALERT_KINDS = Object.freeze(['service', 'facility', 'other']);

/** MBTA `effect_detail` values that describe the service itself. */
const SERVICE_EFFECT_DETAILS = new Set([
  'SUSPENSION',
  'SHUTTLE',
  'CANCELLATION',
  'DELAY',
  'DETOUR',
  'SERVICE_CHANGE',
  'SNOW_ROUTE',
  'STOP_CLOSURE',
  'STATION_CLOSURE',
  'STOP_MOVE',
  'STOP_MOVED',
  'TRACK_CHANGE',
  'SCHEDULE_CHANGE',
  'MODIFIED_SERVICE',
  'NO_SERVICE',
  'REDUCED_SERVICE',
]);

/** MBTA `effect_detail` values about station facilities. */
const FACILITY_EFFECT_DETAILS = new Set([
  'ELEVATOR_CLOSURE',
  'ESCALATOR_CLOSURE',
  'ACCESS_ISSUE',
  'PARKING_ISSUE',
  'PARKING_CLOSURE',
  'BIKE_ISSUE',
  'STATION_ISSUE',
  'FACILITY_ISSUE',
]);

/** Standard GTFS-Realtime `Alert.Effect` values that describe the service. */
const SERVICE_EFFECTS = new Set([
  'NO_SERVICE',
  'REDUCED_SERVICE',
  'SIGNIFICANT_DELAYS',
  'DETOUR',
  'MODIFIED_SERVICE',
  'STOP_MOVED',
  'NO_EFFECT_ON_SERVICE_BUT_STOP_CLOSED',
]);

/** Encoded polylines use printable ASCII 63–126 only. */
const POLYLINE_PATTERN = /^[\x3f-\x7e]+$/;
/** Route ids: printable, no whitespace runs at the ends, bounded. */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._:/+()-]{0,127}$/;
/** Hex colour without the leading '#'. */
const COLOR_PATTERN = /^[0-9A-Fa-f]{6}$/;
/** Upper-snake enum values (effect, cause, lifecycle). */
const ENUM_PATTERN = /^[A-Z][A-Z0-9_]{0,47}$/;

/**
 * Collapse whitespace, strip control characters, and refuse over-long text.
 * @param {unknown} value
 * @param {number} maxChars
 * @returns {string|null}
 */
export function boundedText(value, maxChars) {
  if (typeof value !== 'string') return null;
  // Control characters (including CR/LF, which alert text is full of) become
  // spaces first, so two words on either side of a line break stay two words.
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ');
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (!collapsed) return null;
  if (collapsed.length <= maxChars) return collapsed;
  // Alert headers are sentences: shorten at a word, and say that we did.
  const cut = collapsed.slice(0, maxChars - 1);
  const space = cut.lastIndexOf(' ');
  return `${space > maxChars * 0.6 ? cut.slice(0, space) : cut}…`;
}

/**
 * A GTFS id, or null when it is missing, over-long or odd-looking.
 * @param {unknown} value
 * @returns {string|null}
 */
export function validNetworkId(value) {
  if (typeof value !== 'string') return null;
  return ID_PATTERN.test(value) && value.length <= NETWORK_MAX_ID_CHARS
    ? value
    : null;
}

/**
 * Decode a Google encoded polyline (precision 5) into [lat, lon] pairs.
 *
 * Returns null — never a partial line — when the string is malformed, runs
 * past its own end mid-number, or yields a coordinate off the globe. A
 * half-decoded route drawn to the wrong place is worse than no route.
 *
 * @param {string} encoded
 * @param {number} [maxPoints=Infinity] Refuse lines longer than this.
 * @returns {Array<[number, number]>|null}
 */
export function decodePolyline(encoded, maxPoints = Infinity) {
  if (typeof encoded !== 'string' || encoded.length === 0) return null;
  if (encoded.length > NETWORK_MAX_POLYLINE_CHARS) return null;
  if (!POLYLINE_PATTERN.test(encoded)) return null;
  const points = [];
  let index = 0;
  let lat = 0;
  let lon = 0;
  const length = encoded.length;
  const readValue = () => {
    let result = 0;
    let shift = 0;
    let byte;
    do {
      if (index >= length) return null;
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
      // Seven 5-bit groups exceed any real coordinate delta; a longer run is
      // noise, and letting it continue overflows the 32-bit accumulator.
      if (shift > 35) return null;
    } while (byte >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (index < length) {
    const dLat = readValue();
    if (dLat === null) return null;
    const dLon = readValue();
    if (dLon === null) return null;
    lat += dLat;
    lon += dLon;
    const pLat = lat / 1e5;
    const pLon = lon / 1e5;
    if (Math.abs(pLat) > 90 || Math.abs(pLon) > 180) return null;
    points.push([pLat, pLon]);
    if (points.length > maxPoints) return null;
  }
  return points.length >= 2 ? points : null;
}

/**
 * Mode for a route: its GTFS route_type, else the feed's own route-id hint.
 * @param {number} routeType
 * @param {object|null} feed Registry entry (optional `routeMode`).
 * @param {string} routeId
 * @returns {string}
 */
export function networkRouteMode(routeType, feed, routeId) {
  const fromType = GTFS_ROUTE_TYPE_MODE[routeType];
  if (fromType && fromType !== 'unknown') return fromType;
  const hinted =
    typeof feed?.routeMode === 'function' ? feed.routeMode(routeId) : null;
  return typeof hinted === 'string' ? hinted : 'unknown';
}

/**
 * The name a reader would use for a route. Rapid transit, commuter rail and
 * ferries are known by their long name ("Red Line", "Fitchburg Line"); a bus
 * by its number, with the long name kept as a separate description.
 * @param {{mode: string, shortName: string|null, longName: string|null, id: string}} route
 * @returns {string}
 */
export function networkRouteDisplayName(route) {
  if (route.mode === 'bus') {
    const number = route.shortName || route.id;
    return `Route ${number}`;
  }
  return route.longName || route.shortName || `Route ${route.id}`;
}

/**
 * Normalize an MBTA V3 `/route_patterns?include=representative_trip.shape,route`
 * JSON:API document into the route catalog the layer draws.
 *
 * @param {object} payload Parsed JSON:API response.
 * @param {object|null} [feed=null] Registry entry, for the mode hint.
 * @returns {{ routes: object[], shapeCount: number, pointCount: number, droppedShapes: number }}
 * @throws {TypeError} When the document is not a route-pattern catalog at all.
 */
export function normalizeMbtaRoutePatterns(payload, feed = null) {
  if (!payload || typeof payload !== 'object')
    throw new TypeError('route catalog is not an object');
  const data = Array.isArray(payload.data) ? payload.data : null;
  const included = Array.isArray(payload.included) ? payload.included : null;
  if (!data || !included)
    throw new TypeError('route catalog has no data/included arrays');

  const routesById = new Map();
  const tripShape = new Map();
  const shapes = new Map();
  for (const item of included) {
    const id = validNetworkId(item?.id);
    if (!id) continue;
    if (item.type === 'route') routesById.set(id, item.attributes || {});
    else if (item.type === 'trip') {
      const shapeId = validNetworkId(item.relationships?.shape?.data?.id);
      if (shapeId) tripShape.set(id, shapeId);
    } else if (item.type === 'shape') {
      const polyline = item.attributes?.polyline;
      if (typeof polyline === 'string') shapes.set(id, polyline);
    }
  }

  // One typical pattern per route and direction: the operator's own
  // "this is the normal service" answer. Lowest sort_order wins a tie, which
  // is the order the operator lists them in.
  const chosen = new Map();
  for (const pattern of data) {
    if (pattern?.type !== 'route_pattern') continue;
    const attributes = pattern.attributes || {};
    if (attributes.typicality !== 1) continue;
    const routeId = validNetworkId(pattern.relationships?.route?.data?.id);
    const tripId = validNetworkId(
      pattern.relationships?.representative_trip?.data?.id,
    );
    if (!routeId || !tripId || !routesById.has(routeId)) continue;
    const direction = Number.isInteger(attributes.direction_id)
      ? attributes.direction_id
      : 0;
    const sortOrder = Number.isFinite(attributes.sort_order)
      ? attributes.sort_order
      : Number.MAX_SAFE_INTEGER;
    const key = `${routeId}\u0000${direction}`;
    const existing = chosen.get(key);
    if (!existing || sortOrder < existing.sortOrder) {
      chosen.set(key, { routeId, tripId, sortOrder });
    }
  }

  const byRoute = new Map();
  let pointCount = 0;
  let droppedShapes = 0;
  const seenShapes = new Set();
  for (const { routeId, tripId } of chosen.values()) {
    const shapeId = tripShape.get(tripId);
    const encoded = shapeId ? shapes.get(shapeId) : null;
    if (!shapeId || !encoded) {
      droppedShapes += 1;
      continue;
    }
    // Both directions of a line often share one shape id; draw it once.
    const shapeKey = `${routeId}\u0000${shapeId}`;
    if (seenShapes.has(shapeKey)) continue;
    const points = decodePolyline(encoded, NETWORK_MAX_TOTAL_POINTS);
    if (!points || pointCount + points.length > NETWORK_MAX_TOTAL_POINTS) {
      droppedShapes += 1;
      continue;
    }
    let route = byRoute.get(routeId);
    if (!route) {
      if (byRoute.size >= NETWORK_MAX_ROUTES) {
        droppedShapes += 1;
        continue;
      }
      const a = routesById.get(routeId);
      const routeType = Number.isInteger(a.type) ? a.type : null;
      const shortName = boundedText(a.short_name, NETWORK_MAX_NAME_CHARS);
      const longName = boundedText(a.long_name, NETWORK_MAX_NAME_CHARS);
      const mode = networkRouteMode(routeType, feed, routeId);
      route = {
        id: routeId,
        routeType,
        mode,
        shortName,
        longName,
        name: '',
        color: COLOR_PATTERN.test(a.color || '')
          ? `#${a.color.toUpperCase()}`
          : null,
        textColor: COLOR_PATTERN.test(a.text_color || '')
          ? `#${a.text_color.toUpperCase()}`
          : null,
        sortOrder: Number.isFinite(a.sort_order) ? a.sort_order : null,
        shapes: [],
      };
      route.name = networkRouteDisplayName(route);
      byRoute.set(routeId, route);
    }
    if (route.shapes.length >= NETWORK_MAX_SHAPES_PER_ROUTE) {
      droppedShapes += 1;
      continue;
    }
    seenShapes.add(shapeKey);
    route.shapes.push(encoded);
    pointCount += points.length;
  }

  const routes = [...byRoute.values()].sort(
    (a, b) =>
      (a.sortOrder ?? Number.MAX_SAFE_INTEGER) -
        (b.sortOrder ?? Number.MAX_SAFE_INTEGER) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  let shapeCount = 0;
  for (const route of routes) shapeCount += route.shapes.length;
  return { routes, shapeCount, pointCount, droppedShapes };
}

/**
 * The English text of a GTFS-Realtime TranslatedString, else its first.
 * @param {unknown} translated
 * @param {number} maxChars
 * @returns {string|null}
 */
function translatedText(translated, maxChars) {
  const list = Array.isArray(translated?.translation)
    ? translated.translation
    : [];
  const english =
    list.find(
      (t) => typeof t?.language === 'string' && /^en\b/i.test(t.language),
    ) ||
    list.find((t) => !t?.language) ||
    list[0];
  return boundedText(english?.text, maxChars);
}

function enumValue(value) {
  return typeof value === 'string' && ENUM_PATTERN.test(value) ? value : null;
}

/**
 * Classify an alert as service / facility / other.
 * @param {{effect: string|null, effectDetail: string|null}} alert
 * @returns {'service'|'facility'|'other'}
 */
export function alertKind(alert) {
  const detail = alert?.effectDetail;
  if (detail) {
    if (SERVICE_EFFECT_DETAILS.has(detail)) return 'service';
    if (FACILITY_EFFECT_DETAILS.has(detail)) return 'facility';
  }
  const effect = alert?.effect;
  if (effect && SERVICE_EFFECTS.has(effect)) return 'service';
  if (effect === 'ACCESSIBILITY_ISSUE') return 'facility';
  return 'other';
}

/**
 * Normalize a GTFS-Realtime Alerts feed rendered as JSON (the
 * `gtfs-realtime.proto` field names, snake_case) into bounded alert records.
 *
 * @param {object} payload Parsed JSON FeedMessage.
 * @returns {{ feedTimestamp: number|null, alerts: object[], truncated: boolean }}
 * @throws {TypeError} When the document is not a FeedMessage, or is differential.
 */
export function normalizeGtfsRtAlertsJson(payload) {
  if (!payload || typeof payload !== 'object')
    throw new TypeError('alerts feed is not an object');
  const header = payload.header;
  if (!header || typeof header !== 'object')
    throw new TypeError('alerts feed has no header');
  // FULL_DATASET is the default in the proto; only an explicit DIFFERENTIAL
  // is refused. A differential alert feed read as a snapshot would clear
  // every alert it did not happen to mention.
  const incrementality = header.incrementality;
  if (incrementality === 'DIFFERENTIAL' || incrementality === 1)
    throw new TypeError('alerts feed is differential');
  const entities = Array.isArray(payload.entity) ? payload.entity : null;
  if (!entities) throw new TypeError('alerts feed has no entity array');

  const alerts = [];
  let truncated = false;
  for (const entity of entities) {
    if (alerts.length >= ALERTS_MAX) {
      truncated = true;
      break;
    }
    if (!entity || entity.is_deleted === true) continue;
    const raw = entity.alert;
    if (!raw || typeof raw !== 'object') continue;
    const id = validNetworkId(String(entity.id ?? ''));
    if (!id) continue;

    const routeIds = new Set();
    const routeTypes = new Set();
    let stopCount = 0;
    const stopIds = new Set();
    for (const informed of Array.isArray(raw.informed_entity)
      ? raw.informed_entity
      : []) {
      const routeId = validNetworkId(informed?.route_id);
      if (routeId && routeIds.size < ALERTS_MAX_ROUTES) routeIds.add(routeId);
      if (Number.isInteger(informed?.route_type))
        routeTypes.add(informed.route_type);
      if (typeof informed?.stop_id === 'string') {
        stopCount += 1;
        const stopId = validNetworkId(informed.stop_id);
        if (stopId && stopIds.size < ALERTS_MAX_STOPS) stopIds.add(stopId);
      }
    }

    const activePeriods = [];
    for (const period of Array.isArray(raw.active_period)
      ? raw.active_period
      : []) {
      if (activePeriods.length >= ALERTS_MAX_PERIODS) break;
      const start = Number(period?.start);
      const end = Number(period?.end);
      activePeriods.push({
        start: Number.isFinite(start) && start > 0 ? Math.floor(start) : null,
        end: Number.isFinite(end) && end > 0 ? Math.floor(end) : null,
      });
    }

    const header = translatedText(raw.header_text, ALERTS_MAX_HEADER_CHARS);
    const serviceEffect = translatedText(
      raw.service_effect_text,
      ALERTS_MAX_SHORT_CHARS,
    );
    // An alert with nothing to say cannot be shown honestly.
    if (!header && !serviceEffect) continue;
    const severity = Number(raw.severity);
    const alert = {
      id,
      effect: enumValue(raw.effect),
      effectDetail: enumValue(raw.effect_detail),
      cause: enumValue(raw.cause),
      severity:
        Number.isFinite(severity) && severity >= 0 && severity <= 10
          ? Math.round(severity)
          : null,
      severityLevel: enumValue(raw.severity_level),
      lifecycle: enumValue(raw.alert_lifecycle),
      header,
      serviceEffect,
      timeframe: translatedText(raw.timeframe_text, ALERTS_MAX_SHORT_CHARS),
      activePeriods,
      routeIds: [...routeIds],
      routeTypes: [...routeTypes].slice(0, 8),
      stopCount,
      stopIds: [...stopIds],
      kind: 'other',
    };
    alert.kind = alertKind(alert);
    alerts.push(alert);
  }
  const timestamp = Number(header.timestamp);
  return {
    feedTimestamp:
      Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null,
    alerts,
    truncated,
  };
}

/**
 * Whether an alert is in force at `nowS` (epoch seconds). An alert with no
 * active period is in force for as long as the operator publishes it — the
 * GTFS-Realtime rule.
 * @param {{activePeriods?: Array<{start: number|null, end: number|null}>}} alert
 * @param {number} nowS
 * @returns {boolean}
 */
export function isAlertActive(alert, nowS) {
  const periods = alert?.activePeriods;
  if (!Array.isArray(periods) || periods.length === 0) return true;
  return periods.some(
    (p) =>
      (p.start === null || p.start <= nowS) && (p.end === null || nowS < p.end),
  );
}

/**
 * Order alerts the way a card should list them: service before facility
 * before other, then most severe first, then by id for stability.
 * @param {object} a
 * @param {object} b
 * @returns {number}
 */
export function compareAlerts(a, b) {
  const kind = ALERT_KINDS.indexOf(a.kind) - ALERT_KINDS.indexOf(b.kind);
  if (kind !== 0) return kind;
  const severity = (b.severity ?? -1) - (a.severity ?? -1);
  if (severity !== 0) return severity;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Index the alerts in force right now by route id, each list sorted by
 * {@link compareAlerts}.
 * @param {object[]} alerts Normalized alerts.
 * @param {number} nowS Epoch seconds.
 * @returns {Map<string, object[]>}
 */
export function activeAlertsByRoute(alerts, nowS) {
  const byRoute = new Map();
  for (const alert of alerts || []) {
    if (!isAlertActive(alert, nowS)) continue;
    for (const routeId of alert.routeIds || []) {
      let list = byRoute.get(routeId);
      if (!list) {
        list = [];
        byRoute.set(routeId, list);
      }
      list.push(alert);
    }
  }
  for (const list of byRoute.values()) list.sort(compareAlerts);
  return byRoute;
}

/**
 * The card lines for a route's alerts: up to `maxLines` service alerts in
 * full, then one summary line for whatever did not fit, then a count of
 * station-facility alerts. Empty when the route has nothing in force.
 * @param {object[]} alerts Alerts for ONE route, already sorted.
 * @param {number} [maxLines=3]
 * @returns {string[]}
 */
export function alertCardLines(alerts, maxLines = 3) {
  if (!Array.isArray(alerts) || alerts.length === 0) return [];
  const service = alerts.filter((a) => a.kind === 'service');
  const facility = alerts.filter((a) => a.kind === 'facility');
  const other = alerts.filter((a) => a.kind === 'other');
  const lines = [];
  for (const alert of service.slice(0, maxLines)) {
    const lead = alert.serviceEffect || alert.header;
    const when =
      alert.timeframe && !/^ongoing$/i.test(alert.timeframe)
        ? ` (${alert.timeframe})`
        : '';
    lines.push(`⚠ ${lead}${when}`);
  }
  const moreService = service.length - Math.min(service.length, maxLines);
  const extras = [];
  if (moreService > 0)
    extras.push(
      `${moreService} more service alert${moreService === 1 ? '' : 's'}`,
    );
  if (facility.length > 0)
    extras.push(
      `${facility.length} station access alert${facility.length === 1 ? '' : 's'}`,
    );
  if (other.length > 0)
    extras.push(`${other.length} notice${other.length === 1 ? '' : 's'}`);
  if (extras.length) lines.push(`+ ${extras.join(' · ')}`);
  return lines;
}

/**
 * Service alerts that touch one place on a route, or one detail of it, rather
 * than the route as a whole. A moved or closed stop, a bypassed station, a
 * schedule or track change is worth a line on the card, but outlining the
 * whole route for it would bury the real disruptions: on a normal weekday a
 * single closed busway stop lists fourteen bus routes that are otherwise
 * running normally.
 */
const MINOR_SERVICE_DETAILS = new Set([
  'STOP_MOVE',
  'STOP_MOVED',
  'STOP_CLOSURE',
  'STATION_CLOSURE',
  'SCHEDULE_CHANGE',
  'TRACK_CHANGE',
]);

/**
 * Whether an alert should mark its route on the map as disrupted.
 * @param {object} alert Normalized alert.
 * @returns {boolean}
 */
export function isDisruption(alert) {
  if (alert?.kind !== 'service') return false;
  if (alert.effectDetail && MINOR_SERVICE_DETAILS.has(alert.effectDetail))
    return false;
  if (
    !alert.effectDetail &&
    (alert.effect === 'STOP_MOVED' ||
      alert.effect === 'NO_EFFECT_ON_SERVICE_BUT_STOP_CLOSED')
  )
    return false;
  return true;
}

/**
 * Whether any alert in the list disrupts the route (drives the map outline).
 * @param {object[]|undefined} alerts Alerts for one route.
 * @returns {boolean}
 */
export function hasDisruption(alerts) {
  return Array.isArray(alerts) && alerts.some(isDisruption);
}

/**
 * Whether an alert is about particular STOPS rather than a whole route — a
 * closed, moved or bypassed stop — and so belongs as a marker at those stops.
 * @param {object} alert Normalized alert.
 * @returns {boolean}
 */
export function isStopAlert(alert) {
  if (alert?.kind !== 'service' || !alert.stopIds?.length) return false;
  if (alert.effectDetail) return STOP_LEVEL_DETAILS.has(alert.effectDetail);
  return (
    alert.effect === 'STOP_MOVED' ||
    alert.effect === 'NO_EFFECT_ON_SERVICE_BUT_STOP_CLOSED'
  );
}

const STOP_LEVEL_DETAILS = new Set([
  'STOP_CLOSURE',
  'STATION_CLOSURE',
  'STOP_MOVE',
  'STOP_MOVED',
]);

/**
 * The stops a stop-level alert should be drawn at. A station closure lists
 * its parent station (`place-…`) AND every platform under it; the parent
 * alone is the one place a reader looks for, so when an alert names parents
 * only those are kept. A bus stop has no parent and stands for itself.
 * @param {object} alert Normalized alert.
 * @returns {string[]}
 */
export function alertMarkerStopIds(alert) {
  const ids = Array.isArray(alert?.stopIds) ? alert.stopIds : [];
  const parents = ids.filter((id) => id.startsWith('place-'));
  return parents.length ? parents : ids;
}

/**
 * Normalize an MBTA V3 `/stops` JSON:API document into `{id, name, lat, lon}`
 * records. Anything without a name and a plausible position is dropped.
 * @param {object} payload
 * @returns {Array<{id: string, name: string, lat: number, lon: number}>}
 * @throws {TypeError} When the document has no data array.
 */
export function normalizeMbtaStops(payload) {
  if (!payload || !Array.isArray(payload.data))
    throw new TypeError('stop list has no data array');
  const stops = [];
  for (const item of payload.data) {
    if (item?.type !== 'stop') continue;
    const id = validNetworkId(item.id);
    const name = boundedText(item.attributes?.name, NETWORK_MAX_NAME_CHARS);
    const lat = Number(item.attributes?.latitude);
    const lon = Number(item.attributes?.longitude);
    if (!id || !name) continue;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    if (Math.abs(lat) < 1e-6 && Math.abs(lon) < 1e-6) continue;
    stops.push({
      id,
      name,
      lat: Number(lat.toFixed(6)),
      lon: Number(lon.toFixed(6)),
    });
  }
  return stops;
}
