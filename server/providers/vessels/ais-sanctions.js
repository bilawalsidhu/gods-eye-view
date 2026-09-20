import { mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { isValidImo, normalizeVesselName } from './ais-identity.js';

/**
 * Vessel sanctions screening.
 *
 * Default source is the US Treasury OFAC Specially Designated Nationals list:
 * public domain, no key, no quota, ~1,500 vessel entries carrying IMO numbers,
 * call signs and flags. OpenSanctions' hosted API is richer (EU/UK/UN in one
 * place) but requires a key, so it is an optional upgrade rather than the
 * baseline — screening must work for someone who added no credentials at all.
 *
 * The list is fetched once, cached on disk, and refreshed daily. Screening
 * itself is an in-memory index lookup, because it runs against every contact
 * in a 20,000-vessel feed.
 */
export const SANCTIONS_DEFAULTS = Object.freeze({
  sdnUrl: 'https://sanctionslistservice.ofac.treas.gov/api/download/sdn.csv',
  cachePath: 'data/ofac-sdn.csv',
  refreshMs: 24 * 60 * 60 * 1000,
  fetchTimeoutMs: 45000,
  // OFAC serves a 403 to clients that send no User-Agent.
  userAgent:
    "God's Eye View (gods-eye-view; sanctions screening; +https://github.com/bilawalsidhu/gods-eye-view)",
});

/** Opt-out for operators who do not want the list fetched at all. */
export function sanctionsEnabled(env = process.env) {
  const raw = String(env.GEV_SANCTIONS ?? '')
    .trim()
    .toLowerCase();
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off')
    return false;
  return true;
}

/**
 * Parses the OFAC SDN CSV into vessel records.
 *
 * The SDN format is positional and quotes inconsistently, so this walks the
 * rows defensively: anything that is not typed `vessel` is skipped, and the
 * IMO is recovered from the free-text remarks column where OFAC files it.
 *
 * @param {string} csv Raw SDN CSV text.
 * @returns {Array<Object>} Vessel entries.
 */
export function parseSdnVessels(csv) {
  const vessels = [];
  for (const row of parseCsvRows(String(csv || ''))) {
    if (row.length < 12) continue;
    if (
      String(row[2] || '')
        .trim()
        .toLowerCase() !== 'vessel'
    )
      continue;
    const remarks = String(row[11] || '');
    const imoMatch = /IMO\s*(\d{7})/i.exec(remarks);
    const name = cleanField(row[1]);
    if (!name) continue;
    vessels.push({
      entity: cleanField(row[0]),
      name,
      program: cleanField(row[3]),
      callSign: cleanField(row[5]),
      vesselType: cleanField(row[6]),
      flag: cleanField(row[9]),
      owner: cleanField(row[10]),
      imo: imoMatch ? imoMatch[1] : '',
      source: 'OFAC SDN',
    });
  }
  return vessels;
}

/** OFAC writes "-0-" for an absent field. */
function cleanField(value) {
  const text = String(value ?? '').trim();
  return text === '-0-' ? '' : text;
}

/** Minimal RFC4180 reader — the SDN file embeds commas inside quoted fields. */
function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') field += char;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Builds the lookup index.
 *
 * IMO is the only identifier here that is globally unique and permanent, so it
 * is the strong key. Call sign and name are reassigned and reused across
 * hulls, which is exactly how a screening system produces false positives —
 * they are indexed, but every match records which key hit so the caller can
 * weigh it.
 */
export function buildSanctionsIndex(vessels) {
  const byImo = new Map();
  const byCallSign = new Map();
  const byName = new Map();
  for (const vessel of vessels) {
    if (vessel.imo) push(byImo, vessel.imo, vessel);
    if (vessel.callSign)
      push(byCallSign, vessel.callSign.toUpperCase(), vessel);
    const name = normalizeVesselName(vessel.name);
    if (name) push(byName, name, vessel);
  }
  return { byImo, byCallSign, byName, size: vessels.length };
}

function push(map, key, value) {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}

/**
 * Screens one contact against a built index.
 *
 * `listed` is reserved for identity-grade evidence — a valid IMO or a call
 * sign. Ship names are not identifiers: they are reused constantly, and a live
 * sample of 3,213 European contacts produced 40 name collisions with the SDN
 * list, every one of them a pleasure craft sharing a name with a sanctioned
 * tanker. Those surface as `possibleNameMatch` for an analyst to judge, and
 * never as a verdict on the vessel.
 *
 * @returns {{listed:boolean, confidence:'IMO'|'CALLSIGN'|'NAME'|null, matches:Array<Object>, possibleNameMatch:boolean}}
 */
export function screenAgainstIndex(index, { imo, callSign, name } = {}) {
  if (!index)
    return {
      listed: false,
      confidence: null,
      matches: [],
      possibleNameMatch: false,
    };
  const cleanImo = String(imo || '').replace(/\D/g, '');
  if (cleanImo && isValidImo(cleanImo)) {
    const hit = index.byImo.get(cleanImo);
    if (hit)
      return {
        listed: true,
        confidence: 'IMO',
        matches: hit,
        possibleNameMatch: false,
      };
  }
  const sign = String(callSign || '')
    .trim()
    .toUpperCase();
  if (sign.length >= 4) {
    const hit = index.byCallSign.get(sign);
    if (hit)
      return {
        listed: true,
        confidence: 'CALLSIGN',
        matches: hit,
        possibleNameMatch: false,
      };
  }
  const normalized = normalizeVesselName(name);
  // Two-character names ("AL", "MV") collide constantly; require real substance.
  if (normalized.length >= 5) {
    const hit = index.byName.get(normalized);
    if (hit)
      return {
        listed: false,
        confidence: 'NAME',
        matches: hit,
        possibleNameMatch: true,
      };
  }
  return {
    listed: false,
    confidence: null,
    matches: [],
    possibleNameMatch: false,
  };
}

/**
 * Creates the screening service: disk-cached list, lazy refresh, index lookup.
 * Never throws outward — an unreachable Treasury endpoint degrades to "no
 * screening", never to a broken vessel feed.
 */
export function createSanctionsScreening({
  cachePath = process.env.GEV_SANCTIONS_CACHE || SANCTIONS_DEFAULTS.cachePath,
  sdnUrl = process.env.GEV_SANCTIONS_SDN_URL || SANCTIONS_DEFAULTS.sdnUrl,
  refreshMs = SANCTIONS_DEFAULTS.refreshMs,
  now = () => Date.now(),
  // Bound, not passed bare: undici's fetch throws when detached from globalThis.
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  let index = null;
  let loadedAt = 0;
  let refreshing = null;
  let lastError = '';
  let sourceLabel = '';

  function loadFromDisk() {
    try {
      const stat = statSync(cachePath);
      const age = now() - stat.mtimeMs;
      const csv = readFileSync(cachePath, 'utf8');
      const vessels = parseSdnVessels(csv);
      if (!vessels.length) return false;
      index = buildSanctionsIndex(vessels);
      loadedAt = stat.mtimeMs;
      sourceLabel = `OFAC SDN (cached ${new Date(stat.mtimeMs).toISOString().slice(0, 10)})`;
      return age < refreshMs;
    } catch {
      return false;
    }
  }

  async function refresh() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        const response = await fetchImpl(sdnUrl, {
          headers: { 'User-Agent': SANCTIONS_DEFAULTS.userAgent },
          signal: AbortSignal.timeout(SANCTIONS_DEFAULTS.fetchTimeoutMs),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const csv = await response.text();
        const vessels = parseSdnVessels(csv);
        if (!vessels.length) throw new Error('no vessel entries parsed');
        try {
          mkdirSync(path.dirname(path.resolve(cachePath)), { recursive: true });
          writeFileSync(cachePath, csv);
        } catch {
          /* cache write is an optimisation, not a requirement */
        }
        index = buildSanctionsIndex(vessels);
        loadedAt = now();
        lastError = '';
        sourceLabel = `OFAC SDN (fetched ${new Date(loadedAt).toISOString().slice(0, 10)})`;
      } catch (error) {
        lastError = String(error?.message || error);
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  /** Loads from cache if fresh, otherwise kicks off a background refresh. */
  function ensure() {
    if (!sanctionsEnabled()) return;
    if (index && now() - loadedAt < refreshMs) return;
    const fresh = loadFromDisk();
    // A stale index still screens while the new list downloads.
    if (!fresh) refresh();
  }

  function screen(contact) {
    ensure();
    return screenAgainstIndex(index, contact);
  }

  function status() {
    return {
      enabled: sanctionsEnabled(),
      ready: Boolean(index),
      entries: index?.size ?? 0,
      loadedAt: loadedAt || null,
      source: sourceLabel || null,
      error: lastError || null,
      cachePath,
    };
  }

  return {
    ensure,
    screen,
    status,
    refresh,
    get index() {
      return index;
    },
  };
}
