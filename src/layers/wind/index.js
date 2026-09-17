import * as Cesium from 'cesium';
import { createWindRendering } from './rendering.js';
import { WIND_FIELDS } from './fields.js';
import { createWindPresentation } from './presentation.js';
import {
  inspectWindAtCenter,
  createWindInspectionMarker,
  WIND_UNITS,
} from './inspection.js';

/** Format a forecast timestamp explicitly in UTC. */
export function formatWindValidTime(value) {
  const ms = Date.parse(value);
  return Number.isFinite(ms)
    ? `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`
    : null;
}

/** Forecast issue time is source age; valid time is reported separately. */
export function windStats(manifest) {
  const run = Date.parse(manifest?.cycle?.runIso);
  return {
    count: manifest?.grid ? manifest.grid.nx * manifest.grid.ny : 0,
    lastUpdate: Number.isFinite(run) ? run : null,
    error:
      manifest?.reason || (manifest?.unavailable ? 'Wind unavailable' : null),
  };
}

/** Construct one wind layer with an explicit source and owned animation. */
export function createWindLayer({
  feed,
  cesium = Cesium,
  container,
  createRendering = createWindRendering,
  createPresentation = createWindPresentation,
} = {}) {
  if (typeof feed?.getSnapshot !== 'function')
    throw new TypeError('Wind requires a snapshot source');
  let viewer = null;
  let request = null;
  let enabled = false;
  let rendering = null;
  let manifest = null;
  let error = null;
  let loading = false;
  let model = 'gfs';
  let overlay = 'none';
  let paused = false;
  let units = 'km/h';
  let presentation = null;
  let inspectionMarker = null;
  const hideInspection = () => {
    presentation?.hide();
    inspectionMarker?.clear();
  };
  const requestedScalar = () =>
    ['temperature', 'pressure'].includes(overlay) ? overlay : 'none';
  let generation = 0;
  let rowControlsListener = null;
  const notify = () => rowControlsListener?.();
  const layer = {
    id: 'wind',
    name: 'Wind',
    icon: '🌬',
    source: 'GFS / ECMWF IFS · FORECAST',
    updateInterval: 3600_000,
    init(nextViewer) {
      viewer = nextViewer;
      rendering = createRendering({
        cesium,
        container: container ?? nextViewer.container,
        getViewer: () => viewer,
        onStatusChange: notify,
      });
      rendering.attach();
      rendering.setOptions?.({ overlay, paused });
      const target = container ?? nextViewer.container;
      if (target?.appendChild && target.ownerDocument?.createElement)
        presentation = createPresentation({
          container: target,
          onClose: () => inspectionMarker?.clear(),
        });
      inspectionMarker = createWindInspectionMarker({
        container: target,
        viewer,
        cesium,
      });
    },
    enable() {
      enabled = true;
      rendering?.start();
    },
    disable() {
      enabled = false;
      generation += 1;
      request?.abort();
      request = null;
      loading = false;
      // The renderer releases its field on disable. Retaining a manifest here
      // would falsely satisfy an appearance-only reuse after the next enable.
      manifest = null;
      error = null;
      hideInspection();
      rendering?.stop();
      rendering?.clear();
    },
    async update(nextViewer, { signal } = {}) {
      if (!enabled) return false;
      request?.abort();
      const controller = new AbortController();
      if (signal?.aborted) controller.abort(signal.reason);
      const abort = () => controller.abort(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      request = controller;
      generation += 1;
      loading = true;
      hideInspection();
      notify();
      try {
        signal?.throwIfAborted();
        const snapshot = await feed.getSnapshot({
          signal: controller.signal,
          model,
          overlay: requestedScalar(),
        });
        if (!enabled || controller.signal.aborted || request !== controller)
          return false;
        manifest = snapshot;
        error = null;
        if (snapshot.unavailable) {
          rendering.stop();
          rendering.clear();
        } else {
          rendering.setOptions?.({ overlay, paused });
          rendering.setField(snapshot);
          rendering.start();
        }
        return true;
      } catch (cause) {
        if (controller.signal.aborted || request !== controller) return false;
        error = cause?.message || 'Wind source unavailable';
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
      const previousScalar = requestedScalar();
      const modelChanged =
        ['gfs', 'ifs'].includes(params.model) && params.model !== model;
      const overlayChanged =
        ['none', 'speed', 'temperature', 'pressure'].includes(params.overlay) &&
        params.overlay !== overlay;
      if (typeof params.paused === 'boolean') paused = params.paused;
      const unitsChanged =
        Object.hasOwn(WIND_UNITS, params.units) && params.units !== units;
      if (unitsChanged) units = params.units;
      if (modelChanged) model = params.model;
      if (overlayChanged) overlay = params.overlay;
      rendering?.setOptions?.({ overlay, paused });
      if (modelChanged || overlayChanged || unitsChanged) hideInspection();
      if (modelChanged) {
        manifest = null;
        error = null;
        rendering?.stop();
        rendering?.clear();
      }
      const needsField =
        modelChanged ||
        (overlayChanged &&
          (!manifest?.u ||
            manifest.unavailable ||
            (requestedScalar() !== 'none' &&
              manifest?.scalar?.kind !== overlay)));
      const changesRequest =
        modelChanged ||
        (overlayChanged && previousScalar !== requestedScalar());
      // None and Speed use the identical U/V request. Keep an active refresh
      // alive while changing its presentation, including the first load.
      if (changesRequest || (overlayChanged && needsField && !request)) {
        request?.abort();
        request = null;
        const current = ++generation;
        loading = enabled && needsField;
        if (enabled && needsField)
          queueMicrotask(() => {
            if (enabled && generation === current) void layer.update(viewer);
          });
        else if (enabled && manifest && !manifest.unavailable)
          rendering?.start();
      }
      if (params.inspect === true && enabled) {
        const reading = inspectWindAtCenter(manifest, viewer, cesium, {
          units,
          overlay,
          model: model === 'ifs' ? 'ECMWF IFS' : 'NOAA GFS',
          validTime:
            formatWindValidTime(manifest?.cycle?.validIso) || 'Unavailable',
          status: loading
            ? 'Loading forecast'
            : error ||
              manifest?.reason ||
              (manifest?.stale ? 'Cached forecast · stale' : 'Model forecast'),
        });
        inspectionMarker?.show(reading.position);
        presentation?.show(reading);
      }
      notify();
    },
    getParams() {
      return { model, overlay, paused, units };
    },
    getRowControls() {
      const valid = formatWindValidTime(manifest?.cycle?.validIso);
      const run = formatWindValidTime(manifest?.cycle?.runIso);
      const diagnostic = rendering?.getDiagnostics?.();
      const motionPaused = paused || diagnostic?.reducedMotion;
      const preparing =
        enabled &&
        diagnostic?.renderMode === 'gpu-streamlines' &&
        diagnostic.gpu?.pathCount > 0 &&
        !diagnostic.gpu?.ready;
      const scalarMissing =
        !loading &&
        requestedScalar() !== 'none' &&
        manifest &&
        (!manifest.scalar || manifest.scalar.kind !== overlay);
      const imageryError =
        enabled && !loading ? diagnostic?.imageryError : null;
      const label = {
        none: 'Wind motion',
        speed: 'Wind speed',
        pressure: 'Sea-level pressure',
        temperature: 'Air temperature · 2 m',
      }[overlay];
      const kind = ['temperature', 'pressure'].includes(overlay)
        ? overlay
        : 'speed';
      const spec = WIND_FIELDS[kind];
      const legendUnit = kind === 'speed' ? units : spec.units;
      const legend = spec.stops.map((color, index) => {
        const value =
          spec.min + ((spec.max - spec.min) * index) / (spec.stops.length - 1);
        const display = Math.round(
          kind === 'speed' ? value * WIND_UNITS[units] : value,
        );
        return {
          color,
          label: `${display}${index === spec.stops.length - 1 ? '+' : ''}`,
        };
      });
      return {
        summary: {
          label,
          detail: `${model === 'ifs' ? 'ECMWF IFS' : 'GFS'} forecast · ${valid || 'Unavailable'}`,
          status: loading
            ? 'Loading forecast'
            : preparing
              ? 'Preparing flow'
              : error ||
                manifest?.reason ||
                imageryError ||
                (scalarMissing ? 'Selected field unavailable' : null) ||
                (manifest?.stale ? 'Cached forecast · stale' : null),
          units: legendUnit,
        },
        chips: [
          ...['gfs', 'ifs'].map((value) => ({
            id: `model-${value}`,
            label: value === 'ifs' ? 'ECMWF' : 'GFS',
            active: model === value,
            params: { model: value },
            title:
              value === 'ifs'
                ? 'ECMWF IFS surface forecast'
                : 'NOAA GFS surface forecast',
          })),
          {
            id: 'motion',
            label: diagnostic?.reducedMotion
              ? 'Reduced motion'
              : paused
                ? 'Resume'
                : 'Pause',
            active: motionPaused,
            disabled: Boolean(diagnostic?.reducedMotion),
            params: { paused: !paused },
            title:
              'Pause visual flow; forecast time does not advance with animation',
          },
          ...['none', 'speed', 'pressure', 'temperature'].map((value) => ({
            id: `overlay-${value}`,
            label: {
              none: 'No color field',
              speed: 'Speed',
              pressure: 'Pressure',
              temperature: 'Temperature',
            }[value],
            active: overlay === value,
            params: { overlay: value },
            title: {
              none: 'Wind trails with no field shading',
              speed: 'How hard the surface wind is blowing',
              pressure: 'Sea-level air pressure: broad highs and lows',
              temperature: 'Air temperature two meters above the surface',
            }[value],
          })),
          ...Object.keys(WIND_UNITS).map((value) => ({
            id: `units-${value}`,
            label: value,
            active: units === value,
            params: { units: value },
            title: 'Wind speed units',
          })),
          {
            id: 'inspect-center',
            label: 'Inspect center',
            params: { inspect: true },
            disabled: loading || !manifest?.u || manifest?.unavailable,
            title:
              'Read the forecast at the center of the map without changing selection',
          },
        ],
        legend:
          scalarMissing ||
          imageryError ||
          (overlay === 'none' && diagnostic?.renderMode === 'gpu-streamlines')
            ? []
            : legend,
        info: `${model === 'ifs' ? 'ECMWF IFS' : 'GFS'} forecast · ${label} (${legendUnit})\nValid: ${valid || 'Unavailable'}\nIssued: ${run || 'Unavailable'}${manifest?.stale ? ' · STALE' : ''}${loading ? '\nLoading forecast…' : preparing ? '\nPreparing globe flow…' : ''}${error ? '\n' + error : ''}${scalarMissing ? '\nSelected field unavailable · wind remains visible' : ''}${imageryError && !scalarMissing ? '\n' + imageryError + ' · wind remains visible' : ''}`,
        infoTitle:
          'Surface wind at 10 m. Approximately 1° global grid. Curves follow the 10 m wind field, lifted 12 km for visibility; display height is not weather altitude. View lighting is for readability. Animation shows flow through one fixed forecast; it does not advance time. Color fields drape the globe basemap; photorealistic 3D tiles may cover them.',
      };
    },

    setRowControlsListener(listener) {
      rowControlsListener = typeof listener === 'function' ? listener : null;
    },
    destroy() {
      layer.disable();
      rendering?.destroy();
      rendering = null;
      viewer = null;
      rowControlsListener = null;
      inspectionMarker?.destroy();
      inspectionMarker = null;
      presentation?.destroy();
      presentation = null;
    },
    getStats() {
      const diagnostic = rendering?.getDiagnostics?.();
      const preparing =
        enabled &&
        diagnostic?.renderMode === 'gpu-streamlines' &&
        diagnostic.gpu?.pathCount > 0 &&
        !diagnostic.gpu?.ready;
      const imageryError =
        enabled && !loading
          ? rendering?.getDiagnostics?.()?.imageryError
          : null;
      return {
        ...windStats(manifest),
        countLabel: 'Forecast',
        loading: loading || Boolean(preparing),
        model: model.toUpperCase(),
        overlay,
        paused,
        stale: Boolean(manifest?.stale),
        source: model === 'ifs' ? 'ECMWF IFS' : 'NOAA GFS',
        validTime:
          formatWindValidTime(manifest?.cycle?.validIso) || 'Unavailable',
        error:
          error ||
          windStats(manifest).error ||
          (requestedScalar() !== 'none' ? manifest?.scalarError : null) ||
          imageryError,
      };
    },
    getDiagnostics() {
      return rendering?.getDiagnostics?.() || {};
    },
    getParticleCount() {
      return rendering?.getParticleCount() || 0;
    },
  };
  return layer;
}
