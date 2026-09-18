import { layerFeedState } from '../data/feedState.js';
export { layerFeedState } from '../data/feedState.js';
import { GUIDANCE_STATUSES } from '../loadingFeedback.js';
import { keySetupRequirement } from '../keySetupCore.mjs';
const FEED_STATE_LABELS = Object.freeze({
  nominal: 'ON',
  loading: 'LOADING',
  degraded: 'DEGRADED',
  stale: 'STALE',
  partial: 'PARTIAL',
  fallback: 'FALLBACK',
  unavailable: 'UNAVAILABLE',
});

// Presentation order is independent of catalog registration and startup order.
const PANEL_GROUPS = [
  {
    label: 'Movement',
    ids: [
      'satellites',
      'flights',
      'military',
      'ais-live-vessels',
      'traffic',
      'transit',
      'bikeshare',
    ],
  },
  {
    label: 'Cameras',
    ids: ['cctv', 'alpr-cameras'],
  },
  {
    label: 'Infrastructure',
    ids: [
      'military-installations',
      'local-datacenters',
      'telegeography-submarine-cables',
      'local-dams',
    ],
  },
  {
    label: 'Events',
    ids: ['rocket-launches', 'earthquakes', 'fireballs', 'local-firms'],
  },
  {
    label: 'Utilities',
    ids: ['directions', 'radio'],
  },
];
const PANEL_ORDER = PANEL_GROUPS.flatMap(({ label, ids }) =>
  ids.map((id) => ({ id, label })),
);
const PANEL_POSITIONS = new Map(
  PANEL_ORDER.map(({ id }, index) => [id, index]),
);
const PANEL_LABELS = {
  'ais-live-vessels': 'Live Vessels',
  bikeshare: 'Bike Share',
  cctv: 'Cameras',
  'alpr-cameras': 'Mapped ALPR Cameras',
  'local-datacenters': 'Data Centers',
  'local-firms': 'Active Fires',
};

function panelLabel(layer) {
  return PANEL_LABELS[layer.id] || layer.name;
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
  return requiresKeyId ? keySetupRequirement(requiresKeyId) : '';
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
  }) {
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
  }
  mount(container) {
    if (this._destroyed) return;
    this._releaseBindings();
    this._toggleContainer = container;
    this._renderToggles();
  }
  _bind(element, type, listener) {
    element.addEventListener(type, listener);
    this._removers.push(() => element.removeEventListener(type, listener));
  }
  _releaseBindings() {
    this._generation++;
    for (const remove of this._removers.splice(0)) remove();
  }
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this._releaseBindings();
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
        PANEL_ORDER[PANEL_POSITIONS.get(layer.id)]?.label ?? 'Other layers';
      if (group && group !== previousGroup) {
        const heading = document.createElement('h3');
        heading.className = 'data-layer-group-heading';
        heading.textContent = group;
        this._toggleContainer.appendChild(heading);
      }
      previousGroup = group;
      const row = document.createElement('div');
      row.className = 'data-toggle-row';
      row.dataset.layerId = layer.id;

      const topRow = document.createElement('div');
      topRow.className = 'data-toggle-top';

      const left = document.createElement('div');
      left.className = 'data-toggle-left';
      const icon = document.createElement('span');
      icon.className = 'data-icon';
      icon.textContent = layer.icon;
      const name = document.createElement('span');
      name.className = 'data-name';
      name.textContent = panelLabel(layer);
      left.appendChild(icon);
      left.appendChild(name);

      const right = document.createElement('div');
      right.className = 'data-toggle-right';

      const count = document.createElement('span');
      count.className = 'data-count';
      count.textContent = this._layerCountText(layer.stats);

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

      right.appendChild(count);
      right.appendChild(toggle);
      topRow.appendChild(left);
      topRow.appendChild(right);

      const bottomRow = document.createElement('div');
      bottomRow.className = 'data-toggle-meta';
      bottomRow.textContent = this._buildMetaText(layer);

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
          this._refreshTogglePanel(),
        );
        if (unsubscribe) this._removers.push(unsubscribe);
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

      this._toggleContainer.appendChild(row);
    }
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
   * mid-interaction. Legend entries hold no focus and no listeners, so they
   * are replaced freely.
   * @param {HTMLElement|null} container The row's `.data-toggle-controls` node.
   * @param {object} layer Registered layer entry.
   * @param {HTMLElement|null} [listContainer] The row's `.data-row-list` node.
   */
  _syncRowControls(container, layer, listContainer = null) {
    if (!container) return;
    const controls = layer.enabled ? this._rowControlsFor(layer.id) : null;
    const chips = controls?.chips || [];
    const legend = controls?.legend || [];
    this._syncRowList(listContainer, controls?.list || null);
    container.hidden = chips.length === 0 && legend.length === 0;

    for (const node of [...container.children]) {
      if (
        String(node.className).split(/\s+/).includes('data-toggle-legend-item')
      )
        node.remove();
    }

    const stale = new Map();
    for (const node of [...container.children]) {
      if (node.dataset?.chipId) stale.set(node.dataset.chipId, node);
    }

    for (const chip of chips) {
      let button = stale.get(chip.id);
      stale.delete(chip.id);
      if (!button) {
        button = document.createElement('button');
        button.type = 'button';
        button.dataset.chipId = chip.id;
        container.appendChild(button);
      }
      const state = chip.state || (chip.active ? 'active' : 'idle');
      button.className = `data-toggle-chip chip-${state}${chip.active ? ' active' : ''}`;
      if (button.textContent !== chip.label) button.textContent = chip.label;
      button.title = chip.title || '';
      button.disabled = Boolean(chip.disabled);
      button.setAttribute('aria-pressed', chip.active ? 'true' : 'false');
      button.setAttribute('aria-busy', chip.busy ? 'true' : 'false');
    }
    for (const node of stale.values()) node.remove();

    for (const item of legend) {
      const entry = document.createElement('span');
      entry.className = 'data-toggle-legend-item';
      if (item.blurb) entry.title = item.blurb;
      const swatch = document.createElement('span');
      swatch.className = 'data-toggle-legend-swatch';
      swatch.style.background = item.color;
      const text = document.createElement('span');
      text.textContent = `${item.label} ${this._formatCount(item.count)}`;
      entry.append(swatch, text);
      container.appendChild(entry);
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
    if (!container) return;
    const items = list?.items || [];
    container.hidden = items.length === 0;
    if (list?.ariaLabel) container.setAttribute('aria-label', list.ariaLabel);

    const stale = new Map();
    for (const node of [...container.children]) {
      if (node.dataset?.listItemId) stale.set(node.dataset.listItemId, node);
    }
    let previous = null;
    let activeButton = null;
    for (const item of items) {
      let entry = stale.get(item.id);
      stale.delete(item.id);
      let button;
      if (!entry) {
        entry = document.createElement('li');
        entry.dataset.listItemId = item.id;
        button = document.createElement('button');
        button.type = 'button';
        button.className = 'data-row-list-item';
        button.dataset.listItemId = item.id;
        const lead = document.createElement('span');
        lead.className = 'data-row-list-lead';
        const text = document.createElement('span');
        text.className = 'data-row-list-text';
        button.append(lead, text);
        entry.appendChild(button);
      } else {
        button = entry.querySelector('.data-row-list-item');
      }
      // Keep DOM order in step with descriptor order without rebuilding.
      const anchor = previous ? previous.nextSibling : container.firstChild;
      if (entry !== anchor) container.insertBefore(entry, anchor);
      previous = entry;
      if (!button) continue;
      const lead = button.querySelector('.data-row-list-lead');
      const text = button.querySelector('.data-row-list-text');
      const leadText = String(item.lead ?? '');
      const bodyText = String(item.text ?? '');
      if (lead && lead.textContent !== leadText) lead.textContent = leadText;
      if (text && text.textContent !== bodyText) text.textContent = bodyText;
      button.disabled = Boolean(item.disabled);
      button.classList.toggle('note', Boolean(item.disabled));
      button.classList.toggle('active', Boolean(item.active));
      button.classList.toggle('current', Boolean(item.current));
      button.setAttribute('aria-current', item.current ? 'step' : 'false');
      button.setAttribute('aria-pressed', item.active ? 'true' : 'false');
      button.title = bodyText;
      if (item.current) activeButton = button;
    }
    for (const node of stale.values()) node.remove();
    // Follow the flight, but never steal a scroll the reader is making
    // themselves: only when the step actually changed.
    if (
      activeButton &&
      container.dataset.currentId !== activeButton.dataset.listItemId
    ) {
      container.dataset.currentId = activeButton.dataset.listItemId;
      activeButton.scrollIntoView?.({ block: 'nearest' });
    } else if (!activeButton) {
      delete container.dataset.currentId;
    }
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
        count.textContent = this._layerCountText(layer.stats);
      }

      const meta = row.querySelector('.data-toggle-meta');
      if (meta) {
        meta.textContent = this._buildMetaText(layer);
      }

      this._syncRowControls(
        row.querySelector('.data-toggle-controls'),
        layer,
        row.querySelector('.data-row-list'),
      );
    }
  }

  _buildMetaText(layer) {
    const stats = layer.stats || {};
    const feedState = layerFeedState(stats);
    const stateLabel = FEED_STATE_LABELS[feedState];
    const source = stats.source || layer.source;
    const lifecycleState =
      layer.lifecycleState || (layer.enabled ? 'enabled' : 'disabled');
    if (lifecycleState === 'enabling' || lifecycleState === 'disabling') {
      return `${lifecycleState.toUpperCase()} · ${source}`;
    }
    if (layer.lifecycleUncertain) {
      return `UNCERTAIN · ${source} · lifecycle state requires reconciliation`;
    }
    const presentedError =
      stats.error || stats.lastError || stats.managerRefreshError;
    if (presentedError) {
      if (typeof stats.retryInSec === 'number' && stats.retryInSec > 0) {
        return `${stateLabel} · ${source} · ${presentedError} · retry ${stats.retryInSec}s`;
      }
      return `${stateLabel} · ${source} · ${presentedError}`;
    }
    // A guidance status carries its prompt in `statusMessage`, not `error`, so
    // the row still tells the operator what to do without reporting a fault.
    if (
      GUIDANCE_STATUSES.includes(String(stats.status || '').toLowerCase()) &&
      typeof stats.statusMessage === 'string' &&
      stats.statusMessage.trim()
    ) {
      return `${source} · ${stats.statusMessage.trim()}`;
    }
    const ago = stats.lastUpdate ? this._timeAgo(stats.lastUpdate) : 'never';
    if (stats.loading) {
      const loadingLabel =
        typeof stats.loadingLabel === 'string' && stats.loadingLabel.trim()
          ? stats.loadingLabel.trim()
          : 'loading...';
      return `${source} · ${loadingLabel}`;
    }
    if (feedState === 'fallback') {
      const detail =
        typeof stats.loadingLabel === 'string' && stats.loadingLabel.trim()
          ? stats.loadingLabel.trim()
          : stats.coverage || ago;
      return `${stateLabel} · ${source} · ${detail}`;
    }
    if (feedState === 'partial') {
      const { acceptedRowCount, rawRowCount } = stats;
      const detail =
        Number.isInteger(acceptedRowCount) &&
        Number.isInteger(rawRowCount) &&
        acceptedRowCount >= 0 &&
        rawRowCount > acceptedRowCount
          ? `${acceptedRowCount} of ${rawRowCount} records accepted`
          : 'incomplete snapshot';
      return `${stateLabel} · ${source} · ${detail} · ${ago}`;
    }
    if (feedState === 'stale') {
      const retry =
        typeof stats.retryInSec === 'number' && stats.retryInSec > 0
          ? ` · retrying in ${stats.retryInSec}s`
          : '';
      return `${stateLabel} · ${source} · ${ago}${retry}`;
    }
    if (typeof stats.loadingLabel === 'string' && stats.loadingLabel.trim()) {
      return `${source} · ${stats.loadingLabel.trim()}`;
    }
    return `${source} · ${ago}`;
  }

  _syncToggleButton(button, layer) {
    const feedState = layer.enabled ? layerFeedState(layer.stats) : 'off';
    const transitioning =
      layer.lifecycleState === 'enabling' ||
      layer.lifecycleState === 'disabling';
    const uncertain = Boolean(layer.lifecycleUncertain);
    button.classList.toggle('active', layer.enabled);
    button.classList.toggle('transitioning', transitioning);
    button.classList.toggle('enabling', layer.lifecycleState === 'enabling');
    button.classList.toggle('disabling', layer.lifecycleState === 'disabling');
    button.classList.toggle('lifecycle-uncertain', uncertain);
    for (const state of Object.keys(FEED_STATE_LABELS)) {
      button.classList.toggle(
        `feed-${state}`,
        layer.enabled && !uncertain && feedState === state,
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
    button.setAttribute('aria-disabled', String(transitioning));
    button.setAttribute('aria-busy', String(transitioning));
    button.textContent = transitioning
      ? layer.lifecycleState.toUpperCase()
      : uncertain
        ? 'UNCERTAIN'
        : layer.enabled
          ? FEED_STATE_LABELS[feedState]
          : 'OFF';
    const keyGuidance = layerKeyRequirementTooltip(layer);
    // Name the missing key on the control itself: a row reading KEY REQUIRED
    // without saying WHICH key leaves a dead control and no next step. Empty
    // when the layer needs no key, or already has one.
    button.title = keyGuidance;
    button.setAttribute(
      'aria-label',
      keyGuidance
        ? `${panelLabel(layer)}: ${button.textContent}. ${keyGuidance}`
        : `${panelLabel(layer)}: ${button.textContent}`,
    );
  }

  _formatCount(n) {
    if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
    return String(n);
  }

  _timeAgo(timestamp) {
    const diff = Math.floor((Date.now() - timestamp) / 1000);
    if (diff < 5) return 'just now';
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    return `${Math.floor(diff / 3600)}h ago`;
  }
}
