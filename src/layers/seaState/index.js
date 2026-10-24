import * as Cesium from 'cesium';
import { formatNumber, msg, t } from '../../i18n/index.js';
import { translateFeedError } from '../../ui/statusText.js';
import { orderWeatherImagery } from '../weather/imageryOrder.js';
import { NO_IMAGERY_HOST } from '../weather/imageryHost.js';
import {
  WEATHER_SHELL_HEIGHTS,
  createShellSurface,
} from '../weather/shellRendering.js';
import {
  SEA_STATE_BANDS,
  createSeaStateRaster,
  sampleSeaState,
} from './model.js';
export * from './model.js';
export { createSeaStateSource } from './source.js';

/** Below the wind and weather scalar context, which order at 0. */
const IMAGERY_PRIORITY = -1;

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
  let imagery = null;
  let imageryCollection = null;
  let shell = null;
  let installedKind = null;
  let rowControlsListener = null;
  const notify = () => rowControlsListener?.();

  const host = () =>
    imageryHost?.() ?? {
      collection: viewer?.imageryLayers ?? viewer?.scene?.imageryLayers,
      kind: 'globe',
    };

  function removeImagery() {
    if (imagery && imageryCollection && !imageryCollection.isDestroyed?.())
      imageryCollection.remove(imagery, true);
    imagery = null;
    imageryCollection = null;
    shell?.destroy();
    shell = null;
    installedKind = null;
  }

  function install() {
    removeImagery();
    imageryError = null;
    if (!enabled || !field || !viewer) return;
    const { collection, kind } = host();
    if (kind === 'none') {
      imageryError = NO_IMAGERY_HOST;
      return;
    }
    const raster = createSeaStateRaster(field);
    if (!raster) return; // a flat-calm world draws nothing, which is correct
    try {
      const texture = createCanvas();
      texture.width = raster.width;
      texture.height = raster.height;
      const ctx = texture.getContext('2d');
      const pixels = ctx.createImageData(raster.width, raster.height);
      pixels.data.set(raster.rgba);
      ctx.putImageData(pixels, 0, 0);
      if (kind === 'tileset') {
        shell = createShellSurface({
          viewer,
          cesium,
          rectangle: cesium.Rectangle.MAX_VALUE,
          height: WEATHER_SHELL_HEIGHTS['sea-state'],
        });
        shell.setImage(texture);
        shell.setAlpha(1);
        shell.setShow(true);
      } else {
        const provider = new cesium.SingleTileImageryProvider({
          url: texture.toDataURL('image/png'),
          tileWidth: raster.width,
          tileHeight: raster.height,
          rectangle: cesium.Rectangle.MAX_VALUE,
        });
        imagery = collection.addImageryProvider(provider);
        orderWeatherImagery(collection, imagery, IMAGERY_PRIORITY);
        imageryCollection = collection;
      }
      installedKind = kind;
      viewer.scene?.requestRender?.();
    } catch {
      removeImagery();
      imageryError = msg('Globe field image unavailable');
    }
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
      if (host().kind !== installedKind) install();
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
      removeImagery();
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
            label: t(band.label),
            color: band.color,
            blurb: t('From {height} m', {
              height: formatNumber(band.min),
            }),
          })),
      };
    },
  };
  return layer;
}
