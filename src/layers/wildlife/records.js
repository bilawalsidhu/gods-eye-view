/**
 * Wildlife tracks: the curated Movebank studies and the pure parsing shared by
 * the `/api/wildlife` proxy and the browser.
 *
 * Only public studies whose licence was checked by hand are listed. Movebank
 * does not expose licence metadata without a login, so each entry names where
 * its licence was verified. Movebank applies each owner's hidden-animal and
 * embargo settings before its public feed answers; nothing here tries to get
 * around them.
 */

/** Latest fixes kept per animal: the glyph and a short recent path. */
export const WILDLIFE_MAX_FIXES = 20;
/** Animals per page in the layer row. */
export const WILDLIFE_PAGE_SIZE = 40;
/** Hard ceilings on what the proxy serves and the browser accepts. */
export const WILDLIFE_MAX_ANIMALS = 2_000;

const DAY_MS = 86_400_000;
/** Time windows the row offers, by the age of an animal's latest fix. */
export const WILDLIFE_WINDOWS = Object.freeze({
  month: Object.freeze({
    label: '30 days',
    ms: 30 * DAY_MS,
    title: 'Show animals whose latest fix is from the last 30 days',
    phrase: 'in the last 30 days',
  }),
  year: Object.freeze({
    label: '1 year',
    ms: 365 * DAY_MS,
    title: 'Show animals whose latest fix is from the last year',
    phrase: 'in the last year',
  }),
  all: Object.freeze({
    label: 'All time',
    ms: Infinity,
    title: 'Show every animal, however old its latest fix',
    phrase: 'with public fixes',
  }),
});

/** Common names for the taxa the curated studies carry. */
export const WILDLIFE_COMMON_NAMES = Object.freeze({
  'Ciconia ciconia': 'White stork',
  'Ichthyaetus melanocephalus': 'Mediterranean gull',
  'Larus argentatus': 'Herring gull',
  'Larus armenicus': 'Armenian gull',
  'Larus fuscus': 'Lesser black-backed gull',
  'Platalea leucorodia': 'Eurasian spoonbill',
});

/** Names short enough for a one-line row and the legend. */
export const WILDLIFE_SHORT_NAMES = Object.freeze({
  'Ciconia ciconia': 'White stork',
  'Ichthyaetus melanocephalus': 'Med gull',
  'Larus argentatus': 'Herring gull',
  'Larus armenicus': 'Armenian gull',
  'Larus fuscus': 'LBB gull',
  'Platalea leucorodia': 'Spoonbill',
});

const study = (entry) => Object.freeze({ licence: 'CC0 1.0', ...entry });

/**
 * Public Movebank studies with a verified CC0 licence, verified 2026-09-30.
 * `doi` is the dataset's concept DOI, so it always resolves to the latest
 * published version.
 */
export const WILDLIFE_STUDIES = Object.freeze([
  study({
    id: 1258895879,
    label: 'Gulls · Neeltje Jans',
    name: 'DELTATRACK',
    species: Object.freeze(['Larus argentatus', 'Larus fuscus']),
    title:
      'Herring gulls and lesser black-backed gulls breeding at Neeltje Jans (Netherlands)',
    owner: 'INBO — Stienen, Buijs, de Visser et al.',
    citation:
      'Stienen EWM, Buijs R-J, de Visser J et al. DELTATRACK - Herring gulls (Larus argentatus) and lesser black-backed gulls (Larus fuscus) breeding at Neeltje Jans (Netherlands). Zenodo.',
    doi: '10.5281/zenodo.10209520',
    licenceSource: 'Zenodo 10.5281/zenodo.22102508',
  }),
  study({
    id: 21231406,
    label: 'Storks · SW Germany',
    name: 'LifeTrack White Stork SW Germany',
    species: Object.freeze(['Ciconia ciconia']),
    title: 'White storks from south-west Germany',
    owner: 'MPI of Animal Behavior — Fiedler, Flack, Wikelski et al.',
    citation:
      'Fiedler W, Flack A, Schäfle W, Keeves B, Quetting M, Eid B, Schmid H, Wikelski M. 2024. Data from: Study "LifeTrack White Stork SW Germany" (2013-2023). Movebank Data Repository.',
    doi: '10.5441/001/1.ck04mn78_2',
    licenceSource: 'Movebank Data Repository 10.5441/001/1.ck04mn78_2',
  }),
  study({
    id: 2298738353,
    label: 'LBB gulls · Belgium',
    name: 'LBBG_ADULT',
    species: Object.freeze(['Larus fuscus']),
    title: 'Lesser black-backed gulls breeding in Belgium',
    owner: 'INBO — Stienen, Müller, Lens et al.',
    citation:
      'Stienen EWM, Müller W, Lens L et al. LBBG_ADULT - Lesser black-backed gulls (Larus fuscus) breeding in Belgium. Zenodo.',
    doi: '10.5281/zenodo.10055493',
    licenceSource: 'Zenodo 10.5281/zenodo.22083084',
  }),
  study({
    id: 1609400843,
    label: 'Med gulls · Antwerp',
    name: 'MEDGULL_ANTWERPEN',
    species: Object.freeze(['Ichthyaetus melanocephalus']),
    title: 'Mediterranean gulls breeding near Antwerp (Belgium)',
    owner: 'INBO — Stienen, Desmet, Govaert et al.',
    citation:
      'Stienen EWM, Desmet P, Govaert S et al. MEDGULL_ANTWERPEN - Mediterranean gulls (Ichthyaetus melanocephalus) breeding near Antwerp (Belgium). Zenodo.',
    doi: '10.5281/zenodo.6599272',
    licenceSource: 'Zenodo 10.5281/zenodo.22108360',
  }),
  study({
    id: 2217728245,
    label: 'Young herring gulls',
    name: 'HG_JUVENILE',
    species: Object.freeze(['Larus argentatus']),
    title:
      'Juvenile herring gulls hatched at the southern North Sea coast (Belgium)',
    owner: 'INBO — Allaert, Stienen, Lens et al.',
    citation:
      'Allaert RA, Stienen EWM, Lens L et al. HG_JUVENILE - Juvenile herring gulls (Larus argentatus) hatched at the southern North Sea coast (Belgium). Zenodo.',
    doi: '10.5281/zenodo.16960866',
    licenceSource: 'Zenodo 10.5281/zenodo.21279427',
  }),
  study({
    id: 4194049025,
    label: 'Armenian gulls',
    name: 'ARMENIAN_GULL',
    species: Object.freeze(['Larus armenicus']),
    title:
      'Armenian gulls breeding in Sevan and Lake Arpi National Parks (Armenia)',
    owner: 'INBO — Tumanyan, Matheve, Allaert et al.',
    citation:
      'Tumanyan S, Matheve H, Allaert RA et al. ARMENIAN_GULL - Armenian gulls (Larus armenicus) breeding in Sevan National Park and Lake Arpi National Park (Armenia). Zenodo.',
    doi: '10.5281/zenodo.21276580',
    licenceSource: 'Zenodo 10.5281/zenodo.21391781',
  }),
  study({
    id: 2313947453,
    label: 'Spoonbills · Flanders',
    name: 'SPOONBILL_VLAANDEREN',
    species: Object.freeze(['Platalea leucorodia']),
    title: 'Eurasian spoonbills in Flanders (Belgium)',
    owner: 'INBO — Spanoghe, Janssens, Govaert et al.',
    citation:
      'Spanoghe G, Janssens K, Govaert S et al. SPOONBILL_VLAANDEREN - Eurasian spoonbills (Platalea leucorodia) in Flanders (Belgium). Zenodo.',
    doi: '10.5281/zenodo.10055132',
    licenceSource: 'Zenodo 10.5281/zenodo.15696453',
  }),
]);

const STUDIES_BY_ID = new Map(
  WILDLIFE_STUDIES.map((entry) => [entry.id, entry]),
);

/** The curated study with this Movebank id, or null. */
export function wildlifeStudy(id) {
  return STUDIES_BY_ID.get(id) || null;
}

/** The fixed public-feed URL for one curated study; nothing else is fetched. */
export function movebankStudyUrl(id) {
  if (!STUDIES_BY_ID.has(id)) throw new TypeError('Unknown wildlife study');
  const url = new URL('https://www.movebank.org/movebank/service/public/json');
  url.searchParams.set('study_id', String(id));
  url.searchParams.set('sensor_type', 'gps');
  url.searchParams.set('max_events_per_individual', String(WILDLIFE_MAX_FIXES));
  return url.href;
}

const text = (value, max = 120) =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
const validFix = (lon, lat, t) =>
  Number.isFinite(lon) &&
  Number.isFinite(lat) &&
  Number.isFinite(t) &&
  Math.abs(lon) <= 180 &&
  Math.abs(lat) <= 90 &&
  !(lon === 0 && lat === 0) &&
  t > 0;

/** The short name for the row and legend, falling back like the full one. */
export function wildlifeShortName(taxon) {
  return WILDLIFE_SHORT_NAMES[taxon] || wildlifeSpeciesName(taxon);
}

/** Plain-language species name, falling back to the scientific name. */
export function wildlifeSpeciesName(taxon) {
  if (!taxon) return 'Unidentified animal';
  return WILDLIFE_COMMON_NAMES[taxon] || taxon;
}

/**
 * Turn one Movebank public-feed answer into animals with their latest fixes.
 * Animals with no public fix are left out, as is any `Homo sapiens` test tag.
 *
 * @param {object} payload `{ individuals: [...] }` as Movebank serves it.
 * @param {number} studyId The curated study the payload answers for.
 * @returns {Array<{id: string, study: number, name: string, taxon: string|null, track: number[][]}>|null}
 *   `track` rows are `[lon, lat, timeMs]`, oldest first. Null when malformed.
 */
export function parseMovebankStudy(payload, studyId) {
  if (!STUDIES_BY_ID.has(studyId) || !Array.isArray(payload?.individuals))
    return null;
  const animals = [];
  const seen = new Set();
  for (const individual of payload.individuals) {
    if (Number(individual?.study_id) !== studyId) continue;
    const taxon = text(individual.individual_taxon_canonical_name, 80);
    if (taxon === 'Homo sapiens') continue;
    const localId =
      text(String(individual.individual_local_identifier ?? ''), 60) ||
      text(String(individual.individual_id ?? ''), 60);
    if (!localId) continue;
    const id = `${studyId}:${localId}`;
    if (seen.has(id)) continue;
    const byTime = new Map();
    for (const fix of Array.isArray(individual.locations)
      ? individual.locations
      : []) {
      const lon = Number(fix?.location_long);
      const lat = Number(fix?.location_lat);
      const t = Number(fix?.timestamp);
      if (validFix(lon, lat, t))
        byTime.set(t, [
          Math.round(lon * 1e5) / 1e5,
          Math.round(lat * 1e5) / 1e5,
          t,
        ]);
    }
    const track = [...byTime.values()]
      .sort((a, b) => a[2] - b[2])
      .slice(-WILDLIFE_MAX_FIXES);
    if (!track.length) continue;
    seen.add(id);
    animals.push({ id, study: studyId, name: localId, taxon, track });
  }
  return animals;
}

const EARTH_RADIUS_KM = 6371;
/** Fixes further apart than this in time or space are not one flown path. */
export const WILDLIFE_TRACK_GAP = Object.freeze({ ms: DAY_MS, km: 250 });

/** Great-circle distance between two fixes, in kilometres. */
export function wildlifeDistanceKm([lon1, lat1], [lon2, lat2]) {
  const rad = Math.PI / 180;
  const a =
    Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
    Math.cos(lat1 * rad) *
      Math.cos(lat2 * rad) *
      Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * The newest unbroken stretch of a track. A tag that went quiet for days, or
 * whose next fix is hundreds of kilometres away, did not fly the straight
 * line between them, so the path stops at the gap.
 */
export function wildlifeRecentRun(track, gap = WILDLIFE_TRACK_GAP) {
  let start = track.length - 1;
  while (start > 0) {
    const previous = track[start - 1];
    const next = track[start];
    if (
      next[2] - previous[2] > gap.ms ||
      wildlifeDistanceKm(previous, next) > gap.km
    )
      break;
    start--;
  }
  return track.slice(Math.max(0, start));
}

/** Initial bearing from one fix to the next, degrees clockwise from north. */
export function wildlifeBearing([lon1, lat1], [lon2, lat2]) {
  const rad = Math.PI / 180;
  const dLon = (lon2 - lon1) * rad;
  const y = Math.sin(dLon) * Math.cos(lat2 * rad);
  const x =
    Math.cos(lat1 * rad) * Math.sin(lat2 * rad) -
    Math.sin(lat1 * rad) * Math.cos(lat2 * rad) * Math.cos(dLon);
  return (((Math.atan2(y, x) / rad) % 360) + 360) % 360;
}

/**
 * Heading of an animal's last move, or null when it has one fix or has not
 * moved (a resting bird has no direction worth drawing).
 */
export function wildlifeHeading(track) {
  if (track.length < 2) return null;
  const last = track[track.length - 1];
  for (let i = track.length - 2; i >= 0; i--) {
    const previous = track[i];
    // About 10 m: GPS jitter on a resting bird is not a heading.
    if (
      Math.abs(previous[0] - last[0]) > 1e-4 ||
      Math.abs(previous[1] - last[1]) > 1e-4
    )
      return wildlifeBearing(previous, last);
  }
  return null;
}

/** "3 h ago" style age of a fix; "just now" under a minute. */
export function wildlifeAge(ms, now) {
  const age = Math.max(0, now - ms);
  const minutes = Math.floor(age / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 60) return `${days} days ago`;
  // Past 60 days, so never fewer than two months.
  const months = Math.max(2, Math.floor(days / 30.44));
  if (months < 24) return `${months} months ago`;
  return `${Math.floor(days / 365.25)} years ago`;
}

/** A list-lead age: "now", "45m", "3h", "12d", "4mo", "2y". */
export function wildlifeAgeShort(ms, now) {
  const minutes = Math.floor(Math.max(0, now - ms) / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 60) return `${days}d`;
  const months = Math.max(2, Math.floor(days / 30.44));
  if (months < 24) return `${months}mo`;
  return `${Math.floor(days / 365.25)}y`;
}

/** A fix time as "2026-09-30 07:43 UTC". */
export function wildlifeTime(ms) {
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/**
 * A study's state on the proxy: 'fresh' within the cache TTL, 'stale' past it
 * while refreshes fail (bounded by a hard maximum age), 'pending' on its first
 * fetch, 'withdrawn' when Movebank stopped serving it publicly, 'unavailable'
 * otherwise. Only fresh and stale studies may carry animals.
 */
const STATUSES = new Set([
  'fresh',
  'stale',
  'pending',
  'withdrawn',
  'unavailable',
]);
const SERVABLE = new Set(['fresh', 'stale']);
/** An older proxy's single "served" state. */
const LEGACY_STATUS = { ok: 'fresh' };

/**
 * Validate the proxy's snapshot in the browser: curated studies only, sane
 * fixes, bounded sizes. Returns null when the shape is wrong.
 */
export function sanitizeWildlifeSnapshot(payload) {
  if (!Array.isArray(payload?.studies) || !Array.isArray(payload?.animals))
    return null;
  const studies = [];
  const known = new Set();
  /** Studies whose animals may be drawn: fail closed on any other state. */
  const servable = new Set();
  for (const row of payload.studies) {
    const entry = STUDIES_BY_ID.get(row?.id);
    const status = LEGACY_STATUS[row?.status] || row?.status;
    if (!entry || known.has(entry.id) || !STATUSES.has(status)) continue;
    known.add(entry.id);
    if (SERVABLE.has(status)) servable.add(entry.id);
    studies.push({
      ...entry,
      status,
      fetchedAt: Number.isFinite(row.fetchedAt) ? row.fetchedAt : null,
    });
  }
  const animals = [];
  const ids = new Set();
  for (const row of payload.animals.slice(0, WILDLIFE_MAX_ANIMALS)) {
    if (!servable.has(row?.study) || typeof row.id !== 'string') continue;
    if (ids.has(row.id) || !row.id.startsWith(`${row.study}:`)) continue;
    const name = text(row.name, 60);
    if (!name || !Array.isArray(row.track)) continue;
    const track = row.track
      .slice(-WILDLIFE_MAX_FIXES)
      .filter(
        (fix) =>
          Array.isArray(fix) &&
          fix.length === 3 &&
          validFix(fix[0], fix[1], fix[2]),
      )
      .map(([lon, lat, t]) => [lon, lat, t]);
    if (
      !track.length ||
      track.some((fix, index) => index && fix[2] <= track[index - 1][2])
    )
      continue;
    ids.add(row.id);
    animals.push({
      id: row.id,
      study: row.study,
      name,
      taxon: text(row.taxon, 80),
      track,
    });
  }
  return { studies, animals };
}
