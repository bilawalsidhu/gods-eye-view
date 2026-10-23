import { msg, t, tn } from '../../i18n/index.js';
import { dayLabel, seasonLabel } from './dates.js';
import { LAYER_ID } from './policy.js';

export function createControls({ state: layerState, parts }) {
  function statusMessage(view) {
    if (layerState.loading) return msg('Loading avalanche data…');
    if (layerState.status === 'unavailable')
      return layerState.error || msg('Avalanche data unavailable');
    if (layerState.status === 'idle') return msg('Avalanches off');
    const window = layerState.window;
    if (!window) return msg('Loading avalanche data…');
    if (window.mode === 'replay')
      return t('Replay {season} · week of {day}', {
        season: seasonLabel(window.season),
        day: dayLabel(window.weekFrom ?? window.anchor),
      });
    if (layerState.quiet)
      return msg('Out of season · replay last season from the map');
    const rated = window.regions.filter((region) =>
      region.days.some((day) => day.date === window.anchor && day.level > 0),
    ).length;
    return t('{avalanches} this week · {regions} rated today', {
      avalanches: tn(
        window.observations.length,
        '{count} avalanche',
        '{count} avalanches',
      ),
      regions: tn(rated, '{count} region', '{count} regions'),
    });
  }

  const methods = {
    id: LAYER_ID,

    name: 'Avalanches',

    icon: '❄',

    source: 'Varsom and SLF forecasts · regObs observations',

    /** One window per enable; nothing to poll while it plays. */
    updateInterval: 0,

    statsRefreshInterval: 2000,

    getStats() {
      const window = layerState.window;
      const view = parts.presenter.view();
      return {
        count: window ? window.observations.length : 0,
        lastUpdate: layerState.lastUpdate,
        status: layerState.status,
        loading: layerState.loading,
        error: layerState.status === 'unavailable' ? layerState.error : null,
        stale: layerState.stale,
        failureReason: layerState.failureReason,
        mode: window?.mode ?? null,
        anchor: window?.anchor ?? null,
        day: window?.days[view.current]?.date ?? null,
        quiet: layerState.quiet,
        // An empty off-season window is the source working, not failing.
        empty: Boolean(window) && layerState.quiet,
        statusMessage: statusMessage(view),
        loadingLabel: layerState.loading ? msg('loading avalanche data') : '',
      };
    },
  };

  return { methods };
}
