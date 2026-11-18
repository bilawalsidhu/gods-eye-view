#!/usr/bin/env node
/**
 * Build per-feed rail path packs and schedule packs from each operator's
 * static GTFS.
 *
 *   node scripts/build-rail-paths.mjs (--feed <id> ... | --all)
 *     [--out <dir>] [--work <dir>] [--keep] [--no-schedule] [--force]
 *     [--days <n>] [--from <YYYY-MM-DD>]
 *     [--local-gtfs <id>=<path to zip> ...] [--help]
 *
 * The feeds are named with `--feed` (repeatable), or `--all` builds every
 * enabled feed: many downloads and hours of work, so it is never the
 * default. `--help` prints this text. Packs are opt-in: nothing is
 * downloaded when the app starts, only when this script is run. They add to
 * live trains what their feed leaves out (the operator's lines, stop names,
 * next stops); no train is ever placed from them.
 *
 * For every enabled rail feed with a `staticGtfsUrl` (src/data/railFeeds.js)
 * the script downloads the static GTFS, streams routes.txt, trips.txt and
 * shapes.txt straight out of the zip (nothing is unpacked to disk except a
 * GTFS zip nested inside the download), keeps the routes the feed's
 * classifier accepts and whose route_type is rail (or, with
 * `staticRouteTypes`, one of the types it lists: `keepsRouteType`), and writes
 * `<out>/<feedId>.json`:
 *
 *   { version: 1, feedId, builtAt,
 *     source: { url, file?, entry?, lastModified, feedVersion? },
 *     shapes: [[lat, lon, lat, lon, ...]],   // 1e-5 degrees, identical shapes once
 *     dist:   [[0, m, m, ...]],              // cumulative metres, 0.1 m
 *     shapeSources: ['operator', ...],
 *     trips:  { tripId: shapeIndex },
 *     routes: { routeId: [shapeIndex, ...] } }
 *
 * Shapes are taken at face value: every one is the operator's shapes.txt as
 * published (`shapeSources`: `operator`); nothing is redrawn from other map
 * data, and no line is invented where the operator publishes none.
 * `source.file` is a `--local-gtfs` zip's name, `source.entry` the GTFS zip
 * read from inside the download (`staticGtfsEntry`), `source.feedVersion`
 * the GTFS `feed_info.txt` `feed_version`.
 *
 * Quality gate: a shape with any vertex gap over 5 km is a straight chord, not
 * a track, and is dropped (and logged). Trains on dropped shapes keep the
 * layer's straight-line motion. Kept shapes are simplified to within 1 m, or
 * the feed's `staticSimplifyM` (Douglas-Peucker), before rounding duplicates
 * away. A trip without a usable shape gets none: the layer draws no line
 * for it, only its stops.
 *
 * Unless `--no-schedule` is given, the timetable is written next to it as
 * `<out>/<feedId>.schedule.json` (read by src/data/railSchedule.js); its
 * `pathsBuiltAt` is the `builtAt` of the path pack whose shape indices its
 * patterns use:
 *
 *   { version: 1, feedId, builtAt, pathsBuiltAt, source,
 *     timezone,                                // agency_timezone (IANA)
 *     window: { from, to },                    // service dates, YYYY-MM-DD
 *     routes:   { routeId: { type, short?, long?, color?, textColor? } },
 *     stops:    [{ id, name, lat, lon, parent?, platform?, tz?, cc? }],
 *     patterns: [{ shape, stops, seq, dist, pass? }],
 *     profiles: [[arr0, dep0, arr1, dep1, ...]],   // s after the trip start
 *     services: { serviceId: ['YYYY-MM-DD', ...] },
 *     trips:    { tripId: { pattern, profile, startSec, route, service,
 *                           headsign?, name?, direction? } } }
 *
 * A stop the GTFS gives no coordinates (none, or (0, 0)) is left out of its
 * runs with its times: it is never placed by guesswork, and no line is drawn
 * to it; a run needs two located stops.
 *
 * Writing: a feed's packs go to temporary names of this process and are
 * renamed into place together, the path pack first, only once both are
 * written; nothing is replaced when either fails. A pack over the largest
 * the server serves (RAIL_PATH_PACK_MAX_BYTES, src/data/railProxy.js; the
 * error names its size) is not written: the feed fails and its previous
 * packs stay. So does a build whose trips fall
 * to under a fifth of the pack it would replace (the path pack's trips on
 * the operator's shapes, the schedule's trips per day of its window), or to
 * none: an upstream change, not a timetable; `--force` writes it anyway.
 * With `--no-schedule` the path pack's shape list changes, so the feed's
 * previous schedule pack, whose patterns index the old one, is removed; a
 * feed whose trains are named only through its schedule pack (Renfe long
 * and medium distance, KTMB: railFeedNeedsSchedulePack) is refused instead,
 * and counts as failed.
 * One build runs at a time per `--out`: it holds `<out>/.build-rail-paths.lock`
 * (process id and time, refreshed while it runs), and a second one refuses
 * to start; a lock whose process is gone, or older than 6 hours, is taken
 * over.
 *
 * Calendars are resolved to concrete dates for `--days` days (default 4)
 * from `--from` (default yesterday in the agency zone), plus enough earlier
 * dates for a multi-day run still out; only trips that run in the window are
 * kept. stop_times.txt is streamed and only rows of those trips are held.
 * A frequency-based trip (frequencies.txt) becomes one trip per departure,
 * `<trip_id>@<HH:MM:SS>`, its template's stop times moved to that start.
 *
 * `--local-gtfs <id>=<zip>` reads that feed's static GTFS from a zip already
 * on disk instead of downloading it: a copy of the GTFS the feed publishes.
 * The zip is only opened for reading, never moved, changed or deleted, and
 * the packs record its file name and modification time, not its path.
 *
 * Every download is open: no account, key or sign-in. It is made over https
 * only (a redirect to plain http is refused), capped in size and time, and
 * sent with this script's User-Agent and any identifying headers the
 * operator asks for (`staticHeaders`).
 *
 * Output goes to `--out`, else to RAIL_PATHS_DIR when it is set in this
 * script's environment (the directory the server reads; the script does not
 * read `.env`), else to `.cache/rail-paths/` (gitignored). It is served by
 * `/api/rail/paths/<feedId>` and `/api/rail/schedule/<feedId>`.
 *
 * Downloads go to `--work` (kept) or a temporary directory (removed). A feed
 * that fails is reported and skipped; the others still build, and the
 * script then exits with code 2 (code 1: nothing could start, such as a bad
 * argument or a build already holding the lock). Memory stays
 * small: CSV is parsed as a stream and only rail shapes are held. A feed is
 * abandoned once resident memory passes 1.75 GiB.
 */
import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createInflateRaw, gzipSync } from 'node:zlib';
import {
  RAIL_FEED_ID_PATTERN,
  classifyTrain,
  railEnabledFeeds,
  railFeedNeedsSchedulePack,
} from '../src/data/railFeeds.js';
import { RAIL_PATH_PACK_MAX_BYTES } from '../src/data/railProxy.js';
import { decodeRing, polygonsContain } from '../src/data/adminBoundaries.js';
import {
  RAIL_PATH_PACK_VERSION,
  createRailPath,
  pointAtS,
  projectOnPath,
} from '../src/data/railPaths.js';
import { RAIL_SCHEDULE_PACK_VERSION } from '../src/data/railSchedule.js';
import {
  dateFromDayNumber,
  dayNumberOf,
  isTimeZone,
  localDate,
} from '../src/data/railTimeZones.js';
import { isNoTrainPositionStop } from '../src/data/railNoPositions.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT = path.join(ROOT, '.cache', 'rail-paths');
const USER_AGENT =
  'gods-eye-view-rail-paths/1.0 (+https://github.com/bilawalsidhu/gods-eye-view)';

/** Vertex gap that marks a shape as a straight chord (m). */
const MAX_VERTEX_GAP_M = 5000;
/** Douglas-Peucker tolerance applied to kept shapes (m). */
const SIMPLIFY_TOLERANCE_M = 1;
const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;
/** Largest file inflated from a zip: a national stop_times.txt runs to GB. */
const MAX_ENTRY_BYTES = 4 * 1024 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const FEED_DEADLINE_MS = 15 * 60_000;
const MAX_REDIRECTS = 5;
/** Resident memory past which a feed is abandoned rather than the machine strained. */
const MAX_RSS_BYTES = 1.75 * 1024 * 1024 * 1024;
let peakRss = 0;
const MAX_CSV_RECORD_CHARS = 1024 * 1024;
/** The lock a build holds in its `--out` folder (acquireDirLock). */
export const BUILD_LOCK = '.build-rail-paths.lock';
/**
 * Share of the trips of the pack it replaces under which a build is taken
 * for an upstream fault and not written (without `--force`).
 */
export const MIN_TRIP_SHARE = 0.2;
/** Exit code of a build in which one or more feeds failed. */
export const FEED_FAILED_EXIT_CODE = 2;

/**
 * The exit code of a finished build: 0 when every feed built, otherwise
 * FEED_FAILED_EXIT_CODE, even when the other feeds built (a scheduled run
 * must notice one stale feed).
 */
export function buildExitCode(failed) {
  return failed > 0 ? FEED_FAILED_EXIT_CODE : 0;
}

/**
 * GTFS route types that run on rails: tram, subway, rail, cable tram,
 * funicular (7, and extended 1400), monorail, and the extended railway
 * (100s), urban rail (400s) and tram (900s) families.
 */
export function isRailRouteType(value) {
  const type = Number.parseInt(String(value ?? '').trim(), 10);
  if (!Number.isInteger(type)) return false;
  if ([0, 1, 2, 5, 7, 12, 1400].includes(type)) return true;
  return (
    (type >= 100 && type < 200) ||
    (type >= 400 && type < 500) ||
    (type >= 900 && type < 1000)
  );
}

/**
 * Whether a feed keeps the routes.txt rows of this route_type. Without
 * `staticRouteTypes` that is every rail type; with it, only the types it
 * lists. The list may name a non-rail type for an operator that codes its
 * trains as buses (route_type 3); that feed's classifier (or route rename)
 * then keeps only the train routes.
 */
export function keepsRouteType(feed, value) {
  if (!feed?.staticRouteTypes) return isRailRouteType(value);
  const type = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isInteger(type) && feed.staticRouteTypes.includes(type);
}

// ---------------------------------------------------------------- arguments

/**
 * A registered feed's static GTFS read from a zip on disk
 * (`--local-gtfs id=path`) instead of its `staticGtfsUrl`.
 * @returns {{id: string, file: string}} The path made absolute.
 */
export function parseLocalGtfs(text) {
  const at = String(text ?? '').indexOf('=');
  const id = at > 0 ? text.slice(0, at) : '';
  const file = at > 0 ? text.slice(at + 1).trim() : '';
  if (!RAIL_FEED_ID_PATTERN.test(id) || !file)
    throw new Error(`--local-gtfs needs <id>=<path to zip>, got ${text}`);
  return { id, file: path.resolve(file) };
}

/**
 * Stand in for a download with a zip already on disk. Only its name and
 * modification time reach the packs; it is opened read-only later.
 * @returns {Promise<{file: string, lastModified: string, localName: string}>}
 */
export async function localStatic(file) {
  const info = await stat(file);
  if (!info.isFile() || info.size === 0)
    throw new Error(`--local-gtfs ${path.basename(file)} is not a file`);
  return {
    file,
    lastModified: info.mtime.toUTCString(),
    localName: path.basename(file),
  };
}

/**
 * Whether `target` is `dir` or inside it. A name that merely starts with two
 * dots (`src/..cache`) is inside; only a `..` path segment leaves.
 */
export function isInside(dir, target) {
  const relative = path.relative(dir, target);
  return (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/**
 * The command line. `{help: true}` for `--help`; otherwise the feeds must be
 * named (`--feed`) or `--all` given, so a bare run never starts a build of
 * every feed. `--out` defaults to RAIL_PATHS_DIR when the environment sets
 * it (the directory the server serves), else to DEFAULT_OUT.
 * @param {string[]} argv
 * @param {Record<string, string|undefined>} [env]
 */
export function parseBuildArgs(argv, env = process.env) {
  const args = {
    out: env?.RAIL_PATHS_DIR ? path.resolve(env.RAIL_PATHS_DIR) : DEFAULT_OUT,
    work: null,
    feeds: [],
    all: false,
    keep: false,
    schedule: true,
    force: false,
    days: DEFAULT_SCHEDULE_DAYS,
    from: null,
    localGtfs: new Map(),
  };
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      const next = argv[++i];
      if (!next) throw new Error(`${flag} needs a value`);
      return next;
    };
    if (flag === '--out') args.out = path.resolve(value());
    else if (flag === '--work') args.work = path.resolve(value());
    else if (flag === '--feed') args.feeds.push(value());
    else if (flag === '--all') args.all = true;
    else if (flag === '--force') args.force = true;
    else if (flag === '--keep') args.keep = true;
    else if (flag === '--no-schedule') args.schedule = false;
    else if (flag === '--days') {
      args.days = Number(value());
      if (!Number.isInteger(args.days) || args.days < 1 || args.days > 14)
        throw new Error('--days must be 1 to 14');
    } else if (flag === '--from') {
      args.from = value();
      if (!Number.isFinite(dayNumberOf(args.from)))
        throw new Error('--from must be YYYY-MM-DD');
    } else if (flag === '--local-gtfs') {
      const { id, file } = parseLocalGtfs(value());
      args.localGtfs.set(id, file);
    } else throw new Error(`Unknown argument ${flag}`);
  }
  for (const forbidden of ['src', 'public'])
    if (isInside(path.join(ROOT, forbidden), args.out))
      throw new Error(`--out must not be inside ${forbidden}/`);
  if (args.all && args.feeds.length)
    throw new Error('--all builds every feed: give it or --feed, not both');
  if (!args.all && !args.feeds.length)
    throw new Error(
      'Name the feeds to build (--feed <id> ...), or pass --all to build every enabled feed (many downloads, hours); --help for usage',
    );
  return args;
}

/**
 * Why a feed is not built with these arguments, or null. `--no-schedule`
 * removes a feed's schedule pack, and a feed whose trains are named only
 * through it (railFeedNeedsSchedulePack) would leave the catalog with it.
 * @param {object} feed
 * @param {{schedule: boolean}} args
 * @returns {string|null}
 */
export function buildRefusal(feed, args) {
  if (args.schedule || !railFeedNeedsSchedulePack(feed)) return null;
  return `--no-schedule: ${feed.id} names its trains only through its schedule pack, which --no-schedule would remove; build it without --no-schedule`;
}

/**
 * The `source` a feed's packs record: the URL the GTFS was downloaded from
 * (the last redirect's target, `finalUrl`), else the registered one; a
 * `--local-gtfs` zip's file name; the entry read inside the download.
 * @param {object} feed
 * @param {{finalUrl?: string, localName?: string,
 *   lastModified?: string|null}} got downloadStatic or localStatic's answer.
 * @returns {object}
 */
export function packSource(feed, got) {
  return {
    url: got.finalUrl ?? feed.staticGtfsUrl,
    ...(got.localName ? { file: got.localName } : {}),
    ...(feed.staticGtfsEntry ? { entry: feed.staticGtfsEntry } : {}),
    lastModified: got.lastModified ?? null,
  };
}

// ---------------------------------------------------------------- download

/**
 * Download over https only, following each redirect hop by hand so a hop to
 * plain http is refused, with a byte cap and a time limit. Nothing secret is
 * sent: the User-Agent, and the identifying headers an operator asks for.
 * @param {string} url
 * @param {string} dest
 * @param {Record<string, string>|null} [extraHeaders] A feed's
 *   `staticHeaders`.
 * @param {{timeoutMs?: number, maxBytes?: number}} [limits] The time limit
 *   for the whole download and the byte cap (defaults: 5 minutes, 512 MiB).
 * @returns {Promise<{finalUrl: string, lastModified: string|null, bytes: number}>}
 */
export async function downloadStatic(
  url,
  dest,
  extraHeaders = null,
  { timeoutMs = DOWNLOAD_TIMEOUT_MS, maxBytes = MAX_DOWNLOAD_BYTES } = {},
) {
  let current = url;
  const signal = AbortSignal.timeout(timeoutMs);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const target = new URL(current);
    if (target.protocol !== 'https:')
      throw new Error(`refusing non-https URL ${current}`);
    const response = await fetch(target.href, {
      redirect: 'manual',
      signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: '*/*',
        // Identify-yourself headers an operator asks for (Digitraffic,
        // Entur).
        ...(extraHeaders || {}),
      },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location) throw new Error('redirect without a location');
      current = new URL(location, current).href;
      continue;
    }
    if (!response.ok || !response.body)
      throw new Error(`HTTP ${response.status} from ${current}`);
    const declared = Number(response.headers.get('content-length'));
    if (declared > maxBytes) throw new Error(`download is ${declared} bytes`);
    let bytes = 0;
    await pipeline(
      Readable.fromWeb(response.body),
      new Transform({
        transform(chunk, _encoding, done) {
          bytes += chunk.length;
          if (bytes > maxBytes)
            done(new Error('download exceeds the size cap'));
          else done(null, chunk);
        },
      }),
      createWriteStream(dest),
    );
    return {
      finalUrl: current,
      lastModified: response.headers.get('last-modified'),
      bytes,
    };
  }
  throw new Error('too many redirects');
}

// ---------------------------------------------------------------- zip

/**
 * Read a zip's central directory. Entries are streamed on demand; nothing is
 * extracted. Stored and deflated entries, zip64 sizes; encrypted entries are
 * refused.
 * @param {string} file
 */
export async function openZip(file) {
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    const tailSize = Math.min(size, 65_557);
    const tail = Buffer.alloc(tailSize);
    await handle.read(tail, 0, tailSize, size - tailSize);
    let eocd = -1;
    for (let i = tailSize - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error('not a zip file');
    let count = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      const locator = eocd - 20;
      if (locator < 0 || tail.readUInt32LE(locator) !== 0x07064b50)
        throw new Error('zip64 locator missing');
      const at = Number(tail.readBigUInt64LE(locator + 8));
      const record = Buffer.alloc(56);
      await handle.read(record, 0, 56, at);
      if (record.readUInt32LE(0) !== 0x06064b50)
        throw new Error('zip64 record missing');
      count = Number(record.readBigUInt64LE(32));
      cdSize = Number(record.readBigUInt64LE(40));
      cdOffset = Number(record.readBigUInt64LE(48));
    }
    if (cdOffset + cdSize > size) throw new Error('zip directory out of range');
    const cd = Buffer.alloc(cdSize);
    await handle.read(cd, 0, cdSize, cdOffset);
    const entries = new Map();
    let p = 0;
    for (let k = 0; k < count; k++) {
      if (cd.readUInt32LE(p) !== 0x02014b50)
        throw new Error('bad zip directory entry');
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      let compressed = cd.readUInt32LE(p + 20);
      let uncompressed = cd.readUInt32LE(p + 24);
      const nameLength = cd.readUInt16LE(p + 28);
      const extraLength = cd.readUInt16LE(p + 30);
      const commentLength = cd.readUInt16LE(p + 32);
      let offset = cd.readUInt32LE(p + 42);
      const name = cd.toString('utf8', p + 46, p + 46 + nameLength);
      let e = p + 46 + nameLength;
      const extraEnd = e + extraLength;
      while (e + 4 <= extraEnd) {
        const id = cd.readUInt16LE(e);
        const length = cd.readUInt16LE(e + 2);
        if (id === 0x0001) {
          let q = e + 4;
          if (uncompressed === 0xffffffff) {
            uncompressed = Number(cd.readBigUInt64LE(q));
            q += 8;
          }
          if (compressed === 0xffffffff) {
            compressed = Number(cd.readBigUInt64LE(q));
            q += 8;
          }
          if (offset === 0xffffffff) offset = Number(cd.readBigUInt64LE(q));
        }
        e += 4 + length;
      }
      p = extraEnd + commentLength;
      if (name.endsWith('/')) continue;
      entries.set(name, {
        name,
        method,
        encrypted: (flags & 1) === 1,
        compressed,
        uncompressed,
        offset,
      });
    }
    return { file, size, entries, handle };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** The entry named `base`, at the root or in a single top-level folder. */
function findEntry(zip, base) {
  const exact = zip.entries.get(base);
  if (exact) return exact;
  for (const entry of zip.entries.values()) {
    if (
      entry.name.split('/').pop() === base &&
      !entry.name.startsWith('__MACOSX')
    )
      return entry;
  }
  return null;
}

/**
 * A readable stream of one entry's uncompressed bytes, refused or ended
 * with an error past `maxBytes` (declared or inflated).
 * @param {object} zip From openZip.
 * @param {object} entry
 * @param {{maxBytes?: number}} [options] Default MAX_ENTRY_BYTES; a caller
 *   that holds the whole entry in memory gives a smaller cap.
 */
export async function entryStream(
  zip,
  entry,
  { maxBytes = MAX_ENTRY_BYTES } = {},
) {
  if (entry.encrypted) throw new Error(`${entry.name} is encrypted`);
  if (entry.method !== 0 && entry.method !== 8)
    throw new Error(`${entry.name} uses compression method ${entry.method}`);
  if (entry.uncompressed > maxBytes)
    throw new Error(`${entry.name} is ${entry.uncompressed} bytes`);
  const header = Buffer.alloc(30);
  await zip.handle.read(header, 0, 30, entry.offset);
  if (header.readUInt32LE(0) !== 0x04034b50)
    throw new Error(`bad local header for ${entry.name}`);
  const start =
    entry.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  if (start + entry.compressed > zip.size)
    throw new Error(`${entry.name} runs past the end of the zip`);
  const raw = createReadStream(zip.file, {
    start,
    end: Math.max(start, start + entry.compressed - 1),
  });
  if (entry.compressed === 0) {
    raw.destroy();
    return Readable.from([]);
  }
  let produced = 0;
  const cap = new Transform({
    transform(chunk, _encoding, done) {
      produced += chunk.length;
      if (produced > maxBytes)
        done(new Error(`${entry.name} inflates past the cap`));
      else done(null, chunk);
    },
  });
  if (entry.method === 0) return raw.pipe(cap);
  const inflate = createInflateRaw();
  raw.on('error', (error) => inflate.destroy(error));
  inflate.on('error', (error) => cap.destroy(error));
  return raw.pipe(inflate).pipe(cap);
}

// ---------------------------------------------------------------- csv

function countQuotes(text) {
  let n = 0;
  for (let i = text.indexOf('"'); i >= 0; i = text.indexOf('"', i + 1)) n++;
  return n;
}

/** One CSV record (RFC 4180 quoting), fields trimmed. */
export function parseRecord(line) {
  if (line.endsWith('\r')) line = line.slice(0, -1);
  if (!line.includes('"')) return line.split(',').map((f) => f.trim());
  const fields = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      fields.push(field.trim());
      field = '';
    } else field += c;
  }
  fields.push(field.trim());
  return fields;
}

/**
 * Stream a CSV entry as objects keyed by the (trimmed) header, in batches.
 * Records spanning lines inside quotes are joined; only one chunk and one
 * partial record are held at a time.
 * @param {import('node:stream').Readable} stream
 * @param {(row: Record<string, string>) => void} onRow
 */
export async function readCsv(stream, onRow) {
  const decoder = new StringDecoder('utf8');
  let carry = '';
  let header = null;
  let first = true;
  let rows = 0;
  const emit = (line) => {
    if (!line || line === '\r') return;
    const fields = parseRecord(line);
    if (!header) {
      header = fields;
      return;
    }
    const row = {};
    for (let i = 0; i < header.length; i++) row[header[i]] = fields[i] ?? '';
    onRow(row);
    rows++;
  };
  const consume = (text, final) => {
    if (first) {
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      first = false;
    }
    const lines = text.split('\n');
    carry = final ? '' : lines.pop();
    let pending = null;
    for (const line of lines) {
      const record = pending === null ? line : `${pending}\n${line}`;
      if (countQuotes(record) % 2 === 1) {
        pending = record;
        continue;
      }
      pending = null;
      emit(record);
    }
    if (pending !== null) {
      if (final) emit(pending);
      else carry = `${pending}\n${carry}`;
    }
    if (carry.length > MAX_CSV_RECORD_CHARS)
      throw new Error('CSV record too long');
  };
  for await (const chunk of stream) {
    consume(carry + decoder.write(chunk), false);
    checkMemory();
  }
  consume(carry + decoder.end(), true);
  return rows;
}

/**
 * Abandon the work in hand when resident memory is over the build's cap,
 * 1.75 GiB.
 * @throws when over the cap.
 */
export function checkMemory() {
  const rss = process.memoryUsage.rss();
  if (rss > peakRss) peakRss = rss;
  if (rss > MAX_RSS_BYTES)
    throw new Error(
      `resident memory ${Math.round(rss / 2 ** 20)} MiB over cap`,
    );
}

// ---------------------------------------------------------------- geometry

/**
 * Whether a stop has coordinates: both finite and not both zero. Some feeds
 * write (0, 0) for a stop they cannot place (a foreign station their
 * international trains serve), and that is read as no coordinates at all.
 */
export function hasStopCoordinates(lat, lon) {
  return (
    Number.isFinite(lat) && Number.isFinite(lon) && !(lat === 0 && lon === 0)
  );
}

function haversineM(lat1, lon1, lat2, lon2) {
  const r = 6_371_008.8;
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(a)));
}

const round5 = (value) => Math.round(value * 1e5) / 1e5;
const round1 = (value) => Math.round(value * 10) / 10;

/**
 * Turn raw shape points into a rounded flat polyline with cumulative
 * distances, or a reason it was dropped: a vertex gap over
 * MAX_VERTEX_GAP_M marks a chord.
 * @param {number[]} triples `[sequence, lat, lon, ...]`
 * @param {{toleranceM?: number}} [options] Simplification tolerance (m).
 */
export function finishShape(
  triples,
  { toleranceM = SIMPLIFY_TOLERANCE_M } = {},
) {
  const order = [];
  for (let i = 0; i < triples.length; i += 3) order.push(i);
  order.sort((a, b) => triples[a] - triples[b]);
  const flat = [];
  for (const i of order) {
    const lat = round5(triples[i + 1]);
    const lon = round5(triples[i + 2]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90)
      continue;
    const n = flat.length;
    if (n && flat[n - 2] === lat && flat[n - 1] === lon) continue;
    flat.push(lat, lon);
  }
  if (flat.length < 4) return { dropped: 'fewer than two points' };
  let maxGap = 0;
  let gaps = 0;
  for (let i = 2; i < flat.length; i += 2) {
    const gap = haversineM(flat[i - 2], flat[i - 1], flat[i], flat[i + 1]);
    if (gap > maxGap) maxGap = gap;
    if (gap > MAX_VERTEX_GAP_M) gaps++;
  }
  // The gate reads the operator's own vertices; simplifying first would
  // manufacture long gaps on straight track.
  if (maxGap > MAX_VERTEX_GAP_M)
    return { dropped: `vertex gap ${Math.round(maxGap)} m`, maxGap, gaps };
  const line = simplifyFlat(flat, toleranceM);
  const dist = [0];
  let total = 0;
  for (let i = 2; i < line.length; i += 2) {
    total += haversineM(line[i - 2], line[i - 1], line[i], line[i + 1]);
    dist.push(round1(total));
  }
  return { flat: line, dist, maxGap, rawPoints: flat.length / 2, gaps };
}

/**
 * Douglas-Peucker on a flat lat/lon polyline in a local metric frame. Every
 * dropped vertex lies within `toleranceM` of the kept line, far inside what
 * a train marker shows; dense operator shapes shrink several-fold.
 * @param {number[]} flat
 * @param {number} toleranceM
 * @returns {number[]}
 */
export function simplifyFlat(flat, toleranceM) {
  const n = flat.length / 2;
  if (n <= 2) return flat.slice();
  let sumLat = 0;
  for (let i = 0; i < n; i++) sumLat += flat[2 * i];
  const kx = 111_320 * Math.cos(((sumLat / n) * Math.PI) / 180);
  const ky = 111_320;
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = (flat[2 * i + 1] - flat[1]) * kx;
    y[i] = (flat[2 * i] - flat[0]) * ky;
  }
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack = [0, n - 1];
  const tolerance2 = toleranceM * toleranceM;
  while (stack.length) {
    const last = stack.pop();
    const first = stack.pop();
    const dx = x[last] - x[first];
    const dy = y[last] - y[first];
    const len2 = dx * dx + dy * dy;
    let worst = -1;
    let worstD2 = tolerance2;
    for (let i = first + 1; i < last; i++) {
      let t =
        len2 > 0 ? ((x[i] - x[first]) * dx + (y[i] - y[first]) * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const ex = x[first] + dx * t - x[i];
      const ey = y[first] + dy * t - y[i];
      const d2 = ex * ex + ey * ey;
      if (d2 > worstD2) {
        worstD2 = d2;
        worst = i;
      }
    }
    if (worst < 0) continue;
    keep[worst] = 1;
    stack.push(first, worst, worst, last);
  }
  const out = [];
  for (let i = 0; i < n; i++)
    if (keep[i]) out.push(flat[2 * i], flat[2 * i + 1]);
  return out;
}

// ---------------------------------------------------------------- per feed

/**
 * Spain's provinces (ISO 3166-2) grouped into the autonomous communities the
 * category rule uses as states. Elsewhere the Natural Earth unit is the state.
 */
const STATE_GROUPS = Object.freeze({
  ES: Object.fromEntries(
    Object.entries({
      AN: ['AL', 'CA', 'CO', 'GR', 'H', 'J', 'MA', 'SE'],
      AR: ['HU', 'TE', 'Z'],
      AS: ['O'],
      IB: ['PM'],
      CN: ['GC', 'TF'],
      CB: ['S'],
      CL: ['AV', 'BU', 'LE', 'P', 'SA', 'SG', 'SO', 'VA', 'ZA'],
      CM: ['AB', 'CR', 'CU', 'GU', 'TO'],
      CT: ['B', 'GI', 'L', 'T'],
      VC: ['A', 'CS', 'V'],
      EX: ['BA', 'CC'],
      GA: ['C', 'LU', 'OR', 'PO'],
      MD: ['M'],
      MC: ['MU'],
      NC: ['NA'],
      PV: ['VI', 'BI', 'SS'],
      RI: ['LO'],
      CE: ['CE'],
      ML: ['ML'],
    }).flatMap(([community, provinces]) =>
      provinces.map((province) => ['ES-' + province, 'ES-' + community]),
    ),
  ),
});
/** Nearest unit within this distance claims a point no polygon contains. */
const STATE_SNAP_KM = 25;

let statesPromise = null;
/** Natural Earth admin-1 units with decoded polygons and boxes, loaded once. */
async function loadStates() {
  statesPromise ??= (async () => {
    const file = path.join(
      ROOT,
      'src/data/local_data/natural_earth/states_provinces.json',
    );
    const { meta, features } = JSON.parse(
      await readFile(file, { encoding: 'utf8' }),
    );
    return features
      .filter((unit) => unit.iso2 && Array.isArray(unit.polygons))
      .map((unit) => {
        const polygons = unit.polygons.map((poly) =>
          poly.map((ring) => decodeRing(ring, unit.d ?? meta.decimals)),
        );
        let west = Infinity;
        let south = Infinity;
        let east = -Infinity;
        let north = -Infinity;
        for (const [outer] of polygons)
          for (const [lon, lat] of outer) {
            west = Math.min(west, lon);
            east = Math.max(east, lon);
            south = Math.min(south, lat);
            north = Math.max(north, lat);
          }
        return { unit, polygons, box: { west, south, east, north } };
      });
  })();
  return statesPromise;
}

/**
 * The state a point lies in, for the category rules: `{country, state}`
 * (ISO codes; Spain's provinces grouped into communities), or null. A point
 * just outside every simplified polygon (a coastal station) goes to the
 * nearest unit within STATE_SNAP_KM.
 */
export async function createStateLookup() {
  const states = await loadStates();
  const result = (unit) => ({
    country: unit.iso2,
    state: STATE_GROUPS[unit.iso2]?.[unit.iso] ?? unit.iso ?? unit.name,
  });
  return (lat, lon) => {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    for (const { unit, polygons, box } of states) {
      if (
        lat < box.south ||
        lat > box.north ||
        lon < box.west ||
        lon > box.east
      )
        continue;
      if (polygonsContain(polygons, lat, lon)) return result(unit);
    }
    let best = null;
    const margin = STATE_SNAP_KM / 111;
    for (const { unit, polygons, box } of states) {
      if (
        lat < box.south - margin ||
        lat > box.north + margin ||
        lon < box.west - margin * 2 ||
        lon > box.east + margin * 2
      )
        continue;
      for (const [outer] of polygons)
        for (const [vlon, vlat] of outer) {
          const km = haversineM(lat, lon, vlat, vlon) / 1000;
          if (km <= STATE_SNAP_KM && (!best || km < best.km))
            best = { km, unit };
        }
    }
    return best ? result(best.unit) : null;
  };
}

/**
 * Where each rail trip begins and ends, for a feed whose category rule needs
 * it (`staticTripEnds: true`): the first and last stop by stop_sequence, each
 * as `{id, name, lat, lon, country, state}` (`createStateLookup`; null
 * country and state for a point no unit claims), and every country the trip
 * stops in. Only trips on rail routes are held, so memory follows the
 * feed's trains, not its buses.
 * @returns {Promise<Map<string, {from: object, to: object,
 *   countries: string[]}>>}
 */
export async function readTripEnds(feed, zip) {
  const routes = new Set();
  await csvEntry(zip, 'routes.txt', (row) => {
    if (row.route_id && keepsRouteType(feed, row.route_type))
      routes.add(row.route_id);
  });
  const runs = new Map();
  await csvEntry(zip, 'trips.txt', (row) => {
    if (row.trip_id && routes.has(row.route_id)) runs.set(row.trip_id, null);
  });
  const stops = new Map();
  await csvEntry(zip, 'stops.txt', (row) => {
    const lat = Number(row.stop_lat);
    const lon = Number(row.stop_lon);
    if (row.stop_id && hasStopCoordinates(lat, lon))
      stops.set(row.stop_id, {
        id: row.stop_id,
        name: row.stop_name || '',
        lat,
        lon,
      });
  });
  const stateAt = await createStateLookup();
  const placed = (id) => {
    const stop = stops.get(id);
    if (stop && !('country' in stop)) {
      const at = stateAt(stop.lat, stop.lon);
      stop.country = at?.country ?? null;
      stop.state = at?.state ?? null;
    }
    return stop ?? null;
  };
  await csvEntry(zip, 'stop_times.txt', (row) => {
    if (!runs.has(row.trip_id)) return;
    const stop = placed(row.stop_id);
    const seq = Number(row.stop_sequence);
    if (!stop || !Number.isFinite(seq)) return;
    let run = runs.get(row.trip_id);
    if (!run)
      runs.set(
        row.trip_id,
        (run = { first: seq, last: seq, from: stop, to: stop, countries: '' }),
      );
    if (seq < run.first) [run.first, run.from] = [seq, stop];
    if (seq > run.last) [run.last, run.to] = [seq, stop];
    // ISO codes joined by `|`: small enough for a national feed's year of
    // trips (over a million).
    if (stop.country && !run.countries.includes(stop.country))
      run.countries += `${run.countries ? '|' : ''}${stop.country}`;
  });
  for (const [tripId, run] of runs) {
    if (!run) runs.delete(tripId);
    else
      runs.set(tripId, {
        from: run.from,
        to: run.to,
        countries: run.countries ? run.countries.split('|').sort() : [],
      });
  }
  return runs;
}

/**
 * How a feed's route ids are written into its packs. Most feeds keep the
 * operator's ids. A feed whose classifier needs more than the id gives a
 * `staticRouteRename(route, {stop, stateAt, agencyName})` (from the
 * routes.txt row; `agencyName(agency_id)` reads agency.txt) or a
 * `staticTripRename(trip, routeId, {ends})` (per trips.txt row; `ends` is the
 * trip's `readTripEnds` entry, or null, when the feed sets `staticTripEnds`)
 * that returns an id carrying it (see railFeeds.js `scopedRoute`); the
 * realtime proxy reads the same ids back from the schedule pack.
 * @returns {Promise<{route: (row: object) => string|null,
 *   trip: (row: object, routeId: string) => string|null}>}
 */
export async function createRouteNames(feed, zip) {
  const tripEnds =
    feed.staticTripEnds === true && typeof feed.staticTripRename === 'function'
      ? await readTripEnds(feed, zip)
      : null;
  let helpers = null;
  if (typeof feed.staticRouteRename === 'function') {
    const stops = new Map();
    await csvEntry(
      zip,
      'stops.txt',
      (row) => {
        const lat = Number(row.stop_lat);
        const lon = Number(row.stop_lon);
        if (row.stop_id && hasStopCoordinates(lat, lon))
          stops.set(row.stop_id.trim(), { lat, lon });
      },
      { required: false },
    );
    const stateAt = await createStateLookup();
    // agency_id → agency_name, for a feed that sorts its routes by operator.
    const agencies = new Map();
    await csvEntry(
      zip,
      'agency.txt',
      (row) => {
        agencies.set(String(row.agency_id ?? '').trim(), row.agency_name ?? '');
      },
      { required: false },
    );
    helpers = {
      stop: (id) => stops.get(id) ?? null,
      stateAt,
      agencyName: (id) => agencies.get(String(id ?? '').trim()) ?? null,
    };
  }
  return {
    /** The pack id of a routes.txt row this feed keeps, else null. */
    route(row) {
      if (!row.route_id || !keepsRouteType(feed, row.route_type)) return null;
      const id = helpers
        ? (feed.staticRouteRename(row, helpers) ?? row.route_id)
        : row.route_id;
      // A per-trip rename decides at the trip.
      if (typeof feed.staticTripRename === 'function') return id;
      return classifyTrain(feed, id) ? id : null;
    },
    /** The pack id of a trips.txt row on a kept route, else null. */
    trip(row, routeId) {
      if (typeof feed.staticTripRename !== 'function') return routeId;
      const id =
        (tripEnds
          ? feed.staticTripRename(row, routeId, {
              ends: tripEnds.get(row.trip_id) ?? null,
            })
          : feed.staticTripRename(row, routeId)) ?? routeId;
      return classifyTrain(feed, id, { tripId: row.trip_id }) ? id : null;
    },
  };
}

async function csvEntry(zip, base, onRow, { required = true } = {}) {
  const entry = findEntry(zip, base);
  if (!entry) {
    if (required) throw new Error(`${base} missing`);
    return 0;
  }
  return readCsv(await entryStream(zip, entry), onRow);
}

/**
 * `feed_info.txt` `feed_version`, or null: the packs record which version
 * of the operator's timetable they were built from.
 */
export async function readFeedVersion(zip) {
  let version = null;
  await csvEntry(
    zip,
    'feed_info.txt',
    (row) => {
      const value = String(row.feed_version ?? '').trim();
      if (version === null && value && value.length <= 64) version = value;
    },
    { required: false },
  );
  return version;
}

/**
 * Build one feed's pack from an open GTFS zip: the operator's shapes as
 * published, through the quality gate and simplification.
 */
export async function buildPack(feed, zip, source, names = null) {
  names ??= await createRouteNames(feed, zip);
  const deadline = Date.now() + FEED_DEADLINE_MS;
  const overdue = () => {
    if (Date.now() > deadline)
      throw new Error('feed build ran past its deadline');
  };
  /** routes.txt id → pack id, for the routes this feed keeps. */
  const railRoutes = new Map();
  let routeRows = 0;
  await csvEntry(zip, 'routes.txt', (row) => {
    routeRows++;
    const id = names.route(row);
    if (id) railRoutes.set(row.route_id, id);
  });
  overdue();
  const tripShape = new Map();
  const routeShapes = new Map();
  let railTrips = 0;
  let shapelessTrips = 0;
  await csvEntry(zip, 'trips.txt', (row) => {
    const base = railRoutes.get(row.route_id);
    const routeId = base ? names.trip(row, base) : null;
    if (!routeId) return;
    railTrips++;
    if (!row.shape_id) {
      shapelessTrips++;
      return;
    }
    if (row.trip_id) tripShape.set(row.trip_id, row.shape_id);
    let shapes = routeShapes.get(routeId);
    if (!shapes) routeShapes.set(routeId, (shapes = new Set()));
    shapes.add(row.shape_id);
  });
  overdue();
  const wanted = new Map();
  for (const shapes of routeShapes.values())
    for (const id of shapes) if (!wanted.has(id)) wanted.set(id, []);
  if (wanted.size)
    await csvEntry(zip, 'shapes.txt', (row) => {
      const points = wanted.get(row.shape_id);
      if (!points) return;
      points.push(
        Number(row.shape_pt_sequence),
        Number(row.shape_pt_lat),
        Number(row.shape_pt_lon),
      );
    });
  overdue();

  let sparseShapes = 0;
  const shapes = [];
  const dist = [];
  const shapeSources = [];
  const indexByKey = new Map();
  const indexByShapeId = new Map();
  const dropped = [];
  let rawPoints = 0;
  for (const [shapeId, triples] of wanted) {
    // A feed whose operator shapes are dense enough to break the pack cap
    // (Vy: 1.2 million points at 1 m) sets a coarser `staticSimplifyM`.
    const result = finishShape(triples, {
      toleranceM: feed.staticSimplifyM ?? SIMPLIFY_TOLERANCE_M,
    });
    if (result.maxGap > MAX_VERTEX_GAP_M && !result.dropped) sparseShapes++;
    wanted.set(shapeId, null);
    if (result.dropped) {
      dropped.push({ shapeId, reason: result.dropped });
      continue;
    }
    const key = result.flat.join(',');
    if (!indexByKey.has(key)) rawPoints += result.rawPoints;
    let index = indexByKey.get(key);
    if (index === undefined) {
      index = shapes.length;
      shapes.push(result.flat);
      dist.push(result.dist);
      shapeSources.push('operator');
      indexByKey.set(key, index);
    }
    indexByShapeId.set(shapeId, index);
  }
  const trips = Object.create(null);
  let tripsMapped = 0;
  for (const [tripId, shapeId] of tripShape) {
    const index = indexByShapeId.get(shapeId);
    if (index === undefined) continue;
    trips[tripId] = index;
    tripsMapped++;
  }
  const routes = Object.create(null);
  for (const [routeId, ids] of routeShapes) {
    const list = [
      ...new Set([...ids].map((id) => indexByShapeId.get(id))),
    ].filter((index) => index !== undefined);
    if (list.length) routes[routeId] = list.sort((a, b) => a - b);
  }
  const pack = {
    version: RAIL_PATH_PACK_VERSION,
    feedId: feed.id,
    builtAt: new Date().toISOString(),
    source,
    shapes,
    dist,
    shapeSources,
    trips,
    routes,
  };

  return {
    pack,
    stats: {
      routeRows,
      railRoutes: railRoutes.size,
      routesWithShapes: Object.keys(routes).length,
      railTrips,
      shapelessTrips,
      tripsMapped,
      shapeIds: indexByShapeId.size + dropped.length,
      shapesKept: shapes.length,
      shapesDropped: dropped.length,
      sparseShapes,
      points: shapes.reduce((sum, flat) => sum + flat.length / 2, 0),
      rawPoints,
      dropped,
    },
  };
}

// ---------------------------------------------------------------- schedule

/** Service dates in a pack by default: yesterday, today and two days on. */
const DEFAULT_SCHEDULE_DAYS = 4;
/** Longest run (days) a pack looks back for: a multi-day train still out. */
const MAX_LOOKBACK_DAYS = 7;
/** A stop farther than this from its trip's shape unties the pattern from it (m). */
const MAX_STOP_OFFSET_M = 1000;
/** A stop's match on a shape may be this much worse than its best (m). */
const STOP_MATCH_SLACK_M = 50;
/** Arc stride of the earliest-match search along a shape (m). */
const STOP_SEARCH_STEP_M = 2000;
const WEEKDAYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
];

/** GTFS 'H:MM:SS' (hours may pass 24) to seconds, or NaN when blank. */
export function parseGtfsTime(text) {
  const match = /^\s*(\d{1,3}):([0-5]\d):([0-5]\d)\s*$/.exec(text ?? '');
  return match
    ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
    : NaN;
}

/** Most runs one frequencies.txt row may expand to (a minute apart all day). */
const MAX_FREQUENCY_RUNS = 1440;

/**
 * The departures of a frequency-based trip (frequencies.txt): from each
 * row's start_time every headway_secs while before its end_time, the GTFS
 * reading for both `exact_times` values. Rows are flat `[start, end,
 * headway, ...]` in seconds; a malformed row adds nothing, and one row adds
 * at most MAX_FREQUENCY_RUNS runs. Sorted, without duplicates.
 * @param {number[]} windows
 * @returns {number[]}
 */
export function frequencyDepartures(windows) {
  const out = new Set();
  for (let i = 0; i + 2 < windows.length; i += 3) {
    const [start, end, headway] = windows.slice(i, i + 3);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (!Number.isInteger(headway) || headway <= 0) continue;
    for (
      let at = start, n = 0;
      at < end && n < MAX_FREQUENCY_RUNS;
      at += headway, n++
    )
      out.add(at);
  }
  return [...out].sort((a, b) => a - b);
}

/** Seconds after midnight as GTFS 'HH:MM:SS' (hours may pass 24). */
function gtfsTimeText(sec) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(Math.floor(sec / 3600))}:${pad(Math.floor(sec / 60) % 60)}:${pad(sec % 60)}`;
}

/**
 * Resolve calendar.txt and calendar_dates.txt rows to the concrete service
 * dates between two UTC-day numbers (inclusive).
 * @param {object[]} calendar
 * @param {object[]} exceptions
 * @param {number} fromDay
 * @param {number} toDay
 * @returns {Map<string, number[]>} service_id → sorted day numbers.
 */
export function resolveServiceDays(calendar, exceptions, fromDay, toDay) {
  const days = new Map();
  const setFor = (id) => {
    let set = days.get(id);
    if (!set) days.set(id, (set = new Set()));
    return set;
  };
  for (const row of calendar) {
    const start = dayNumberOf(row.start_date);
    const end = dayNumberOf(row.end_date);
    if (!row.service_id || !Number.isFinite(start) || !Number.isFinite(end))
      continue;
    const set = setFor(row.service_id);
    const last = Math.min(end, toDay);
    // Day 0 (1970-01-01) was a Thursday.
    for (let day = Math.max(start, fromDay); day <= last; day++)
      if (row[WEEKDAYS[(((day + 4) % 7) + 7) % 7]] === '1') set.add(day);
  }
  for (const row of exceptions) {
    const day = dayNumberOf(row.date);
    if (
      !row.service_id ||
      !Number.isFinite(day) ||
      day < fromDay ||
      day > toDay
    )
      continue;
    const set = setFor(row.service_id);
    if (row.exception_type === '1') set.add(day);
    else if (row.exception_type === '2') set.delete(day);
  }
  const out = new Map();
  for (const [id, set] of days)
    if (set.size)
      out.set(
        id,
        [...set].sort((a, b) => a - b),
      );
  return out;
}

/**
 * Arc length of each stop along a path, in stop order and never decreasing.
 * Each stop takes the earliest point at or after the previous stop whose
 * distance is within STOP_MATCH_SLACK_M of its best forward match, so a loop
 * that passes a station twice binds the station to the pass in order.
 * @param {object} path From createRailPath.
 * @param {Array<{lat: number, lon: number}>} stops
 * @returns {{dist: number[], maxOffsetM: number}|null}
 */
export function projectStops(path, stops) {
  const dist = [];
  let prev = 0;
  let maxOffsetM = 0;
  for (const { lat, lon } of stops) {
    const rest = Math.max(0, path.length - prev);
    const whole = projectOnPath(path, lat, lon, prev + rest / 2, rest / 2 + 1);
    if (!whole) return null;
    let pick = { s: whole.s, offsetM: whole.offsetM };
    const accept = whole.offsetM + STOP_MATCH_SLACK_M;
    for (
      let a = prev;
      a < whole.s - STOP_SEARCH_STEP_M;
      a += STOP_SEARCH_STEP_M
    ) {
      const hit = projectOnPath(
        path,
        lat,
        lon,
        a + STOP_SEARCH_STEP_M / 2,
        STOP_SEARCH_STEP_M / 2,
      );
      if (hit && hit.offsetM <= accept && hit.s + 1 >= prev) {
        pick = { s: hit.s, offsetM: hit.offsetM };
        break;
      }
    }
    const s = Math.max(prev, pick.s);
    dist.push(round1(s));
    prev = s;
    // The path's flat projection stretches east-west distance away from its
    // middle latitude (2% at Newark on a Roanoke to New York line), so the
    // offset is the great-circle distance to the matched point.
    const foot = pointAtS(path, pick.s);
    const offsetM = foot
      ? haversineM(lat, lon, foot.lat, foot.lon)
      : pick.offsetM;
    if (offsetM > maxOffsetM) maxOffsetM = offsetM;
  }
  return { dist, maxOffsetM };
}

/** Cumulative great-circle metres along a list of points. */
function straightDist(points) {
  const dist = [0];
  for (let k = 1; k < points.length; k++) {
    const a = points[k - 1];
    const b = points[k];
    dist.push(round1(dist[k - 1] + haversineM(a.lat, a.lon, b.lat, b.lon)));
  }
  return dist;
}

/**
 * Fill blank stop times: a stop with one of arrival/departure takes it for
 * both; a stop with neither (GTFS allows that between timepoints) is placed
 * by distance between the timed stops around it.
 * @returns {boolean} false when the first or last stop has no time.
 */
export function fillTimes(arr, dep, dist) {
  const n = arr.length;
  for (let k = 0; k < n; k++) {
    if (!Number.isFinite(arr[k])) arr[k] = dep[k];
    if (!Number.isFinite(dep[k])) dep[k] = arr[k];
  }
  if (!Number.isFinite(dep[0]) || !Number.isFinite(arr[n - 1])) return false;
  let last = 0;
  for (let k = 1; k < n; k++) {
    if (!Number.isFinite(arr[k])) continue;
    const span = dist[k] - dist[last];
    for (let j = last + 1; j < k; j++) {
      const f =
        span > 0 ? (dist[j] - dist[last]) / span : (j - last) / (k - last);
      arr[j] = dep[j] = Math.round(dep[last] + (arr[k] - dep[last]) * f);
    }
    last = k;
  }
  return true;
}

/**
 * Build one feed's schedule pack from an open GTFS zip and the path pack just
 * built from it. A stop with no coordinates (hasStopCoordinates) is left out
 * of its runs, so no line is drawn to it and nothing is guessed; a run needs
 * two located stops. A pattern whose trips have no usable operator shape
 * takes `shape: null`, and the layer draws no line for it.
 * @param {object} feed
 * @param {object} zip
 * @param {object} source
 * @param {object} pathPack Read only.
 * @param {{from?: string|null, days?: number, now?: number,
 *   names?: object}} [options]
 */
export async function buildSchedule(feed, zip, source, pathPack, options = {}) {
  const names = options.names ?? (await createRouteNames(feed, zip));
  const deadline = Date.now() + FEED_DEADLINE_MS;
  const overdue = () => {
    if (Date.now() > deadline)
      throw new Error('schedule build ran past its deadline');
  };
  let timezone = null;
  await csvEntry(zip, 'agency.txt', (row) => {
    if (!timezone && row.agency_timezone) timezone = row.agency_timezone;
  });
  if (!isTimeZone(timezone))
    throw new Error(`agency_timezone ${timezone} is not an IANA zone`);
  const days = Math.max(1, Math.min(14, options.days ?? DEFAULT_SCHEDULE_DAYS));
  const fromDay = options.from
    ? dayNumberOf(options.from)
    : dayNumberOf(localDate(options.now ?? Date.now(), timezone)) - 1;
  if (!Number.isFinite(fromDay)) throw new Error(`bad --from ${options.from}`);
  const toDay = fromDay + days - 1;

  const calendar = [];
  const exceptions = [];
  await csvEntry(zip, 'calendar.txt', (row) => calendar.push(row), {
    required: false,
  });
  // Only dates inside the window can change it; a national feed lists a
  // year of exceptions (hundreds of MB), too many rows to hold.
  await csvEntry(
    zip,
    'calendar_dates.txt',
    (row) => {
      const day = dayNumberOf(row.date);
      if (day >= fromDay - MAX_LOOKBACK_DAYS && day <= toDay)
        exceptions.push(row);
    },
    { required: false },
  );
  const serviceDays = resolveServiceDays(
    calendar,
    exceptions,
    fromDay - MAX_LOOKBACK_DAYS,
    toDay,
  );
  calendar.length = 0;
  exceptions.length = 0;
  overdue();

  const routes = Object.create(null);
  /** routes.txt id → pack id, for the routes this feed keeps. */
  const routeIds = new Map();
  await csvEntry(zip, 'routes.txt', (row) => {
    const id = names.route(row);
    if (!id) return;
    routeIds.set(row.route_id, id);
    const info = { type: Number.parseInt(row.route_type, 10) };
    if (row.route_short_name) info.short = row.route_short_name;
    if (row.route_long_name) info.long = row.route_long_name;
    if (/^[0-9a-f]{6}$/i.test(row.route_color ?? ''))
      info.color = row.route_color.toUpperCase();
    if (/^[0-9a-f]{6}$/i.test(row.route_text_color ?? ''))
      info.textColor = row.route_text_color.toUpperCase();
    routes[id] = info;
  });
  const trips = new Map();
  let railTrips = 0;
  await csvEntry(zip, 'trips.txt', (row) => {
    const base = routeIds.get(row.route_id);
    if (!base || !row.trip_id) return;
    const routeId = names.trip(row, base);
    if (!routeId) return;
    // A per-trip rename makes a new pack route with its line's details.
    if (!Object.hasOwn(routes, routeId)) routes[routeId] = { ...routes[base] };
    railTrips++;
    if (!serviceDays.has(row.service_id)) return;
    trips.set(row.trip_id, {
      route: routeId,
      service: row.service_id,
      headsign: row.trip_headsign || '',
      name: row.trip_short_name || '',
      direction:
        row.direction_id === '0' ? 0 : row.direction_id === '1' ? 1 : null,
      rows: [],
    });
  });
  // Frequency-based runs repeat one template trip (Santiago's Tren Nos):
  // the template's stop times are kept and expanded below into one run per
  // departure, `<trip_id>@<HH:MM:SS>`, all sharing its pattern and run times.
  /** trip_id → flat [start, end, headway, ...] seconds. */
  const frequencyWindows = new Map();
  await csvEntry(
    zip,
    'frequencies.txt',
    (row) => {
      if (!trips.has(row.trip_id)) return;
      let windows = frequencyWindows.get(row.trip_id);
      if (!windows) frequencyWindows.set(row.trip_id, (windows = []));
      windows.push(
        parseGtfsTime(row.start_time),
        parseGtfsTime(row.end_time),
        Number(row.headway_secs),
      );
    },
    { required: false },
  );
  const frequencyTrips = frequencyWindows.size;
  overdue();

  const allStops = new Map();
  await csvEntry(zip, 'stops.txt', (row) => {
    if (!row.stop_id) return;
    allStops.set(row.stop_id, {
      name: row.stop_name || '',
      lat: row.stop_lat ? Number(row.stop_lat) : NaN,
      lon: row.stop_lon ? Number(row.stop_lon) : NaN,
      parent: row.parent_station || '',
      tz: row.stop_timezone || '',
      platform: row.platform_code || '',
    });
  });
  overdue();

  // The heavy file is streamed; only rows of kept trips are held, as flat
  // tuples [sequence, arrival, departure, stop id, pass-through].
  let stopTimeRows = 0;
  await csvEntry(zip, 'stop_times.txt', (row) => {
    stopTimeRows++;
    const trip = trips.get(row.trip_id);
    if (!trip) return;
    trip.rows.push(
      Number(row.stop_sequence),
      parseGtfsTime(row.arrival_time),
      parseGtfsTime(row.departure_time),
      row.stop_id,
      row.pickup_type === '1' && row.drop_off_type === '1' ? 1 : 0,
    );
  });
  overdue();

  const paths = new Map();
  const pathAt = (index) => {
    if (!paths.has(index))
      paths.set(
        index,
        createRailPath(pathPack.shapes[index], pathPack.dist[index]),
      );
    return paths.get(index);
  };
  const patterns = [];
  const patternByKey = new Map();
  const profiles = [];
  const profileByKey = new Map();
  const outTrips = Object.create(null);
  const stats = {
    railTrips,
    tripsInWindow: trips.size,
    frequencyTrips,
    /** Runs the kept frequency-based trips expanded to. */
    frequencyRuns: 0,
    stopTimeRows,
    tripsKept: 0,
    tripsUntimed: 0,
    tripsOutOfWindow: 0,
    tripsUnknownStop: 0,
    tripsNoPositions: 0,
    /** Runs that kept their located stops when some had no coordinates. */
    tripsStopsLeftOut: 0,
    stopsLeftOut: 0,
    patternsOffShape: 0,
    patternsShapeless: 0,
    maxStopOffsetM: 0,
  };
  let lookbackDays = 0;

  /** Stops projected onto an operator shape, or null when they do not fit. */
  const projections = new Map();
  const projectOnto = (shape, stopIds) => {
    const key = `${shape}|${stopIds.join('\u0001')}`;
    if (!projections.has(key)) {
      const path = pathAt(shape);
      const projected = path
        ? projectStops(
            path,
            stopIds.map((id) => allStops.get(id)),
          )
        : null;
      projections.set(
        key,
        projected && projected.maxOffsetM <= MAX_STOP_OFFSET_M
          ? projected
          : null,
      );
    }
    return projections.get(key);
  };

  const patternFor = (shapeIndex, stopIds, seqs, pass) => {
    const key = `${shapeIndex ?? ''}|${stopIds.join('\u0001')}|${seqs.join(',')}|${pass.join('')}`;
    const known = patternByKey.get(key);
    if (known !== undefined) return known;
    const coords = stopIds.map((id) => allStops.get(id));
    let shape = shapeIndex;
    let dist = null;
    if (shape !== null) {
      const projected = projectOnto(shape, stopIds);
      if (projected) {
        dist = projected.dist;
        stats.maxStopOffsetM = Math.max(
          stats.maxStopOffsetM,
          Math.round(projected.maxOffsetM),
        );
      } else {
        stats.patternsOffShape++;
        shape = null;
      }
    }
    if (shape === null) {
      stats.patternsShapeless++;
      dist = straightDist(coords);
    }
    const pattern = { shape, stops: stopIds, seq: seqs, dist };
    if (pass.includes(1)) pattern.pass = pass;
    const index = patterns.length;
    patterns.push(pattern);
    patternByKey.set(key, index);
    return index;
  };

  /** Stops without coordinates, left out of their runs below. */
  const leftOut = new Set();

  // The trips that run in the window, their stops in order.
  const prepared = [];
  for (const [tripId, trip] of trips) {
    const rows = trip.rows;
    trip.rows = null;
    if (rows.length / 5 < 2) {
      stats.tripsUntimed++;
      continue;
    }
    const all = Array.from({ length: rows.length / 5 }, (_, k) => k).sort(
      (a, b) => rows[5 * a] - rows[5 * b],
    );
    const located = (k) => {
      const stop = allStops.get(rows[5 * k + 3]);
      return hasStopCoordinates(stop?.lat, stop?.lon);
    };
    // A stop with no coordinates is left out of the run, its times with it,
    // so no line is drawn to it; a run needs two located stops.
    const order = all.filter(located);
    if (order.length < all.length)
      for (const k of all) if (!located(k)) leftOut.add(rows[5 * k + 3]);
    if (order.length < 2) {
      stats.tripsUnknownStop++;
      continue;
    }
    if (order.length < all.length) stats.tripsStopsLeftOut++;
    const count = order.length;
    const stopIds = order.map((k) => rows[5 * k + 3]);
    // A trip that stops in a no-position country (Ukraine,
    // src/data/railNoPositions.js) is left out of the pack. A stop left out
    // above still counts, by its id.
    if (
      all.some((k) => {
        const id = rows[5 * k + 3];
        const stop = allStops.get(id);
        return isNoTrainPositionStop({ id, lat: stop?.lat, lon: stop?.lon });
      })
    ) {
      stats.tripsNoPositions++;
      continue;
    }
    const seqs = order.map((k) => rows[5 * k]);
    const pass = order.map((k) => rows[5 * k + 4]);
    const arr = order.map((k) => rows[5 * k + 1]);
    const dep = order.map((k) => rows[5 * k + 2]);
    const first = Number.isFinite(dep[0]) ? dep[0] : arr[0];
    const last = Number.isFinite(arr[count - 1])
      ? arr[count - 1]
      : dep[count - 1];
    if (!Number.isFinite(first) || !Number.isFinite(last)) {
      stats.tripsUntimed++;
      continue;
    }
    // A frequency-based template runs from each departure, its stop times
    // moved by the departure's distance from its own first one.
    const departures = frequencyWindows.has(tripId)
      ? frequencyDepartures(frequencyWindows.get(tripId))
      : null;
    if (departures && !departures.length) {
      stats.tripsUntimed++;
      continue;
    }
    // A run that left before the window opened still counts while it is out.
    const reach = Math.floor(
      (departures ? last - first + departures.at(-1) : last) / 86_400,
    );
    const runDays = serviceDays
      .get(trip.service)
      .filter((day) => day <= toDay && day >= fromDay - reach);
    if (!runDays.length) {
      stats.tripsOutOfWindow++;
      continue;
    }
    const shapeIndex = Object.hasOwn(pathPack.trips, tripId)
      ? pathPack.trips[tripId]
      : null;
    prepared.push({
      tripId,
      trip,
      count,
      stopIds,
      seqs,
      pass,
      arr,
      dep,
      reach,
      shapeIndex,
      first,
      departures,
    });
  }
  trips.clear();
  frequencyWindows.clear();
  stats.stopsLeftOut = leftOut.size;
  overdue();

  for (const {
    tripId,
    trip,
    count,
    stopIds,
    seqs,
    pass,
    arr,
    dep,
    reach,
    shapeIndex,
    first,
    departures,
  } of prepared) {
    const patternIndex = patternFor(shapeIndex, stopIds, seqs, pass);
    fillTimes(arr, dep, patterns[patternIndex].dist);
    const startSec = Math.min(arr[0], dep[0]);
    const offsets = [];
    for (let k = 0; k < count; k++)
      offsets.push(arr[k] - startSec, Math.max(arr[k], dep[k]) - startSec);
    lookbackDays = Math.max(lookbackDays, Math.min(reach, MAX_LOOKBACK_DAYS));
    const profileKey = offsets.join(',');
    let profile = profileByKey.get(profileKey);
    if (profile === undefined) {
      profile = profiles.length;
      profiles.push(offsets);
      profileByKey.set(profileKey, profile);
    }
    const out = {
      pattern: patternIndex,
      profile,
      startSec,
      route: trip.route,
      service: trip.service,
    };
    if (trip.headsign) out.headsign = trip.headsign;
    if (trip.name) out.name = trip.name;
    if (trip.direction !== null) out.direction = trip.direction;
    if (!departures) {
      outTrips[tripId] = out;
      stats.tripsKept++;
      continue;
    }
    for (const departure of departures) {
      const run = `${tripId}@${gtfsTimeText(departure)}`;
      if (Object.hasOwn(outTrips, run)) continue;
      outTrips[run] = { ...out, startSec: startSec + departure - first };
      stats.tripsKept++;
      stats.frequencyRuns++;
    }
  }
  prepared.length = 0;
  overdue();

  // Stops: those the kept trips serve, then their parent stations.
  const stopIndex = new Map();
  const stopList = [];
  const addStop = (id) => {
    if (stopIndex.has(id)) return stopIndex.get(id);
    const stop = allStops.get(id);
    const index = stopList.length;
    stopIndex.set(id, index);
    const entry = {
      id,
      name: stop.name,
      lat: round5(stop.lat),
      lon: round5(stop.lon),
    };
    stopList.push(entry);
    if (stop.platform) entry.platform = stop.platform;
    // A child without its own zone takes its parent's (GTFS stop_timezone).
    const zone = stop.tz || allStops.get(stop.parent)?.tz || '';
    if (zone && zone !== timezone && isTimeZone(zone)) entry.tz = zone;
    if (
      stop.parent &&
      stop.parent !== id &&
      hasStopCoordinates(
        allStops.get(stop.parent)?.lat,
        allStops.get(stop.parent)?.lon,
      )
    )
      entry.parent = addStop(stop.parent);
    return index;
  };
  for (const pattern of patterns) for (const id of pattern.stops) addStop(id);
  for (const pattern of patterns)
    pattern.stops = pattern.stops.map((id) => stopIndex.get(id));
  allStops.clear();

  const services = Object.create(null);
  for (const trip of Object.values(outTrips)) {
    if (services[trip.service]) continue;
    services[trip.service] = serviceDays
      .get(trip.service)
      .filter((day) => day >= fromDay - lookbackDays && day <= toDay)
      .map(dateFromDayNumber);
  }
  const usedRoutes = new Set(Object.values(outTrips).map((t) => t.route));
  for (const id of Object.keys(routes))
    if (!usedRoutes.has(id)) delete routes[id];

  const schedule = {
    version: RAIL_SCHEDULE_PACK_VERSION,
    feedId: feed.id,
    builtAt: new Date().toISOString(),
    pathsBuiltAt: pathPack.builtAt,
    source,
    timezone,
    window: { from: dateFromDayNumber(fromDay), to: dateFromDayNumber(toDay) },
    routes,
    stops: stopList,
    patterns: patterns,
    profiles,
    services,
    trips: outTrips,
  };
  return {
    schedule,
    stats: {
      ...stats,
      stops: stopList.length,
      patterns: patterns.length,
      profiles: profiles.length,
      services: Object.keys(services).length,
      lookbackDays,
    },
  };
}

// ---------------------------------------------------------------- main

/**
 * A script's usage for `--help`: the doc comment at the head of the file,
 * where its flags are written down, without the comment markers.
 * @param {string} moduleUrl The script's `import.meta.url`.
 * @returns {Promise<string>}
 */
export async function headerHelp(moduleUrl) {
  const text = await readFile(fileURLToPath(moduleUrl), 'utf8');
  const block = /\/\*\*([\s\S]*?)\*\//.exec(text)?.[1] ?? '';
  return block
    .split('\n')
    .map((line) => line.replace(/^\s*\* ?/, ''))
    .join('\n')
    .trim();
}

async function prepareWorkDir(dir) {
  if (!dir) return mkdtemp(path.join(os.tmpdir(), 'gev-rail-paths-'));
  await mkdir(dir, { recursive: true });
  if ((await readdir(dir)).length)
    throw new Error(`--work ${dir} must be a new or empty directory`);
  return dir;
}

const kib = (bytes) => `${(bytes / 1024).toFixed(1)} KiB`;

/** A pack already on disk, parsed, or null (missing or unreadable). */
async function readPackIfAny(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Trips of a path pack bound to the shapes buildPack makes, the operator's.
 * A shape of any other source (a pack from an older build) is not counted.
 */
export function operatorShapeTrips(pack) {
  const sources = Array.isArray(pack?.shapeSources) ? pack.shapeSources : [];
  let count = 0;
  for (const index of Object.values(pack?.trips ?? {}))
    if ((sources[index] ?? 'operator') === 'operator') count++;
  return count;
}

/** A schedule pack's trips per service day of its window. */
export function scheduleTripsPerDay(schedule) {
  const trips = Object.keys(schedule?.trips ?? {}).length;
  const from = dayNumberOf(schedule?.window?.from ?? '');
  const to = dayNumberOf(schedule?.window?.to ?? '');
  const days =
    Number.isFinite(from) && Number.isFinite(to) && to >= from
      ? to - from + 1
      : 1;
  return trips / days;
}

/**
 * Why a new pack's trips look like an upstream fault rather than a
 * timetable, or null: under MIN_TRIP_SHARE of the pack it replaces (none at
 * all included).
 */
export function tripFloorProblem(label, now, before, share = MIN_TRIP_SHARE) {
  if (!(before > 0) || now >= before * share) return null;
  const round = (n) => Math.round(n * 10) / 10;
  return `${label} ${round(now)} against ${round(before)} in the pack it would replace`;
}

/** How many points a path pack holds, and what thins them. */
function shrinkHint(pack) {
  const points = pack.shapes.reduce((sum, flat) => sum + flat.length / 2, 0);
  return `its shapes hold ${points} points (simplified to the feed's staticSimplifyM, default ${SIMPLIFY_TOLERANCE_M} m: set it coarser)`;
}

/**
 * Write one feed's path pack and, unless null, its schedule pack, as a pair.
 *
 * Both texts are made and checked before anything is written: a pack over
 * `maxBytes` (what the server serves), or trips under MIN_TRIP_SHARE of the
 * packs being replaced (operatorShapeTrips; scheduleTripsPerDay) unless
 * `force`, throws and leaves the previous packs as they were. Both are then
 * written to temporary names of this process; only when both are written is
 * the path pack renamed into place, then the schedule. Without a schedule,
 * the previous one is removed: its patterns index the replaced path pack's
 * shapes. Should the second step fail, the previous schedule is removed for
 * the same reason, and the error says so.
 * @param {string} out
 * @param {string} feedId
 * @param {{pack: object, schedule?: object|null, force?: boolean,
 *   maxBytes?: number}} packs
 * @returns {Promise<{pathText: string, scheduleText: string|null,
 *   removedSchedule: boolean}>}
 */
export async function writeFeedPacks(
  out,
  feedId,
  { pack, schedule = null, force = false, maxBytes = RAIL_PATH_PACK_MAX_BYTES },
) {
  const pathFile = path.join(out, `${feedId}.json`);
  const scheduleFile = path.join(out, `${feedId}.schedule.json`);
  const pathText = JSON.stringify(pack);
  const scheduleText = schedule ? JSON.stringify(schedule) : null;
  const pathBytes = Buffer.byteLength(pathText);
  if (pathBytes > maxBytes)
    throw new Error(
      `paths are ${kib(pathBytes)}, over the ${kib(maxBytes)} the server serves, so the previous packs are kept; ${shrinkHint(pack)}`,
    );
  if (scheduleText !== null && Buffer.byteLength(scheduleText) > maxBytes)
    throw new Error(
      `the schedule is ${kib(Buffer.byteLength(scheduleText))}, over the ${kib(maxBytes)} the server serves, so the previous packs are kept; narrow it with --days`,
    );
  if (!force) {
    const problems = [
      tripFloorProblem(
        'trips on operator shapes',
        operatorShapeTrips(pack),
        operatorShapeTrips(await readPackIfAny(pathFile)),
      ),
    ];
    if (schedule)
      problems.push(
        tripFloorProblem(
          'schedule trips per day',
          scheduleTripsPerDay(schedule),
          scheduleTripsPerDay(await readPackIfAny(scheduleFile)),
        ),
      );
    const found = problems.filter(Boolean);
    if (found.length)
      throw new Error(
        `${found.join('; ')}: an upstream change, not a timetable, so the previous packs are kept (--force writes these)`,
      );
  }
  const pathTemp = tempPathFor(pathFile);
  const scheduleTemp = scheduleText !== null ? tempPathFor(scheduleFile) : null;
  const clean = () =>
    Promise.all(
      [pathTemp, scheduleTemp]
        .filter(Boolean)
        .map((file) => rm(file, { force: true }).catch(() => {})),
    );
  try {
    await writeFile(pathTemp, pathText);
    if (scheduleTemp) await writeFile(scheduleTemp, scheduleText);
    await rename(pathTemp, pathFile);
  } catch (error) {
    await clean();
    throw error;
  }
  // The path pack is in place: the schedule beside it must match it or go.
  let removedSchedule = false;
  try {
    if (scheduleTemp) await rename(scheduleTemp, scheduleFile);
    else {
      removedSchedule = await stat(scheduleFile).then(
        () => true,
        () => false,
      );
      await rm(scheduleFile, { force: true });
    }
  } catch (error) {
    await clean();
    await rm(scheduleFile, { force: true }).catch(() => {});
    throw new Error(
      `the path pack was written but the schedule beside it could not be ${scheduleTemp ? 'replaced' : 'removed'} (${error?.message || error}); it indexes the previous path pack's shapes, so it is removed where it can be`,
    );
  }
  return { pathText, scheduleText, removedSchedule };
}

// ---------------------------------------------------------------- lock

/**
 * A temporary name next to `target`, of this process and this call alone,
 * so two writers of the same file never write into one temporary file.
 */
export function tempPathFor(target) {
  return `${target}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
}

/** A lock not refreshed for this long was left by a run that died (ms). */
export const BUILD_LOCK_STALE_MS = 6 * 3_600_000;
/** How often a held lock's time is refreshed (ms). */
const BUILD_LOCK_REFRESH_MS = 10 * 60_000;
/** A lock file younger than this is held even while it reads as empty (ms). */
const BUILD_LOCK_WRITE_GRACE_MS = 60_000;

/** Whether a process id is running on this machine. */
function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it runs, under another user.
    return error?.code === 'EPERM';
  }
}

/**
 * Take the lock file `name` in `dir` for a build, or refuse when another
 * build holds it. The file records the holder's process id and the time it
 * was taken or last refreshed (every 10 minutes while held). A lock whose
 * process is not running, or that was not refreshed for `staleMs`, is taken
 * over. Locks are advisory: they keep two builds from writing into the same
 * folder at once, nothing more.
 * @param {string} dir Created when missing.
 * @param {string} name
 * @param {{what?: string, staleMs?: number, now?: () => number,
 *   alive?: (pid: number) => boolean}} [options]
 * @returns {Promise<{file: string, release: () => Promise<void>}>}
 */
export async function acquireDirLock(
  dir,
  name,
  {
    what = 'build',
    staleMs = BUILD_LOCK_STALE_MS,
    now = Date.now,
    alive = processAlive,
  } = {},
) {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  const body = () =>
    JSON.stringify({ pid: process.pid, time: new Date(now()).toISOString() });
  const ours = async () => {
    try {
      return JSON.parse(await readFile(file, 'utf8'))?.pid === process.pid;
    } catch {
      return false;
    }
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await writeFile(file, body(), { flag: 'wx' });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let held = null;
      let modified = NaN;
      try {
        modified = (await stat(file)).mtimeMs;
        held = JSON.parse(await readFile(file, 'utf8'));
      } catch {
        held = null;
      }
      const since = Date.parse(held?.time ?? '');
      const fresh = held
        ? alive(held.pid) && Number.isFinite(since) && now() - since <= staleMs
        : // Unreadable: another build may be writing it this moment.
          Number.isFinite(modified) &&
          now() - modified <= BUILD_LOCK_WRITE_GRACE_MS;
      if (fresh)
        throw new Error(
          `another ${what} holds ${file} (pid ${held?.pid ?? '?'}, ${held?.time ?? 'just now'}); ` +
            `wait for it to finish, or delete the file if that process is gone`,
        );
      await rm(file, { force: true });
      continue;
    }
    const timer = setInterval(() => {
      ours()
        .then((yes) => (yes ? writeFile(file, body()) : null))
        .catch(() => {});
    }, BUILD_LOCK_REFRESH_MS);
    timer.unref?.();
    return {
      file,
      async release() {
        clearInterval(timer);
        if (await ours()) await rm(file, { force: true });
      },
    };
  }
  throw new Error(`could not take ${file}`);
}

// ---------------------------------------------------------------- run

async function main() {
  const args = parseBuildArgs(process.argv.slice(2));
  if (args.help) {
    console.log(await headerHelp(import.meta.url));
    return;
  }
  // One build at a time per output folder.
  const lock = await acquireDirLock(args.out, BUILD_LOCK, {
    what: 'rail path build',
  });
  try {
    await buildFeeds(args);
  } finally {
    await lock.release();
  }
}

/** Build the feeds the command line names, holding the --out lock. */
async function buildFeeds(args) {
  const wanted = (feed) => args.all || args.feeds.includes(feed.id);
  const enabled = railEnabledFeeds();
  const feeds = enabled.filter((feed) => feed.staticGtfsUrl && wanted(feed));
  for (const id of args.feeds)
    if (!feeds.some((feed) => feed.id === id))
      throw new Error(`No enabled feed ${id} with a staticGtfsUrl`);
  for (const id of args.localGtfs.keys())
    if (!feeds.some((feed) => feed.id === id))
      throw new Error(
        `--local-gtfs ${id}: no enabled feed ${id} in this build`,
      );
  const work = await prepareWorkDir(args.work);
  await mkdir(args.out, { recursive: true });
  console.log(`[rail-paths] ${feeds.length} feeds → ${args.out}`);
  console.log(`[rail-paths] downloads in ${work}`);
  const downloads = new Map();
  const failures = [];
  try {
    for (const [n, feed] of feeds.entries()) {
      const started = Date.now();
      peakRss = process.memoryUsage.rss();
      let zip = null;
      let inner = null;
      const local = args.localGtfs.get(feed.id) ?? null;
      try {
        const refusal = buildRefusal(feed, args);
        if (refusal) throw new Error(refusal);
        let fetched = local
          ? localStatic(local)
          : downloads.get(feed.staticGtfsUrl);
        if (!fetched) {
          const file = path.join(work, `download-${downloads.size + 1}.zip`);
          fetched = downloadStatic(
            feed.staticGtfsUrl,
            file,
            feed.staticHeaders || null,
          ).then((info) => ({ ...info, file }));
          downloads.set(feed.staticGtfsUrl, fetched);
        }
        const got = await fetched;
        zip = await openZip(got.file);
        if (feed.staticGtfsEntry) {
          const entry = zip.entries.get(feed.staticGtfsEntry);
          if (!entry)
            throw new Error(`${feed.staticGtfsEntry} not in download`);
          const nested = path.join(
            work,
            `${feed.id}-${path.basename(entry.name)}`,
          );
          await pipeline(
            await entryStream(zip, entry),
            createWriteStream(nested),
          );
          inner = zip;
          zip = await openZip(nested);
        }
        const source = packSource(feed, got);
        const feedVersion = await readFeedVersion(zip);
        if (feedVersion) source.feedVersion = feedVersion;
        const names = await createRouteNames(feed, zip);
        const { pack, stats } = await buildPack(feed, zip, source, names);
        // Both packs are written together, once both are built.
        const timetable = args.schedule
          ? await buildSchedule(feed, zip, source, pack, {
              from: args.from,
              days: args.days,
              names,
            })
          : null;
        const written = await writeFeedPacks(args.out, feed.id, {
          pack,
          schedule: timetable?.schedule ?? null,
          force: args.force,
        });
        const text = written.pathText;
        const gz = gzipSync(text).length;
        console.log(
          `[rail-paths] ${n + 1}/${feeds.length} ${feed.id}: ` +
            `rail routes ${stats.railRoutes} (of ${stats.routeRows}), ` +
            `with shapes ${stats.routesWithShapes}; ` +
            `shapes kept ${stats.shapesKept} (from ${stats.shapeIds} ids), dropped ${stats.shapesDropped}, sparse kept ${stats.sparseShapes}; ` +
            `points ${stats.points} (from ${stats.rawPoints}); ` +
            `trips mapped ${stats.tripsMapped}/${stats.railTrips} (no shape_id ${stats.shapelessTrips}); ` +
            `size ${kib(Buffer.byteLength(text))}, gzip ${kib(gz)}; ` +
            `${((Date.now() - started) / 1000).toFixed(1)} s, rss ${Math.round(process.memoryUsage.rss() / 2 ** 20)} MiB, peak ${Math.round(peakRss / 2 ** 20)} MiB`,
        );
        for (const { shapeId, reason } of stats.dropped)
          console.log(`[rail-paths]   dropped shape ${shapeId}: ${reason}`);
        if (written.removedSchedule)
          console.log(
            `[rail-paths]   ${feed.id}: removed the previous schedule pack (--no-schedule): its patterns index the shapes of the path pack just replaced`,
          );
        if (timetable) {
          const body = written.scheduleText;
          const bytes = Buffer.byteLength(body);
          const t = timetable.stats;
          const w = timetable.schedule.window;
          console.log(
            `[rail-paths]   schedule ${feed.id} (${timetable.schedule.timezone}, ${w.from}..${w.to}, lookback ${t.lookbackDays} d): ` +
              `trips ${t.tripsKept} (rail ${t.railTrips}, in calendar ${t.tripsInWindow}, ` +
              `out of window ${t.tripsOutOfWindow}, untimed ${t.tripsUntimed}, unknown stop ${t.tripsUnknownStop}, no positions ${t.tripsNoPositions}, frequency ${t.frequencyTrips} → ${t.frequencyRuns} runs); ` +
              `unlocated stops left out ${t.stopsLeftOut} (from ${t.tripsStopsLeftOut} trips); ` +
              `stops ${t.stops}; patterns ${t.patterns} (off shape ${t.patternsOffShape}, shapeless ${t.patternsShapeless}); ` +
              `profiles ${t.profiles}; services ${t.services}; ` +
              `max stop offset ${t.maxStopOffsetM} m; stop_times rows ${t.stopTimeRows}; ` +
              `size ${kib(bytes)}, gzip ${kib(gzipSync(body).length)}; ` +
              `rss ${Math.round(process.memoryUsage.rss() / 2 ** 20)} MiB`,
          );
        }
      } catch (error) {
        failures.push(feed.id);
        console.error(
          `[rail-paths] ${n + 1}/${feeds.length} ${feed.id} skipped: ${error?.message || error}`,
        );
      } finally {
        await zip?.handle.close().catch(() => {});
        await inner?.handle.close().catch(() => {});
      }
    }
  } finally {
    if (!args.work && !args.keep)
      await rm(work, { recursive: true, force: true });
  }
  console.log(
    `[rail-paths] done: ${feeds.length - failures.length} built` +
      (failures.length ? `, failed: ${failures.join(', ')}` : ''),
  );
  const code = buildExitCode(failures.length);
  if (code) process.exitCode = code;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    console.error(`[rail-paths] ${error?.message || error}`);
    process.exitCode = 1;
  });
