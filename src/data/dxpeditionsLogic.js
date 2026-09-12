/**
 * Pure helpers for the DXpeditions layer (NG3K announced DX operations,
 * enriched with the Club Log most-wanted rank by HamRig).
 *
 * Cesium-free and DOM-free so `node --test` covers it; the layer module
 * `src/data/dxpeditions.js` only adds the Cesium plumbing.
 *
 * Rows arrive from the same-origin broker `/api/hamrig/dxpeditions` already
 * normalized (contract shape `Dxpedition`). Positions are entity centroids
 * (`precision: 'entity'`), so several operations often share one point —
 * the layer spreads those with the deterministic spiral from the
 * activations logic.
 */

import { spreadCoincidentPositions } from './hamActivationsLogic.js';

/** Lifecycle states an operation can be in. */
export const DXPEDITION_STATUSES = Object.freeze(['active', 'upcoming', 'ended']);

/** Status filter rows for the panel chips. */
export const DXPEDITION_STATUS_FILTERS = Object.freeze([
  Object.freeze({ id: 'all', label: 'All' }),
  Object.freeze({ id: 'active', label: 'Active' }),
  Object.freeze({ id: 'upcoming', label: 'Upcoming' }),
]);

/** Ranks at or below this are "most wanted": big pink markers. */
export const MOST_WANTED_TOP_RANK = 20;

/** Marker colours. */
export const DXPEDITION_COLORS = Object.freeze({
  wanted: '#f472b6',
  regular: '#a78bfa',
  outline: '#ffffff',
});

/** Default panel filter. */
export const DEFAULT_DXPEDITION_FILTER = Object.freeze({ status: 'all', mostWantedOnly: false });

/** Entity-centroid piles are spread wider than activation piles (km). */
export const DXPEDITION_SPREAD = Object.freeze({ keyDecimals: 2, stepKm: 18, maxKm: 60 });

const MS_PER_DAY = 86_400_000;
const CALLSIGN_RE = /^[A-Z0-9/-]{1,15}$/i;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function cleanText(value, maxLength = 200) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseTimeMs(timeIso) {
  if (typeof timeIso === 'number') return Number.isFinite(timeIso) ? timeIso : null;
  let text = String(timeIso ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(text)) text += 'Z';
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

function isoOrNull(value) {
  const ms = parseTimeMs(value);
  return ms === null ? null : new Date(ms).toISOString();
}

function validCoordinates(lat, lon) {
  return lat !== null && lon !== null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0);
}

function stringList(value, maxItems = 20) {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(value.map((entry) => cleanText(entry, 12)).filter(Boolean).slice(0, maxItems));
}

/** Canonical status word or null. Upstream 'past' is accepted as 'ended'. */
export function normalizeDxpeditionStatus(value) {
  const text = cleanText(value, 12).toLowerCase();
  if (text === 'past') return 'ended';
  return DXPEDITION_STATUSES.includes(text) ? text : null;
}

/** Re-validate one broker row. Coordinates are optional (unlocatable prefixes still list). */
export function isValidDxpedition(row) {
  if (!row || typeof row !== 'object') return false;
  if (!cleanText(row.id, 120)) return false;
  if (!CALLSIGN_RE.test(cleanText(row.callsign, 20))) return false;
  const lat = finiteNumber(row.lat);
  const lon = finiteNumber(row.lon);
  if ((lat !== null || lon !== null) && !validCoordinates(lat, lon)) return false;
  return Boolean(normalizeDxpeditionStatus(row.status) || parseTimeMs(row.startIso) !== null || parseTimeMs(row.endIso) !== null);
}

/** Freeze a validated row into the shape the layer, panel and voice tools use. */
export function freezeDxpedition(row) {
  const lat = finiteNumber(row.lat);
  const lon = finiteNumber(row.lon);
  const located = validCoordinates(lat, lon);
  const rank = finiteNumber(row.mostWantedRank);
  const url = cleanText(row.url, 300);
  const daysUntil = finiteNumber(row.daysUntil);
  return Object.freeze({
    id: cleanText(row.id, 120),
    callsign: cleanText(row.callsign, 20).toUpperCase(),
    entity: cleanText(row.entity, 80) || null,
    adif: finiteNumber(row.adif),
    continent: cleanText(row.continent, 4).toUpperCase() || null,
    lat: located ? lat : null,
    lon: located ? lon : null,
    precision: 'entity',
    located,
    startIso: isoOrNull(row.startIso),
    endIso: isoOrNull(row.endIso),
    status: normalizeDxpeditionStatus(row.status) || 'upcoming',
    daysUntil: daysUntil === null ? null : Math.round(daysUntil),
    qslVia: cleanText(row.qslVia, 60) || null,
    info: cleanText(row.info, 400) || null,
    url: /^https?:\/\//i.test(url) ? url : null,
    iota: cleanText(row.iota, 12).toUpperCase() || null,
    mostWantedRank: rank === null || rank <= 0 ? null : Math.round(rank),
    bands: stringList(row.bands),
    modes: stringList(row.modes),
  });
}

/**
 * Status as of `nowMs`, recomputed from the dates when both are known (the
 * upstream flag is cached for a day and can lag). The end date is a whole
 * day, so an operation stays active through the end of that UTC day.
 */
export function effectiveStatus(op, nowMs = Date.now()) {
  const start = parseTimeMs(op?.startIso);
  const end = parseTimeMs(op?.endIso);
  if (start !== null && nowMs < start) return 'upcoming';
  if (end !== null && nowMs >= end + MS_PER_DAY) return 'ended';
  if (start !== null && end !== null) return 'active';
  if (start !== null && end === null) return 'active';
  return normalizeDxpeditionStatus(op?.status) || 'upcoming';
}

/** Calendar (UTC) days until the start / end: 0 = today, negative = passed, null = unknown. */
export function dxpeditionDays(op, nowMs = Date.now()) {
  const start = parseTimeMs(op?.startIso);
  const end = parseTimeMs(op?.endIso);
  const today = Math.floor(nowMs / MS_PER_DAY);
  return {
    daysUntilStart: start === null ? null : Math.floor(start / MS_PER_DAY) - today,
    daysUntilEnd: end === null ? null : Math.floor(end / MS_PER_DAY) - today,
  };
}

/** True when the operation carries a most-wanted rank. */
export function isMostWanted(op) {
  return Number.isFinite(op?.mostWantedRank) && op.mostWantedRank > 0;
}

/** 'top' (≤ 20), 'high' (≤ 100), 'other' (ranked), 'none'. */
export function rankBucket(rank) {
  const value = finiteNumber(rank);
  if (value === null || value <= 0) return 'none';
  if (value <= MOST_WANTED_TOP_RANK) return 'top';
  if (value <= 100) return 'high';
  return 'other';
}

/** Normalize a partial filter update against the current one. */
export function normalizeDxpeditionFilter(next = {}, current = DEFAULT_DXPEDITION_FILTER) {
  const base = current && typeof current === 'object' ? current : DEFAULT_DXPEDITION_FILTER;
  let status = DXPEDITION_STATUS_FILTERS.some((row) => row.id === base.status) ? base.status : 'all';
  let mostWantedOnly = Boolean(base.mostWantedOnly);
  const source = next && typeof next === 'object' ? next : {};
  if (source.status !== undefined && source.status !== null) {
    const text = cleanText(source.status, 12).toLowerCase();
    if (text === '' || text === 'all') status = 'all';
    else if (text === 'active' || text === 'upcoming') status = text;
  }
  if (source.mostWantedOnly !== undefined && source.mostWantedOnly !== null) {
    const raw = source.mostWantedOnly;
    mostWantedOnly = raw === true || raw === 1 || /^(true|1|yes|on)$/i.test(String(raw));
  }
  return { status, mostWantedOnly };
}

/** True when the operation passes the status + most-wanted filter at `nowMs`. */
export function dxpeditionMatchesFilter(op, filter = DEFAULT_DXPEDITION_FILTER, nowMs = Date.now()) {
  if (!op) return false;
  const status = effectiveStatus(op, nowMs);
  const wanted = filter?.status || 'all';
  if (wanted !== 'all' && status !== wanted) return false;
  if (wanted === 'all' && status === 'ended') return false;
  if (filter?.mostWantedOnly && !isMostWanted(op)) return false;
  return true;
}

/** Filtered copy of the list (order preserved). */
export function filterDxpeditions(list, filter = DEFAULT_DXPEDITION_FILTER, nowMs = Date.now()) {
  return list.filter((op) => dxpeditionMatchesFilter(op, filter, nowMs));
}

/**
 * Marker style: outlined point sized by most-wanted rank (rank ≤ 20 big and
 * pink, other ranks purple and slightly smaller, unranked smallest);
 * upcoming operations are dimmer, ended ones faint. Active operations carry
 * their callsign label permanently; others only on hover.
 */
export function dxpeditionStyle(op, { nowMs = Date.now() } = {}) {
  const status = effectiveStatus(op, nowMs);
  const bucket = rankBucket(op?.mostWantedRank);
  const wanted = bucket === 'top';
  const pixelSize = bucket === 'top' ? 17 : (bucket === 'high' ? 13 : 11);
  const alpha = status === 'active' ? 1 : (status === 'upcoming' ? 0.55 : 0.3);
  return {
    status,
    wanted,
    bucket,
    color: wanted ? DXPEDITION_COLORS.wanted : DXPEDITION_COLORS.regular,
    outlineColor: DXPEDITION_COLORS.outline,
    outlineWidth: wanted ? 2.5 : 1.5,
    pixelSize,
    alpha,
    labelAlways: status === 'active',
  };
}

/** Short UTC date: '10 Oct' (or '10 Oct 2027' when not this year). */
export function formatShortDate(iso, nowMs = Date.now()) {
  const ms = parseTimeMs(iso);
  if (ms === null) return '';
  const date = new Date(ms);
  const text = `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
  return date.getUTCFullYear() === new Date(nowMs).getUTCFullYear() ? text : `${text} ${date.getUTCFullYear()}`;
}

/** Map label: the callsign. */
export function dxpeditionLabel(op) {
  return op?.callsign || '';
}

/**
 * Second label line / list detail:
 * `Namibia · until 10 Oct · QSL DK2WH · #224` (active)
 * `Turks & Caicos · starts 18 Sep (6 d) · QSL LoTW · #70` (upcoming)
 */
export function dxpeditionDetail(op, nowMs = Date.now()) {
  if (!op) return '';
  const status = effectiveStatus(op, nowMs);
  const days = dxpeditionDays(op, nowMs);
  const parts = [];
  if (op.entity) parts.push(op.entity);
  if (status === 'upcoming') {
    const when = formatShortDate(op.startIso, nowMs);
    const inDays = days.daysUntilStart !== null && days.daysUntilStart >= 0 ? ` (${days.daysUntilStart} d)` : '';
    if (when) parts.push(`starts ${when}${inDays}`);
  } else if (status === 'active') {
    const when = formatShortDate(op.endIso, nowMs);
    if (when) parts.push(`until ${when}`);
  } else {
    const when = formatShortDate(op.endIso, nowMs);
    parts.push(when ? `ended ${when}` : 'ended');
  }
  if (op.qslVia) parts.push(`QSL ${op.qslVia}`);
  if (isMostWanted(op)) parts.push(`#${op.mostWantedRank}`);
  return parts.join(' · ');
}

function statusOrder(status) {
  return status === 'active' ? 0 : (status === 'upcoming' ? 1 : 2);
}

/**
 * Panel order: active first (most-wanted rank ascending, unranked last,
 * then ending soonest), then upcoming by start date, then ended by end date.
 */
export function sortDxpeditions(list, nowMs = Date.now()) {
  return [...list].sort((a, b) => {
    const sa = statusOrder(effectiveStatus(a, nowMs));
    const sb = statusOrder(effectiveStatus(b, nowMs));
    if (sa !== sb) return sa - sb;
    if (sa === 0) {
      const ra = isMostWanted(a) ? a.mostWantedRank : Infinity;
      const rb = isMostWanted(b) ? b.mostWantedRank : Infinity;
      if (ra !== rb) return ra - rb;
      const ea = parseTimeMs(a.endIso) ?? Infinity;
      const eb = parseTimeMs(b.endIso) ?? Infinity;
      if (ea !== eb) return ea - eb;
    } else if (sa === 1) {
      const ta = parseTimeMs(a.startIso) ?? Infinity;
      const tb = parseTimeMs(b.startIso) ?? Infinity;
      if (ta !== tb) return ta - tb;
    } else {
      const ea = parseTimeMs(a.endIso) ?? -Infinity;
      const eb = parseTimeMs(b.endIso) ?? -Infinity;
      if (ea !== eb) return eb - ea;
    }
    return String(a.callsign).localeCompare(String(b.callsign)) || String(a.id).localeCompare(String(b.id));
  });
}

/**
 * Find one operation by id, callsign (a bare prefix like 'TF' matches the
 * 'TF' row, a full call like 'TF/DA6IC/P' matches the row whose callsign is
 * its prefix or that mentions it in `info`), entity name, or a word search
 * over callsign/entity/info. Case-insensitive; active operations win ties.
 */
export function resolveDxpedition(list, query, nowMs = Date.now()) {
  const text = cleanText(query, 120);
  if (!text) return null;
  const lower = text.toLowerCase();
  const upper = text.toUpperCase();
  const ordered = sortDxpeditions(list, nowMs);
  const byId = ordered.find((op) => String(op.id).toLowerCase() === lower);
  if (byId) return byId;
  const byCall = ordered.find((op) => op.callsign === upper);
  if (byCall) return byCall;
  const byEntity = ordered.find((op) => (op.entity || '').toLowerCase() === lower);
  if (byEntity) return byEntity;
  if (/^[A-Z0-9/-]+$/.test(upper)) {
    const mentioned = ordered.find((op) => new RegExp(`(^|[^A-Z0-9])${upper.replace(/[/-]/g, '\\$&')}([^A-Z0-9]|$)`, 'i').test(op.info || ''));
    if (mentioned) return mentioned;
    const byPrefix = ordered.find((op) => upper.startsWith(op.callsign) && op.callsign.length >= 2);
    if (byPrefix) return byPrefix;
  }
  const words = lower.split(/\s+/).filter((word) => /[a-z0-9]/.test(word));
  if (!words.length) return null;
  return ordered.find((op) => {
    const haystack = `${op.callsign} ${op.entity || ''} ${op.info || ''} ${op.iota || ''}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  }) || null;
}

/** Display positions for located operations, spreading shared centroids. */
export function dxpeditionDisplayPositions(list) {
  return spreadCoincidentPositions(list.filter((op) => op.located), DXPEDITION_SPREAD);
}

/** Sorted list capped for the UI snapshot. */
export function trimDxpeditionItems(list, limit = 200, nowMs = Date.now()) {
  const max = Math.max(0, Math.floor(Number(limit) || 0));
  return sortDxpeditions(list, nowMs).slice(0, max);
}

/** Counts for the panel: total, per status, most-wanted, located. */
export function summarizeDxpeditions(list, nowMs = Date.now()) {
  const summary = { total: list.length, active: 0, upcoming: 0, ended: 0, mostWanted: 0, located: 0 };
  for (const op of list) {
    summary[effectiveStatus(op, nowMs)] += 1;
    if (isMostWanted(op)) summary.mostWanted += 1;
    if (op.located) summary.located += 1;
  }
  return summary;
}
