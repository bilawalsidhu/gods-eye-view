import { seasonOf, utcDate, windowDays } from './dates.js';
import { busiestWeek, isQuietWindow } from './model.js';

/**
 * Loading: region outlines once, then one ten-day window at a time.
 *
 * A window is anchored on a day. Live, that is today: seven observed days, today,
 * and Varsom's two forecast days. In replay it is the last day of a chosen
 * week of a past season, so the week plays as observed history with the two
 * days after it as the forecasts issued then.
 */
export function createIngestion({
  state: layerState,
  services,
  parts,
  source,
}) {
  const { governorRequestRender } = services.render;
  const now = services.now ?? (() => Date.now());

  function setStatus(status, error = null) {
    layerState.status = status;
    layerState.error = error;
    governorRequestRender('avalanches-status');
  }

  async function ensureOutlines(signal) {
    if (layerState.outlines) return layerState.outlines;
    layerState.outlines = await source.getRegions({ signal });
    return layerState.outlines;
  }

  /**
   * Load and show the window anchored on a day.
   * @param {string} anchor Window day treated as "today".
   * @param {{mode:'live'|'replay', season?:number, weekFrom?:string}} context
   * @returns {Promise<boolean>} Whether the window is on screen.
   */
  async function loadWindow(anchor, context) {
    if (!layerState.enabled || !layerState.viewer) return false;
    layerState.abort?.abort();
    const request = new AbortController();
    layerState.abort = request;
    layerState.loading = true;
    setStatus('loading');
    parts.presenter.refresh();
    const { signal } = request;
    const current = () =>
      !signal.aborted && layerState.abort === request && layerState.enabled;
    try {
      const days = windowDays(anchor);
      const [, forecast, observed] = await Promise.all([
        ensureOutlines(signal),
        source.getForecast({
          from: days[0].date,
          to: days.at(-1).date,
          signal,
        }),
        source.getObservations({ from: days[0].date, to: anchor, signal }),
      ]);
      if (!current()) return false;
      layerState.window = {
        anchor,
        days,
        regions: forecast.regions,
        observations: observed.observations,
        mode: context.mode,
        season: context.season ?? seasonOf(anchor),
        weekFrom: context.weekFrom ?? null,
      };
      layerState.stale = forecast.stale || observed.stale;
      if (context.mode === 'live')
        layerState.quiet = isQuietWindow(
          forecast.regions,
          observed.observations,
        );
      layerState.selected = null;
      parts.presenter.invalidateCard();
      parts.rendering.build(layerState.window);
      layerState.lastUpdate = now();
      layerState.failureReason = null;
      setStatus('ready');
      parts.playback.begin();
      return true;
    } catch (error) {
      if (!current() || error?.name === 'AbortError') return false;
      console.warn('[Data:Avalanches] window load failed:', error);
      layerState.failureReason = error?.failureReason || 'unavailable';
      setStatus('unavailable', 'Avalanche data unavailable');
      return false;
    } finally {
      if (layerState.abort === request) {
        layerState.abort = null;
        layerState.loading = false;
        parts.presenter.refresh();
      }
    }
  }

  /** The live window: the last week, today, and the forecast days. */
  function loadLive() {
    layerState.season = null;
    return loadWindow(utcDate(now()), { mode: 'live' });
  }

  /**
   * Replay a past season: load its weekly histogram, then open the week with
   * the most reported avalanches.
   * @returns {Promise<boolean>} Whether a replay week is on screen.
   */
  async function startReplay() {
    const season = seasonOf(utcDate(now()));
    layerState.season = null;
    layerState.loading = true;
    parts.presenter.refresh();
    try {
      const weeks = await source.getSeason({ season });
      if (!layerState.enabled) return false;
      layerState.season = { season, weeks };
      const week = busiestWeek(weeks);
      if (!week) {
        layerState.season = null;
        setStatus('ready', `No avalanches were reported in ${season}`);
        return false;
      }
      return loadWeek(week.from, week.to);
    } catch (error) {
      if (!layerState.enabled || error?.name === 'AbortError') return false;
      setStatus('unavailable', 'Season history unavailable');
      return false;
    } finally {
      layerState.loading = false;
      parts.presenter.refresh();
    }
  }

  /** Open one week of the replayed season. */
  function loadWeek(from, to) {
    return loadWindow(to, {
      mode: 'replay',
      season: layerState.season?.season ?? seasonOf(to),
      weekFrom: from,
    });
  }

  const methods = {
    update() {
      // One window per enable; replay and live switch on demand.
      if (layerState.window && layerState.status === 'ready') return;
      return loadLive();
    },
  };

  return { loadLive, startReplay, loadWeek, setStatus, methods };
}
