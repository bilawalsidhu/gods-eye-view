import { t, formatNumber, translateKnown } from '../../i18n/index.js';
import { msg } from '../../i18n/marker.js';
import { translateFeedError } from '../../ui/statusText.js';
import { wildlifeIconicGroup } from './model.js';
import { formatAge } from './photoText.js';
import {
  ICONIC_TINTS,
  ICONIC_LEGEND_ORDER,
  TAXA_PRESETS,
  WILDLIFE_CONFIRMED_CHIP_ID,
  WILDLIFE_GRID_HEIGHT_METERS,
  WILDLIFE_UPDATE_INTERVAL_MS,
} from './policy.js';

const LEGEND_LABELS = Object.freeze({
  Aves: msg('Birds'),
  Mammalia: msg('Mammals'),
  Reptilia: msg('Reptiles'),
  Amphibia: msg('Amphibians'),
  Actinopterygii: msg('Ray-finned fishes'),
  Insecta: msg('Insects'),
  Arachnida: msg('Arachnids'),
  Plantae: msg('Plants'),
  Fungi: msg('Fungi'),
  Animalia: msg('Other animals'),
  Unknown: msg('Other or unknown'),
});

/** Own layer-row descriptors and serializable filter options. */
export function createControls({ state, services, parts }) {
  function notify() {
    try {
      state.controlsListener?.();
    } catch {
      /* repaint listeners are optional */
    }
  }

  function chip({ id, label, title, params, key, value }) {
    const pending =
      state.pendingParams?.keys.includes(key) &&
      (key === 'confirmed' || state.pendingParams[key] === value);
    const failedKey = state.failedParams?.keys.includes(key);
    const failed =
      failedKey && (key === 'confirmed' || state.failedParams[key] === value);
    const active =
      !pending &&
      (failedKey
        ? state[key] === value
        : !!state.drawnParams && state.drawnParams[key] === value);
    return {
      id,
      label: `${label}${pending ? ' ···' : failed ? ' ✕' : ''}`,
      title: failed
        ? t('{label} {detail} — click to retry', {
            label,
            detail: translateFeedError(
              state.error || msg('Wildlife sightings source unavailable'),
            ),
          })
        : title,
      active,
      busy: !!pending,
      disabled: !!pending,
      state: pending
        ? 'loading'
        : failed
          ? 'error'
          : active
            ? 'active'
            : 'idle',
      params,
    };
  }

  const methods = {
    id: 'wildlife-sightings',
    name: 'Wildlife Sightings',
    icon: '🦉',
    source: 'iNaturalist',
    updateInterval: WILDLIFE_UPDATE_INTERVAL_MS,

    /** Route camera refreshes through the application's lifecycle manager. */
    attachDataManager(manager) {
      state.manager = manager;
    },
    /** Connect the layer row's repaint listener. */
    setRowControlsListener(listener) {
      state.controlsListener = typeof listener === 'function' ? listener : null;
    },
    /** Snapshot the requested filters for share links and restoration. */
    getParams() {
      return { confirmed: state.confirmed, taxa: state.taxa };
    },
    /** Apply filters while retaining the last accepted display until success. */
    setParams(params = {}) {
      const next = {
        confirmed:
          typeof params.confirmed === 'boolean'
            ? params.confirmed
            : state.confirmed,
        taxa: TAXA_PRESETS.some((preset) => preset.value === params.taxa)
          ? params.taxa
          : state.taxa,
      };
      const changed = ['confirmed', 'taxa'].filter(
        (key) => next[key] !== state[key],
      );
      if (!changed.length && !state.failedParams) return true;
      // Compare with the displayed filters so disjoint edits stay pending.
      // Initially taxa awaits data while the default-off toggle remains idle.
      const drawn = state.drawnParams || { confirmed: false, taxa: null };
      const keys = ['confirmed', 'taxa'].filter(
        (key) => next[key] !== drawn[key],
      );
      if (!changed.length && state.failedParams) {
        for (const key of state.failedParams.keys) {
          if (!keys.includes(key)) keys.push(key);
        }
      }
      state.confirmed = next.confirmed;
      state.taxa = next.taxa;
      state.pendingParams = keys.length ? { ...next, keys } : null;
      state.failedParams = null;
      // Replace the LRU with the accepted result so taxa never get mixed.
      state.pendingClear = true;
      state.lastQueryKey = null;
      state.request?.abort();
      state.background?.abort();
      parts.lifecycle.scheduleRefresh();
      notify();
      return true;
    },
    /** Describe filter chips, nonempty legend groups and provider attribution. */
    getRowControls() {
      const confirmedFailed = state.failedParams?.keys.includes('confirmed');
      const chips = [
        chip({
          id: WILDLIFE_CONFIRMED_CHIP_ID,
          label: t('CONFIRMED'),
          title: t('Show only community-confirmed (research-grade) sightings'),
          params: {
            confirmed: confirmedFailed ? state.confirmed : !state.confirmed,
          },
          key: 'confirmed',
          value: true,
        }),
        ...TAXA_PRESETS.map((preset) =>
          chip({
            id: preset.id,
            label: translateKnown(preset.label),
            title: translateKnown(preset.title),
            params: { taxa: preset.value },
            key: 'taxa',
            value: preset.value,
          }),
        ),
      ];
      const counts = new Map();
      for (const row of state.renderedRows) {
        const group = wildlifeIconicGroup(row.iconic);
        counts.set(group, (counts.get(group) || 0) + 1);
      }
      const legend = ICONIC_LEGEND_ORDER.filter((key) => counts.has(key)).map(
        (key, index) => ({
          label: translateKnown(LEGEND_LABELS[key]),
          color: ICONIC_TINTS[key],
          count: counts.get(key),
          ...(index === 0
            ? {
                blurb: t(
                  'Wildlife observed within 48 h (whales 7 d). Color and badge glyph show the taxon group. Sensitive species are shown only as 0.2° cells; Salish Sea marine mammal reports via Acartia are rounded to 0.01°. Not a census.',
                ),
              }
            : {}),
        }),
      );
      if (!state.lastUpdate && !legend.length) return { chips, legend: [] };
      const acartiaCount = state.renderedRows.filter(
        (row) => row.origin === 'acartia',
      ).length;
      const info = acartiaCount
        ? t(
            'iNaturalist contributors · Acartia {count} (Salish Sea) · licences per record',
            { count: formatNumber(acartiaCount) },
          )
        : t('iNaturalist contributors · licences per record');
      return { chips, legend, info };
    },
    /** Report the visible count, feed state and retry guidance. */
    getStats() {
      const grid = state.gridAvailable === true;
      const count =
        state.sightingCount ??
        (grid ? (state.gridTotal ?? 0) : state.renderedRows.length);
      const loading = state.loading && !state.lastUpdate;
      const refreshing = state.loading && !!state.lastUpdate;
      const age = state.lastUpdate
        ? formatAge(services.now() - state.lastUpdate)
        : '';
      const minutes = state.lastUpdate
        ? Math.max(0, (services.now() - state.lastUpdate) / 60_000)
        : 0;
      const liveAge =
        minutes < 1
          ? t('<1m ago')
          : minutes < 90
            ? t('{count}m ago', { count: Math.floor(minutes) })
            : t('{count}h ago', { count: Math.round(minutes / 60) });
      const stats = {
        count,
        lastUpdate: state.lastUpdate,
        error: state.error,
        stale: state.stale,
        loading,
        refreshing,
        countLabel: t('{count} sightings in view', {
          count: formatNumber(count),
        }),
        loadingLabel: loading
          ? t('loading...')
          : refreshing
            ? t('refreshing...')
            : state.stale
              ? t('STALE · cached {age}', { age })
              : state.lastUpdate
                ? t('LIVE · updated {age}', { age: liveAge })
                : '',
      };
      if (
        !state.error &&
        !state.query &&
        state.viewer?.camera?.positionCartographic?.height >
          WILDLIFE_GRID_HEIGHT_METERS
      ) {
        // i18n-ignore: feed-state protocol value
        stats.status = 'zoom-in';
        stats.statusMessage = msg('Zoom in for local sightings');
      } else if (!state.error && state.lastUpdate && !count) {
        // i18n-ignore: feed-state protocol value
        stats.status = 'empty';
        stats.statusMessage = msg('No recent sightings in view');
      }
      if (state.retryAt > services.now())
        stats.retryInSec = Math.ceil((state.retryAt - services.now()) / 1000);
      return stats;
    },
  };
  return { methods, notify };
}
