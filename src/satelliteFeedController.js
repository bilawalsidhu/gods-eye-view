/**
 * @module satelliteFeedController
 * @description Bridges the satellites layer's track/untrack events to the SAT
 * FEED panel. Listens for the `gev:awareness-subject-selected` /
 * `gev:awareness-subject-cleared` window events the layer already emits
 * (`data/satellites.js`), and — when the tracked subject is a satellite that
 * has a feed — pushes a render-ready `state` object to subscribers. The UI's
 * `_renderSatFeedState` consumes it exactly like `_renderCctvState` consumes
 * `cctvLayer.subscribe`.
 *
 * `imagery` feeds get a `refreshMs` interval that re-emits with a fresh frame
 * URL; the interval no-ops while the tab is hidden so it does no off-screen
 * work. All environment seams (`now`, timers, `document.hidden`, the event
 * target) are injectable so the controller unit-tests with no DOM.
 */

import { feedForNorad, hasSatelliteFeed, resolveFeedSource } from './data/satelliteFeeds.js';

const SATELLITES_LAYER_ID = 'satellites';

/** @typedef {(state: object) => void} FeedStateListener */

export class SatelliteFeedController {
  /**
   * @param {object} [deps]
   * @param {() => number} [deps.now]
   * @param {(fn: () => void, ms: number) => any} [deps.setInterval]
   * @param {(handle: any) => void} [deps.clearInterval]
   * @param {() => boolean} [deps.isDocumentHidden]
   * @param {{ addEventListener: Function, removeEventListener: Function }} [deps.eventTarget]
   */
  constructor({
    now = () => Date.now(),
    setInterval: setIntervalFn = (fn, ms) => setInterval(fn, ms),
    clearInterval: clearIntervalFn = (handle) => clearInterval(handle),
    isDocumentHidden = () => typeof document !== 'undefined' && document.hidden === true,
    eventTarget = typeof window !== 'undefined' ? window : null,
  } = {}) {
    this._now = now;
    this._setInterval = setIntervalFn;
    this._clearInterval = clearIntervalFn;
    this._isDocumentHidden = isDocumentHidden;
    this._eventTarget = eventTarget;

    /** @type {Set<FeedStateListener>} */
    this._subscribers = new Set();
    this._state = { visible: false };
    this._activeFeed = null;
    this._activeLabel = null;
    this._activeSourceId = null;
    this._refreshHandle = null;
    // LIVE FEEDS ONLY: when true, `kind: 'imagery'` feeds (GOES / Himawari
    // full-disk stills) are suppressed — only genuine live video (the ISS)
    // renders. The panel button drives this via {@link setLiveOnly}.
    this._liveOnly = false;

    this._onSelected = (event) => this._handleSubject(event && event.detail ? event.detail : null);
    this._onCleared = () => this._handleSubject(null);

    if (this._eventTarget) {
      this._eventTarget.addEventListener('gev:awareness-subject-selected', this._onSelected);
      this._eventTarget.addEventListener('gev:awareness-subject-cleared', this._onCleared);
    }
  }

  /**
   * @param {FeedStateListener} fn Invoked immediately with the current state,
   *   then on every change.
   * @returns {() => void} Unsubscribe.
   */
  subscribe(fn) {
    this._subscribers.add(fn);
    fn(this._state);
    return () => this._subscribers.delete(fn);
  }

  /** @returns {object} The last emitted state. */
  getState() {
    return this._state;
  }

  /**
   * Switch the ISS video between its named sources (panel NASA ⇄ 24/7 toggle).
   * No-op unless a video feed is active.
   * @param {string} sourceId
   * @returns {void}
   */
  setVideoSource(sourceId) {
    if (!this._activeFeed || this._activeFeed.kind !== 'video') return;
    this._activeSourceId = sourceId;
    this._emit(this._buildVideoState(this._activeFeed, sourceId, this._state.label));
  }

  /**
   * LIVE FEEDS ONLY toggle. When on, an `imagery` feed selected on the globe
   * renders a compact "hidden" notice instead of the full-disk still, and its
   * refresh interval is stopped. Re-applies to the current subject immediately.
   * @param {boolean} on
   * @returns {void}
   */
  setLiveOnly(on) {
    const next = !!on;
    if (next === this._liveOnly) return;
    this._liveOnly = next;
    if (this._activeFeed) this._applyActiveFeed();
    else this._emit({ visible: false });
  }

  /** @returns {boolean} Whether LIVE FEEDS ONLY is active. */
  isLiveOnly() {
    return this._liveOnly;
  }

  /** Tear down listeners and the refresh interval. */
  destroy() {
    this._stopRefresh();
    if (this._eventTarget) {
      this._eventTarget.removeEventListener('gev:awareness-subject-selected', this._onSelected);
      this._eventTarget.removeEventListener('gev:awareness-subject-cleared', this._onCleared);
    }
    this._subscribers.clear();
  }

  /**
   * @param {{ layerId?: string, id?: number|string, label?: string }|null} detail
   * @returns {void}
   */
  _handleSubject(detail) {
    const noradId = detail && detail.layerId === SATELLITES_LAYER_ID ? Number(detail.id) : null;
    const feed = noradId != null && hasSatelliteFeed(noradId) ? feedForNorad(noradId) : null;

    if (!feed) {
      this._stopRefresh();
      this._activeFeed = null;
      this._activeLabel = null;
      this._activeSourceId = null;
      this._emit({ visible: false });
      return;
    }

    this._activeFeed = feed;
    this._activeLabel = (detail && detail.label) || feed.name;
    this._activeSourceId = feed.kind === 'video' ? feed.defaultSourceId : null;
    this._applyActiveFeed();
  }

  /**
   * Emit the render state for {@link _activeFeed}, honouring {@link _liveOnly}.
   * Split out of `_handleSubject` so `setLiveOnly` can re-run it in place.
   * @returns {void}
   */
  _applyActiveFeed() {
    const feed = this._activeFeed;
    if (!feed) return;
    const label = this._activeLabel || feed.name;

    if (feed.kind === 'video') {
      this._stopRefresh();
      this._emit(this._buildVideoState(feed, this._activeSourceId, label));
      return;
    }

    if (this._liveOnly) {
      this._stopRefresh();
      this._emit(this._buildSuppressedState(feed, label));
      return;
    }

    this._emit(this._buildImageryState(feed, label));
    this._startRefresh(feed, label);
  }

  _buildVideoState(feed, sourceId, label) {
    const source = resolveFeedSource(feed, sourceId);
    return {
      visible: true,
      kind: 'video',
      liveOnly: this._liveOnly,
      noradId: feed.noradId,
      label: label || feed.name,
      mediaUrl: source.embedUrl,
      // Ordered candidate video ids for the panel's IFrame-API probe; it plays
      // the first that does not error.
      videoIds: Array.isArray(source.videoIds) ? [...source.videoIds] : [],
      watchUrl: source.watchUrl || null,
      attribution: source.attribution,
      note: source.note || feed.note || '',
      aspect: feed.aspect || '16 / 9',
      sources: feed.sources.map((s) => ({ id: s.id, label: s.label })),
      activeSourceId: source.id,
    };
  }

  _buildImageryState(feed, label) {
    return {
      visible: true,
      kind: 'imagery',
      liveOnly: this._liveOnly,
      noradId: feed.noradId,
      label: label || feed.name,
      mediaUrl: feed.frameUrl(this._now()),
      watchUrl: feed.watchUrl || null,
      attribution: feed.attribution,
      note: feed.note || '',
      aspect: feed.aspect || '1 / 1',
      refreshMs: feed.refreshMs,
      sources: [],
      activeSourceId: null,
    };
  }

  /**
   * State for an `imagery` feed while LIVE FEEDS ONLY is on: the panel shows a
   * short "hidden" notice, plays nothing, and starts no refresh interval.
   */
  _buildSuppressedState(feed, label) {
    const name = label || feed.name;
    return {
      visible: true,
      kind: 'imagery',
      suppressed: true,
      liveOnly: true,
      noradId: feed.noradId,
      label: name,
      mediaUrl: null,
      watchUrl: feed.watchUrl || null,
      attribution: feed.attribution,
      note: `${name} is full-disk imagery, not live video — hidden while LIVE FEEDS ONLY is on.`,
      aspect: feed.aspect || '1 / 1',
      sources: [],
      activeSourceId: null,
    };
  }

  _startRefresh(feed, label) {
    this._stopRefresh();
    if (!feed.refreshMs) return;
    this._refreshHandle = this._setInterval(() => {
      if (this._isDocumentHidden()) return;
      if (this._activeFeed !== feed) return;
      this._emit(this._buildImageryState(feed, label));
    }, feed.refreshMs);
  }

  _stopRefresh() {
    if (this._refreshHandle != null) {
      this._clearInterval(this._refreshHandle);
      this._refreshHandle = null;
    }
  }

  _emit(state) {
    this._state = state;
    for (const fn of this._subscribers) fn(state);
  }
}

export default SatelliteFeedController;
