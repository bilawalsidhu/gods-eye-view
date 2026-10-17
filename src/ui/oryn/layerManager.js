// Layer manager drawer: a searchable, grouped view of every layer the engine
// registered, toggled through the engine's own lifecycle (no duplicate
// fetch loops). Each row shows source, state, last retrieval and record
// count exactly as the engine reports them.
import { t, msg } from '../../i18n/index.js';

import { el, button, chip, replaceChildren, emptyState } from './dom.js';
import { feedStateDescription } from './provenance.js';
import { localizeLayerName } from '../layerNames.js';

/** Domain grouping for the ORYN manager; ids not listed fall into "Other". */
export const LAYER_GROUPS = Object.freeze([
  {
    id: 'aircraft',
    label: msg('Aircraft'),
    ids: ['flights', 'military', 'local-adsb', 'military-awareness'],
  },
  {
    id: 'maritime',
    label: msg('Maritime'),
    ids: ['ais-live-vessels', 'telegeography-submarine-cables'],
  },
  {
    id: 'space',
    label: msg('Space'),
    ids: ['satellites', 'rocket-launches', 'gnss-integrity'],
  },
  {
    id: 'hazards',
    label: msg('Hazards and environment'),
    ids: [
      'earthquakes',
      'local-firms',
      'fire-perimeters',
      'weather-cyclones',
      'air-quality',
    ],
  },
  {
    id: 'weather',
    label: msg('Weather'),
    ids: ['wind', 'weather-radar', 'weather-satellite', 'weather-lightning'],
  },
  {
    id: 'cameras',
    label: msg('Cameras and imagery'),
    ids: ['cctv', 'alpr-cameras', 'street-level', 'recent-imagery'],
  },
  {
    id: 'transport',
    label: msg('Transportation'),
    ids: ['traffic', 'transit', 'bikeshare', 'directions'],
  },
  {
    id: 'infrastructure',
    label: msg('Infrastructure'),
    ids: ['military-installations', 'local-datacenters', 'local-dams'],
  },
  {
    id: 'scenes',
    label: msg('Scenes and utilities'),
    ids: ['radio', 'bhote-koshi-2026', 'bhote-koshi-locator'],
  },
]);

/** Consistent swatch per group used by the manager, legend and inspector. */
export const GROUP_SWATCHES = Object.freeze({
  aircraft: '#4f9cf9',
  maritime: '#22d3ee',
  space: '#a78bfa',
  hazards: '#f97316',
  weather: '#60a5fa',
  cameras: '#f472b6',
  transport: '#34c77b',
  infrastructure: '#f2b134',
  scenes: '#94a3b8',
  other: '#94a3b8',
});

export function groupForLayer(id) {
  return LAYER_GROUPS.find((group) => group.ids.includes(id))?.id ?? 'other';
}

export function createLayerManager({ engine }) {
  const root = document.getElementById('oryn-layers');
  let query = '';
  let unsubscribe = null;
  let pending = new Set();

  const search = el('input', {
    className: 'oryn-input',
    attrs: {
      type: 'search',
      placeholder: t('Filter layers'),
      'aria-label': t('Filter layers'),
    },
    on: {
      input: (event) => {
        query = event.target.value.trim().toLowerCase();
        render();
      },
    },
  });
  const list = el('div', { className: 'oryn-panel-body' });
  const header = el(
    'div',
    { className: 'oryn-panel-header' },
    el('span', { className: 'oryn-panel-title', text: t('LAYER MANAGER') }),
    el(
      'div',
      { className: 'oryn-actions' },
      button({
        label: t('Clear all'),
        iconName: 'trash',
        className: 'oryn-btn-sm oryn-btn-ghost',
        onClick: async () => {
          const current = engine();
          if (!current) return;
          try {
            await current.dataManager.clearSelectedLayers({ origin: 'user' });
          } catch (error) {
            console.warn('[ORYN] clear layers', error);
          }
        },
      }),
      button({
        iconName: 'close',
        className: 'oryn-btn-ghost oryn-btn-icon',
        title: t('Close layer manager'),
        onClick: () => setOpen(false),
      }),
    ),
  );
  replaceChildren(
    root,
    header,
    el('div', { className: 'oryn-layer-search' }, search),
    list,
  );

  function setOpen(open) {
    root.hidden = !open;
    if (open) render();
  }

  function row(feed) {
    const groupId = groupForLayer(feed.id);
    const name = el(
      'div',
      { className: 'oryn-layer-name' },
      el('span', { attrs: { 'aria-hidden': 'true' } }),
      el('span', { text: localizeLayerName(feed.name) }),
    );
    name.firstChild.style.setProperty('--swatch', GROUP_SWATCHES[groupId]);
    const busy = pending.has(feed.id);
    const blocked = feed.state === 'unavailable' && !feed.enabled;
    const toggle = el('button', {
      className: 'oryn-switch',
      attrs: {
        type: 'button',
        role: 'switch',
        'aria-checked': String(feed.enabled),
        'aria-busy': busy ? 'true' : null,
        'aria-disabled': blocked ? 'true' : null,
        'aria-label': t('Toggle {name}', { name: feed.name }),
        title: blocked ? feed.error || feedStateDescription(feed.state) : null,
      },
      on: {
        click: async () => {
          const current = engine();
          if (!current || busy || blocked) return;
          pending.add(feed.id);
          render();
          try {
            await current.setLayerEnabled(feed.id, !feed.enabled);
          } catch (error) {
            console.warn(`[ORYN] toggle ${feed.id}`, error);
          } finally {
            pending.delete(feed.id);
            render();
          }
        },
      },
    });
    const meta = el(
      'div',
      { className: 'oryn-layer-meta' },
      chip(feed.label, feed.state, { title: feedStateDescription(feed.state) }),
      feed.source ? el('span', { text: feed.source }) : null,
      feed.enabled && feed.lastUpdate
        ? el('span', { text: t('retrieved {age}', { age: feed.ageLabel }) })
        : null,
      feed.enabled
        ? el('span', { text: t('{count} records', { count: feed.count }) })
        : null,
      feed.requiresKeyId ? chip(t('KEY REQUIRED'), 'warn') : null,
    );
    const error =
      feed.error && feed.enabled
        ? el('div', { className: 'oryn-layer-error', text: feed.error })
        : null;
    return el(
      'div',
      { className: 'oryn-layer-row', dataset: { layerId: feed.id } },
      name,
      toggle,
      meta,
      error,
    );
  }

  function render() {
    if (root.hidden) return;
    const current = engine();
    if (!current) {
      replaceChildren(
        list,
        emptyState(
          t('Engine starting'),
          t('Layers appear once the globe has initialized.'),
        ),
      );
      return;
    }
    const feeds = current.feeds().filter((feed) => feed.showInTogglePanel);
    const visible = query
      ? feeds.filter((feed) =>
          `${feed.name} ${feed.source || ''} ${feed.id}`
            .toLowerCase()
            .includes(query),
        )
      : feeds;
    const byId = new Map(visible.map((feed) => [feed.id, feed]));
    const sections = [];
    const placed = new Set();
    for (const group of LAYER_GROUPS) {
      const members = group.ids.filter((id) => byId.has(id));
      if (!members.length) continue;
      sections.push(
        el('h4', { className: 'oryn-layer-group', text: t(group.label) }),
      );
      for (const id of members) {
        sections.push(row(byId.get(id)));
        placed.add(id);
      }
    }
    const rest = visible.filter((feed) => !placed.has(feed.id));
    if (rest.length) {
      sections.push(
        el('h4', { className: 'oryn-layer-group', text: t('Other') }),
      );
      for (const feed of rest) sections.push(row(feed));
    }
    if (!sections.length)
      sections.push(
        emptyState(t('No layers match'), t('Try a different filter.')),
      );
    sections.push(
      el('p', {
        className: 'oryn-note',
        text: t(
          'Only layers with a real implementation are listed. Layers marked KEY REQUIRED stay off until a provider key is configured in Settings.',
        ),
      }),
    );
    replaceChildren(list, sections);
  }

  function attach() {
    unsubscribe?.();
    const current = engine();
    if (!current) return;
    let frame = null;
    unsubscribe = current.subscribeActivity(() => {
      if (root.hidden || frame) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        render();
      });
    });
  }

  return Object.freeze({
    open: () => setOpen(true),
    close: () => setOpen(false),
    toggle: () => setOpen(root.hidden),
    get isOpen() {
      return !root.hidden;
    },
    attach,
    render,
    destroy: () => unsubscribe?.(),
  });
}
