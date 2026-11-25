import { inflateRawSync } from 'node:zlib';

/**
 * Joint Typhoon Warning Center (JTWC) warnings for the cyclone layer: the
 * western North Pacific, North Indian Ocean and Southern Hemisphere, where
 * NHC and CPHC issue none. Keyless; US government work.
 *
 *   rss/jtwc.rss             current warnings, product links in each item
 *   products/<prefix>.tcw    JMV 3.0 warning data (position, forecast, text)
 *   products/<prefix>.kmz    Google Earth overlay: the 34-knot danger swath
 *
 * JTWC publishes no schema for any of these. Each reader takes only what it
 * recognises and throws on a product that lacks it. The danger swath is the
 * swath of 34-knot winds widened by forecast track error; it is drawn as its
 * own area (`dangerArea`), never as a cone of centre-track uncertainty.
 */

export const JTWC_ORIGIN = 'https://www.metoc.navy.mil';
export const JTWC_RSS_URL = `${JTWC_ORIGIN}/jtwc/rss/jtwc.rss`;
export const JTWC_PRODUCTS_URL = `${JTWC_ORIGIN}/jtwc/products`;
const WARNING_ITEMS = [
  'NWPAC-NIO-WARNINGS',
  'EPAC-CPAC-WARNINGS',
  'SH-WARNINGS',
];
const NO_WARNINGS = 'No Current Tropical Cyclone Warnings';
const PREFIX = /^(?:wp|io|sh|ep|cp)\d{4}$/;
const HOUR = 3600_000;
/**
 * A JTWC warning is usable for 13 hours after issuance: some storms are on
 * 12-hourly warnings, and the next one posts shortly before its time.
 */
export const JTWC_USABLE_MS = 13 * HOUR;
const KML_MAX_BYTES = 4 * 1024 * 1024;

function invalid(what) {
  return new Error(`invalid_jtwc_data: ${what}`);
}

/** Storm product prefixes (`sh0427`) the feed lists, in feed order. */
export function parseJtwcFeed(feed) {
  if (typeof feed !== 'string' || !feed.includes('<rss')) throw invalid('feed');
  const prefixes = [];
  for (const guid of WARNING_ITEMS) {
    const item = feed
      .split('<item>')
      .slice(1)
      .map((part) => part.split('</item>')[0])
      .find((part) => part.includes(`<guid>${guid}</guid>`));
    if (!item) throw invalid(`feed item ${guid}`);
    const found = [
      ...item.matchAll(
        /\/jtwc\/products\/([a-z]{2}\d{4})(?:web\.txt|\.tcw|\.kmz)/g,
      ),
    ]
      .map((match) => match[1])
      .filter((prefix) => PREFIX.test(prefix));
    if (!found.length && !item.includes(NO_WARNINGS))
      throw invalid(`feed item ${guid}`);
    for (const prefix of found)
      if (!prefixes.includes(prefix)) prefixes.push(prefix);
  }
  return prefixes;
}

/** `sh0427` is ATCF `sh042027` (the season year). */
export function jtwcStormId(prefix) {
  if (!PREFIX.test(prefix)) throw invalid('prefix');
  return `${prefix.slice(0, 4)}20${prefix.slice(4)}`;
}

// JTWC's words for a storm, longest first, and their codes.
const KINDS = [
  ['SUPER TYPHOON', 'STY'],
  ['SUBTROPICAL STORM', 'SS'],
  ['SUBTROPICAL DEPRESSION', 'SD'],
  ['TROPICAL CYCLONE', 'TC'],
  ['TROPICAL STORM', 'TS'],
  ['TROPICAL DEPRESSION', 'TD'],
  ['TYPHOON', 'TY'],
  ['HURRICANE', 'HU'],
];

/** `115S` / `1642W` (tenths) or `11.6S` (degrees); south and west negative. */
function coordinate(word, tenths) {
  const match = /^(\d+(?:\.\d+)?)([NSEW])$/.exec(word || '');
  if (!match || (tenths && match[1].includes('.'))) return null;
  const value = Number(match[1]) / (tenths ? 10 : 1);
  const limit = 'NS'.includes(match[2]) ? 90 : 180;
  if (!(value <= limit)) return null;
  return 'SW'.includes(match[2]) ? -value : value;
}

function utc(year, month, day, hour, minute = 0) {
  const at = Date.UTC(year, month - 1, day, hour, minute);
  const date = new Date(at);
  return date.getUTCDate() === day && date.getUTCHours() === hour ? at : NaN;
}

/** `ddhhmm` (optionally `Z`-suffixed) as the time nearest `near`. */
function nearest(dtg, near) {
  const match = /^(\d\d)(\d\d)(\d\d)Z?[.,]?$/.exec(dtg || '');
  if (!match) return NaN;
  const base = new Date(near);
  let best = NaN;
  for (const offset of [-1, 0, 1]) {
    const month = new Date(
      Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + offset, 1),
    );
    const at = utc(
      month.getUTCFullYear(),
      month.getUTCMonth() + 1,
      Number(match[1]),
      Number(match[2]),
      Number(match[3]),
    );
    if (
      Number.isFinite(at) &&
      (!Number.isFinite(best) || Math.abs(at - near) < Math.abs(best - near))
    )
      best = at;
  }
  return best;
}

const iso = (ms) => new Date(ms).toISOString();

function titleCase(name) {
  return name
    .toLowerCase()
    .replace(
      /(^|[\s-])([a-z])/g,
      (_, gap, letter) => gap + letter.toUpperCase(),
    );
}

/**
 * One storm's warning (`.tcw`) as a cyclone-snapshot storm, its geometry
 * pending until `withJtwcDangerArea` gives it the warning's danger swath.
 * Throws on a warning without its header, hour 0 or subject.
 */
export function parseJtwcWarning(prefix, text) {
  const id = jtwcStormId(prefix);
  if (typeof text !== 'string') throw invalid('tcw');
  const lines = text.split(/\r?\n/).map((line) => line.replace(/\s+$/, ''));
  const dtg = lines[0]?.split(/\s+/)[2];
  const headerAt = lines.findIndex((line) => /^\d{10}\s/.test(line));
  if (headerAt < 0 || !dtg) throw invalid('tcw header');
  const header = lines[headerAt].split(/\s+/);
  const synopticAt = utc(
    Number(header[0].slice(0, 4)),
    Number(header[0].slice(4, 6)),
    Number(header[0].slice(6, 8)),
    Number(header[0].slice(8, 10)),
  );
  if (!Number.isFinite(synopticAt)) throw invalid('tcw synoptic time');
  const number = header[1];
  let at = 2;
  const nameWords = [];
  while (at < header.length && !/^\d+$/.test(header[at]))
    nameWords.push(header[at++]);
  const numbers = header.slice(at);
  const warningMatch = /^0*(\d{1,3})$/.exec(numbers[0] || '');
  if (!warningMatch || !number) throw invalid('tcw warning number');
  const advisoryNumber = String(Number(warningMatch[1]));
  const issuedAt = nearest(dtg, synopticAt);
  if (!Number.isFinite(issuedAt)) throw invalid('tcw message time');
  const direction = Number(numbers[2]);
  const speed = Number(numbers[3]);

  const forecast = [];
  for (const line of lines.slice(headerAt + 1)) {
    const words = line.trim().split(/\s+/);
    const tau = /^T(\d{3})$/.exec(words[0]);
    if (!tau) break;
    const latitude = coordinate(words[1], true);
    const longitude = coordinate(words[2], true);
    const windKt = Number(words[3]);
    if (latitude === null || longitude === null || !/^\d+$/.test(words[3]))
      throw invalid('tcw forecast line');
    forecast.push({
      position: { longitude, latitude },
      tauHours: Number(tau[1]),
      windKt,
      gustKt: null,
    });
  }
  if (forecast[0]?.tauHours !== 0) throw invalid('tcw hour 0');

  const subjectAt = lines.findIndex((line) => /^\s*SUBJ/.test(line));
  if (subjectAt < 0) throw invalid('tcw subject');
  const subject = lines[subjectAt]
    .replace(/^\s*SUBJ[:/]?/, '')
    .replace(/\/+$/, '')
    .trim();
  let end = lines.findIndex((line, i) => i > subjectAt && line.trim() === '//');
  if (end < 0) end = lines.length;
  const body = lines.slice(subjectAt, end);
  let tau = null;
  for (const line of body) {
    const trimmed = line.trim();
    const hours = /^(\d+) HRS, VALID AT:$/.exec(trimmed);
    if (trimmed.startsWith('WARNING POSITION')) tau = 0;
    else if (hours) tau = Number(hours[1]);
    else {
      const gust = /GUSTS (\d+) KT/.exec(trimmed);
      const point = gust && forecast.find((p) => p.tauHours === tau);
      if (point && point.gustKt === null) point.gustKt = Number(gust[1]);
    }
  }
  const remarksAt = body.findIndex((line) => /^\s*REMARKS/.test(line));
  const remarks = (remarksAt < 0 ? [] : body.slice(remarksAt))
    .join(' ')
    .replace(/\s+/g, ' ');
  const issue = /(\d{6})Z POSITION NEAR (\d+\.\d)([NS]) (\d+\.\d)([EW])/.exec(
    remarks,
  );
  const issueAt = issue ? nearest(issue[1], synopticAt) : NaN;
  const pressure = /CENTRAL PRESSURE AT \d{6}Z IS (\d{3,4}) MB/.exec(remarks);
  const kind = KINDS.find(([words]) => subject.includes(words));
  const first = forecast[0];
  const position =
    issue && Number.isFinite(issueAt)
      ? {
          longitude: coordinate(`${issue[4]}${issue[5]}`, false),
          latitude: coordinate(`${issue[2]}${issue[3]}`, false),
        }
      : first.position;
  if (position.longitude === null || position.latitude === null)
    throw invalid('tcw position');
  const basin = id.slice(0, 2);
  const longitude = position.longitude;
  const outlook =
    basin === 'io' || (basin === 'sh' && longitude >= 0 && longitude < 135)
      ? 'abioweb.txt'
      : basin === 'wp' || basin === 'sh'
        ? 'abpwweb.txt'
        : null;
  const pressureHpa = pressure ? Number(pressure[1]) : null;
  const storm = {
    id,
    agency: 'jtwc',
    name: nameWords.length ? titleCase(nameWords.join(' ')) : number,
    classification: kind ? kind[1] : 'TC',
    basin: basin.toUpperCase(),
    position,
    positionAt: iso(Number.isFinite(issueAt) ? issueAt : synopticAt),
    advisoryNumber,
    issuedAt: iso(issuedAt),
    windKt: first.windKt <= 300 ? first.windKt : null,
    pressureHpa:
      pressureHpa !== null && pressureHpa >= 800 && pressureHpa <= 1100
        ? pressureHpa
        : null,
    movement: {
      directionDegrees:
        Number.isInteger(direction) && direction <= 360 ? direction : null,
      speedKt: Number.isInteger(speed) && speed <= 200 ? speed : null,
    },
    advisoryUrl: `${JTWC_PRODUCTS_URL}/${prefix}web.txt`,
    outlookUrl: outlook ? `${JTWC_PRODUCTS_URL}/${outlook}` : null,
    geometryStatus: 'pending',
    geometryAdvisoryNumber: null,
    forecastPoints: [],
    track: null,
    cone: null,
    dangerArea: null,
  };
  return { storm, forecast };
}

/**
 * The storm with its forecast geometry, current only with the danger swath
 * of its own warning number (JTWC posts the overlay before the text).
 */
export function withJtwcDangerArea({ storm, forecast }, overlay) {
  if (
    !overlay ||
    overlay.advisoryNumber !== storm.advisoryNumber ||
    !overlay.dangerArea ||
    forecast.length < 2
  )
    return storm;
  return {
    ...storm,
    geometryStatus: 'current',
    geometryAdvisoryNumber: storm.advisoryNumber,
    forecastPoints: forecast.map((point) => ({
      position: { ...point.position },
      tauHours: point.tauHours,
      windKt: point.windKt,
      gustKt: point.gustKt,
    })),
    track: {
      type: 'LineString',
      coordinates: forecast.map((point) => [
        point.position.longitude,
        point.position.latitude,
      ]),
    },
    dangerArea: overlay.dangerArea,
  };
}

/** The warning number and 34-knot danger swath of a warning's KML. */
export function parseJtwcKml(kml) {
  if (typeof kml !== 'string') throw invalid('kml');
  const number = /WARNING NR\s+0*(\d{1,3})\b/.exec(kml);
  if (!number) throw invalid('kml warning number');
  const polygons = [];
  for (const part of kml.split('<Placemark').slice(1)) {
    const placemark = part.split('</Placemark>')[0];
    const name = /<name>([^<]*)<\/name>/.exec(placemark)?.[1] || '';
    if (!/^\s*34 knot Danger Swath/i.test(name)) continue;
    for (const polygonPart of placemark.split('<Polygon').slice(1)) {
      const polygon = polygonPart.split('</Polygon>')[0];
      const rings = [
        ...polygon.matchAll(/<coordinates>([\s\S]*?)<\/coordinates>/g),
      ]
        .map((match) => ring(match[1]))
        .filter(Boolean);
      if (rings.length) polygons.push(rings);
    }
  }
  return {
    advisoryNumber: String(Number(number[1])),
    dangerArea: !polygons.length
      ? null
      : polygons.length === 1
        ? { type: 'Polygon', coordinates: polygons[0] }
        : { type: 'MultiPolygon', coordinates: polygons },
  };
}

/**
 * `longitude` in -180..180 (180 stays 180). JTWC writes a ring crossing the
 * antimeridian with longitudes past ±180 (`181.5`); wrapped, the ring crosses
 * 180° as NHC's cones that cross it do.
 */
export function wrapJtwcLongitude(longitude) {
  if (Math.abs(longitude) <= 180) return longitude;
  const wrapped = ((((longitude + 180) % 360) + 360) % 360) - 180;
  // JTWC writes two decimals; this drops the float noise of the wrap.
  return Math.round(wrapped * 1e6) / 1e6;
}

function ring(text) {
  const points = [];
  for (const tuple of text.trim().split(/\s+/)) {
    const [lon, lat] = tuple.split(',').map(Number);
    if (
      !Number.isFinite(lon) ||
      !Number.isFinite(lat) ||
      Math.abs(lon) > 540 ||
      Math.abs(lat) > 90
    )
      return null;
    points.push([wrapJtwcLongitude(lon), lat]);
  }
  if (!points.length) return null;
  const [a, b] = [points[0], points.at(-1)];
  if (a[0] !== b[0] || a[1] !== b[1]) points.push([...a]);
  return points.length >= 4 ? points : null;
}

/**
 * The first `.kml` entry of a KMZ (a zip), from its central directory.
 * Stored and deflated entries only.
 */
export function kmlFromKmz(bytes) {
  const data = Buffer.from(bytes);
  let end = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65_557); i--)
    if (data.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  if (end < 0) throw invalid('kmz');
  const entries = data.readUInt16LE(end + 10);
  let at = data.readUInt32LE(end + 16);
  for (let n = 0; n < entries; n++) {
    if (at + 46 > data.length || data.readUInt32LE(at) !== 0x02014b50)
      throw invalid('kmz directory');
    const method = data.readUInt16LE(at + 10);
    const compressed = data.readUInt32LE(at + 20);
    const size = data.readUInt32LE(at + 24);
    const nameLength = data.readUInt16LE(at + 28);
    const extra = data.readUInt16LE(at + 30);
    const comment = data.readUInt16LE(at + 32);
    const local = data.readUInt32LE(at + 42);
    const name = data.toString('utf8', at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extra + comment;
    if (!name.toLowerCase().endsWith('.kml')) continue;
    if (size > KML_MAX_BYTES || data.readUInt32LE(local) !== 0x04034b50)
      throw invalid('kmz entry');
    const start =
      local +
      30 +
      data.readUInt16LE(local + 26) +
      data.readUInt16LE(local + 28);
    const raw = data.subarray(start, start + compressed);
    if (method === 0) return raw.toString('utf8');
    if (method === 8)
      return inflateRawSync(raw, { maxOutputLength: KML_MAX_BYTES }).toString(
        'utf8',
      );
    throw invalid('kmz compression');
  }
  throw invalid('kmz holds no kml');
}

/**
 * Every storm JTWC lists, through `read(url, kind)` (kind `text` or
 * `bytes`). A feed that cannot be read throws. One storm never stops the
 * others: a warning that cannot be read or parsed leaves that storm out,
 * and only when every listed storm's fails does the read throw. An overlay
 * that cannot be read leaves its storm's geometry `unavailable`, and one
 * JTWC has not posted yet (`read` resolving null), or posted for another
 * warning, leaves it `pending`.
 */
export async function readJtwcStorms(read, now = Date.now()) {
  const prefixes = parseJtwcFeed(await read(JTWC_RSS_URL, 'text'));
  // Each storm's warning and overlay are read at once, every storm alike.
  const readStorm = async (prefix) => {
    const [text, overlay] = await Promise.all([
      read(`${JTWC_PRODUCTS_URL}/${prefix}.tcw`, 'text'),
      read(`${JTWC_PRODUCTS_URL}/${prefix}.kmz`, 'bytes')
        .then((bytes) =>
          bytes === null ? null : parseJtwcKml(kmlFromKmz(bytes)),
        )
        .catch((error) => {
          if (error?.name === 'AbortError') throw error;
          return undefined;
        }),
    ]);
    if (text === null) throw invalid(`${prefix}.tcw missing`);
    const warning = parseJtwcWarning(prefix, text);
    const issued = Date.parse(warning.storm.issuedAt);
    // A warning past its use, or dated far ahead of this clock, is left out.
    if (now - issued > JTWC_USABLE_MS || issued - now > 90 * 60_000)
      return null;
    // An overlay that could not be read: the geometry is unavailable.
    return overlay === undefined
      ? { ...warning.storm, geometryStatus: 'unavailable' }
      : withJtwcDangerArea(warning, overlay);
  };
  const results = await Promise.allSettled(prefixes.map(readStorm));
  const failed = results.filter((result) => result.status === 'rejected');
  const aborted = failed.find((result) => result.reason?.name === 'AbortError');
  if (aborted) throw aborted.reason;
  if (failed.length && failed.length === results.length) throw failed[0].reason;
  const storms = [];
  for (const result of results) {
    const storm = result.status === 'fulfilled' ? result.value : null;
    if (storm && !storms.some((held) => held.id === storm.id))
      storms.push(storm);
  }
  return storms;
}
