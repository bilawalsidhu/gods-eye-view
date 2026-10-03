import * as Cesium from 'cesium';
import {
  createAuroraRendering,
  AURORA_COLORS,
  AURORA_TRANSITION_FPS,
} from './rendering.js';

const utc = (value) =>
  value ? `${value.slice(0, 16).replace('T', ' ')} UTC` : 'Unavailable';

export function createAuroraLayer({
  feed,
  cesium = Cesium,
  createRendering = createAuroraRendering,
  eventTarget = globalThis.window,
  setInterval: setIntervalImpl = globalThis.setInterval,
  clearInterval: clearIntervalImpl = globalThis.clearInterval,
} = {}) {
  if (typeof feed?.getSnapshot !== 'function')
    throw new TypeError('Aurora requires a snapshot source');
  let viewer = null;
  let rendering = null;
  let imageryHost = null;
  let enabled = false;
  let request = null;
  let snapshot = null;
  let loading = false;
  let error = null;
  let opacity = 'strong';
  let listener = null;
  let ticker = null;
  const notify = () => listener?.();

  const stopTicker = () => {
    if (ticker === null) return;
    clearIntervalImpl(ticker);
    ticker = null;
  };
  /**
   * Drive an in-flight transition to completion.
   *
   * Only runs while one is in flight. The rest of the time the field is static
   * and costs nothing, which matters because the blended raster is roughly
   * 23 ms of main-thread work per frame.
   */
  const runTicker = () => {
    stopTicker();
    if (typeof setIntervalImpl !== 'function') {
      // No timer available, as in a unit test. Settle immediately rather than
      // leaving the oval frozen part-way between two forecasts.
      rendering?.advance(Number.POSITIVE_INFINITY);
      return;
    }
    ticker = setIntervalImpl(
      () => {
        if (!rendering?.advance()) stopTicker();
      },
      Math.round(1000 / AURORA_TRANSITION_FPS),
    );
  };
  const getHost = () =>
    imageryHost?.() ?? {
      collection: viewer?.imageryLayers ?? viewer?.scene?.imageryLayers,
      kind: 'globe',
    };
  const onMapStackChanged = () => rendering?.rehome();
  const layer = {
    id: 'weather-aurora',
    name: 'Aurora forecast',
    icon: '✦',
    source: 'NOAA SWPC OVATION · FORECAST',
    updateInterval: 5 * 60_000,
    init(nextViewer) {
      viewer = nextViewer;
      rendering = createRendering({ viewer, cesium, getHost });
      eventTarget?.addEventListener?.(
        'gev:map-stack-changed',
        onMapStackChanged,
      );
    },
    attachShellServices(services) {
      imageryHost =
        typeof services?.imageryHost === 'function'
          ? services.imageryHost
          : null;
      rendering?.rehome();
    },
    enable() {
      enabled = true;
    },
    disable() {
      enabled = false;
      stopTicker();
      request?.abort();
      request = null;
      snapshot = null;
      loading = false;
      error = null;
      rendering?.clear();
      notify();
    },
    async update(_viewer, { signal } = {}) {
      if (!enabled) return false;
      request?.abort();
      const controller = new AbortController();
      if (signal?.aborted) controller.abort(signal.reason);
      const abort = () => controller.abort(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      request = controller;
      loading = true;
      notify();
      try {
        signal?.throwIfAborted();
        const next = await feed.getSnapshot({ signal: controller.signal });
        if (!next || typeof next !== 'object')
          throw new Error('Malformed aurora forecast');
        if (!enabled || controller.signal.aborted || request !== controller)
          return false;
        if (next.unavailable) {
          error = next.reason || 'Aurora forecast unavailable';
        } else {
          snapshot = next;
          error = null;
          rendering.setField(next);
          if (rendering.isTransitioning?.()) runTicker();
        }
        return true;
      } catch (cause) {
        if (controller.signal.aborted || request !== controller) return false;
        error = cause?.message || 'Aurora forecast unavailable';
        return true;
      } finally {
        signal?.removeEventListener('abort', abort);
        if (request === controller) {
          request = null;
          loading = false;
          notify();
        }
      }
    },
    setParams(params = {}) {
      if (['light', 'strong'].includes(params.opacity)) {
        opacity = params.opacity;
        rendering?.setAlpha(opacity === 'light' ? 0.45 : 0.75);
      }
      notify();
    },
    getParams() {
      return { opacity };
    },
    getRowControls() {
      const valid = snapshot?.forecastTime;
      const issued = snapshot?.observationTime;
      const status = loading
        ? 'Loading forecast'
        : error ||
          rendering?.getDiagnostics?.().error ||
          (snapshot?.stale ? 'Cached forecast · stale' : null);
      const chips = ['light', 'strong'].map((value) => ({
        id: `opacity-${value}`,
        label: value === 'light' ? 'Soft' : 'Vivid',
        active: opacity === value,
        params: { opacity: value },
        title: 'Display opacity only; does not change forecast probability',
      }));
      return {
        readout: true,
        summary: {
          label: 'Aurora probability · FORECAST',
          coverage: 'Both hemispheres · 1° grid',
          horizon: 'Variable 30–90 min forecast',
          uncertainty: 'Modeled probability, not guaranteed visibility',
          validTime: valid,
          issuedTime: issued,
          detail: `NOAA OVATION forecast · valid ${utc(valid)}`,
          status,
          units: '% probability',
          settings: [{ id: 'opacity', label: 'OPACITY', chips }],
          actions: [],
        },
        chips,
        legend: AURORA_COLORS.map(([value, color]) => ({
          label: `${value}%`,
          color: `rgba(${color.join(',')})`,
          blurb: `${value}% modeled probability of visible aurora`,
        })),
        info:
          `OVATION AURORA · FORECAST · BOTH HEMISPHERES\n` +
          `Valid: ${utc(valid)} · variable 30–90 min horizon\n` +
          `Issued/input: ${utc(issued)}${snapshot?.stale ? ' · STALE' : ''}` +
          (status ? `\n${status}` : '') +
          '\nModeled viewing probability, not a guarantee of visibility\n' +
          'Clouds, darkness, local light pollution, and model uncertainty affect actual visibility',
        infoTitle:
          'NOAA OVATION is a 30–90 minute model forecast. Lead time varies with solar-wind travel time. Darkness, clouds, local light pollution and model uncertainty affect actual visibility. Low probability is not an all-clear.',
      };
    },
    setRowControlsListener(value) {
      listener = typeof value === 'function' ? value : null;
    },
    getStats() {
      return {
        count: snapshot?.probabilities?.length || 0,
        countLabel: snapshot?.probabilities ? '360×181 grid cells' : '',
        lastUpdate: snapshot?.observationTime
          ? Date.parse(snapshot.observationTime)
          : null,
        loading,
        error,
        stale: Boolean(snapshot?.stale),
        source: 'NOAA SWPC OVATION · FORECAST',
        validTime: snapshot?.forecastTime || null,
      };
    },
    getDiagnostics() {
      return {
        validTime: snapshot?.forecastTime || null,
        issuedTime: snapshot?.observationTime || null,
        stale: Boolean(snapshot?.stale),
        ...rendering?.getDiagnostics?.(),
      };
    },
    destroy() {
      stopTicker();
      layer.disable();
      eventTarget?.removeEventListener?.(
        'gev:map-stack-changed',
        onMapStackChanged,
      );
      rendering?.destroy();
      rendering = null;
      viewer = null;
      listener = null;
    },
  };
  return layer;
}
