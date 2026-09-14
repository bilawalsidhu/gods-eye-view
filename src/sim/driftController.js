import * as Cesium from 'cesium';
import { governorRequestRender } from '../renderGovernor.js';
import { registerSpriteCollection, restoreSpriteOrder } from '../data/spriteOrder.js';
import { setOverlayEntries, clearOverlaySource } from '../overlays/worldOverlay.js';
import { metFromDirToUV, oceanToDirToUV } from './leeway.js';
import { createDriftPanel } from './driftPanel.js';
import { loadLandSeaMask } from '../data/landSeaMask.js';

/**
 * Drift-simulation controller: fetches the marine forcing grid, runs the
 * leeway Monte Carlo in a worker, and renders the ensemble as a scrubbable
 * PointPrimitiveCollection under the shared sprite order ('ocean-drift'
 * slot, below vessels and aircraft). One simulation at a time; a new start
 * disposes the previous one.
 *
 * Everything on screen is labeled `SIMULATED DRIFT ENSEMBLE` — this is a
 * probabilistic visualization of forecast-driven leeway drift, not a SAR
 * product (Open-Meteo currents are coarse model forecasts: no nearshore
 * eddies, no tidal currents, no Stokes drift term in this MVP).
 */

export const DRIFT_OVERLAY_SOURCE_ID = 'ocean-drift';
const GRID_URL = '/api/ocean/marine-grid';
const ETOPO_URL = '/api/ocean/etopo';

/**
 * Last-known-position uncertainty presets, metres (1-sigma).
 *
 * This is the standard deviation of the ensemble's INITIAL POSITION SCATTER —
 * how well the entry point is known — not a display parameter. It is exposed
 * because the honest value differs by more than an order of magnitude between a
 * witnessed man-overboard and a position reconstructed hours later, and because
 * the answer the panel reports is meaningless without it.
 *
 * The bands follow SAR practice for initial position error: a witnessed MOB
 * with a mark dropped immediately is O(100 m); a position estimated from a
 * track and a time is O(1 km); a last-known-position inferred from a missed
 * check-in or a partial report is several km. NOT sourced to a specific
 * publication — treat the boundaries as round numbers chosen to span the real
 * range, and set the value deliberately rather than accepting a default.
 * @const {ReadonlyArray<{id: string, label: string, posSigmaM: number}>}
 */
export const DRIFT_POSITION_UNCERTAINTY = Object.freeze([
  Object.freeze({ id: 'witnessed', label: 'witnessed · 300 m', posSigmaM: 300 }),
  Object.freeze({ id: 'estimated', label: 'estimated · 1 km', posSigmaM: 1000 }),
  Object.freeze({ id: 'uncertain', label: 'uncertain · 5 km', posSigmaM: 5000 }),
]);

/**
 * Ensemble defaults, sized by the frame-buffer formula
 * n · (60·horizonH/dtMin + 1) frames · 2 floats · 4 bytes:
 * 10⁴ · 145 · 8 B ≈ 11.6 MB — comfortably transferable and scrubbable.
 * (5×10⁴ particles would need the horizon halved to stay in budget.)
 */
export const DRIFT_DEFAULTS = Object.freeze({
  n: 10000,
  horizonH: 24,
  dtMin: 10,
  // Default: the middle band. A drift answer quoted from a 300 m assumption
  // when the position was actually estimated understates the search area.
  posSigmaM: 1000,
  sigmaTurbMs: 0.05,
});

/** Hard particle cap enforced by {@link resolveDriftParams}. */
const DRIFT_MAX_PARTICLES = 25000;
/** Frame-buffer ceiling: n · frames · 2 float32 (= 8 B) must stay below it. */
const DRIFT_FRAME_BUDGET_BYTES = 32 * 1024 * 1024;

/**
 * Validate/complete a user-facing drift parameter set into the full set the
 * model run needs. dtMin is DERIVED, never user-set: 10 min below 48 h and
 * 20 min at 48 h keeps the frame count at 60·horizonH/dtMin + 1 ≤ 145.
 * Budget arithmetic: each frame stores 2 float32 per particle (8 B), so the
 * transferable frame buffer is n · frames · 8 B; the worst offered combo
 * (n = 25000, horizonH = 48 → 145 frames) is 25000·145·8 = 29 MB, under the
 * 32 MB ceiling. n is clamped to 25000 and the ceiling is asserted so no
 * parameter drift can silently blow the budget.
 * @param {Object} [overrides]
 * @param {number} [overrides.horizonH] Simulation horizon, hours.
 * @param {number} [overrides.n] Ensemble size (clamped to [1, 25000]).
 * @param {number} [overrides.sigmaTurbMs] Turbulent-diffusion σ, m/s.
 * @param {number} [overrides.posSigmaM] Last-known-position uncertainty, metres
 *   (1-sigma initial scatter). Clamped to [0, 20000]: this is a physical
 *   uncertainty, and a scatter wider than the forcing grid would put particles
 *   where the sampler clamps and the answer stops meaning anything.
 * @param {boolean} [overrides.backward] Reverse (hindcast) drift.
 * @returns {{horizonH: number, dtMin: number, n: number, sigmaTurbMs: number,
 *   posSigmaM: number, backward: boolean}}
 */
export function resolveDriftParams({
  horizonH = DRIFT_DEFAULTS.horizonH,
  n = DRIFT_DEFAULTS.n,
  sigmaTurbMs = DRIFT_DEFAULTS.sigmaTurbMs,
  posSigmaM = DRIFT_DEFAULTS.posSigmaM,
  backward = false,
} = {}) {
  const clampedN = Math.min(DRIFT_MAX_PARTICLES, Math.max(1, Math.floor(n)));
  const dtMin = horizonH >= 48 ? 20 : 10;
  const frameCount = Math.round((60 * horizonH) / dtMin) + 1;
  const bytes = clampedN * frameCount * 8;
  if (bytes >= DRIFT_FRAME_BUDGET_BYTES) {
    throw new Error(`drift frame buffer ${bytes} B exceeds the ${DRIFT_FRAME_BUDGET_BYTES} B budget`);
  }
  // Clamped to the offered range: a negative sigma is meaningless and an
  // enormous one would scatter particles across the forcing grid's edge, where
  // the sampler clamps and the answer stops meaning anything.
  const clampedSigma = Math.min(20000, Math.max(0, Number(posSigmaM) || 0));
  return {
    horizonH, dtMin, n: clampedN, sigmaTurbMs, posSigmaM: clampedSigma, backward: Boolean(backward),
  };
}

const EARTH_RADIUS_KM = 6371;
const DEG = Math.PI / 180;

/**
 * Haversine great-circle distance plus initial bearing from (lat1, lon1)
 * to (lat2, lon2). Bearing is degrees clockwise from true north in [0, 360).
 * @returns {{km: number, bearingDeg: number}}
 */
function driftVector(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * DEG;
  const p2 = lat2 * DEG;
  const dp = (lat2 - lat1) * DEG;
  const dl = (lon2 - lon1) * DEG;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  const km = 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  const bearingDeg = ((Math.atan2(y, x) / DEG) + 360) % 360;
  return { km, bearingDeg };
}

/**
 * Panel diagnostics line for a run result, or null when the model did not
 * report mean-endpoint fields (stubs and older workers may omit them).
 * @param {number} seedLat @param {number} seedLon @param {Object} result
 * @returns {?string} e.g. `Δ 10.0 km @ 90° · ± 3.2 km spread`
 */
function summarizeResult(seedLat, seedLon, result) {
  if (!Number.isFinite(result?.meanEndLat) || !Number.isFinite(result?.meanEndLon)) return null;
  const { km, bearingDeg } = driftVector(seedLat, seedLon, result.meanEndLat, result.meanEndLon);
  let text = `Δ ${km.toFixed(1)} km @ ${Math.round(bearingDeg) % 360}°`;
  if (Number.isFinite(result.spreadKm)) text += ` · ± ${result.spreadKm.toFixed(1)} km spread`;
  return text;
}

const PARTICLE_COLOR = Cesium.Color.fromCssColorString('#ffb14d');
const BEACHED_COLOR = Cesium.Color.fromCssColorString('#9fb8c8');
// Precomputed per-frame point colors — setFrame assigns, never allocates.
const LIVE_POINT_COLOR = PARTICLE_COLOR.withAlpha(0.55);
const BEACHED_POINT_COLOR = BEACHED_COLOR.withAlpha(0.55);

/**
 * Normalize a `/api/ocean/marine-grid` payload into the leeway model's
 * forcing-grid contract (hour-major u/v component fields, m/s). Direction
 * conventions are resolved HERE, once: NDBC/Open-Meteo wind directions are
 * meteorological FROM, ocean current directions are oceanographic TO.
 * Missing samples become NaN — the model's sampler zero-fills them and
 * reports degradation; this function must never invent forcing.
 * @param {?Object} payload - Grid endpoint response body.
 * @returns {?Object} Normalized grid, or null when the payload is unusable.
 */
export function normalizeForcingGrid(payload) {
  const lats = payload?.grid?.lats;
  const lons = payload?.grid?.lons;
  const hoursMs = payload?.hoursMs;
  const nodes = payload?.nodes;
  if (!Array.isArray(lats) || !Array.isArray(lons) || !Array.isArray(hoursMs) || !Array.isArray(nodes)) return null;
  const nodeCount = lats.length * lons.length;
  if (!lats.length || !lons.length || !hoursMs.length || nodes.length !== nodeCount) return null;

  const size = hoursMs.length * nodeCount;
  const currentU = new Float32Array(size);
  const currentV = new Float32Array(size);
  const windU = new Float32Array(size);
  const windV = new Float32Array(size);

  for (let node = 0; node < nodeCount; node += 1) {
    const series = nodes[node] ?? {};
    for (let t = 0; t < hoursMs.length; t += 1) {
      const flat = t * nodeCount + node;
      const curKmh = series.currentKmh?.[t];
      const curDir = series.currentDirDeg?.[t];
      if (Number.isFinite(curKmh) && Number.isFinite(curDir)) {
        const { u, v } = oceanToDirToUV(curKmh / 3.6, curDir);
        currentU[flat] = u;
        currentV[flat] = v;
      } else {
        currentU[flat] = NaN;
        currentV[flat] = NaN;
      }
      const wind = series.windMs?.[t];
      const windDir = series.windDirDeg?.[t];
      if (Number.isFinite(wind) && Number.isFinite(windDir)) {
        const { u, v } = metFromDirToUV(wind, windDir);
        windU[flat] = u;
        windV[flat] = v;
      } else {
        windU[flat] = NaN;
        windV[flat] = NaN;
      }
    }
  }
  return { lats, lons, hoursMs, currentU, currentV, windU, windV };
}

/**
 * Nearest ensemble frame for a wall-clock time, clamped to the run's range.
 * @param {Float64Array|number[]} timesMs - Frame times.
 * @param {number} tMs - Query time.
 * @returns {number} Frame index, or -1 for an empty run.
 */
export function frameForTime(timesMs, tMs) {
  const length = timesMs?.length ?? 0;
  if (!length) return -1;
  if (tMs <= timesMs[0]) return 0;
  if (tMs >= timesMs[length - 1]) return length - 1;
  let best = 0;
  for (let i = 1; i < length; i += 1) {
    if (Math.abs(timesMs[i] - tMs) < Math.abs(timesMs[best] - tMs)) best = i;
  }
  return best;
}

/** Default worker-backed ensemble runner (kept injectable for tests). */
function runEnsembleInWorker(params) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./leeway.worker.mjs', import.meta.url), { type: 'module' });
    worker.onmessage = (event) => {
      const message = event.data ?? {};
      worker.terminate();
      if (message.type === 'result') resolve(message);
      else reject(new Error(message.message || 'drift worker failed'));
    };
    worker.onerror = (error) => {
      worker.terminate();
      reject(error instanceof Error ? error : new Error('drift worker error'));
    };
    worker.postMessage({ cmd: 'run', payload: params });
  });
}

/**
 * @param {Object} options
 * @param {Object} options.viewer Cesium viewer (scene.primitives is used).
 * @param {Object} [options.overlayHost] `{setEntries, clearSource}` (defaults to the world overlay).
 * @param {Function} [options.fetchImpl] Injectable fetch (tests).
 * @param {Function} [options.runEnsembleFn] Injectable ensemble runner (tests).
 * @param {Function} [options.collectionFactory] Injectable point-collection factory (tests).
 * @param {Function} [options.panelFactory] Injectable scrub-panel factory (tests).
 * @param {Function} [options.maskLoaderFn] Injectable bundled-bitmask loader (tests).
 * @returns {{start: Function, rerun: Function, setFrame: Function, play: Function, pause: Function, dispose: Function, isActive: Function}}
 */
export function createDriftController({
  viewer,
  overlayHost = { setEntries: setOverlayEntries, clearSource: clearOverlaySource },
  fetchImpl = (...args) => fetch(...args),
  runEnsembleFn = runEnsembleInWorker,
  collectionFactory = () => new Cesium.PointPrimitiveCollection({ blendOption: Cesium.BlendOption.TRANSLUCENT }),
  panelFactory = createDriftPanel,
  maskLoaderFn = loadLandSeaMask,
} = {}) {
  let _active = null; // {collection, points, timesMs, frames, beachedAtFrame, n, frameIndex, panel, playTimer}
  let _lastSeed = null; // {lat, lon, label} of the most recent start()
  let _lastParams = null; // {horizonH, n, sigmaTurbMs, backward} resolved for it
  // Monotonic token identifying the in-flight start(). start() awaits 0.9–3.9 s
  // of network and compute (measured: grid 195–812 ms, runEnsemble 1094 ms at
  // n = 10⁴, 2490 ms at 25 k) before it touches _active, and dispose() only
  // ever reaches the CURRENT _active. Two overlapping starts therefore used to
  // leak the first run's GPU collection and DOM panel permanently — and worse,
  // the orphaned panel's onScrub/onClose closed over this controller and drove
  // the surviving run. Every await below re-checks this token.
  let _runToken = 0;

  function dispose() {
    if (!_active) return;
    const { collection, panel, playTimer } = _active;
    // Null out FIRST so a teardown throw can never brick the next start().
    _active = null;
    if (playTimer) clearInterval(playTimer);
    panel?.destroy?.();
    overlayHost.clearSource(DRIFT_OVERLAY_SOURCE_ID);
    // PrimitiveCollection.remove DESTROYS the primitive (destroyPrimitives
    // defaults to true) — calling destroy() again after remove() throws and
    // was the "simulation only runs once" bug. Destroy ourselves only when
    // the scene never took ownership (no viewer) and it is still alive.
    viewer?.scene?.primitives?.remove?.(collection);
    if (collection && !collection.isDestroyed?.()) collection.destroy?.();
    governorRequestRender('drift-dispose');
  }

  function setFrame(index) {
    if (!_active) return;
    const clamped = Math.max(0, Math.min(_active.timesMs.length - 1, Math.floor(index)));
    _active.frameIndex = clamped;
    const { frames, n, points, beachedAtFrame } = _active;
    const offset = clamped * n * 2;
    let beachedCount = 0;
    for (let i = 0; i < n; i += 1) {
      points[i].position = Cesium.Cartesian3.fromDegrees(frames[offset + i * 2], frames[offset + i * 2 + 1]);
      // Frame-derived, so scrubbing back before the beach frame reverts it.
      const isBeached = beachedAtFrame != null
        && beachedAtFrame[i] !== -1 && beachedAtFrame[i] <= clamped;
      if (isBeached) beachedCount += 1;
      points[i].color = isBeached ? BEACHED_POINT_COLOR : LIVE_POINT_COLOR;
    }
    _active.panel?.setFrame?.(clamped, _active.timesMs[clamped] - _active.timesMs[0], beachedCount);
    governorRequestRender('drift-scrub');
  }

  function pause() {
    if (!_active?.playTimer) return;
    clearInterval(_active.playTimer);
    _active.playTimer = null;
    _active.panel?.setPlaying?.(false);
  }

  function play() {
    if (!_active || _active.playTimer) return;
    _active.panel?.setPlaying?.(true);
    _active.playTimer = setInterval(() => {
      if (!_active) return;
      if (_active.frameIndex >= _active.timesMs.length - 1) {
        pause();
        return;
      }
      setFrame(_active.frameIndex + 1);
    }, 200);
  }

  /**
   * Start a drift simulation at an ocean point. Returns `{ok, reason?}` —
   * the caller owns telling the user when forcing is unavailable.
   * Parameter overrides {horizonH, n, sigmaTurbMs, backward} are resolved
   * through {@link resolveDriftParams} (dtMin is derived from the horizon);
   * the seed and resolved params are remembered for {@link rerun}.
   */
  async function start({ lat, lon, label = '', horizonH, n, sigmaTurbMs, posSigmaM, backward } = {}) {
    const token = _runToken + 1;
    _runToken = token;
    dispose();
    const runParams = resolveDriftParams({ horizonH, n, sigmaTurbMs, posSigmaM, backward });
    _lastSeed = { lat, lon, label };
    _lastParams = {
      horizonH: runParams.horizonH,
      n: runParams.n,
      sigmaTurbMs: runParams.sigmaTurbMs,
      posSigmaM: runParams.posSigmaM,
      backward: runParams.backward,
    };
    const params = new URLSearchParams({ latitude: lat.toFixed(4), longitude: lon.toFixed(4) });
    // Grid is required; ETOPO bathymetry only upgrades beaching resolution.
    const [gridSettled, etopoSettled] = await Promise.allSettled([
      fetchImpl(`${GRID_URL}?${params}`).then((r) => (r.ok ? r.json() : null)),
      fetchImpl(`${ETOPO_URL}?${params}`).then((r) => (r.ok ? r.json() : null)),
    ]);
    if (token !== _runToken) return { ok: false, reason: 'superseded' };
    const gridPayload = gridSettled.status === 'fulfilled' ? gridSettled.value : null;
    const grid = gridPayload ? normalizeForcingGrid(gridPayload) : null;
    if (!grid) return { ok: false, reason: 'marine forcing grid unavailable' };

    // Beaching forcing: ETOPO bathymetry (~3.7 km) → bundled 1/8° bitmask →
    // null (drift still runs, particles just never beach).
    let landMask = null;
    const etopo = etopoSettled.status === 'fulfilled' ? etopoSettled.value : null;
    if (Array.isArray(etopo?.lats) && etopo.lats.length
      && Array.isArray(etopo.lons) && etopo.lons.length
      && Array.isArray(etopo.z) && etopo.z.length === etopo.lats.length * etopo.lons.length) {
      landMask = { type: 'bathy', lats: etopo.lats, lons: etopo.lons, z: Float32Array.from(etopo.z) };
    } else {
      try {
        const mask = await maskLoaderFn();
        if (token !== _runToken) return { ok: false, reason: 'superseded' };
        if (mask) landMask = { type: 'mask', width: mask.width, height: mask.height, data: mask.data };
      } catch {
        landMask = null;
      }
    }

    let result;
    try {
      result = await runEnsembleFn({
        n: runParams.n,
        seedLat: lat,
        seedLon: lon,
        startTimeMs: Date.now(),
        horizonH: runParams.horizonH,
        dtMin: runParams.dtMin,
        sigmaTurbMs: runParams.sigmaTurbMs,
        backward: runParams.backward,
        grid,
        landMask,
        rngSeed: Date.now() >>> 0,
        posSigmaM: runParams.posSigmaM,
      });
    } catch {
      return { ok: false, reason: 'drift ensemble failed' };
    }
    // Last gate before this run takes ownership of the scene and the DOM.
    if (token !== _runToken) return { ok: false, reason: 'superseded' };

    const collection = collectionFactory();
    const points = [];
    const startOffset = 0;
    for (let i = 0; i < result.n; i += 1) {
      points.push(collection.add({
        position: Cesium.Cartesian3.fromDegrees(
          result.frames[startOffset + i * 2],
          result.frames[startOffset + i * 2 + 1],
        ),
        pixelSize: 2.5,
        color: LIVE_POINT_COLOR,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      }));
    }
    viewer?.scene?.primitives?.add?.(collection);
    registerSpriteCollection('ocean-drift', collection);
    restoreSpriteOrder(viewer);

    const panel = panelFactory({
      particleCount: result.n,
      classLabel: 'PIW — person in water',
      frameCount: result.timesMs.length,
      horizonH: runParams.horizonH,
      degraded: Boolean(result.degraded),
      // The honest quality surface: node counts, how far upstream moved each
      // node from where it was asked for, and how many frames ran past the end
      // of the forecast. A latching boolean read `true` on every coastal run.
      forcing: {
        ...(gridPayload?.validation ?? {}),
        clampedFrames: result.clampedFrames ?? 0,
        frameCount: result.timesMs.length,
      },
      label,
      params: { ..._lastParams },
      onRerun: (overrides) => rerun(overrides),
      onScrub: (index) => { pause(); setFrame(index); },
      onPlayPause: () => (_active?.playTimer ? pause() : play()),
      onClose: () => dispose(),
    });
    panel?.setSummary?.(summarizeResult(lat, lon, result));

    _active = {
      collection,
      points,
      timesMs: result.timesMs,
      frames: result.frames,
      beachedAtFrame: result.beachedAtFrame ?? null,
      n: result.n,
      frameIndex: 0,
      panel,
      playTimer: null,
    };

    overlayHost.setEntries(DRIFT_OVERLAY_SOURCE_ID, [{
      id: 'ocean-drift-banner',
      position: Cesium.Cartesian3.fromDegrees(lon, lat),
      variant: 'selected',
      selected: true,
      protected: true,
      paintLane: 'selected',
      collisionGroup: 'ambient-card',
      priority: Number.MAX_SAFE_INTEGER,
      title: 'SIMULATED DRIFT ENSEMBLE',
      details: [`${result.n.toLocaleString()} particles · ${runParams.horizonH} h · PIW`,
        ...(runParams.backward ? ['REVERSE DRIFT — origin hypothesis'] : []),
        ...(result.degraded ? ['⚠ forcing gaps zero-filled'] : []),
        ...(result.clampedFrames > 0
          ? [`⚠ ${result.clampedFrames}/${result.timesMs.length} frames past forecast end`]
          : [])],
      accent: '#ffb14d',
      interactive: false,
      verticalOnly: true,
      placement: 'above',
      edgeFade: 'keyhole',
      horizonCull: true,
      terrainOcclusion: false,
    }], { cohortLimit: 1, collisionCapacity: 0, moving: false });

    setFrame(0);
    return { ok: true };
  }

  /**
   * Dispose the current run and start again at the REMEMBERED seed with the
   * remembered params merged under `paramOverrides` (start() itself disposes
   * first). Returns `{ok: false}` when nothing has been started yet.
   * @param {Object} [paramOverrides] Subset of {horizonH, n, sigmaTurbMs, backward}.
   */
  async function rerun(paramOverrides = {}) {
    if (!_lastSeed) return { ok: false, reason: 'no prior simulation to re-run' };
    return start({ ..._lastSeed, ..._lastParams, ...paramOverrides });
  }

  return {
    start,
    rerun,
    setFrame,
    play,
    pause,
    dispose,
    isActive: () => Boolean(_active),
    /** True while a start() is between its first await and taking ownership. */
    isBusy: () => _runToken > 0 && !_active,
  };
}
