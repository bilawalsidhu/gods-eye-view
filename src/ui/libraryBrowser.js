/**
 * DATA LAYERS ▸ Browse data library: the owner of the dialog that lists every
 * Data Library entry this build knows, with its licence, coverage and what
 * this instance needs to serve it, and adds or removes it from the panel.
 *
 * Framework-free: `createLibraryBrowser` presents the dialog's state (open,
 * filters, the rows they show, the stat summary, Remove all) through
 * `publish`, and its `controls` answer the view
 * (src/ui/views/panels/DataLibraryDialog.vue, placed by LayerPanelsView). The
 * text helpers below are what the view renders; they call `t()`, so text
 * rendered through them follows the locale.
 *
 * A `dialog[data-panel-surface]` per docs/panel-surfaces.md: the view owns
 * width, height, labels and focus; this owner closes the dialog when clean
 * view, recording or Cockpit hides the panels.
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

/** The Theme filter's choices, translated: all themes first. */
export function libraryThemeOptions() {
  return [
    { value: '', label: t('All themes') },
    ...Object.entries(FAMILY_LABELS).map(([value, label]) => ({
      value,
      label: t(label),
    })),
  ];
}

/**
 * An entry card's badges: kind, status, then how it is served (operator
 * opt-in, a provider key, or keyless). `tone` is '', 'good' or 'warn'.
 * @param {object} entry
 * @returns {Array<{ label: string, tone: string }>}
 */
export function libraryBadges(entry) {
  const badges = [
    { label: t(KIND_LABELS[entry.kind]), tone: '' },
    {
      label: t(STATUS_LABELS[entry.status]),
      tone:
        entry.status === 'verified'
          ? 'good'
          : entry.status === 'stale'
            ? 'warn'
            : '',
    },
  ];
  if (entry.licence.operatorOptIn)
    badges.push({ label: t('OPT-IN'), tone: 'warn' });
  else if (entry.kind !== 'pack' && entry.source.key)
    badges.push({ label: t('KEY'), tone: 'warn' });
  else if (entry.kind !== 'pack')
    badges.push({ label: t('KEYLESS'), tone: '' });
  return badges;
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

/** Where an entry covers, for its card line. */
export function coverageText(entry) {
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
 * The Browse dialog's owner. Presents its state through `publish` and answers
 * the view through `controls`; never touches the dialog's markup.
 * @param {{ library: ReturnType<import('../library/controller.js').createDataLibrary>, publish?: (view: object|null) => void, body?: HTMLElement|null }} options
 * @returns {{ controls: object, open: () => void, close: () => void, destroy: () => void }}
 */
export function createLibraryBrowser({
  library,
  publish = () => {},
  body = globalThis.document?.body ?? null,
}) {
  const filter = { query: '', family: '', availableOnly: false };
  let open = false;
  let destroyed = false;
  let rows = [];
  let statsTimer = null;
  // Remove all asks twice: the first press arms it for a few seconds.
  let resetArmed = false;
  let resetTimer = null;
  let resetting = false;
  // Bumped when focus should go back to the search field (after Remove all).
  let focusSearch = 0;

  function disarmReset() {
    clearTimeout(resetTimer);
    resetTimer = null;
    resetArmed = false;
  }

  /**
   * Publish the dialog. Rows are reread from the library unless only the
   * stat tiles changed, so an unchanged row list keeps its identity and its
   * cards do not re-render.
   */
  function present({ rowsChanged = true } = {}) {
    if (destroyed) return;
    if (rowsChanged || !rows.length) rows = library.list();
    const added = rows.filter((row) => row.added).length;
    if (!added && !resetting && resetArmed) disarmReset();
    publish({
      open,
      ready: library.ready,
      filter: { ...filter },
      shown: open
        ? sortLibraryRows(rows.filter((row) => libraryRowMatches(row, filter)))
        : [],
      total: rows.length,
      added,
      summary: library.summary(),
      reset: {
        visible: added > 0 || resetting,
        armed: resetArmed,
        busy: resetting,
      },
      focusSearch,
    });
  }

  function close() {
    disarmReset();
    clearInterval(statsTimer);
    statsTimer = null;
    if (!open) return;
    open = false;
    present();
  }

  const controls = {
    open() {
      if (destroyed || open) return;
      open = true;
      present();
      // Feature counts arrive as datasets finish loading, outside the
      // library's own notifications; refresh the tiles while open.
      clearInterval(statsTimer);
      statsTimer = setInterval(
        () => present({ rowsChanged: false }),
        STATS_REFRESH_MS,
      );
    },
    close,
    setQuery(value) {
      filter.query = String(value ?? '');
      present({ rowsChanged: false });
    },
    setFamily(value) {
      filter.family = String(value ?? '');
      present({ rowsChanged: false });
    },
    setAvailableOnly(value) {
      filter.availableOnly = Boolean(value);
      present({ rowsChanged: false });
    },
    add(id) {
      Promise.resolve(library.add(id)).catch((error) =>
        console.warn(`[Library] ${id} failed:`, error),
      );
    },
    remove(id) {
      Promise.resolve(library.remove(id)).catch((error) =>
        console.warn(`[Library] ${id} failed:`, error),
      );
    },
    zoom(id) {
      // Close first so the flight is visible; focus returns to Browse. An
      // entry that is off is switched on first.
      close();
      Promise.resolve(library.zoom(id)).catch((error) =>
        console.warn(`[Library] ${id} zoom failed:`, error),
      );
    },
    reset() {
      if (resetting) return;
      if (!resetArmed) {
        resetArmed = true;
        resetTimer = setTimeout(() => {
          disarmReset();
          present({ rowsChanged: false });
        }, RESET_CONFIRM_MS);
        present({ rowsChanged: false });
        return;
      }
      disarmReset();
      resetting = true;
      present({ rowsChanged: false });
      Promise.resolve(library.reset())
        .catch((error) => console.warn('[Library] reset failed:', error))
        .finally(() => {
          resetting = false;
          focusSearch += 1;
          present();
        });
    },
  };

  const unsubscribe = library.subscribe(() => present());
  const observer =
    typeof MutationObserver === 'function' && body
      ? new MutationObserver(() => {
          if (PANEL_HIDING_MODES.some((mode) => body.classList.contains(mode)))
            close();
        })
      : null;
  observer?.observe(body, { attributes: true, attributeFilter: ['class'] });
  present();

  return {
    controls,
    open: controls.open,
    close,
    destroy() {
      if (destroyed) return;
      close();
      destroyed = true;
      unsubscribe();
      observer?.disconnect();
      publish(null);
    },
  };
}
