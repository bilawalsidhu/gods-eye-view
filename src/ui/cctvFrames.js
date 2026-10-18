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
export function cctvSourceKindLabel(kind) {
  const key = String(kind || 'unknown').toLowerCase();
  return SOURCE_KIND_LABELS[key]
    ? t(SOURCE_KIND_LABELS[key])
    : key.toUpperCase();
}

/** "DEGRADED" / "ПЕРЕБОИ"; OK and unknown codes stay as uppercase codes. */
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

export function _clearCctvFrame() {
  this._cctvFrameRequestToken += 1;
  if (this._cctvFramePreloader) {
    this._cctvFramePreloader.onload = null;
    this._cctvFramePreloader.onerror = null;
  }
  this._cctvFramePreloader = null;
  if (this._cctvFrame) {
    this._cctvFrame.classList.remove('active');
    this._cctvFrame.removeAttribute('src');
    this._cctvFrame.dataset.cameraId = '';
    this._cctvFrame.dataset.currentSrc = '';
    this._cctvFrame.dataset.loading = '';
    this._cctvFrame.dataset.error = '';
  }
  this._cctvFrameWrap?.classList.remove('loading', 'has-frame');
}

export function _queueCctvFrame(src, cameraId, cameraChanged) {
  if (this.destroyed || !this._cctvFrame || !src) return;

  if (cameraChanged) {
    // A different camera gets an honest acquisition state. Never retain
    // the prior camera's pixels under the newly selected metadata.
    this._cctvFrame.classList.remove('active');
    this._cctvFrame.removeAttribute('src');
    this._cctvFrameWrap?.classList.remove('has-frame');
  }

  if (this._cctvFramePreloader) {
    this._cctvFramePreloader.onload = null;
    this._cctvFramePreloader.onerror = null;
  }
  const token = ++this._cctvFrameRequestToken;
  this._cctvFrame.dataset.cameraId = cameraId;
  this._cctvFrame.dataset.currentSrc = src;
  this._cctvFrame.dataset.loading = 'true';
  this._cctvFrame.dataset.error = '';
  this._cctvFrameWrap?.classList.toggle(
    'loading',
    !this._cctvFrameWrap?.classList.contains('has-frame'),
  );

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
  this._cctvFrame.dataset.loading = '';
  this._cctvFrameWrap?.classList.remove('loading');

  const syncBadge = () =>
    this._syncCctvSourceBadge(
      this._cctvState?.activeCamera,
      !!this._cctvState?.enabled && !!this.actions.isEnabled(),
    );

  if (!ok) {
    // Leave the element untouched — a settled frame stays on screen.
    this._cctvFrame.dataset.error = 'true';
    syncBadge();
    return;
  }

  this._cctvFrame.dataset.error = '';
  this._cctvFrame.src = src;
  this._cctvFrame.classList.add('active');
  this._cctvFrameWrap?.classList.add('has-frame');
  syncBadge();
}

export function _syncCctvSourceBadge(activeCamera, enabled) {
  if (!this._cctvSourceBadge) return;
  if (!enabled || !activeCamera) {
    this._cctvSourceBadge.textContent = t('SOURCE · UNKNOWN');
    this._cctvSourceBadge.dataset.frameState = 'idle';
    return;
  }
  const hasDisplayedFrame =
    this._cctvFrameWrap?.classList.contains('has-frame');
  if (this._cctvFrame?.dataset.loading === 'true' && !hasDisplayedFrame) {
    this._cctvSourceBadge.textContent = t('FRAME · LOADING');
    this._cctvSourceBadge.dataset.frameState = 'loading';
    return;
  }
  if (this._cctvFrame?.dataset.error === 'true' && !hasDisplayedFrame) {
    this._cctvSourceBadge.textContent = t('FRAME · UNAVAILABLE');
    this._cctvSourceBadge.dataset.frameState = 'error';
    return;
  }
  const kind = cctvSourceKindLabel(
    activeCamera.sourceKind || activeCamera.feedType || 'unknown',
  );
  const status = cctvSourceStatusLabel(activeCamera.sourceStatus || 'unknown');
  this._cctvSourceBadge.textContent = `${kind} · ${status}`;
  this._cctvSourceBadge.dataset.frameState = 'ready';
}
