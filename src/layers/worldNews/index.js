import * as Cesium from 'cesium';
import {
  DEFAULT_RETENTION_MS,
  KEY_ID,
  LAYER_ICON,
  LAYER_ID,
  LAYER_NAME,
  MAX_RENDERED_PLACES,
  REFRESH_INTERVAL_MS,
  SOURCE_LABEL,
  TONE_COLORS,
  WORLD_NEWS_OVERLAY_SOURCE_ID,
} from './policy.js';
import {
  mergeBatchArticles,
  retainWithinWindow,
} from '../../data/worldNewsArticles.js';
import {
  aggregatePlaces,
  collapseSyndicated,
  formatAge,
  formatAgoMinutes,
  mapAnalystRecord,
  toneBand,
} from './model.js';
import { createWorldNewsPresentation } from './presentation.js';
import {
  describeNewsRegion,
  NEWS_REGION_MAX_RADIUS_KM,
} from '../../data/worldNewsRegion.js';
import { resolveViewerRegion, watchCameraSettle } from './viewport.js';
export * from './model.js';
export * from './policy.js';
export { createWorldNewsSource } from './source.js';

/** Proxy `blocked` codes the row can name; anything else reads as an error. */
const BLOCKED_LABELS = Object.freeze({
  // `budget` is THIS install's own daily cap, not the provider's plan — see
  // blockedLabel(), which fills in both numbers. `quota` is the provider
  // actually refusing (HTTP 402); only that one means the plan is spent.
  budget: 'LOCAL DAILY CAP REACHED',
  quota: 'PROVIDER QUOTA EXHAUSTED · resets 00:00 UTC',
  rate_limited: 'RATE LIMITED',
  bad_key: 'INVALID KEY',
  upstream: 'UPSTREAM UNAVAILABLE',
  region_rate: 'VIEW FETCHES SPENT · resets hourly',
  region_off: 'VIEW FETCHING OFF',
});

/**
 * Region failures that will not fix themselves on the next tick, so the pinned
 * circle is dropped rather than retried every refresh: the server has view
 * fetching switched off, or it rejected the circle outright.
 */
const PERMANENT_REGION_FAILURES = Object.freeze(['region_off', 'bad_region']);

/**
 * Failures that concern only the view circle. They are reported on the chip,
 * never as a layer block: the worldwide feed is unaffected by all of them.
 */
const REGION_ONLY_FAILURES = Object.freeze([
  'region_off',
  'bad_region',
  'region_rate',
]);

const TONE_LEGEND = Object.freeze([
  { band: 'negative', label: 'Negative tone' },
  { band: 'neutral', label: 'Neutral tone' },
  { band: 'positive', label: 'Positive tone' },
]);

const LEGEND_BLURB =
  "Pins sit at the place named in the headline, not where the article was published. Tone is the provider's sentiment score for the article text.";

/**
 * Own one World News display and its refresh lifecycle.
 * A source resolves `{ keyRequired: true }` while the proxy has no key, or a
 * validated snapshot `{ rows, fetchedAt, stale, blocked, budget, quota,
 * requested, unplacedCount, morePagesLeft, costPerRequest }`.
 *
 * update() returns false ONLY when the request was superseded or aborted:
 * the manager reverts an enable whose first update returns false, so a
 * keyless proxy or an upstream fault sets state (surfaced by getStats())
 * and returns true instead of turning the toggle back off.
 */
export function createWorldNewsLayer({
  source,
  services,
  overlayHost,
  credit = null,
  openArticle = (url) => globalThis.open?.(url, '_blank', 'noopener'),
  screenSpaceEventHandlerFactory,
  /** Injectable clock; retention is the one thing here that turns on real time. */
  clock = () => Date.now(),
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('World News requires a snapshot source');
  if (!overlayHost) throw new TypeError('World News requires an overlay host');
  if (!services?.context || !services?.picking || !services?.render)
    throw new TypeError(
      'World News requires context, picking and render services',
    );
  const { governorRequestRender } = services.render;
  const { registerPickOwner, unregisterPickOwner } = services.picking;

  const state = {
    viewer: null,
    dataSource: null,
    clickHandler: null,
    enabled: false,
    loading: false,
    keyRequired: false,
    stale: false,
    blocked: null,
    budget: null,
    quota: null,
    error: null,
    /** LOAD MORE failure text; the base feed row stays honest on its own. */
    moreError: null,
    /** NEWS IN VIEW failure text, kept off the base feed row for the same reason. */
    regionError: null,
    /**
     * Every batch still on the map, as `{at, articles, region}`, oldest first.
     * A fetch ADDS one — views and the worldwide feed accumulate, so asking
     * about a second city never wipes the first. Only three things remove a
     * pin: the provider's retention window, the render cap, and CLEAR PINS.
     */
    batches: [],
    /** Retention window the proxy declares; see DEFAULT_RETENTION_MS. */
    retentionMs: DEFAULT_RETENTION_MS,
    /**
     * What the ten-minute refresh re-asks for: a circle, or null for the
     * worldwide feed. The last successful fetch sets it. It is NOT "what the
     * map shows" — the map shows everything that has not aged out.
     */
    refreshTarget: null,
    regionFetchesLeft: null,
    /** Disposer for the camera-settle listener that repaints the chip. */
    cameraWatch: null,
    /** Data age (proxy fetchedAt), not response age. */
    lastUpdate: null,
    rows: [],
    groups: [],
    groupById: new Map(),
    selectedId: null,
    storyIndex: 0,
    request: null,
    morePagesLeft: 0,
    costPerRequest: null,
    costMeasured: false,
    requested: 0,
    unplacedCount: 0,
    creditRegistered: false,
    rowControlsListener: null,
  };
  const {
    renderPlaces,
    selectPlace,
    nextStory,
    prevStory,
    clearSelection,
    clearRendered,
    installInteraction,
    destroyInteraction,
    notifyRowControls,
    selectedGroup,
  } = createWorldNewsPresentation({
    state,
    services,
    overlayHost,
    screenSpaceEventHandlerFactory,
    // Declared below and hoisted: clicking the card opens the story it shows.
    onCardActivate: () => openSelectedArticle(),
  });

  function selectedStory() {
    const group = selectedGroup();
    return group ? group.articles[state.storyIndex] || group.articles[0] : null;
  }

  function resetData() {
    state.rows = [];
    state.groups = [];
    state.groupById = new Map();
    state.selectedId = null;
    state.storyIndex = 0;
    state.lastUpdate = null;
    state.error = null;
    state.moreError = null;
    state.regionError = null;
    state.batches = [];
    state.retentionMs = DEFAULT_RETENTION_MS;
    state.refreshTarget = null;
    state.regionFetchesLeft = null;
    state.stale = false;
    state.blocked = null;
    state.budget = null;
    state.quota = null;
    state.keyRequired = false;
    state.requested = 0;
    state.unplacedCount = 0;
    state.morePagesLeft = 0;
    state.costPerRequest = null;
    state.costMeasured = false;
  }

  /**
   * Add one fetched batch to the map and return the headlines now on it.
   *
   * Batches accumulate, so a second view never wipes the first. Two things
   * bound that: the same one-hour retention window the proxy enforces (the
   * provider's terms cap caching there, and a browser holding pins longer
   * would break the promise the server keeps), and de-duplication by article
   * id, so refetching an overlapping circle re-dates a headline instead of
   * doubling it.
   *
   * @param {object} snapshot Validated proxy snapshot.
   * @returns {Array<object>} Merged rows, newest first.
   */
  function admitBatch(snapshot) {
    const now = clock();
    // Dated by when the BROWSER received it, not by the proxy's `fetchedAt`.
    // The two agree whenever the clocks do, and when they do not — a browser
    // clock off by hours is ordinary — receipt time still bounds how long a
    // pin lives, where proxy time would silently blank the whole map.
    // Either way this is stricter than the layer used to be: before the map
    // accumulated, rows simply stayed until a fetch replaced them.
    state.batches = retainWithinWindow(
      [
        ...state.batches,
        { at: now, articles: snapshot.rows, region: snapshot.region ?? null },
      ],
      now,
      state.retentionMs,
    );
    // After the merge, not per batch: a syndicated copy often arrives in a
    // different fetch (the worldwide feed, then a view) from the one it
    // duplicates. The batches keep every copy, so if the representative ages
    // out the next admission promotes a surviving one.
    return collapseSyndicated(mergeBatchArticles(state.batches));
  }

  /**
   * What the pins currently on the map cover: the worldwide feed, a set of
   * distinct circles, or both. Derived from the retained batches, so it stays
   * true as they age out.
   * @returns {{global: boolean, regions: Array<object>}}
   */
  function mapScope() {
    const regions = new Map();
    let global = false;
    for (const batch of state.batches) {
      if (batch.region)
        regions.set(
          batch.region.key ?? describeNewsRegion(batch.region),
          batch.region,
        );
      else global = true;
    }
    return { global, regions: [...regions.values()] };
  }

  /** Operator-facing phrase for what the map holds, following a row count. */
  function describeScope() {
    const { global, regions } = mapScope();
    if (!regions.length) return 'latest headlines';
    if (!global && regions.length === 1)
      return `headlines ${describeNewsRegion(regions[0])}`;
    const views = `${regions.length} view${regions.length === 1 ? '' : 's'}`;
    return global
      ? `headlines from the worldwide feed and ${views}`
      : `headlines from ${views}`;
  }

  function applySnapshot(snapshot) {
    state.keyRequired = false;
    state.error = null;
    state.moreError = null;
    state.regionError = null;
    // The payload names the feed it came from, so the refresh follows the last
    // thing actually fetched without anyone having to remember to set it.
    state.refreshTarget = snapshot.region ?? null;
    state.regionFetchesLeft = Number.isFinite(snapshot.regionFetchesLeft)
      ? snapshot.regionFetchesLeft
      : null;
    if (Number.isFinite(snapshot.retentionMs) && snapshot.retentionMs > 0)
      state.retentionMs = snapshot.retentionMs;
    state.rows = admitBatch(snapshot);
    state.stale = snapshot.stale === true;
    state.blocked = snapshot.blocked ?? null;
    state.budget = snapshot.budget ?? null;
    state.quota = snapshot.quota ?? null;
    state.requested = Number.isFinite(snapshot.requested)
      ? snapshot.requested
      : snapshot.rows.length;
    state.unplacedCount = Number.isFinite(snapshot.unplacedCount)
      ? snapshot.unplacedCount
      : 0;
    state.morePagesLeft = Number.isFinite(snapshot.morePagesLeft)
      ? snapshot.morePagesLeft
      : 0;
    state.costPerRequest = Number.isFinite(snapshot.costPerRequest)
      ? snapshot.costPerRequest
      : null;
    state.costMeasured =
      snapshot.costMeasured === true && state.costPerRequest !== null;
    // Data age, not response age: a stale proxy payload truthfully reads old.
    state.lastUpdate = Number.isFinite(snapshot.fetchedAt)
      ? snapshot.fetchedAt
      : Date.now();
    // Everything retained, not just this batch: the map is cumulative.
    const groups = aggregatePlaces(state.rows).slice(0, MAX_RENDERED_PLACES);
    state.groups = groups;
    state.groupById = new Map(groups.map((group) => [group.id, group]));
    renderPlaces(Date.now());
    if (credit && state.rows.length && !state.creditRegistered) {
      state.creditRegistered =
        services.credits?.register?.(state.viewer, credit) !== false;
    }
    console.log(
      `[Data:WorldNews] +${snapshot.rows.length} from ${describeNewsRegion(snapshot.region ?? null)} → ${state.rows.length} headlines at ${groups.length} places`,
    );
  }

  function applyKeyless() {
    state.keyRequired = true;
    state.error = null;
    state.moreError = null;
    state.regionError = null;
    state.batches = [];
    state.refreshTarget = null;
    state.regionFetchesLeft = null;
    state.stale = false;
    state.blocked = null;
    state.rows = [];
    state.groups = [];
    state.groupById = new Map();
    state.morePagesLeft = 0;
    renderPlaces(Date.now());
  }

  function superseded(request) {
    return (
      request.signal.aborted || state.request !== request || !state.enabled
    );
  }

  /**
   * Run one request against the source; `kind` decides how a failure lands.
   * A refresh failure degrades the row (previous rows stay); a LOAD MORE
   * failure only explains itself on the chip, since the base feed is intact.
   */
  async function load(fetcher, kind, externalSignal = null) {
    state.request?.abort();
    const request = new AbortController();
    const forward = () => request.abort();
    if (externalSignal?.aborted) forward();
    else externalSignal?.addEventListener('abort', forward, { once: true });
    state.request = request;
    state.loading = true;
    notifyRowControls();
    governorRequestRender('world-news');
    try {
      const snapshot = await fetcher(request.signal);
      if (superseded(request)) return false;
      if (snapshot?.keyRequired) applyKeyless();
      else applySnapshot(snapshot);
      return true;
    } catch (error) {
      if (error?.name === 'AbortError' || superseded(request)) return false;
      console.warn(`[Data:WorldNews] ${kind} failed:`, error);
      const code = error?.code;
      const message = error?.message || 'World News unavailable';
      if (kind === 'refresh') {
        state.error = message;
        if (BLOCKED_LABELS[code]) state.blocked = code;
      } else if (kind === 'region') {
        state.regionError = message;
        if (code === 'region_rate') state.regionFetchesLeft = 0;
        // A circle this server will never serve is unpinned, or every refresh
        // from here on would re-ask for it and re-fail.
        if (PERMANENT_REGION_FAILURES.includes(code))
          state.refreshTarget = null;
        // Only an account-wide fault blocks the layer. The view-specific codes
        // leave the worldwide feed perfectly usable, so they stay on the chip
        // instead of greying out the whole row.
        if (BLOCKED_LABELS[code] && !REGION_ONLY_FAILURES.includes(code))
          state.blocked = code;
      } else {
        state.moreError = message;
        if (code === 'pages') state.morePagesLeft = 0;
        else if (BLOCKED_LABELS[code]) state.blocked = code;
      }
      return true;
    } finally {
      externalSignal?.removeEventListener('abort', forward);
      if (state.request === request) {
        state.request = null;
        state.loading = false;
        notifyRowControls();
        governorRequestRender('world-news');
      }
    }
  }

  function canLoadMore() {
    return (
      state.enabled &&
      !state.loading &&
      !state.keyRequired &&
      !state.blocked &&
      state.morePagesLeft > 0
    );
  }

  function openSelectedArticle() {
    const story = selectedStory();
    if (!story?.url) return false;
    openArticle(story.url);
    return true;
  }

  /**
   * Human label for a `blocked` code.
   *
   * `budget` gets both numbers spelled out. It is this install's own daily
   * spending cap (`WORLD_NEWS_DAILY_POINT_BUDGET`), NOT the provider's plan,
   * and the bare words "BUDGET REACHED" over an UNAVAILABLE row read as "the
   * provider cut you off" — reported 2026-09-22 against a plan that still had
   * 420 of 1000 points left. Naming the cap, the count and what the provider
   * actually reports makes the difference impossible to miss, and says which
   * knob to turn.
   *
   * @param {string|null} code Proxy blocked code.
   * @returns {string}
   */
  function blockedLabel(code) {
    if (!code) return '';
    if (code !== 'budget')
      return BLOCKED_LABELS[code] || String(code).toUpperCase();
    const spent = state.budget?.spent;
    const limit = state.budget?.limit;
    const left = state.quota?.left;
    const counts =
      Number.isFinite(spent) && Number.isFinite(limit)
        ? ` ${spent}/${limit} points`
        : '';
    const provider = Number.isFinite(left)
      ? ` · provider quota still has ${left}`
      : '';
    return `${BLOCKED_LABELS.budget}${counts}${provider} · raise WORLD_NEWS_DAILY_POINT_BUDGET`;
  }

  function budgetLine() {
    const cost = state.costPerRequest ?? 2;
    const spent = state.budget?.spent ?? 0;
    const limit = state.budget?.limit ?? '?';
    // The provider documents 1 point + 0.01 per result; without an
    // X-API-Quota-Request header on the last response that is all we know.
    const costNote = state.costMeasured ? '' : ' (estimate)';
    return `1 request ≈ ${cost} points${costNote} of today's budget (${spent}/${limit} used)`;
  }

  function loadMoreTitle() {
    const budget = budgetLine();
    if (state.keyRequired) return 'Add a World News API key to load headlines';
    if (state.blocked) return `${blockedLabel(state.blocked)} · ${budget}`;
    if (state.moreError) return `${state.moreError} · ${budget}`;
    // A view batch is one page by construction (the proxy sends morePagesLeft
    // 0 for every region), which is not the same thing as an hour spent.
    if (state.refreshTarget)
      return `A view is a single page — fetch the worldwide feed to page further · ${budget}`;
    if (state.morePagesLeft <= 0)
      return `No extra pages left this hour · ${budget}`;
    return `Fetch one more page of headlines (${state.morePagesLeft} left this hour) · ${budget}`;
  }

  /**
   * The circle the camera frames right now, re-read on demand.
   * A camera read can throw on a degenerate scene; that reads as "no usable
   * circle", which disables the chip rather than breaking the whole panel.
   */
  function viewRegion() {
    if (!state.viewer) return null;
    try {
      return resolveViewerRegion(state.viewer);
    } catch (error) {
      console.warn('[Data:WorldNews] view region unavailable:', error);
      return null;
    }
  }

  function canFetchRegion(region) {
    return (
      canFetchGlobal() &&
      region?.band === 'local' &&
      typeof source.getRegionSnapshot === 'function'
    );
  }

  function canFetchGlobal() {
    return (
      state.enabled && !state.loading && !state.keyRequired && !state.blocked
    );
  }

  function newsInViewTitle(region) {
    const budget = budgetLine();
    if (state.keyRequired) return 'Add a World News API key to fetch headlines';
    if (state.blocked) return `${blockedLabel(state.blocked)} · ${budget}`;
    if (state.regionError) return `${state.regionError} · ${budget}`;
    // The provider matches a geocoded CENTROID inside a circle capped at
    // 100 km, so a continental view has no circle that covers it. Saying so
    // is kinder than a greyed-out chip with no reason.
    if (region?.band !== 'local')
      return `Zoom in to a city first — a news circle is capped at ${NEWS_REGION_MAX_RADIUS_KM} km across the ground, and this view is wider · ${budget}`;
    const left = Number.isFinite(state.regionFetchesLeft)
      ? ` (${state.regionFetchesLeft} left this hour)`
      : '';
    return `Fetch the headlines ${describeNewsRegion(region)}${left} · ${budget}`;
  }

  function globalFeedTitle() {
    const budget = budgetLine();
    if (state.keyRequired) return 'Add a World News API key to fetch headlines';
    if (state.blocked) return `${blockedLabel(state.blocked)} · ${budget}`;
    // Additive, exactly like NEWS IN VIEW: the worldwide feed joins whatever
    // views are already pinned instead of replacing them.
    return `Add the latest worldwide headlines to the map · ${budget}`;
  }

  function clearPinsTitle() {
    if (!state.rows.length) return 'No headline pins to clear';
    // describeNewsRegion answers "whole earth" for no circle, which reads
    // oddly as the object of "adds ... again".
    const next = state.refreshTarget
      ? `the headlines ${describeNewsRegion(state.refreshTarget)}`
      : 'the worldwide feed';
    return `Remove all ${state.rows.length} headline pins from the map. The layer is live, so the next refresh adds ${next} again.`;
  }

  const layer = {
    id: LAYER_ID,
    name: LAYER_NAME,
    icon: LAYER_ICON,
    source: SOURCE_LABEL,
    // The proxy answers 503 {error:'no_key'} without a World News key; the
    // key registry names the variable, so the row can say which key.
    requiresKeyId: KEY_ID,
    updateInterval: REFRESH_INTERVAL_MS,

    init(viewer) {
      if (state.viewer)
        throw new Error('World News layer is already initialized');
      state.viewer = viewer;
      state.dataSource = new Cesium.CustomDataSource('world-news');
      state.dataSource.show = false;
      viewer.dataSources.add(state.dataSource);
      overlayHost.setVisible(WORLD_NEWS_OVERLAY_SOURCE_ID, false);
      installInteraction(viewer);
      // NEWS IN VIEW is enabled or not depending on how wide the view is, but
      // the layer panel only repaints on layer status changes. Without this
      // the chip would stay greyed out after the operator zoomed in far
      // enough to use it.
      state.cameraWatch = watchCameraSettle(viewer, () => {
        if (state.enabled) notifyRowControls();
      });
      console.log('[Data:WorldNews] Initialized');
    },

    enable() {
      if (state.enabled) return;
      state.enabled = true;
      registerPickOwner(LAYER_ID, (id) => state.groupById.has(id));
      if (state.dataSource) state.dataSource.show = true;
      overlayHost.setVisible(WORLD_NEWS_OVERLAY_SOURCE_ID, true);
      notifyRowControls();
      // DataLayerManager calls update() right after enable(); it owns the first fetch.
    },

    disable() {
      state.request?.abort();
      state.request = null;
      state.loading = false;
      state.enabled = false;
      clearSelection();
      unregisterPickOwner(LAYER_ID);
      if (state.dataSource) state.dataSource.show = false;
      clearRendered();
      overlayHost.setVisible(WORLD_NEWS_OVERLAY_SOURCE_ID, false);
      resetData();
      notifyRowControls();
      governorRequestRender('world-news');
    },

    update(viewer, { signal = null } = {}) {
      if (!state.enabled || !state.dataSource) return Promise.resolve(false);
      // A pinned circle is re-asked for rather than quietly replaced by the
      // worldwide feed — and it is re-asked for as PINNED, not re-derived from
      // wherever the camera has drifted to since, which would spend budget the
      // operator never asked to spend. Within the proxy's TTL this is a cache
      // hit and costs nothing.
      const region = state.refreshTarget;
      if (region && typeof source.getRegionSnapshot === 'function')
        return load(
          (requestSignal) =>
            source.getRegionSnapshot({ region, signal: requestSignal }),
          'region',
          signal,
        );
      return load(
        (requestSignal) => source.getSnapshot({ signal: requestSignal }),
        'refresh',
        signal,
      );
    },

    /** LOAD MORE chip: one extra page, merged like a refresh. */
    loadMore() {
      if (!canLoadMore() || typeof source.loadMore !== 'function')
        return Promise.resolve(false);
      return load(
        (requestSignal) => source.loadMore({ signal: requestSignal }),
        'more',
      );
    },

    /**
     * NEWS IN VIEW chip: replace the shown batch with one page filtered to the
     * circle the camera frames, and pin it so refreshes keep it.
     * @returns {Promise<boolean>} False when the view has no usable circle.
     */
    fetchViewRegion() {
      const region = viewRegion();
      if (!canFetchRegion(region)) return Promise.resolve(false);
      return load(
        (requestSignal) =>
          source.getRegionSnapshot({ region, signal: requestSignal }),
        'region',
      );
    },

    /**
     * GLOBAL FEED chip: add the worldwide newest-first feed to the map. It
     * merges with whatever views are pinned rather than replacing them, and it
     * points the refresh back at the worldwide feed.
     * @returns {Promise<boolean>} False when busy or unavailable.
     */
    showGlobalFeed() {
      if (!canFetchGlobal()) return Promise.resolve(false);
      return load(
        (requestSignal) => source.getSnapshot({ signal: requestSignal }),
        'refresh',
      );
    },

    /**
     * CLEAR PINS chip: take every headline off the map. The only control that
     * removes a pin — every fetch adds. Purely local: nothing is requested and
     * no budget is spent, and the next refresh will repopulate from the live
     * feed, which is what a live layer does.
     * @returns {boolean} False when there was nothing to clear.
     */
    clearPins() {
      if (!state.enabled || !state.batches.length) return false;
      state.batches = [];
      state.rows = [];
      state.groups = [];
      state.groupById = new Map();
      // Without this the row would read "empty" as though the feed had come
      // back with nothing, which is a different fact about the world.
      state.lastUpdate = null;
      // renderPlaces settles the selection itself, and evicts rather than
      // deselects when the selected place is no longer on the map — which is
      // exactly what just happened to every one of them.
      renderPlaces(Date.now());
      notifyRowControls();
      governorRequestRender('world-news');
      console.log('[Data:WorldNews] Pins cleared');
      return true;
    },

    destroy(viewer = state.viewer) {
      layer.disable();
      destroyInteraction();
      state.cameraWatch?.();
      state.cameraWatch = null;
      if (state.dataSource && viewer)
        viewer.dataSources.remove(state.dataSource, true);
      state.dataSource = null;
      state.viewer = null;
      state.creditRegistered = false;
      resetData();
    },

    selectPlace,
    nextStory,
    prevStory,
    clearSelection,

    /**
     * Snapshot the loaded headline rows as plain JSON-safe objects for the
     * analyst query engine. On-demand only — zero per-frame cost.
     * @param {number} [maxCount=500] Maximum records to return (truncation).
     * @returns {Array<Object>} See mapAnalystRecord for the record shape.
     */
    getAnalystRecords(maxCount = 500) {
      if (!state.enabled || !state.rows.length) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 500;
      return state.rows
        .slice(0, limit)
        .map((row, index) => mapAnalystRecord(row, index));
    },

    /**
     * Install the manager's "row controls changed" callback. Requests are
     * asynchronous, so completion and failure push a re-render — nothing
     * else would repaint the chips before the next 10-minute refresh.
     * @param {(() => void)|null} listener Callback, or null to detach.
     */
    setRowControlsListener(listener) {
      state.rowControlsListener =
        typeof listener === 'function' ? listener : null;
    },

    getRowControls() {
      const group = selectedGroup();
      const story = selectedStory();
      const chips = [
        {
          id: 'open-article',
          label: 'OPEN ARTICLE',
          title: story
            ? `Open this headline at ${story.domain || 'its publisher'} in a new tab`
            : 'Select a headline pin to open its article',
          disabled: !story,
          onClick: openSelectedArticle,
        },
      ];
      // LOAD MORE comes before the paging chips: the panel appends chips that
      // newly appear instead of reordering, so the always-present chips must
      // precede the ones that exist only for a multi-story place.
      chips.push({
        id: 'load-more',
        label: 'LOAD MORE',
        title: loadMoreTitle(),
        disabled: !canLoadMore(),
        // `busy` is what earns the wait cursor; a chip that is merely
        // unavailable gets "not-allowed" and explains itself in the title.
        busy: state.loading,
        onClick: () => layer.loadMore(),
      });
      // Fetching. All three are always present and explain themselves when
      // disabled, for the ordering reason above: a chip that came and went
      // would be appended in the wrong place when it returned. None of them
      // is `active` — they are actions that ADD to the map, not modes, and a
      // lit chip would imply the map showed only that one thing.
      const region = viewRegion();
      chips.push(
        {
          id: 'news-in-view',
          label: 'NEWS IN VIEW',
          title: newsInViewTitle(region),
          disabled: !canFetchRegion(region),
          busy: state.loading,
          onClick: () => layer.fetchViewRegion(),
        },
        {
          id: 'global-news',
          label: 'GLOBAL FEED',
          title: globalFeedTitle(),
          disabled: !canFetchGlobal(),
          busy: state.loading,
          onClick: () => layer.showGlobalFeed(),
        },
        {
          id: 'clear-pins',
          label: 'CLEAR PINS',
          title: clearPinsTitle(),
          disabled: !state.enabled || !state.rows.length,
          onClick: () => layer.clearPins(),
        },
      );
      if (group && group.count > 1) {
        chips.push(
          {
            id: 'prev-story',
            label: 'PREV STORY',
            title: `Show the previous of ${group.count} stories at ${group.place}`,
            disabled: false,
            onClick: prevStory,
          },
          {
            id: 'next-story',
            label: 'NEXT STORY',
            title: `Show the next of ${group.count} stories at ${group.place}`,
            disabled: false,
            onClick: nextStory,
          },
        );
      }
      const tally = { negative: 0, neutral: 0, positive: 0, unknown: 0 };
      for (const row of state.rows) tally[toneBand(row.sentiment)]++;
      const legend = TONE_LEGEND.map(({ band, label }) => ({
        label,
        color: TONE_COLORS[band],
        count: tally[band],
        blurb: LEGEND_BLURB,
      }));
      // Unscored headlines are still pinned; a legend that omitted them would
      // disagree with the map.
      if (tally.unknown)
        legend.push({
          label: 'No tone score',
          color: TONE_COLORS.unknown,
          count: tally.unknown,
          blurb: LEGEND_BLURB,
        });
      return { chips, legend };
    },

    /**
     * Layer stats for the data panel. Degraded feed states surface through
     * `error` (a dead feed must never look like a healthy empty layer) with a
     * matching human `loadingLabel`; `keyRequired` is the machine-readable
     * half of the keyless state.
     */
    getStats() {
      const now = Date.now();
      const rows = state.rows.length;
      const cachedAge = state.lastUpdate
        ? `cached ${formatAge(now - state.lastUpdate) || '<1h'}`
        : null;
      const blockedName = state.blocked ? blockedLabel(state.blocked) : null;
      // A block on a cached batch names the block AND the age of the pins it
      // still shows: the panel renders `error` for a stale row, so a bare
      // `stale` flag read STALE with no reason (local QA, 2026-09-19).
      const blockedText =
        blockedName &&
        rows &&
        cachedAge &&
        (state.stale || state.blocked === 'budget')
          ? `${blockedName} · ${cachedAge}`
          : blockedName;
      // A transient upstream fault keeps its specific message (e.g. the HTTP
      // status) when one exists; the generic label only covers a cache served
      // during the proxy's backoff.
      const namedBlock =
        state.blocked && (state.blocked !== 'upstream' || !state.error);
      let loadingLabel = '';
      if (state.loading) {
        loadingLabel = rows ? 'refreshing...' : 'loading...';
      } else if (state.keyRequired) {
        loadingLabel = 'KEY REQUIRED';
      } else if (namedBlock) {
        loadingLabel = blockedText;
      } else if (state.stale) {
        loadingLabel = `STALE · ${cachedAge || 'cached <1h'}`;
      } else if (state.error) {
        loadingLabel = state.error;
      } else if (state.lastUpdate) {
        // The source label already ends in "· LIVE"; repeating it here made
        // the row read "World News API · LIVE · LIVE · …". The map is
        // cumulative, so the row names what is actually on it: it must never
        // read as the whole world while it holds two cities, nor quote one
        // batch's "of N scanned" once several have been merged.
        const ago = formatAgoMinutes(now - state.lastUpdate);
        const singleGlobalBatch =
          state.batches.length === 1 && !state.batches[0].region;
        loadingLabel = singleGlobalBatch
          ? `${rows} of ${state.requested} latest headlines place-tagged · updated ${ago}`
          : `${rows} ${describeScope()} place-tagged · updated ${ago}`;
      }
      const empty = !state.loading && !rows;
      const status = state.keyRequired
        ? 'unavailable'
        : empty && (state.error || state.blocked)
          ? 'unavailable'
          : empty && state.lastUpdate
            ? 'empty'
            : undefined;
      return {
        count: state.groups.length,
        countLabel: state.enabled ? `${rows} pinned` : '',
        lastUpdate: state.lastUpdate,
        loading: state.loading,
        stale: state.stale || state.blocked === 'budget',
        keyRequired: state.keyRequired,
        blocked: state.blocked,
        error: state.keyRequired
          ? 'KEY REQUIRED'
          : namedBlock
            ? blockedText
            : state.error,
        status,
        statusMessage:
          status === 'empty'
            ? state.refreshTarget
              ? `No place-tagged headlines ${describeNewsRegion(state.refreshTarget)}`
              : 'No place-tagged headlines in the latest batch'
            : undefined,
        loadingLabel,
      };
    },
  };
  return layer;
}
