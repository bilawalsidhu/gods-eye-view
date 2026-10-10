import * as Cesium from 'cesium';
import { createWeatherRendering } from './rendering.js';
import { imageryHostStatus, NO_IMAGERY_HOST } from './imageryHost.js';
import { subscribeLocale, t } from '../../i18n/index.js';
import {
  RADAR_MAX_GAP_MS,
  REGIONAL_INFRARED_MAX_GAP_MS,
  GLOBAL_INFRARED_MAX_GAP_MS,
  LIGHTNING_MAX_GAP_MS,
} from './clock.js';

const STOPS = [
  [10, '#00ecec'],
  [20, '#0000f6'],
  [30, '#00c800'],
  [40, '#ffff00'],
  [50, '#ff9000'],
  [60, '#dc0000'],
  [70, '#ff00ff'],
  [80, '#05ede0'],
];
const LIGHTNING_STOPS = [
  ['0.1', '#FFFFCC'],
  ['1', '#FFA400'],
  ['5', '#FF4500'],
  ['10', '#FF0000'],
  ['50', '#FF00FF'],
  ['100', '#4000C0'],
  ['200', '#00C7FF'],
  ['300+', '#00FF00'],
];
const utc = (value) =>
  value
    ? `${value.slice(5, 16).replace('T', ' ')} UTC`
    : t('common.unavailable');
// Own status messages are stored as closed tokens and translated at paint, so
// a locale switch repaints persisted state. Unknown values stay verbatim.
const WEATHER_ERROR_KEYS = Object.freeze({
  frame: 'atmos.weather.error.frame',
  imagery: 'atmos.weather.error.imagery',
  source: 'atmos.weather.error.source',
  generic: 'atmos.weather.error.generic',
});
// Stable rendering-module messages, named at this presentation edge.
const KNOWN_DIAGNOSTIC_ERRORS = new Map([
  [NO_IMAGERY_HOST, 'atmos.weather.error.hostHidden'],
  [
    'Weather tiles unavailable · previous frame retained',
    'atmos.weather.error.tiles',
  ],
  ['Some weather tiles unavailable', 'atmos.weather.error.someTiles'],
]);
const messageText = (value) => {
  if (!value) return null;
  const key = WEATHER_ERROR_KEYS[value] || KNOWN_DIAGNOSTIC_ERRORS.get(value);
  return key ? t(key) : value;
};

/** A per-application observation layer, using the existing layer lifecycle and
 * row controls. History is transient: shared links always open latest imagery. */
export function createWeatherLayer({
  feed,
  clock,
  id = 'weather-radar',
  cesium = Cesium,
  createRendering = createWeatherRendering,
  documentRef = globalThis.document,
  eventTarget = globalThis.window,
  matchMedia = globalThis.matchMedia?.bind(globalThis),
} = {}) {
  if (typeof feed?.getSnapshot !== 'function')
    throw new TypeError('Weather requires a snapshot source');
  const radar = id === 'weather-radar';
  const lightning = id === 'weather-lightning';
  const satellite = !radar && !lightning;
  let product = radar ? 'radar' : lightning ? 'lightning' : 'clouds-regional';
  let opacity = 'strong';
  let infrared = 'filtered';
  let viewer = null,
    rendering = null,
    manifest = null,
    request = null,
    listener = null;
  let enabled = false,
    loading = false,
    playing = false,
    followLatest = true;
  let generation = 0,
    timer = null,
    error = null,
    removeCamera = null;
  let motion = null;
  let runNavigation = null;
  let imageryHost = null;
  let hostCollection;
  let hostHidden = false;
  let hostStatus = null;
  let unregisterClock = null;
  let frameRequest = null;
  let noFrame = false;
  const maxGap = () =>
    radar
      ? RADAR_MAX_GAP_MS
      : lightning
        ? LIGHTNING_MAX_GAP_MS
        : product === 'clouds'
          ? GLOBAL_INFRARED_MAX_GAP_MS
          : REGIONAL_INFRARED_MAX_GAP_MS;
  const isLatest = () =>
    clock ? clock.getState().mode === 'latest' : followLatest;
  const getHost = () =>
    imageryHost?.() ?? { collection: viewer?.imageryLayers, kind: 'globe' };
  const notify = () => listener?.();
  const shownTime = () => (noFrame ? null : rendering?.getDiagnostics().time);
  const unsubscribeClock = clock?.subscribe(() => {
    if (!clock.getState().playing || suspended()) rendering?.cancelPrefetch?.();
    notify();
  });
  // Row summaries persist between data ticks; repaint them on a locale switch.
  const unsubscribeLocale = subscribeLocale(() => notify());
  const observationDelayed = () =>
    manifest?.latest &&
    Date.now() - Date.parse(manifest.latest) >
      (product === 'clouds' ? 240 : lightning ? 45 : 20) * 60_000;
  const stop = () => {
    if (clock) return;
    playing = false;
    rendering?.cancelPrefetch?.();
    clearTimeout(timer);
    timer = null;
  };
  const suspended = () => hostHidden || documentRef?.hidden || motion?.matches;
  const onVisibility = () => {
    if (suspended()) rendering?.cancelPrefetch?.();
    if (clock) void clock.refresh();
    else if (suspended()) stop();
    notify();
  };

  function checkHost(resume = true) {
    const host = getHost();
    const status = imageryHostStatus(host);
    const changed = host.collection !== hostCollection || hostStatus !== status;
    hostCollection = host.collection;
    hostStatus = status;
    hostHidden = status !== null;
    // Keep playback intent and the displayed time while the host is unavailable.
    if (!changed || !rendering) return;
    ++generation;
    rendering.rehome?.();
    clearTimeout(timer);
    timer = null;
    loading = Boolean(request && !request.signal.aborted);
    if (clock && enabled) {
      if (resume) {
        void clock.refresh();
        if (!hostHidden && manifest && isLatest()) void show(manifest.latest);
      }
      notify();
      return;
    }
    if (resume && enabled && !hostHidden && manifest) {
      const time =
        followLatest || !manifest.times.includes(shownTime())
          ? manifest.latest
          : shownTime();
      if (
        time !== shownTime() ||
        (satellite && rendering.getDiagnostics().infrared !== infrared)
      )
        void show(time);
      else schedule();
    }
    notify();
  }
  const onMapStackChanged = () => checkHost();

  function schedule() {
    if (clock) return;
    clearTimeout(timer);
    timer = null;
    if (!enabled || !playing || suspended()) return;
    timer = setTimeout(() => {
      timer = null;
      const times = manifest?.times || [];
      const next = (times.indexOf(shownTime()) + 1) % times.length;
      if (times[next]) void show(times[next]);
      else stop();
    }, 2000);
  }
  async function applyClockTime(time, { signal }) {
    if (!enabled || signal.aborted) return false;
    if (time !== null) return show(time, signal);
    ++generation;
    frameRequest?.abort();
    frameRequest = null;
    noFrame = true;
    rendering?.setHidden(true);
    loading = Boolean(request && !request.signal.aborted);
    notify();
    return true;
  }
  function registerClock() {
    if (!clock || unregisterClock || !rendering || !enabled) return;
    unregisterClock = clock.register({
      id,
      get maxGapMs() {
        return maxGap();
      },
      getTimes: () => manifest?.times ?? [],
      getShownTime: shownTime,
      apply: applyClockTime,
      isSuspended: suspended,
    });
  }
  async function warmNext(time) {
    if (
      !enabled ||
      suspended() ||
      !(clock ? clock.getState().playing : playing)
    )
      return;
    const times = manifest?.times ?? [];
    const next = times[(times.indexOf(time) + 1) % times.length];
    if (!next || next === time) return;
    try {
      await rendering.prefetch?.(manifest, next, { infrared });
    } catch {
      // Speculative work must not change the displayed frame or playback state.
    }
  }
  async function show(time, signal) {
    checkHost(false);
    if (!enabled || hostHidden || !manifest?.times?.includes(time))
      return false;
    signal?.throwIfAborted();
    frameRequest?.abort();
    const controller = new AbortController();
    frameRequest = controller;
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const owner = ++generation;
    loading = true;
    notify();
    try {
      const ok = await rendering.setFrame(manifest, time, {
        signal: controller.signal,
        infrared,
      });
      if (owner !== generation || !enabled || controller.signal.aborted)
        return false;
      if (ok) {
        noFrame = false;
        rendering.setHidden?.(false);
        void warmNext(time);
      }
      error = ok ? null : 'frame';
      if (!ok) stop();
      return ok;
    } catch {
      if (owner === generation && !controller.signal.aborted) {
        error = 'imagery';
        stop();
      }
      return false;
    } finally {
      signal?.removeEventListener('abort', abort);
      if (frameRequest === controller) frameRequest = null;
      if (owner === generation) {
        loading = Boolean(request && !request.signal.aborted);
        notify();
        if (clock && isLatest()) void clock.refresh();
        schedule();
      }
    }
  }
  const layer = {
    id,
    name: radar
      ? 'Rain radar'
      : lightning
        ? 'Lightning density'
        : 'Satellite clouds',
    icon: radar ? '◉' : lightning ? 'ϟ' : '☁',
    source: 'NOAA nowCOAST · OBSERVED',
    updateInterval: lightning ? 600_000 : 120_000,
    init(nextViewer) {
      viewer = nextViewer;
      rendering = createRendering({
        viewer,
        cesium,
        getHost,
        onChange: notify,
      });
      checkHost(false);
      eventTarget?.addEventListener?.(
        'gev:map-stack-changed',
        onMapStackChanged,
      );
      rendering.setAlpha(opacity === 'light' ? 0.4 : satellite ? 0.7 : 0.8);
      motion = matchMedia?.('(prefers-reduced-motion: reduce)');
      motion?.addEventListener?.('change', onVisibility);
      documentRef?.addEventListener?.('visibilitychange', onVisibility);
      registerClock();
      removeCamera = viewer.camera.moveEnd?.addEventListener(() => {
        checkHost();
        if (enabled) notify();
      });
    },
    attachShellServices(services) {
      imageryHost =
        typeof services?.imageryHost === 'function'
          ? services.imageryHost
          : null;
      checkHost();
      runNavigation =
        typeof services?.runNavigation === 'function'
          ? services.runNavigation
          : null;
      notify();
    },
    enable() {
      enabled = true;
      registerClock();
    },
    disable() {
      enabled = false;
      unregisterClock?.();
      unregisterClock = null;
      ++generation;
      frameRequest?.abort();
      frameRequest = null;
      noFrame = false;
      request?.abort();
      request = null;
      stop();
      rendering?.clear();
      manifest = null;
      loading = false;
      error = null;
      followLatest = true;
    },
    async update(_viewer, { signal } = {}) {
      if (!enabled) return false;
      checkHost(false);
      clearTimeout(timer);
      timer = null;
      request?.abort();
      const controller = new AbortController();
      if (signal?.aborted) controller.abort(signal.reason);
      request = controller;
      const abort = () => {
        controller.abort(signal.reason);
        stop();
      };
      signal?.addEventListener('abort', abort, { once: true });
      loading = true;
      notify();
      try {
        signal?.throwIfAborted();
        const snapshot = await feed.getSnapshot({
          product,
          signal: controller.signal,
        });
        if (!enabled || controller.signal.aborted || request !== controller)
          return false;
        if (snapshot.unavailable) {
          error = 'source';
          stop();
          return true;
        }
        manifest = snapshot;
        error = null;
        if (clock) {
          await clock.refresh();
          if (
            isLatest() &&
            request === controller &&
            !controller.signal.aborted
          )
            await show(snapshot.latest, controller.signal);
          return (
            !controller.signal.aborted && request === controller && enabled
          );
        }
        const time =
          followLatest || !snapshot.times.includes(shownTime())
            ? snapshot.latest
            : shownTime();
        if (
          shownTime() !== time ||
          (satellite && rendering.getDiagnostics().infrared !== infrared)
        )
          await show(time, controller.signal);
        return !controller.signal.aborted && request === controller && enabled;
      } catch (cause) {
        if (controller.signal.aborted || request !== controller) return false;
        error = cause?.message || 'generic';
        stop();
        return true;
      } finally {
        signal?.removeEventListener('abort', abort);
        if (request === controller) {
          request = null;
          loading = Boolean(rendering?.getDiagnostics().loading);
          notify();
          schedule();
        }
      }
    },
    setParams(params = {}) {
      const infraredChanged =
        satellite &&
        ['filtered', 'full'].includes(params.infrared) &&
        params.infrared !== infrared;
      if (infraredChanged) infrared = params.infrared;
      if (['light', 'strong'].includes(params.opacity)) {
        opacity = params.opacity;
        rendering?.setAlpha(opacity === 'light' ? 0.4 : satellite ? 0.7 : 0.8);
      }
      if (
        satellite &&
        ['clouds', 'clouds-regional'].includes(params.product) &&
        params.product !== product
      ) {
        product = params.product;
        ++generation;
        frameRequest?.abort();
        frameRequest = null;
        noFrame = false;
        request?.abort();
        request = null;
        stop();
        manifest = null;
        error = null;
        loading = false;
        followLatest = true;
        rendering?.clear();
        if (clock) void clock.refresh();
        if (enabled) void layer.update(viewer);
      }
      if (infraredChanged && enabled && manifest) {
        clearTimeout(timer);
        timer = null;
        if (clock && !isLatest()) void clock.refresh();
        else void show(shownTime() || manifest.latest);
      }
      if (
        params.focus === true &&
        enabled &&
        manifest?.bounds &&
        runNavigation
      ) {
        const b = lightning
          ? { west: 110, south: -25, east: 0, north: 80 }
          : manifest.bounds;
        runNavigation(() =>
          viewer.camera.flyTo({
            destination: cesium.Rectangle.fromDegrees(
              b.west,
              b.south,
              b.east,
              b.north,
            ),
            duration: motion?.matches ? 0 : 1.4,
          }),
        );
      }
      if (clock && enabled) {
        if (params.play === true) void clock.togglePlay();
        if (params.latest === true) void clock.latest();
        if ([-1, 1].includes(params.step)) void clock.step(params.step);
      }
      if (
        !clock &&
        params.play === true &&
        enabled &&
        manifest?.times?.length > 1 &&
        !suspended()
      ) {
        playing = !playing;
        followLatest = false;
        if (playing) schedule();
        else stop();
      }
      if (!clock && params.latest === true && manifest) {
        stop();
        followLatest = true;
        void show(manifest.latest);
      }
      if (!clock && [-1, 1].includes(params.step) && manifest && !loading) {
        stop();
        followLatest = false;
        const at = manifest.times.indexOf(shownTime());
        const next = Math.max(
          0,
          Math.min(manifest.times.length - 1, at + params.step),
        );
        void show(manifest.times[next]);
      }
      notify();
    },
    getParams() {
      return radar
        ? { opacity }
        : satellite
          ? { product, opacity, infrared }
          : { product, opacity };
    },
    getRowControls() {
      const shared = clock?.getState();
      const followLatest = isLatest();
      const missing =
        noFrame &&
        shared?.mode === 'history' &&
        shared.products.find((entry) => entry.id === id)?.selected === null
          ? t('weather.noFrame', {
              gap:
                maxGap() / 60_000 < 60
                  ? t('weather.gap.minutes', { gap: maxGap() / 60_000 })
                  : t('weather.gap.hours', { gap: maxGap() / 3600_000 }),
              time: utc(shared.target),
            })
          : null;
      const time = shownTime();
      const relation =
        shared?.mode === 'history' && time
          ? Date.parse(time) === Date.parse(shared.target)
            ? t('weather.synced')
            : Date.parse(time) < Date.parse(shared.target)
              ? t('weather.nearest')
              : ''
          : '';
      const times = manifest?.times || [];
      const index = times.indexOf(time);
      const current = index >= 0;
      const age = time
        ? Math.max(0, Math.floor((Date.now() - Date.parse(time)) / 60000))
        : null;
      const lag =
        age === null
          ? ''
          : age >= 60
            ? t('weather.age.hoursMinutes', {
                h: Math.floor(age / 60),
                m: age % 60,
              })
            : t('weather.age.minutes', { m: age });
      const diagnostic = rendering?.getDiagnostics();
      const b = manifest?.bounds;
      const canvas = viewer?.scene?.canvas;
      const point =
        canvas &&
        viewer.camera.pickEllipsoid?.(
          new cesium.Cartesian2(
            canvas.clientWidth / 2,
            canvas.clientHeight / 2,
          ),
          viewer.scene.globe.ellipsoid,
        );
      const camera = point
        ? cesium.Cartographic.fromCartesian(point, viewer.scene.globe.ellipsoid)
        : null;
      const lon = camera ? cesium.Math.toDegrees(camera.longitude) : 0;
      const lat = camera ? cesium.Math.toDegrees(camera.latitude) : 0;
      const outside =
        b &&
        camera &&
        (lon < b.west ||
          lon > b.east ||
          lat < b.south ||
          lat > b.north ||
          (lightning && lon > 0 && lon < 110));
      const controls = {
        readout: true,
        summary: {
          label: radar
            ? t('atmos.weather.summary.radar')
            : lightning
              ? t('atmos.weather.summary.lightning')
              : t('atmos.weather.summary.satellite'),
          coverage: radar
            ? t('atmos.weather.summary.coverage.conus')
            : lightning
              ? t('atmos.weather.summary.coverage.lightning')
              : product === 'clouds'
                ? t('atmos.weather.summary.coverage.global')
                : t('atmos.weather.summary.coverage.northAmerica'),
          shownTime: time,
          maxGapMinutes: maxGap() / 60_000,
          detail: time
            ? t('atmos.weather.summary.detail', {
                mode: followLatest
                  ? t('atmos.weather.observed')
                  : t('atmos.weather.history'),
                time: utc(time),
                lag,
                relation,
              })
            : missing
              ? t('atmos.weather.summary.observationUnavailable')
              : t('atmos.weather.summary.waitingForObservation'),
          status:
            missing ||
            messageText(hostStatus) ||
            messageText(error) ||
            messageText(diagnostic?.error) ||
            (observationDelayed()
              ? t('atmos.weather.summary.delayed')
              : manifest?.stale
                ? t('atmos.weather.summary.stale')
                : loading
                  ? t('atmos.weather.summary.loading')
                  : outside
                    ? t('atmos.weather.summary.outside')
                    : null),
          units: radar ? 'dBZ' : lightning ? 'strikes/km²/min ×10³' : '',
        },
        chips: [
          ...(satellite
            ? [
                ['clouds-regional', 'atmos.weather.chips.northAmerica'],
                ['clouds', 'atmos.weather.chips.global'],
              ].map(([value, key]) => ({
                id: value,
                label: t(key),
                active: product === value,
                params: { product: value },
                title:
                  value === 'clouds'
                    ? t('atmos.weather.chips.globalMosaicTitle')
                    : t('atmos.weather.chips.regionalCloudsTitle'),
              }))
            : []),
          ...(satellite
            ? [
                {
                  id: 'filtered',
                  label: t('atmos.weather.chips.cloudsOnly'),
                  active: infrared === 'filtered',
                  params: { infrared: 'filtered' },
                  title: t('atmos.weather.chips.cloudsOnlyTitle'),
                },
                {
                  id: 'full',
                  label: t('atmos.weather.chips.full'),
                  active: infrared === 'full',
                  params: { infrared: 'full' },
                  title: t('atmos.weather.chips.fullTitle'),
                },
              ]
            : []),
          ...['light', 'strong'].map((value) => ({
            id: `opacity-${value}`,
            label:
              value === 'light'
                ? t('atmos.weather.chips.soft')
                : t('atmos.weather.chips.vivid'),
            active: opacity === value,
            params: { opacity: value },
            title: t('atmos.weather.chips.opacityTitle'),
          })),
          {
            id: 'coverage',
            label: radar
              ? t('atmos.weather.chips.viewRadar')
              : lightning
                ? t('atmos.weather.chips.viewLightning')
                : t('atmos.weather.chips.viewCoverage'),
            disabled: !manifest || !runNavigation,
            params: { focus: true },
          },
        ],
        legend:
          radar || lightning
            ? (lightning ? LIGHTNING_STOPS : STOPS).map(([label, color]) => ({
                label: String(label),
                color,
                blurb: lightning
                  ? t('atmos.weather.legend.lightning', { label })
                  : t('atmos.weather.legend.radar', { label }),
              }))
            : [],
        info: hostHidden
          ? messageText(hostStatus)
          : `${radar ? t('atmos.weather.info.radar') : lightning ? t('atmos.weather.info.lightning') : product === 'clouds' ? t('atmos.weather.info.globalInfrared') : t('atmos.weather.info.goesInfrared')}\n${time ? `${followLatest ? t('atmos.weather.info.latest') : t('atmos.weather.history')}: ${utc(time)}\n${lag}${current && !followLatest ? t('atmos.weather.info.frame', { i: index + 1, n: times.length }) : ''}${loading ? t('atmos.weather.info.loading') : ''}` : `${t('atmos.weather.info.observationUnavailable')}${loading ? t('atmos.weather.info.loading') : ''}`}${missing ? `\n${missing}` : ''}${manifest?.stale ? `\n${t('atmos.weather.info.stale')}` : ''}${error || diagnostic?.error ? '\n' + messageText(error || diagnostic.error) : ''}\n${radar ? t('atmos.weather.info.radarScope') : lightning ? `${t('atmos.weather.info.lightningScope')}\n${t('atmos.weather.info.lightningColor')}` : product === 'clouds' ? t('atmos.weather.info.globalScope') : t('atmos.weather.info.regionalScope')}${outside ? `\n${t('atmos.weather.info.outside')}` : ''}${motion?.matches ? (clock ? `\n${t('atmos.weather.info.reducedMotionClock')}` : `\n${t('atmos.weather.info.reducedMotionManual')}`) : ''}`,
        infoTitle: t(
          lightning
            ? 'atmos.weather.infoTitle.lightning'
            : radar
              ? 'atmos.weather.infoTitle.radar'
              : 'atmos.weather.infoTitle.satellite',
        ),
      };
      controls.summary.settings = [
        ...(satellite
          ? [
              {
                id: 'region',
                label: t('atmos.weather.settings.region'),
                chips: controls.chips.filter(({ params }) => params.product),
              },
              {
                id: 'image',
                label: t('atmos.weather.settings.image'),
                chips: controls.chips.filter(({ params }) => params.infrared),
              },
            ]
          : []),
        {
          id: 'opacity',
          label: t('atmos.weather.settings.opacity'),
          chips: controls.chips.filter(({ params }) => params.opacity),
        },
      ];
      controls.summary.actions = controls.chips.filter(
        ({ id }) => id === 'coverage',
      );
      return controls;
    },
    setRowControlsListener(value) {
      listener = typeof value === 'function' ? value : null;
    },
    getStats() {
      return {
        count: shownTime() ? 1 : 0,
        countLabel: isLatest()
          ? t('atmos.weather.observed')
          : t('atmos.weather.history'),
        lastUpdate: shownTime() ? Date.parse(shownTime()) : null,
        loading,
        error:
          messageText(error) ||
          messageText(rendering?.getDiagnostics().error) ||
          null,
        stale: Boolean(manifest?.stale || observationDelayed()),
        source: 'NOAA nowCOAST',
        observedAt: shownTime(),
      };
    },
    getDiagnostics() {
      const shared = clock?.getState();
      return {
        ...rendering?.getDiagnostics(),
        playing: shared ? shared.playing : playing && !hostHidden,
        followLatest: isLatest(),
        ...(shared
          ? {
              clock: {
                mode: shared.mode,
                target: shared.target,
                playing: shared.playing,
              },
            }
          : {}),
        historyFrames: manifest?.times?.length || 0,
        timerActive: timer !== null,
      };
    },
    destroy() {
      layer.disable();
      unsubscribeClock?.();
      unsubscribeLocale?.();
      removeCamera?.();
      removeCamera = null;
      motion?.removeEventListener?.('change', onVisibility);
      documentRef?.removeEventListener?.('visibilitychange', onVisibility);
      eventTarget?.removeEventListener?.(
        'gev:map-stack-changed',
        onMapStackChanged,
      );
      runNavigation = null;
      imageryHost = null;
      viewer = null;
      rendering = null;
      listener = null;
    },
  };
  return layer;
}
