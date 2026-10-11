/**
 * Shared keyless Wikidata plumbing for the map dossiers (aircraft, space).
 *
 * Uses the MediaWiki Action APIs with `origin=*` (CORS) rather than the query
 * service. Every request has a deadline and a body cap, a 429 gets one polite
 * retry, and lookups are cached (LRU + TTL) with in-flight sharing so a
 * caller's abort never cancels a request another caller is waiting on.
 */
import { readResponseJsonCapped } from './httpBody.js';
import { requestWithDeadline } from './requestDeadline.js';

export const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';
export const WIKIPEDIA_API = 'https://en.wikipedia.org/w/api.php';
const TIMEOUT_MS = 12_000;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const RETRY_CAP_MS = 5000;
const MAX_ENTITIES_PER_REQUEST = 50;
const COMMONS_FILE_PATH =
  'https://commons.wikimedia.org/wiki/Special:FilePath/';
const PHOTO_WIDTH_PX = 320;

/**
 * Create a rate-polite JSON client for the Wikidata/Wikipedia Action APIs.
 * @param {object} options
 * @param {typeof fetch} options.fetchImpl
 * @param {string} options.clientId Sent as `Api-User-Agent`.
 */
export function createWikidataClient({ fetchImpl, clientId }) {
  async function getJsonOnce(endpoint, params, signal) {
    signal?.throwIfAborted();
    const url = `${endpoint}?${new URLSearchParams({
      ...params,
      format: 'json',
      formatversion: '2',
      origin: '*',
    })}`;
    return requestWithDeadline(
      async (requestSignal) => {
        const response = await fetchImpl(url, {
          signal: requestSignal,
          headers: { 'Api-User-Agent': clientId },
        });
        if (!response.ok) {
          void response.body?.cancel?.().catch(() => {});
          const error = new Error(
            response.status === 429
              ? 'Wikidata rate limit — try again shortly'
              : `Wikidata HTTP ${response.status}`,
          );
          error.status = response.status;
          error.retryAfter = response.headers?.get?.('retry-after');
          throw error;
        }
        return readResponseJsonCapped(response, MAX_BODY_BYTES, requestSignal);
      },
      { signal, timeoutMs: TIMEOUT_MS },
    );
  }

  async function getJson(endpoint, params, signal) {
    try {
      return await getJsonOnce(endpoint, params, signal);
    } catch (error) {
      if (error?.status !== 429) throw error;
      // One polite retry after Wikimedia's back-off hint (capped).
      const waitMs = Math.min(
        RETRY_CAP_MS,
        Math.max(1000, (Number(error.retryAfter) || 2) * 1000),
      );
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, waitMs);
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(signal.reason);
          },
          { once: true },
        );
      });
      return getJsonOnce(endpoint, params, signal);
    }
  }

  async function getEntities(ids, props, signal) {
    const unique = [...new Set(ids.filter(Boolean))].slice(
      0,
      MAX_ENTITIES_PER_REQUEST,
    );
    if (!unique.length) return {};
    const json = await getJson(
      WIKIDATA_API,
      {
        action: 'wbgetentities',
        ids: unique.join('|'),
        props,
        languages: 'en',
        languagefallback: '1',
      },
      signal,
    );
    return json?.entities || {};
  }

  /**
   * English labels for item ids; a failure yields an empty map unless aborted.
   * @returns {Promise<Map<string, string>>}
   */
  async function getLabels(ids, signal) {
    const entities = await getEntities(ids, 'labels', signal).catch((error) => {
      if (signal?.aborted) throw error;
      return {};
    });
    return new Map(
      Object.entries(entities)
        .map(([qid, item]) => [qid, item?.labels?.en?.value])
        .filter(([, label]) => label),
    );
  }

  /**
   * Wikidata items linked from the top English Wikipedia search hits.
   * @param {string} query
   * @param {number} limit
   * @param {AbortSignal} signal
   * @returns {Promise<{id: string, title: string}[]>}
   */
  async function searchWikipedia(query, limit, signal) {
    const json = await getJson(
      WIKIPEDIA_API,
      {
        action: 'query',
        generator: 'search',
        gsrsearch: query,
        gsrlimit: String(limit),
        gsrnamespace: '0',
        prop: 'pageprops',
        ppprop: 'wikibase_item',
        redirects: '1',
      },
      signal,
    );
    return (json?.query?.pages || [])
      .filter((page) => /^Q\d+$/.test(page?.pageprops?.wikibase_item || ''))
      .sort((a, b) => (a.index ?? 99) - (b.index ?? 99))
      .map((page) => ({
        id: page.pageprops.wikibase_item,
        title: String(page.title || ''),
      }));
  }

  /**
   * Wikidata full-text search, e.g. `haswbstatement:P377=25544`.
   * @returns {Promise<{ids: string[], total: number}>}
   */
  async function searchStatements(query, limit, signal) {
    const json = await getJson(
      WIKIDATA_API,
      {
        action: 'query',
        list: 'search',
        srsearch: query,
        srlimit: String(limit),
        srprop: '',
        srinfo: 'totalhits',
      },
      signal,
    );
    const ids = (json?.query?.search || [])
      .map((hit) => hit?.title)
      .filter((title) => /^Q\d+$/.test(title || ''));
    return {
      ids,
      total: Number(json?.query?.searchinfo?.totalhits) || ids.length,
    };
  }

  return { getJson, getEntities, getLabels, searchWikipedia, searchStatements };
}

/**
 * Wrap a loader with an LRU/TTL cache and in-flight sharing.
 * @param {object} options
 * @param {(input: any, signal: AbortSignal) => Promise<any>} options.load
 *   Receives the lookup's `input` (defaults to the key).
 * @param {() => number} options.now
 * @param {number} options.limit Max cached keys.
 * @param {number} options.ttlMs TTL for found (truthy) values.
 * @param {number} options.missTtlMs TTL for null values.
 * @returns {(key: string, signal?: AbortSignal, input?: any) => Promise<any>}
 */
export function createCachedLookup({ load, now, limit, ttlMs, missTtlMs }) {
  const cache = new Map();
  const inflight = new Map();

  function cached(key, at) {
    const hit = cache.get(key);
    if (!hit) return undefined;
    if (at - hit.at > hit.ttl) {
      cache.delete(key);
      return undefined;
    }
    cache.delete(key);
    cache.set(key, hit);
    return hit.value;
  }

  function store(key, value, at) {
    cache.delete(key);
    cache.set(key, { value, at, ttl: value ? ttlMs : missTtlMs });
    while (cache.size > limit) cache.delete(cache.keys().next().value);
  }

  return function lookup(key, signal, input = key) {
    const hit = cached(key, now());
    if (hit !== undefined) return Promise.resolve(hit);
    if (!inflight.has(key)) {
      // Shared across callers, so a single caller's abort must not cancel it.
      const controller = new AbortController();
      const promise = Promise.resolve()
        .then(() => load(input, controller.signal))
        .then((value) => {
          store(key, value, now());
          return value;
        })
        .finally(() => inflight.delete(key));
      inflight.set(key, promise);
    }
    const shared = inflight.get(key);
    if (!signal) return shared;
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      shared
        .then(resolve, reject)
        .finally(() => signal.removeEventListener('abort', onAbort));
    });
  };
}

/** Non-deprecated claims with a value. */
export function claimsOf(entity, property) {
  return (entity?.claims?.[property] || []).filter(
    (claim) => claim?.rank !== 'deprecated' && claim?.mainsnak?.datavalue,
  );
}

/** Item ids (QIDs) a property points at. */
export function itemIds(entity, property) {
  return claimsOf(entity, property)
    .map((claim) => claim.mainsnak.datavalue.value?.id)
    .filter((id) => typeof id === 'string');
}

/** Units normalised by {@link quantities}: Wikidata unit QID → base unit. */
export const UNIT = {
  Q11573: { to: 'm', factor: 1 }, // metre
  Q3710: { to: 'm', factor: 0.3048 }, // foot
  Q11570: { to: 'kg', factor: 1 }, // kilogram
  Q191118: { to: 'kg', factor: 1000 }, // tonne
  Q100995: { to: 'kg', factor: 0.45359237 }, // pound
  Q180154: { to: 'km/h', factor: 1 }, // kilometre per hour
  Q128822: { to: 'km/h', factor: 1.852 }, // knot
  Q211256: { to: 'km/h', factor: 1.609344 }, // mile per hour
  Q182429: { to: 'km/h', factor: 3.6 }, // metre per second
  Q828224: { to: 'km', factor: 1 }, // kilometre
  Q93318: { to: 'km', factor: 1.852 }, // nautical mile
  Q253276: { to: 'km', factor: 1.609344 }, // mile
  Q160669: { to: 'mach', factor: 1 }, // Mach number
  Q22673229: { to: 'm/s', factor: 0.00508 }, // foot per minute
  Q21014455: { to: 'm/s', factor: 1 / 60 }, // metre per minute
  Q25343: { to: 'm²', factor: 1 }, // square metre
  Q857027: { to: 'm²', factor: 0.09290304 }, // square foot
  Q3320608: { to: 'kW', factor: 1 }, // kilowatt
  Q2276380: { to: 'kW', factor: 0.745699872 }, // imperial horsepower
  Q160857: { to: 'kW', factor: 0.73549875 }, // metric horsepower
  Q28390: { to: 'deg', factor: 1 }, // degree
  Q7727: { to: 'min', factor: 1 }, // minute
  Q25235: { to: 'min', factor: 60 }, // hour
  Q573: { to: 'min', factor: 1440 }, // day
  Q11574: { to: 'min', factor: 1 / 60 }, // second
  Q174728: { to: 'm', factor: 0.01 }, // centimetre
  Q174789: { to: 'm', factor: 0.001 }, // millimetre
};

const ROLE_QUALIFIERS = ['P3831', 'P1013'];

/** Role qualifier (P3831 or P1013) of a statement, or null. */
export function claimRole(claim) {
  for (const qualifier of ROLE_QUALIFIERS) {
    const id = claim.qualifiers?.[qualifier]?.[0]?.datavalue?.value?.id;
    if (typeof id === 'string') return id;
  }
  return null;
}

/**
 * Quantity claims normalised to base units.
 * @param {object} entity
 * @param {string} property
 * @param {((role: string|null) => boolean)|null} [acceptRole] Keep only
 *   statements whose role qualifier passes (null when unqualified).
 */
export function quantities(entity, property, acceptRole = null) {
  const out = [];
  for (const claim of claimsOf(entity, property)) {
    if (acceptRole && !acceptRole(claimRole(claim))) continue;
    const value = claim.mainsnak.datavalue.value;
    const amount = Number(value?.amount);
    if (!Number.isFinite(amount)) continue;
    const unitId = String(value?.unit || '')
      .split('/')
      .pop();
    if (unitId === '1') out.push({ value: amount, unit: '' });
    else if (UNIT[unitId])
      out.push({
        value: amount * UNIT[unitId].factor,
        unit: UNIT[unitId].to,
      });
  }
  return out;
}

/** Trimmed non-empty string values of a property. */
export function strings(entity, property) {
  return claimsOf(entity, property)
    .map((claim) => claim.mainsnak.datavalue.value)
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => value.trim());
}

/**
 * Time values as `{year, month, day, decade}`, ordered earliest first.
 * Month/day are null when the statement is less precise than that; `decade`
 * marks a decade-precision value ("2030s").
 */
export function times(entity, property) {
  return claimsOf(entity, property)
    .map((claim) => {
      const value = claim.mainsnak.datavalue.value || {};
      const match = /^([+-]\d+)-(\d\d)-(\d\d)/.exec(value.time || '');
      if (!match) return null;
      const precision = Number(value.precision) || 9;
      return {
        year: Number(match[1]),
        decade: precision === 8,
        month: precision >= 10 ? Number(match[2]) || null : null,
        day: precision >= 11 ? Number(match[3]) || null : null,
      };
    })
    .filter((entry) => entry && Number.isFinite(entry.year))
    .sort(
      (a, b) =>
        a.year - b.year ||
        (a.month || 0) - (b.month || 0) ||
        (a.day || 0) - (b.day || 0),
    );
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** "4 Oct 1957", "Oct 1957", "1957" or "2030s" depending on precision. */
export function formatDate(date) {
  if (!date) return null;
  if (date.decade && date.year >= 0) return `${date.year - (date.year % 10)}s`;
  const year = date.year < 0 ? `${-date.year} BCE` : String(date.year);
  if (!date.month) return year;
  const month = MONTHS[date.month - 1];
  return date.day ? `${date.day} ${month} ${year}` : `${month} ${year}`;
}

/**
 * Thumbnail URL for a Wikimedia Commons file name (`P18` value).
 * @param {string} file Commons file name, e.g. "Boeing 787 N1015X.jpg".
 * @param {number} [width]
 * @returns {string|null}
 */
export function commonsThumbnailUrl(file, width = PHOTO_WIDTH_PX) {
  const name = String(file ?? '')
    .trim()
    .replace(/^File:/i, '')
    .replace(/ /g, '_');
  if (!name) return null;
  return `${COMMONS_FILE_PATH}${encodeURIComponent(name)}?width=${Math.round(width)}`;
}

/** Image payload for a dossier, or null. */
export function commonsImage(file) {
  const url = file ? commonsThumbnailUrl(file) : null;
  return url ? { file, url } : null;
}

export const groupInteger = (value) =>
  Math.round(value).toLocaleString('en-US', { maximumFractionDigits: 0 });

export const decimal = (value) =>
  value < 100 ? value.toFixed(1) : groupInteger(value);

/** Min/max span of normalised values, or null. */
export function range(values) {
  if (!values.length) return null;
  const numbers = values.map((entry) => entry.value);
  return {
    min: Math.min(...numbers),
    max: Math.max(...numbers),
    unit: values[0].unit,
  };
}

/**
 * Format a value or range once with its primary and secondary units,
 * e.g. "31.4–44.5 m (103–146 ft)".
 */
export function formatRange(span, primary, secondary = null) {
  if (!span) return null;
  const same = Math.abs(span.max - span.min) < 1e-9;
  const pair = (fn) =>
    same ? fn(span.max) : `${fn(span.min)}–${fn(span.max)}`;
  const main = `${pair(primary.format)} ${primary.unit}`.trim();
  return secondary
    ? `${main} (${pair(secondary.format)} ${secondary.unit})`
    : main;
}

/** "A, B, C +2 more" from labelled ids (unlabelled ids are skipped). */
export function labelList(ids, labels, max) {
  const named = ids.map((id) => labels.get(id)).filter(Boolean);
  const unique = [...new Set(named)];
  if (!unique.length) return null;
  const shown = unique.slice(0, max).join(', ');
  const extra = ids.length - Math.min(max, unique.length);
  return extra > 0 ? `${shown} +${extra} more` : shown;
}
