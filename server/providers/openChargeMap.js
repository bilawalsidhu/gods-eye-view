import { readResponseJsonCapped } from './common/http.js';
import { requiredFiniteQueryNumber } from './common/query.js';
import { admitSameSite } from './common/same-site.js';

/**
 * Open Charge Map (OCM) proxy for the EV Charging layer.
 *
 * Upstream: https://api.openchargemap.io/v3 — `/poi` for one bounding box and
 * `/referencedata` for the lookup tables a compact POI points into. The key
 * comes from OPEN_CHARGE_MAP_API_KEY server-side only and travels in the
 * `X-API-Key` header, so it is in no URL, log line or response. The browser
 * reads same-origin `/api/ocm/*` and never sees it.
 *
 * Licence is per record. A POI carries its DataProvider's licence, so a site
 * is kept only when that provider is open-data licensed
 * (`IsOpenDataLicensed === true`, the same test the upstream `opendata=true`
 * filter applies) and is not on the exclusion list below. The upstream filter
 * is asked for too, but this module decides: a site whose provider is unknown,
 * not open, or excluded is dropped here.
 *
 * Politeness (OCM publishes no rate limit and asks callers not to flood it):
 * answers are cached for ten minutes per box snapped outward onto a 0.01°
 * grid, refreshes are single-flight per box, a failed refresh serves the last
 * answer for that box, a box wider than 0.5° is refused before any request,
 * one read returns at most 500 sites, and the process makes at most 30 POI
 * requests a minute.
 *
 * Routes:
 *   GET /api/ocm/status → {hasKey}
 *   GET /api/ocm/poi?south=&west=&north=&east=
 *     → {fetchedAt, stale, saturated, count, sites}
 * Keyless: /status → {hasKey:false}; /poi → 503 {error:'no_key'} and upstream
 * is never touched. Every error is one of the fixed bodies in this file.
 *
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl] Upstream fetch; a test seam.
 * @param {() => number} [options.now] Clock; a test seam.
 * @returns {import('vite').Plugin}
 */
export function openChargeMapProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  /** @type {Map<string, {at:number, payload:object}>} box key → last answer. */
  const answers = new Map();
  /** @type {Map<string, Promise<object>>} single-flight refresh per box. */
  const inflight = new Map();
  /** @type {?{at:number, refs:object}} */
  let reference = null;
  /** @type {?Promise<object>} */
  let referenceInflight = null;
  /** Upstream POI request times inside the last minute. */
  let recent = [];

  const apiKey = () => String(process.env.OPEN_CHARGE_MAP_API_KEY || '').trim();

  async function upstreamJson(url, key, maxBytes) {
    const signal = AbortSignal.timeout(OCM_UPSTREAM_TIMEOUT_MS);
    let response;
    try {
      response = await fetchImpl(url, {
        signal,
        headers: {
          Accept: 'application/json',
          'X-API-Key': key,
          'User-Agent': OCM_USER_AGENT,
        },
      });
    } catch (error) {
      throw ocmFailure(
        error?.name === 'TimeoutError' || error?.name === 'AbortError'
          ? 'timeout'
          : 'network',
      );
    }
    if (!response.ok) {
      void response.body?.cancel?.().catch(() => {});
      throw ocmFailure('http', response.status);
    }
    try {
      return await readResponseJsonCapped(response, maxBytes, signal);
    } catch (error) {
      if (error?.name === 'TimeoutError') throw ocmFailure('timeout');
      throw ocmFailure('malformed');
    }
  }

  /** The lookup tables, refreshed daily and shared by every box. */
  async function referenceData(key) {
    if (reference && now() - reference.at < OCM_REFERENCE_TTL_MS)
      return reference.refs;
    referenceInflight ??= upstreamJson(
      `${OCM_API_BASE}/referencedata/`,
      key,
      OCM_REFERENCE_MAX_BYTES,
    )
      .then((body) => {
        const refs = indexReferenceData(body);
        if (!refs) throw ocmFailure('malformed');
        reference = { at: now(), refs };
        return refs;
      })
      .finally(() => {
        referenceInflight = null;
      });
    try {
      return await referenceInflight;
    } catch (error) {
      // Day-old tables still name providers correctly; use them over nothing.
      if (reference) return reference.refs;
      throw error;
    }
  }

  async function refresh(box, key) {
    const time = now();
    recent = recent.filter((at) => time - at < 60_000);
    if (recent.length >= OCM_UPSTREAM_PER_MIN) throw ocmFailure('busy');
    const refs = await referenceData(key);
    recent.push(now());
    const body = await upstreamJson(ocmPoiUrl(box), key, OCM_POI_MAX_BYTES);
    if (!Array.isArray(body)) throw ocmFailure('malformed');
    const sites = [];
    for (const poi of body.slice(0, OCM_MAX_RESULTS)) {
      const site = trimOcmSite(poi, refs);
      if (site) sites.push(site);
    }
    return {
      fetchedAt: now(),
      saturated: body.length >= OCM_MAX_RESULTS,
      count: sites.length,
      sites,
    };
  }

  function remember(cacheKey, payload) {
    answers.delete(cacheKey);
    if (answers.size >= OCM_CACHE_ENTRIES)
      answers.delete(answers.keys().next().value);
    answers.set(cacheKey, { at: payload.fetchedAt, payload });
  }

  const installMiddleware = (server) => {
    server.middlewares.use('/api/ocm', async (req, res) => {
      // Gate first: a cross-site page must not spend this key's goodwill.
      if (admitSameSite(req, res)) return;
      const sendJson = (status, body) => {
        if (res.headersSent) return;
        res.writeHead(status, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(body));
      };
      try {
        if (req.method && req.method !== 'GET') {
          sendJson(405, { error: 'method_not_allowed' });
          return;
        }
        const [subPath, query = ''] = String(req.url || '').split('?');
        if (subPath === '/status') {
          sendJson(200, { hasKey: Boolean(apiKey()) });
          return;
        }
        if (subPath !== '/poi') {
          sendJson(404, { error: 'not_found' });
          return;
        }
        const box = validOcmBox(new URLSearchParams(query));
        if (!box) {
          sendJson(400, { error: 'invalid_bbox' });
          return;
        }
        const snapped = quantizeOcmBox(box);
        if (
          snapped.north - snapped.south > OCM_MAX_SPAN_DEG ||
          snapped.east - snapped.west > OCM_MAX_SPAN_DEG
        ) {
          sendJson(400, { error: 'bbox_too_large' });
          return;
        }
        const key = apiKey();
        if (!key) {
          sendJson(503, { error: 'no_key' });
          return;
        }
        const cacheKey = ocmCacheKey(snapped);
        const cached = answers.get(cacheKey);
        if (cached && now() - cached.at < OCM_POI_TTL_MS) {
          sendJson(200, { ...cached.payload, stale: false });
          return;
        }
        if (!inflight.has(cacheKey))
          inflight.set(
            cacheKey,
            refresh(snapped, key)
              .then((payload) => {
                remember(cacheKey, payload);
                return payload;
              })
              .finally(() => inflight.delete(cacheKey)),
          );
        try {
          sendJson(200, { ...(await inflight.get(cacheKey)), stale: false });
        } catch (error) {
          console.warn(
            `[ocm-proxy] refresh failed (${error?.ocmReason || 'error'}${
              error?.upstreamStatus ? ` ${error.upstreamStatus}` : ''
            })${cached ? ' — serving the last answer' : ''}`,
          );
          if (cached) sendJson(200, { ...cached.payload, stale: true });
          else sendJson(...ocmErrorResponse(error));
        }
      } catch (error) {
        console.warn('[ocm-proxy] error:', error?.name || 'error');
        sendJson(500, { error: 'proxy' });
      }
    });
  };
  return {
    name: 'open-charge-map-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}

export const OCM_API_BASE = 'https://api.openchargemap.io/v3';
const OCM_USER_AGENT =
  'gods-eye-view (+https://github.com/bilawalsidhu/gods-eye-view)';
const OCM_UPSTREAM_TIMEOUT_MS = 15_000;
const OCM_POI_TTL_MS = 10 * 60_000;
const OCM_REFERENCE_TTL_MS = 24 * 3_600_000;
const OCM_CACHE_ENTRIES = 128;
const OCM_UPSTREAM_PER_MIN = 30;
/** A full referencedata answer is about 0.6 MB. */
const OCM_REFERENCE_MAX_BYTES = 8 * 1024 * 1024;
/** 500 compact POIs are well under 2 MB; this bounds a runaway body. */
const OCM_POI_MAX_BYTES = 8 * 1024 * 1024;
/** Sites one read returns; reaching it reports `saturated`. */
export const OCM_MAX_RESULTS = 500;
/** Cache grid. A box is snapped outward onto it before the upstream query. */
export const OCM_GRID_DEG = 0.01;
/** Widest snapped box accepted, per axis. A 16-tile z14 view is ~0.35°. */
export const OCM_MAX_SPAN_DEG = 0.5;

/**
 * Providers dropped even though OCM marks them open data:
 * 7 Mobie.pt is "Public Data redistributed by agreement", an agreement with
 * OCM that does not extend to this application's users;
 * 26 Oplaadpalen.nl publishes under CC BY-NC-SA 3.0, a non-commercial licence
 * this MIT application cannot pass on to its users.
 */
export const OCM_EXCLUDED_PROVIDER_IDS = Object.freeze(new Set([7, 26]));

/** StatusType ids for listings OCM keeps only as history. */
const OCM_REMOVED_STATUS_IDS = new Set([200, 210]);
/**
 * OperatorInfo placeholders rather than operators: 1 "(Unknown Operator)",
 * 44 "(Private Residence/Individual)", 45 "(Business Owner at Location)".
 */
const OCM_PLACEHOLDER_OPERATOR_IDS = new Set([1, 44, 45]);
/** ConnectionType 0 is "Unknown" ("Not Specified"). */
const OCM_UNKNOWN_CONNECTION_TYPE_ID = 0;

/**
 * Whether a DataProvider's records may be shown: open-data licensed by OCM's
 * own flag (strictly `true`, so false and null both fail) and not excluded.
 * @param {?{ID:number, IsOpenDataLicensed:?boolean}} provider
 * @returns {boolean}
 */
export function ocmProviderIsOpen(provider) {
  return (
    provider?.IsOpenDataLicensed === true &&
    Number.isInteger(provider.ID) &&
    !OCM_EXCLUDED_PROVIDER_IDS.has(provider.ID)
  );
}

/**
 * A short licence name for the card, or null when the provider's licence text
 * is not one of the forms recognised here (the full text is still credited).
 * @param {unknown} text DataProvider `License`.
 * @returns {string|null}
 */
export function ocmLicenceLabel(text) {
  const value = typeof text === 'string' ? text : '';
  if (/\bCC[- ]?BY[- ]?4\.0\b|Attribution 4\.0/i.test(value))
    return 'CC BY 4.0';
  if (/licenses\/by\/3\.0|\bCC[- ]?BY[- ]?3\.0\b/i.test(value))
    return 'CC BY 3.0';
  if (/\bCC[- ]?0\b|\bCC0\b/i.test(value)) return 'CC0';
  if (/^CC-BY$/i.test(value.trim())) return 'CC BY';
  if (/Open Government Licence v?(\d\.\d)/i.test(value))
    return `OGL v${/Open Government Licence v?(\d\.\d)/i.exec(value)[1]}`;
  if (/Licence Ouverte|Open License: https:\/\/www\.etalab/i.test(value))
    return 'Licence Ouverte';
  return null;
}

/**
 * Lookup maps from an OCM referencedata body, or null when it is not one.
 * @param {unknown} body
 * @returns {?{providers:Map, statuses:Map, connectionTypes:Map, operators:Map}}
 */
export function indexReferenceData(body) {
  if (!body || !Array.isArray(body.DataProviders)) return null;
  const byId = (rows) =>
    new Map(
      (Array.isArray(rows) ? rows : [])
        .filter((row) => Number.isInteger(row?.ID))
        .map((row) => [row.ID, row]),
    );
  return {
    providers: byId(body.DataProviders),
    statuses: byId(body.StatusTypes),
    connectionTypes: byId(body.ConnectionTypes),
    operators: byId(body.Operators),
  };
}

const text = (value, max) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed ? trimmed.slice(0, max) : null;
};
const positiveInt = (value) =>
  Number.isInteger(value) && value > 0 ? value : null;
const positiveNumber = (value) =>
  Number.isFinite(value) && value > 0 ? value : null;
const time = (value) => {
  const at = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? at : null;
};
const httpUrl = (value) => {
  try {
    const url = new URL(String(value));
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
};

function ocmStatus(statuses, id) {
  if (!Number.isInteger(id)) return null;
  const status = statuses.get(id);
  return {
    id,
    operational:
      typeof status?.IsOperational === 'boolean' ? status.IsOperational : null,
  };
}

/**
 * One compact OCM POI as the trimmed, licence-checked site the browser gets,
 * or null when it may not be shown or is unusable.
 * @param {object} poi Compact POI (`compact=true`): reference fields are ids.
 * @param {ReturnType<typeof indexReferenceData>} refs
 * @returns {object|null}
 */
export function trimOcmSite(poi, refs) {
  const provider = refs.providers.get(poi?.DataProviderID);
  if (!ocmProviderIsOpen(provider)) return null;
  const id = positiveInt(poi.ID);
  const latitude = poi.AddressInfo?.Latitude;
  const longitude = poi.AddressInfo?.Longitude;
  if (
    !id ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180
  )
    return null;
  if (OCM_REMOVED_STATUS_IDS.has(poi.StatusTypeID)) return null;
  const operatorInfo = refs.operators.get(poi.OperatorID);
  const operator = OCM_PLACEHOLDER_OPERATOR_IDS.has(poi.OperatorID)
    ? null
    : text(operatorInfo?.Title, 120);
  // A charger someone offers at home is shown where it is, without a street
  // address.
  const address =
    operatorInfo?.IsPrivateIndividual === true
      ? ''
      : [poi.AddressInfo.AddressLine1, poi.AddressInfo.Town]
          .map((part) => text(part, 120))
          .filter(Boolean)
          .join(', ');
  return {
    id,
    latitude,
    longitude,
    title: text(poi.AddressInfo.Title, 160),
    operator,
    address: address || null,
    status: ocmStatus(refs.statuses, poi.StatusTypeID),
    lastStatusUpdate: time(poi.DateLastStatusUpdate),
    connections: (Array.isArray(poi.Connections) ? poi.Connections : [])
      .slice(0, 16)
      .map((connection) => ({
        type:
          connection?.ConnectionTypeID === OCM_UNKNOWN_CONNECTION_TYPE_ID
            ? null
            : text(
                refs.connectionTypes.get(connection?.ConnectionTypeID)?.Title,
                80,
              ),
        powerKw: positiveNumber(connection?.PowerKW),
        quantity: positiveInt(connection?.Quantity),
        status: ocmStatus(refs.statuses, connection?.StatusTypeID),
      })),
    numberOfPoints: positiveInt(poi.NumberOfPoints),
    usageCost: text(poi.UsageCost, 120),
    provider: {
      id: provider.ID,
      name: text(provider.Title, 120),
      licence: ocmLicenceLabel(provider.License),
      licenceText: text(provider.License, 300),
      url: httpUrl(provider.WebsiteURL),
    },
  };
}

/**
 * The query box, or null unless all four bounds are finite numbers inside the
 * globe with south < north and west < east.
 * @param {URLSearchParams} params
 */
export function validOcmBox(params) {
  const south = requiredFiniteQueryNumber(params, 'south');
  const west = requiredFiniteQueryNumber(params, 'west');
  const north = requiredFiniteQueryNumber(params, 'north');
  const east = requiredFiniteQueryNumber(params, 'east');
  if (![south, west, north, east].every(Number.isFinite)) return null;
  if (
    south < -90 ||
    north > 90 ||
    west < -180 ||
    east > 180 ||
    south >= north ||
    west >= east
  )
    return null;
  return { south, west, north, east };
}

/** Snap a box outward onto the OCM_GRID_DEG grid. */
export function quantizeOcmBox(box, step = OCM_GRID_DEG) {
  // Round the ratio first so a bound on a grid line stays on it.
  const snap = (value, grow) => {
    const cells = Number((value / step).toFixed(9));
    return Number(
      ((grow > 0 ? Math.ceil(cells) : Math.floor(cells)) * step).toFixed(6),
    );
  };
  return {
    south: Math.max(-90, snap(box.south, -1)),
    west: Math.max(-180, snap(box.west, -1)),
    north: Math.min(90, snap(box.north, 1)),
    east: Math.min(180, snap(box.east, 1)),
  };
}

export function ocmCacheKey(box) {
  return [box.south, box.west, box.north, box.east]
    .map((value) => value.toFixed(2))
    .join(',');
}

/**
 * The upstream POI URL for a snapped box. Built only from the four numbers;
 * nothing the client sends is forwarded. The key is not in it.
 */
export function ocmPoiUrl(box) {
  const params = new URLSearchParams({
    output: 'json',
    // The API documents the corners as top left, then bottom right.
    boundingbox: `(${box.north},${box.west}),(${box.south},${box.east})`,
    maxresults: String(OCM_MAX_RESULTS),
    compact: 'true',
    verbose: 'false',
    opendata: 'true',
  });
  return `${OCM_API_BASE}/poi/?${params}`;
}

function ocmFailure(reason, upstreamStatus = null) {
  return Object.assign(new Error(`ocm ${reason}`), {
    ocmReason: reason,
    upstreamStatus: Number.isInteger(upstreamStatus) ? upstreamStatus : null,
  });
}

/**
 * The fixed [status, body] for a failed refresh with nothing cached. Bodies
 * carry a reason and at most the upstream status number, never upstream text.
 */
export function ocmErrorResponse(error) {
  switch (error?.ocmReason) {
    case 'busy':
      return [429, { error: 'rate_limited' }];
    case 'http':
      return error.upstreamStatus === 429
        ? [429, { error: 'rate_limited' }]
        : [502, { error: 'upstream', upstreamStatus: error.upstreamStatus }];
    case 'timeout':
      return [504, { error: 'timeout' }];
    case 'network':
      return [502, { error: 'network' }];
    case 'malformed':
      return [502, { error: 'malformed' }];
    default:
      return [500, { error: 'proxy' }];
  }
}
