/**
 * Client catalog for guided tours (authored + optional on-disk generated via /api/tours).
 * Tour generation and Q&A memory are not enabled in this build.
 * @module tours/tourCatalog
 */

import { matchTourQuery, normalizeTour, summarizeTour } from './tourSchema.js';
import rome from './data/rome.json';
import paris from './data/paris.json';
import tokyo from './data/tokyo.json';

const AUTHORED = [rome, paris, tokyo].map((raw) => normalizeTour(raw, { source: 'authored' }));

let _cache = null;
let _cacheAt = 0;
const CACHE_MS = 4000;

export async function fetchTourList({ force = false } = {}) {
  if (!force && _cache && Date.now() - _cacheAt < CACHE_MS) return _cache;
  try {
    const res = await fetch('/api/tours');
    const data = await res.json().catch(() => ({}));
    const tours = Array.isArray(data.tours) ? data.tours : [];
    if (tours.length) {
      _cache = tours;
      _cacheAt = Date.now();
      return tours;
    }
  } catch { /* fall back to shipped tours */ }
  _cache = AUTHORED.map(summarizeTour);
  _cacheAt = Date.now();
  return _cache;
}

export function invalidateTourCache() {
  _cache = null;
  _cacheAt = 0;
}

export async function fetchTourById(id) {
  try {
    const res = await fetch(`/api/tours/${encodeURIComponent(id)}`);
    const data = await res.json().catch(() => ({}));
    if (data?.ok && data.tour) return normalizeTour(data.tour, { source: data.tour.source });
  } catch { /* shipped fallback */ }
  return AUTHORED.find((tour) => tour.id === id || tour.cityId === id) || matchTourQuery(AUTHORED, id);
}

export async function resolveTour(query) {
  const list = await fetchTourList();
  const summary = matchTourQuery(list, query);
  if (!summary) return null;
  return fetchTourById(summary.id);
}

export async function pickRandomTour(excludeId = null) {
  const list = await fetchTourList({ force: true });
  if (!list.length) return { ok: false, empty: true, tours: [] };
  const pool = excludeId ? list.filter((tour) => tour.id !== excludeId) : list;
  const pick = (pool.length ? pool : list)[Math.floor(Math.random() * (pool.length ? pool.length : list.length))];
  const tour = await fetchTourById(pick.id);
  return { ok: Boolean(tour), tour, only: list.length === 1, tours: list.map(summarizeTour) };
}

export async function fetchTourRoute(from, to) {
  if (!from || !to) return { ok: false, error: 'need from and to' };
  const params = new URLSearchParams({
    fromLat: String(from.lat),
    fromLon: String(from.lon),
    toLat: String(to.lat),
    toLon: String(to.lon),
  });
  const res = await fetch(`/api/tours/route?${params}`);
  return res.json().catch(() => ({ ok: false, error: 'route failed' }));
}

/**
 * Stub: AI tour generation is not shipped in this build.
 * @param {string} [_query]
 * @param {{ confirmCost?: boolean }} [_opts]
 * @returns {Promise<{ ok: false, error: string }>}
 */
export async function generateTour(_query, _opts = {}) {
  return { ok: false, error: 'Tour generation is not enabled in this build' };
}

/**
 * Stub: Q&A tour memory is not shipped in this build.
 * @returns {Promise<{ ok: false, error: string, saved: false }>}
 */
export async function recordTourMemory(_entry) {
  return { ok: false, saved: false, error: 'Tour memory is not enabled in this build' };
}

/**
 * Stub: Q&A tour memory is not shipped in this build.
 * @returns {Promise<{ ok: false, error: string, memories: [] }>}
 */
export async function queryTourMemory(_bbox) {
  return { ok: false, memories: [], error: 'Tour memory is not enabled in this build' };
}
