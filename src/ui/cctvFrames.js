import { msg, t } from '../i18n/index.js';

/**
 * Display text for the CCTV source health the server reports
 * (server/providers/cctv.js `setHealth`). The server keeps its English codes
 * and messages; the panel translates them where it renders.
 */

const SOURCE_KIND_LABELS = Object.freeze({
  snapshot: msg('SNAPSHOT'),
  live: msg('LIVE'),
  fallback: msg('FALLBACK'),
  upstream: msg('UPSTREAM'),
  synthetic: msg('SYNTHETIC'),
  configured: msg('CONFIGURED'),
  seed: msg('SEED'),
  image: msg('IMAGE'),
  unknown: msg('UNKNOWN'),
});

const SOURCE_STATUS_LABELS = Object.freeze({
  ok: msg('OK'),
  degraded: msg('DEGRADED'),
  error: msg('ERROR'),
  unknown: msg('UNKNOWN'),
});

const SOURCE_MESSAGES = Object.freeze({
  'Live HLS connected': msg('Live HLS connected'),
  'Live HLS unavailable': msg('Live HLS unavailable'),
  'No stream URL configured': msg('No stream URL configured'),
  'Live stream connected': msg('Live stream connected'),
  'Snapshot feed connected': msg('Snapshot feed connected'),
  'Media fetch failed': msg('Media fetch failed'),
  'Upstream snapshot active': msg('Upstream snapshot active'),
  'Fallback Street View frame': msg('Fallback Street View frame'),
  'Upstream unavailable': msg('Upstream unavailable'),
  'No source configured': msg('No source configured'),
});

const SOURCE_LABELS = Object.freeze({
  'Configured source': msg('Configured source'),
  'Configured Source': msg('Configured Source'),
  'Synthetic fallback': msg('Synthetic fallback'),
});

/** "SNAPSHOT" / "СНИМОК"; unknown codes (HLS, MJPEG…) stay as uppercase codes. */
function cctvSourceKindLabel(kind) {
  const key = String(kind || 'unknown').toLowerCase();
  return SOURCE_KIND_LABELS[key]
    ? t(SOURCE_KIND_LABELS[key])
    : key.toUpperCase();
}

/** "DEGRADED" / "ПЕРЕБОИ"; unknown codes stay as uppercase codes. */
export function cctvSourceStatusLabel(status) {
  const key = String(status || 'unknown').toLowerCase();
  return SOURCE_STATUS_LABELS[key]
    ? t(SOURCE_STATUS_LABELS[key])
    : key.toUpperCase();
}

/** A server health message in the page language; unknown text passes through. */
export function cctvSourceMessageText(message) {
  const text = String(message || '');
  if (SOURCE_MESSAGES[text]) return t(SOURCE_MESSAGES[text]);
  const http = /^Upstream HTTP (\d{3})$/.exec(text);
  if (http) return t('Upstream HTTP {status}', { status: http[1] });
  const media = /^Unexpected media type (.+)$/.exec(text);
  if (media) return t('Unexpected media type {type}', { type: media[1] });
  return text;
}

/** A generic provider label from the server; real provider names pass through. */
export function cctvSourceLabelText(label) {
  const text = String(label || '');
  return SOURCE_LABELS[text] ? t(SOURCE_LABELS[text]) : text;
}

/** Longest wait for a loaded frame's decode before it is shown anyway. */
export const CCTV_FRAME_DECODE_WAIT_MS = 1000;

/**
 * The response header in which a camera source that sets `framesCarryTime`
 * gives each frame's capture time, in milliseconds since the epoch.
 */
export const CCTV_FRAME_TIME_HEADER = 'X-CCTV-Frame-Time';

/** The latest time a Date can hold. */
const MAX_TIME_MS = 8.64e15;

/** A frame-time header's value as epoch ms, or null when absent or malformed. */
export function cctvFrameTimeMs(value) {
  const text = String(value ?? '').trim();
  if (!/^\d{1,16}$/.test(text)) return null;
  const ms = Number(text);
  return ms > 0 && ms <= MAX_TIME_MS ? ms : null;
}

/** "2026-11-26 18:04:31Z", or '' for no time. */
export function cctvFrameTimeLabel(ms) {
  if (!Number.isFinite(ms) || ms <= 0 || ms > MAX_TIME_MS) return '';
  return `${new Date(ms).toISOString().slice(0, 19).replace('T', ' ')}Z`;
}

/**
 * A frame's time as the preview publishes it: epoch ms, its text and its ISO
 * form for a `<time datetime>`, or none.
 */
function frameTime(ms) {
  const timeLabel = cctvFrameTimeLabel(ms);
  return timeLabel
    ? { timeMs: ms, timeLabel, timeIso: new Date(ms).toISOString() }
    : { timeMs: null, timeLabel: '', timeIso: '' };
}

/** The preview before any frame: nothing requested, nothing shown. */
export const EMPTY_CCTV_FRAME = Object.freeze({
  cameraId: '',
  currentSrc: '',
  src: '',
  loading: false,
  error: false,
  hasFrame: false,
  wrapLoading: false,
  ...frameTime(null),
});

/** Apply a change to the preview and publish it to the panel view. */
export function _setCctvFrame(change) {
  this._frame = { ...this._frame, ...change };
  this.store.setFrame(this._frame);
}

/** Forget a frame read into an object URL; a shown image keeps its pixels. */
function revoke(url) {
  if (url) URL.revokeObjectURL(url);
}

/** Stop the frame request in flight, its image and any frame it read. */
function dropPendingFrame(controls) {
  controls._cctvFrameFetch?.abort();
  controls._cctvFrameFetch = null;
  if (controls._cctvFramePreloader) {
    controls._cctvFramePreloader.onload = null;
    controls._cctvFramePreloader.onerror = null;
  }
  controls._cctvFramePreloader = null;
  revoke(controls._cctvFramePendingUrl);
  controls._cctvFramePendingUrl = null;
}

export function _clearCctvFrame() {
  this._cctvFrameRequestToken += 1;
  dropPendingFrame(this);
  revoke(this._cctvFrameShownUrl);
  this._cctvFrameShownUrl = null;
  if (this._cctvFrame) this._setCctvFrame(EMPTY_CCTV_FRAME);
}

/**
 * Read a frame and the time its source gives it: the bytes become an object
 * URL, so the picture shown is the one the time belongs to.
 */
async function fetchCctvFrame(src, signal) {
  const response = await globalThis.fetch(src, { signal });
  if (!response.ok) throw new Error('Camera frame HTTP ' + response.status);
  const timeMs = cctvFrameTimeMs(response.headers.get(CCTV_FRAME_TIME_HEADER));
  const blob = await response.blob();
  return { url: URL.createObjectURL(blob), timeMs };
}

/**
 * Show the frame for `src`. A camera whose source sets `framesCarryTime`
 * (`readTime`) has its frame fetched, so the time in its response header can
 * be shown with it; any other frame loads as an image, with no time.
 */
export function _queueCctvFrame(
  src,
  cameraId,
  cameraChanged,
  { readTime = false } = {},
) {
  if (this.destroyed || !this._cctvFrame || !src) return;

  dropPendingFrame(this);
  const token = ++this._cctvFrameRequestToken;
  if (cameraChanged) {
    revoke(this._cctvFrameShownUrl);
    this._cctvFrameShownUrl = null;
  }
  // A different camera gets an honest acquisition state. Never retain the
  // prior camera's pixels under the newly selected metadata.
  const hasFrame = cameraChanged ? false : this._frame.hasFrame;
  this._setCctvFrame({
    ...(cameraChanged ? { src: '', ...frameTime(null) } : {}),
    hasFrame,
    cameraId,
    currentSrc: src,
    loading: true,
    error: false,
    wrapLoading: !hasFrame,
  });

  if (!readTime || typeof globalThis.fetch !== 'function') {
    loadCctvFrameImage(this, token, src, null);
    return;
  }
  const request = new AbortController();
  this._cctvFrameFetch = request;
  fetchCctvFrame(src, request.signal).then(
    ({ url, timeMs }) => {
      if (this.destroyed || token !== this._cctvFrameRequestToken) {
        revoke(url);
        return;
      }
      this._cctvFrameFetch = null;
      this._cctvFramePendingUrl = url;
      loadCctvFrameImage(this, token, url, timeMs);
    },
    () => {
      if (token !== this._cctvFrameRequestToken) return;
      this._cctvFrameFetch = null;
      this._settleCctvFrame(token, src, false);
    },
  );
}

function loadCctvFrameImage(controls, token, src, timeMs) {
  const preloader = new Image();
  controls._cctvFramePreloader = preloader;
  // Settle once the image is decoded, not merely loaded: the panel's <img>
  // then paints the frame the moment it takes the src, instead of showing
  // its empty box for the decode.
  // A decode that rejects after a load still has drawable data, as it was
  // before decoding was awaited. A decode that never settles (a hidden tab may
  // hold it until the page draws) shows the loaded frame after
  // CCTV_FRAME_DECODE_WAIT_MS rather than leaving the preview loading.
  preloader.onload = () => {
    if (typeof preloader.decode !== 'function') {
      controls._settleCctvFrame(token, src, true, timeMs);
      return;
    }
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      controls._settleCctvFrame(token, src, true, timeMs);
    };
    const timer = setTimeout(settle, CCTV_FRAME_DECODE_WAIT_MS);
    preloader.decode().then(settle, settle);
  };
  preloader.onerror = () => controls._settleCctvFrame(token, src, false);
  preloader.src = src;
}

/**
 * Settle the request `token`: `src` is the picture to show (an object URL for
 * a fetched frame) and `timeMs` the time its source gave it, or null.
 */
export function _settleCctvFrame(token, src, ok, timeMs = null) {
  if (
    this.destroyed ||
    !this._cctvFrame ||
    token !== this._cctvFrameRequestToken
  )
    return;
  if (this._cctvFramePreloader) {
    this._cctvFramePreloader.onload = null;
    this._cctvFramePreloader.onerror = null;
  }
  this._cctvFramePreloader = null;
  if (ok) {
    if (this._cctvFrameShownUrl !== this._cctvFramePendingUrl)
      revoke(this._cctvFrameShownUrl);
    this._cctvFrameShownUrl = this._cctvFramePendingUrl;
  } else revoke(this._cctvFramePendingUrl);
  this._cctvFramePendingUrl = null;
  // A failure leaves a settled frame, and its time, on screen.
  this._setCctvFrame(
    ok
      ? {
          loading: false,
          wrapLoading: false,
          error: false,
          src,
          hasFrame: true,
          ...frameTime(timeMs),
        }
      : { loading: false, wrapLoading: false, error: true },
  );
  this._syncCctvSourceBadge(
    this._cctvState?.activeCamera,
    !!this._cctvState?.enabled && !!this.actions.isEnabled(),
  );
}

/** Shared live health describes the stream even when this viewer shows a frame. */
export function isCctvLiveFrameFallback(activeCamera) {
  return (
    activeCamera?.isVideo === false &&
    String(activeCamera.sourceKind || '').toLowerCase() === 'live'
  );
}

/** The source badge's label and frame state for the camera and preview. */
export function presentCctvSourceBadge(activeCamera, enabled, frame) {
  if (!enabled || !activeCamera)
    return { label: t('SOURCE · UNKNOWN'), state: 'idle' };
  if (frame.loading && !frame.hasFrame)
    return { label: t('FRAME · LOADING'), state: 'loading' };
  if (frame.error && !frame.hasFrame)
    return { label: t('FRAME · UNAVAILABLE'), state: 'error' };
  if (isCctvLiveFrameFallback(activeCamera))
    return {
      label: `${cctvSourceKindLabel('fallback')} · ${cctvSourceStatusLabel('degraded')}`,
      state: 'ready',
    };
  const kind = cctvSourceKindLabel(
    activeCamera.sourceKind || activeCamera.feedType || 'unknown',
  );
  const status = cctvSourceStatusLabel(activeCamera.sourceStatus || 'unknown');
  return { label: `${kind} · ${status}`, state: 'ready' };
}

export function _syncCctvSourceBadge(activeCamera, enabled) {
  this.store.setSourceBadge(
    presentCctvSourceBadge(
      activeCamera,
      enabled,
      this.store.live ? EMPTY_CCTV_FRAME : this._frame,
    ),
  );
}
