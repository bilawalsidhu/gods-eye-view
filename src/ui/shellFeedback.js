/** Own loading notices, traffic status, toast timing and visibility cleanup. */
import {
  aggregateLayerLoading,
  createGlobalStatusNotice,
  createLoadingFeedbackState,
  createTrafficSyncFeedbackState,
  presentGlobalLoadingStatus,
  reduceLoadingFeedback,
  reduceTrafficSyncFeedback,
} from '../loadingFeedback.js';
import { setSplitFlapText, disposeSplitFlap } from '../splitFlap.js';
import { getLocale, t, msg } from '../i18n/index.js';
import { localizeLayerName } from './layerPanel.js';
import { translateFeedError } from './statusText.js';

// The server also loads loadingFeedback.js (through the HUD summary), so its
// labels stay English. Translate the known ones; pass anything else (a live
// provider error) through.
const STATUS_LABEL_KEYS = Object.freeze({
  'LOADING LIVE DATA': msg('LOADING LIVE DATA'),
  'LOAD COMPLETE': msg('LOAD COMPLETE'),
  'LOAD CANCELLED': msg('LOAD CANCELLED'),
  'LOAD FAILED': msg('LOAD FAILED'),
  'LIVE DATA OFF': msg('LIVE DATA OFF'),
  'MAPPED SITES LOADED': msg('MAPPED SITES LOADED'),
  'RETRYING MAPPED SITES': msg('RETRYING MAPPED SITES'),
  'FETCHING MAPPED SITES': msg('FETCHING MAPPED SITES'),
  'RETRYING ALPR CAMERAS': msg('RETRYING ALPR CAMERAS'),
  'FETCHING ALPR CAMERAS': msg('FETCHING ALPR CAMERAS'),
  'OVERPASS TEMPORARILY UNAVAILABLE': msg('OVERPASS TEMPORARILY UNAVAILABLE'),
  // The other mapped-site failure reasons (src/data/installationFeedback.js),
  // upper-cased by presentGlobalLoadingStatus.
  'OVERPASS RATE-LIMITED': msg('OVERPASS RATE-LIMITED'),
  'OVERPASS TIMED OUT': msg('OVERPASS TIMED OUT'),
  'OVERPASS COULD NOT COMPLETE THE QUERY': msg(
    'OVERPASS COULD NOT COMPLETE THE QUERY',
  ),
  'MAP TILES TEMPORARILY UNAVAILABLE': msg('MAP TILES TEMPORARILY UNAVAILABLE'),
  'MAPPED NAMES TEMPORARILY UNAVAILABLE': msg(
    'MAPPED NAMES TEMPORARILY UNAVAILABLE',
  ),
  'TURNING OFF LIVE DATA': msg('TURNING OFF LIVE DATA'),
  'REFRESHING LIVE DATA': msg('REFRESHING LIVE DATA'),
  'syncing road network': msg('syncing road network'),
});

// The ALPR retry chip shows the layer's English error upper-cased
// (loadingFeedback.js). These are the camera and vector tile failures it can
// carry, by their upper-cased text; each is translated through its own
// sentence-case key, the one the layer row shows, and upper-cased again.
const CHIP_ERROR_KEYS = new Map(
  [
    msg('Vector tile metadata unavailable'),
    msg('Vector tiles unavailable'),
    msg('Vector tile request timed out'),
    msg('Camera coverage unavailable'),
    msg('Camera source temporarily unavailable'),
    msg('Overpass returned an incomplete camera response'),
  ].map((key) => [key.toUpperCase(), key]),
);
const CHIP_TILE_HTTP_RE = /^VECTOR TILES UNAVAILABLE \(HTTP (\d+)\)$/;

function localizeStatusLabel(label) {
  if (typeof label !== 'string' || !label) return label;
  const text = label.trim();
  const key = STATUS_LABEL_KEYS[text];
  if (key) return t(key);
  const errorKey = CHIP_ERROR_KEYS.get(text);
  const http = errorKey ? null : CHIP_TILE_HTTP_RE.exec(text);
  if (!errorKey && !http) return label;
  return translateFeedError(
    errorKey || `Vector tiles unavailable (HTTP ${http[1]})`,
  ).toLocaleUpperCase(getLocale());
}

// A retry detail is "retrying in Ns" or "retry pending", optionally prefixed
// by the ALPR layer name (loadingFeedback.js). The prefix is kept in every
// language: it is what tells the chip apart from a mapped-sites retry.
const RETRY_DETAIL_RE =
  /^(?:(ALPR cameras) · )?(?:retrying in (\d+)s|(retry pending))$/;

function localizeStatusDetail(detail) {
  if (typeof detail !== 'string' || !detail) return detail;
  const match = detail.trim().match(RETRY_DETAIL_RE);
  if (match) {
    const [, prefix, seconds, pending] = match;
    const retry = pending
      ? t('retry pending')
      : t('retrying in {seconds}s', { seconds });
    return prefix ? `${t('ALPR cameras')} · ${retry}` : retry;
  }
  return localizeLayerRoster(detail);
}

// The loading detail is the active layers' English names joined by " · ",
// with " +N" when more are loading. Translate each known layer name; anything
// else (a provider such as "OpenStreetMap · Overpass") passes through.
function localizeLayerRoster(detail) {
  const [, names, suffix = ''] = detail.match(/^(.*?)( \+\d+)?$/s) || [];
  if (!names) return detail;
  return (
    names
      .split(' · ')
      .map((name) => localizeLayerName(name))
      .join(' · ') + suffix
  );
}

/** The chip's label and detail in the UI language (exported for tests). */
export function localizeLoadingPresentation(presentation) {
  if (!presentation) return presentation;
  return {
    ...presentation,
    label: localizeStatusLabel(presentation.label),
    detail: localizeStatusDetail(presentation.detail),
  };
}
export class ShellFeedback {
  constructor({ readLayers }) {
    this.readLayers = readLayers;
    this.destroyed = false;
    this._loadingFeedbackState = createLoadingFeedbackState();
    this._trafficSyncFeedbackState = createTrafficSyncFeedbackState();
    this._loadingFeedbackEvent = null;
    this._globalStatusNotice = null;
    this._loadingFeedbackTicker =
      this._trafficChipTicker =
      this._toastTimer =
        null;
    this._loadingVisibilityHandler = null;
    this._lastLoadingFeedbackUpdateAt = 0;
    this._lastTrafficChipUpdateAt = 0;
    this._lastTrafficGlobalUpdateAt = 0;
    this._globalLoadingStatus = document.getElementById(
      'global-loading-status',
    );
    this._globalLoadingLabel = document.getElementById('global-loading-label');
    this._globalLoadingDetail = document.getElementById(
      'global-loading-detail',
    );
    this._trafficSyncChip = document.getElementById('traffic-sync-chip');
    this._trafficSyncLabel = document.getElementById('traffic-sync-label');
    this._trafficSyncProgress = document.getElementById(
      'traffic-sync-progress',
    );
    this._toast = document.getElementById('toast');
  }
  observeVisibility() {
    if (this.destroyed || this._loadingVisibilityHandler) return;
    this._loadingVisibilityHandler = () => {
      if (!document.hidden) this._updateGlobalLoadingFeedback();
      else this._stopLoadingFeedbackTicker();
    };
    document.addEventListener(
      'visibilitychange',
      this._loadingVisibilityHandler,
    );
  }
  _updateTrafficSyncChip(forceShow = false, now = performance.now()) {
    if (this.destroyed) return;
    if (
      !this._trafficSyncChip ||
      !this._trafficSyncLabel ||
      !this._trafficSyncProgress
    )
      return;
    const layers = this.readLayers();
    const traffic = Array.isArray(layers)
      ? layers.find((layer) => layer.id === 'traffic')
      : null;
    this._trafficSyncFeedbackState = reduceTrafficSyncFeedback(
      this._trafficSyncFeedbackState,
      {
        enabled: traffic?.enabled === true,
        stats: traffic?.stats || {},
        forceShow,
      },
      now,
    );
    const presentation = this._trafficSyncFeedbackState;
    // setSplitFlapText carries the same unchanged-text guard internally, and
    // the flap keeps textContent equal to the settled label throughout, so
    // this stays a no-op on the repeat ticks exactly as it did before.
    if (presentation.label)
      setSplitFlapText(
        this._trafficSyncLabel,
        localizeStatusLabel(presentation.label),
        {
          // Completion is a timing signal, not another animated loading stage.
          immediate: !presentation.busy,
        },
      );
    // Written on every change INCLUDING the empty settled value — the reducer
    // clears the progress number once the sync lands, and a truthiness guard
    // here would strand the last "..." beside the settled label.
    if (this._trafficSyncProgress.textContent !== presentation.progressText) {
      this._trafficSyncProgress.textContent = presentation.progressText;
    }
    this._trafficSyncChip.classList.toggle('visible', presentation.visible);
  }

  _updateGlobalLoadingFeedback(now = performance.now()) {
    if (this.destroyed) return;
    if (!this._globalLoadingStatus) return;
    const summary = aggregateLayerLoading(this.readLayers() || []);
    this._loadingFeedbackState = reduceLoadingFeedback(
      this._loadingFeedbackState,
      summary,
      now,
      this._loadingFeedbackEvent,
    );
    this._loadingFeedbackEvent = null;
    const presentation = presentGlobalLoadingStatus(
      this._globalStatusNotice,
      this._loadingFeedbackState,
      summary,
      now,
    );
    if (
      this._globalStatusNotice?.persistent !== true &&
      Number.isFinite(this._globalStatusNotice?.hideAt) &&
      now >= this._globalStatusNotice.hideAt
    ) {
      this._globalStatusNotice = null;
    }
    // Loading phases and universal notices both have time-driven transitions.
    // Compute this after arbitration: a queued finite notice starts its dwell
    // only on its first visible frame, then keeps the ticker alive to expiry.
    const noticeNeedsTicker = Number.isFinite(this._globalStatusNotice?.hideAt);
    if (this._loadingFeedbackState?.phase !== 'idle' || noticeNeedsTicker) {
      this._armLoadingFeedbackTicker();
    }
    const localized = localizeLoadingPresentation(presentation);
    this._globalLoadingStatus.hidden = !presentation;
    if (!presentation) {
      delete this._globalLoadingStatus.dataset.state;
      return;
    }
    this._globalLoadingStatus.dataset.state = presentation.state;
    // Split-flap the LABEL only ("LOADING LIVE DATA" -> "LOAD COMPLETE").
    // setSplitFlapText is a no-op when the text is unchanged, which matters
    // here: this runs on every 60 ms and 500 ms tick. The detail line is the
    // live layer roster inside an ellipsised, width-capped span — flapping a
    // list that churns as layers join would be noise, not delight.
    setSplitFlapText(this._globalLoadingLabel, localized.label);
    this._globalLoadingDetail.textContent = localized.detail;
  }

  _showGlobalStatusNotice(message, options = {}) {
    if (this.destroyed) return;
    const now = performance.now();
    this._globalStatusNotice = createGlobalStatusNotice(message, now, options);
    this._updateGlobalLoadingFeedback(now);
  }

  _startTrafficChipTicker() {
    if (this.destroyed) return;
    if (this._trafficChipTicker) return;
    this._trafficChipTicker = setInterval(() => {
      if (document.hidden) return;
      const now = performance.now();
      // Poll busy traffic promptly; retain the idle/global 500 ms read budget.
      if (
        this._trafficSyncFeedbackState.busy ||
        now - this._lastTrafficChipUpdateAt >= 500
      ) {
        this._lastTrafficChipUpdateAt = now;
        this._updateTrafficSyncChip(false, now);
      }
      if (now - this._lastTrafficGlobalUpdateAt >= 500) {
        this._lastTrafficGlobalUpdateAt = now;
        this._updateGlobalLoadingFeedback(now);
      }
    }, 100);
  }

  _armLoadingFeedbackTicker() {
    if (this.destroyed) return;
    // Never arm behind a hidden tab: the reducer cannot usefully advance a
    // chip nobody can see, and the old `return` INSIDE the interval left the
    // 60ms timer scheduled for the entire hidden period (a batch completing
    // while hidden could never clear it — the idle check sat behind the
    // hidden guard). visibilitychange resamples and re-arms on return.
    if (this._loadingFeedbackTicker || document.hidden) return;
    this._loadingFeedbackTicker = setInterval(() => {
      if (document.hidden) {
        this._stopLoadingFeedbackTicker();
        return;
      }
      const now = performance.now();
      this._lastLoadingFeedbackUpdateAt = now;
      this._updateGlobalLoadingFeedback(now);
      const noticeNeedsTicker = Number.isFinite(
        this._globalStatusNotice?.hideAt,
      );
      if (this._loadingFeedbackState?.phase === 'idle' && !noticeNeedsTicker) {
        this._stopLoadingFeedbackTicker();
      }
    }, 60);
  }

  _stopLoadingFeedbackTicker() {
    if (!this._loadingFeedbackTicker) return;
    clearInterval(this._loadingFeedbackTicker);
    this._loadingFeedbackTicker = null;
  }

  _showToast(message) {
    if (this.destroyed) return;
    this._toast.textContent = message;
    this._toast.classList.add('visible');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      this._toast.classList.remove('visible');
    }, 2000);
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this._stopLoadingFeedbackTicker();
    clearInterval(this._trafficChipTicker);
    clearTimeout(this._toastTimer);
    this._trafficChipTicker = this._toastTimer = null;
    if (this._loadingVisibilityHandler)
      document.removeEventListener(
        'visibilitychange',
        this._loadingVisibilityHandler,
      );
    this._loadingVisibilityHandler = null;
    disposeSplitFlap(this._globalLoadingLabel);
    disposeSplitFlap(this._trafficSyncLabel);
    this._toast?.classList.remove('visible');
    if (this._globalLoadingStatus) this._globalLoadingStatus.hidden = true;
  }
}
