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

/** The preview before any frame: nothing requested, nothing shown. */
export const EMPTY_CCTV_FRAME = Object.freeze({
  cameraId: '',
  currentSrc: '',
  src: '',
  loading: false,
  error: false,
  hasFrame: false,
  wrapLoading: false,
});

/** Apply a change to the preview and publish it to the panel view. */
export function _setCctvFrame(change) {
  this._frame = { ...this._frame, ...change };
  this.store.setFrame(this._frame);
}

export function _clearCctvFrame() {
  this._cctvFrameRequestToken += 1;
  if (this._cctvFramePreloader) {
    this._cctvFramePreloader.onload = null;
    this._cctvFramePreloader.onerror = null;
  }
  this._cctvFramePreloader = null;
  if (this._cctvFrame) this._setCctvFrame(EMPTY_CCTV_FRAME);
}

export function _queueCctvFrame(src, cameraId, cameraChanged) {
  if (this.destroyed || !this._cctvFrame || !src) return;

  if (this._cctvFramePreloader) {
    this._cctvFramePreloader.onload = null;
    this._cctvFramePreloader.onerror = null;
  }
  const token = ++this._cctvFrameRequestToken;
  // A different camera gets an honest acquisition state. Never retain the
  // prior camera's pixels under the newly selected metadata.
  const hasFrame = cameraChanged ? false : this._frame.hasFrame;
  this._setCctvFrame({
    ...(cameraChanged ? { src: '' } : {}),
    hasFrame,
    cameraId,
    currentSrc: src,
    loading: true,
    error: false,
    wrapLoading: !hasFrame,
  });

  const preloader = new Image();
  this._cctvFramePreloader = preloader;
  preloader.onload = () => this._settleCctvFrame(token, src, true);
  preloader.onerror = () => this._settleCctvFrame(token, src, false);
  preloader.src = src;
}

export function _settleCctvFrame(token, src, ok) {
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
  // A failure leaves a settled frame on screen.
  this._setCctvFrame(
    ok
      ? {
          loading: false,
          wrapLoading: false,
          error: false,
          src,
          hasFrame: true,
        }
      : { loading: false, wrapLoading: false, error: true },
  );
  this._syncCctvSourceBadge(
    this._cctvState?.activeCamera,
    !!this._cctvState?.enabled && !!this.actions.isEnabled(),
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
  const kind = cctvSourceKindLabel(
    activeCamera.sourceKind || activeCamera.feedType || 'unknown',
  );
  const status = cctvSourceStatusLabel(activeCamera.sourceStatus || 'unknown');
  return { label: `${kind} · ${status}`, state: 'ready' };
}

export function _syncCctvSourceBadge(activeCamera, enabled) {
  this.store.setSourceBadge(
    presentCctvSourceBadge(activeCamera, enabled, this._frame),
  );
}
