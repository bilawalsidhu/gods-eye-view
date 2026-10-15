import { dayLabel, seasonLabel } from './dates.js';
import { LAYER_ID } from './policy.js';

export function createControls({ state: layerState, parts }) {
  function statusMessage(view) {
    if (layerState.loading) return 'Loading avalanche data…';
    if (layerState.status === 'unavailable')
      return layerState.error || 'Avalanche data unavailable';
    if (layerState.status === 'idle') return 'Avalanches off';
    const window = layerState.window;
    if (!window) return 'Loading avalanche data…';
    if (window.mode === 'replay')
      return `Replay ${seasonLabel(window.season)} · week of ${dayLabel(window.weekFrom ?? window.anchor)}`;
    if (layerState.quiet)
      return 'Out of season · replay last season from the map';
    const rated = window.regions.filter((region) =>
      region.days.some((day) => day.date === window.anchor && day.level > 0),
    ).length;
    return `${window.observations.length} avalanches this week · ${rated} regions rated today`;
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
        loadingLabel: layerState.loading ? 'loading avalanche data' : '',
      };
    },
  };

  return { methods };
}
