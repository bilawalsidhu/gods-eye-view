import * as Cesium from 'cesium';
import {
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
  aggregatePlaces,
  formatAge,
  formatAgoMinutes,
  mapAnalystRecord,
  toneBand,
} from './model.js';
import { createWorldNewsPresentation } from './presentation.js';
export * from './model.js';
export * from './policy.js';
export { createWorldNewsSource } from './source.js';

/** Proxy `blocked` codes the row can name; anything else reads as an error. */
const BLOCKED_LABELS = Object.freeze({
  budget: 'BUDGET REACHED · resumes 00:00 UTC',
  quota: 'QUOTA EXHAUSTED · resets 00:00 UTC',
  rate_limited: 'RATE LIMITED',
  bad_key: 'INVALID KEY',
  upstream: 'UPSTREAM UNAVAILABLE',
});

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
    state.stale = false;
    state.blocked = null;
    state.budget = null;
    state.quota = null;
    state.keyRequired = false;
    state.requested = 0;
    state.unplacedCount = 0;
    state.morePagesLeft = 0;
    state.costPerRequest = null;
  }

  function applySnapshot(snapshot) {
    state.keyRequired = false;
    state.error = null;
    state.moreError = null;
    state.rows = snapshot.rows;
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
    // Data age, not response age: a stale proxy payload truthfully reads old.
    state.lastUpdate = Number.isFinite(snapshot.fetchedAt)
      ? snapshot.fetchedAt
      : Date.now();
    const groups = aggregatePlaces(snapshot.rows).slice(0, MAX_RENDERED_PLACES);
    state.groups = groups;
    state.groupById = new Map(groups.map((group) => [group.id, group]));
    renderPlaces(Date.now());
    if (credit && snapshot.rows.length && !state.creditRegistered) {
      state.creditRegistered =
        services.credits?.register?.(state.viewer, credit) !== false;
    }
    console.log(
      `[Data:WorldNews] Updated: ${snapshot.rows.length} headlines at ${groups.length} places`,
    );
  }

  function applyKeyless() {
    state.keyRequired = true;
    state.error = null;
    state.moreError = null;
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

  function loadMoreTitle() {
    const cost = state.costPerRequest ?? 2;
    const spent = state.budget?.spent ?? 0;
    const limit = state.budget?.limit ?? '?';
    const budgetLine = `1 request ≈ ${cost} points of today's budget (${spent}/${limit} used)`;
    if (state.keyRequired) return 'Add a World News API key to load headlines';
    if (state.blocked)
      return `${BLOCKED_LABELS[state.blocked] || state.blocked} · ${budgetLine}`;
    if (state.moreError) return `${state.moreError} · ${budgetLine}`;
    if (state.morePagesLeft <= 0)
      return `No extra pages left this hour · ${budgetLine}`;
    return `Fetch one more page of headlines (${state.morePagesLeft} left this hour) · ${budgetLine}`;
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

    destroy(viewer = state.viewer) {
      layer.disable();
      destroyInteraction();
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
      chips.push({
        id: 'load-more',
        label: 'LOAD MORE',
        title: loadMoreTitle(),
        disabled: !canLoadMore(),
        onClick: () => layer.loadMore(),
      });
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
      const blockedLabel = state.blocked
        ? BLOCKED_LABELS[state.blocked] || state.blocked.toUpperCase()
        : null;
      let loadingLabel = '';
      if (state.loading) {
        loadingLabel = rows ? 'refreshing...' : 'loading...';
      } else if (state.keyRequired) {
        loadingLabel = 'KEY REQUIRED';
      } else if (state.blocked && state.blocked !== 'upstream') {
        loadingLabel = blockedLabel;
      } else if (state.stale) {
        loadingLabel = `STALE · cached ${formatAge(now - state.lastUpdate) || '<1h'}`;
      } else if (state.error) {
        loadingLabel = state.error;
      } else if (state.lastUpdate) {
        loadingLabel = `LIVE · ${rows} of ${state.requested} latest headlines place-tagged · updated ${formatAgoMinutes(now - state.lastUpdate)}`;
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
          : state.blocked && !rows
            ? blockedLabel
            : state.error,
        status,
        statusMessage:
          status === 'empty'
            ? 'No place-tagged headlines in the latest batch'
            : undefined,
        loadingLabel,
      };
    },
  };
  return layer;
}
