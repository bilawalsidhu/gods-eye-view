/**
 * Referents: the numbered things the latest voice result listed, so "the
 * second one" or "that one" can resolve without the model copying ids.
 *
 * The registry mirrors what the voice card shows: a result replaces the list
 * when the card displays it with numbered rows (see resultDisplay.js, which
 * both the card and this registry read — analyst items and OSM places
 * included, in the order the model reads them in the tool output).
 *
 * Session-scoped: the voice commands clear it when a session ends.
 */

import { presentResult } from './resultDisplay.js';

/** The numbered rows visible in the voice card and therefore resolvable later. */
export const MAX_DISPLAYED_REFERENTS = 5;

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalize(entry, index) {
  if (!entry || typeof entry !== 'object') return null;
  // Identity is the canonical key (transponder hex, MMSI, NORAD id); a
  // display `id` such as a callsign is only a label, and two contacts can
  // share one.
  const id = entry.icao24 ?? entry.mmsi ?? entry.noradId ?? entry.id ?? null;
  const label = String(
    entry.label ?? entry.callsign ?? entry.name ?? entry.id ?? id ?? '',
  ).trim();
  if (!label && id === null) return null;
  return {
    n: index + 1,
    id: id === null ? null : String(id),
    label: label || String(id),
    layerId: entry.layerId ?? entry.layerKey ?? null,
    lat: finite(entry.lat ?? entry.latitude),
    lon: finite(entry.lon ?? entry.longitude),
  };
}

/** Referents a tool result offers, in card order; [] when it offers none. */
export function referentsFromResult(name, result) {
  if (!result || typeof result !== 'object' || result.ok === false) return [];
  return presentResult(name, result)?.referents || [];
}

/** Numbered referent records ({n, id, label, layerId, lat, lon}). */
export function normalizeReferents(entries, max = MAX_DISPLAYED_REFERENTS) {
  return (Array.isArray(entries) ? entries : [])
    .slice(0, max)
    .map(normalize)
    .filter(Boolean)
    .map((entry, index) => ({ ...entry, n: index + 1 }));
}

export function createReferentRegistry({ max = MAX_DISPLAYED_REFERENTS } = {}) {
  let list = [];
  let generation = 0;
  return {
    /** Bumped by every clear; read before an action, checked after it. */
    generation() {
      return generation;
    },
    /**
     * Replace the list with a result's referents; empty results keep it
     * unless they are a result set of their own. A
     * result whose action started before the last clear (a new session or a
     * cancelled turn) is refused.
     */
    recordResult(name, result, { since = generation } = {}) {
      if (since !== generation) return false;
      if (!result || typeof result !== 'object' || result.ok === false)
        return false;
      const shown = presentResult(name, result);
      const entries = shown?.referents || [];
      // A new result set (a count, a place search) replaces the list even
      // when it is empty: "the second one" never reaches an older answer.
      if (!entries.length && !shown?.resultSet) return false;
      list = normalizeReferents(entries, max);
      return list.length > 0;
    },
    /** 1-based lookup; negative counts from the end ("the last one" = -1). */
    get(n) {
      const index = Number(n);
      if (!Number.isInteger(index) || index === 0) return null;
      return (index > 0 ? list[index - 1] : list[list.length + index]) || null;
    },
    list() {
      return list.slice();
    },
    clear() {
      list = [];
      generation++;
    },
  };
}
