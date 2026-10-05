import {
  MILITARY_INSTALLATION_CACHE_MS,
  MILITARY_INSTALLATION_ELEMENT_CAP,
  MILITARY_INSTALLATION_DISK_TTL_MS,
  MILITARY_INSTALLATION_DISK_DIR,
  MILITARY_INSTALLATION_MAX_CACHE,
} from './constants.js';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';

const _militaryInstallationCache = new Map();

/**
 * Resolve the READ tiers for one installation request, in order: fresh memory,
 * then disk. Returns UPSTREAM when neither can answer.
 *
 * Disk is skipped while a request for this key is already in flight — the
 * caller joins that instead of paying a read. Exported so the tier ORDER is
 * testable against a real temp directory without a Vite server, mirroring
 * resolveOverpassPreflight.
 *
 * @param {object} options
 * @param {string} options.cacheKey
 * @param {Map<string, {payload: object, cachedAt: number}>} options.memoryCache
 * @param {Map<string, Promise>} options.inFlight
 * @param {() => Promise<?{payload: object, cachedAt: number}>} options.readDisk
 * @param {number} [options.now]
 * @param {number} [options.cacheMs]
 * @returns {Promise<{source: 'HIT'|'DISK'|'UPSTREAM', entry: ?object}>}
 */
async function resolveMilitaryInstallationTier({
  cacheKey,
  memoryCache,
  inFlight,
  readDisk,
  now = Date.now(),
  cacheMs = MILITARY_INSTALLATION_CACHE_MS,
}) {
  const cached = memoryCache.get(cacheKey);
  if (cached && now - cached.cachedAt <= cacheMs)
    return { source: 'HIT', entry: cached };
  if (inFlight.has(cacheKey)) return { source: 'UPSTREAM', entry: null };
  const disk = await readDisk();
  return disk
    ? { source: 'DISK', entry: disk }
    : { source: 'UPSTREAM', entry: null };
}

/**
 * Bring a stored installation entry up to the current payload shape.
 *
 * Entries written before the saturation guard shipped carry no `saturated`
 * field, and the disk TTL is 30 DAYS — so without this a cached, truncated
 * 700-element snapped response would keep skipping the exact-viewport retry for
 * a month, quietly starving in-view sites. Saturation is DERIVED from the
 * element count rather than invalidating those entries, so warm caches survive
 * the upgrade.
 * @param {?{payload: object, cachedAt: number}} entry
 * @returns {?{payload: object, cachedAt: number}}
 */
function migrateMilitaryInstallationEntry(entry) {
  if (!entry?.payload || typeof entry.payload.saturated === 'boolean')
    return entry;
  const elements = Array.isArray(entry.payload.elements)
    ? entry.payload.elements
    : [];
  return {
    ...entry,
    payload: {
      ...entry.payload,
      saturated: elements.length >= MILITARY_INSTALLATION_ELEMENT_CAP,
    },
  };
}

/** Whether a stored installation entry is still inside its TTL. */
function militaryInstallationDiskFresh(
  entry,
  maxAgeMs = MILITARY_INSTALLATION_DISK_TTL_MS,
  now = Date.now(),
) {
  if (
    !entry ||
    !Number.isFinite(entry.cachedAt) ||
    !Array.isArray(entry.payload?.elements)
  )
    return false;
  return now - entry.cachedAt <= maxAgeMs;
}

/** Cache key -> stable disk-cache file path. */
function militaryInstallationDiskPath(
  cacheKey,
  dir = MILITARY_INSTALLATION_DISK_DIR,
) {
  return path.join(
    dir,
    `${createHash('sha1').update(cacheKey).digest('hex')}.json`,
  );
}

/**
 * Read a disk-cached installation entry. maxAgeMs Infinity = any age (the
 * serve-stale path when Overpass is down).
 * @returns {Promise<?{payload: object, cachedAt: number}>}
 */
async function readMilitaryInstallationDisk(
  cacheKey,
  maxAgeMs,
  dir = MILITARY_INSTALLATION_DISK_DIR,
) {
  try {
    const entry = JSON.parse(
      await fsp.readFile(militaryInstallationDiskPath(cacheKey, dir), 'utf8'),
    );
    if (!militaryInstallationDiskFresh(entry, maxAgeMs)) return null;
    return migrateMilitaryInstallationEntry(entry);
  } catch {
    return null;
  }
}

/**
 * Persist one installation payload ATOMICALLY: serialize to a temp sibling,
 * then rename over the target. A crash or a full disk mid-write leaves the
 * PREVIOUS entry intact — an in-place overwrite would shred the last-good copy
 * and take serve-stale down with it, exactly when it is needed most.
 * @returns {Promise<boolean>} Whether the entry landed.
 */
async function writeMilitaryInstallationDisk(
  cacheKey,
  entry,
  dir = MILITARY_INSTALLATION_DISK_DIR,
) {
  const target = militaryInstallationDiskPath(cacheKey, dir);
  // Same directory, so the rename is atomic on POSIX rather than a cross-device copy.
  const temp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(temp, JSON.stringify(entry));
    await fsp.rename(temp, target);
    return true;
  } catch (err) {
    console.warn(
      '[Installations Proxy] disk cache write failed:',
      err?.message || err,
    );
    await fsp.rm(temp, { force: true }).catch(() => {});
    return false;
  }
}

function trimMilitaryInstallationCache() {
  while (_militaryInstallationCache.size > MILITARY_INSTALLATION_MAX_CACHE) {
    const oldest = _militaryInstallationCache.keys().next().value;
    if (oldest === undefined) break;
    _militaryInstallationCache.delete(oldest);
  }
}

export {
  _militaryInstallationCache,
  trimMilitaryInstallationCache,
  writeMilitaryInstallationDisk,
  resolveMilitaryInstallationTier,
  readMilitaryInstallationDisk,
  migrateMilitaryInstallationEntry,
  militaryInstallationDiskFresh,
  militaryInstallationDiskPath,
};
