/**
 * DATA LAYERS ▸ Browse data library: the dialog that lists every Data Library
 * entry this build knows, with its licence, coverage and what this instance
 * needs to serve it, and adds or removes it from the panel.
 *
 * A `dialog[data-panel-surface]` per docs/panel-surfaces.md: this module owns
 * width, height, labels, initial and return focus, Escape and dismissal, and
 * closes itself when clean view, recording or Cockpit hides the panels.
 */
import { formatNumber, msg, t, tn } from '../i18n/index.js';

const PANEL_HIDING_MODES = ['ui-clean-view', 'recording-mode', 'cockpit-mode'];
/** How long Remove all stays armed after its first press. */
const RESET_CONFIRM_MS = 4000;
/** How often the open dialog rereads its stat tiles (the panel's own pace). */
const STATS_REFRESH_MS = 1000;

const FAMILY_LABELS = Object.freeze({
  movement: msg('Movement'),
  cameras: msg('Cameras'),
  infrastructure: msg('Infrastructure'),
  events: msg('Events'),
  weather: msg('Weather'),
  environment: msg('Environment'),
  imagery: msg('Imagery'),
  demographics: msg('Demographics'),
});

const KIND_LABELS = Object.freeze({
  dataset: msg('DATASET'),
  tiles: msg('TILES'),
  pack: msg('PACK'),
});

const STATUS_LABELS = Object.freeze({
  incubating: msg('INCUBATING'),
  community: msg('COMMUNITY'),
  verified: msg('VERIFIED'),
  stale: msg('STALE'),
  archived: msg('ARCHIVED'),
});

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function badge(text, tone = '') {
  const node = element(
    'span',
    `data-library-badge${tone ? ` data-library-badge--${tone}` : ''}`,
    text,
  );
  return node;
}

const compact = (value) =>
  formatNumber(value, { notation: 'compact', maximumFractionDigits: 1 });

/**
 * The four stat tiles at the top of Browse: label, value and one line of
 * breakdown each. Text only; nothing here is a data colour.
 * @param {ReturnType<ReturnType<typeof import('../library/controller.js').createDataLibrary>['summary']>} summary
 * @returns {Array<{ id: string, label: string, value: string, detail: string }>}
 */
export function libraryStatTiles(summary) {
  const { kinds } = summary;
  return [
    {
      id: 'entries',
      label: t('Datasets'),
      value: compact(summary.entries),
      detail: t('{datasets} · {tiles} · {packs}', {
        datasets: tn(kinds.dataset, '{count} dataset', '{count} datasets'),
        tiles: tn(kinds.tiles, '{count} tile layer', '{count} tile layers'),
        packs: tn(kinds.pack, '{count} pack', '{count} packs'),
      }),
    },
    {
      id: 'themes',
      label: t('Themes'),
      value: compact(summary.themes.length),
      // The count alone: the theme names are the Theme filter below.
      detail: '',
    },
    {
      id: 'added',
      label: t('Added'),
      value: compact(summary.added),
      detail: summary.added
        ? tn(summary.on, '{count} on the map', '{count} on the map')
        : t('none yet'),
    },
    {
      id: 'features',
      label: t('Map features'),
      value: summary.featureLayers ? compact(summary.features) : '—',
      detail: summary.featureLayers
        ? tn(
            summary.featureLayers,
            'from {count} dataset',
            'from {count} datasets',
          )
        : t('switch on a dataset to load features'),
    },
  ];
}

/** The sentence explaining what this instance needs to serve an entry. */
export function libraryReasonText({ entry, available, reason }) {
  if (entry.kind === 'pack')
    return available
      ? t('Switched on by this instance · part of the CCTV layer')
      : t('Operator opt-in: set {env}=1 on the server', {
          env: entry.pack.env,
        });
  if (available) return '';
  if (reason === 'operator-opt-in')
    return t('Operator opt-in: add {id} to GEV_LIBRARY_ENABLE on the server', {
      id: entry.id,
    });
  if (reason === 'operator-disabled')
    return t("Turned off by this instance's operator");
  if (reason === 'key-missing') return t('Needs a provider key on the server');
  if (reason === 'server-unavailable')
    return t("Needs this app's server · not available in a static build");
  return t('Checking what this instance serves…');
}

function coverageText(entry) {
  const { coverage } = entry;
  if (coverage.global) return t('Global');
  if (coverage.countries?.length) return coverage.countries.join(' · ');
  return t('Regional');
}

const IMAGERY_TYPE_LABELS = Object.freeze({
  ortho: msg('Orthophoto'),
  'satellite-mosaic': msg('Satellite mosaic'),
  oblique: msg('Oblique'),
  historic: msg('Historic imagery'),
});

/**
 * An imagery entry's specs as label/value pairs for its card: what it is,
 * how sharp, when it was flown and how often it is refreshed.
 * @param {object} entry
 * @returns {Array<{ label: string, value: string }>}
 */
export function imagerySpecs(entry) {
  const imagery = entry?.imagery;
  if (!imagery) return [];
  const type =
    imagery.type === 'ortho' && imagery.trueOrtho
      ? t('True orthophoto')
      : t(IMAGERY_TYPE_LABELS[imagery.type]);
  return [
    { label: t('Type'), value: type },
    { label: t('Resolution'), value: imagery.resolution },
    imagery.vintage && { label: t('Flown'), value: imagery.vintage },
    imagery.updateCycle && { label: t('Updates'), value: imagery.updateCycle },
    imagery.orthoQuality && {
      label: t('Ortho quality'),
      value: imagery.orthoQuality,
    },
  ].filter(Boolean);
}

/**
 * Whether a row matches the current filters.
 * @param {{ entry: object, available: boolean, added: boolean }} row
 * @param {{ query: string, family: string, availableOnly: boolean }} filter
 */
export function libraryRowMatches(row, { query, family, availableOnly }) {
  const { entry } = row;
  if (entry.status === 'archived' && !row.added) return false;
  if (family && entry.family !== family) return false;
  if (availableOnly && !row.available) return false;
  const needle = String(query || '')
    .trim()
    .toLocaleLowerCase();
  if (!needle) return true;
  return [
    entry.title,
    entry.provider,
    entry.description,
    entry.id,
    entry.imagery?.resolution,
    ...(entry.coverage.countries || []),
  ]
    .join(' ')
    .toLocaleLowerCase()
    .includes(needle);
}

/**
 * Browse order: what a viewer can add first, then what this instance would
 * need to switch on, then packs (which a host layer owns), each by title.
 * @param {Array<{ entry: object, available: boolean }>} rows
 */
export function sortLibraryRows(rows) {
  const rank = ({ entry, available }) =>
    entry.kind === 'pack' ? 2 : available ? 0 : 1;
  return [...rows].sort(
    (a, b) =>
      rank(a) - rank(b) || a.entry.title.localeCompare(b.entry.title, 'en'),
  );
}

/**
 * @param {{ library: ReturnType<import('../library/controller.js').createDataLibrary>, trigger: HTMLElement|null }} options
 * @returns {{ open: () => void, close: () => void, destroy: () => void }}
 */
export function mountLibraryBrowser({ library, trigger }) {
  const removers = [];
  const listen = (node, type, listener) => {
    node.addEventListener(type, listener);
    removers.push(() => node.removeEventListener(type, listener));
  };
  const filter = { query: '', family: '', availableOnly: false };
  let dialog = null;
  let list = null;
  let status = null;
  let stats = null;
  let statsTimer = null;
  let resetButton = null;
  // Remove all asks twice: the first press arms it for a few seconds.
  let resetArmed = false;
  let resetTimer = null;
  let resetting = false;

  function disarmReset() {
    clearTimeout(resetTimer);
    resetTimer = null;
    resetArmed = false;
  }

  function build() {
    dialog = element('dialog', 'data-library-dialog');
    dialog.id = 'data-library';
    dialog.setAttribute('data-panel-surface', '');
    dialog.setAttribute('aria-labelledby', 'data-library-title');
    dialog.setAttribute('aria-describedby', 'data-library-intro');

    const header = element('header', 'data-library-header');
    header.setAttribute('data-panel-header', '');
    const title = element(
      'h2',
      'panel-title panel-surface-title',
      t('DATA LIBRARY'),
    );
    title.id = 'data-library-title';
    const close = element(
      'button',
      'panel-surface-control data-library-close',
      '×',
    );
    close.type = 'button';
    close.setAttribute('aria-label', t('Close data library'));
    listen(close, 'click', () => api.close());
    header.append(title, close);

    const body = element('div', 'data-library-body');
    body.setAttribute('data-panel-body', '');
    stats = element('dl', 'data-library-stats');
    stats.setAttribute('aria-label', t('Data Library at a glance'));
    const intro = element(
      'p',
      'data-library-intro',
      t(
        'Live sources beyond the core layers. Each one is fetched from its provider while it is on; nothing is stored in this app. Add one and it appears in Data Layers under Library.',
      ),
    );
    intro.id = 'data-library-intro';

    const filters = element('div', 'data-library-filters');
    const searchLabel = element('label', 'data-library-field');
    searchLabel.append(element('span', '', t('Search')));
    const search = element('input', 'panel-surface-control');
    search.type = 'search';
    search.autocomplete = 'off';
    search.placeholder = t('Name, provider or country');
    listen(search, 'input', () => {
      filter.query = search.value;
      render();
    });
    searchLabel.append(search);

    const familyLabel = element('label', 'data-library-field');
    familyLabel.append(element('span', '', t('Theme')));
    const family = element('select', 'panel-surface-control');
    family.append(new Option(t('All themes'), ''));
    for (const [value, label] of Object.entries(FAMILY_LABELS))
      family.append(new Option(t(label), value));
    listen(family, 'change', () => {
      filter.family = family.value;
      render();
    });
    familyLabel.append(family);

    const availableLabel = element('label', 'data-library-check');
    const available = element('input');
    available.type = 'checkbox';
    listen(available, 'change', () => {
      filter.availableOnly = available.checked;
      render();
    });
    availableLabel.append(
      available,
      element('span', '', t('Only what this instance serves')),
    );
    filters.append(searchLabel, familyLabel, availableLabel);

    const toolbar = element('div', 'data-library-toolbar');
    status = element('p', 'data-library-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    resetButton = element('button', 'panel-surface-control data-library-reset');
    resetButton.type = 'button';
    listen(resetButton, 'click', () => {
      if (resetting) return;
      if (!resetArmed) {
        resetArmed = true;
        resetTimer = setTimeout(() => {
          disarmReset();
          render();
        }, RESET_CONFIRM_MS);
        render();
        return;
      }
      disarmReset();
      resetting = true;
      render();
      Promise.resolve(library.reset())
        .catch((error) => console.warn('[Library] reset failed:', error))
        .finally(() => {
          resetting = false;
          render();
          dialog?.querySelector('input[type="search"]')?.focus();
        });
    });
    toolbar.append(status, resetButton);

    list = element('ul', 'data-library-list');
    listen(list, 'click', (event) => {
      const button = event.target?.closest?.('button[data-library-action]');
      if (!button || button.disabled) return;
      const id = button.dataset.libraryId;
      const kind = button.dataset.libraryAction;
      if (kind === 'zoom') {
        // Close first so the flight is visible; focus returns to Browse.
        // An entry that is off is switched on first.
        api.close();
        Promise.resolve(library.zoom(id)).catch((error) =>
          console.warn(`[Library] ${id} zoom failed:`, error),
        );
        return;
      }
      const action = kind === 'add' ? library.add(id) : library.remove(id);
      Promise.resolve(action).catch((error) =>
        console.warn(`[Library] ${id} failed:`, error),
      );
    });

    body.append(stats, intro, filters, toolbar, list);
    dialog.append(header, body);
    listen(dialog, 'cancel', (event) => {
      event.preventDefault();
      api.close();
    });
    // A click on the backdrop (the dialog box itself, outside its content)
    // dismisses, like Escape.
    listen(dialog, 'click', (event) => {
      if (event.target === dialog) api.close();
    });
    document.body.append(dialog);
    return search;
  }

  function renderRow({ entry, available, reason, added, on, busy, canZoom }) {
    const item = element('li', 'data-library-item');
    item.dataset.libraryId = entry.id;
    item.classList.toggle('is-unavailable', !available);

    const head = element('div', 'data-library-item-head');
    const icon = element('span', 'data-library-icon', entry.icon);
    icon.setAttribute('aria-hidden', 'true');
    const name = element('span', 'data-library-name', entry.title);
    const badges = element('span', 'data-library-badges');
    badges.append(badge(t(KIND_LABELS[entry.kind])));
    badges.append(
      badge(
        t(STATUS_LABELS[entry.status]),
        entry.status === 'verified'
          ? 'good'
          : entry.status === 'stale'
            ? 'warn'
            : '',
      ),
    );
    if (entry.licence.operatorOptIn) badges.append(badge(t('OPT-IN'), 'warn'));
    else if (entry.kind !== 'pack' && entry.source.key)
      badges.append(badge(t('KEY'), 'warn'));
    else if (entry.kind !== 'pack') badges.append(badge(t('KEYLESS')));
    head.append(icon, name, badges);

    const description = element('p', 'data-library-description');
    description.textContent = entry.description;

    const meta = element('p', 'data-library-meta');
    const provider = element('span', '', entry.provider);
    provider.setAttribute('translate', 'no');
    const licence = element('a', '', entry.licence.name);
    licence.href = entry.licence.url;
    licence.target = '_blank';
    licence.rel = 'noopener noreferrer';
    meta.append(
      provider,
      document.createTextNode(' · '),
      element('span', '', coverageText(entry)),
      document.createTextNode(' · '),
      licence,
    );

    item.append(head, description);
    const specs = imagerySpecs(entry);
    if (specs.length) {
      const list = element('dl', 'data-library-specs');
      for (const { label, value } of specs) {
        const row = element('div', 'data-library-spec');
        row.append(element('dt', '', label), element('dd', '', value));
        list.append(row);
      }
      item.append(list);
    }
    item.append(meta);
    const note = libraryReasonText({ entry, available, reason });
    if (note) item.append(element('p', 'data-library-reason', note));

    if (entry.kind !== 'pack') {
      const actions = element('div', 'data-library-actions');
      if (added && canZoom) {
        const zoom = element(
          'button',
          'panel-surface-control data-library-action',
          t('ZOOM'),
        );
        zoom.type = 'button';
        zoom.dataset.libraryId = entry.id;
        zoom.dataset.libraryAction = 'zoom';
        zoom.disabled = busy;
        zoom.setAttribute(
          'aria-label',
          t('Zoom to {name}', { name: entry.title }),
        );
        actions.append(zoom);
      }
      const action = element(
        'button',
        'panel-surface-control data-library-action',
      );
      action.type = 'button';
      action.dataset.libraryId = entry.id;
      action.dataset.libraryAction = added ? 'remove' : 'add';
      action.textContent = busy
        ? t('WORKING…')
        : added
          ? t('REMOVE')
          : t('ADD');
      action.disabled = busy || (!added && !available);
      action.setAttribute(
        'aria-label',
        added
          ? t('Remove {name} from Data Layers', { name: entry.title })
          : t('Add {name} to Data Layers', { name: entry.title }),
      );
      if (added && on) item.classList.add('is-on');
      actions.append(action);
      item.append(actions);
    }
    return item;
  }

  /** Rewrite the stat tiles in place; unchanged text is not touched. */
  function renderStats() {
    if (!dialog?.open || !stats) return;
    for (const tile of libraryStatTiles(library.summary())) {
      let node = stats.querySelector(`[data-stat="${tile.id}"]`);
      if (!node) {
        node = element('div', 'data-library-stat');
        node.dataset.stat = tile.id;
        node.append(
          element('dt', 'data-library-stat-label'),
          element('dd', 'data-library-stat-value'),
          element('dd', 'data-library-stat-detail'),
        );
        stats.append(node);
      }
      const [label, value, detail] = node.children;
      if (label.textContent !== tile.label) label.textContent = tile.label;
      if (value.textContent !== tile.value) value.textContent = tile.value;
      if (detail.textContent !== tile.detail) detail.textContent = tile.detail;
      detail.hidden = !tile.detail;
    }
  }

  function render() {
    if (!dialog?.open) return;
    renderStats();
    const rows = library.list();
    const shown = sortLibraryRows(
      rows.filter((row) => libraryRowMatches(row, filter)),
    );
    const focusedId = document.activeElement?.dataset?.libraryId;
    const focusedAction = document.activeElement?.dataset?.libraryAction;
    list.replaceChildren(...shown.map(renderRow));
    if (focusedId) {
      const row = `button[data-library-id="${CSS.escape(focusedId)}"]`;
      // The same control when it survived the render (Add becomes Remove).
      (
        list.querySelector(
          `${row}[data-library-action="${CSS.escape(focusedAction || '')}"]`,
        ) ||
        list.querySelector(`${row}:not([data-library-action="zoom"])`) ||
        list.querySelector(row)
      )?.focus();
    }
    const added = rows.filter((row) => row.added).length;
    if (!added && !resetting) disarmReset();
    resetButton.hidden = added === 0 && !resetting;
    resetButton.disabled = resetting;
    resetButton.classList.toggle('is-armed', resetArmed);
    resetButton.textContent = resetting
      ? t('WORKING…')
      : resetArmed
        ? tn(added, 'CONFIRM · REMOVE {count}', 'CONFIRM · REMOVE ALL {count}')
        : t('REMOVE ALL');
    resetButton.setAttribute(
      'aria-label',
      resetArmed
        ? t('Confirm: remove every added entry from Data Layers')
        : t('Remove every added entry from Data Layers'),
    );
    // The stat tiles carry the totals; this line answers the filter.
    status.textContent = !library.ready
      ? t('Checking what this instance serves…')
      : t('Showing {shown} of {total}', {
          shown: shown.length,
          total: rows.length,
        });
  }

  const api = {
    open() {
      const search = dialog ? null : build();
      if (dialog.open) return;
      render();
      dialog.showModal();
      render();
      // Feature counts arrive as datasets finish loading, outside the
      // library's own notifications; refresh the tiles while open.
      clearInterval(statsTimer);
      statsTimer = setInterval(renderStats, STATS_REFRESH_MS);
      (search || dialog.querySelector('input[type="search"]'))?.focus();
    },
    close() {
      disarmReset();
      clearInterval(statsTimer);
      statsTimer = null;
      if (!dialog?.open) return;
      dialog.close();
      trigger?.focus?.();
    },
    destroy() {
      api.close();
      unsubscribe();
      observer?.disconnect();
      for (const remove of removers.splice(0)) remove();
      dialog?.remove();
      dialog = null;
    },
  };

  const unsubscribe = library.subscribe(render);
  if (trigger) listen(trigger, 'click', () => api.open());
  const observer =
    typeof MutationObserver === 'function'
      ? new MutationObserver(() => {
          if (
            PANEL_HIDING_MODES.some((mode) =>
              document.body.classList.contains(mode),
            )
          )
            api.close();
        })
      : null;
  observer?.observe(document.body, {
    attributes: true,
    attributeFilter: ['class'],
  });
  return api;
}
