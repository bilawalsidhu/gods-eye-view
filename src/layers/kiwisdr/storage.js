/**
 * The user's own KiwiSDR data: favorite receivers and per-receiver presets.
 *
 * Kept in the browser's localStorage under one key. Everything read back is
 * re-validated (it is user-editable storage), the storage object is injected
 * so tests need no browser, and a missing or full localStorage degrades to a
 * store that works for the session instead of throwing.
 */

export const KIWI_STORAGE_KEY = 'gev.kiwisdr.v1';
export const MAX_FAVORITES = 200;
export const MAX_PRESETS_PER_STATION = 24;
const MAX_STATIONS_WITH_PRESETS = 400;

const FREQ_MATCH_KHZ = 0.005;

function text(value, max) {
  return typeof value === 'string'
    ? value
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .trim()
        .slice(0, max)
    : '';
}

function stationId(value) {
  const id = text(value, 40);
  return /^[A-Za-z0-9_-]{4,40}$/.test(id) ? id : null;
}

function validFavorite(row) {
  const id = stationId(row?.id);
  if (!id) return null;
  const lat = Number(row.lat);
  const lon = Number(row.lon);
  return {
    id,
    name: text(row.name, 160) || id,
    loc: text(row.loc, 120),
    lat: Number.isFinite(lat) && Math.abs(lat) <= 90 ? lat : null,
    lon: Number.isFinite(lon) && Math.abs(lon) <= 180 ? lon : null,
  };
}

function validPreset(row, modes) {
  const freqKhz = Number(row?.freqKhz);
  if (!Number.isFinite(freqKhz) || freqKhz <= 0 || freqKhz > 32_000_000)
    return null;
  const mode =
    typeof row.mode === 'string' && modes.has(row.mode) ? row.mode : null;
  return { freqKhz: Number(freqKhz.toFixed(3)), mode };
}

function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * @param {object} [options]
 * @param {Storage|null} [options.storage] localStorage-like; default is the browser's.
 * @param {Iterable<string>} [options.modes] Valid mode ids, so a stale preset cannot name a mode that no longer exists.
 */
export function createKiwiStore({
  storage = defaultStorage(),
  modes = ['am', 'amn', 'sam', 'usb', 'lsb', 'cw', 'nbfm'],
} = {}) {
  const modeSet = new Set(modes);
  const listeners = new Set();
  let data = load();

  function load() {
    const empty = { favorites: [], presets: {} };
    let parsed;
    try {
      parsed = JSON.parse(storage?.getItem(KIWI_STORAGE_KEY) ?? 'null');
    } catch {
      return empty;
    }
    if (!parsed || typeof parsed !== 'object') return empty;
    const favorites = [];
    const seen = new Set();
    for (const row of Array.isArray(parsed.favorites) ? parsed.favorites : []) {
      const fav = validFavorite(row);
      if (!fav || seen.has(fav.id)) continue;
      seen.add(fav.id);
      favorites.push(fav);
      if (favorites.length >= MAX_FAVORITES) break;
    }
    const presets = {};
    const source =
      parsed.presets && typeof parsed.presets === 'object'
        ? parsed.presets
        : {};
    for (const [key, rows] of Object.entries(source)) {
      const id = stationId(key);
      if (!id || !Array.isArray(rows)) continue;
      const list = rows
        .map((row) => validPreset(row, modeSet))
        .filter(Boolean)
        .slice(0, MAX_PRESETS_PER_STATION);
      if (list.length) presets[id] = list;
      if (Object.keys(presets).length >= MAX_STATIONS_WITH_PRESETS) break;
    }
    return { favorites, presets };
  }

  function persist() {
    try {
      storage?.setItem(KIWI_STORAGE_KEY, JSON.stringify(data));
    } catch {
      // Storage full or blocked: keep working in memory for this session.
    }
  }

  function changed(what) {
    persist();
    for (const fn of [...listeners]) {
      try {
        fn(what);
      } catch (error) {
        console.warn('[KiwiSDR] store listener failed', error);
      }
    }
  }

  return {
    /** Subscribe to changes; the callback gets 'favorites' or 'presets'. */
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    getFavorites() {
      return data.favorites.map((fav) => ({ ...fav }));
    },
    isFavorite(id) {
      return data.favorites.some((fav) => fav.id === id);
    },
    /** Add or remove a receiver; returns whether it is now a favorite. */
    toggleFavorite(station) {
      const id = stationId(station?.id);
      if (!id) return false;
      const index = data.favorites.findIndex((fav) => fav.id === id);
      if (index >= 0) {
        data.favorites.splice(index, 1);
        changed('favorites');
        return false;
      }
      const fav = validFavorite({
        id,
        name: station.name,
        loc: station.loc,
        lat: station.lat,
        lon: station.lon,
      });
      data.favorites.push(fav);
      if (data.favorites.length > MAX_FAVORITES) data.favorites.shift();
      changed('favorites');
      return true;
    },

    removeFavorite(id) {
      const index = data.favorites.findIndex((fav) => fav.id === id);
      if (index < 0) return false;
      data.favorites.splice(index, 1);
      changed('favorites');
      return true;
    },

    getPresets(id) {
      return (data.presets[id] ?? []).map((preset) => ({ ...preset }));
    },
    /** Save a frequency (and optionally mode) for one receiver; false if already saved or full. */
    addPreset(id, { freqKhz, mode } = {}) {
      const key = stationId(id);
      const preset = validPreset({ freqKhz, mode }, modeSet);
      if (!key || !preset) return false;
      const list = data.presets[key] ?? [];
      if (
        list.some(
          (p) =>
            Math.abs(p.freqKhz - preset.freqKhz) < FREQ_MATCH_KHZ &&
            p.mode === preset.mode,
        )
      )
        return false;
      if (list.length >= MAX_PRESETS_PER_STATION) return false;
      data.presets[key] = [...list, preset].sort(
        (a, b) => a.freqKhz - b.freqKhz,
      );
      changed('presets');
      return true;
    },
    removePreset(id, { freqKhz, mode } = {}) {
      const list = data.presets[id];
      if (!list) return false;
      const next = list.filter(
        (p) =>
          !(
            Math.abs(p.freqKhz - Number(freqKhz)) < FREQ_MATCH_KHZ &&
            p.mode === (mode ?? null)
          ),
      );
      if (next.length === list.length) return false;
      if (next.length) data.presets[id] = next;
      else delete data.presets[id];
      changed('presets');
      return true;
    },
  };
}
