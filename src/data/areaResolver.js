/**
 * Named place → area handle, through the outline ladder that needs no public
 * Overpass:
 *
 *   1. the area store (a query already resolved this session);
 *   2. bundled Natural Earth physical/marine regions;
 *   3. bundled countries and states/provinces by name — a name several
 *      prominent units share ("Georgia", "Punjab") asks which one, unless
 *      the view is inside exactly one of them;
 *   4. the annotation outline ladder (`resolveNamedOutline`): bundled
 *      counties, US Census places and neighbourhood packs, then the guarded
 *      Nominatim outline route, then Overpass only when an operator
 *      configured it.
 *
 * Providers are injected, so the ladder runs under node:test:
 *   findNaturalRegion(query) → {name, polygons, kind}|null
 *   findAdminCandidates(query) → Array<AdminArea> (see data/adminBoundaries.js)
 *   resolveNamedOutline(query, {level, levelHint, signal}) →
 *     {ok:true, name, polygons, source, rung, approximate?, country?}
 *     |{ok:false, code, error}
 *   viewCenter() → {lat, lon}|null
 *
 * @module data/areaResolver
 */

import { AREA_LEVELS } from './areaStore.js';
import { pointInPreparedArea, prepareArea } from './areaGeometry.js';
import { adminQueryIdentity, normalizeAdminName } from './adminBoundaries.js';
import {
  isAreaCandidateId,
  MAX_AREA_CANDIDATE_ID_LENGTH,
} from '../voice/areaCandidateContract.js';
export {
  AREA_CANDIDATE_ID_PATTERN,
  isAreaCandidateId,
  MAX_AREA_CANDIDATE_ID_LENGTH,
} from '../voice/areaCandidateContract.js';

/** Most candidates a clarification offers. */
export const MAX_AREA_CANDIDATES = 4;
/** Candidates remembered for a follow-up `candidateId`. */
const CANDIDATE_MEMORY = 24;

/**
 * A place name as a cache and matching key: case-folded and NFKC-normalized,
 * punctuation dropped, letters, marks and digits in every script kept (東京
 * and 大阪 are different keys). Empty when the text names nothing.
 */
export function normalizeAreaQuery(text) {
  return String(text || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N} ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^the /, '');
}

/** Words that name the kind of area rather than the area. */
const LEVEL_WORDS = [
  [/\b(province|state|region|oblast|prefecture|canton|governorate)$/, 'admin1'],
  [/\b(county|district|department)$/, 'admin2'],
  [/\b(city|town|municipality|metropolitan city)$/, 'city'],
  [/\b(neighbou?rhood|borough|suburb|quarter)$/, 'district'],
  [/\b(country|nation)$/, 'country'],
];

/**
 * Strip a trailing level word ("Bagmati province" → "bagmati", admin1). The
 * word is kept as a hint, not a filter, since names often contain it.
 */
export function splitLevelWord(query) {
  const norm = normalizeAreaQuery(query);
  for (const [re, level] of LEVEL_WORDS) {
    if (re.test(norm)) {
      const bare = norm.replace(re, '').trim();
      if (bare) return { bare, level };
    }
  }
  return { bare: norm, level: null };
}

/** Area level of a bundled admin unit. */
const ADMIN_LEVEL = Object.freeze({
  country: 'country',
  state: 'admin1',
  county: 'admin2',
  natural: 'natural',
});

/**
 * One of several same-name natural places as a clarification choice, located
 * by its rough centre ("39 N 31 W") since it has no country.
 */
function naturalCandidate(place, kind) {
  const { lat, lon } = place.center || {};
  const locator = Number.isFinite(lat)
    ? `${Math.abs(Math.round(lat))} ${lat >= 0 ? 'N' : 'S'} ${Math.abs(Math.round(lon))} ${lon >= 0 ? 'E' : 'W'}`
    : '';
  return {
    kind: 'natural',
    name: place.name,
    country: '',
    regionCode: locator,
    polygons: place.polygons.map((ring) => [ring]),
    source: 'natural-earth',
    meta: { kind },
  };
}

const ADMIN_NAME_LEVEL = Object.freeze({
  country: 'country',
  nation: 'country',
  province: 'admin1',
  state: 'admin1',
  region: 'admin1',
  oblast: 'admin1',
  prefecture: 'admin1',
  canton: 'admin1',
  governorate: 'admin1',
  county: 'admin2',
  district: 'admin2',
  department: 'admin2',
});

/**
 * Drop accents from Latin letters only, for comparing names: speech often
 * loses them ("Quebec" for "Québec"), while a Thai or Devanagari mark changes
 * the name and is kept.
 */
export function foldLatinMarks(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/(\p{Script=Latin})\p{M}+/gu, '$1')
    .normalize('NFC');
}

function explicitAdminName(text) {
  const normalized = normalizeAreaQuery(String(text).split(',')[0]);
  const match = normalized.match(
    /\b(country|nation|province|state|region|zone|oblast|prefecture|canton|governorate|county|district|department)$/,
  );
  return {
    normalized,
    bare: foldLatinMarks(
      match ? normalized.slice(0, -match[0].length).trim() : normalized,
    ),
    word: match?.[1] || null,
    level: match ? ADMIN_NAME_LEVEL[match[1]] || null : null,
  };
}

/**
 * Fail closed when a bundled unit's own name contradicts the requested unit.
 * With `aliases`, an ask the administrative matcher reads as naming this very
 * unit at its level ("State of Texas", "USA") also matches; the natural-region
 * check leaves it off, since "Great Britain" is not the United Kingdom.
 */
function bundledAdminIdentityRefusal(
  admin,
  query,
  wantedLevel,
  { aliases = true } = {},
) {
  const source = explicitAdminName(admin?.name || '');
  const requested = explicitAdminName(query);
  const expectedLevel = wantedLevel || requested.level;
  const emittedLevel = ADMIN_LEVEL[admin?.kind] || null;
  if (!source.normalized || source.word === 'zone')
    return {
      ok: false,
      code: 'AREA_IDENTITY_UNVERIFIED',
      error: `The bundled boundary is ${admin?.name || 'an unverified administrative unit'}, not a verified current match for "${query}".`,
    };
  const alias = aliases ? adminQueryIdentity(query) : null;
  const named =
    source.bare === requested.bare ||
    Boolean(
      alias &&
      alias.level === emittedLevel &&
      alias.name === normalizeAdminName(admin.name),
    );
  if (
    !named ||
    (source.level && expectedLevel && source.level !== expectedLevel) ||
    (expectedLevel && emittedLevel !== expectedLevel)
  )
    return {
      ok: false,
      code: 'AREA_IDENTITY_MISMATCH',
      error: `The bundled boundary is ${admin.name}, not the requested administrative area "${query}".`,
    };
  return null;
}

function stableCandidateHash(value) {
  let hash = 0x811c9dc5;
  for (const char of String(value)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function candidateIdOf(admin) {
  const prefix = `ne:${admin.kind}:`;
  // The region code keeps same-named units apart: "Washington" is both WA
  // and DC, which would otherwise share one candidate and one stored area.
  const slug = normalizeAreaQuery(
    `${admin.country} ${admin.name} ${admin.regionCode || ''}`,
  ).replace(/ /g, '-');
  const full = `${prefix}${slug}`;
  if (full.length <= MAX_AREA_CANDIDATE_ID_LENGTH) return full;
  const suffix = `-${stableCandidateHash(slug)}`;
  let shortened = '';
  for (const char of slug) {
    if (
      `${prefix}${shortened}${char}${suffix}`.length >
      MAX_AREA_CANDIDATE_ID_LENGTH
    )
      break;
    shortened += char;
  }
  return `${prefix}${shortened.replace(/-+$/u, '')}${suffix}`;
}

/** Short, speakable identity for a clarification choice. */
function describeCandidate(admin) {
  return {
    candidateId: candidateIdOf(admin),
    name: admin.name,
    level: ADMIN_LEVEL[admin.kind] || null,
    // Tells same-named units apart when spoken: Washington WA vs DC.
    ...(admin.regionCode && admin.kind !== 'country'
      ? { region: String(admin.regionCode) }
      : {}),
    ...(admin.country && admin.kind !== 'country'
      ? { country: admin.country }
      : {}),
  };
}

/**
 * Distinct places among bundled candidates. Within one country, the country
 * itself stands for its same-named state ("Mexico" is the country, not the
 * State of Mexico); across countries each name is its own place.
 */
/** A coarse ~2° cell of the view, or "none", for keying view-picked answers. */
function viewCell(center) {
  if (!Number.isFinite(center?.lat) || !Number.isFinite(center?.lon))
    return 'none';
  return `${Math.floor(center.lat / 2)},${Math.floor(center.lon / 2)}`;
}

export function distinctAdminPlaces(candidates) {
  const byCountry = new Map();
  for (const admin of candidates) {
    const list = byCountry.get(admin.country) || [];
    list.push(admin);
    byCountry.set(admin.country, list);
  }
  const out = [];
  for (const list of byCountry.values()) {
    const country = list.find((admin) => admin.kind === 'country');
    out.push(...(country ? [country] : list));
  }
  return out;
}

/**
 * Create a resolver bound to an area store and providers.
 * @param {object} options
 */
export function createAreaResolver({
  store,
  findNaturalRegion = async () => null,
  findAdminCandidates = async () => [],
  resolveNamedOutline = async () => ({
    ok: false,
    code: 'AREA_UNAVAILABLE',
    error: 'Boundary lookup is unavailable here.',
  }),
  viewCenter = () => null,
  onCredit = () => {},
  now = () => Date.now(),
  maxInFlight = 8,
} = {}) {
  if (!store) throw new TypeError('An area store is required');
  /** candidateId → bundled unit and original ask, for a clarification answered later. */
  const candidateMemory = new Map();
  /** query key → in-flight lookup, so a repeat joins the first. */
  const inFlight = new Map();
  const lifetime = new AbortController();
  const inFlightLimit = Number.isFinite(maxInFlight)
    ? Math.max(1, Math.floor(maxInFlight))
    : 8;
  let activeLookups = 0;
  let disposed = false;

  const assertActive = () => lifetime.signal.throwIfAborted();

  const remember = (admin, identity) => {
    const id = candidateIdOf(admin);
    candidateMemory.delete(id);
    candidateMemory.set(id, { admin, identity });
    while (candidateMemory.size > CANDIDATE_MEMORY)
      candidateMemory.delete(candidateMemory.keys().next().value);
  };

  function storeAdmin(admin, confidence, identity) {
    assertActive();
    const refused = bundledAdminIdentityRefusal(
      admin,
      identity?.query,
      identity?.wantedLevel,
    );
    if (refused) return refused;
    const record = store.put({
      geometry: admin.polygons,
      name: admin.name,
      level: ADMIN_LEVEL[admin.kind] || null,
      source: admin.source,
      sourceId: candidateIdOf(admin),
      meta: {
        ...(admin.kind !== 'country' && admin.country
          ? { country: admin.country }
          : {}),
        rung: 'bundled',
      },
    });
    if (!record)
      return {
        ok: false,
        code: 'AREA_NOT_FOUND',
        error: `The boundary for ${admin.name} is not a usable polygon.`,
      };
    onCredit(admin.source);
    return { ok: true, record, confidence, rung: 'bundled' };
  }

  async function lookup({ query, level, within }, { signal }) {
    const { level: levelHint } = splitLevelWord(query);
    const searchText = within ? `${query}, ${within}` : query;
    let bundledRefusal = null;
    // Offline first: a named natural region, unless an admin level or a
    // country/state qualifier was given (the pack cannot check `within`).
    if ((!level || level === 'natural') && !within) {
      const ne = await findNaturalRegion(query, { signal }).catch(() => null);
      signal?.throwIfAborted?.();
      // A region named like a country or state ("India" the peninsula,
      // "Punjab" the desert) never hides it; asked for by level, it answers.
      // Only a unit that really has this name counts: "Great Britain" finds
      // the United Kingdom by alias, which is not a Great Britain.
      // A feature split into parts is one place with every part; distant
      // namesakes (Flores in the Azores and Indonesia) are asked about.
      const places = ne?.places?.length
        ? ne.places
        : ne?.polygons?.length
          ? [{ name: ne.name, polygons: ne.polygons }]
          : [];
      const shadowsAdmin =
        places.length > 0 &&
        level !== 'natural' &&
        (await findAdminCandidates(query, { signal }).catch(() => [])).some(
          (admin) =>
            !bundledAdminIdentityRefusal(admin, query, null, {
              aliases: false,
            }),
        );
      signal?.throwIfAborted?.();
      if (places.length > 1 && !shadowsAdmin) {
        const offered = places
          .slice(0, MAX_AREA_CANDIDATES)
          .map((place) => naturalCandidate(place, ne.kind));
        const identity = { query, wantedLevel: 'natural' };
        offered.forEach((admin) => remember(admin, identity));
        return {
          ok: false,
          needsClarification: true,
          code: 'AMBIGUOUS_AREA',
          candidates: offered.map(describeCandidate),
          error: `"${query}" names ${offered.length} places — ask which one.`,
        };
      }
      if (places.length === 1 && !shadowsAdmin) {
        const record = store.put({
          geometry: places[0].polygons.map((ring) => [ring]),
          name: ne.name,
          level: 'natural',
          source: 'natural-earth',
          sourceId: `ne:${normalizeAreaQuery(ne.name).replace(/ /g, '-')}`,
          meta: { kind: ne.kind, rung: 'bundled' },
        });
        if (record) {
          onCredit('natural-earth');
          return { ok: true, record, confidence: 0.95, rung: 'bundled' };
        }
      }
    }
    signal?.throwIfAborted?.();
    // Bundled countries and states by name. A name prominent units share is
    // asked about, never guessed — except when the view is inside one.
    const wanted = level || levelHint;
    if (!wanted || wanted === 'country' || wanted === 'admin1') {
      let admins = await findAdminCandidates(searchText, { signal }).catch(
        () => [],
      );
      signal?.throwIfAborted?.();
      if (wanted) admins = admins.filter((a) => ADMIN_LEVEL[a.kind] === wanted);
      let places = distinctAdminPlaces(admins);
      const identity = { query, wantedLevel: wanted };
      const checked = places.map((admin) => ({
        admin,
        refused: bundledAdminIdentityRefusal(admin, query, wanted),
      }));
      places = checked
        .filter(({ refused }) => !refused)
        .map(({ admin }) => admin);
      if (!places.length && checked.length) {
        const refused = checked.find((entry) => entry.refused)?.refused;
        // A retired or unverifiable unit is final. A different unit that
        // merely shares the name ("Azad Kashmir" for "Kashmir") is not an
        // answer, so the outline ladder still gets to look.
        if (refused?.code !== 'AREA_IDENTITY_MISMATCH') return refused;
        bundledRefusal = refused;
      }
      if (places.length === 1) {
        return storeAdmin(places[0], 0.95, identity);
      }
      if (places.length > 1) {
        const center = viewCenter();
        const holding = center
          ? places.filter((admin) => {
              const prepared = prepareArea(admin.polygons);
              return (
                prepared &&
                pointInPreparedArea(prepared, center.lat, center.lon)
              );
            })
          : [];
        // Chosen by the view, so never remembered for the name: asked again
        // over the other one, it answers the other one.
        if (holding.length === 1)
          return { ...storeAdmin(holding[0], 0.85, identity), byView: true };
        const offered = places.slice(0, MAX_AREA_CANDIDATES);
        offered.forEach((admin) => remember(admin, identity));
        return {
          ok: false,
          needsClarification: true,
          code: 'AMBIGUOUS_AREA',
          candidates: offered.map(describeCandidate),
          error: `"${query}" names ${offered.length} places — ask which one.`,
        };
      }
    }
    signal?.throwIfAborted?.();
    // Everything else: the annotation outline ladder.
    const outline = await resolveNamedOutline(searchText, {
      level,
      levelHint,
      signal,
    });
    signal?.throwIfAborted?.();
    if (!outline?.ok)
      return (
        bundledRefusal || {
          ok: false,
          code: outline?.code || 'AREA_NOT_FOUND',
          error: outline?.error || `No boundary found for "${query}".`,
        }
      );
    const record = store.put({
      geometry: outline.polygons,
      name: outline.name || query,
      level: level || levelHint || outline.adminLevel || null,
      source: outline.approximate ? 'approximate' : outline.source,
      approximate: Boolean(outline.approximate),
      meta: {
        ...(outline.country ? { country: outline.country } : {}),
        ...(outline.adminName ? { adminName: outline.adminName } : {}),
        ...(outline.adminLevel ? { adminLevel: outline.adminLevel } : {}),
        rung: outline.rung || null,
        ...(outline.basis ? { basis: outline.basis } : {}),
      },
    });
    if (!record)
      return {
        ok: false,
        code: 'AREA_NOT_FOUND',
        error: `The boundary for ${query} is not a usable polygon.`,
      };
    return {
      ok: true,
      record,
      confidence: outline.approximate ? 0.5 : 0.8,
      rung: outline.rung || null,
    };
  }

  /**
   * Resolve a place to an area handle.
   * @param {{query?: string, level?: string, within?: string, candidateId?: string}} args
   * @param {{signal?: AbortSignal, budgetMs?: number}} [options] Past the
   *   budget the call answers AREA_TIMEOUT while the lookup continues and
   *   fills the caches, so asking again shortly is fast.
   * @returns {Promise<object>}
   */
  async function resolve(args = {}, { signal, budgetMs = 8000 } = {}) {
    const started = now();
    const level = AREA_LEVELS.includes(args.level) ? args.level : null;
    const within = String(args.within || '').trim();
    const candidateId = String(args.candidateId || '').trim();
    const finish = (result, cached = false) => ({
      ...result,
      cached,
      ms: now() - started,
    });

    if (disposed)
      return finish({
        ok: false,
        code: 'CANCELLED',
        cancelled: true,
        error: 'Area resolver has been disposed.',
      });

    if (candidateId) {
      if (!isAreaCandidateId(candidateId))
        return finish({
          ok: false,
          code: 'BAD_CANDIDATE',
          error:
            'candidateId is malformed or too long. Resolve the name again.',
        });
      const remembered = candidateMemory.get(candidateId);
      if (!remembered)
        return finish({
          ok: false,
          code: 'UNKNOWN_CANDIDATE',
          error: `Unknown candidateId "${candidateId}". Resolve the name again.`,
        });
      if (signal?.aborted)
        return finish({
          ok: false,
          code: 'CANCELLED',
          cancelled: true,
          error: 'This request was superseded.',
        });
      return finish(storeAdmin(remembered.admin, 0.9, remembered.identity));
    }

    const query = String(args.query || '').trim();
    if (!query)
      return finish({
        ok: false,
        code: 'BAD_AREA',
        error: 'Name a place to resolve.',
      });
    const nameKey = normalizeAreaQuery(query);
    // The outline ladder and geocoder pick by the view ("Springfield" over
    // Illinois), so an answer is reused or shared only within the same
    // ~2° view cell. A name that normalizes to nothing is never cached.
    const key = nameKey
      ? `${nameKey}|${level || ''}|${normalizeAreaQuery(within)}|${viewCell(viewCenter())}`
      : null;
    const recalled = key ? store.recallQuery(key) : null;
    if (recalled)
      return finish(
        { ok: true, record: recalled, confidence: 0.95, rung: 'store' },
        true,
      );

    let pending = key ? inFlight.get(key) : null;
    if (!pending) {
      if (activeLookups >= inFlightLimit)
        return finish({
          ok: false,
          code: 'AREA_BUSY',
          error:
            'Too many area lookups are already running — try again shortly.',
        });
      // The shared lookup outlives any one caller's signal: a superseded turn
      // must not cancel the answer a repeat is waiting on. The resolver's own
      // lifetime still owns the provider work, so final teardown stops it.
      activeLookups += 1;
      pending = lookup({ query, level, within }, { signal: lifetime.signal })
        .then((result) => {
          assertActive();
          if (result.ok && key && !result.byView)
            store.rememberQuery(key, result.record.areaId);
          return result;
        })
        .catch((error) =>
          lifetime.signal.aborted
            ? {
                ok: false,
                code: 'CANCELLED',
                cancelled: true,
                error: 'Area resolver has been disposed.',
              }
            : {
                ok: false,
                code: 'AREA_UNAVAILABLE',
                error: error?.message || 'Boundary lookup failed.',
              },
        )
        .finally(() => {
          activeLookups -= 1;
          if (key) inFlight.delete(key);
        });
      if (key) inFlight.set(key, pending);
    }
    let timer;
    const racers = [pending];
    if (Number.isFinite(budgetMs))
      racers.push(
        new Promise((resolveTimeout) => {
          timer = setTimeout(
            () =>
              resolveTimeout({
                ok: false,
                code: 'AREA_TIMEOUT',
                error: `Looking up "${query}" is taking a while — ask again in a moment.`,
              }),
            budgetMs,
          );
        }),
      );
    // Detached once this call settles: a caller's long-lived signal must not
    // collect one listener per completed lookup.
    let cancelled = null;
    if (signal)
      racers.push(
        new Promise((resolveAbort) => {
          const superseded = {
            ok: false,
            code: 'CANCELLED',
            cancelled: true,
            error: 'Superseded.',
          };
          if (signal.aborted) return resolveAbort(superseded);
          cancelled = () => resolveAbort(superseded);
          signal.addEventListener?.('abort', cancelled, { once: true });
          return undefined;
        }),
      );
    try {
      return finish(await Promise.race(racers));
    } finally {
      clearTimeout(timer);
      if (cancelled) signal.removeEventListener?.('abort', cancelled);
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    lifetime.abort();
    inFlight.clear();
    candidateMemory.clear();
  }

  return {
    resolve,
    dispose,
    candidate: (id) => candidateMemory.get(id) || null,
  };
}
