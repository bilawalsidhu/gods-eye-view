import * as Cesium from 'cesium';
import { formatNumber, msg, t } from '../../i18n/index.js';
import { translateFeedError } from '../../ui/statusText.js';
import { createGlobeFieldTexture } from '../weather/fieldTexture.js';
import { WEATHER_SHELL_HEIGHTS } from '../weather/shellRendering.js';
import {
  SEA_STATE_BANDS,
  createSeaStateRaster,
  sampleSeaState,
} from './model.js';
export * from './model.js';
export { createSeaStateSource } from './source.js';

/** Below the wind and weather scalar context, which order at 0. */
const IMAGERY_PRIORITY = -1;

/**
 * Band names as marine terms. Moderate and High already name air-quality
 * bands, so each takes the `sea state` context and its own translation.
 */
const BAND_NAMES = Object.freeze({
  1: () => t('Calm', { context: 'sea state' }),
  2: () => t('Smooth', { context: 'sea state' }),
  3: () => t('Slight', { context: 'sea state' }),
  4: () => t('Moderate', { context: 'sea state' }),
  5: () => t('Rough', { context: 'sea state' }),
  6: () => t('Very rough', { context: 'sea state' }),
  7: () => t('High', { context: 'sea state' }),
  8: () => t('Very high', { context: 'sea state' }),
  9: () => t('Phenomenal', { context: 'sea state' }),
});

/** `YYYY-MM-DD HH:MM UTC`, or null for an unreadable time. */
function utcMinute(iso) {
  const ms = Date.parse(iso);
  return Number.isFinite(ms)
    ? `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`
    : null;
}

/**
 * Own one significant-wave-height display: a global ECMWF IFS forecast field
 * drawn as one texture in WMO sea-state bands, on the globe or, over 3D
 * tiles, on a raised shell. The field is global, so the camera never causes
 * a request; it refreshes hourly like wind.
 */
export function createSeaStateLayer({
  source,
  cesium = Cesium,
  createCanvas = () => document.createElement('canvas'),
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Sea state layer requires a snapshot source');
  let viewer = null;
  let enabled = false;
  let request = null;
  let field = null;
  let error = null;
  let imageryError = null;
  let loading = false;
  let imageryHost = null;
  let rowControlsListener = null;
  const texture = createGlobeFieldTexture({
    cesium,
    createCanvas,
    priority: IMAGERY_PRIORITY,
    shellHeight: WEATHER_SHELL_HEIGHTS['sea-state'],
  });
  const notify = () => rowControlsListener?.();

  const host = () =>
    imageryHost?.() ?? {
      collection: viewer?.imageryLayers ?? viewer?.scene?.imageryLayers,
      kind: 'globe',
    };

  function install() {
    texture.remove();
    imageryError = null;
    if (!enabled || !field || !viewer) return;
    // A flat-calm world has no raster and draws nothing, which is correct.
    imageryError = texture.install({
      viewer,
      ...host(),
      raster: createSeaStateRaster(field),
    });
  }

  const layer = {
    id: 'sea-state',
    name: 'Sea state',
    icon: '🌊',
    source: 'ECMWF IFS · WAVE FORECAST',
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
      if (field) install();
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
        return true;
      } catch (cause) {
        if (controller.signal.aborted || request !== controller) return false;
        // A failed refresh keeps the field already on the globe.
        error = cause?.message || msg('Sea state unavailable');
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
      viewer = null;
      imageryHost = null;
      rowControlsListener = null;
    },
    /** Significant wave height under a point, in metres, or null. */
    sampleAt(lon, lat) {
      return field ? sampleSeaState(field, lon, lat) : null;
    },
    getStats() {
      const run = Date.parse(field?.runIso);
      return {
        count: field ? 1 : 0,
        countLabel:
          field && Number.isFinite(field.maxValue)
            ? t('Max {height} m', {
                height: formatNumber(field.maxValue, {
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
          'Significant wave height, the mean of the highest third of waves, from the ECMWF IFS wave model at 0.25°, shown at 0.5°. A model forecast, not an observation. Bands follow the WMO sea-state scale. Land and calm water are left clear.',
        ),
        legend: SEA_STATE_BANDS.filter(({ alpha }) => alpha > 0)
          .reverse()
          .map((band) => ({
            label: BAND_NAMES[band.code]?.() ?? band.name,
            color: band.color,
            blurb: t('Above {height} m', {
              height: formatNumber(band.min),
            }),
          })),
      };
    },
  };
  return layer;
}
