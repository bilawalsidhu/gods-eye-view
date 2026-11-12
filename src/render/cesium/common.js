/**
 * @module render/cesium/common
 * @description What the Cesium ports share: the contract's listener rules
 * and its positions as Cesium's.
 */
import * as Cesium from 'cesium';

/**
 * One subscription list under the contract's listener rules: subscription
 * order, one removed during delivery does not run, one added during
 * delivery waits for the next event, and a throw goes to `onThrow` while
 * the rest still run. Each subscription is its own entry, so a callback
 * subscribed twice runs twice.
 * @param {(error: unknown) => void} onThrow
 */
export function listenerList(onThrow) {
  const entries = [];
  return {
    get size() {
      return entries.length;
    },
    on(cb) {
      const entry = { cb, live: true };
      entries.push(entry);
      return () => {
        entry.live = false;
        const i = entries.indexOf(entry);
        if (i >= 0) entries.splice(i, 1);
      };
    },
    fire(...args) {
      for (const entry of entries.slice()) {
        if (!entry.live) continue;
        try {
          entry.cb(...args);
        } catch (error) {
          onThrow(error);
        }
      }
    },
    clear() {
      for (const entry of entries) entry.live = false;
      entries.length = 0;
    },
  };
}

/** A contract position as ECEF. */
export function toCartesian(pos) {
  if ('x' in pos) return new Cesium.Cartesian3(pos.x, pos.y, pos.z);
  return Cesium.Cartesian3.fromDegrees(pos.lon, pos.lat, pos.height ?? 0);
}

/**
 * Where a listener's throw goes with no `error` listener: the platform's
 * `reportError` (or a rethrow on a microtask), as a browser reports an event
 * listener's exception, loud, while the frame and the other listeners carry
 * on.
 */
export function uncaught(error) {
  if (typeof globalThis.reportError === 'function')
    globalThis.reportError(error);
  else
    queueMicrotask(() => {
      throw error;
    });
}

/**
 * How long a blob's object URL lives after it was last asked for, ms. The
 * object URL store keeps its blob alive, so a URL never revoked keeps every
 * blob ever drawn. An image starts loading from its URL as it is given (a
 * billboard, the icon atlas) or in the next frame drawn (a material), and a
 * load started goes on after the URL is revoked, so a URL idle this long,
 * with `BLOB_URL_FRAMES` frames drawn since, is revoked; the blob drawn
 * again later gets a new one.
 */
export const BLOB_URL_IDLE_MS = 60000;
/** Frames drawn after a blob's URL was last asked for before it is revoked. */
export const BLOB_URL_FRAMES = 2;
let blobFrames = 0;

/** A frame was drawn: lazily loaded images have started loading. */
export function blobUrlFrameDrawn() {
  blobFrames += 1;
}

/**
 * Each blob's object URL: `{blob, url, askedAt, askedFrame}`, while it is
 * not revoked.
 */
const blobUrls = new WeakMap();
/** The same entries, to sweep. */
const liveBlobUrls = new Set();
let blobSweep = null;

/** Revoke the object URLs idle for `BLOB_URL_IDLE_MS`; sweep again while any live. */
function sweepBlobUrls() {
  blobSweep = null;
  const now = Date.now();
  for (const entry of liveBlobUrls)
    if (
      now - entry.askedAt >= BLOB_URL_IDLE_MS &&
      blobFrames - entry.askedFrame >= BLOB_URL_FRAMES
    ) {
      liveBlobUrls.delete(entry);
      blobUrls.delete(entry.blob);
      URL.revokeObjectURL(entry.url);
    }
  if (liveBlobUrls.size) scheduleBlobSweep();
}

function scheduleBlobSweep() {
  if (blobSweep !== null) return;
  blobSweep = setTimeout(sweepBlobUrls, BLOB_URL_IDLE_MS);
  // Never what keeps a process running.
  blobSweep?.unref?.();
}

/**
 * A blob's object URL: the same one each time it is drawn, until it has
 * gone `BLOB_URL_IDLE_MS` and `BLOB_URL_FRAMES` drawn frames without being
 * asked for, when it is revoked.
 */
export function blobUrl(blob) {
  let entry = blobUrls.get(blob);
  if (!entry) {
    entry = { blob, url: URL.createObjectURL(blob), askedAt: 0, askedFrame: 0 };
    blobUrls.set(blob, entry);
    liveBlobUrls.add(entry);
  }
  entry.askedAt = Date.now();
  entry.askedFrame = blobFrames;
  scheduleBlobSweep();
  return entry.url;
}
