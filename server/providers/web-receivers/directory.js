import { createHash } from 'node:crypto';
import { isNonGlobalIpv4 } from '../../../src/sources/radioBrowser.js';
import {
  cleanReceiverText,
  coverageFlags,
  parseBandsFromText,
} from '../../../src/sources/webReceivers.js';

const RECEIVER_TYPE_BY_LABEL = Object.freeze({
  openwebrx: 'openwebrx',
  websdr: 'websdr',
  kiwisdr: 'kiwisdr',
});

/** Return a normalized public http(s) receiver URL, or null for private/odd targets. */
export function publicWebReceiverUrl(value) {
  let url;
  try {
    url = new URL(String(value ?? '').trim());
  } catch {
    return null;
  }
  const hostname = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    !hostname
  )
    return null;
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    !hostname.includes('.') ||
    isNonGlobalIpv4(hostname) ||
    hostname.includes(':')
  )
    return null;
  url.hostname = hostname;
  url.hash = '';
  url.search = '';
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.href;
}

/** Stable receiver id: hash of host, port and path. */
export function webReceiverId(url) {
  const parsed = new URL(url);
  const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
  return createHash('sha256')
    .update(`${parsed.hostname}:${port}${parsed.pathname}`)
    .digest('hex')
    .slice(0, 12);
}

function latLon(lat, lon) {
  const latitude = Number(lat);
  const longitude = Number(lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  if (latitude === 0 && longitude === 0) return null;
  return {
    lat: Number(latitude.toFixed(5)),
    lon: Number(longitude.toFixed(5)),
  };
}

/** Parse Receiverbook's map page into normalized receiver rows. */
export function normalizeReceiverbookSites(html) {
  const text = String(html ?? '');
  const start = text.indexOf('var receivers = ');
  if (start < 0) throw new Error('Receiverbook map data not found');
  const open = text.indexOf('[', start);
  let depth = 0;
  let end = -1;
  let inString = false;
  for (let index = open; index >= 0 && index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (char === '\\') index += 1;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '[') depth += 1;
    else if (char === ']') {
      depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }
  if (open < 0 || end < 0)
    throw new Error('Receiverbook map data is truncated');
  const sites = JSON.parse(text.slice(open, end + 1));
  const rows = [];
  for (const site of Array.isArray(sites) ? sites : []) {
    const coordinates = site?.location?.coordinates;
    const position = Array.isArray(coordinates)
      ? latLon(coordinates[1], coordinates[0])
      : null;
    if (!position) continue;
    const siteLabel = cleanReceiverText(site?.label, 160);
    for (const entry of Array.isArray(site?.receivers) ? site.receivers : []) {
      const type =
        RECEIVER_TYPE_BY_LABEL[String(entry?.type || '').toLowerCase()];
      const url = publicWebReceiverUrl(entry?.url);
      if (!type || !url) continue;
      const name =
        cleanReceiverText(entry?.label, 160) ||
        siteLabel ||
        new URL(url).hostname;
      rows.push({
        id: webReceiverId(url),
        type,
        name,
        site: siteLabel,
        url,
        lat: position.lat,
        lon: position.lon,
        // Receiverbook publishes no coverage; the label is the only clue and
        // the browser presents this as inferred, never as a guarantee.
        bands: parseBandsFromText(`${name} ${siteLabel}`),
        users: null,
        usersMax: null,
        online: null,
        antenna: '',
        sources: ['receiverbook'],
      });
    }
  }
  return rows;
}

/** Parse the community KiwiSDR feed (`var kiwisdr_com = [...]`) into normalized rows. */
export function normalizeKiwiSdrRows(js) {
  const text = String(js ?? '');
  const open = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (open < 0 || end <= open) throw new Error('KiwiSDR feed data not found');
  // The feed is JavaScript, not JSON: it ends with a trailing comma before `]`.
  const entries = JSON.parse(
    text.slice(open, end + 1).replace(/,(\s*[\]}])/g, '$1'),
  );
  const rows = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const url = publicWebReceiverUrl(entry?.url);
    if (!url) continue;
    const gps = String(entry?.gps || '').match(
      /\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)/,
    );
    const position = gps ? latLon(gps[1], gps[2]) : null;
    if (!position) continue;
    const bandsMatch = String(entry?.bands || '').match(/^(\d+)-(\d+)$/);
    const bands = [];
    if (bandsMatch) {
      const lowHz = Number(bandsMatch[1]);
      const highHz = Number(bandsMatch[2]);
      if (highHz > lowHz)
        bands.push({
          lowHz,
          highHz,
          label: `${Math.round(lowHz / 1e6)}–${Math.round(highHz / 1e6)} MHz`,
        });
    }
    const users = Number(entry?.users);
    const usersMax = Number(entry?.users_max);
    const status = String(entry?.status || '').toLowerCase();
    rows.push({
      id: webReceiverId(url),
      type: 'kiwisdr',
      name: cleanReceiverText(entry?.name, 160) || new URL(url).hostname,
      site: cleanReceiverText(entry?.loc, 160),
      url,
      lat: position.lat,
      lon: position.lon,
      bands,
      users: Number.isFinite(users) ? users : null,
      usersMax: Number.isFinite(usersMax) ? usersMax : null,
      online:
        status === 'active' &&
        String(entry?.offline || 'no').toLowerCase() !== 'yes',
      antenna: cleanReceiverText(entry?.antenna, 160),
      sources: ['kiwisdr'],
    });
  }
  return rows;
}

/**
 * Merge the directories by receiver URL: Receiverbook is the catalog, the
 * KiwiSDR feed enriches its rows (published coverage replaces a label guess)
 * and adds Kiwis Receiverbook does not list. A third directory would join
 * the same way.
 */
export function mergeWebReceivers({ receiverbook = [], kiwisdr = [] } = {}) {
  const byId = new Map();
  for (const row of receiverbook)
    byId.set(row.id, {
      ...row,
      bands: [...row.bands],
      sources: [...row.sources],
    });
  for (const row of kiwisdr) {
    const existing = byId.get(row.id);
    if (!existing) {
      byId.set(row.id, {
        ...row,
        bands: [...row.bands],
        sources: [...row.sources],
      });
      continue;
    }
    existing.type = 'kiwisdr';
    existing.bands = row.bands.length ? [...row.bands] : existing.bands;
    existing.users = row.users;
    existing.usersMax = row.usersMax;
    existing.online = row.online;
    existing.antenna = row.antenna || existing.antenna;
    if (!existing.site && row.site) existing.site = row.site;
    existing.sources = [...new Set([...existing.sources, ...row.sources])];
  }
  return [...byId.values()]
    .map((row) => ({ ...row, coverage: coverageFlags(row.bands) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
