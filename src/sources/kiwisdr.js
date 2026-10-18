/**
 * KiwiSDR public receiver directory: parsing and normalization.
 *
 * The directory (kiwisdr.com's list, republished as a JS file by the map
 * maker at rx.linkfanel.net) is a `var kiwisdr_com = [ {...}, ... ];` script,
 * not JSON. Every value is a string. This module is pure so the server proxy
 * and the browser can share one definition of what a usable receiver is.
 */
import { isNonGlobalIpv4 } from './radioBrowser.js';

export const KIWISDR_MAX_STATIONS = 4000;

const INVISIBLE = /[⁠-⁤​-‏﻿]/g;

function clean(value, max) {
  if (typeof value !== 'string') return '';
  return value
    .replace(INVISIBLE, '')
    .replace(/[\u0000-\u001f\u007f<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function integer(value, min, max) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  if (!/^-?\d+$/.test(text)) return null;
  const n = Number(text);
  return n >= min && n <= max ? n : null;
}

/** Extract the array literal from the `var kiwisdr_com = [...]` script. */
export function parseKiwiDirectoryScript(text) {
  if (typeof text !== 'string') throw new Error('kiwisdr_directory_invalid');
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) throw new Error('kiwisdr_directory_invalid');
  const body = text.slice(start, end + 1);
  try {
    const rows = JSON.parse(body);
    if (Array.isArray(rows)) return rows;
  } catch {
    // The list is typed in by thousands of receiver owners, so one stray quote
    // or tab must cost one row, not the whole directory: fall through.
  }
  const rows = parseKiwiRowsLeniently(body);
  if (!rows.length) throw new Error('kiwisdr_directory_invalid');
  return rows;
}

/**
 * Salvage every well-formed row from a directory that is not valid JSON as a
 * whole. Rows are flat objects of string values, so a row is the text from a
 * `{` to the next `}` that sit outside a string; a string never spans a line,
 * which lets a stray quote desynchronise at most the row it is in.
 */
export function parseKiwiRowsLeniently(body) {
  const rows = [];
  let inString = false;
  let escaped = false;
  let from = -1;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '\n') {
      inString = false;
      escaped = false;
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') from = i;
    else if (ch === '}' && from >= 0) {
      const row = body
        .slice(from, i + 1)
        .replace(/[\u0000-\u001f]/g, ' ')
        .replace(/,\s*}$/, '}');
      from = -1;
      try {
        const value = JSON.parse(row);
        if (value && typeof value === 'object' && !Array.isArray(value))
          rows.push(value);
      } catch {
        // Skip just this row.
      }
    }
  }
  return rows;
}

/** "(50.85, -0.66)" -> { lat, lon }; unset (0, 0) and malformed pairs are null. */
export function parseKiwiGps(value) {
  if (typeof value !== 'string') return null;
  const match =
    /^\s*\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)\s*$/.exec(value);
  if (!match) return null;
  const lat = Number(match[1]);
  const lon = Number(match[2]);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  // Receivers that never set a position report exactly 0,0.
  if (lat === 0 && lon === 0) return null;
  return { lat, lon };
}

/**
 * Only plain http(s) origins on public hosts. The browser connects to these
 * directly, so a directory entry must not be able to aim it at a LAN address.
 */
export function parseKiwiOrigin(value) {
  if (typeof value !== 'string' || value.length > 200) return null;
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  if (!host || host.startsWith('[') || !host.includes('.')) return null;
  if (host === 'localhost' || host.endsWith('.local')) return null;
  if (isNonGlobalIpv4(host)) return null;
  return {
    origin: url.origin,
    host,
    port: url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80,
    secure: url.protocol === 'https:',
  };
}

function bandRange(value) {
  const match = /^(\d+)-(\d+)$/.exec(typeof value === 'string' ? value : '');
  if (!match) return { lowHz: 0, highHz: 30_000_000 };
  const lowHz = Number(match[1]);
  const highHz = Number(match[2]);
  return highHz > lowHz && highHz <= 32_000_000_000
    ? { lowHz, highHz }
    : { lowHz: 0, highHz: 30_000_000 };
}

function snr(value) {
  if (typeof value !== 'string') return null;
  const parts = value
    .split(',')
    .map((p) => Number(p))
    .filter((n) => Number.isFinite(n) && n > 0 && n < 100);
  return parts.length ? Math.max(...parts) : null;
}

/** One directory row -> a station record, or null when it cannot be listened to. */
export function normalizeKiwiStation(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (raw.status !== 'active' || raw.offline === 'yes') return null;
  const id = clean(raw.id, 40);
  if (!/^[A-Za-z0-9_-]{4,40}$/.test(id)) return null;
  const position = parseKiwiGps(raw.gps);
  const endpoint = parseKiwiOrigin(raw.url);
  const usersMax = integer(raw.users_max, 1, 1000);
  const users = integer(raw.users, 0, 10_000);
  if (!position || !endpoint || usersMax === null || users === null)
    return null;
  const loc = clean(raw.loc, 120);
  const hw = /^KiwiSDR(?: \d)?(?: v[\d.]+)?/.exec(clean(raw.sdr_hw, 120));
  return {
    id,
    name: clean(raw.name, 160) || loc || endpoint.host,
    loc,
    lat: position.lat,
    lon: position.lon,
    users: Math.min(users, usersMax),
    usersMax,
    origin: endpoint.origin,
    host: endpoint.host,
    port: endpoint.port,
    secure: endpoint.secure,
    antenna: clean(raw.antenna, 160),
    hardware: hw ? hw[0] : 'KiwiSDR',
    ...bandRange(raw.bands),
    snr: snr(raw.snr),
    gridSquare: clean(raw.grid, 8),
    updated: clean(raw.updated, 60),
  };
}

/** Normalize a whole directory; first row wins when an id repeats. */
export function normalizeKiwiDirectory(rows) {
  if (!Array.isArray(rows)) throw new Error('kiwisdr_directory_invalid');
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const station = normalizeKiwiStation(row);
    if (!station || seen.has(station.id)) continue;
    seen.add(station.id);
    out.push(station);
    if (out.length >= KIWISDR_MAX_STATIONS) break;
  }
  return out;
}

/** 'free' | 'busy' | 'full': whether you can realistically get a slot. */
export function kiwiLoad(station) {
  if (station.users >= station.usersMax) return 'full';
  return station.users / station.usersMax >= 0.5 ? 'busy' : 'free';
}
