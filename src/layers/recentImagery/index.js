/**
 * Recent Imagery layer: pick a box, list the last 30 days of HLS (Sentinel-2 /
 * Landsat) and VIIRS imagery that touch it, and drape the days the operator
 * pins. No polling — work happens when the box changes. Rendering, thumbnails
 * and the catalog are injected, so the state machine runs under `node:test`.
 *
 * The mode is explicit. IMAGE shows one pinned day (slot `a`); VS BASEMAP
 * swipes that day (left) against the basemap (right); A / B swipes day `a`
 * (left) against day `b` (right). While the mode's slot is empty the focused
 * day previews in it. Two draped layers at most, and while any image is on
 * the map it borrows the Esri surface on Google 3D, and keeps it: a manual
 * switch back to Google 3D while a day is shown is answered with a new lease;
 * the map controller's own fallback to Google 3D is not, so a failing Esri
 * map is never retried in a loop.
 */
import { searchHls } from './catalog.js';
import { NO_IMAGERY_HOST, resolveImageryHost } from '../../maps/imageryHost.js';
import {
  CATALOG_DAYS,
  PRODUCTS,
  boxCentre,
  boxFromPin,
  boxFromRectangle,
  boxSideKm,
  dequantizeBox,
  fitViewHeightM,
  formatCandidateReadout,
  parseCandidateKey,
  quantizeBox,
  rankLatest,
  shortDay,
  utcDay,
  validateBox,
  viewTooLargeMessage,
} from './model.js';

/**
 * Quiet time after the last arrow key before the focused day previews, so a
 * burst of key presses drapes only the day it lands on.
 */
export const FOCUS_DEBOUNCE_MS = 250;

/** Quiet time after the last divider move before the split is published. */
export const SPLIT_PUBLISH_MS = 400;

/** The three modes, in share-link order (`m` = index). */
export const MODES = Object.freeze(['image', 'basemap', 'ab']);

const COMPARISON_IN_USE = 'Comparison in use by another scene';
const COMPARISON_UNAVAILABLE = 'Esri map unavailable · no swipe';
const COMPARISON_NEEDS_GLOBE = 'Swipe needs a globe map';
const ESRI_KEPT = 'Imagery stays on Esri · CLEAR to use Google 3D';
/** ZOOM IN's flight time, in seconds. */
const ZOOM_FIT_SECONDS = 1.2;
const DEFAULT_SPLIT = 0.5;
const SLOT_IDS = ['a', 'b'];
const BOX_EDGES = ['west', 'south', 'east', 'north'];
const OTHER_SLOT = { a: 'b', b: 'a' };

const clampUnit = (value, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : fallback;
};
const boxSignature = (box) =>
  box ? BOX_EDGES.map((edge) => Number(box[edge]).toFixed(6)).join(',') : '';
const sourceOf = (product) => PRODUCTS[product]?.source || null;
const toDegrees = (radians) => (radians * 180) / Math.PI;
const toRadians = (degrees) => (degrees * Math.PI) / 180;
const ellipsoidOf = (viewer) =>
  viewer?.scene?.ellipsoid || viewer?.scene?.globe?.ellipsoid || null;

/**
 * The ground under the canvas centre, in degrees; null when the centre is
 * sky or the viewer cannot pick.
 * @param {object} viewer
 * @returns {{ lon: number, lat: number } | null}
 */
function viewCentre(viewer) {
  const ellipsoid = ellipsoidOf(viewer);
  const canvas = viewer?.scene?.canvas;
  const width = Number(canvas?.clientWidth);
  const height = Number(canvas?.clientHeight);
  if (!ellipsoid?.cartesianToCartographic || !(width > 0) || !(height > 0))
    return null;
  const hit = viewer.camera?.pickEllipsoid?.(
    { x: width / 2, y: height / 2 },
    ellipsoid,
  );
  const ground = hit ? ellipsoid.cartesianToCartographic(hit) : null;
  return ground
    ? { lon: toDegrees(ground.longitude), lat: toDegrees(ground.latitude) }
    : null;
}
const modeFrom = (value) =>
  MODES.includes(value)
    ? value
    : Number.isInteger(Number(value)) && value !== '' && value !== null
      ? MODES[Number(value)] || null
      : null;

/**
 * Create the layer.
 * @param {{ catalog?: { searchHls: Function }, renderer: object, thumbnails: object, host?: Function, now?: () => Date, days?: number, setTimeoutImpl?: Function, clearTimeoutImpl?: Function }} options
 */
export function createRecentImageryLayer({
  catalog = { searchHls },
  renderer,
  thumbnails,
  host = resolveImageryHost,
  now = () => new Date(),
  days = CATALOG_DAYS,
  setTimeoutImpl = (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeoutImpl = (id) => globalThis.clearTimeout(id),
} = {}) {
  let _viewer = null;
  let _tileset = null;
  let _mapStackController = null;
  let _dataManager = null;
  let _enabled = false;
  let _destroyed = false;
  let _applyingParams = false;

  let _box = null;
  /** The refusal notice; persists until the next successful box. */
  let _boxError = null;
  /** Where ZOOM IN flies for an oversized box or view (degrees), or null. */
  let _refusalTarget = null;
  let _candidates = [];
  let _truncated = false;
  let _catalogErrors = [];
  let _catalogError = null;
  let _searching = false;
  let _searchAbort = null;
  let _lastUpdate = null;

  const _sources = { hls: true, viirs: false };
  let _showUnavailable = false;
  let _focusKey = null;
  let _visible = { first: 0, last: 5 };

  let _mode = 'image';
  const _assigned = { a: null, b: null };
  /** The focused day shown while the mode's slot is empty. */
  let _previewKey = null;
  /** A preview armed by the arrow-key debounce: `{ key }`, key may be null. */
  let _pending = null;
  let _pendingTimer = null;
  /** A focused day still being probed: it previews once present. */
  let _followKey = null;
  let _auto = null;
  let _notice = null;
  let _split = DEFAULT_SPLIT;
  let _splitFromLink = false;
  let _splitTimer = null;
  let _swipeKind = 'none';
  /**
   * SWAP: the two sides of the divider traded (A right and B left, or the
   * image right of the basemap). Session-only: the share link never carries
   * it, and every new comparison starts unswapped.
   */
  let _swapped = false;
  let _alpha = 1;

  let _lease = null;
  let _leaseFromPhotoreal = false;
  /** The stack the lease switched to, once ready. */
  let _leaseStackId = null;
  /** The controller's switch generation right after the lease was taken. */
  let _leaseGeneration = null;
  /** The last switch generation answered with a new lease. */
  let _keptGeneration = null;
  /**
   * The lease was let go because the map controller fell back to Google 3D
   * on its own; the next manual switch to Google 3D may take Esri again.
   */
  let _droppedByFallback = false;
  let _releasing = null;
  let _comparisonReady = false;
  let _comparisonError = null;
  let _hostInfo = { collection: null, kind: 'none' };

  let _toolActive = false;
  let _toolHandler = null;
  let _rowListener = null;
  let _unsubscribeThumbnails = null;
  let _unsubscribeMap = null;
  const _listeners = new Set();

  const candidateFor = (key) =>
    (key && _candidates.find((candidate) => candidate.key === key)) || null;
  const sourceOn = (candidate) =>
    Boolean(candidate && _sources[sourceOf(candidate.product)]);

  /** Worldview's Data-Present header is the only proof a day has pixels. */
  const availability = (candidate) => {
    const status = thumbnails.get(candidate.key)?.status;
    return status === 'empty' || status === 'present'
      ? status
      : candidate.availability;
  };
  const withAvailability = (candidate) => ({
    ...candidate,
    availability: availability(candidate),
  });
  const drapable = (candidate) =>
    sourceOn(candidate) && availability(candidate) === 'present';

  const sourcedCandidates = () => _candidates.filter(sourceOn);
  /** Source-on candidates, minus confirmed-empty days unless asked for. */
  const stripList = () =>
    _showUnavailable
      ? sourcedCandidates()
      : sourcedCandidates().filter((c) => availability(c) !== 'empty');
  const focusIndexIn = (list) =>
    _focusKey ? list.findIndex((candidate) => candidate.key === _focusKey) : -1;

  /** The slot a pinned day occupies in the current mode, if any. */
  const activeSlotOf = (key) =>
    !key
      ? null
      : key === _assigned.a
        ? 'a'
        : _mode === 'ab' && key === _assigned.b
          ? 'b'
          : null;
  /** The slot a preview fills: the mode's first empty slot. */
  function previewSlot() {
    if (_mode !== 'ab') return _assigned.a ? null : 'a';
    if (!_assigned.a) return 'a';
    return _assigned.b ? null : 'b';
  }

  /** What the map shows: one key per renderer slot, and the swipe kind. */
  function plan() {
    const out = { a: null, b: null, preview: null, swipe: 'none' };
    if (!_enabled || !_box) return out;
    const live = (key) => (drapable(candidateFor(key)) ? key : null);
    out.a = live(_assigned.a);
    if (_mode === 'ab') out.b = live(_assigned.b);
    const slot = previewSlot();
    const preview =
      slot && !activeSlotOf(_previewKey) ? live(_previewKey) : null;
    if (preview) {
      out[slot] = preview;
      out.preview = slot;
    }
    if (_mode === 'basemap' && out.a) out.swipe = 'basemap';
    else if (_mode === 'ab' && out.a && out.b) out.swipe = 'ab';
    return out;
  }

  /**
   * Keep focus on the same day across probe results, source toggles and the
   * availability filter; when its card leaves the strip, move to the nearest
   * card still shown (ties go to the older day).
   */
  function reconcileFocus() {
    const list = stripList();
    if (!list.length) {
      _focusKey = null;
      return;
    }
    if (focusIndexIn(list) >= 0) return;
    const previous = _candidates.findIndex((c) => c.key === _focusKey);
    let best = list[0];
    if (previous >= 0) {
      let bestDistance = Infinity;
      for (const candidate of list) {
        const index = _candidates.indexOf(candidate);
        const distance = Math.abs(index - previous);
        if (
          distance < bestDistance ||
          (distance === bestDistance && index > previous)
        ) {
          best = candidate;
          bestDistance = distance;
        }
      }
    }
    _focusKey = best.key;
  }

  const rank = (list) =>
    rankLatest(list.map(withAvailability), { truncated: _truncated });

  /** Focus the START HERE day and preview it when the mode's slot is empty. */
  function autoPreview() {
    const ranked = rank(sourcedCandidates());
    if (!ranked.candidate) return;
    const key = ranked.candidate.key;
    if (!_focusKey) _focusKey = key;
    if (!previewSlot() || activeSlotOf(key)) return;
    _auto = { key, reason: ranked.reason, certain: ranked.certain };
    if (drapable(candidateFor(key))) _previewKey = key;
    else _followKey = key;
  }

  /**
   * A day whose probe came back empty leaves the map: JPEG products have no
   * alpha and would drape black "no data" tiles. A pinned day is unpinned and
   * an empty automatic preview is re-ranked.
   */
  function pruneEmpty() {
    let changed = false;
    for (const slotId of SLOT_IDS) {
      const pinned = candidateFor(_assigned[slotId]);
      if (pinned && availability(pinned) === 'empty') {
        _assigned[slotId] = null;
        changed = true;
      }
    }
    const preview = candidateFor(_previewKey);
    if (preview && availability(preview) === 'empty') {
      const wasAuto = _auto?.key === preview.key;
      _previewKey = null;
      _auto = null;
      changed = true;
      if (wasAuto) autoPreview();
    }
    // A followed day that turns out empty is dropped; an automatic one hands
    // over to the next ranked day.
    const followed = candidateFor(_followKey);
    if (followed && availability(followed) === 'empty') {
      const wasAuto = _auto?.key === followed.key;
      _followKey = null;
      if (wasAuto) {
        _auto = null;
        autoPreview();
      }
      changed = true;
    }
    return changed;
  }

  function notify(reason = 'state') {
    if (_destroyed) return;
    reconcileFocus();
    const snapshot = _listeners.size ? layer.getSnapshot() : null;
    for (const listener of [..._listeners]) {
      try {
        listener(snapshot, reason);
      } catch (error) {
        console.warn('[Data:RecentImagery] listener failed:', error);
      }
    }
    if (reason === 'state') _rowListener?.();
  }

  /**
   * Publish what a direct interaction changed, so the durable state and the
   * share link follow it. Never while applying params (a restore): a nested
   * intent would supersede the one being applied.
   */
  function publish(keys) {
    if (_applyingParams || _destroyed || !_dataManager?.adoptLayerParams)
      return;
    const params = layer.getParams();
    const picked = {};
    for (const key of keys) picked[key] = params[key];
    try {
      _dataManager.adoptLayerParams(layer.id, picked, { origin: 'user' });
    } catch (error) {
      console.warn('[Data:RecentImagery] publish failed:', error);
    }
  }

  function clearSplitTimer() {
    if (_splitTimer !== null) clearTimeoutImpl(_splitTimer);
    _splitTimer = null;
  }

  function syncHost() {
    const next = host({ viewer: _viewer, tileset: _tileset }) || {
      collection: null,
      kind: 'none',
    };
    const changed =
      next.collection !== _hostInfo.collection || next.kind !== _hostInfo.kind;
    _hostInfo = next;
    renderer.rebind(next);
    return changed;
  }

  /**
   * Hand the lease back. The release restores the map asynchronously; no new
   * lease is taken until it settles, and then the state is reconciled, so a
   * new image inside that window re-acquires.
   */
  function releaseComparison() {
    const lease = _lease;
    forgetLease();
    if (_notice === ESRI_KEPT) _notice = null;
    if (!lease) return;
    const releasing = Promise.resolve()
      .then(() => lease.release())
      .catch((error) => {
        console.warn('[Data:RecentImagery] comparison release failed:', error);
      })
      .then(() => {
        if (_releasing === releasing) _releasing = null;
        if (_destroyed) return;
        if (_enabled) syncRender();
        notify();
      });
    _releasing = releasing;
  }

  function forgetLease() {
    _droppedByFallback = false;
    _lease = null;
    _leaseFromPhotoreal = false;
    _leaseStackId = null;
    _leaseGeneration = null;
    _comparisonReady = false;
    _comparisonError = null;
  }

  function acquireComparison() {
    if (_lease || _releasing || _comparisonError || _comparisonReady) return;
    if (!_mapStackController?.acquireImageryComparison) {
      _comparisonReady = true;
      return;
    }
    const fromPhotoreal = _mapStackController.getActiveId?.() === 'photoreal';
    let lease;
    try {
      lease = _mapStackController.acquireImageryComparison({
        owner: 'recent-imagery',
        switchPolicy: 'esri-if-photoreal',
      });
    } catch {
      _comparisonError = COMPARISON_IN_USE;
      return;
    }
    _lease = lease;
    _leaseFromPhotoreal = fromPhotoreal;
    // Read after the lease issued its switch, so that switch is known as ours.
    _leaseGeneration = _mapStackController.getSwitchGeneration?.() ?? null;
    Promise.resolve(lease.ready)
      .catch(() => null)
      .then((result) => {
        if (_destroyed || _lease !== lease) return;
        if (result?.status === 'ready') {
          _comparisonReady = true;
          _leaseStackId = result.activeId ?? null;
        } else _comparisonError = COMPARISON_UNAVAILABLE;
        if (_enabled) syncRender({ comparison: false });
        notify();
      });
  }

  /**
   * While a day is shown the imagery keeps the Esri surface. A manual switch
   * (the operator's, not the lease's own) that lands on Google 3D is
   * answered at once with a new lease under the same policy; the old lease
   * no longer owns the map, so it lets go without a switch of its own, and
   * the new one remembers Google 3D for CLEAR. An automatic one (the
   * controller's fallback or recovery after Esri failed) is not retried: the
   * lease lets go, restoring nothing, and the days show without a swipe
   * until the operator switches to Google 3D by hand. Once per switch
   * generation, never while releasing (CLEAR and disable return to Google
   * 3D), and never without a lease to renew or one a fallback let go, so a
   * lease another owner holds stays refused.
   * @returns {boolean} Whether the lease was renewed, refused or let go.
   */
  function keepEsri() {
    const controller = _mapStackController;
    if (!_enabled || _destroyed || _releasing) return false;
    if (!_lease && !_droppedByFallback) return false;
    if (controller?.getActiveId?.() !== 'photoreal') return false;
    const shown = plan();
    if (!shown.a && !shown.b) return false;
    const generation = controller.getSwitchGeneration?.() ?? null;
    if (generation === _leaseGeneration || generation === _keptGeneration)
      return false;
    _keptGeneration = generation;
    const automatic = controller.getSwitchOrigin?.() === 'automatic';
    const previous = _lease;
    forgetLease();
    try {
      void previous?.release();
    } catch (error) {
      console.warn('[Data:RecentImagery] comparison release failed:', error);
    }
    if (automatic) {
      _droppedByFallback = true;
      _comparisonError = COMPARISON_UNAVAILABLE;
      if (_notice === ESRI_KEPT) _notice = null;
      return true;
    }
    acquireComparison();
    if (_lease) _notice = ESRI_KEPT;
    else if (_notice === ESRI_KEPT) _notice = null;
    return true;
  }

  /**
   * A settled stack switch (or, without a subscription, the stats poll):
   * rebind to the new host and keep the Esri surface.
   */
  function followMap() {
    if (_destroyed || !_enabled) return;
    const moved = syncHost();
    if (!keepEsri() && !moved) return;
    syncRender();
    notify();
  }

  const swipeGranted = () => _comparisonReady && !_comparisonError;
  /** Whether the divider is live for this plan: granted, on the globe. */
  const swipeLive = (shown) =>
    shown.swipe !== 'none' && swipeGranted() && _hostInfo.kind === 'globe';

  /**
   * Every new comparison starts unswapped with the divider centred, except
   * once for a split restored from a share link (the author's framing).
   * Scrubbing the second image inside a comparison keeps both as they are.
   */
  function trackSwipeStart(kind) {
    if (kind !== 'none' && kind !== _swipeKind) {
      _swapped = false;
      if (_splitFromLink) _splitFromLink = false;
      else if (_split !== DEFAULT_SPLIT) {
        _split = DEFAULT_SPLIT;
        clearSplitTimer();
        publish(['split']);
        notify('split');
      }
    }
    _swipeKind = kind;
  }

  function syncRender({ comparison = true } = {}) {
    if (_destroyed) return;
    syncHost();
    pruneEmpty();
    const shown = plan();
    trackSwipeStart(shown.swipe);
    const live = swipeLive(shown);
    for (const slotId of SLOT_IDS) {
      const candidate = candidateFor(shown[slotId]);
      if (candidate && _hostInfo.collection) {
        renderer.showSlot(slotId, candidate, _box, {
          alpha: _alpha,
          splitDirection: !live
            ? 'none'
            : (slotId === 'a') !== _swapped
              ? 'left'
              : 'right',
        });
      } else {
        renderer.hideSlot(slotId);
      }
    }
    if (!comparison) return;
    if (shown.a || shown.b) acquireComparison();
    else if (_lease || _comparisonReady || _comparisonError)
      releaseComparison();
  }

  /**
   * Probe the visible strip window, then the pinned and previewed days
   * wherever they sit: a pin restored or assigned off-screen never drapes
   * until its probe says present, so it goes at the focused card's priority.
   */
  function requestThumbnails() {
    if (!_enabled || !_box) return;
    const list = stripList();
    if (!list.length) return;
    reconcileFocus();
    thumbnails.requestOrdered(list, _box, {
      focusIndex: Math.max(0, focusIndexIn(list)),
      firstVisible: _visible.first,
      lastVisible: _visible.last,
      extra: 2,
    });
    for (const key of new Set([
      _assigned.a,
      _assigned.b,
      _previewKey,
      _followKey,
    ])) {
      const candidate = candidateFor(key);
      if (sourceOn(candidate)) thumbnails.request(candidate, _box, 0);
    }
  }

  function resetCatalog() {
    _candidates = [];
    _truncated = false;
    _catalogErrors = [];
    _catalogError = null;
    _auto = null;
  }

  function cancelSearch() {
    _searchAbort?.abort();
    _searchAbort = null;
    _searching = false;
  }

  async function runSearch() {
    cancelSearch();
    const abort = new AbortController();
    _searchAbort = abort;
    _searching = true;
    _catalogError = null;
    notify();
    try {
      const result = await catalog.searchHls({
        box: _box,
        days,
        now: now(),
        signal: abort.signal,
      });
      if (abort.signal.aborted) return;
      _candidates = result?.candidates || [];
      _truncated = Boolean(result?.truncated);
      _catalogErrors = result?.errors || [];
      _lastUpdate = Date.now();
      // Drop days the catalog no longer lists; start from a pinned day or
      // the recommended one.
      for (const slotId of SLOT_IDS)
        if (!candidateFor(_assigned[slotId])) _assigned[slotId] = null;
      _previewKey = null;
      _auto = null;
      _focusKey =
        [_assigned.a, _assigned.b].find((key) => activeSlotOf(key)) || null;
      if (!_focusKey) autoPreview();
    } catch (error) {
      if (abort.signal.aborted) return;
      resetCatalog();
      _catalogError = error?.message || 'Imagery catalog unavailable';
    } finally {
      if (_searchAbort === abort) {
        _searchAbort = null;
        _searching = false;
      }
    }
    syncRender();
    requestThumbnails();
    notify();
  }

  function clearPending() {
    if (_pendingTimer !== null) clearTimeoutImpl(_pendingTimer);
    _pendingTimer = null;
    _pending = null;
  }

  /** Make `key` (or nothing) the preview now. */
  function applyPreview(key) {
    clearPending();
    _followKey = null;
    if (key === _previewKey) return false;
    if (_auto?.key !== key) _auto = null;
    _previewKey = key;
    if (_enabled) syncRender();
    return true;
  }

  /** Arm the debounce for the focused day, or follow it until it is probed. */
  function schedulePreviewFromFocus() {
    clearPending();
    _followKey = null;
    const candidate = candidateFor(_focusKey);
    if (!candidate || !_enabled || !previewSlot()) return;
    // A pinned day is already on the map; focusing it takes the preview off.
    const key = activeSlotOf(candidate.key) ? null : candidate.key;
    if (key === _previewKey) return;
    if (key && !drapable(candidate)) {
      _followKey = key;
      return;
    }
    _pending = { key };
    _pendingTimer = setTimeoutImpl(() => {
      _pendingTimer = null;
      const pending = _pending;
      _pending = null;
      if (_destroyed || !pending) return;
      if (pending.key && !drapable(candidateFor(pending.key))) return;
      if (applyPreview(pending.key)) notify();
    }, FOCUS_DEBOUNCE_MS);
  }

  /**
   * @param {string} message
   * @param {{ lon: number, lat: number } | null} [target] Where ZOOM IN flies.
   */
  function refuseBox(message, target = null) {
    _boxError = message;
    _refusalTarget = target;
    notify();
    return false;
  }

  /** ZOOM IN applies to a box over the cap only: fly to its centre. */
  const oversizedCentre = (box) =>
    validateBox(box).reason === 'too-large' ? boxCentre(box) : null;

  function applyBox(box) {
    const result = validateBox(box);
    if (!result.ok) return refuseBox(result.message, oversizedCentre(box));
    _boxError = null;
    _refusalTarget = null;
    _notice = null;
    if (
      boxSignature(result.box) === boxSignature(_box) &&
      (_searching || _candidates.length)
    ) {
      notify();
      return true;
    }
    clearPending();
    _followKey = null;
    _previewKey = null;
    _box = result.box;
    thumbnails.clear();
    resetCatalog();
    _focusKey = null;
    if (_enabled) {
      // The old box's drapes come down now, not when the new search lands.
      syncRender();
      void runSearch();
    } else notify();
    return true;
  }

  /** A user-chosen box, published once accepted. */
  function chooseBox(box) {
    const accepted = applyBox(box);
    if (accepted) publish(BOX_EDGES);
    return accepted;
  }

  function guidance() {
    if (_enabled && _hostInfo.kind === 'none') return NO_IMAGERY_HOST;
    if (_comparisonError) return _comparisonError;
    if (
      _enabled &&
      plan().swipe !== 'none' &&
      swipeGranted() &&
      _hostInfo.kind === 'tileset'
    )
      return COMPARISON_NEEDS_GLOBE;
    return _catalogError;
  }

  function notes() {
    const out = [];
    if (_truncated) out.push('Catalog truncated · a newer clear day may exist');
    for (const error of _catalogErrors) {
      const label = PRODUCTS[error.product]?.label || error.product;
      out.push(`${label} catalog unavailable · ${error.message}`);
    }
    const today = utcDay(now());
    const viirsToday = candidateFor(`VIIRS:${today}`);
    if (viirsToday?.availability === 'unknown' && _sources.viirs)
      out.push('Daily overview for today may still be empty until the pass');
    return out;
  }

  function imageSnapshot(key) {
    const parsed = parseCandidateKey(key);
    const sourceOff = Boolean(parsed) && !_sources[sourceOf(parsed.product)];
    return {
      key: key || null,
      candidate: candidateFor(key),
      label: parsed
        ? `${shortDay(parsed.day)} · ${PRODUCTS[parsed.product].name} · ${PRODUCTS[parsed.product].resolutionM} m`
        : null,
      sourceOff,
      drapable: drapable(candidateFor(key)),
    };
  }

  function applySources(next) {
    let changed = false;
    for (const id of ['hls', 'viirs']) {
      if (next?.[id] == null || Boolean(next[id]) === _sources[id]) continue;
      _sources[id] = Boolean(next[id]);
      changed = true;
      const pending = candidateFor(_pending?.key);
      if (!_sources[id] && pending && sourceOf(pending.product) === id)
        clearPending();
    }
    return changed;
  }

  const layer = {
    id: 'recent-imagery',
    name: 'Recent Imagery',
    icon: '🛰',
    source: 'NASA GIBS · HLS + VIIRS',
    updateInterval: 0,

    init(viewer) {
      _viewer = viewer || null;
      return true;
    },

    enable(viewer) {
      if (_destroyed) return false;
      if (viewer) _viewer = viewer;
      _enabled = true;
      _comparisonError = null;
      _unsubscribeThumbnails?.();
      _unsubscribeThumbnails = thumbnails.subscribe(() => {
        // A probe can take a pinned day off the map or let a followed focus
        // preview; both change more than the cards, so a full notification
        // follows the thumbnail one.
        const pruned = pruneEmpty();
        if (pruned) syncRender();
        const followed =
          Boolean(_followKey) &&
          _followKey === _focusKey &&
          drapable(candidateFor(_followKey)) &&
          applyPreview(_followKey);
        // A pinned or previewed day that was still being probed drapes now.
        const shown = plan();
        const owned = renderer.getOwned?.() || {};
        const drapesChanged = SLOT_IDS.some(
          (slotId) => (owned[slotId]?.key || null) !== shown[slotId],
        );
        if (drapesChanged && !pruned && !followed) syncRender();
        notify('thumbnail');
        if (pruned || followed || drapesChanged) notify();
      });
      syncHost();
      if (_box && !_candidates.length) void runSearch();
      else {
        syncRender();
        requestThumbnails();
      }
      notify();
      return true;
    },

    disable() {
      cancelSearch();
      clearPending();
      _followKey = null;
      thumbnails.clear();
      _unsubscribeThumbnails?.();
      _unsubscribeThumbnails = null;
      _toolHandler?.();
      _toolActive = false;
      _enabled = false;
      resetCatalog();
      _previewKey = null;
      _swipeKind = 'none';
      for (const slotId of SLOT_IDS) renderer.hideSlot(slotId);
      releaseComparison();
      notify();
      return true;
    },

    /** No polling: candidates change with the box, not with the clock. */
    async update() {},

    destroy() {
      if (_destroyed) return;
      if (_enabled) this.disable();
      clearPending();
      clearSplitTimer();
      _unsubscribeMap?.();
      _unsubscribeMap = null;
      renderer.destroy();
      thumbnails.destroy();
      _listeners.clear();
      _rowListener = null;
      _toolHandler = null;
      _viewer = null;
      _tileset = null;
      _mapStackController = null;
      _dataManager = null;
      _destroyed = true;
    },

    /**
     * Keep the map controller for the Esri lease and hear every settled
     * stack switch, so the drapes move to the new host the moment it
     * changes, and a manual switch to Google 3D while a day is shown takes
     * Esri back, while an automatic fallback lets it go (`keepEsri`).
     * @param {object | null} controller
     */
    attachMapStackController(controller) {
      _unsubscribeMap?.();
      _unsubscribeMap = null;
      _mapStackController = controller || null;
      const off = controller?.subscribe?.(followMap);
      _unsubscribeMap = typeof off === 'function' ? off : null;
    },

    /** The layer manager, to publish direct interactions as params. */
    attachDataManager(manager) {
      _dataManager = manager || null;
    },

    /** The photoreal tileset, for draping while the globe is hidden. */
    attachTileset(tileset) {
      _tileset = tileset || null;
      if (_enabled && syncHost()) {
        syncRender();
        notify();
      }
    },

    /** The UI registers how the box tool is cancelled (CLEAR, disable). */
    setToolHandler(handler) {
      _toolHandler = typeof handler === 'function' ? handler : null;
    },

    /** The UI reports whether the box tool is live. */
    setToolActive(active) {
      if (Boolean(active) === _toolActive) return;
      _toolActive = Boolean(active);
      notify();
    },

    /**
     * Select a box; a refusal stays on the panel until a box succeeds.
     * @param {object} box Degrees box.
     * @returns {boolean}
     */
    setBox(box) {
      return chooseBox(box);
    },

    /**
     * The box tool refused a drag: keep its reason on the panel. With the
     * dragged box, an oversized drag offers ZOOM IN.
     * @param {string} message
     * @param {object} [box] Degrees box.
     */
    reportBoxRefusal(message, box = null) {
      const text = typeof message === 'string' ? message.trim() : '';
      if (!text) return false;
      refuseBox(text, box ? oversizedCentre(box) : null);
      return true;
    },

    /**
     * Use the camera's view rectangle as the box. A view wider than the cap
     * is refused with its size, never silently shrunk.
     * @param {object} [viewer]
     * @returns {boolean}
     */
    useCurrentView(viewer = _viewer) {
      const rectangle = viewer?.camera?.computeViewRectangle?.();
      if (!rectangle)
        return refuseBox('Point the camera at the ground to use the view');
      const box = boxFromRectangle(rectangle);
      if (validateBox(box).reason === 'too-large') {
        const { width, height } = boxSideKm(box);
        return refuseBox(
          viewTooLargeMessage(Math.max(width, height)),
          viewCentre(viewer) || boxCentre(box),
        );
      }
      return chooseBox(box);
    },

    /**
     * ZOOM IN: fly top-down to the refused box's or view's centre, at the
     * height whose view is about 400 km wide for this canvas and FOV.
     * @returns {number | null} The target height in metres, or null when
     * there is nothing to fit.
     */
    zoomToFit() {
      const target = _boxError ? _refusalTarget : null;
      const camera = _viewer?.camera;
      const ellipsoid = ellipsoidOf(_viewer);
      if (!target || !camera?.flyTo || !ellipsoid?.cartographicToCartesian)
        return null;
      const canvas = _viewer.scene?.canvas;
      const height = fitViewHeightM({
        width: canvas?.clientWidth,
        height: canvas?.clientHeight,
        fovy: camera.frustum?.fovy,
      });
      camera.flyTo({
        destination: ellipsoid.cartographicToCartesian({
          longitude: toRadians(target.lon),
          latitude: toRadians(target.lat),
          height,
        }),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
        duration: ZOOM_FIT_SECONDS,
      });
      return height;
    },

    /** A 10 km box centred on a point. */
    boxFromPinAt(lon, lat) {
      const box = boxFromPin(lon, lat);
      return box ? chooseBox(box) : refuseBox('That point cannot anchor a box');
    },

    /**
     * Move focus in the strip (index into the shown cards). While the mode's
     * slot is empty the focused day previews after `FOCUS_DEBOUNCE_MS`, once
     * it is probed present.
     * @param {number} index
     */
    focus(index) {
      const list = stripList();
      if (!list.length) return;
      const next = Math.max(
        0,
        Math.min(list.length - 1, Math.trunc(Number(index)) || 0),
      );
      if (list[next].key === _focusKey) return;
      _focusKey = list[next].key;
      schedulePreviewFromFocus();
      requestThumbnails();
      notify();
    },

    /** The strip reports which cards are on screen. */
    setVisibleRange(first, last) {
      const lo = Math.max(0, Math.trunc(Number(first)) || 0);
      const hi = Math.max(lo, Math.trunc(Number(last)) || lo);
      if (lo === _visible.first && hi === _visible.last) return;
      _visible = { first: lo, last: hi };
      requestThumbnails();
    },

    /**
     * Focus a day and preview it now (a card click). A day still being
     * probed is followed; an empty day never drapes and the previous preview
     * stays. With the mode's slots full the click only moves focus.
     * @param {string} key
     * @returns {boolean} Whether that day is now the preview.
     */
    preview(key) {
      const candidate = candidateFor(key);
      if (!sourceOn(candidate)) return false;
      if (stripList().includes(candidate)) _focusKey = candidate.key;
      if (!previewSlot() || !_enabled) {
        clearPending();
        _followKey = null;
        notify();
        return false;
      }
      if (activeSlotOf(candidate.key)) {
        applyPreview(null);
        notify();
        return false;
      }
      if (!drapable(candidate)) {
        clearPending();
        _followKey = availability(candidate) === 'empty' ? null : candidate.key;
        notify();
        return false;
      }
      applyPreview(candidate.key);
      notify();
      return true;
    },

    /**
     * Take the preview off the map (Escape). Pinned days stay.
     * @returns {boolean} Whether a preview was showing or on its way.
     */
    clearPreview() {
      const had = Boolean(_pending || _followKey || plan().preview);
      clearPending();
      _followKey = null;
      if (_previewKey) {
        _previewKey = null;
        _auto = null;
        if (_enabled) syncRender();
      }
      if (had) notify();
      return had;
    },

    /**
     * Pin a day in slot `a` or `b`, or unpin the slot with `null`. A day is
     * in one slot at most: pinning it in the other slot moves it. Empty days
     * cannot be pinned.
     * @param {'a'|'b'} slot
     * @param {string | null} key
     * @returns {boolean} Whether the pins changed.
     */
    setAssignment(slot, key) {
      if (!SLOT_IDS.includes(slot)) return false;
      let next = null;
      if (key != null) {
        const candidate = candidateFor(key);
        if (!sourceOn(candidate) || availability(candidate) === 'empty')
          return false;
        next = candidate.key;
        if (stripList().includes(candidate)) _focusKey = next;
      }
      if (_assigned[slot] === next) return false;
      if (next && _assigned[OTHER_SLOT[slot]] === next)
        _assigned[OTHER_SLOT[slot]] = null;
      _assigned[slot] = next;
      // The preview belonged to the old pins; the next focus move brings it back.
      clearPending();
      _followKey = null;
      _previewKey = null;
      _auto = null;
      if (_enabled) {
        syncRender();
        requestThumbnails();
      }
      publish(['a', 'b']);
      notify();
      return true;
    },

    /**
     * Pin `key` in `slot`, or unpin it when it is already there.
     * @param {'a'|'b'} slot
     * @param {string} key
     * @returns {boolean} Whether the pins changed.
     */
    toggleAssignment(slot, key) {
      return layer.setAssignment(slot, _assigned[slot] === key ? null : key);
    },

    /**
     * Switch the mode: `image`, `basemap` (the pinned day against the
     * basemap) or `ab` (two pinned days). Pins survive a mode switch; the
     * B pin only drapes in `ab`.
     * @param {'image'|'basemap'|'ab'} mode
     * @returns {boolean} Whether the mode changed.
     */
    setMode(mode) {
      const next = modeFrom(mode);
      if (!next || next === _mode) return false;
      _mode = next;
      clearPending();
      _followKey = null;
      if (_enabled) syncRender();
      publish(['mode']);
      notify();
      return true;
    },

    /**
     * Turn the source groups on or off. Off takes their cards and drapes
     * away and labels their pins "Source off"; on restores them.
     * @param {{ hls?: boolean, viirs?: boolean }} next
     * @returns {boolean} Whether anything changed.
     */
    setSources(next) {
      if (!applySources(next)) return false;
      if (_enabled) {
        syncRender();
        requestThumbnails();
      }
      notify();
      return true;
    },

    /** Show or hide confirmed-empty days in the strip. */
    setShowUnavailable(value) {
      if (Boolean(value) === _showUnavailable) return;
      _showUnavailable = Boolean(value);
      if (_enabled) requestThumbnails();
      notify();
    },

    /** Split position 0–1; the split control owns the scene write. */
    setSplit(value) {
      const next = clampUnit(value, _split);
      if (next === _split) return;
      _split = next;
      clearSplitTimer();
      _splitTimer = setTimeoutImpl(() => {
        _splitTimer = null;
        publish(['split']);
      }, SPLIT_PUBLISH_MS);
      notify('split');
    },

    /**
     * SWAP: trade the two sides of a live divider (A moves right and B left;
     * in VS BASEMAP the image moves right of the basemap). Again restores.
     * The divider position stays; nothing is published.
     * @returns {boolean} Whether a live swipe was swapped.
     */
    swapSides() {
      if (!_enabled || _destroyed || !swipeLive(plan())) return false;
      _swapped = !_swapped;
      syncRender({ comparison: false });
      notify();
      return true;
    },

    /** One opacity for both drapes. */
    setAlpha(value) {
      const next = clampUnit(value, _alpha);
      if (next === _alpha) return;
      _alpha = next;
      for (const slotId of SLOT_IDS) renderer.setAlpha(slotId, next);
      notify('alpha');
    },

    /**
     * Forget the box, the candidates, both pins, the preview and any pending
     * pick; reset opacity and split and cancel the box tool. Mode and
     * sources survive.
     */
    clear() {
      cancelSearch();
      clearPending();
      clearSplitTimer();
      _followKey = null;
      _toolHandler?.();
      thumbnails.clear();
      _box = null;
      _boxError = null;
      _refusalTarget = null;
      resetCatalog();
      _focusKey = null;
      _assigned.a = null;
      _assigned.b = null;
      _previewKey = null;
      _split = DEFAULT_SPLIT;
      _swapped = false;
      if (_alpha !== 1) {
        _alpha = 1;
        for (const slotId of SLOT_IDS) renderer.setAlpha(slotId, 1);
      }
      _notice = 'Box and images cleared';
      syncRender();
      publish([...BOX_EDGES, 'a', 'b', 'split']);
      notify();
    },

    /** Everything the panel renders. */
    getSnapshot() {
      reconcileFocus();
      const list = stripList();
      const focusIndex = Math.max(0, focusIndexIn(list));
      const ranked = rank(list);
      const shown = plan();
      const previewKey = shown.preview ? shown[shown.preview] : null;
      const pendingKey = _pending?.key || _followKey || null;
      // The focused day is its card's entry, so the readout sees the same
      // map and probe state the strip does.
      const candidates = list.map((candidate, index) => ({
        ...candidate,
        index,
        pinned:
          candidate.key === _assigned.a
            ? 'a'
            : candidate.key === _assigned.b
              ? 'b'
              : null,
        preview: candidate.key === previewKey,
        pending: candidate.key === pendingKey,
        drapable: drapable(candidate),
        thumbnail: thumbnails.get(candidate.key),
      }));
      const focus = candidates[focusIndex] || null;
      const comparing = swipeLive(shown);
      return {
        enabled: _enabled,
        box: _box,
        boxSizeKm: _box ? boxSideKm(_box) : null,
        boxError: _boxError,
        /** An oversized box or view: the panel offers ZOOM IN. */
        zoomToFit: Boolean(_boxError && _refusalTarget),
        searching: _searching,
        sources: { ..._sources },
        showUnavailable: _showUnavailable,
        hiddenCount: _showUnavailable
          ? 0
          : sourcedCandidates().length - list.length,
        candidates,
        focusIndex,
        focus,
        readout: focus ? formatCandidateReadout(focus, now()) : '',
        recommended: ranked.candidate
          ? { key: ranked.candidate.key, reason: ranked.reason }
          : null,
        mode: _mode,
        pins: { a: imageSnapshot(_assigned.a), b: imageSnapshot(_assigned.b) },
        preview: {
          ...imageSnapshot(previewKey),
          slot: shown.preview,
          pending: pendingKey,
        },
        shown: { a: shown.a, b: shown.b, swipe: shown.swipe },
        alpha: _alpha,
        split: _split,
        swapped: _swapped,
        comparison: {
          active: comparing,
          suspended:
            shown.swipe !== 'none' &&
            swipeGranted() &&
            _hostInfo.kind === 'tileset',
        },
        // Only while the borrowed map is still the one showing: an operator
        // who switched back by hand is not told the imagery is on Esri.
        borrowedEsri:
          Boolean(_lease) &&
          _comparisonReady &&
          _leaseFromPhotoreal &&
          _leaseStackId !== null &&
          _mapStackController?.getActiveId?.() === _leaseStackId,
        notes: notes(),
        auto: _auto,
        toolActive: _toolActive,
        error: guidance(),
        notice: _notice,
      };
    },

    /**
     * @param {(snapshot: object, reason: string) => void} listener
     * @returns {() => void}
     */
    subscribe(listener) {
      _listeners.add(listener);
      return () => _listeners.delete(listener);
    },

    /** The data-panel row carries the two source toggles only. */
    getRowControls() {
      return {
        chips: [
          {
            id: 'hls',
            label: 'MORE DETAIL · 30 m',
            active: _sources.hls,
            title: 'Sentinel-2 and Landsat via HLS, 30 m, every 2–6 days',
            params: { hls: !_sources.hls },
          },
          {
            id: 'viirs',
            label: 'DAILY OVERVIEW · 250 m',
            active: _sources.viirs,
            title:
              'VIIRS daily mosaic, 250 m, follows broad changes; little detail under 25 km',
            params: { viirs: !_sources.viirs },
          },
        ],
      };
    },

    setRowControlsListener(listener) {
      _rowListener = typeof listener === 'function' ? listener : null;
    },

    /**
     * Share-link and row-chip options: box edges as integers at degrees ×
     * 100000, the `a` and `b` pins, `mode` (0 image, 1 basemap, 2 A / B),
     * `split` percent, `hls` / `viirs` source toggles.
     * @param {object} params
     * @returns {boolean}
     */
    setParams(params) {
      if (!params || typeof params !== 'object') return false;
      _applyingParams = true;
      try {
        let changed = applySources(params);
        if (BOX_EDGES.every((edge) => params[edge] != null)) {
          const box = dequantizeBox(params);
          if (box) applyBox(box);
        }
        // Read before the pins so a link's framing is in place when its
        // comparison first renders. Local storage never keeps the split, so
        // only a non-default value can have come from a link.
        if (params.split != null && Number.isFinite(Number(params.split))) {
          _split = clampUnit(Number(params.split) / 100, _split);
          _splitFromLink = _split !== DEFAULT_SPLIT;
        }
        const mode = params.mode == null ? null : modeFrom(params.mode);
        if (mode && mode !== _mode) {
          _mode = mode;
          changed = true;
        }
        if ('a' in params || 'b' in params) {
          clearPending();
          _followKey = null;
          for (const slotId of SLOT_IDS) {
            if (slotId in params)
              _assigned[slotId] = parseCandidateKey(params[slotId])
                ? params[slotId]
                : null;
          }
          if (_assigned.a && _assigned.a === _assigned.b) _assigned.b = null;
          _previewKey = null;
          _auto = null;
          const pinned = _assigned.a || _assigned.b;
          if (pinned && candidateFor(pinned)) _focusKey = pinned;
          changed = true;
        }
        if (changed && _enabled) {
          syncRender();
          requestThumbnails();
        }
        notify();
        return true;
      } finally {
        _applyingParams = false;
      }
    },

    getParams() {
      const quantized = quantizeBox(_box);
      return {
        west: quantized?.west ?? null,
        south: quantized?.south ?? null,
        east: quantized?.east ?? null,
        north: quantized?.north ?? null,
        a: _assigned.a,
        b: _assigned.b,
        mode: MODES.indexOf(_mode),
        split: Math.round(_split * 100),
        viirs: _sources.viirs,
      };
    },

    getStats() {
      // Without a controller subscription the stats poll is the only steady
      // heartbeat, so it doubles as the map-stack watch.
      if (!_unsubscribeMap) followMap();
      return {
        count: _candidates.length,
        lastUpdate: _lastUpdate,
        error: guidance(),
      };
    },

    /** Renderer, host and lease state for tests and the live gate. */
    diagnostics() {
      const shown = plan();
      return {
        host: _hostInfo.kind,
        ownedCount: renderer.ownedCount(),
        lease: Boolean(_lease),
        releasing: Boolean(_releasing),
        mode: _mode,
        pins: { ..._assigned },
        preview: _previewKey,
        shown,
        pending: _pending ? _pending.key : undefined,
        following: _followKey,
        splitFromLink: _splitFromLink,
      };
    },
  };
  return layer;
}
