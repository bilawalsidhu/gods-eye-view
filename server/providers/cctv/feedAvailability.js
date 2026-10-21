/**
 * Learn which CCTV cameras have no public picture, so they are
 * served as location-only (`feedType: 'none'`) instead of an endless
 * "UPSTREAM UNAVAILABLE" placeholder feed.
 *
 * Discovery, not a list. Two signals, both from real upstream answers:
 *  1. Per camera: NO_FEED_FAILS_TO_MARK consecutive failed frame fetches mark
 *     the camera; any success clears it. A mark expires after
 *     NO_FEED_CAMERA_TTL_MS so the client tries the feed again and the camera
 *     heals by itself when the provider fixes it.
 *  2. Per group (e.g. a TxDOT district): a small sample is probed. If every
 *     sampled camera fails, the group becomes SUSPECT and is re-probed after
 *     NO_FEED_SUSPECT_TTL_MS; only a second consecutive all-fail probe makes it
 *     location-only (until NO_FEED_GROUP_TTL_MS). One upstream blip must not
 *     hide a working district (seen live: El Paso, 2026-10-08). Houston's TxDOT
 *     district (images live on Houston TranStar, not its.txdot.gov) is the
 *     case this exists for.
 *
 * State persists to a small JSON file so a restart does not re-learn it.
 * Pure state + I/O; no HTTP here. Wiring lives in server/providers/cctv.js.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const NO_FEED_FAILS_TO_MARK = 2;
export const NO_FEED_CAMERA_TTL_MS = 24 * 60 * 60 * 1000;
export const NO_FEED_GROUP_TTL_MS = 6 * 60 * 60 * 1000;
export const NO_FEED_SUSPECT_TTL_MS = 10 * 60 * 1000;
export const NO_FEED_GROUP_SAMPLE = 3;
export const NO_FEED_MAX_ENTRIES = 20000;
const GROUP_STATES = new Set(['ok', 'suspect', 'unavailable']);

/**
 * @param {object} [options]
 * @param {string|null} [options.file] - Persistence path (null = memory only).
 * @param {() => number} [options.now]
 * @param {number} [options.persistDelayMs]
 */
export function createFeedAvailability({
  file = null,
  now = Date.now,
  persistDelayMs = 5000,
} = {}) {
  /** id -> consecutive failure count */
  const fails = new Map();
  /** id -> epoch ms when marked location-only */
  const cameras = new Map();
  /** group key -> { state: 'ok'|'suspect'|'unavailable', at: epoch ms } */
  const groups = new Map();
  let persistTimer = null;

  if (file) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const [id, at] of Object.entries(saved?.cameras || {}))
        if (Number.isFinite(at)) cameras.set(id, at);
      for (const [key, verdict] of Object.entries(saved?.groups || {}))
        if (
          verdict &&
          Number.isFinite(verdict.at) &&
          GROUP_STATES.has(verdict.state)
        )
          groups.set(key, { state: verdict.state, at: verdict.at });
      prune();
    } catch {
      /* no saved state yet */
    }
  }

  function prune() {
    const t = now();
    for (const [id, at] of cameras)
      if (t - at >= NO_FEED_CAMERA_TTL_MS) cameras.delete(id);
    // Suspect verdicts are kept for a full group TTL so the confirming
    // re-probe can still see them; freshness is judged in groupVerdictFresh.
    for (const [key, verdict] of groups)
      if (t - verdict.at >= NO_FEED_GROUP_TTL_MS) groups.delete(key);
  }

  function bound(map) {
    while (map.size > NO_FEED_MAX_ENTRIES) map.delete(map.keys().next().value);
  }

  function schedulePersist() {
    if (!file || persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      void persistNow();
    }, persistDelayMs);
    persistTimer.unref?.();
  }

  async function persistNow() {
    if (!file) return;
    prune();
    const body = JSON.stringify({
      cameras: Object.fromEntries(cameras),
      groups: Object.fromEntries(groups),
    });
    try {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      await fsp.writeFile(tmp, body);
      await fsp.rename(tmp, file);
    } catch (error) {
      console.warn(
        '[CCTV] feed availability persist failed:',
        error?.message || error,
      );
    }
  }

  /** Record one real upstream frame attempt for a camera. */
  function recordFrame(id, ok) {
    if (!id) return;
    if (ok) {
      fails.delete(id);
      if (cameras.delete(id)) schedulePersist();
      return;
    }
    const count = (fails.get(id) || 0) + 1;
    fails.delete(id);
    fails.set(id, count);
    bound(fails);
    if (count >= NO_FEED_FAILS_TO_MARK && !cameras.has(id)) {
      cameras.set(id, now());
      bound(cameras);
      schedulePersist();
    }
  }

  /** True while a group's last probe verdict is fresh (suspect = short). */
  function groupVerdictFresh(key) {
    const verdict = groups.get(key);
    if (!verdict) return false;
    const ttl =
      verdict.state === 'suspect'
        ? NO_FEED_SUSPECT_TTL_MS
        : NO_FEED_GROUP_TTL_MS;
    return now() - verdict.at < ttl;
  }

  /**
   * Record a probe result. allFailed=true twice in a row (suspect, then
   * confirm) makes the group unavailable; any success makes it ok.
   * @returns {'ok'|'suspect'|'unavailable'} the new state
   */
  function setGroupVerdict(key, allFailed) {
    if (!key) return null;
    const prev = groups.get(key);
    let state = 'ok';
    if (allFailed === true)
      state =
        prev && (prev.state === 'suspect' || prev.state === 'unavailable')
          ? 'unavailable'
          : 'suspect';
    groups.set(key, { state, at: now() });
    schedulePersist();
    return state;
  }

  /** Location-only right now? (camera mark or group verdict, within TTL) */
  function isUnavailable(id, groupKey = null) {
    const t = now();
    const at = cameras.get(id);
    if (at !== undefined && t - at < NO_FEED_CAMERA_TTL_MS) return true;
    if (!groupKey) return false;
    const verdict = groups.get(groupKey);
    return (
      !!verdict &&
      verdict.state === 'unavailable' &&
      t - verdict.at < NO_FEED_GROUP_TTL_MS
    );
  }

  function stats() {
    prune();
    return {
      cameras: cameras.size,
      groupsUnavailable: [...groups]
        .filter(([, v]) => v.state === 'unavailable')
        .map(([k]) => k),
    };
  }

  return {
    recordFrame,
    groupVerdictFresh,
    setGroupVerdict,
    isUnavailable,
    stats,
    persistNow,
  };
}

/**
 * Probe each stale group with a few evenly spaced cameras, one request at a
 * time (gentle on providers). A group is unavailable only if EVERY sampled
 * camera fails.
 * @param {Array<object>} sources
 * @param {object} availability - createFeedAvailability() instance.
 * @param {(source: object) => string|null} groupKeyFor
 * @param {(source: object) => Promise<boolean>} probe - true if a real image came back.
 */
export async function probeFeedGroups(
  sources,
  availability,
  groupKeyFor,
  probe,
) {
  const byGroup = new Map();
  for (const source of sources) {
    const key = groupKeyFor(source);
    if (!key) continue;
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key).push(source);
  }
  const verdicts = {};
  for (const [key, list] of byGroup) {
    if (availability.groupVerdictFresh(key)) continue;
    const n = Math.min(NO_FEED_GROUP_SAMPLE, list.length);
    let anyOk = false;
    for (let i = 0; i < n && !anyOk; i += 1) {
      const pick = list[Math.floor(((i + 0.5) * list.length) / n)];
      try {
        anyOk = (await probe(pick)) === true;
      } catch {
        anyOk = false;
      }
    }
    const state = availability.setGroupVerdict(key, !anyOk);
    verdicts[key] = state === 'unavailable' ? 'location-only' : state;
  }
  return verdicts;
}
