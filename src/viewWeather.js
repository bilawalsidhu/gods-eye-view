/**
 * The weather drawn around the view, on a renderer that draws weather (the
 * `weather` capability, `globe.weather`). Live, it is the conditions observed
 * under the camera, asked of the weather service again after five minutes or
 * 25 km of movement; the user can turn live off and set clouds, fog, rain and
 * snow by hand. Without the capability it does nothing and the Display panel
 * shows no weather controls.
 */
import { findCamera, findGlobe } from './render/rendererOf.js';
import { greatCircleMeters } from './geoDistance.js';
import { deriveWeatherEffectProfile } from './weatherEffectsMath.js';
import { CLEAR_WEATHER } from './render/weather.js';

const REFRESH_MS = 5 * 60_000;
const MOVE_REFRESH_M = 25_000;
/** Above this the camera is over a region, not a place: no new observation. */
const OBSERVE_BELOW_M = 200_000;
const STORAGE_KEY = 'godsEyeView.viewWeather';
/** The conditions the user sets by hand, in the order the panel lists them. */
export const MANUAL_KEYS = Object.freeze(['clouds', 'fog', 'rain', 'snow']);

/**
 * What a renderer draws for an observation: the profile the app derives from
 * the report (`deriveWeatherEffectProfile`), clear when there is none.
 * @param {object|null|undefined} observation The weather service's `weather`.
 * @returns {import('./render/contract/globe').WeatherSettings}
 */
export function weatherFromObservation(observation) {
  const profile = deriveWeatherEffectProfile(observation);
  if (!profile.available) return CLEAR_WEATHER;
  const kph = Number(observation.windKph);
  return {
    clouds: profile.cloud,
    fog: profile.fog,
    haze: profile.haze,
    rain: profile.rain,
    snow: profile.snow,
    wind: {
      speedMps: Number.isFinite(kph) ? Math.max(0, kph / 3.6) : 0,
      fromDeg: profile.windDirectionDeg,
    },
  };
}

/** The saved choice: live, and the hand-set strengths (0..1). */
function readSaved(storage) {
  try {
    const saved = JSON.parse(storage?.getItem(STORAGE_KEY) ?? 'null');
    if (!saved || typeof saved !== 'object') return null;
    const manual = {};
    for (const key of MANUAL_KEYS) {
      const value = Number(saved.manual?.[key]);
      manual[key] = Number.isFinite(value)
        ? Math.min(1, Math.max(0, value))
        : 0;
    }
    return { live: saved.live !== false, manual };
  } catch {
    return null;
  }
}

/**
 * @param {object} viewer The scene host a renderer is bound to.
 * @param {object} options
 * @param {{getConditions: Function}} options.weatherService
 * @param {{publishWeather: Function, connect: Function, detach: Function}} options.store
 *   The Display store: the panel's Weather group and its controls.
 * @param {Storage} [options.storage]
 * @param {() => number} [options.now]
 * @returns {{refresh: () => Promise<void>, destroy: () => void}}
 */
export function createViewWeather(
  viewer,
  {
    weatherService,
    store,
    storage = globalThis.localStorage,
    now = () => Date.now(),
  },
) {
  const port = findGlobe(viewer)?.weather ?? null;
  if (!port) {
    store?.publishWeather?.(null);
    return { refresh: async () => {}, destroy() {} };
  }
  const saved = readSaved(storage);
  let live = saved?.live ?? true;
  const manual = saved?.manual ?? { clouds: 0, fog: 0, rain: 0, snow: 0 };
  /** Haze by hand: what was shown when live went off, until fog is moved. */
  let manualHaze = null;
  /** The observation under `anchor`, or null: none for where the camera is. */
  let observed = null;
  /** `loading`, `live`, `unavailable` or `none` (no place under the camera). */
  let status = 'loading';
  let fetchedAt = -Infinity;
  let anchor = null;
  /** The fetch in flight: its abort and the point it asks about. */
  let pending = null;
  let timer = null;
  let destroyed = false;

  function settings() {
    if (live) return observed ?? CLEAR_WEATHER;
    return {
      ...manual,
      haze: manualHaze ?? manual.fog * 0.78,
      // The observed wind, or still air.
      wind: (observed ?? CLEAR_WEATHER).wind,
    };
  }

  function apply() {
    port.set(settings());
    publish();
  }

  function publish() {
    const shown = settings();
    store?.publishWeather?.({
      live,
      status,
      values: Object.fromEntries(
        MANUAL_KEYS.map((key) => [key, Math.round(shown[key] * 100)]),
      ),
    });
  }

  function save() {
    try {
      storage?.setItem(STORAGE_KEY, JSON.stringify({ live, manual }));
    } catch {
      // Private mode: the choice lasts the visit.
    }
  }

  /** Hand-set from what is shown now, so going off live changes nothing. */
  function takeShown() {
    const shown = settings();
    for (const key of MANUAL_KEYS) manual[key] = shown[key];
    manualHaze = shown.haze;
    live = false;
  }

  function cameraPoint() {
    const pose = findCamera(viewer)?.pose();
    if (!pose || !Number.isFinite(pose.lat) || !Number.isFinite(pose.lon))
      return null;
    return { lat: pose.lat, lon: pose.lon, height: pose.height };
  }

  const far = (a, b) => !a || !b || greatCircleMeters(a, b) >= MOVE_REFRESH_M;

  /** Ask for the conditions under the camera when they are due. */
  async function refresh() {
    if (destroyed || !live || globalThis.document?.hidden) return;
    const point = cameraPoint();
    if (!point) return;
    if (!(point.height < OBSERVE_BELOW_M)) {
      // Over a region, not a place: no one place's weather over it all.
      pending?.abort.abort();
      pending = null;
      if (observed || status !== 'none') {
        observed = null;
        anchor = null;
        status = 'none';
        apply();
      }
      return;
    }
    if (far(anchor, point) && observed) {
      // Moved off the place observed: clear until the new report comes.
      observed = null;
      status = 'loading';
      apply();
    }
    const due = !observed || now() - fetchedAt >= REFRESH_MS;
    if (!due) return;
    // A fetch for a place far from here is out of date: ask again here.
    if (pending && !far(pending.point, point)) return;
    pending?.abort.abort();
    const request = { abort: new AbortController(), point };
    pending = request;
    try {
      const payload = await weatherService.getConditions(point.lat, point.lon, {
        signal: request.abort.signal,
      });
      if (destroyed || pending !== request) return;
      observed = weatherFromObservation(payload?.weather);
      status = payload?.weather ? 'live' : 'unavailable';
    } catch (error) {
      if (destroyed || pending !== request || error?.name === 'AbortError')
        return;
      // Missing weather fails clear instead of inventing conditions.
      observed = CLEAR_WEATHER;
      status = 'unavailable';
    } finally {
      if (pending === request) pending = null;
    }
    fetchedAt = now();
    anchor = point;
    schedule();
    if (live) apply();
    else publish();
  }

  /** The next refresh, five minutes after the last report. */
  function schedule() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (destroyed) return;
    const wait = Number.isFinite(fetchedAt)
      ? Math.max(1000, fetchedAt + REFRESH_MS - now())
      : REFRESH_MS;
    timer = setTimeout(() => {
      timer = null;
      void refresh().finally(() => {
        if (timer === null) schedule();
      });
    }, wait);
  }

  const onVisible = () => {
    if (!globalThis.document?.hidden) void refresh();
  };
  globalThis.document?.addEventListener?.('visibilitychange', onVisible);
  const offMove = findCamera(viewer)?.on('moveEnd', () => void refresh());
  const token = store?.connect?.({
    setWeatherLive(next) {
      if (Boolean(next) === live) return;
      if (next) {
        live = true;
        manualHaze = null;
      } else {
        takeShown();
      }
      save();
      apply();
      if (live) void refresh();
    },
    setWeatherValue(key, pct) {
      if (!MANUAL_KEYS.includes(key)) return;
      const value = Number(pct) / 100;
      if (!Number.isFinite(value)) return;
      // Moving a slider takes the weather off live, from what it shows.
      if (live) takeShown();
      manual[key] = Math.min(1, Math.max(0, value));
      if (key === 'fog') manualHaze = null;
      save();
      apply();
    },
  });

  apply();
  void refresh();
  schedule();

  return {
    refresh,
    destroy() {
      destroyed = true;
      pending?.abort.abort();
      pending = null;
      globalThis.document?.removeEventListener?.('visibilitychange', onVisible);
      if (timer !== null) clearTimeout(timer);
      timer = null;
      offMove?.();
      if (token) store?.detach?.(token);
      store?.publishWeather?.(null);
    },
  };
}
