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
import { t } from '../i18n/index.js';

// loadingFeedback.js composes the shared status copy inside the portable
// node/browser graph (the server-side HUD summary reads the same modules), so
// its labels stay English there. This chip is the presentation boundary: map
// the closed label vocabulary to the catalog, and pass anything unrecognized
// (a live provider error) through verbatim (docs/TRANSLATORS.md).
const STATUS_LABEL_KEYS = Object.freeze({
  'LOADING LIVE DATA': 'shell.status.loadingLiveData',
  'LOAD COMPLETE': 'shell.status.loadComplete',
  'LOAD CANCELLED': 'shell.status.loadCancelled',
  'LOAD FAILED': 'shell.status.loadFailed',
  'LIVE DATA OFF': 'shell.status.liveDataOff',
  'MAPPED SITES LOADED': 'shell.status.mappedSitesLoaded',
  'RETRYING MAPPED SITES': 'shell.status.retryingMappedSites',
  'FETCHING MAPPED SITES': 'shell.status.fetchingMappedSites',
  'TURNING OFF LIVE DATA': 'shell.status.turningOffLiveData',
  'REFRESHING LIVE DATA': 'shell.status.refreshingLiveData',
  'syncing road network': 'shell.status.trafficSyncing',
});

function localizeStatusLabel(label) {
  if (typeof label !== 'string' || !label) return label;
  const key = STATUS_LABEL_KEYS[label.trim()];
  return key ? t(key) : label;
}

const RETRY_DETAIL_RE = /^(?:ALPR cameras · )?retrying in (\d+)s$/;

function localizeStatusDetail(detail) {
  if (typeof detail !== 'string' || !detail) return detail;
  const match = detail.match(RETRY_DETAIL_RE);
  if (match) return t('shell.status.retryingIn', { seconds: match[1] });
  if (detail.trim() === 'retry pending') return t('shell.status.retryPending');
  return detail;
}

function localizeLoadingPresentation(presentation) {
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
      this._updateTrafficSyncChip();
      this._updateGlobalLoadingFeedback();
    }, 500);
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
