/**
 * Sky view observer: who is looking up, and from where.
 *
 * Observer = { latDeg, lonDeg, groundHeightM, heightKnown, eyeHeightM, source,
 * accuracyM }. Pure parts (parsing, the geolocation state machine, observer
 * construction) are tested without a browser; the two async helpers take their
 * platform objects (navigator.geolocation, the Cesium module, the viewer) as
 * arguments so tests can drive them.
 */
import { EYE_HEIGHT_M } from './skyMath.js';

export const OBSERVER_SOURCES = Object.freeze(['map', 'gps', 'manual', 'url']);

/** Build a validated observer, or null when the coordinates are unusable. */
export function createObserver({
  latDeg,
  lonDeg,
  groundHeightM = 0,
  heightKnown = false,
  eyeHeightM = EYE_HEIGHT_M,
  source = 'map',
  accuracyM = null,
} = {}) {
  const lat = Number(latDeg);
  const lon = Number(lonDeg);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const ground = Number(groundHeightM);
  const known = Boolean(heightKnown) && Number.isFinite(ground);
  const eye = Number(eyeHeightM);
  return {
    latDeg: lat,
    lonDeg: lon,
    groundHeightM: known ? ground : 0,
    heightKnown: known,
    eyeHeightM:
      Number.isFinite(eye) && eye >= 0 && eye < 10_000 ? eye : EYE_HEIGHT_M,
    source: OBSERVER_SOURCES.includes(source) ? source : 'manual',
    accuracyM: Number.isFinite(accuracyM) && accuracyM >= 0 ? accuracyM : null,
  };
}

/** Height of the eye above the ellipsoid, metres. */
export const observerEyeHeight = (observer) =>
  observer.groundHeightM + observer.eyeHeightM;

const HEMI = { N: 1, S: -1, E: 1, W: -1 };

/**
 * Parse "29.7604, -95.3698", "29.7604 -95.3698" or "29.7604 N 95.3698 W"
 * (hemisphere letters before or after the number, any case). Returns
 * { latDeg, lonDeg } or null.
 */
export function parseLatLon(text) {
  const source = String(text ?? '')
    .trim()
    .toUpperCase()
    .replace(/°/g, ' ');
  if (!source) return null;
  const tokens = [
    ...source.matchAll(/([NSEW])?\s*([+-]?\d+(?:\.\d+)?)\s*([NSEW])?/g),
  ].filter((match) => match[2] !== undefined);
  if (tokens.length !== 2) return null;
  const values = tokens.map(([, before, number, after]) => {
    const hemi = before || after || null;
    let value = Number(number);
    if (hemi) {
      if (value < 0) return null;
      value *= HEMI[hemi];
    }
    return { value, hemi };
  });
  if (values.includes(null)) return null;
  let [a, b] = values;
  // "95.3698 W 29.7604 N": hemisphere letters say which one is the latitude.
  if ((a.hemi === 'E' || a.hemi === 'W') && (b.hemi === 'N' || b.hemi === 'S'))
    [a, b] = [b, a];
  if (a.hemi === 'E' || a.hemi === 'W' || b.hemi === 'N' || b.hemi === 'S')
    return null;
  if (Math.abs(a.value) > 90 || Math.abs(b.value) > 180) return null;
  return { latDeg: a.value, lonDeg: b.value };
}

/** Plain-language accuracy readout; null when unknown. */
export function accuracyText(accuracyM) {
  if (!Number.isFinite(accuracyM)) return null;
  const text =
    accuracyM >= 1000
      ? `+/- ${(accuracyM / 1000).toFixed(accuracyM >= 10_000 ? 0 : 1)} km`
      : `+/- ${Math.round(accuracyM)} m`;
  return accuracyM > 5000
    ? `${text}: the sky is still right to well under a degree, but the terrain horizon may not match`
    : text;
}

// ── geolocation state machine ──────────────────────────────────────────────

export const GEO_STATES = Object.freeze([
  'idle',
  'requesting',
  'ready',
  'denied',
  'unavailable',
  'insecure-context',
  'timeout',
]);

export const GEO_MESSAGES = Object.freeze({
  idle: '',
  requesting: 'Waiting for your browser to allow location',
  ready: 'Location found',
  denied:
    'Location blocked. Allow it in the browser address bar, or pick a point on the map',
  unavailable:
    'Location is not available on this device. Pick a point on the map or type lat, lon',
  'insecure-context': 'Location needs the https:// address',
  timeout: 'Location took too long. Press again, or pick a point on the map',
});

export const GEO_OPTIONS = Object.freeze({
  enableHighAccuracy: true,
  timeout: 20_000,
  maximumAge: 300_000,
});

/**
 * Pure reducer. Events: { type: 'request', secure, supported },
 * { type: 'success', coords }, { type: 'error', code } (GeolocationPositionError
 * codes: 1 denied, 2 unavailable, 3 timeout). A request while one is in
 * flight is ignored: one press = one browser request, never a retry loop.
 */
export function geoReduce(state, event) {
  const current = state ?? { status: 'idle', coords: null };
  switch (event?.type) {
    case 'request':
      if (current.status === 'requesting') return current;
      if (!event.secure) return { status: 'insecure-context', coords: null };
      if (!event.supported) return { status: 'unavailable', coords: null };
      return { status: 'requesting', coords: null };
    case 'success': {
      if (current.status !== 'requesting') return current;
      const c = event.coords;
      if (!Number.isFinite(c?.latitude) || !Number.isFinite(c?.longitude))
        return { status: 'unavailable', coords: null };
      return {
        status: 'ready',
        coords: {
          latDeg: c.latitude,
          lonDeg: c.longitude,
          accuracyM: Number.isFinite(c.accuracy) ? c.accuracy : null,
        },
      };
    }
    case 'error': {
      if (current.status !== 'requesting') return current;
      const status =
        event.code === 1
          ? 'denied'
          : event.code === 3
            ? 'timeout'
            : 'unavailable';
      return { status, coords: null };
    }
    default:
      return current;
  }
}

/**
 * Bind the reducer to a browser. `request()` makes at most ONE
 * getCurrentPosition call per press; the result arrives via onChange.
 */
export function createGeolocator({
  geolocation = globalThis.navigator?.geolocation,
  isSecureContext = globalThis.isSecureContext,
  onChange = () => {},
} = {}) {
  let state = { status: 'idle', coords: null };
  let calls = 0;
  const set = (next) => {
    if (next === state) return;
    state = next;
    onChange(state, GEO_MESSAGES[state.status]);
  };
  return {
    get state() {
      return state;
    },
    get calls() {
      return calls;
    },
    request() {
      const before = state;
      const next = geoReduce(state, {
        type: 'request',
        secure: isSecureContext !== false,
        supported: typeof geolocation?.getCurrentPosition === 'function',
      });
      set(next);
      if (next.status !== 'requesting' || before.status === 'requesting')
        return state;
      calls += 1;
      try {
        geolocation.getCurrentPosition(
          (position) =>
            set(
              geoReduce(state, { type: 'success', coords: position?.coords }),
            ),
          (error) =>
            set(geoReduce(state, { type: 'error', code: error?.code })),
          { ...GEO_OPTIONS },
        );
      } catch {
        set(geoReduce(state, { type: 'error', code: 2 }));
      }
      return state;
    },
    reset() {
      set({ status: 'idle', coords: null });
    },
  };
}

// ── ground height ──────────────────────────────────────────────────────────

const withTimeout = (promise, ms) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

/** True for a terrain provider that has real heights (not the bare ellipsoid). */
export function hasRealTerrain(Cesium, provider) {
  if (!provider) return false;
  if (
    Cesium?.EllipsoidTerrainProvider &&
    provider instanceof Cesium.EllipsoidTerrainProvider
  )
    return false;
  return typeof provider.requestTileGeometry === 'function';
}

/**
 * Ground height under a point: the globe's terrain provider first (the same
 * provider the map already uses), then a 3D-tiles height sample (Google 3D),
 * else 0 flagged unknown. Never throws.
 * @returns {Promise<{heightM:number, known:boolean, via:string}>}
 */
export async function sampleGroundHeight({
  Cesium,
  viewer,
  latDeg,
  lonDeg,
  timeoutMs = 8000,
}) {
  const unknown = { heightM: 0, known: false, via: 'none' };
  if (!Cesium || !viewer) return unknown;
  let carto;
  try {
    carto = Cesium.Cartographic.fromDegrees(lonDeg, latDeg);
  } catch {
    return unknown;
  }
  const provider =
    viewer.terrainProvider ?? viewer.scene?.globe?.terrainProvider;
  if (
    hasRealTerrain(Cesium, provider) &&
    typeof Cesium.sampleTerrainMostDetailed === 'function'
  ) {
    try {
      const [sample] = await withTimeout(
        Cesium.sampleTerrainMostDetailed(provider, [carto.clone()]),
        timeoutMs,
      );
      if (Number.isFinite(sample?.height))
        return { heightM: sample.height, known: true, via: 'terrain' };
    } catch {
      /* fall through */
    }
  }
  const scene = viewer.scene;
  if (typeof scene?.sampleHeightMostDetailed === 'function') {
    try {
      const [sample] = await withTimeout(
        scene.sampleHeightMostDetailed([carto.clone()]),
        timeoutMs,
      );
      if (Number.isFinite(sample?.height))
        return { heightM: sample.height, known: true, via: 'tiles' };
    } catch {
      /* fall through */
    }
  }
  return unknown;
}
