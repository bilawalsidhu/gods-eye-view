import * as Cesium from 'cesium';
import { createWeatherRendering } from './rendering.js';
import { imageryHostStatus } from './imageryHost.js';
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
// Xweather colours warnings by alert type and publishes no scale beyond that
// reference, so the card links it instead of drawing a ramp.
const ALERT_TYPES_URL =
  'https://www.xweather.com/docs/maps/reference/alert-types';
const utc = (value) =>
  value ? `${value.slice(5, 16).replace('T', ' ')} UTC` : 'Unavailable';

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
  credits = null,
} = {}) {
  if (typeof feed?.getSnapshot !== 'function')
    throw new TypeError('Weather requires a snapshot source');
  const radar = id === 'weather-radar';
  const lightning = id === 'weather-lightning';
  // Official warnings: Xweather only, so the card needs its key.
  const alerts = id === 'weather-alerts';
  const satellite = !radar && !lightning && !alerts;
  let source = alerts ? 'xweather' : 'nowcoast';
  let product = radar
    ? 'radar'
    : lightning
      ? 'lightning'
      : alerts
        ? 'xweather-alerts'
        : 'clouds-regional';
  const productFor = () =>
    radar
      ? source === 'xweather'
        ? 'xweather-radar'
        : 'radar'
      : lightning
        ? source === 'xweather'
          ? 'xweather-lightning'
          : 'lightning'
        : product;
  // Key presence and the free-month count, asked at most once a minute.
  let xweatherStatus = null;
  let statusAt = -Infinity;
  let keyFallback = false;
  let fallbackShownAt = null;
  // The warnings card without a key: it asks for status and nothing else.
  let keyRequired = false;
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
  const xweather = () => source === 'xweather';
  // A notice, not a header: gone a poll interval after the first NOAA frame.
  const fallbackNotice = () =>
    keyFallback &&
    (fallbackShownAt === null || Date.now() - fallbackShownAt < 60_000);
  const maxGap = () =>
    radar || alerts
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
  // Drop the current product's frames and acquire the newly chosen one.
  /** Drop the shown frame and manifest; the running update is left alone. */
  function clearFrames() {
    ++generation;
    frameRequest?.abort();
    frameRequest = null;
    noFrame = false;
    stop();
    manifest = null;
    error = null;
    followLatest = true;
    rendering?.clear();
  }
  function restage() {
    clearFrames();
    request?.abort();
    request = null;
    loading = false;
    if (clock) void clock.refresh();
    if (enabled) void layer.update(viewer);
  }

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
        // Xweather terms want attribution once its imagery is on screen.
        if (xweather())
          credits?.registerDynamicCredit(viewer, credits.XWEATHER_CREDIT);
        else if (keyFallback) fallbackShownAt ??= Date.now();
        void warmNext(time);
      }
      error = ok ? null : 'Frame unavailable; previous observation retained';
      if (!ok) stop();
      return ok;
    } catch {
      if (owner === generation && !controller.signal.aborted) {
        error = 'Weather imagery unavailable';
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
        : alerts
          ? 'Warnings'
          : 'Satellite clouds',
    icon: radar ? '◉' : lightning ? 'ϟ' : alerts ? '⚠' : '☁',
    // Registry id of the key this card needs; `getStats().keyRequired` says
    // when it is missing, and the panel names it.
    requiresKeyId: alerts ? 'xweather' : null,
    get source() {
      return xweather()
        ? 'Vaisala Xweather · OBSERVED'
        : 'NOAA nowCOAST · OBSERVED';
    },
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
      keyRequired = false;
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
        if (
          (radar || lightning || alerts) &&
          feed.getXweatherStatus &&
          Date.now() - statusAt >= 60_000
        ) {
          statusAt = Date.now();
          const status = await feed
            .getXweatherStatus({ signal: controller.signal })
            .catch(() => null);
          // Keep the last status through a failure; ask again next update.
          if (status) xweatherStatus = status;
          else statusAt = -Infinity;
          if (!enabled || controller.signal.aborted || request !== controller)
            return false;
          if (xweatherStatus?.hasKey) keyFallback = false;
          // A removed key must not leave the card asking Xweather for frames.
          // Switch to NOAA and fetch it in this same update: the lifecycle
          // reads `false` from a first update as a rejection and turns the
          // card off (a keyless share link with the Xweather source).
          // Warnings have no NOAA product to fall back to (below).
          if (
            !alerts &&
            xweather() &&
            xweatherStatus &&
            !xweatherStatus.hasKey
          ) {
            source = 'nowcoast';
            product = productFor();
            keyFallback = true;
            fallbackShownAt = null;
            clearFrames();
            notify();
          }
        }
        if (alerts) {
          // No key, or no answer yet: never ask Xweather for frames. A
          // removed key also takes its last frame off the map.
          const missing = xweatherStatus?.hasKey !== true;
          if (missing && (manifest || shownTime())) clearFrames();
          keyRequired = xweatherStatus?.hasKey === false;
          if (missing) {
            error = keyRequired ? null : 'Xweather status unavailable';
            return true;
          }
        }
        const snapshot = await feed.getSnapshot({
          product,
          signal: controller.signal,
        });
        if (!enabled || controller.signal.aborted || request !== controller)
          return false;
        if (snapshot.unavailable) {
          error = 'Weather source unavailable; previous observation retained';
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
        error = cause?.message || 'Weather unavailable';
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
        restage();
      }
      if (
        (radar || lightning) &&
        ['nowcoast', 'xweather'].includes(params.source) &&
        params.source !== source
      ) {
        source = params.source;
        product = productFor();
        keyFallback = false;
        // Ask again now: the choice may be the first spend this month.
        statusAt = -Infinity;
        restage();
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
        const b =
          lightning && !xweather()
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
      return satellite
        ? { product, opacity, infrared }
        : alerts
          ? { opacity }
          : { source, opacity };
    },
    getRowControls() {
      const shared = clock?.getState();
      const followLatest = isLatest();
      // A card waiting for its key has no frame to miss.
      const missing =
        !keyRequired &&
        noFrame &&
        shared?.mode === 'history' &&
        shared.products.find((entry) => entry.id === id)?.selected === null
          ? `No frame within ${maxGap() / 60_000 < 60 ? `${maxGap() / 60_000} min` : `${maxGap() / 3600_000} h`} of ${utc(shared.target)}`
          : null;
      const time = shownTime();
      const relation =
        shared?.mode === 'history' && time
          ? Date.parse(time) === Date.parse(shared.target)
            ? ' · synced'
            : Date.parse(time) < Date.parse(shared.target)
              ? ' · nearest'
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
            ? `${Math.floor(age / 60)}h ${age % 60}m ago`
            : `${age}m ago`;
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
          (lightning && !xweather() && lon > 0 && lon < 110));
      const count = (value) => Number(value).toLocaleString('en-US');
      const budget =
        xweather() && xweatherStatus?.hasKey
          ? xweatherStatus.over
            ? `Xweather · past the free ${count(xweatherStatus.allowance)} this month · requests may fail`
            : `Xweather · ${count(xweatherStatus.used)} / ${count(xweatherStatus.allowance)} free this month`
          : null;
      const controls = {
        readout: true,
        summary: {
          label: radar
            ? xweather()
              ? 'Rain radar · Global'
              : 'Rain radar · US'
            : lightning
              ? xweather()
                ? 'Lightning · 5 min flashes'
                : 'Lightning density · 15 min'
              : alerts
                ? 'Warnings · Xweather'
                : 'Satellite clouds',
          coverage: alerts
            ? 'US · Canada · Europe · Australia · Japan · Korea'
            : xweather()
              ? 'Global · 85°S–85°N'
              : radar
                ? 'CONUS'
                : lightning
                  ? 'Americas + Pacific'
                  : product === 'clouds'
                    ? 'Global · 60°S–60°N'
                    : 'North America',
          shownTime: time,
          maxGapMinutes: maxGap() / 60_000,
          detail: time
            ? `${followLatest ? 'Observed' : 'History'} · ${utc(time)} · ${lag}${relation}`
            : missing
              ? 'Observation unavailable'
              : keyRequired
                ? 'Xweather key required'
                : 'Waiting for observation',
          keyRequired,
          // The status line is one line high: the short form here, and the
          // panel puts the full key requirement on the detail line.
          status:
            (keyRequired
              ? 'Needs an Xweather key · see Provider Settings'
              : null) ||
            missing ||
            hostStatus ||
            // A refusal also fails the frame, so it must outrank that error.
            (xweather() && xweatherStatus?.upstreamError
              ? 'Xweather refused the request · see Provider Settings'
              : null) ||
            error ||
            diagnostic?.error ||
            (observationDelayed()
              ? 'Source observations delayed'
              : manifest?.stale
                ? 'Stale source'
                : fallbackNotice()
                  ? 'Xweather key removed · showing NOAA'
                  : loading
                    ? 'Loading next frame…'
                    : outside
                      ? 'Map center outside coverage'
                      : null),
          units: xweather()
            ? ''
            : radar
              ? 'dBZ'
              : lightning
                ? 'strikes/km²/min ×10³'
                : '',
          lines: xweather()
            ? [
                {
                  id: 'caveat',
                  text: radar
                    ? 'Radar where available; satellite-derived elsewhere'
                    : alerts
                      ? 'Official warnings where issued · no global coverage'
                      : 'Individual flashes, last 5 min · not density',
                  muted: true,
                },
                ...(budget
                  ? [
                      {
                        id: 'xweather-budget',
                        text: budget,
                        muted: !xweatherStatus.over,
                      },
                    ]
                  : []),
              ]
            : [],
        },
        chips: [
          ...(satellite
            ? [
                ['clouds-regional', 'N. America'],
                ['clouds', 'Global'],
              ].map(([value, label]) => ({
                id: value,
                label,
                active: product === value,
                params: { product: value },
                title:
                  value === 'clouds'
                    ? 'Hourly global mosaic; usually 2–3 hours delayed'
                    : 'GOES regional clouds; approximately 5-minute updates',
              }))
            : []),
          ...(satellite
            ? [
                {
                  id: 'filtered',
                  label: 'Clouds only',
                  active: infrared === 'filtered',
                  params: { infrared: 'filtered' },
                  title:
                    'Dim everything but the bright, cold cloud tops; a brightness filter, not a cloud mask',
                },
                {
                  id: 'full',
                  label: 'Full',
                  active: infrared === 'full',
                  params: { infrared: 'full' },
                  title: 'The complete infrared image at the chosen opacity',
                },
              ]
            : []),
          ...((radar || lightning) && (xweatherStatus?.hasKey || xweather())
            ? [
                ['nowcoast', 'NOAA'],
                ['xweather', 'Global (Xweather)'],
              ].map(([value, label]) => ({
                id: value,
                label,
                active: source === value,
                params: { source: value },
                title:
                  value === 'xweather'
                    ? "Vaisala Xweather · uses your key, counts toward your account's free monthly allowance"
                    : 'NOAA nowCOAST · keyless',
              }))
            : []),
          ...['light', 'strong'].map((value) => ({
            id: `opacity-${value}`,
            label: value === 'light' ? 'Soft' : 'Vivid',
            active: opacity === value,
            params: { opacity: value },
            title: 'Image opacity; does not alter the observed values',
          })),
          // Warnings cover a set of countries, not the global manifest bounds,
          // so flying there would imply global coverage.
          ...(alerts
            ? []
            : [
                {
                  id: 'coverage',
                  label: xweather()
                    ? 'View coverage'
                    : radar
                      ? 'View US radar'
                      : lightning
                        ? 'View Americas & Pacific'
                        : 'View coverage',
                  disabled: !manifest || !runNavigation,
                  params: { focus: true },
                },
              ]),
        ],
        // Xweather publishes no colour scale for radar-global or
        // lightning-flash (https://www.xweather.com/docs/maps/reference/legends);
        // info links the layer docs instead of a guessed ramp.
        legend:
          (radar || lightning) && !xweather()
            ? (lightning ? LIGHTNING_STOPS : STOPS).map(([label, color]) => ({
                label: String(label),
                color,
                blurb: lightning
                  ? `${label} strikes/km²/min ×10³ (15-minute density)`
                  : `${label} dBZ radar reflectivity`,
              }))
            : [],
        info: hostHidden
          ? hostStatus
          : `${xweather() ? (radar ? 'GLOBAL RADAR · ~2 min' : alerts ? 'OFFICIAL WARNINGS · ~3 min' : 'LIGHTNING FLASHES · last 5 min') : radar ? 'RADAR REFLECTIVITY · dBZ' : lightning ? 'LIGHTNING DENSITY · 15 min accumulation' : product === 'clouds' ? 'GLOBAL INFRARED · hourly' : 'GOES INFRARED · ~5 min'}\n${time ? `${followLatest ? 'Latest observation' : 'History'}: ${utc(time)}\n${lag}${current && !followLatest ? ` · frame ${index + 1}/${times.length}` : ''}${loading ? ' · loading' : ''}` : `Observation: unavailable${loading ? ' · loading' : ''}`}${missing ? `\n${missing}` : ''}${manifest?.stale ? '\nSTALE · cached source metadata' : ''}${error || diagnostic?.error ? '\n' + (error || diagnostic.error) : ''}\n${alerts ? `US · Canada · Europe · Australia · Japan · Korea · where agencies issue warnings\nColours: Xweather alert types — ${ALERT_TYPES_URL}` : xweather() ? `85°S–85°N · ${radar ? 'satellite-derived where radar is absent' : 'individual flashes, not density'}\nColours: Xweather ${radar ? 'radar' : 'lightning'} legend — https://www.xweather.com/docs/maps/layers` : radar ? 'Contiguous US · gaps ≠ no rain' : lightning ? 'Americas + Pacific · not individual strikes\nColor: strikes/km²/min ×10³' : product === 'clouds' ? '60°S–60°N · typically 2–3 h delayed' : 'North America · infrared imagery'}${outside ? '\nMap center is outside source coverage' : ''}${motion?.matches ? (clock ? '\nReduced motion · history playback unavailable' : '\nReduced motion · manual history available') : ''}`,
        infoTitle: alerts
          ? 'Vaisala Xweather alerts: official warnings, watches and advisories from national weather agencies in the US, Canada, Europe, Australia, Japan and Korea, coloured by alert type. Nothing is drawn where no agency issues warnings through Xweather. Not a forecast. Uses your key and counts toward the free monthly allowance.'
          : xweather()
            ? radar
              ? 'Vaisala Xweather radar-global: radar where available, satellite-derived radar elsewhere, about every 2 minutes. Web Mercator source, so coverage stops at 85°S–85°N. Not rain rate, a storm warning or a forecast. Uses your key and counts toward the free monthly allowance.'
              : 'Vaisala Xweather lightning-flash: cloud-to-ground and in-cloud flashes aggregated over the last 5 minutes. Coverage 85°S–85°N. Not a density or a safety warning. Uses your key and counts toward the free monthly allowance.'
            : lightning
              ? 'NOAA/NWS 15-minute lightning density derived from Vaisala NLDN/GLD360. Coverage 110°E across the Pacific/Americas to 0°, 25°S–80°N. Not a live strike count, global coverage or a safety warning.'
              : radar
                ? 'NOAA MRMS radar echoes indicate precipitation patterns, not rain rate, a storm warning or a future forecast. Native source approximately 1 km; display is limited to level 6. Frames use exact advertised observation times.'
                : 'GOES-19/18 longwave infrared Band 14 regional; NESDIS global longwave mosaic. Clouds only dims everything but bright, cold cloud tops; a brightness filter, not a cloud mask. Coverage and freshness differ by region.',
      };
      controls.summary.settings = [
        ...(satellite
          ? [
              {
                id: 'region',
                label: 'REGION',
                chips: controls.chips.filter(({ params }) => params.product),
              },
              {
                id: 'image',
                label: 'IMAGE',
                chips: controls.chips.filter(({ params }) => params.infrared),
              },
            ]
          : []),
        ...(controls.chips.some(({ params }) => params.source)
          ? [
              {
                id: 'source',
                label: 'SOURCE',
                chips: controls.chips.filter(({ params }) => params.source),
              },
            ]
          : []),
        {
          id: 'opacity',
          label: 'OPACITY',
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
        countLabel: isLatest() ? 'Observed' : 'History',
        lastUpdate: shownTime() ? Date.parse(shownTime()) : null,
        loading,
        // The panel names the key from `requiresKeyId`; this says it is due.
        keyRequired,
        ...(keyRequired ? { loadingLabel: 'KEY REQUIRED' } : {}),
        error: error || rendering?.getDiagnostics().error || null,
        stale: Boolean(manifest?.stale || observationDelayed()),
        source: xweather() ? 'Vaisala Xweather' : 'NOAA nowCOAST',
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
