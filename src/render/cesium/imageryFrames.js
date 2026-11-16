/**
 * @module render/cesium/imageryFrames
 * @description Timed imagery (`imageryFrames`) on the Cesium globe: which
 * frames of a `TimedSource` a time shows and prefetches, video tiles drawn
 * at a time within their segment, and whether a layer's tiles in view are
 * drawn from its own imagery.
 *
 * A source is a list of frames, in time order. A `frames` source is its own
 * list. A `video` source is each segment's videos seen every
 * `VIDEO_STEP_MS` from its start to its end (at most `VIDEO_STEPS_MAX`
 * steps a segment): a time is shown by the step nearest it, its offset into
 * the segment's videos in proportion; outside every segment, the nearest
 * segment end is the nearest frame.
 */
import * as Cesium from 'cesium';
import { globeTilesDrawn } from './internals.js';

/** How far apart the times a video segment is seen at are, ms. */
export const VIDEO_STEP_MS = 250;
/** The most times one video segment is seen at. */
export const VIDEO_STEPS_MAX = 1200;
/** Tile videos kept loaded a layer, the least recently seen let go first. */
export const VIDEO_CACHE = 48;
/** How long a tile video's seek may take before its frame fails, ms. */
export const VIDEO_SEEK_TIMEOUT_MS = 10000;
/**
 * How long the seek past its end that learns a video's length may take, ms:
 * it may read the whole video first.
 */
export const VIDEO_DURATION_TIMEOUT_MS = 60000;
/**
 * How long a video that failed to load (to say how long it is, or to seek)
 * fails its frames at once, ms, before it is loaded again: not downloaded
 * afresh for every tile that asks.
 */
export const VIDEO_RETRY_MS = 180000;

/**
 * The frames of a timed source, in time order: `{time, url}`, and for
 * video `fraction`, how far into the segment's videos the time is.
 * @param {import('../contract/globe').TimedSource} source
 * @returns {Array<{time: number, url: string, fraction?: number}>}
 */
export function framesOf(source) {
  if (source?.kind === 'video') {
    const frames = [];
    for (const segment of source.segments ?? []) {
      const { url, start, end } = segment;
      if (typeof url !== 'string' || !(end >= start)) continue;
      const span = end - start;
      const steps = Math.min(
        VIDEO_STEPS_MAX,
        Math.max(1, Math.ceil(span / VIDEO_STEP_MS)),
      );
      for (let k = 0; k <= steps; k++)
        frames.push({
          time: start + (span * k) / steps,
          url,
          fraction: span > 0 ? k / steps : 0,
        });
    }
    return frames.sort((a, b) => a.time - b.time);
  }
  if (source?.kind === 'frames')
    return (source.frames ?? [])
      .filter((f) => Number.isFinite(f?.time) && typeof f?.url === 'string')
      .map((f) => ({ time: f.time, url: f.url }))
      .sort((a, b) => a.time - b.time);
  throw new TypeError(`Unknown timed source: ${source?.kind}`);
}

/** The index of the frame nearest `ms` (the earlier one on a tie). */
function nearestIndex(frames, ms) {
  let lo = 0;
  let hi = frames.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].time < ms) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && ms - frames[lo - 1].time <= frames[lo].time - ms) return lo - 1;
  return lo;
}

/**
 * What `ms` shows: the nearest frame, and in `blend` mode the frames either
 * side of it, each with its weight (the later one's share of the way).
 * `nearest` is the frame the clock shows, which `frameReady` names.
 * @returns {{nearest: number, shown: Array<{index: number, weight: number}>}|null}
 */
export function shownAt(frames, ms, mode = 'nearest') {
  if (!frames.length || !Number.isFinite(ms)) return null;
  const nearest = nearestIndex(frames, ms);
  if (mode !== 'blend')
    return { nearest, shown: [{ index: nearest, weight: 1 }] };
  let before = nearest;
  if (frames[before].time > ms && before > 0) before -= 1;
  const after = Math.min(frames.length - 1, before + 1);
  const t0 = frames[before].time;
  const t1 = frames[after].time;
  if (after === before || ms <= t0 || t1 <= t0)
    return { nearest, shown: [{ index: before, weight: 1 }] };
  if (ms >= t1) return { nearest, shown: [{ index: after, weight: 1 }] };
  const f = (ms - t0) / (t1 - t0);
  return {
    nearest,
    shown: [
      { index: before, weight: 1 },
      { index: after, weight: f },
    ],
  };
}

/**
 * The frames to hold loaded: those shown, and the `prefetch` after the
 * last of them (playback runs forward).
 * @returns {number[]} Indices.
 */
export function heldFrames(frames, shown, prefetch) {
  const held = new Set(shown.shown.map((s) => s.index));
  const last = Math.max(...held);
  for (let k = 1; k <= prefetch && last + k < frames.length; k++)
    held.add(last + k);
  return [...held];
}

/** The URL of a tile from a template, as `xyz` imagery fills it. */
function tileUrlOf(template, tilingScheme, x, y, level) {
  const rows = tilingScheme.getNumberOfYTilesAtLevel(level);
  return template
    .replaceAll('{x}', String(x))
    .replaceAll('{y}', String(y))
    .replaceAll('{z}', String(level))
    .replaceAll('{reverseY}', String(rows - 1 - y));
}

/**
 * Seek a video, resolving once it has: on a `seeked` that leaves it no
 * longer seeking (one a seek before it sends late does not count), and its
 * frame there presented where the browser says so. Rejects on an error, or
 * after `timeoutMs` with no seek.
 */
function seekTo(video, time, url, timeoutMs = VIDEO_SEEK_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const stop = () => {
      clearTimeout(timeout);
      video.removeEventListener('seeked', seeked);
      video.removeEventListener('error', failed);
    };
    const failed = () => {
      stop();
      reject(new Error(`The video tile did not seek: ${url}`));
    };
    const timeout = setTimeout(failed, timeoutMs);
    const seeked = () => {
      if (video.seeking) return;
      stop();
      if (typeof video.requestVideoFrameCallback !== 'function') resolve();
      else {
        // Its frame is drawable once presented; never wait on it for long.
        const timer = setTimeout(resolve, 100);
        video.requestVideoFrameCallback(() => {
          clearTimeout(timer);
          resolve();
        });
      }
    };
    video.addEventListener('seeked', seeked);
    video.addEventListener('error', failed);
    video.currentTime = time;
  });
}

/**
 * A layer's tile videos, loaded once each and seeked for each frame drawn
 * from them, one seek at a time a video. A video let go (the least recently
 * seen past `limit`, or all of them on `clear`) fails every frame still
 * waiting on it: emptied, it would never load or seek again.
 */
export function createTileVideos(limit = VIDEO_CACHE) {
  /** url → {video, ready: Promise, queue: Promise, gone: Promise, release} */
  const videos = new Map();
  /**
   * url → when a video that failed to load (or to seek) may be loaded again,
   * epoch ms; pruned as it is added to.
   */
  const failed = new Map();
  /** Fail a url's frames at once for `VIDEO_RETRY_MS`. */
  function fail(url) {
    const now = Date.now();
    for (const [other, retryAt] of failed)
      if (retryAt <= now) failed.delete(other);
    failed.set(url, now + VIDEO_RETRY_MS);
  }
  /** Let go of a url's video, if `entry` is still the one it holds. */
  function drop(url, entry) {
    if (videos.get(url) !== entry) return;
    videos.delete(url);
    release(entry, url);
  }
  /** Let go of an entry's video, failing what waits on it. */
  function release(entry, url) {
    entry.released = true;
    entry.release(new Error(`The video tile was let go: ${url}`));
    entry.video.removeAttribute('src');
    entry.video.load();
  }
  function load(url) {
    let entry = videos.get(url);
    if (entry) {
      videos.delete(url);
      videos.set(url, entry);
      return entry;
    }
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.crossOrigin = 'anonymous';
    const loaded = new Promise((resolve, reject) => {
      video.addEventListener('loadeddata', () => resolve(video), {
        once: true,
      });
      video.addEventListener(
        'error',
        () => reject(new Error(`The video tile did not load: ${url}`)),
        { once: true },
      );
    });
    // A video that does not say how long it is (a recorded WebM, say) is
    // seeked past its end once to learn it.
    const ready = loaded.then(async () => {
      if (!Number.isFinite(video.duration))
        await seekTo(
          video,
          Number.MAX_SAFE_INTEGER,
          url,
          VIDEO_DURATION_TIMEOUT_MS,
        );
      return video;
    });
    video.src = url;
    let releaseWith;
    const gone = new Promise((_, reject) => {
      releaseWith = reject;
    });
    gone.catch(() => {});
    entry = {
      video,
      ready,
      queue: Promise.resolve(),
      gone,
      release: releaseWith,
      released: false,
    };
    videos.set(url, entry);
    // A video that failed to load (or to say how long it is) is not kept,
    // and is loaded again only after `VIDEO_RETRY_MS`.
    const loadedEntry = entry;
    ready.catch(() => {
      if (videos.get(url) !== loadedEntry) return;
      fail(url);
      drop(url, loadedEntry);
    });
    while (videos.size > limit) {
      const [oldest, old] = videos.entries().next().value;
      videos.delete(oldest);
      release(old, oldest);
    }
    return entry;
  }
  /** The video at `fraction` of its length, drawn on a canvas. */
  function frame(url, fraction) {
    const retryAt = failed.get(url);
    if (retryAt !== undefined) {
      if (Date.now() < retryAt)
        return Promise.reject(
          new Error(`The video tile failed to load lately: ${url}`),
        );
      failed.delete(url);
    }
    const entry = load(url);
    // Whatever it waits on, it fails once its video is let go.
    const until = (promise) => Promise.race([promise, entry.gone]);
    const run = until(entry.queue).then(async () => {
      if (entry.released) await entry.gone;
      const video = await until(entry.ready);
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      const at = Math.max(0, Math.min(duration - 1e-3, fraction * duration));
      // Still seeking (a seek that timed out may have set the time without
      // ever ending): seeked again, never drawn as it stands.
      if (video.seeking || Math.abs(video.currentTime - at) > 1e-4)
        try {
          await until(seekTo(video, at, url));
        } catch (error) {
          // A video whose seek did not end (or failed) is let go and, like
          // one that failed to load, loaded again only after
          // `VIDEO_RETRY_MS`: a url that always hangs is not waited on by
          // every tile that asks. One let go meanwhile has not failed.
          if (!entry.released) fail(url);
          drop(url, entry);
          throw error;
        }
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth || 1;
      canvas.height = video.videoHeight || 1;
      canvas.getContext('2d').drawImage(video, 0, 0);
      return canvas;
    });
    entry.queue = run.catch(() => {});
    return run;
  }
  return {
    frame,
    clear() {
      for (const [url, entry] of videos) release(entry, url);
      videos.clear();
      failed.clear();
    },
  };
}

/**
 * A provider drawing a video frame's tiles: each tile the video its URL
 * template names for it (an `xyz` spec), or the one video over the layer's
 * rectangle (any other), at the frame's place in it.
 * @param {import('../contract/globe').ImagerySpec} spec
 * @param {{url: string, fraction: number}} frame
 * @param {ReturnType<typeof createTileVideos>} videos
 */
export function videoProvider(spec, frame, videos) {
  const tiled = spec.kind === 'xyz';
  const rectangle = spec.rectangle
    ? Cesium.Rectangle.fromDegrees(
        spec.rectangle.west,
        spec.rectangle.south,
        spec.rectangle.east,
        spec.rectangle.north,
      )
    : undefined;
  const tilingScheme = tiled
    ? spec.tiling === 'geographic'
      ? new Cesium.GeographicTilingScheme()
      : new Cesium.WebMercatorTilingScheme()
    : new Cesium.GeographicTilingScheme({
        rectangle: rectangle ?? Cesium.Rectangle.MAX_VALUE,
        numberOfLevelZeroTilesX: 1,
        numberOfLevelZeroTilesY: 1,
      });
  const size = spec.tileSize ?? 256;
  return {
    tilingScheme,
    tileWidth: size,
    tileHeight: size,
    minimumLevel: tiled ? (spec.minLevel ?? 0) : 0,
    maximumLevel: tiled ? spec.maxLevel : 0,
    rectangle: rectangle ?? tilingScheme.rectangle,
    credit: undefined,
    errorEvent: new Cesium.Event(),
    hasAlphaChannel: true,
    tileDiscardPolicy: undefined,
    proxy: undefined,
    getTileCredits: () => undefined,
    pickFeatures: () => undefined,
    requestImage(x, y, level) {
      const url = tiled
        ? tileUrlOf(frame.url, tilingScheme, x, y, level)
        : frame.url;
      return videos.frame(url, frame.fraction ?? 0);
    },
  };
}

const { ImageryState } = Cesium;
/** States a tile's imagery settles in: drawn, or nothing better to come. */
const SETTLED = new Set([
  ImageryState.READY,
  ImageryState.FAILED,
  ImageryState.INVALID,
]);

/**
 * Whether every globe tile drawn last frame draws `layer` from its own
 * imagery (not an ancestor's while its own loads). Tiles outside the
 * layer's rectangle have none to draw.
 */
export function layerDrawn(scene, layer) {
  if (!layer || layer.isDestroyed?.() || !layer.ready) return false;
  const tiles = globeTilesDrawn(scene.globe);
  if (!tiles?.length) return false;
  const bounds = layer.imageryProvider?.rectangle ?? layer.rectangle;
  for (const tile of tiles) {
    let found = false;
    for (const tileImagery of tile.data?.imagery ?? []) {
      const loading = tileImagery.loadingImagery;
      const ready = tileImagery.readyImagery;
      if ((loading ?? ready)?.imageryLayer !== layer) continue;
      found = true;
      if (loading && !SETTLED.has(loading.state)) return false;
      if (loading?.state === ImageryState.READY && ready !== loading)
        return false;
    }
    if (
      !found &&
      (!bounds || Cesium.Rectangle.intersection(tile.rectangle, bounds))
    )
      return false;
  }
  return true;
}
