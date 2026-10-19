import { syncChipGroup } from './chipGroup.js';
import { syncRowList } from './rowList.js';
import { layerFeedState } from '../data/feedState.js';
export { layerFeedState } from '../data/feedState.js';
import { GUIDANCE_STATUSES } from '../loadingFeedback.js';
import { keyGuidanceText, keyRequirementText } from './keyGuidance.js';
import {
  LAYER_NAME_KEYS,
  PANEL_LABEL_KEYS as PANEL_LABELS,
  sourceLabel,
} from './layerNames.js';
export { localizeLayerName } from './layerNames.js';
import { createWeatherPanel } from './weatherPanel.js';
import { translateFeedError, translateStatusLine } from './statusText.js';
import {
  formatNumber,
  getLocale,
  msg,
  t,
  translateKnown,
} from '../i18n/index.js';

// Feed-state values are machine ids (QA hooks, CSS feed-* classes); only the
// label translates.
const FEED_STATE_LABEL_KEYS = Object.freeze({
  nominal: msg('ON'),
  loading: msg('LOADING'),
  degraded: msg('DEGRADED'),
  stale: msg('STALE'),
  partial: msg('PARTIAL'),
  fallback: msg('FALLBACK'),
  unavailable: msg('UNAVAILABLE'),
});

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
      'local-datacenters',
      'telegeography-submarine-cables',
      'local-dams',
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
    ],
  },
  {
    label: msg('Weather'),
    ids: [
      'air-quality',
      'wind',
      'weather-radar',
      'weather-satellite',
      'weather-lightning',
      'bom-radar',
      'weather-cyclones',
    ],
  },
  {
    label: msg('Utilities'),
    ids: ['directions', 'radio'],
  },
];
const PANEL_ORDER = PANEL_GROUPS.flatMap(({ label, ids }) =>
  ids.map((id) => ({ id, label })),
);
const PANEL_POSITIONS = new Map(
  PANEL_ORDER.map(({ id }, index) => [id, index]),
);

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
 * Naming the variable turns an unexplained dead control into a next step.
 *
 * An unnamed or unknown key returns '' rather than guessing: guidance naming
 * the wrong variable sends the operator to the wrong provider.
 *
 * @param {object} [layer] Row from the layer manager's getAll().
 * @returns {string} Guidance text, or '' when no key guidance applies.
 */
export function layerKeyRequirementTooltip(layer = {}) {
  if (layer?.stats?.keyRequired !== true) return '';
  const requiresKeyId = String(layer.requiresKeyId || '').trim();
  // A layer with several sources also names the ones it could use instead.
  return keyGuidanceText(
    requiresKeyId ? keyRequirementText(requiresKeyId) : '',
    layer.stats.keyAlternatives || [],
  );
}

const ROW_TEXT_SEPARATOR = ' · ';

// A short Latin code joined by hyphens. Longer runs (a URL, a token in an
// error) keep their break opportunities so they cannot overflow the rail.
const HYPHENATED_CODE = /[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+/g;
const HYPHENATED_CODE_MAX = 16;

/** A span for one run of row text; `keep` stops the browser breaking inside it. */
function rowTextSpan(text, keep) {
  const span = document.createElement('span');
  if (keep) span.className = 'data-keep';
  span.textContent = text;
  return span;
}

/**
 * Set a row's name, count or meta line so that a narrow column wraps it well
 * in every language: a Latin code with hyphens (ADS-B, RTL-SDR, GTFS-RT) never
 * splits at its hyphen, and a " · " separator stays at the end of the line it
 * closes, so no line starts with "·". The element's textContent is still the
 * plain string; text with neither feature is set directly.
 *
 * @param {HTMLElement} element
 * @param {string} text
 */
export function setRowText(element, text) {
  const value = String(text ?? '');
  // Refreshes run every second; leave unchanged text (and its spans) alone.
  if (element.textContent === value) return;
  const codes = [...value.matchAll(HYPHENATED_CODE)].filter(
    (match) => match[0].length <= HYPHENATED_CODE_MAX,
  );
  if (!codes.length && !value.includes(ROW_TEXT_SEPARATOR)) {
    element.textContent = value;
    return;
  }
  const spans = [];
  const pushPlain = (from, to) => {
    if (to <= from) return;
    const pieces = value.slice(from, to).split(ROW_TEXT_SEPARATOR);
    pieces.forEach((piece, index) => {
      // The space before the dot belongs to a no-wrap span, so the only break
      // opportunity around a separator is the space after it.
      if (index > 0) spans.push(rowTextSpan(' ·', true));
      const textPiece = index > 0 ? ` ${piece}` : piece;
      if (textPiece) spans.push(rowTextSpan(textPiece, false));
    });
  };
  let cursor = 0;
  for (const match of codes) {
    pushPlain(cursor, match.index);
    spans.push(rowTextSpan(match[0], true));
    cursor = match.index + match[0].length;
  }
  pushPlain(cursor, value.length);
  element.textContent = '';
  for (const span of spans) element.appendChild(span);
}

/** Layer row presentation over supplied state and actions; no layer imports. */
export class LayerPanel {
  constructor({
    getLayers,
    isEnabled,
    setEnabled,
    setLayerParams,
    getRowControls,
    hasRowControls,
    subscribeRowControls,
    onHiddenRefresh = () => {},
    weatherClock,
  }) {
    this.weatherClock = weatherClock;
    this.getAll = getLayers;
    this.isEnabled = isEnabled;
    this.setEnabled = setEnabled;
    this.setLayerParams = setLayerParams;
    this._rowControlsFor = getRowControls;
    this.hasRowControls = hasRowControls;
    this.subscribeRowControls = subscribeRowControls;
    this.onHiddenRefresh = onHiddenRefresh;
    this._generation = 0;
    this._removers = [];
    this._destroyed = false;
    this._cancelRowControlsRefresh = null;
    this._recentImageryFactory = null;
    this._recentImageryPanel = null;
  }
  mount(container) {
    if (this._destroyed) return;
    this._releaseBindings();
    this._toggleContainer = container;
    this._weatherPanel?.destroy();
    this._weatherPanel = createWeatherPanel({
      clock: this.weatherClock,
      container:
        container?.ownerDocument?.getElementById?.('weather-panel-body'),
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
  _bind(element, type, listener) {
    element.addEventListener(type, listener);
    this._removers.push(() => element.removeEventListener(type, listener));
  }
  _releaseBindings() {
    this._generation++;
    this._cancelRowControlsRefresh?.();
    this._cancelRowControlsRefresh = null;
    for (const remove of this._removers.splice(0)) remove();
  }
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this._releaseBindings();
    this._weatherPanel?.destroy();
    this._weatherPanel = null;
    this._recentImageryPanel?.destroy();
    this._recentImageryPanel = null;
    this._recentImageryFactory = null;
    this._toggleContainer = null;
  }
  _renderToggles() {
    if (this._destroyed || !this._toggleContainer) return;
    this._releaseBindings();
    this._toggleContainer.innerHTML = '';

    const generation = this._generation;
    const layers = this.getAll()
      .slice()
      .sort(
        (a, b) =>
          (PANEL_POSITIONS.get(a.id) ?? PANEL_ORDER.length) -
          (PANEL_POSITIONS.get(b.id) ?? PANEL_ORDER.length),
      );
    let previousGroup = '';
    for (const layer of layers) {
      if (!layer.showInTogglePanel) continue;
      const group =
        PANEL_ORDER[PANEL_POSITIONS.get(layer.id)]?.label ??
        msg('Other layers');
      if (group && group !== previousGroup) {
        const heading = document.createElement('h3');
        heading.className = 'data-layer-group-heading';
        heading.textContent = t(group);
        this._toggleContainer.appendChild(heading);
      }
      previousGroup = group;
      const row = document.createElement('div');
      row.className = 'data-toggle-row';
      row.dataset.layerId = layer.id;
      // English name for voice tools, which must not receive translated text.
      row.dataset.layerName = englishPanelLabel(layer);

      const topRow = document.createElement('div');
      topRow.className = 'data-toggle-top';

      const left = document.createElement('div');
      left.className = 'data-toggle-left';
      const icon = document.createElement('span');
      icon.className = 'data-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = layer.icon;
      const name = document.createElement('span');
      name.className = 'data-name';
      setRowText(name, panelLabel(layer));
      left.appendChild(icon);
      left.appendChild(name);

      const right = document.createElement('div');
      right.className = 'data-toggle-right';

      const count = document.createElement('span');
      count.className = 'data-count';
      this._syncCount(row, count, layer.stats);

      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = `data-toggle-btn${layer.enabled ? ' active' : ''}`;
      this._syncToggleButton(toggle, layer);
      this._bind(toggle, 'click', async () => {
        // Native `disabled` immediately evicts keyboard focus in Chromium. Keep
        // the lifecycle control focusable while it is busy, and enforce the
        // same single-flight interaction contract through ARIA instead.
        if (
          this._destroyed ||
          this._generation !== generation ||
          toggle.getAttribute('aria-disabled') === 'true'
        )
          return;
        toggle.setAttribute('aria-disabled', 'true');
        toggle.setAttribute('aria-busy', 'true');
        try {
          await this.setEnabled(layer.id, !this.isEnabled(layer.id), {
            origin: 'user',
          });
        } catch (error) {
          console.warn(`[Data] ${layer.id} toggle error:`, error);
        } finally {
          const current = this.getAll().find(({ id }) => id === layer.id);
          if (!this._destroyed && current && this._generation === generation)
            this._syncToggleButton(toggle, current);
        }
      });

      const readout = Boolean(this._rowControlsFor(layer.id)?.readout);
      if (!readout) right.appendChild(count);
      right.appendChild(toggle);
      topRow.appendChild(left);
      topRow.appendChild(right);

      const bottomRow = document.createElement('div');
      bottomRow.className = 'data-toggle-meta';
      setRowText(bottomRow, this._buildMetaText(layer));

      row.appendChild(topRow);
      row.appendChild(bottomRow);

      // Optional per-layer sub-controls (chips + color legend). The click
      // listener is delegated and attached once here, so it survives
      // _refreshTogglePanel — which only rewrites the container's contents.
      if (this.hasRowControls(layer.id)) {
        // A layer whose controls settle asynchronously (a chunked catalog load
        // that can also fail) pushes a re-render through this; nothing else
        // would repaint the row before its next scheduled refresh.
        const unsubscribe = this.subscribeRowControls(layer.id, () =>
          this._scheduleRowControlsRefresh(),
        );
        if (unsubscribe) this._removers.push(unsubscribe);
        if (!readout) {
          const controls = document.createElement('div');
          controls.className = 'data-toggle-controls';
          this._bind(controls, 'click', (event) => {
            const button = event.target?.closest?.('.data-toggle-chip');
            if (!button || button.disabled) return;
            // Re-read the live descriptor rather than trusting the rendered
            // chip, so a stale row can never apply an inverted toggle.
            const chip = this._rowControlsFor(layer.id)?.chips?.find(
              (entry) => entry.id === button.dataset.chipId,
            );
            if (!chip || chip.disabled || !this.isEnabled(layer.id)) return;
            if (typeof chip.onClick === 'function') chip.onClick();
            else if (chip.params)
              this.setLayerParams(layer.id, chip.params, { origin: 'user' });
          });
          row.appendChild(controls);
          // An ordered list below the chips, for a layer whose row carries a
          // sequence (turn-by-turn directions). Its own delegated listener, its
          // own container — the chip row stays a chip row.
          const list = document.createElement('ol');
          list.className = 'data-row-list';
          list.hidden = true;
          this._bind(list, 'click', (event) => {
            const button = event.target?.closest?.('.data-row-list-item');
            if (!button || button.disabled) return;
            const item = this._rowControlsFor(layer.id)?.list?.items?.find(
              (entry) => entry.id === button.dataset.listItemId,
            );
            if (item?.params)
              this.setLayerParams(layer.id, item.params, { origin: 'user' });
          });
          row.appendChild(list);
          this._syncRowControls(controls, layer, list);
        }
      }

      this._toggleContainer.appendChild(row);
    }
    this._refreshWeatherPanel();
  }

  _scheduleRowControlsRefresh() {
    if (this._destroyed || this._cancelRowControlsRefresh) return;
    const refresh = () => {
      this._cancelRowControlsRefresh = null;
      if (!this._destroyed) this._refreshTogglePanel();
    };
    if (typeof requestAnimationFrame === 'function') {
      const frame = requestAnimationFrame(refresh);
      this._cancelRowControlsRefresh = () => cancelAnimationFrame(frame);
    } else {
      const timer = setTimeout(refresh, 0);
      this._cancelRowControlsRefresh = () => clearTimeout(timer);
    }
  }

  /** Synchronously flush a pending row-controls refresh, including in tests. */
  _flushRowControlsRefresh() {
    if (this._destroyed || !this._cancelRowControlsRefresh) return;
    this._cancelRowControlsRefresh();
    this._cancelRowControlsRefresh = null;
    this._refreshTogglePanel();
  }

  _refreshWeatherPanel() {
    this._weatherPanel?.update(
      this.getAll()
        .filter(
          (layer) =>
            layer.enabled &&
            [
              'wind',
              'weather-radar',
              'weather-satellite',
              'weather-lightning',
              'weather-cyclones',
              'air-quality',
            ].includes(layer.id),
        )
        .map((layer) => ({
          id: layer.id,
          icon: layer.icon,
          ...this._rowControlsFor(layer.id),
        })),
    );
  }

  /**
   * Write a row's count. Outside English a count phrase ("24 nearby · 2 on
   * screen") gets its own line, or it squeezes a longer translated name to a
   * word per line. "—" is marked so a wide status chip can replace it
   * (radio.css).
   */
  _syncCount(row, count, stats) {
    const text = this._layerCountText(stats);
    setRowText(count, text);
    const phrase =
      getLocale() !== 'en' &&
      typeof stats.countLabel === 'string' &&
      /\d/.test(stats.countLabel);
    row.classList.toggle('data-toggle-row--count-line', phrase);
    count.classList.toggle('data-count-empty', text === '—');
  }

  /** Qualify a loaded count when it does not mean items currently on screen. */
  _layerCountText(stats) {
    if (typeof stats.countLabel === 'string' && stats.countLabel.trim())
      return stats.countLabel;
    return stats.count ? this._formatCount(stats.count) : '—';
  }

  /**
   * Render a layer's row chips and color legend, and keep the whole block
   * hidden while the layer is off (or while a dependency owner has surrendered
   * it) so a quiet row stays quiet.
   *
   * Chip BUTTONS are reconciled in place, keyed by chip id, rather than
   * rebuilt: this runs on every panel refresh — including the one the chip's
   * own click triggers — and replacing the node would drop keyboard focus
   * mid-interaction. Legend entries are rebuilt only when their content changes;
   * the info node is retained across refreshes.
   * @param {HTMLElement|null} container The row's `.data-toggle-controls` node.
   * @param {object} layer Registered layer entry.
   * @param {HTMLElement|null} [listContainer] The row's `.data-row-list` node.
   */
  _syncRowControls(container, layer, listContainer = null) {
    if (!container) return;
    const controls = layer.enabled ? this._rowControlsFor(layer.id) : null;
    if (controls?.readout) {
      container.remove();
      listContainer?.remove();
      return;
    }
    const chips = controls?.chips || [];
    const legend = controls?.legend || [];
    const infoText = controls?.info;
    this._syncRowList(listContainer, controls?.list || null);
    container.hidden = chips.length === 0 && legend.length === 0 && !infoText;

    const info = container._rowControlsInfo || null;
    const firstLegend = container.querySelector('.data-toggle-legend-item');

    syncChipGroup(container, chips, { before: firstLegend || info });

    const legendSignature = JSON.stringify(
      legend.map(({ label, color, count, blurb }) => [
        label,
        color,
        count,
        blurb,
      ]),
    );
    if (container._legendSignature !== legendSignature) {
      for (const node of [...container.children]) {
        if (node.className === 'data-toggle-legend-item') node.remove();
      }
      for (const item of legend) {
        const entry = document.createElement('span');
        entry.className = 'data-toggle-legend-item';
        if (item.blurb) entry.title = item.blurb;
        const swatch = document.createElement('span');
        swatch.className = 'data-toggle-legend-swatch';
        swatch.style.background = item.color;
        const text = document.createElement('span');
        text.textContent =
          item.count == null
            ? String(item.label)
            : `${item.label} ${this._formatCount(item.count)}`;
        entry.append(swatch, text);
        container.insertBefore(entry, info);
      }
      container._legendSignature = legendSignature;
    }
    if (infoText || info) {
      const node = info || document.createElement('div');
      if (!info) {
        container.appendChild(node);
        container._rowControlsInfo = node;
      }
      const className = 'data-toggle-controls-info';
      if (node.className !== className) node.className = className;
      const text = infoText ? String(infoText) : '';
      const title = controls?.infoTitle || '';
      if (node.textContent !== text) node.textContent = text;
      if (node.title !== title) node.title = title;
      const hidden = !text;
      if (node.hidden !== hidden) node.hidden = hidden;
    }
  }

  /**
   * Render a row's ordered list (turn-by-turn directions).
   *
   * Each entry is a real `<button>` inside a real `<li>`, so Tab reaches it and
   * Enter activates it with no key handling of our own, and the `<ol>` carries
   * the ordering a screen reader announces. Items are reconciled in place,
   * keyed by id, for the same reason chips are: this runs on every refresh —
   * including the one a click on the list triggers — and replacing the node
   * would drop keyboard focus mid-interaction.
   * @param {HTMLElement|null} container The row's `.data-row-list` node.
   * @param {{ariaLabel?: string, items?: Array<object>}|null} list Descriptor.
   */
  _syncRowList(container, list) {
    syncRowList(container, list);
  }

  _refreshTogglePanel() {
    if (this._destroyed || !this._toggleContainer) return;
    // Skip DOM churn while hidden; visibilitychange (main.js) triggers one
    // refresh on return. (perf wave 2)
    if (typeof document !== 'undefined' && document.hidden) {
      this.onHiddenRefresh();
      return;
    }
    for (const layer of this.getAll()) {
      const row = this._toggleContainer.querySelector(
        `[data-layer-id="${layer.id}"]`,
      );
      if (!row) continue;

      const btn = row.querySelector('.data-toggle-btn');
      if (btn) {
        this._syncToggleButton(btn, layer);
      }

      const count = row.querySelector('.data-count');
      if (count) {
        this._syncCount(row, count, layer.stats);
      }

      const meta = row.querySelector('.data-toggle-meta');
      if (meta) {
        setRowText(meta, this._buildMetaText(layer));
      }

      this._syncRowControls(
        row.querySelector('.data-toggle-controls'),
        layer,
        row.querySelector('.data-row-list'),
      );
    }
    this._refreshWeatherPanel();
  }

  _buildMetaText(layer) {
    const stats = layer.stats || {};
    const feedState = layerFeedState(stats);
    const stateLabel = t(FEED_STATE_LABEL_KEYS[feedState]);
    const source = sourceLabel(stats.source || layer.source);
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
      return `${source} · ${translateKnown(stats.statusMessage.trim())}`;
    }
    const ago = stats.lastUpdate ? this._timeAgo(stats.lastUpdate) : t('never');
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
      if (typeof stats.retryInSec === 'number' && stats.retryInSec > 0) {
        return t('{state} · {source} · {ago} · retrying in {seconds}s', {
          state: stateLabel,
          source,
          ago,
          seconds: stats.retryInSec,
        });
      }
      return t('{state} · {source} · {ago}', {
        state: stateLabel,
        source,
        ago,
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

  _syncToggleButton(button, layer) {
    const unavailable = layer.stats?.sourceUnavailable === true;
    const feedState = unavailable
      ? 'unavailable'
      : layer.enabled
        ? layerFeedState(layer.stats)
        : 'off';
    const transitioning =
      layer.lifecycleState === 'enabling' ||
      layer.lifecycleState === 'disabling';
    const uncertain = Boolean(layer.lifecycleUncertain);
    button.classList.toggle('active', layer.enabled);
    button.classList.toggle('transitioning', transitioning);
    button.classList.toggle('enabling', layer.lifecycleState === 'enabling');
    button.classList.toggle('disabling', layer.lifecycleState === 'disabling');
    button.classList.toggle('lifecycle-uncertain', uncertain);
    for (const state of Object.keys(FEED_STATE_LABEL_KEYS)) {
      button.classList.toggle(
        `feed-${state}`,
        (layer.enabled || unavailable) && !uncertain && feedState === state,
      );
    }
    button.dataset.feedState = transitioning
      ? layer.lifecycleState
      : uncertain
        ? 'uncertain'
        : feedState;
    // A busy toggle remains the keyboard focus owner. `aria-disabled` plus the
    // click guard above prevents repeat activation without the focus loss caused
    // by native `disabled`.
    button.disabled = false;
    button.setAttribute(
      'aria-disabled',
      String(transitioning || (unavailable && !layer.enabled)),
    );
    button.setAttribute('aria-busy', String(transitioning));
    const showsFeedState =
      !transitioning && !uncertain && (layer.enabled || unavailable);
    const stateText = transitioning
      ? lifecycleStateLabel(layer.lifecycleState)
      : uncertain
        ? t('UNCERTAIN')
        : showsFeedState
          ? t(FEED_STATE_LABEL_KEYS[feedState])
          : t('OFF');
    // The chip may abbreviate where a language's word is wider than the
    // status column; the meta line and the accessible name keep the full word.
    button.textContent =
      showsFeedState && feedState === 'unavailable'
        ? t('UNAVAILABLE', { context: 'status chip' })
        : stateText;
    const keyGuidance = unavailable
      ? String(
          translateFeedError(layer.stats.error) || t('Data source unavailable'),
        )
      : layerKeyRequirementTooltip(layer);
    // Name the missing key on the control itself: a row reading KEY REQUIRED
    // without saying WHICH key leaves a dead control and no next step. Empty
    // when the layer needs no key, or already has one.
    button.title = keyGuidance;
    const ariaLabel = t('{name}: {state}', {
      name: panelLabel(layer),
      state: stateText,
    });
    button.setAttribute(
      'aria-label',
      keyGuidance ? `${ariaLabel}. ${keyGuidance}` : ariaLabel,
    );
  }

  _formatCount(n) {
    if (n >= 1000)
      return `${formatNumber(n / 1000, {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
        useGrouping: false,
      })}K`;
    return String(n);
  }

  _timeAgo(timestamp) {
    const diff = Math.floor((Date.now() - timestamp) / 1000);
    if (diff < 5) return t('just now');
    if (diff < 60) return t('{count}s ago', { count: diff });
    if (diff < 3600) return t('{count}m ago', { count: Math.floor(diff / 60) });
    return t('{count}h ago', { count: Math.floor(diff / 3600) });
  }
}
