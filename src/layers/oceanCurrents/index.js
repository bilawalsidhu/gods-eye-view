import * as Cesium from 'cesium';
import { formatNumber, msg, t } from '../../i18n/index.js';
import { translateFeedError } from '../../ui/statusText.js';
import { createGlobeFieldTexture } from '../weather/fieldTexture.js';
import { WEATHER_SHELL_HEIGHTS } from '../weather/shellRendering.js';
import { createWindGpuRendering } from '../wind/gpuRendering.js';
import {
  CURRENT_SPEED_STOPS,
  createCurrentSpeedRaster,
  sampleOceanCurrent,
} from './model.js';
export * from './model.js';
export { createOceanCurrentsSource } from './source.js';

/** Below the wind and weather scalar context, which order at 0. */
const IMAGERY_PRIORITY = -1;

/**
 * Ocean currents drawn with the wind streamline renderer. Currents run at
 * 0.05–2 m/s against wind's 1–30, so a path step covers six hours of field
 * time instead of half an hour; lines float just above the sea, not at 12 km,
 * and are near white so they read over the speed colours.
 */
export const OCEAN_CURRENT_FLOW_PROFILE = Object.freeze({
  materialType: 'GevOceanCurrentStreamline',
  pathLimit: 4000,
  narrowPathLimit: 900,
  bake: Object.freeze({
    stepSeconds: 6 * 3600,
    maxStepSeconds: 6 * 3600,
    minSpeed: 0.05,
  }),
  displayHeightMeters: 1000,
  fadeLowMeters: 15000,
  fadeHighMeters: 60000,
  baseColor: Object.freeze([0.86, 0.93, 0.96]),
  tipColor: Object.freeze([1, 1, 1]),
});

/** `YYYY-MM-DD HH:MM UTC`, or null for an unreadable time. */
function utcMinute(iso) {
  const ms = Date.parse(iso);
  return Number.isFinite(ms)
    ? `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`
    : null;
}

/**
 * Own one surface-current display: a global ECMWF IFS forecast field drawn as
 * a speed texture (globe imagery, or a raised shell over 3D tiles) plus
 * animated flow lines baked once per field. The field is global, so the
 * camera never causes a request; it refreshes hourly like wind.
 */
export function createOceanCurrentsLayer({
  source,
  cesium = Cesium,
  createCanvas = () => document.createElement('canvas'),
  createFlowRendering = createWindGpuRendering,
  requestFrame = (callback) => globalThis.requestAnimationFrame(callback),
  cancelFrame = (handle) => globalThis.cancelAnimationFrame(handle),
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Ocean currents layer requires a snapshot source');
  let viewer = null;
  let enabled = false;
  let request = null;
  let field = null;
  let error = null;
  let imageryError = null;
  let loading = false;
  let imageryHost = null;
  let rowControlsListener = null;
  let flowActive = false;
  let flowVisible = false;
  let flowTime = 0;
  let lastTime = null;
  let frame = null;
  let removers = [];
  let media = null;
  const notify = () => rowControlsListener?.();
  const texture = createGlobeFieldTexture({
    cesium,
    createCanvas,
    priority: IMAGERY_PRIORITY,
    shellHeight: WEATHER_SHELL_HEIGHTS['ocean-currents'],
  });
  const flow = createFlowRendering({
    cesium,
    getViewer: () => viewer,
    profile: OCEAN_CURRENT_FLOW_PROFILE,
  });

  const host = () =>
    imageryHost?.() ?? {
      collection: viewer?.imageryLayers ?? viewer?.scene?.imageryLayers,
      kind: 'globe',
    };
  const still = () =>
    media?.matches === true || globalThis.document?.hidden === true;

  function cancel() {
    if (frame !== null) cancelFrame(frame);
    frame = null;
    lastTime = null;
  }
  function schedule() {
    if (enabled && flowActive && flowVisible && !still() && frame === null)
      frame = requestFrame(draw);
  }
  function draw(time) {
    frame = null;
    if (!enabled || !flowActive || !flowVisible || still()) return;
    const elapsed =
      lastTime === null ? 1 / 60 : Math.max(0, (time - lastTime) / 1000);
    lastTime = time;
    flowTime += Math.min(0.1, elapsed);
    flow.tick(flowTime);
    viewer?.scene?.requestRender?.();
    schedule();
  }
  /** Scene pre-render: show only the cells in view, animate while any are. */
  function viewChanged() {
    const camera = viewer?.scene?.camera;
    if (!flowActive || !camera) return;
    flowVisible = flow.updateVisibility(camera);
    if (flowVisible) schedule();
    else cancel();
  }
  function motionChanged() {
    cancel();
    flow.setOptions({ paused: still() });
    viewChanged();
  }

  function listen(target, event, callback) {
    if (!target?.addEventListener) return;
    target.addEventListener(event, callback);
    removers.push(() => target.removeEventListener(event, callback));
  }
  function attachListeners() {
    if (removers.length) return;
    media = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null;
    listen(media, 'change', motionChanged);
    listen(globalThis.document, 'visibilitychange', motionChanged);
    const preRender = viewer?.scene?.preRender;
    if (preRender?.addEventListener) {
      const remove = preRender.addEventListener(viewChanged);
      removers.push(
        typeof remove === 'function'
          ? remove
          : () => preRender.removeEventListener(viewChanged),
      );
    }
  }
  function detachListeners() {
    for (const remove of removers) remove();
    removers = [];
    media = null;
  }

  function install() {
    texture.remove();
    imageryError = null;
    if (!enabled || !field || !viewer) return;
    imageryError = texture.install({
      viewer,
      ...host(),
      raster: createCurrentSpeedRaster(field),
    });
  }
  function installFlow() {
    cancel();
    flowActive =
      Boolean(enabled && field && viewer) &&
      flow.setField({ ...field.grid, u: field.u, v: field.v });
    flowVisible = false;
    if (!flowActive) return;
    attachListeners();
    flow.setOptions({ paused: still() });
    viewChanged();
  }

  const layer = {
    id: 'ocean-currents',
    name: 'Ocean currents',
    icon: '〰',
    source: 'ECMWF IFS · OCEAN FORECAST',
    updateInterval: 3600_000,
    init(nextViewer) {
      viewer = nextViewer;
    },
    attachShellServices(services) {
      imageryHost =
        typeof services?.imageryHost === 'function'
          ? services.imageryHost
          : null;
      layer.rehome();
    },
    /** Move the texture when the map source changes between globe and tiles. */
    rehome() {
      if (!enabled || !field) return;
      if (host().kind !== texture.kind) install();
    },
    enable() {
      enabled = true;
      if (field) {
        install();
        installFlow();
      }
    },
    disable() {
      enabled = false;
      request?.abort();
      request = null;
      loading = false;
      field = null;
      error = null;
      imageryError = null;
      texture.remove();
      cancel();
      detachListeners();
      flow.clear();
      flowActive = false;
      flowVisible = false;
    },
    async update(nextViewer, { signal } = {}) {
      if (!enabled) return false;
      if (nextViewer) viewer = nextViewer;
      request?.abort();
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      if (signal?.aborted) controller.abort(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      request = controller;
      loading = true;
      notify();
      try {
        const snapshot = await source.getSnapshot({
          signal: controller.signal,
        });
        if (!enabled || request !== controller) return false;
        field = snapshot;
        error = null;
        install();
        installFlow();
        return true;
      } catch (cause) {
        if (controller.signal.aborted || request !== controller) return false;
        // A failed refresh keeps the field already on the globe.
        error = cause?.message || msg('Ocean currents unavailable');
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
    setRowControlsListener(listener) {
      rowControlsListener = typeof listener === 'function' ? listener : null;
    },
    destroy() {
      layer.disable();
      flow.destroy();
      viewer = null;
      imageryHost = null;
      rowControlsListener = null;
    },
    /** The surface current under a point: u, v and speed in m/s, the compass
     * direction it flows towards, or null on land. */
    sampleAt(lon, lat) {
      return field ? sampleOceanCurrent(field, lon, lat) : null;
    },
    getStats() {
      const run = Date.parse(field?.runIso);
      return {
        count: field ? 1 : 0,
        countLabel:
          field && Number.isFinite(field.maxSpeed)
            ? t('Max {speed} m/s', {
                speed: formatNumber(field.maxSpeed, {
                  maximumFractionDigits: 1,
                }),
              })
            : undefined,
        loading,
        lastUpdate: Number.isFinite(run) ? run : null,
        validTime: field ? utcMinute(field.validIso) : null,
        stale: Boolean(field?.stale),
        error: error || imageryError,
        source: 'ECMWF IFS',
        fallback: false,
      };
    },
    getRowControls() {
      if (!enabled) return null;
      const valid = field ? utcMinute(field.validIso) : null;
      return {
        info:
          (valid ? t('Forecast valid {time}', { time: valid }) : '') +
          (error ? `${valid ? ' · ' : ''}${translateFeedError(error)}` : ''),
        infoTitle: t(
          'Surface sea water velocity from the ocean model coupled to ECMWF IFS, at 0.25°, shown at 0.5°. Color is speed; moving lines follow the flow. A model forecast, not an observation. Land and water slower than 0.1 m/s are left clear.',
        ),
        legend: CURRENT_SPEED_STOPS.slice(1)
          .reverse()
          .map((stop) => ({
            label: t('{speed} m/s', { speed: formatNumber(stop.min) }),
            color: stop.color,
          })),
      };
    },
  };
  return layer;
}
