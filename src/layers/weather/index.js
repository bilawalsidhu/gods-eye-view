import { createWeatherRendering } from './rendering.js';
import { createWeatherShell, globeImageryHost } from './shellRendering.js';
import { weatherFrameSource } from './source.js';
import { imageryHostStatus } from './imageryHost.js';
import { weatherDisplay, weatherSourceName, insideExtent } from './display.js';
import {
  RADAR_MAX_GAP_MS,
  REGIONAL_INFRARED_MAX_GAP_MS,
  GLOBAL_INFRARED_MAX_GAP_MS,
  LIGHTNING_MAX_GAP_MS,
  atLeastFrameSpacing,
  createWeatherClock,
} from './clock.js';
import { worldClock } from '../../time/worldClock.js';
import { formatUtcDayMonth, t, msg } from '../../i18n/index.js';
import { formatScaleLabel } from '../../ui/unitLabels.js';
import { toLonLatH } from '../../geo/ellipsoid.js';
import {
  cameraOf,
  canvasOf,
  findCamera,
  findQuery,
} from '../../render/rendererOf.js';

/**
 * A stored (English) failure in the language. HTTP failures from source.js
 * and infraredImage.js carry their status in the text, so they are matched
 * back onto a placeholder; anything else is a plain catalog key.
 */
function presentWeatherProblem(problem) {
  const http = /^Weather (image )?HTTP (\d+)$/.exec(problem);
  if (http) {
    return http[1]
      ? t('Weather image HTTP {status}', { status: http[2] })
      : t('Weather HTTP {status}', { status: http[2] });
  }
  return t(problem);
}

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
    ? `${formatUtcDayMonth(value)} ${value.slice(11, 16)} UTC`
    : t('Unavailable');

/**
 * Move `world`, the world clock, as its timeline does: `play` toggles play at
 * the world clock's rate (the speed the timeline chose), from the start of the
 * covered time when live or at its end, unless `canPlay` is false or there
 * is no covered time (no timeline to play); `latest` goes live. `step` (-1 or 1) goes to the previous or next of `frames`, the
 * weather frames; the timeline does not mark them, so this is the row's own
 * way to step through them.
 */
function moveWorldTime(world, frames, { play, latest, step }, canPlay) {
  if (!world) return;
  if (play === true) {
    const state = world.getState();
    if (state.playing) world.pause();
    else {
      // With no time to show there is no timeline, and nothing to play.
      const covered = canPlay && state.supported ? world.coverage() : null;
      if (covered) {
        // The covered time reaches to now, as the timeline's track does.
        const end = Math.max(covered.end, world.wallNow());
        if (state.live || state.timeMs >= end)
          world.seek(Math.min(covered.start, state.timeMs));
        world.play({ continuous: true });
      }
    }
  }
  if (latest === true) world.goLive();
  if (step === -1 || step === 1) {
    const at = world.getState().timeMs;
    const times = frames
      .map((time) => Date.parse(time))
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    const to =
      step < 0
        ? times.findLast((frame) => frame < at)
        : times.find((frame) => frame > at);
    if (to === undefined) return;
    world.pause();
    world.seek(to);
  }
}

// What a layer that has not built its own clock yet reads: live, no frames.
const IDLE_CLOCK = Object.freeze({
  mode: 'latest',
  target: null,
  advancing: false,
  timeline: [],
  products: [],
});

/** A per-application observation layer, using the existing layer lifecycle and
 * row controls. Its time is the world clock's, so a link made away from live
 * opens its imagery at that time; one made live opens the latest. Its frames
 * follow `clock`, a weather clock several layers share; without one the layer
 * builds its own on the page's world clock when first enabled and keeps it
 * for its lifetime; that clock never sends the world live. The feed may also
 * name its source with `sourceName(kind)`, `kind` being 'radar', 'lightning'
 * or 'satellite'; NOAA nowCOAST is named otherwise. */
export function createWeatherLayer({
  feed,
  clock: sharedClock,
  id = 'weather-radar',
  createRendering = createWeatherRendering,
  documentRef = globalThis.document,
  eventTarget = globalThis.window,
  matchMedia = globalThis.matchMedia?.bind(globalThis),
} = {}) {
  if (typeof feed?.getSnapshot !== 'function')
    throw new TypeError('Weather requires a snapshot source');
  // Without a shared clock the layer builds its own when first enabled, so a
  // layer never turned on leaves the world clock alone.
  let ownClock = null;
  let clock = sharedClock ?? null;
  // A feed may also supply decoded frames; see weatherFrameSource.
  const radar = id === 'weather-radar';
  const lightning = id === 'weather-lightning';
  const satellite = !radar && !lightning;
  // A feed may name the source behind each product ('radar', 'lightning' or
  // 'satellite'); its row then says so before a manifest names it. A name
  // that fails, like a manifest's, leaves the built-in one.
  let sourceName = null;
  try {
    sourceName =
      weatherSourceName(
        feed.sourceName?.(
          radar ? 'radar' : lightning ? 'lightning' : 'satellite',
        ),
      ) ?? null;
  } catch (cause) {
    console.warn('[weather] source name unavailable:', cause);
  }
  let product = radar ? 'radar' : lightning ? 'lightning' : 'clouds-regional';
  let opacity = 'strong';
  let infrared = 100;
  let viewer = null,
    rendering = null,
    manifest = null,
    request = null,
    listener = null;
  let destroyed = false;
  let enabled = false,
    loading = false;
  let generation = 0,
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
  // A product's own gap, and the delay after which its latest frame reads
  // late. A feed whose frames come further apart holds each frame, and waits
  // for the next, as long as its frames are apart (see atLeastFrameSpacing).
  const productGap = () =>
    radar
      ? RADAR_MAX_GAP_MS
      : lightning
        ? LIGHTNING_MAX_GAP_MS
        : product === 'clouds'
          ? GLOBAL_INFRARED_MAX_GAP_MS
          : REGIONAL_INFRARED_MAX_GAP_MS;
  const productDelay = () =>
    (product === 'clouds' ? 240 : lightning ? 45 : 20) * 60_000;
  // Read for every frame a selection weighs, so worked out once per product
  // and frame list.
  let spaced = null;
  const spacedTimes = () => {
    const times = manifest?.times ?? [];
    if (spaced?.times !== times || spaced?.product !== product)
      spaced = {
        times,
        product,
        gap: atLeastFrameSpacing(productGap(), times),
        delay: atLeastFrameSpacing(productDelay(), times),
      };
    return spaced;
  };
  const maxGap = () => spacedTimes().gap;
  const clockState = () => clock?.getState() ?? IDLE_CLOCK;
  const isLatest = () => clockState().mode === 'latest';
  const getHost = () => imageryHost?.() ?? globeImageryHost(viewer);
  const notify = () => listener?.();
  const shownTime = () => (noFrame ? null : rendering?.getDiagnostics().time);
  // The row and readout follow the time through the panel
  // (`panelFollowsTime`); the clock only steers prefetching here.
  const onClock = () => {
    if (!clock.getState().advancing || suspended())
      rendering?.cancelPrefetch?.();
  };
  let unsubscribeClock = clock?.subscribe(onClock) ?? null;
  const ensureClock = () => {
    if (clock) return;
    ownClock = createWeatherClock({ world: worldClock, shared: false });
    clock = ownClock;
    unsubscribeClock = clock.subscribe(onClock);
  };
  // Ages and delays are measured from the time the layer shows: the world
  // clock's time at a past time, the wall clock while live.
  const worldNow = () => {
    const shared = clockState();
    return shared.mode === 'history' && shared.target
      ? Date.parse(shared.target)
      : Date.now();
  };
  const observationDelayed = () =>
    manifest?.latest &&
    worldNow() - Date.parse(manifest.latest) > spacedTimes().delay;
  const suspended = () => hostHidden || documentRef?.hidden || motion?.matches;
  const onVisibility = () => {
    if (suspended()) rendering?.cancelPrefetch?.();
    void clock?.refresh();
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
    loading = Boolean(request && !request.signal.aborted);
    if (enabled && resume) {
      void clock.refresh();
      if (!hostHidden && manifest && isLatest()) void show(manifest.latest);
    }
    notify();
  }
  const onMapStackChanged = () => checkHost();

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
    if (unregisterClock || !rendering || !enabled || !clock) return;
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
    if (!enabled || suspended() || !clockState().advancing) return;
    // The world plays on past the newest frame, never round to the first.
    const times = manifest?.times ?? [];
    const next = times[times.indexOf(time) + 1];
    if (!next) return;
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
      error = ok
        ? null
        : msg('Frame unavailable; previous observation retained');
      return ok;
    } catch {
      if (owner === generation && !controller.signal.aborted)
        error = msg('Weather imagery unavailable');
      return false;
    } finally {
      signal?.removeEventListener('abort', abort);
      if (frameRequest === controller) frameRequest = null;
      if (owner === generation) {
        loading = Boolean(request && !request.signal.aborted);
        notify();
        if (isLatest()) void clock?.refresh();
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
    source: sourceName ?? 'NOAA nowCOAST · OBSERVED',
    updateInterval: lightning ? 600_000 : 120_000,
    // The row and the Weather readout read the scene time; the panel reads
    // them again when it moves.
    panelFollowsTime: true,
    init(nextViewer, { panel = null } = {}) {
      // The panels' handle: invalidated when the row or readout changed.
      listener = panel ? () => panel.invalidate() : null;
      viewer = nextViewer;
      rendering = createRendering({
        viewer,
        createShell: createWeatherShell,
        getHost,
        onChange: notify,
        frameSource: weatherFrameSource(feed),
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
      // Destroyed, the layer stays off: no clock is built for it again.
      if (destroyed) return;
      enabled = true;
      ensureClock();
      if (!removeCamera) {
        removeCamera =
          findCamera(viewer)?.on('moveEnd', () => {
            checkHost();
            notify();
          }) ?? null;
      }
      registerClock();
    },
    disable() {
      enabled = false;
      removeCamera?.();
      removeCamera = null;
      unregisterClock?.();
      unregisterClock = null;
      ++generation;
      frameRequest?.abort();
      frameRequest = null;
      noFrame = false;
      request?.abort();
      request = null;
      rendering?.cancelPrefetch?.();
      rendering?.clear();
      manifest = null;
      loading = false;
      error = null;
    },
    async update(_viewer, { signal } = {}) {
      if (!enabled) return false;
      checkHost(false);
      request?.abort();
      const controller = new AbortController();
      if (signal?.aborted) controller.abort(signal.reason);
      request = controller;
      const abort = () => controller.abort(signal.reason);
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
          return enabled && !signal?.aborted && request !== controller;
        if (snapshot.unavailable) {
          error = msg(
            'Weather source unavailable; previous observation retained',
          );
          return true;
        }
        manifest = snapshot;
        error = null;
        // The shown frame may stay; its credit follows the refreshed manifest.
        rendering?.updateSnapshot?.(snapshot);
        await clock.refresh();
        if (isLatest() && request === controller && !controller.signal.aborted)
          await show(snapshot.latest, controller.signal);
        return (
          enabled &&
          !signal?.aborted &&
          (!controller.signal.aborted || request !== controller)
        );
      } catch (cause) {
        if (controller.signal.aborted || request !== controller)
          return enabled && !signal?.aborted && request !== controller;
        error = cause?.message || msg('Weather unavailable');
        return true;
      } finally {
        signal?.removeEventListener('abort', abort);
        if (request === controller) {
          request = null;
          loading = Boolean(rendering?.getDiagnostics().loading);
          notify();
        }
      }
    },
    setParams(params = {}) {
      const nextInfrared = satellite
        ? params.infrared === 'full'
          ? 0
          : params.infrared === 'filtered'
            ? 100
            : params.infrared
        : null;
      const infraredChanged =
        satellite &&
        Number.isInteger(nextInfrared) &&
        nextInfrared >= 0 &&
        nextInfrared <= 100 &&
        nextInfrared !== infrared;
      if (infraredChanged) infrared = nextInfrared;
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
        rendering?.cancelPrefetch?.();
        manifest = null;
        error = null;
        loading = false;
        rendering?.clear();
        void clock?.refresh();
        if (enabled) void layer.update(viewer);
      }
      if (infraredChanged && enabled && manifest) {
        if (!isLatest()) void clock.refresh();
        else void show(shownTime() || manifest.latest);
      }
      if (
        params.focus === true &&
        enabled &&
        manifest?.bounds &&
        runNavigation
      ) {
        const b =
          weatherDisplay(manifest).extent ??
          (lightning
            ? { west: 110, south: -25, east: 0, north: 80 }
            : manifest.bounds);
        runNavigation(() => {
          cameraOf(viewer).flyTo(
            {
              rect: {
                west: b.west,
                south: b.south,
                east: b.east,
                north: b.north,
              },
            },
            { durationS: motion?.matches ? 0 : 1.4 },
          );
        });
      }
      // Time is the world's: these move the world clock as its timeline
      // does, and every layer that follows it moves along. A step goes
      // through every shown observation's frames, and this row's own even
      // while it is suspended.
      // Play does nothing while every observation it would show is suspended
      // (reduced motion, a hidden page, no imagery host), as the row says.
      if (enabled)
        moveWorldTime(
          clock.world,
          [...clock.getTimeline(), ...(manifest?.times ?? [])],
          params,
          clock.getState().products.some(({ suspended }) => !suspended),
        );
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
      const shared = clockState();
      const followLatest = isLatest();
      // Source-described text is data: shown as is, never translated.
      const display = weatherDisplay(manifest);
      const missing =
        noFrame &&
        shared.mode === 'history' &&
        shared.products.find((entry) => entry.id === id)?.selected === null
          ? maxGap() / 60_000 < 60
            ? t('No frame within {gap} min of {time}', {
                gap: Math.round(maxGap() / 60_000),
                time: utc(shared.target),
              })
            : t('No frame within {gap} h of {time}', {
                gap: Math.round(maxGap() / 360_000) / 10,
                time: utc(shared.target),
              })
          : null;
      const time = shownTime();
      const relation =
        shared?.mode === 'history' && time
          ? Date.parse(time) === Date.parse(shared.target)
            ? 'synced'
            : Date.parse(time) < Date.parse(shared.target)
              ? 'nearest'
              : ''
          : '';
      const times = manifest?.times || [];
      const index = times.indexOf(time);
      const current = index >= 0;
      const age = time
        ? Math.max(0, Math.floor((worldNow() - Date.parse(time)) / 60000))
        : null;
      const lag =
        age === null
          ? ''
          : age >= 60
            ? t('{hours}h {minutes}m ago', {
                hours: Math.floor(age / 60),
                minutes: age % 60,
              })
            : t('{minutes}m ago', { minutes: age });
      const diagnostic = rendering?.getDiagnostics();
      // Errors are stored in English (stats, diagnostics); shown translated.
      const problem = error || diagnostic?.error;
      const shownProblem = problem ? presentWeatherProblem(problem) : null;
      const shownHost = hostStatus ? t(hostStatus) : null;
      const b = manifest?.bounds;
      const canvas = canvasOf(viewer);
      const point =
        canvas &&
        findQuery(viewer)?.pickEllipsoid(
          canvas.clientWidth / 2,
          canvas.clientHeight / 2,
        );
      const camera = point ? toLonLatH(point) : null;
      const lon = camera ? camera.lon : 0;
      const lat = camera ? camera.lat : 0;
      const outside =
        b &&
        camera &&
        (lon < b.west ||
          lon > b.east ||
          lat < b.south ||
          lat > b.north ||
          (display.extent
            ? !insideExtent(display.extent, lon, lat)
            : lightning && lon > 0 && lon < 110));
      let detail = time
        ? t('{state} · {time} · {lag}', {
            state: followLatest ? t('Observed') : t('History'),
            time: utc(time),
            lag,
          })
        : missing
          ? t('Observation unavailable')
          : t('Waiting for observation');
      if (relation === 'synced') detail = t('{detail} · synced', { detail });
      else if (relation === 'nearest')
        detail = t('{detail} · nearest', { detail });
      const infoHeading = radar
        ? display.units !== undefined
          ? t('RADAR · {units}', { units: display.units })
          : t('RADAR REFLECTIVITY · dBZ')
        : lightning
          ? t('LIGHTNING DENSITY · 15 min accumulation')
          : product === 'clouds'
            ? t('GLOBAL INFRARED · hourly')
            : t('GOES INFRARED · ~5 min');
      const infoTime = time
        ? `${t('{state}: {time}', {
            state: followLatest ? t('Latest observation') : t('History'),
            time: utc(time),
          })}\n${[
            lag,
            current && !followLatest
              ? t('frame {index}/{total}', {
                  index: index + 1,
                  total: times.length,
                })
              : '',
            loading ? t('loading') : '',
          ]
            .filter(Boolean)
            .join(' · ')}`
        : [t('Observation: unavailable'), loading ? t('loading') : '']
            .filter(Boolean)
            .join(' · ');
      const coverageLine =
        display.coverage ??
        (radar
          ? t('Contiguous US · gaps ≠ no rain')
          : lightning
            ? t('Americas + Pacific · not individual strikes')
            : product === 'clouds'
              ? t('60°S–60°N · typically 2–3 h delayed')
              : t('North America · infrared imagery'));
      const infoCoverage = lightning
        ? `${coverageLine}\n${
            display.units === undefined
              ? t('Color: strikes/km²/min ×10³')
              : t('Color: {units}', { units: display.units })
          }`
        : coverageLine;
      const stops =
        display.legend ?? (radar ? STOPS : lightning ? LIGHTNING_STOPS : []);
      const infoMotion = motion?.matches
        ? t('Reduced motion · history playback unavailable')
        : '';
      const controls = {
        readout: true,
        summary: {
          label: radar
            ? t('Rain radar · US')
            : lightning
              ? t('Lightning density · 15 min')
              : t('Satellite clouds'),
          coverage:
            display.coverage ??
            (radar
              ? 'CONUS'
              : lightning
                ? t('Americas + Pacific')
                : product === 'clouds'
                  ? t('Global · 60°S–60°N')
                  : t('North America')),
          shownTime: time,
          maxGapMinutes: Math.round(maxGap() / 60_000),
          detail,
          status:
            missing ||
            shownHost ||
            shownProblem ||
            (observationDelayed()
              ? t('Source observations delayed')
              : manifest?.stale
                ? t('Stale source')
                : loading
                  ? t('Loading next frame…')
                  : outside
                    ? t('Map center outside coverage')
                    : null),
          units:
            display.units ??
            (radar ? 'dBZ' : lightning ? t('strikes/km²/min ×10³') : ''),
          // Source units are data: the panel shows them untranslated.
          ...(display.units !== undefined ? { unitsVerbatim: true } : {}),
        },
        chips: [
          ...(satellite
            ? [
                ['clouds-regional', t('N. America')],
                ['clouds', t('Global')],
              ].map(([value, label]) => ({
                id: value,
                label,
                active: product === value,
                params: { product: value },
                title:
                  value === 'clouds'
                    ? t('Hourly global mosaic; usually 2–3 hours delayed')
                    : t('GOES regional clouds; approximately 5-minute updates'),
              }))
            : []),
          ...(satellite
            ? [
                {
                  id: 'filtered',
                  label: t('Clouds only'),
                  active: infrared === 100,
                  params: { infrared: 100 },
                  title: t(
                    'Apply the full cloud brightness key; 100% filter strength',
                  ),
                },
                {
                  id: 'full',
                  label: t('Full'),
                  active: infrared === 0,
                  params: { infrared: 0 },
                  title: t(
                    'Show the complete infrared image; 0% filter strength',
                  ),
                },
              ]
            : []),
          ...['light', 'strong'].map((value) => ({
            id: `opacity-${value}`,
            label: value === 'light' ? t('Soft') : t('Vivid'),
            active: opacity === value,
            params: { opacity: value },
            title: t('Image opacity; does not alter the observed values'),
          })),
          {
            id: 'coverage',
            label:
              display.coverage !== undefined || display.extent !== undefined
                ? t('View coverage')
                : radar
                  ? t('View US radar')
                  : lightning
                    ? t('View Americas & Pacific')
                    : t('View coverage'),
            disabled: !manifest || !runNavigation,
            params: { focus: true },
          },
        ],
        legend: stops.map(([label, color]) => ({
          label: String(label),
          color,
          blurb: display.legend
            ? `${formatScaleLabel(label)} ${display.units}`
            : lightning
              ? t('{value} strikes/km²/min ×10³ (15-minute density)', {
                  value: formatScaleLabel(label),
                })
              : t('{value} dBZ radar reflectivity', {
                  value: formatScaleLabel(label),
                }),
        })),
        info: hostHidden
          ? shownHost
          : `${infoHeading}\n${infoTime}${missing ? `\n${missing}` : ''}${manifest?.stale ? `\n${t('STALE · cached source metadata')}` : ''}${shownProblem ? `\n${shownProblem}` : ''}\n${infoCoverage}${outside ? `\n${t('Map center is outside source coverage')}` : ''}${infoMotion ? `\n${infoMotion}` : ''}`,
        infoTitle:
          display.info ??
          (lightning
            ? t(
                'NOAA/NWS 15-minute lightning density derived from Vaisala NLDN/GLD360. Coverage 110°E across the Pacific/Americas to 0°, 25°S–80°N. Not a live strike count, global coverage or a safety warning.',
              )
            : radar
              ? t(
                  'NOAA MRMS radar echoes indicate precipitation patterns, not rain rate, a storm warning or a future forecast. Native source approximately 1 km; display is limited to level 6. Frames use exact advertised observation times.',
                )
              : t(
                  'GOES-19/18 longwave infrared Band 14 regional; NESDIS global longwave mosaic. Clouds only dims everything but bright, cold cloud tops; a brightness filter, not a cloud mask. Coverage and freshness differ by region.',
                )),
      };
      controls.summary.settings = [
        ...(satellite
          ? [
              {
                id: 'region',
                label: t('REGION'),
                chips: controls.chips.filter(({ params }) => params.product),
              },
              {
                id: 'image',
                label: t('IMAGE'),
                chips: controls.chips.filter(
                  ({ params }) => params.infrared !== undefined,
                ),
                range: {
                  id: 'cloud-filter',
                  param: 'infrared',
                  min: 0,
                  max: 100,
                  step: 1,
                  value: infrared,
                  label: t('FILTER'),
                  unit: '%',
                  ariaLabel: t('Cloud filter strength'),
                  commitOnChange: true,
                },
              },
            ]
          : []),
        {
          id: 'opacity',
          label: t('OPACITY'),
          chips: controls.chips.filter(({ params }) => params.opacity),
        },
      ];
      controls.summary.actions = controls.chips.filter(
        ({ id }) => id === 'coverage',
      );
      return controls;
    },
    getStats() {
      const { source } = weatherDisplay(manifest);
      return {
        count: shownTime() ? 1 : 0,
        countLabel: isLatest() ? t('Observed') : t('History'),
        lastUpdate: shownTime() ? Date.parse(shownTime()) : null,
        loading,
        error: error || rendering?.getDiagnostics().error || null,
        stale: Boolean(manifest?.stale || observationDelayed()),
        ...(source === undefined && sourceName === null
          ? { source: 'NOAA nowCOAST' }
          : // Source text is data: the panel shows it untranslated.
            { source: source ?? sourceName, sourceVerbatim: true }),
        observedAt: shownTime(),
      };
    },
    getDiagnostics() {
      const shared = clockState();
      return {
        ...rendering?.getDiagnostics(),
        playing: shared.advancing,
        followLatest: isLatest(),
        clock: {
          mode: shared.mode,
          target: shared.target,
          playing: shared.advancing,
        },
        historyFrames: manifest?.times?.length || 0,
      };
    },
    destroy() {
      destroyed = true;
      layer.disable();
      unsubscribeClock?.();
      unsubscribeClock = null;
      ownClock?.destroy();
      if (ownClock) clock = ownClock = null;
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
