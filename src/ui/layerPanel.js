import { h, render as renderVue } from 'vue';
import {
  createLayerFinder,
  filterLayerRows,
  layerFinderFor,
} from './layerFinderFilter.js';
import LayerRows from './layerPanel/LayerRows.vue';
import { layerFeedState } from '../data/feedState.js';
import { FEED_STATE_LABEL_KEYS } from './layerRowState.js';
export { layerFeedState } from '../data/feedState.js';
import { GUIDANCE_STATUSES } from '../loadingFeedback.js';
import { keyGuidanceText, keysRequirementText } from './keyGuidance.js';
import {
  LAYER_NAME_KEYS,
  PANEL_LABEL_KEYS as PANEL_LABELS,
  layerSourceText,
} from './layerNames.js';
export { localizeLayerName } from './layerNames.js';
import { createWeatherPanel } from './weatherPanel.js';
import { createNewsPanel } from './newsPanel.js';
import { watchDisplayed } from './displayWatch.js';
import { onPanelOpening } from './rail/panelContent.js';
import {
  translateFeedError,
  translateStatusLine,
  translateStatusMessage,
} from './statusText.js';
import {
  formatNumber,
  getLocale,
  msg,
  onLocaleChange,
  t,
} from '../i18n/index.js';

function lifecycleStateLabel(lifecycleState) {
  return t(lifecycleState === 'enabling' ? msg('ENABLING') : msg('DISABLING'));
}

// Presentation order is independent of catalog registration and startup order.
const PANEL_GROUPS = [
  {
    label: msg('Movement'),
    ids: [
      'satellites',
      'flights',
      'military',
      'local-adsb',
      'ais-live-vessels',
      'traffic',
      'transit',
      'rail',
      'bikeshare',
    ],
  },
  {
    label: msg('Cameras'),
    ids: ['cctv', 'recent-imagery', 'street-level'],
  },
  {
    label: msg('Infrastructure'),
    ids: [
      'alpr-cameras',
      'military-installations',
      'drone-airspace',
      'local-datacenters',
      'telegeography-submarine-cables',
      'local-dams',
      'sea-marks',
      'ski-pistes',
    ],
  },
  {
    label: msg('Events'),
    ids: [
      'rocket-launches',
      'earthquakes',
      'local-firms',
      'fire-perimeters',
      'gnss-integrity',
      's2-ghostmaps',
      'shipwrecks',
      'news',
    ],
  },
  {
    label: msg('Wildlife'),
    ids: ['wildlife-sightings'],
  },
  {
    label: msg('Weather'),
    ids: [
      'air-quality',
      'wind',
      'weather-radar',
      'weather-satellite',
      'weather-lightning',
      'weather-cyclones',
    ],
  },
  // Directions renders in the Utilities panel, beside Draw and Import, and
  // needs no heading there.
  {
    label: msg('Utilities'),
    ids: ['directions', 'osm-places'],
    containerId: 'utilities-toggles',
  },
  {
    label: msg('Audio'),
    ids: ['radio'],
  },
];
const PANEL_ORDER = PANEL_GROUPS.flatMap(({ label, ids, containerId }) =>
  ids.map((id) => ({ id, label, containerId })),
);
const PANEL_POSITIONS = new Map(
  PANEL_ORDER.map(({ id }, index) => [id, index]),
);
// Data Library layers follow every core group, in the order they were added.
const LIBRARY_GROUP = msg('Library');
const panelPosition = (layer) =>
  layer.libraryEntryId
    ? PANEL_ORDER.length + 1
    : (PANEL_POSITIONS.get(layer.id) ?? PANEL_ORDER.length);
const panelGroup = (layer) =>
  layer.libraryEntryId
    ? LIBRARY_GROUP
    : (PANEL_ORDER[PANEL_POSITIONS.get(layer.id)]?.label ??
      msg('Other layers'));

function englishPanelLabel(layer) {
  return PANEL_LABELS[layer.id] || LAYER_NAME_KEYS[layer.id] || layer.name;
}

// PANEL_LABELS win over layer-name keys; otherwise the module's own name.
function panelLabel(layer) {
  if (PANEL_LABELS[layer.id]) return t(PANEL_LABELS[layer.id]);
  const key = LAYER_NAME_KEYS[layer.id];
  return key ? t(key) : layer.name;
}

/**
 * Guidance for a control a missing provider key is holding back.
 *
 * The key registry already owns what each key is called and which environment
 * variables enable it, so a layer only declares WHICH key it needs
 * (`requiresKeyId`) and reports `stats.keyRequired` while that key is absent.
 * Naming the variable turns an unexplained dead control into a next step. A
 * layer reading several keyed networks may name each key it lacks (an array).
 *
 * An unnamed or unknown key returns '' rather than guessing: guidance naming
 * the wrong variable sends the operator to the wrong provider.
 *
 * @param {object} [layer] Row from the layer manager's getAll().
 * @returns {string} Guidance text, or '' when no key guidance applies.
 */
export function layerKeyRequirementTooltip(layer = {}) {
  if (layer?.stats?.keyRequired !== true) return '';
  const ids = [layer.requiresKeyId]
    .flat()
    .map((id) => String(id || '').trim())
    .filter(Boolean);
  // A layer with several sources also names the ones it could use instead.
  return keyGuidanceText(
    keysRequirementText(ids),
    layer.stats.keyAlternatives || [],
  );
}

function formatCount(n) {
  if (n >= 1000)
    return `${formatNumber(n / 1000, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
      useGrouping: false,
    })}K`;
  return String(n);
}

/** Qualify a loaded count when it does not mean items currently on screen. */
function layerCountText(stats) {
  if (typeof stats.countLabel === 'string' && stats.countLabel.trim())
    return stats.countLabel;
  return stats.count ? formatCount(stats.count) : '—';
}

/**
 * A row's count. Outside English a count phrase ("24 nearby · 2 on screen")
 * gets its own line (`countLine`), or it squeezes a longer translated name to
 * a word per line. "—" is marked `empty` so a wide status chip can replace it
 * (radio.css).
 * @param {object} stats Layer stats.
 * @returns {{text: string, empty: boolean, countLine: boolean}}
 */
export function presentLayerCount(stats = {}) {
  const text = layerCountText(stats);
  return {
    text,
    empty: text === '—',
    countLine:
      getLocale() !== 'en' &&
      typeof stats.countLabel === 'string' &&
      /\d/.test(stats.countLabel),
  };
}

/**
 * A row's lifecycle toggle: its classes, feed state, label and accessible
 * name. A busy or unavailable toggle is `ariaDisabled` and stays focusable;
 * native `disabled` would evict keyboard focus in Chromium.
 * @param {object} layer Row from the layer manager's getAll().
 */
export function presentLayerToggle(layer) {
  const unavailable = layer.stats?.sourceUnavailable === true;
  const feedState = unavailable
    ? 'unavailable'
    : layer.enabled
      ? layerFeedState(layer.stats)
      : 'off';
  const transitioning =
    layer.lifecycleState === 'enabling' || layer.lifecycleState === 'disabling';
  const uncertain = Boolean(layer.lifecycleUncertain);
  const classes = {
    active: Boolean(layer.enabled),
    transitioning,
    enabling: layer.lifecycleState === 'enabling',
    disabling: layer.lifecycleState === 'disabling',
    'lifecycle-uncertain': uncertain,
  };
  for (const state of Object.keys(FEED_STATE_LABEL_KEYS))
    classes[`feed-${state}`] =
      (layer.enabled || unavailable) && !uncertain && feedState === state;
  const showsFeedState =
    !transitioning && !uncertain && (layer.enabled || unavailable);
  const stateText = transitioning
    ? lifecycleStateLabel(layer.lifecycleState)
    : uncertain
      ? t('UNCERTAIN')
      : showsFeedState
        ? t(FEED_STATE_LABEL_KEYS[feedState])
        : t('OFF');
  // Name the missing key on the control itself: a row reading KEY REQUIRED
  // without saying WHICH key leaves a dead control and no next step. Empty
  // when the layer needs no key, or already has one.
  const keyGuidance = unavailable
    ? String(
        translateFeedError(layer.stats.error) || t('Data source unavailable'),
      )
    : layerKeyRequirementTooltip(layer);
  const ariaLabel = t('{name}: {state}', {
    name: panelLabel(layer),
    state: stateText,
  });
  return {
    classes,
    feedState: transitioning
      ? layer.lifecycleState
      : uncertain
        ? 'uncertain'
        : feedState,
    ariaDisabled: transitioning || (unavailable && !layer.enabled),
    ariaBusy: transitioning,
    // The chip may abbreviate where a language's word is wider than the
    // status column; the meta line and the accessible name keep the full word.
    text:
      showsFeedState && feedState === 'unavailable'
        ? t('UNAVAILABLE', { context: 'status chip' })
        : stateText,
    title: keyGuidance,
    ariaLabel: keyGuidance ? `${ariaLabel}. ${keyGuidance}` : ariaLabel,
  };
}

/** The layers the Weather rail readout shows. */
const WEATHER_PANEL_IDS = Object.freeze([
  'wind',
  'weather-radar',
  'weather-satellite',
  'weather-lightning',
  'weather-cyclones',
  'air-quality',
]);
const RECENT_IMAGERY_ID = 'recent-imagery';
/** Marks the scene time as moved among the dirty layer ids. */
const TIME = Symbol('time');

/**
 * Layer rows over supplied state and actions. The standard row container's Finder
 * takes precedence over an explicit Finder or the private default.
 */
export class LayerPanel {
  constructor({
    getLayers,
    isEnabled,
    setEnabled,
    setLayerParams,
    getRowControls,
    hasRowControls,
    weatherClock,
    finder,
  }) {
    this._ownFinder = finder ?? createLayerFinder();
    this.finder = this._ownFinder;
    this.weatherClock = weatherClock;
    this.getAll = getLayers;
    this.isEnabled = isEnabled;
    this.setEnabled = setEnabled;
    this.setLayerParams = setLayerParams;
    this._rowControlsFor = getRowControls;
    this.hasRowControls = hasRowControls;
    this._generation = 0;
    this._removers = [];
    this._destroyed = false;
    /** @type {Map<string, HTMLElement>} lists of their own, by element id */
    this._groupContainers = new Map();
    // The scheduler: layers whose row or readout may have changed since the
    // last paint (`invalidate`), painted together on the next frame.
    /** @type {Set<string | symbol>} */
    this._dirty = new Set();
    this._dirtyAll = false;
    /** @type {(() => void) | null} cancels the frame asked for */
    this._cancelFrame = null;
    /** @type {Set<string> | 'all' | null} ids a skipped paint left unpresented */
    this._stale = null;
    /** @type {string[]} layers whose row text follows the scene time */
    this._timeFollowers = [];
    this._offTime = null;
    this._recentImageryFactory = null;
    this._recentImageryPanel = null;
    this._rows = [];
    this._rowViews = new Map();
    this._finderRows = [];
    this._pending = new Set();
    /** @type {Map<HTMLElement, ReturnType<typeof watchDisplayed>>} */
    this._displayWatches = new Map();
    /** @type {Array<() => void>} releases the panels' opening flushes */
    this._openingRemovers = [];
    /** @type {Map<HTMLElement, string | null>} the rows each list shows */
    this._paintedRows = new Map();
    // Row lists a refresh skipped while they were not displayed.
    this._owedLists = new Set();
  }
  mount(container) {
    if (this._destroyed) return;
    this._releaseBindings();
    if (this._toggleContainer && this._toggleContainer !== container)
      renderVue(null, this._toggleContainer);
    for (const element of this._groupContainers.values())
      renderVue(null, element);
    // The rows replace whatever the container held before.
    if (container && !container._vnode) container.replaceChildren();
    this._toggleContainer = container;
    this.finder = layerFinderFor(container) ?? this._ownFinder;
    // A group with a list of its own (Directions in Utilities) renders there;
    // without that list it stays in Data Layers under its heading.
    this._groupContainers = new Map();
    for (const { containerId } of PANEL_GROUPS) {
      const element =
        containerId && container?.ownerDocument?.getElementById?.(containerId);
      if (!element) continue;
      if (!element._vnode) element.replaceChildren();
      this._groupContainers.set(containerId, element);
    }
    this._watchRowLists();
    // The panel follows the scene time once, for every layer that declares
    // its row or readout follows it; no layer pushes a repaint per time step.
    this._offTime?.();
    this._offTime =
      this.weatherClock?.subscribe?.(() => this._onTimeMoved()) ?? null;
    this._weatherPanel?.destroy();
    this._weatherPanel = createWeatherPanel({
      clock: this.weatherClock,
      container:
        container?.ownerDocument?.getElementById?.('weather-panel-body'),
      setLayerParams: this.setLayerParams,
    });
    this._newsPanel?.destroy();
    this._newsPanel = createNewsPanel({
      container: container?.ownerDocument?.getElementById?.('news-panel-body'),
      setLayerParams: this.setLayerParams,
    });
    this._mountRecentImagery();
    this._renderToggles();
  }
  /**
   * Host the Recent Imagery readout in its rail body, like the weather
   * readout. The application supplies the factory once the layer, viewer and
   * box tool exist; a remount rebuilds the readout in place.
   * @param {((container: HTMLElement) => { destroy: () => void } | null) | null} factory
   */
  attachRecentImagery(factory) {
    if (this._destroyed) return;
    this._recentImageryFactory = typeof factory === 'function' ? factory : null;
    this._mountRecentImagery();
  }
  _mountRecentImagery() {
    this._recentImageryPanel?.destroy();
    this._recentImageryPanel = null;
    const container = this._toggleContainer?.ownerDocument?.getElementById?.(
      'recent-imagery-panel-body',
    );
    if (container && this._recentImageryFactory)
      this._recentImageryPanel = this._recentImageryFactory(container) || null;
  }
  /**
   * A refresh skips a row list its panel does not display (collapsed or
   * hidden) and repaints it once when it is displayed again: at once when the
   * panel chrome presents its panel open, so nothing lays out, measures or
   * reads old rows, and otherwise when a ResizeObserver reports it displayed.
   */
  _watchRowLists() {
    this._unwatchRowLists();
    const panels = new Set();
    for (const element of [
      this._toggleContainer,
      ...this._groupContainers.values(),
    ]) {
      if (!element || this._displayWatches.has(element)) continue;
      this._displayWatches.set(
        element,
        watchDisplayed(element, () => {
          if (this._owedLists.has(element) && !this._destroyed)
            this._paint({ whileShown: true });
        }),
      );
      const panel = element.closest?.('[data-panel-id]');
      if (panel && !panels.has(panel)) {
        panels.add(panel);
        this._openingRemovers.push(
          onPanelOpening(panel, (options) =>
            this.flushOwedRows({ ...options, panel }),
          ),
        );
      }
    }
  }
  _unwatchRowLists() {
    for (const watch of this._displayWatches.values()) watch.disconnect();
    this._displayWatches = new Map();
    for (const remove of this._openingRemovers.splice(0)) remove();
  }
  /**
   * Paint now what a panel being shown owes: the rows a refresh skipped while
   * their list was not displayed, and whatever a frame was about to paint.
   * Whatever shows a panel calls this first (see `rail/panelContent.js`); a
   * no-op when nothing concerned is owed or pending. Only the lists inside
   * `panel` count as shown, or with `displayedOnly` only the owed lists that
   * have a layout box now; the others stay owed.
   * @param {{ displayedOnly?: boolean, panel?: Element | null }} [options]
   */
  flushOwedRows({ displayedOnly = false, panel = null } = {}) {
    if (this._destroyed) return;
    const pending = this._hasPending();
    const shown = displayedOnly
      ? [...this._owedLists].filter(
          (element) => element.getClientRects?.().length > 0,
        )
      : [...this._displayWatches.keys()].filter(
          (element) =>
            (pending || this._owedLists.has(element)) &&
            (!panel || panel.contains(element)),
        );
    if (shown.length === 0) return;
    // These lists are being shown: a paint before the observer's next report
    // paints them rather than owing them again.
    for (const element of shown)
      this._displayWatches.get(element)?.assumeShown();
    this._dirtyAll = true;
    this.paintPending();
  }

  /**
   * A layer's row or rail readout may have changed. Nothing paints now: the
   * changes made before the next frame are painted together then, only on
   * the surfaces that are displayed, and a surface that is not keeps them
   * owed until it is. With no id, every layer.
   * @param {string} [layerId]
   */
  invalidate(layerId) {
    if (this._destroyed) return;
    if (typeof layerId === 'string' || layerId === TIME)
      this._dirty.add(layerId);
    else this._dirtyAll = true;
    if (this._cancelFrame) return;
    const frame = () => {
      this._cancelFrame = null;
      this.paintPending();
    };
    if (typeof requestAnimationFrame === 'function') {
      const id = requestAnimationFrame(frame);
      this._cancelFrame = () => cancelAnimationFrame(id);
    } else {
      const id = setTimeout(frame, 0);
      this._cancelFrame = () => clearTimeout(id);
    }
  }

  /**
   * Paint now what was invalidated since the last paint. While the page is
   * hidden it stays pending; the page's return calls this again.
   */
  paintPending() {
    if (this._destroyed) return;
    this._cancelFrame?.();
    this._cancelFrame = null;
    if (!this._hasPending() || !this._toggleContainer) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    const only = this._dirtyAll ? null : new Set(this._dirty);
    this._dirtyAll = false;
    this._dirty.clear();
    this._paint({ whileShown: true, only });
    if (!only || WEATHER_PANEL_IDS.some((id) => only.has(id)) || only.has(TIME))
      this._refreshWeatherPanel();
    if (!only || only.has('news')) this._refreshNewsPanel();
    if (!only || only.has(RECENT_IMAGERY_ID))
      this._recentImageryPanel?.update?.();
  }

  _hasPending() {
    return this._dirtyAll || this._dirty.size > 0;
  }

  /** Every layer's row and readout, painted now (a remount, a test). */
  _refreshTogglePanel() {
    this._dirtyAll = true;
    this.paintPending();
  }

  /** The scene time moved: the rows and readouts that follow it are dirty. */
  _onTimeMoved() {
    if (this._destroyed) return;
    let dirty = false;
    for (const id of this._timeFollowers)
      if (this.isEnabled(id)) {
        this._dirty.add(id);
        dirty = true;
      }
    // The Weather readout's frame time and ages are read from the time.
    if (WEATHER_PANEL_IDS.some((id) => this.isEnabled(id))) dirty = true;
    if (dirty) this.invalidate(TIME);
  }
  _isDisplayed(element) {
    return this._displayWatches.get(element)?.shown() ?? true;
  }
  _releaseBindings() {
    this._generation++;
    // New bindings render every list again. What was invalidated stays
    // pending, with its frame: a rebuild repaints the rows, and the frame
    // still updates every surface the invalidations were for.
    this._paintedRows = new Map();
    this._stale = null;
    for (const remove of this._removers.splice(0)) remove();
  }
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this._releaseBindings();
    this._cancelFrame?.();
    this._cancelFrame = null;
    this._dirty.clear();
    this._dirtyAll = false;
    this._unwatchRowLists();
    this._owedLists.clear();
    this._offTime?.();
    this._offTime = null;
    this._weatherPanel?.destroy();
    this._weatherPanel = null;
    this._newsPanel?.destroy();
    this._newsPanel = null;
    this._recentImageryPanel?.destroy();
    this._recentImageryPanel = null;
    this._recentImageryFactory = null;
    if (this._toggleContainer) renderVue(null, this._toggleContainer);
    for (const element of this._groupContainers.values())
      renderVue(null, element);
    this._groupContainers = new Map();
    this._toggleContainer = null;
    this._finderRows = [];
  }
  /** Rebuild the rows after the layer set changed (a Data Library add/remove). */
  rerender() {
    this._renderToggles();
  }
  _renderToggles() {
    if (this._destroyed || !this._toggleContainer) return;
    this._releaseBindings();
    // The rows are fixed here, in panel order under their group headings;
    // refreshes repaint them. A layer whose row is a rail readout keeps only
    // its toggle and metadata.
    const layers = this.getAll()
      .slice()
      .sort((a, b) => panelPosition(a) - panelPosition(b));
    this._rows = [];
    this._rowViews = new Map();
    this._timeFollowers = [];
    let previousGroup = '';
    for (const layer of layers) {
      if (!layer.showInTogglePanel) continue;
      const group = panelGroup(layer);
      const containerId =
        PANEL_ORDER[PANEL_POSITIONS.get(layer.id)]?.containerId;
      const container = this._groupContainers.has(containerId)
        ? containerId
        : null;
      // A group in a list of its own needs no heading there.
      if (!container && group && group !== previousGroup)
        this._rows.push({ key: `group:${group}`, heading: group });
      previousGroup = container ? '' : group;
      const readout = Boolean(this._rowControlsFor(layer.id)?.readout);
      const controls = this.hasRowControls(layer.id);
      if (layer.followsTime) this._timeFollowers.push(layer.id);
      this._rows.push({
        key: layer.id,
        id: layer.id,
        container,
        count: !readout,
        controls: controls && !readout,
        info: false,
      });
    }
    // The rows carry text this panel translates; show it in a new locale.
    this._removers.push(
      onLocaleChange(() => {
        this._paint();
        this._refreshWeatherPanel();
        this._refreshNewsPanel();
      }),
    );
    this._paint();
    this._removers.push(this.finder.onInputs(() => this._onFinderInputs()));
    this._refreshWeatherPanel();
    this._refreshNewsPanel();
  }

  /**
   * Present every row from the layers' current state and render them. A list
   * whose rows are the ones it already shows is not rendered again. With
   * `whileShown`, a list that is not displayed is left as it is and owed a
   * repaint for when it is displayed again.
   */
  _paint({ whileShown = false, only = null } = {}) {
    if (this._destroyed || !this._toggleContainer) return;
    const containers = [
      this._toggleContainer,
      ...this._groupContainers.values(),
    ];
    // Rows a skipped paint did not present are presented with these.
    const stale = this._stale;
    const present =
      !only || stale === 'all' ? null : new Set([...only, ...(stale ?? [])]);
    if (
      whileShown &&
      !containers.some((element) => this._isDisplayed(element))
    ) {
      for (const element of containers) this._owedLists.add(element);
      this._stale = present ?? 'all';
      return;
    }
    this._stale = null;
    const layers = new Map(this.getAll().map((layer) => [layer.id, layer]));
    // Each list renders its own rows: Data Layers, and any group's own list.
    const lists = new Map([[null, []]]);
    for (const id of this._groupContainers.keys()) lists.set(id, []);
    for (const row of this._rows) {
      let item;
      if (row.heading) item = { key: row.key, heading: t(row.heading) };
      else {
        const layer = layers.get(row.id);
        if (
          layer &&
          (!present || present.has(row.id) || !this._rowViews.has(row.id))
        )
          this._rowViews.set(row.id, this._presentRow(row, layer));
        item = this._rowViews.get(row.id);
      }
      if (item) lists.get(row.container ?? null).push(item);
    }
    this._finderRows = lists.get(null);
    if (
      this._listNeedsRender(this._toggleContainer, this._finderRows, whileShown)
    )
      this._paintFinder();
    for (const [id, container] of this._groupContainers) {
      const items = lists.get(id);
      if (this._listNeedsRender(container, items, whileShown))
        this._renderRows(container, items);
    }
  }

  /**
   * Whether a list must be rendered: not while it is not displayed (with
   * `whileShown`), which leaves it owed a repaint, nor when it already shows
   * these rows. Row handlers re-read the live descriptor, so only the
   * presented values, never their functions, are compared.
   */
  _listNeedsRender(container, items, whileShown) {
    if (whileShown && !this._isDisplayed(container)) {
      this._owedLists.add(container);
      return false;
    }
    this._owedLists.delete(container);
    let rows = null;
    try {
      rows = JSON.stringify(items);
    } catch {
      // Rows that cannot be compared are always rendered.
    }
    if (rows !== null && this._paintedRows.get(container) === rows)
      return false;
    this._paintedRows.set(container, rows);
    return true;
  }

  /**
   * Filter the rows anew. Rows a refresh left owed are presented anew first,
   * and the Data Layers list renders even when its rows are unchanged.
   */
  _onFinderInputs() {
    if (!this._owedLists.has(this._toggleContainer)) return this._paintFinder();
    this._paintedRows.delete(this._toggleContainer);
    this._paint();
  }

  /** Finder input changes only visibility, not the layer state or controls. */
  _paintFinder() {
    if (this._destroyed || !this._toggleContainer) return;
    const { filtered, groups, shown } = filterLayerRows(
      this._finderRows,
      this.finder.inputs(),
    );
    this.finder.publish(groups, shown);
    this._renderRows(this._toggleContainer, this._finderRows, filtered);
  }

  _renderRows(container, items, filtered) {
    const generation = this._generation;
    renderVue(
      h(LayerRows, {
        items,
        filtered,
        onToggle: (layerId) => this._toggle(layerId, generation),
        onChip: (layerId, chipId) =>
          this._selectChip(layerId, chipId, generation),
        onListItem: (layerId, itemId) =>
          this._selectListItem(layerId, itemId, generation),
        onSlider: (layerId, sliderId, value) =>
          this._moveSlider(layerId, sliderId, value, generation),
        onRange: (layerId, rangeId, end, value) =>
          this._pickRangeEnd(layerId, rangeId, end, value, generation),
      }),
      container,
    );
  }

  _presentRow(row, layer) {
    const toggle = presentLayerToggle(layer);
    if (this._pending.has(layer.id)) {
      // A busy toggle keeps keyboard focus: `aria-disabled` and the click
      // guard prevent repeat activation, where native `disabled` would evict
      // focus in Chromium.
      toggle.ariaDisabled = true;
      toggle.ariaBusy = true;
    }
    return {
      key: layer.id,
      id: layer.id,
      // English name for voice tools, which must not receive translated text.
      englishName: englishPanelLabel(layer),
      libraryEntry: layer.libraryEntryId || null,
      icon: layer.icon,
      name: panelLabel(layer),
      count: row.count ? presentLayerCount(layer.stats) : null,
      toggle,
      meta: this._buildMetaText(layer),
      controls: row.controls ? this._presentControls(row, layer) : null,
    };
  }

  /**
   * A layer's row chips, one-of-many switch, slider, start/end pickers, color legend, info line
   * and ordered list. The block
   * is hidden while the layer is off (or while a dependency owner has
   * surrendered it), so a quiet row stays quiet. Chips and list items are
   * keyed, so the refresh a chip's own click triggers keeps keyboard focus.
   * It records on `row` what persists across paints: a readout drops the
   * controls for good, and a shown info line stays.
   */
  _presentControls(row, layer) {
    // A quiet row stays quiet while off, except Data Library rows, whose
    // actions (zoom, remove) work on a layer that is off.
    const controls =
      layer.enabled || layer.libraryEntryId
        ? this._rowControlsFor(layer.id)
        : null;
    if (controls?.readout) {
      // The row became a rail readout: its controls go for good.
      row.controls = false;
      return null;
    }
    // A chip's count is shortened as the row's is.
    const chips = (controls?.chips || []).map((chip) =>
      Number.isFinite(chip.count)
        ? { ...chip, countText: formatCount(chip.count) }
        : chip,
    );
    const legend = (controls?.legend || []).map((item) => ({
      color: item.color,
      blurb: item.blurb,
      text:
        item.count == null
          ? String(item.label)
          : `${item.label} ${formatCount(item.count)}`,
    }));
    const infoText = controls?.info ? String(controls.info) : '';
    const segmented = controls?.segmented || null;
    const slider = controls?.slider || null;
    const range = controls?.range || null;
    // The info line, once shown, stays in place and hides when empty.
    if (infoText) row.info = true;
    return {
      hidden:
        chips.length === 0 &&
        legend.length === 0 &&
        !infoText &&
        !segmented &&
        !slider &&
        !range,
      chips,
      segmented,
      slider,
      range,
      legend,
      info: row.info
        ? { text: infoText, title: controls?.infoTitle || '' }
        : null,
      list: controls?.list || null,
    };
  }

  async _toggle(id, generation) {
    const layer = this.getAll().find((entry) => entry.id === id);
    if (
      this._destroyed ||
      this._generation !== generation ||
      !layer ||
      this._pending.has(id) ||
      presentLayerToggle(layer).ariaDisabled
    )
      return;
    this._pending.add(id);
    this._paint();
    try {
      await this.setEnabled(id, !this.isEnabled(id), { origin: 'user' });
    } catch (error) {
      console.warn(`[Data] ${id} toggle error:`, error);
    } finally {
      this._pending.delete(id);
      // Repaint even after a remount: the new rows were painted busy while
      // this toggle was pending.
      if (!this._destroyed) this._paint();
    }
  }

  // Re-read the live descriptor rather than trusting the rendered chip, so a
  // stale row can never apply an inverted toggle. Unmounted rows keep their
  // listeners, so a click from a released generation is dropped.
  _selectChip(id, chipId, generation = this._generation) {
    if (this._destroyed || this._generation !== generation) return;
    // A switch option carries the same fields as a chip.
    const live = this._rowControlsFor(id);
    const chip = [
      ...(live?.chips || []),
      ...(live?.segmented?.options || []),
    ].find((entry) => entry.id === chipId);
    if (!chip || chip.disabled || (!this.isEnabled(id) && !chip.whileOff))
      return;
    if (typeof chip.onClick === 'function') chip.onClick();
    else if (chip.params)
      this.setLayerParams(id, chip.params, { origin: 'user' });
  }

  // A row slider (e.g. the Active Fires minimum-FRP filter) maps its position
  // to params through the live descriptor on every tick.
  _moveSlider(id, sliderId, value, generation = this._generation) {
    if (this._destroyed || this._generation !== generation) return;
    const slider = this._rowControlsFor(id)?.slider;
    if (
      !slider ||
      slider.id !== sliderId ||
      typeof slider.params !== 'function' ||
      !this.isEnabled(id)
    )
      return;
    this.setLayerParams(id, slider.params(value), { origin: 'user' });
  }

  _pickRangeEnd(id, rangeId, end, value, generation = this._generation) {
    if (this._destroyed || this._generation !== generation) return;
    const range = this._rowControlsFor(id)?.range;
    if (
      !range ||
      range.id !== rangeId ||
      (end !== 'from' && end !== 'to') ||
      typeof range.params !== 'function' ||
      !this.isEnabled(id)
    )
      return;
    this.setLayerParams(id, range.params(end, value), { origin: 'user' });
  }

  _selectListItem(id, itemId, generation = this._generation) {
    if (this._destroyed || this._generation !== generation) return;
    const item = this._rowControlsFor(id)?.list?.items?.find(
      (entry) => entry.id === itemId,
    );
    if (item && !item.disabled && item.params)
      this.setLayerParams(id, item.params, { origin: 'user' });
  }

  _refreshWeatherPanel() {
    this._weatherPanel?.update(
      this.getAll()
        .filter(
          (layer) => layer.enabled && WEATHER_PANEL_IDS.includes(layer.id),
        )
        .map((layer) => ({
          id: layer.id,
          icon: layer.icon,
          ...this._rowControlsFor(layer.id),
        })),
    );
  }

  /** Feed the News rail panel the view the news layer publishes while on. */
  _refreshNewsPanel() {
    const layer = this.getAll().find(({ id }) => id === 'news');
    this._newsPanel?.update(
      layer?.enabled ? this._rowControlsFor(layer.id)?.feed || null : null,
    );
  }

  _buildMetaText(layer) {
    const stats = layer.stats || {};
    const feedState = layerFeedState(stats);
    const stateLabel = t(FEED_STATE_LABEL_KEYS[feedState]);
    // A layer marks source text that is data rather than a catalog name.
    const source = layerSourceText(layer);
    const lifecycleState =
      layer.lifecycleState || (layer.enabled ? 'enabled' : 'disabled');
    if (lifecycleState === 'enabling' || lifecycleState === 'disabling') {
      return t('{state} · {source}', {
        state: lifecycleStateLabel(lifecycleState),
        source,
      });
    }
    if (layer.lifecycleUncertain) {
      return t(
        'UNCERTAIN · {source} · lifecycle state requires reconciliation',
        { source },
      );
    }
    const presentedError = translateFeedError(
      stats.error || stats.lastError || stats.managerRefreshError,
    );
    if (presentedError) {
      if (typeof stats.retryInSec === 'number' && stats.retryInSec > 0) {
        return t('{state} · {source} · {detail} · retry {seconds}s', {
          state: stateLabel,
          source,
          detail: presentedError,
          seconds: stats.retryInSec,
        });
      }
      return t('{state} · {source} · {detail}', {
        state: stateLabel,
        source,
        detail: presentedError,
      });
    }
    // A guidance status carries its prompt in `statusMessage`, not `error`, so
    // the row still tells the operator what to do without reporting a fault.
    if (
      GUIDANCE_STATUSES.includes(String(stats.status || '').toLowerCase()) &&
      typeof stats.statusMessage === 'string' &&
      stats.statusMessage.trim()
    ) {
      return `${source} · ${translateStatusMessage(stats.statusMessage.trim())}`;
    }
    const ago = stats.lastUpdate
      ? this._timeAgo(stats.lastUpdate, stats.atMs)
      : t('never');
    if (stats.loading) {
      const loadingLabel =
        typeof stats.loadingLabel === 'string' && stats.loadingLabel.trim()
          ? translateStatusLine(stats.loadingLabel.trim())
          : t('loading...');
      return t('{source} · {loadingLabel}', { source, loadingLabel });
    }
    if (feedState === 'fallback') {
      const detail =
        typeof stats.loadingLabel === 'string' && stats.loadingLabel.trim()
          ? translateStatusLine(stats.loadingLabel.trim())
          : stats.coverage || ago;
      return t('{state} · {source} · {detail}', {
        state: stateLabel,
        source,
        detail,
      });
    }
    if (feedState === 'partial') {
      const { acceptedRowCount, rawRowCount } = stats;
      const detail =
        Number.isInteger(acceptedRowCount) &&
        Number.isInteger(rawRowCount) &&
        acceptedRowCount >= 0 &&
        rawRowCount > acceptedRowCount
          ? t('{accepted} of {raw} records accepted', {
              accepted: acceptedRowCount,
              raw: rawRowCount,
            })
          : t('incomplete snapshot');
      return t('{state} · {source} · {detail} · {ago}', {
        state: stateLabel,
        source,
        detail,
        ago,
      });
    }
    if (feedState === 'stale') {
      // A layer drawing cached upstream data (Traffic's proxy tiles) dates the
      // row by the oldest of it, not by the load that re-served it.
      const dataAgo =
        Number(stats.oldestTileAt) > 0
          ? this._timeAgo(stats.oldestTileAt, stats.atMs)
          : ago;
      if (typeof stats.retryInSec === 'number' && stats.retryInSec > 0) {
        return t('{state} · {source} · {ago} · retrying in {seconds}s', {
          state: stateLabel,
          source,
          ago: dataAgo,
          seconds: stats.retryInSec,
        });
      }
      return t('{state} · {source} · {ago}', {
        state: stateLabel,
        source,
        ago: dataAgo,
      });
    }
    if (typeof stats.loadingLabel === 'string' && stats.loadingLabel.trim()) {
      return t('{source} · {loadingLabel}', {
        source,
        loadingLabel: translateStatusLine(stats.loadingLabel.trim()),
      });
    }
    return t('{source} · {ago}', { source, ago });
  }

  /** How long before `nowMs` (the layer's world time, else the wall clock). */
  _timeAgo(timestamp, nowMs) {
    const diff = Math.floor(
      ((Number.isFinite(nowMs) ? nowMs : Date.now()) - timestamp) / 1000,
    );
    if (diff < 5) return t('just now');
    if (diff < 60) return t('{count}s ago', { count: diff });
    if (diff < 3600) return t('{count}m ago', { count: Math.floor(diff / 60) });
    return t('{count}h ago', { count: Math.floor(diff / 3600) });
  }
}
