/**
 * @file Animated ocean-current field layer — streaklines over the globe.
 *
 * Renders the `/api/ocean/field` payload as thousands of short particle trails
 * advected through the surface-current field, in the spirit of
 * earth.nullschool.net but draped over a 3D globe rather than a flat
 * projection. It exists because the drift ensemble had nothing to move
 * *against*: a point cloud translating over a blank ocean reads as static
 * whether or not it is moving, and the water itself was never drawn.
 *
 * ## Why a screen-space canvas
 *
 * Particles are advected in SCREEN space on a 2-D canvas layered over the
 * Cesium canvas, not as scene primitives. Trails need per-frame sub-pixel
 * accumulation and a fade, which a `PointPrimitiveCollection` cannot express,
 * and 4,000 primitives re-uploaded every frame would dominate the frame budget.
 *
 * ## The velocity raster
 *
 * Unprojecting every particle every frame is far too expensive (4,000
 * particles × 60 fps = 240 k ellipsoid picks per second). Instead the layer
 * rebuilds a coarse SCREEN-SPACE VELOCITY RASTER whenever the camera settles:
 * one node every {@link SCREEN_GRID_STEP_PX} pixels, each carrying the screen
 * displacement (px) that one second of the local current produces. Per node
 * that costs one `pickEllipsoid` plus one forward projection; particles then
 * bilinearly interpolate the raster, which is pure arithmetic.
 *
 * The raster is what makes the projection correct: it measures the screen
 * displacement of a real eastward/northward metre offset at that point, so
 * convergence of meridians, tilt, and perspective foreshortening are all
 * absorbed rather than approximated by a global scale factor.
 *
 * ## Honesty
 *
 * The legend renders straight from `payload.provenance`. A cell is drawn only
 * where the field has data — gaps stay empty rather than being filled with
 * slack water — and the tier, dataset, valid time, age, and (for HF radar) the
 * holdout RMSE are all on screen. A 3-day-old 28 km model field must never look
 * like a 1-hour-old 2 km observation.
 *
 * @module data/oceanField
 */

import * as Cesium from 'cesium';
import {
  createFieldSampler,
  createParticleSystem,
  speedColor,
  speedLegendStops,
  buildTrailAlpha,
  fieldStats,
  DEFAULT_SPEED_SCALE,
} from './oceanFieldMath.js';
import { loadLandSeaMask, maskStateAt, MASK_LAND } from './landSeaMask.js';

/** @const {string} Field endpoint. */
const FIELD_URL = '/api/ocean/field';

/** @const {number} Velocity-raster node spacing, screen pixels. */
export const SCREEN_GRID_STEP_PX = 16;

/**
 * @const {number} Particle count. 4,000 fills a 1600×900 viewport densely
 * enough to read as a flow without the trails merging into a wash; the per
 * frame cost is one raster lookup and one line segment each.
 */
export const PARTICLE_COUNT = 4000;

/**
 * @const {number} Target on-screen speed of a MEDIAN current, px per frame.
 *
 * The time compression cannot be a constant. Screen speed is physical speed
 * times the view's pixels-per-metre, which spans five orders of magnitude
 * between a global view and a bay: at 1600 px across, a 0.15 m/s current moves
 * 2.4e-3 px/s over a 100 km view but 6e-6 px/s over the whole Earth. A fixed
 * multiplier is therefore either a frozen field or an unreadable blur,
 * depending only on zoom. Instead the time compression is solved for on every
 * raster rebuild so the median current always moves at this rate — the
 * animation conveys direction and RELATIVE speed, which is what it is for, and
 * never claims to convey elapsed time.
 */
export const TARGET_PX_PER_FRAME = 1.1;

/** @const {number} Clamp on the solved time compression, seconds per frame. */
const MIN_SECONDS_PER_FRAME = 1;
const MAX_SECONDS_PER_FRAME = 4e6;

/** @const {number} Trail fade per frame — lower leaves longer streaks. */
const TRAIL_FADE_ALPHA = 0.955;

/**
 * @const {number} Minimum cosine between the surface normal and the direction
 * to the camera for a raster node to be usable.
 *
 * The screen projection's Jacobian diverges at the limb: as the surface turns
 * edge-on, a one-metre offset on the ground projects to an unbounded screen
 * displacement, so raster nodes near the limb carry enormous velocities and
 * fling particles radially off the globe. 0.15 rejects the outer ~81.4° of the
 * visible hemisphere's grazing band, where the horizontal scale is stretched
 * more than ~6.7x and the field could not be read anyway.
 */
const MIN_LIMB_COSINE = 0.15;

/** @const {number} Camera-settle debounce before refetching, ms. */
const REFETCH_DEBOUNCE_MS = 450;

/**
 * @const {number} Minimum fractional view-box change that justifies a refetch.
 * Small pans reuse the payload; the server also caches on a 0.5° box key, so a
 * refetch below this threshold would usually return the identical field.
 */
const REFETCH_MIN_DELTA = 0.25;

/**
 * Solve the time compression that puts a median current at
 * {@link TARGET_PX_PER_FRAME}.
 *
 * The median (not the mean) so a handful of fast cells — a western boundary
 * current crossing the view — cannot wash out everything slower, and the
 * median over FINITE nodes only so empty ocean does not drag it to zero.
 *
 * @param {{vx: Float32Array, vy: Float32Array, ok: Uint8Array}} raster - Node
 *   velocities in screen px per second of ocean time.
 * @returns {number} Seconds of ocean time per animation frame, clamped.
 */
export function solveSecondsPerFrame(raster) {
  const speeds = [];
  for (let k = 0; k < raster.ok.length; k += 1) {
    if (raster.ok[k] !== 1) continue;
    const speed = Math.hypot(raster.vx[k], raster.vy[k]);
    if (speed > 0) speeds.push(speed);
  }
  if (!speeds.length) return MIN_SECONDS_PER_FRAME;
  speeds.sort((a, b) => a - b);
  const median = speeds[speeds.length >> 1];
  if (!(median > 0)) return MIN_SECONDS_PER_FRAME;
  return Math.min(MAX_SECONDS_PER_FRAME,
    Math.max(MIN_SECONDS_PER_FRAME, TARGET_PX_PER_FRAME / median));
}

/**
 * Bilinear lookup into a screen-space velocity raster.
 *
 * Returns `ok:false` when any of the four surrounding nodes has no data, so a
 * particle straddling the edge of coverage is retired rather than advected on a
 * half-invented velocity. Allocation-free: the same result object is returned
 * every call and the caller must copy what it keeps.
 *
 * @param {{cols: number, rows: number, step: number, vx: Float32Array,
 *   vy: Float32Array, speed: Float32Array, ok: Uint8Array}} raster
 * @returns {(x: number, y: number) => {vx: number, vy: number, speedMs: number, ok: boolean}}
 */
export function createRasterSampler(raster) {
  const { cols, rows, step, vx, vy, speed, ok } = raster;
  const out = { vx: 0, vy: 0, speedMs: Number.NaN, ok: false };
  return (x, y) => {
    const gx = x / step;
    const gy = y / step;
    const i = Math.floor(gx);
    const j = Math.floor(gy);
    if (!(i >= 0 && j >= 0 && i < cols - 1 && j < rows - 1)) {
      out.ok = false;
      return out;
    }
    const fx = gx - i;
    const fy = gy - j;
    const k00 = j * cols + i;
    const k10 = k00 + 1;
    const k01 = k00 + cols;
    const k11 = k01 + 1;
    if (ok[k00] !== 1 || ok[k10] !== 1 || ok[k01] !== 1 || ok[k11] !== 1) {
      out.ok = false;
      return out;
    }
    const w00 = (1 - fx) * (1 - fy);
    const w10 = fx * (1 - fy);
    const w01 = (1 - fx) * fy;
    const w11 = fx * fy;
    out.vx = vx[k00] * w00 + vx[k10] * w10 + vx[k01] * w01 + vx[k11] * w11;
    out.vy = vy[k00] * w00 + vy[k10] * w10 + vy[k01] * w01 + vy[k11] * w11;
    out.speedMs = speed[k00] * w00 + speed[k10] * w10 + speed[k01] * w01 + speed[k11] * w11;
    out.ok = true;
    return out;
  };
}

/**
 * The camera's current view rectangle as a plain lat/lon box, or null when the
 * camera looks past the limb (a fully off-globe view has no rectangle).
 *
 * @param {Object} viewer - Cesium viewer.
 * @returns {?{latMin: number, lonMin: number, latMax: number, lonMax: number}}
 *   Degrees. A rectangle spanning the antimeridian is returned with
 *   `lonMax < lonMin`; callers must handle or reject that themselves.
 */
export function cameraViewBox(viewer) {
  const rect = viewer?.camera?.computeViewRectangle?.(viewer.scene?.globe?.ellipsoid);
  if (!rect) return null;
  const deg = Cesium.Math.toDegrees;
  const box = {
    latMin: deg(rect.south),
    latMax: deg(rect.north),
    lonMin: deg(rect.west),
    lonMax: deg(rect.east),
  };
  return Object.values(box).every(Number.isFinite) ? box : null;
}

/**
 * Fractional change between two view boxes, as the larger of the centre shift
 * and the span change relative to the previous span. Used to decide whether a
 * camera move is worth a refetch.
 *
 * @param {?Object} previous @param {?Object} next
 * @returns {number} 0 when identical, Infinity when there is nothing to compare.
 */
export function viewBoxDelta(previous, next) {
  if (!previous || !next) return Number.POSITIVE_INFINITY;
  const prevLat = previous.latMax - previous.latMin;
  const prevLon = previous.lonMax - previous.lonMin;
  if (!(prevLat > 0) || !(prevLon > 0)) return Number.POSITIVE_INFINITY;
  const centreShift = Math.max(
    Math.abs((next.latMin + next.latMax) / 2 - (previous.latMin + previous.latMax) / 2) / prevLat,
    Math.abs((next.lonMin + next.lonMax) / 2 - (previous.lonMin + previous.lonMax) / 2) / prevLon,
  );
  const spanChange = Math.max(
    Math.abs((next.latMax - next.latMin) - prevLat) / prevLat,
    Math.abs((next.lonMax - next.lonMin) - prevLon) / prevLon,
  );
  return Math.max(centreShift, spanChange);
}

/**
 * Legend lines for a field payload's provenance block.
 *
 * Pure and exported so the wording is testable without a DOM: this is the text
 * that keeps a derived 3-day-old model field from reading as a live
 * observation, and it should fail a test if it ever stops saying so.
 *
 * @param {?Object} payload - Field payload, or null.
 * @returns {{title: string, lines: string[], caveats: string[]}}
 */
/**
 * A compact name for the rung that actually served, for the DATA panel row.
 *
 * The layer's static `source` names the whole ladder because any rung of it can
 * be what a view shows; this narrows it to the one in front of the user. A
 * composite names both, in cell-share order, because "IOOS HF radar" over a
 * view that is 89% model fill would be the same over-claim the legend exists to
 * prevent.
 *
 * @param {?Object} provenance - `payload.provenance`.
 * @returns {?string} e.g. `'IOOS HF radar'`, `'HYCOM'`, `'IOOS HF radar + HYCOM'`.
 */
function sourceLabel(provenance) {
  if (!provenance) return null;
  const name = (entry) => {
    if (entry?.tier === 'hfr') return 'IOOS HF radar';
    if (entry?.kind === 'modeled') return 'HYCOM';
    return 'CoastWatch altimetry';
  };
  const sources = Array.isArray(provenance.sources) && provenance.sources.length
    ? provenance.sources
    : [provenance];
  const names = [...new Set(sources.map(name))];
  return names.join(' + ');
}

export function fieldLegendText(payload) {
  if (!payload || payload.status !== 'ok' || !payload.provenance) {
    return {
      title: 'OCEAN CURRENTS',
      lines: [payload?.reason ? `Unavailable — ${payload.reason}` : 'No current field for this view'],
      caveats: [],
    };
  }
  const p = payload.provenance;
  const lines = [];
  const sources = Array.isArray(p.sources) && p.sources.length ? p.sources : [{
    tier: p.tier,
    kind: p.kind,
    label: p.tierLabel ?? p.label,
    ageLabel: p.ageLabel,
    resolutionKm: p.resolutionKm,
    cellShare: 1,
  }];
  for (const source of sources) {
    const share = sources.length > 1 && Number.isFinite(source.cellShare)
      ? `${Math.round(source.cellShare * 100)}% · `
      : '';
    const res = Number.isFinite(source.resolutionKm) ? `${source.resolutionKm} km · ` : '';
    const kind = source.kind === 'observed' ? 'OBSERVED' : 'MODELED';
    const forecast = source.isForecast ? ' · FORECAST' : '';
    lines.push(`${share}${res}${kind}${forecast} · ${source.ageLabel ?? 'age unknown'}`);
    if (source.label) lines.push(`  ${source.label}`);
    // The physics the source actually carries. `globalTier.GLOBAL_TIER_PHYSICS`
    // documents these strings as user-facing text and is deliberately explicit
    // about what is ABSENT — "NO Ekman ... and NO tides" — but nothing rendered
    // them, so the one sentence telling a viewer whether the field in front of
    // them contains tides travelled the whole way over the wire and stopped
    // here. Per-source first, so a composite names each rung's physics.
    const method = source.method ?? (sources.length === 1 ? p.method : null);
    if (method) lines.push(`  ${method}`);
    if (source.preferredSourceUnavailable) {
      lines.push(`  ${source.preferredSourceUnavailable}`);
    }
  }
  if (Number.isFinite(p.rmseMs)) {
    lines.push(`Holdout RMSE ${p.rmseMs.toFixed(3)} m/s over ${p.holdoutCount} withheld vectors`);
  }
  if (Number.isFinite(p.coverage)) {
    lines.push(`${Math.round(p.coverage * 100)}% of the water in view has a vector`);
  }
  return { title: 'OCEAN CURRENTS', lines, caveats: Array.isArray(p.caveats) ? p.caveats : [] };
}

/**
 * Colour-ramp upper bound for a field, from its own speed distribution.
 *
 * p95 rather than the max so one fast jet cannot flatten everything else to the
 * bottom of the ramp, x1.25 so the p95 itself is not already saturated, and a
 * 0.2 m/s floor so a nearly slack field does not amplify noise into full scale.
 *
 * @param {?{p95Ms: ?number}} stats - {@link fieldStats} output, or null.
 * @returns {number} Scale in m/s.
 */
export function speedScaleFor(stats) {
  return Number.isFinite(stats?.p95Ms) && stats.p95Ms > 0
    ? Math.max(0.2, stats.p95Ms * 1.25)
    : DEFAULT_SPEED_SCALE;
}

/** HTML-escape server-authored text. An upstream dataset title is not ours to trust. */
function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * The legend's full inner HTML.
 *
 * Pure and exported so the markup is testable: this used to be built inline
 * inside `renderLegend()`, where nothing in the suite could reach it (the
 * headless harness has no `document`, so the legend element is never created),
 * and it shipped every swatch as `background:undefined` — `speedLegendStops`
 * returns `{t, speedMs, r, g, b}` and the code read a `css` property that has
 * never existed. The colour key for the whole layer rendered blank.
 *
 * @param {?Object} payload - Field payload.
 * @param {number} scale - Ramp upper bound, m/s; see {@link speedScaleFor}.
 * @returns {string} Inner HTML for the legend container.
 */
export function buildLegendHtml(payload, scale = DEFAULT_SPEED_SCALE) {
  const { title, lines, caveats } = fieldLegendText(payload);
  const stops = payload?.status === 'ok' ? speedLegendStops(5, scale) : [];
  const swatchStyle = 'display:inline-block;width:22px;height:8px;vertical-align:middle';
  const swatches = stops.map((stop) => (
    `<span style="${swatchStyle};background:rgb(${stop.r}, ${stop.g}, ${stop.b})"`
    + ` title="${stop.speedMs.toFixed(2)} m/s"></span>`
  )).join('');
  const scaleLabel = stops.length
    ? `<div style="margin:4px 0 5px">${swatches}<span style="margin-left:6px;color:#8fa8b6">`
      + `0–${stops[stops.length - 1].speedMs.toFixed(2)} m/s</span></div>`
    : '';
  return [
    `<div style="color:#4dd2ff;font-weight:700;letter-spacing:0.08em">${escapeHtml(title)}</div>`,
    scaleLabel,
    ...lines.map((line) => `<div>${escapeHtml(line)}</div>`),
    ...caveats.map((line) => `<div style="color:#ffb14d;margin-top:3px">⚠ ${escapeHtml(line)}</div>`),
  ].join('');
}

/**
 * Build the animated current-field layer.
 *
 * @param {Object} [options]
 * @param {Function} [options.fetchImpl] - Injectable fetch (tests).
 * @param {number} [options.particleCount] - Override the particle count.
 * @returns {Object} A DataLayerManager-compatible layer.
 */
export function createOceanFieldLayer({
  fetchImpl = (...args) => fetch(...args),
  particleCount = PARTICLE_COUNT,
} = {}) {
  let _viewer = null;
  let _enabled = false;
  let _canvas = null;
  let _ctx = null;
  let _legend = null;
  let _raf = 0;
  let _payload = null;
  let _sampler = null;
  let _stats = null;
  let _raster = null;
  let _rasterSampler = null;
  let _particles = null;
  let _fetchedBox = null;
  let _rasterDirty = true;
  let _refetchTimer = 0;
  let _cameraListener = null;
  let _lastError = null;
  let _inFlight = 0;
  let _secondsPerFrame = MIN_SECONDS_PER_FRAME;
  let _frameWidth = 0;
  let _frameHeight = 0;
  let _mask = null;
  let _rasterGating = null;
  // Reused per particle per frame; step() copies what it needs before the next call.
  const _velocityScratch = { vx: 0, vy: 0, speedMs: Number.NaN, ok: true };

  function canvasSize() {
    const scene = _viewer?.scene;
    return {
      width: scene?.canvas?.clientWidth || 0,
      height: scene?.canvas?.clientHeight || 0,
    };
  }

  function ensureCanvas() {
    if (_canvas || typeof document === 'undefined') return;
    _canvas = document.createElement('canvas');
    _canvas.id = 'ocean-field-canvas';
    // Sits above the globe but below #world-overlay-root, so overlay labels and
    // cards stay legible over the field.
    Object.assign(_canvas.style, {
      position: 'absolute',
      inset: '0',
      pointerEvents: 'none',
      zIndex: '2',
    });
    const container = document.getElementById('cesiumContainer');
    container?.appendChild(_canvas);
    _ctx = _canvas.getContext('2d', { alpha: true });

    _legend = document.createElement('div');
    _legend.id = 'ocean-field-legend';
    _legend.setAttribute('aria-live', 'polite');
    // Inline styles follow the drift panel's precedent (src/sim/driftPanel.js)
    // rather than style.css, so the layer carries its own presentation. Bottom
    // LEFT is the free corner: bottom-centre is #command-dock, bottom-right is
    // #gev-voice-control + #view-switcher, top-right is the style/orbit
    // indicators. The 88px inset clears the Cesium ion credit line.
    _legend.style.cssText = [
      'position:absolute', 'left:20px', 'bottom:88px', 'z-index:3',
      'max-width:340px', 'pointer-events:none',
      'background:rgba(8,14,18,0.86)', 'border:1px solid rgba(77,210,255,0.45)',
      'border-radius:6px', 'padding:8px 10px',
      'font:11px/1.55 "SF Mono", ui-monospace, monospace', 'color:#cfe6f2',
      'backdrop-filter:blur(6px)',
    ].join(';');
    container?.appendChild(_legend);
  }

  function destroyCanvas() {
    _canvas?.remove();
    _legend?.remove();
    _canvas = null;
    _ctx = null;
    _legend = null;
  }

  function resizeCanvas() {
    if (!_canvas) return false;
    const { width, height } = canvasSize();
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const w = Math.round(width * dpr);
    const h = Math.round(height * dpr);
    if (_canvas.width === w && _canvas.height === h) return false;
    _canvas.width = w;
    _canvas.height = h;
    _canvas.style.width = `${width}px`;
    _canvas.style.height = `${height}px`;
    _ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    return true;
  }

  /**
   * Rebuild the screen-space velocity raster for the current camera.
   *
   * Each node: pick the ellipsoid under that pixel, sample the field there,
   * then measure where one second of that current lands on screen. Nodes off
   * the globe, behind the limb, or over a field gap are marked no-data, and the
   * bilinear sampler refuses any cell touching one.
   */
  function rebuildRaster() {
    _raster = null;
    _rasterSampler = null;
    _rasterDirty = false;
    if (!_sampler || !_viewer?.scene) return;
    const scene = _viewer.scene;
    const { width, height } = canvasSize();
    if (!(width > 0 && height > 0)) return;
    const ellipsoid = scene.globe.ellipsoid;
    const step = SCREEN_GRID_STEP_PX;
    const cols = Math.floor(width / step) + 2;
    const rows = Math.floor(height / step) + 2;
    const n = cols * rows;
    const vx = new Float32Array(n);
    const vy = new Float32Array(n);
    const speed = new Float32Array(n);
    const ok = new Uint8Array(n);
    // Why each node was rejected. Without this, "the field is drawing where it
    // shouldn't" is guesswork against a screenshot.
    const gated = { offGlobe: 0, land: 0, noData: 0, limb: 0, pole: 0, unprojectable: 0, ok: 0 };

    const pixel = new Cesium.Cartesian2();
    const carto = new Cesium.Cartographic();
    const offsetWorld = new Cesium.Cartesian3();
    const up = new Cesium.Cartesian3();
    const east = new Cesium.Cartesian3();
    const north = new Cesium.Cartesian3();
    const toCamera = new Cesium.Cartesian3();
    const cameraPosition = _viewer.camera.positionWC;
    const project = Cesium.SceneTransforms.worldToWindowCoordinates;
    if (typeof project !== 'function') return;

    for (let j = 0; j < rows; j += 1) {
      for (let i = 0; i < cols; i += 1) {
        const px = i * step;
        const py = j * step;
        pixel.x = px;
        pixel.y = py;
        const world = _viewer.camera.pickEllipsoid(pixel, ellipsoid);
        if (!world) { gated.offGlobe += 1; continue; }
        Cesium.Cartographic.fromCartesian(world, ellipsoid, carto);
        const lat = Cesium.Math.toDegrees(carto.latitude);
        const lon = Cesium.Math.toDegrees(carto.longitude);
        // Land gate at SCREEN resolution. The server already blanks land, but
        // only at the field's own resolution — a 0.25° global cell is ~28 km
        // and is classified by a single lookup at its centre, so bilinear
        // interpolation carries a coastal cell's current well inland. The
        // bundled 1/8° mask is ~14x finer than that cell and is already loaded
        // for click gating, so testing every 16 px node here costs nothing and
        // stops the field being drawn over dry land.
        if (_mask && maskStateAt(_mask, lat, lon) === MASK_LAND) { gated.land += 1; continue; }

        const sample = _sampler(lat, lon);
        if (!sample.ok) { gated.noData += 1; continue; }

        // East/north unit vectors at this point, from the geodetic surface
        // normal: east = ẑ × up (normalized), north = up × east. Degenerate
        // within a hair of the poles, where ẑ × up vanishes — those nodes are
        // skipped rather than given an arbitrary basis.
        ellipsoid.geodeticSurfaceNormal(world, up);

        // Limb gate: the projection stretches without bound as the surface
        // turns edge-on, which was flinging particles radially off the globe.
        Cesium.Cartesian3.subtract(cameraPosition, world, toCamera);
        Cesium.Cartesian3.normalize(toCamera, toCamera);
        if (Cesium.Cartesian3.dot(up, toCamera) < MIN_LIMB_COSINE) { gated.limb += 1; continue; }

        Cesium.Cartesian3.cross(Cesium.Cartesian3.UNIT_Z, up, east);
        if (Cesium.Cartesian3.magnitudeSquared(east) < 1e-12) { gated.pole += 1; continue; }
        Cesium.Cartesian3.normalize(east, east);
        Cesium.Cartesian3.cross(up, east, north);

        // One second of current, in metres, as a world offset.
        Cesium.Cartesian3.multiplyByScalar(east, sample.u, east);
        Cesium.Cartesian3.multiplyByScalar(north, sample.v, north);
        Cesium.Cartesian3.add(world, east, offsetWorld);
        Cesium.Cartesian3.add(offsetWorld, north, offsetWorld);
        const screen = project(scene, offsetWorld);
        if (!screen) { gated.unprojectable += 1; continue; }

        const k = j * cols + i;
        // Screen displacement per second of ocean time.
        vx[k] = screen.x - px;
        vy[k] = screen.y - py;
        speed[k] = Math.hypot(sample.u, sample.v);
        ok[k] = 1;
        gated.ok += 1;
      }
    }
    _raster = { cols, rows, step, vx, vy, speed, ok };
    _rasterGating = { ...gated, nodes: n };
    _rasterSampler = createRasterSampler(_raster);
    _secondsPerFrame = solveSecondsPerFrame(_raster);
  }

  /**
   * Place a particle at a random point that has data, or leave it dead.
   *
   * Uses the frame's cached viewport size rather than reading `clientWidth`:
   * this runs once per dead particle per frame, and a layout read in that loop
   * is a synchronous reflow the animation cannot afford. Eight attempts, then
   * give up until the next frame — over a sparsely covered view, insisting on
   * a hit would spin.
   */
  function spawnParticle(index, system) {
    if (!_rasterSampler) return;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const x = system.random() * _frameWidth;
      const y = system.random() * _frameHeight;
      if (_rasterSampler(x, y).ok) {
        system.respawn(index, x, y);
        return;
      }
    }
  }

  function drawFrame() {
    if (!_ctx || !_canvas) return;
    const { width, height } = canvasSize();
    if (!(width > 0 && height > 0)) return;
    // One layout read per frame, cached for spawnParticle's inner loop.
    _frameWidth = width;
    _frameHeight = height;
    if (_rasterDirty) rebuildRaster();

    // Fade the previous frame rather than clearing it: the residue IS the trail.
    _ctx.globalCompositeOperation = 'destination-in';
    _ctx.fillStyle = `rgba(0, 0, 0, ${TRAIL_FADE_ALPHA})`;
    _ctx.fillRect(0, 0, width, height);
    _ctx.globalCompositeOperation = 'source-over';

    if (!_rasterSampler || !_particles) return;
    const bounds = { minX: 0, minY: 0, maxX: width, maxY: height };
    const scale = speedScaleFor(_stats);

    _particles.step({
      dt: 1,
      bounds,
      spawn: spawnParticle,
      velocityAt: (x, y) => {
        const v = _rasterSampler(x, y);
        if (!v.ok) return v;
        // The raster is px per second of ocean time; one frame advances
        // _secondsPerFrame of it, solved per rebuild so the median current
        // reads at the same on-screen rate at every zoom. Reuses one scratch
        // object — this runs once per particle per frame.
        _velocityScratch.vx = v.vx * _secondsPerFrame;
        _velocityScratch.vy = v.vy * _secondsPerFrame;
        _velocityScratch.speedMs = v.speedMs;
        return _velocityScratch;
      },
    });

    const { x, y, prevX, prevY, age, maxAge, speedMs, alive, count } = _particles;
    _ctx.lineWidth = 1.35;
    _ctx.lineCap = 'round';
    const rgb = { r: 0, g: 0, b: 0 };
    for (let i = 0; i < count; i += 1) {
      if (alive[i] !== 1) continue;
      const px = prevX[i];
      const py = prevY[i];
      const nx = x[i];
      const ny = y[i];
      if (!Number.isFinite(px) || !Number.isFinite(nx)) continue;
      const alpha = buildTrailAlpha(age[i], maxAge[i]);
      if (!(alpha > 0)) continue;
      speedColor(speedMs[i], scale, rgb);
      _ctx.strokeStyle = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha.toFixed(3)})`;
      _ctx.beginPath();
      _ctx.moveTo(px, py);
      _ctx.lineTo(nx, ny);
      _ctx.stroke();
    }
  }

  /**
   * True when this runtime can actually animate. Headless runs (unit tests,
   * track regression) have no rAF and no document; the layer must still fetch,
   * report status and tear down cleanly there rather than throwing on enable.
   */
  function canAnimate() {
    return typeof globalThis.requestAnimationFrame === 'function'
      && typeof document !== 'undefined';
  }

  function tick() {
    if (!_enabled) return;
    try {
      if (resizeCanvas()) _rasterDirty = true;
      drawFrame();
    } catch (error) {
      // A render fault must not wedge the animation loop or the app.
      _lastError = String(error?.message ?? error);
    }
    _raf = globalThis.requestAnimationFrame(tick);
  }

  function renderLegend() {
    if (!_legend) return;
    _legend.innerHTML = buildLegendHtml(_payload, speedScaleFor(_stats));
  }

  /** Fetch the field for the current camera view and rebuild derived state. */
  async function refresh() {
    const box = cameraViewBox(_viewer);
    if (!box) return false;
    // The endpoint takes a west→east box; a view spanning the antimeridian
    // would need two requests, which the global tier does not yet stitch.
    if (box.lonMax <= box.lonMin) {
      _lastError = 'view crosses the antimeridian';
      return false;
    }
    const params = new URLSearchParams({
      latMin: box.latMin.toFixed(4),
      latMax: box.latMax.toFixed(4),
      lonMin: box.lonMin.toFixed(4),
      lonMax: box.lonMax.toFixed(4),
      // `cells` is deliberately omitted so the server's DEFAULT_TARGET_CELLS is
      // the single definition of the lattice budget; sending it from here too
      // meant two copies of 4096 that could drift apart.
    });
    const token = _inFlight + 1;
    _inFlight = token;
    // A superseded request must not report ANYTHING — not its payload and not
    // its failure. Writing `_lastError` from a stale request is the same class
    // of bug the run token fixes in driftController: a slow first request
    // failing after a fast second one succeeded would leave the layer reporting
    // an error it had already recovered from.
    const stale = () => token !== _inFlight || !_enabled;
    let payload = null;
    try {
      const response = await fetchImpl(`${FIELD_URL}?${params}`);
      if (!response.ok) {
        if (!stale()) _lastError = `Ocean field HTTP ${response.status}`;
        return false;
      }
      payload = await response.json();
    } catch (error) {
      if (!stale()) _lastError = String(error?.message ?? error);
      return false;
    }
    if (stale()) return false;

    // createFieldSampler/fieldStats throw on a malformed grid, and
    // createParticleSystem on a bad count. Outside a try, that rejected the
    // promise unhandled AND left `_payload` assigned — the layer reporting a
    // field it had failed to derive anything from.
    try {
      const nextSampler = payload?.status === 'ok' ? createFieldSampler(payload) : null;
      const nextStats = payload?.status === 'ok' ? fieldStats(payload) : null;
      if (payload?.status === 'ok') {
        _particles = _particles ?? createParticleSystem({ count: particleCount, seed: 20260901 });
      }
      _sampler = nextSampler;
      _stats = nextStats;
      _particles?.killAll();
    } catch (error) {
      _lastError = `Ocean field payload unusable: ${String(error?.message ?? error)}`;
      _sampler = null;
      _stats = null;
      _particles?.killAll();
      _rasterDirty = true;
      renderLegend();
      return false;
    }

    _payload = payload;
    _fetchedBox = box;
    _lastError = payload?.status === 'ok' ? null : (payload?.reason ?? 'field unavailable');
    _rasterDirty = true;
    renderLegend();
    return payload?.status === 'ok';
  }

  function onCameraChanged() {
    _rasterDirty = true;
    if (_refetchTimer) globalThis.clearTimeout(_refetchTimer);
    _refetchTimer = globalThis.setTimeout(() => {
      _refetchTimer = 0;
      if (!_enabled) return;
      const box = cameraViewBox(_viewer);
      if (!box) return;
      if (viewBoxDelta(_fetchedBox, box) < REFETCH_MIN_DELTA) return;
      refresh();
    }, REFETCH_DEBOUNCE_MS);
  }

  const layer = {
    id: 'ocean-field',
    name: 'Ocean Currents',
    icon: '🌀',
    // The whole ladder, because any rung of it can be what a given view is
    // actually showing. `getStats().source` narrows this to the one that served
    // once a payload has come back.
    source: 'IOOS HF radar · HYCOM · NOAA CoastWatch',
    updateInterval: 900000,

    init(viewer) {
      _viewer = viewer;
      _enabled = false;
      console.log('[Data:OceanField] Initialized');
    },

    enable(viewer) {
      _viewer = viewer ?? _viewer;
      const wasEnabled = _enabled;
      _enabled = true;
      ensureCanvas();
      resizeCanvas();
      renderLegend();
      // Idempotent: a second enable() without an intervening disable() must not
      // add a second pair of camera listeners. Cesium's Event holds duplicates,
      // so each extra enable() would leak one listener per event for the
      // session and multiply the refetch debounce work per camera move.
      if (wasEnabled && _cameraListener) {
        refresh();
        if (canAnimate() && !_raf) _raf = globalThis.requestAnimationFrame(tick);
        return;
      }
      _cameraListener = () => onCameraChanged();
      _viewer?.camera?.changed?.addEventListener(_cameraListener);
      // Cesium only raises `changed` past a percentage threshold; moveEnd
      // catches the settle after a flyTo or a small drag.
      _viewer?.camera?.moveEnd?.addEventListener(_cameraListener);
      // The mask is memoized and shared with ocean click gating and drift
      // beaching, so this is at worst one 1 MB fetch per session. A failure is
      // non-fatal: the field still renders, just without the fine land gate.
      loadLandSeaMask().then((mask) => {
        _mask = mask;
        _rasterDirty = true;
      }).catch(() => {});
      refresh();
      if (canAnimate() && !_raf) _raf = globalThis.requestAnimationFrame(tick);
    },

    disable() {
      _enabled = false;
      if (_raf && typeof globalThis.cancelAnimationFrame === 'function') {
        globalThis.cancelAnimationFrame(_raf);
      }
      _raf = 0;
      if (_refetchTimer) globalThis.clearTimeout(_refetchTimer);
      _refetchTimer = 0;
      if (_cameraListener) {
        _viewer?.camera?.changed?.removeEventListener(_cameraListener);
        _viewer?.camera?.moveEnd?.removeEventListener(_cameraListener);
        _cameraListener = null;
      }
      _particles?.killAll();
      destroyCanvas();
    },

    async update() {
      if (!_enabled) return false;
      return refresh();
    },

    /**
     * The DataLayerManager stats contract. The name matters: the manager reads
     * `getStats()` and nothing else (`manager.js:_moduleStats`), early-returning
     * a `{count: 0, lastUpdate: null}` stub for any layer that does not have it.
     * This was `getStatus()`, so the DATA panel row for this layer reported a
     * blank count and "never" permanently — including while `refresh()` was
     * failing — and the contract test asserted the wrong name, certifying it.
     *
     * @returns {{count: number, lastUpdate: ?number, error: ?string,
     *   source: ?string, tier: ?string, gating: ?Object}}
     */
    getStats() {
      const provenance = _payload?.provenance ?? null;
      return {
        count: _stats?.finite ?? 0,
        lastUpdate: _payload?.generatedAtMs ?? null,
        error: _lastError,
        // Names the rung that actually served, so the row does not advertise HF
        // radar over a view the radar network does not reach. Undefined (not
        // null) when nothing has served yet, so `stats.source || layer.source`
        // in `_buildMetaText` falls through to the static ladder.
        source: provenance ? sourceLabel(provenance) : undefined,
        tier: provenance?.tier ?? null,
        gating: _rasterGating,
      };
    },

    /** Test seams — drive the production paths without a browser. */
    _refreshForTest: () => refresh(),
    _stateForTest: () => ({
      payload: _payload,
      stats: _stats,
      raster: _raster,
      gating: _rasterGating,
      fetchedBox: _fetchedBox,
      error: _lastError,
    }),
  };
  return layer;
}

const oceanFieldLayer = createOceanFieldLayer();

// QA seam, matching the repo's existing `window.__gevQa*` idiom: the field is a
// canvas the DOM cannot describe, so browser-driven checks need the layer's own
// raster gating counts to say WHY a node is empty rather than guess at a
// screenshot. Exposed as a frozen object of read-only accessors, and only under
// `import.meta.env.DEV`, so it is tree-shaken out of a production build rather
// than handing anyone a live handle on the layer.
if (import.meta.env?.DEV && typeof window !== 'undefined') {
  Object.defineProperty(window, '__gevQaOceanField', {
    value: Object.freeze({
      state: () => oceanFieldLayer._stateForTest(),
      status: () => oceanFieldLayer.getStats(),
    }),
    configurable: false,
    writable: false,
  });
}

export default oceanFieldLayer;
