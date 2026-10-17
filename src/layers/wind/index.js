import * as Cesium from 'cesium';
import { createWindRendering } from './rendering.js';
import { WIND_FIELDS } from './fields.js';
import {
  formatWindReading,
  windReadingResult,
  windUnitChips,
} from './presentation.js';
import {
  inspectWindAtCenter,
  createWindInspectionMarker,
  WIND_UNITS,
} from './inspection.js';
import { t, msg, translateKnown } from '../../i18n/index.js';
import { unitLabel } from '../../ui/unitLabels.js';

/** Format a forecast timestamp explicitly in UTC. */
export function formatWindValidTime(value) {
  const ms = Date.parse(value);
  return Number.isFinite(ms)
    ? `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`
    : null;
}

/*
 * Reasons the server puts in the manifest (server/providers/wind.js). They stay
 * English in data and are translated where they are shown.
 */
const SERVER_REASONS = new Set([msg('Wind upstream unavailable')]);
const reasonText = (reason) =>
  SERVER_REASONS.has(reason) ? t(reason) : translateKnown(reason) || null;

/**
 * A wind problem in the UI language. Source errors are English data; the
 * HTTP status line carries a number, so it goes back onto a placeholder.
 */
function presentWindProblem(problem) {
  const http = /^Wind HTTP (\d+)$/.exec(problem);
  if (http)
    return t('{source} HTTP {status}', { source: t('Wind'), status: http[1] });
  return t(problem);
}

/** Forecast issue time is source age; valid time is reported separately. */
export function windStats(manifest) {
  const run = Date.parse(manifest?.cycle?.runIso);
  return {
    count: manifest?.grid ? manifest.grid.nx * manifest.grid.ny : 0,
    lastUpdate: Number.isFinite(run) ? run : null,
    error:
      manifest?.reason ||
      (manifest?.unavailable ? msg('Wind unavailable') : null),
  };
}

/** Construct one wind layer with an explicit source and owned animation. */
export function createWindLayer({
  feed,
  clock,
  cesium = Cesium,
  container,
  createRendering = createWindRendering,
} = {}) {
  if (typeof feed?.getSnapshot !== 'function')
    throw new TypeError('Wind requires a snapshot source');
  let viewer = null;
  let request = null;
  let enabled = false;
  let rendering = null;
  let imageryHost = null;
  let manifest = null;
  let error = null;
  let loading = false;
  let model = 'gfs';
  let overlay = 'none';
  let paused = false;
  let units = 'km/h';
  let reading = null;
  let inspectionMarker = null;
  let sampledPosition = null;
  const hideInspection = () => {
    reading = null;
    sampledPosition = null;
    inspectionMarker?.clear();
  };
  const sample = (position) => {
    reading = inspectWindAtCenter(manifest, viewer, cesium, {
      position,
      units,
      overlay,
      model: model === 'ifs' ? 'ECMWF' : 'GFS',
      validTime:
        formatWindValidTime(manifest?.cycle?.validIso) || 'Unavailable',
      // i18n-ignore: English reading for AI tools; the card status uses t()
      status: loading
        ? 'Loading forecast'
        : error ||
          manifest?.reason ||
          (manifest?.stale ? 'Cached forecast · stale' : 'Model forecast'),
    });
    sampledPosition = reading.position || position || null;
    inspectionMarker?.show(sampledPosition);
  };
  const requestedScalar = () =>
    ['temperature', 'pressure'].includes(overlay) ? overlay : 'none';
  let generation = 0;
  let rowControlsListener = null;
  const notify = () => rowControlsListener?.();
  const unsubscribeClock = clock?.subscribe(notify);
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
        getHost: () =>
          imageryHost?.() ?? {
            collection: viewer.imageryLayers ?? viewer.scene?.imageryLayers,
            kind: 'globe',
          },
        onStatusChange: notify,
      });
      rendering.attach();
      rendering.setOptions?.({ overlay, paused });
      const target = container ?? nextViewer.container;
      inspectionMarker = createWindInspectionMarker({
        container: target,
        viewer,
        cesium,
      });
    },
    attachShellServices(services) {
      imageryHost =
        typeof services?.imageryHost === 'function'
          ? services.imageryHost
          : null;
      rendering?.rehome?.();
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
      rendering?.rehome?.();
      request?.abort();
      const controller = new AbortController();
      if (signal?.aborted) controller.abort(signal.reason);
      const abort = () => controller.abort(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      request = controller;
      generation += 1;
      loading = true;
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
        if (sampledPosition) sample(sampledPosition);
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
        error = cause?.message || msg('Wind source unavailable');
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
      if (unitsChanged) reading = formatWindReading(reading, units);
      if (params.inspect === false) hideInspection();
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
      if (overlayChanged && !needsField && sampledPosition)
        sample(sampledPosition);
      if (params.inspect === true && enabled) {
        sample();
      }
      notify();
    },
    getParams() {
      return { model, overlay, paused, units };
    },
    getRowControls() {
      const historyStatus =
        clock?.getState().mode === 'history'
          ? t('Forecast · does not follow history')
          : null;
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
      // Stored in English for diagnostics; shown translated.
      const imageryError =
        enabled && !loading && diagnostic?.imageryError
          ? t(diagnostic.imageryError)
          : null;
      const label = {
        none: t('Wind motion'),
        speed: t('Wind speed'),
        pressure: t('Sea-level pressure'),
        temperature: t('Air temperature · 2 m'),
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
      const speedLegendVisible =
        !imageryError &&
        (overlay === 'speed' ||
          (overlay === 'none' && diagnostic?.renderMode === 'canvas-fallback'));
      const controls = {
        readout: true,
        summary: {
          label,
          coverage: t('Global · 1° grid'),
          validTime: manifest?.cycle?.validIso,
          issuedTime: manifest?.cycle?.runIso,
          detail: t('{model} forecast · {time}', {
            model: model === 'ifs' ? 'ECMWF IFS' : 'GFS',
            time: valid || t('Unavailable'),
          }),
          status: loading
            ? t('Loading forecast')
            : preparing
              ? t('Preparing flow')
              : (error && presentWindProblem(error)) ||
                reasonText(manifest?.reason) ||
                imageryError ||
                (scalarMissing ? t('Selected field unavailable') : null) ||
                (manifest?.stale ? t('Cached forecast · stale') : null),
          units: legendUnit,
        },
        chips: [
          ...['gfs', 'ifs'].map((value) => ({
            id: `model-${value}`,
            label: value === 'ifs' ? 'ECMWF' : 'GFS', // i18n-ignore: forecast model names
            active: model === value,
            params: { model: value },
            title:
              value === 'ifs'
                ? t('ECMWF IFS surface forecast')
                : t('NOAA GFS surface forecast'),
          })),
          {
            id: 'motion',
            label: diagnostic?.reducedMotion
              ? t('Reduced motion')
              : paused
                ? t('Resume')
                : t('Pause'),
            active: motionPaused,
            disabled: Boolean(diagnostic?.reducedMotion),
            params: { paused: !paused },
            title: t(
              'Pause visual flow; forecast time does not advance with animation',
            ),
          },
          ...['none', 'speed', 'pressure', 'temperature'].map((value) => ({
            id: `overlay-${value}`,
            label: {
              none: t('None'),
              speed: t('Speed'),
              pressure: t('Pressure'),
              temperature: t('Temperature'),
            }[value],
            active: overlay === value,
            params: { overlay: value },
            title: {
              none: t('Wind trails with no field shading'),
              speed: t('How hard the surface wind is blowing'),
              pressure: t('Sea-level air pressure: broad highs and lows'),
              temperature: t('Air temperature two meters above the surface'),
            }[value],
          })),
          ...(speedLegendVisible ||
          diagnostic?.renderMode === 'canvas-fallback' ||
          Number.isFinite(reading?.speed)
            ? Object.keys(WIND_UNITS)
            : []
          ).map((value) => ({
            id: `units-${value}`,
            label: unitLabel(value),
            active: units === value,
            params: { units: value },
            title: t('Wind speed units'),
          })),
          {
            id: 'read-wind',
            label: t('Read wind at map center'),
            params: { inspect: true },
            disabled: loading || !manifest?.u || manifest?.unavailable,
            title: t(
              'Read the forecast at the center of the map without changing selection',
            ),
          },
        ],
        legend:
          scalarMissing ||
          imageryError ||
          (overlay === 'none' && !speedLegendVisible)
            ? []
            : legend,
        info: `${t('{model} forecast · {field} ({unit})', {
          model: model === 'ifs' ? 'ECMWF IFS' : 'GFS',
          field: label,
          unit: unitLabel(legendUnit),
        })}${historyStatus ? `\n${historyStatus}` : ''}\n${t('Valid: {time}', { time: valid || t('Unavailable') })}${loading ? ` · ${t('loading')}` : preparing ? ` · ${t('preparing')}` : ''}\n${t('Issued: {time}', { time: run || t('Unavailable') })}${manifest?.stale ? ` · ${t('STALE')}` : ''}${error ? `\n${presentWindProblem(error)}` : ''}${scalarMissing ? `\n${t('Selected field unavailable · wind remains visible')}` : ''}${imageryError && !scalarMissing ? `\n${t('{error} · wind remains visible', { error: imageryError })}` : ''}`,
        infoTitle: t(
          'Surface wind at 10 m. Approximately 1° global grid. Curves follow the 10 m wind field, lifted 12 km for visibility; display height is not weather altitude. View lighting is for readability. Animation shows flow through one fixed forecast; it does not advance time. Color fields drape the globe basemap or the active photorealistic 3D Tiles.',
        ),
      };
      controls.summary.reading = reading;
      controls.summary.result = reading ? windReadingResult(reading) : null;
      const setting = (id, label, prefix) => ({
        id,
        label,
        chips: controls.chips.filter((chip) => chip.id.startsWith(prefix)),
      });
      controls.summary.settings = [
        setting('model', t('MODEL'), 'model-'),
        setting('field', t('FIELD'), 'overlay-'),
        ...(controls.chips.some(({ id }) => id.startsWith('units-'))
          ? [{ id: 'units', label: t('UNITS'), chips: windUnitChips(units) }]
          : []),
        setting('motion', t('MOTION'), 'motion'),
      ];
      controls.summary.actions = controls.chips.filter(
        ({ id }) => id === 'read-wind',
      );
      return controls;
    },

    setRowControlsListener(listener) {
      rowControlsListener = typeof listener === 'function' ? listener : null;
    },
    destroy() {
      layer.disable();
      unsubscribeClock?.();
      rendering?.destroy();
      rendering = null;
      imageryHost = null;
      viewer = null;
      rowControlsListener = null;
      inspectionMarker?.destroy();
      inspectionMarker = null;
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
        countLabel: t('Forecast'),
        loading: loading || Boolean(preparing),
        model: model.toUpperCase(),
        overlay,
        paused,
        stale: Boolean(manifest?.stale),
        source: model === 'ifs' ? 'ECMWF IFS' : 'NOAA GFS',
        validTime:
          formatWindValidTime(manifest?.cycle?.validIso) || t('Unavailable'),
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
