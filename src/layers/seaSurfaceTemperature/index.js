import * as Cesium from 'cesium';
import { formatNumber, msg, t } from '../../i18n/index.js';
import { translateFeedError } from '../../ui/statusText.js';
import { createGlobeFieldTexture } from '../weather/fieldTexture.js';
import { WEATHER_SHELL_HEIGHTS } from '../weather/shellRendering.js';
import {
  SST_VIEWS,
  createSeaSurfaceTemperatureRaster,
  sampleSeaSurfaceTemperature,
  seaSurfaceTemperatureStops,
} from './model.js';
export * from './model.js';
export { createSeaSurfaceTemperatureSource } from './source.js';

/**
 * Below sea state (-1) and ocean currents (-2): temperature fills every sea
 * cell, so the other ocean fields draw over it, as with the shells over 3D
 * tiles.
 */
const IMAGERY_PRIORITY = -3;

/** `YYYY-MM-DD` in UTC, or null for an unreadable time. */
function utcDay(iso) {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : null;
}

/** `+1.5`, `0`, `-2`: an anomaly always says which side it is on. */
const signed = (value, options = {}) =>
  formatNumber(value, { signDisplay: 'exceptZero', ...options });

/**
 * Own one sea surface temperature display: the newest NOAA Coral Reef Watch
 * CoralTemp day, a satellite analysis, drawn as one texture on the globe or,
 * over 3D tiles, on a raised shell. The `view` param picks the temperature
 * or its anomaly from CRW's daily climatology; each is its own route and
 * ramp. The field is global and daily, so the camera never causes a
 * request; it refreshes every three hours.
 */
export function createSeaSurfaceTemperatureLayer({
  source,
  cesium = Cesium,
  createCanvas = () => document.createElement('canvas'),
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError(
      'Sea surface temperature layer requires a snapshot source',
    );
  let viewer = null;
  let enabled = false;
  let view = 'temperature';
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
    shellHeight: WEATHER_SHELL_HEIGHTS['sea-surface-temperature'],
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
    imageryError = texture.install({
      viewer,
      ...host(),
      raster: createSeaSurfaceTemperatureRaster(field),
    });
  }

  const layer = {
    id: 'sea-surface-temperature',
    name: 'Sea surface temperature',
    icon: '🌡',
    source: 'NOAA CORAL REEF WATCH · SATELLITE',
    updateInterval: 3 * 3600_000,
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
          view,
        });
        if (!enabled || request !== controller) return false;
        field = snapshot;
        error = null;
        install();
        return true;
      } catch (cause) {
        if (controller.signal.aborted || request !== controller) return false;
        // A failed refresh keeps the field already on the globe.
        error =
          cause?.message ||
          (view === 'anomaly'
            ? msg('Sea surface temperature anomaly unavailable')
            : msg('Sea surface temperature unavailable'));
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
    /**
     * `{view: 'temperature' | 'anomaly'}`. A new view drops the old field at
     * once; the update it starts aborts any request for the old view.
     */
    setParams(params = {}) {
      if (!SST_VIEWS.includes(params.view) || params.view === view) return true;
      view = params.view;
      field = null;
      error = null;
      texture.remove();
      notify();
      if (enabled) void layer.update(viewer);
      return true;
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
    /** The shown view's value under a point, in °C, or null on land. */
    sampleAt(lon, lat) {
      return field ? sampleSeaSurfaceTemperature(field, lon, lat) : null;
    },
    getStats() {
      const day = Date.parse(field?.validIso);
      const max = field?.maxValue;
      return {
        count: field ? 1 : 0,
        countLabel: !Number.isFinite(max)
          ? undefined
          : field.view === 'anomaly'
            ? t('Max {anomaly} °C from normal', {
                anomaly: signed(max, { maximumFractionDigits: 1 }),
              })
            : t('Max {temperature} °C', {
                temperature: formatNumber(max, { maximumFractionDigits: 1 }),
              }),
        loading,
        lastUpdate: Number.isFinite(day) ? day : null,
        validTime: field ? utcDay(field.validIso) : null,
        stale: Boolean(field?.stale),
        error: error || imageryError,
        source: 'NOAA Coral Reef Watch',
        fallback: false,
      };
    },
    getRowControls() {
      if (!enabled) return null;
      const day = field ? utcDay(field.validIso) : null;
      const anomaly = view === 'anomaly';
      return {
        chips: SST_VIEWS.map((value) => ({
          id: `view-${value}`,
          label: value === 'anomaly' ? t('Anomaly') : t('Temperature'),
          active: view === value,
          params: { view: value },
          title:
            value === 'anomaly'
              ? t('Difference from the long-term mean for this day of year')
              : t('Sea surface temperature in °C'),
        })),
        info:
          (day ? t('Observed {date}', { date: day }) : '') +
          (error ? `${day ? ' · ' : ''}${translateFeedError(error)}` : ''),
        infoTitle: anomaly
          ? t(
              'Night-time sea surface temperature minus the Coral Reef Watch daily climatology for the same place and day of year, from NOAA Coral Reef Watch, shown at 0.5°. Its baseline is 1985–1990 plus 1993, cooler than recent decades, so most of the ocean reads somewhat warm; marine heatwaves stand out from about +2 °C. Each day appears one to two days after the night it describes. Land and sea ice are left clear.',
            )
          : t(
              'Night-time sea surface temperature from NOAA Coral Reef Watch CoralTemp, a daily gap-free satellite analysis at 0.05°, shown at 0.5°. Each day appears one to two days after the night it describes. Water under sea ice reads near -1.8 °C. Land is left clear.',
            ),
        legend: [...seaSurfaceTemperatureStops(view)].reverse().map((stop) => ({
          label: t('{temperature} °C', {
            temperature: anomaly ? signed(stop.min) : formatNumber(stop.min),
          }),
          color: stop.color,
        })),
      };
    },
  };
  return layer;
}
