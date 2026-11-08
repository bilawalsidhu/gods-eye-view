/* global Cesium */
// Deterministic frame renderer for the Cosmos 2612 / ICEYE-X36 replay.
// window.rpo.frame(seconds) sets every piece of state for one video instant,
// renders, and resolves once imagery and models have settled.

import { createHud } from './hud.js';
import { buildStory } from './story.js';

const params = new URLSearchParams(location.search);
const W = Number(params.get('w') || 1920);
const H = Number(params.get('h') || 1080);
const PORTRAIT = H > W;
const U = PORTRAIT ? W / 1080 : W / 1920;
document.documentElement.style.setProperty('--u', `${U}px`);
if (PORTRAIT) document.body.classList.add('portrait');

const D = await (await fetch('data.json')).json();
const T0 = Date.parse(D.t0);
const DT = D.dt;
const NS = D.sep_km.length;
const sec = (iso) => (Date.parse(iso) - T0) / 1000;
const FPS = Number(params.get('fps') || 30);
const SHUTTER = 0.5; // 180° shutter for motion blur
const SETTLE = Number(params.get('settle') || 4);

// ---------------------------------------------------------------------------
// Interpolation
// ---------------------------------------------------------------------------
function cr(arr, t, out, scale = 1) {
  const x = Math.min(Math.max(t / DT, 1), NS - 3);
  const i = Math.floor(x);
  const u = x - i;
  const u2 = u * u;
  const u3 = u2 * u;
  for (let k = 0; k < 3; k++) {
    const p0 = arr[(i - 1) * 3 + k];
    const p1 = arr[i * 3 + k];
    const p2 = arr[(i + 1) * 3 + k];
    const p3 = arr[(i + 2) * 3 + k];
    out[k] =
      0.5 * scale *
      (2 * p1 + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 + (-p0 + 3 * p1 - 3 * p2 + p3) * u3);
    if (out.length > 3) {
      out[3 + k] = (0.5 * scale * ((-p0 + p2) + 2 * (2 * p0 - 5 * p1 + 4 * p2 - p3) * u + 3 * (-p0 + 3 * p1 - 3 * p2 + p3) * u2)) / DT;
    }
  }
  return out;
}
const v3 = Cesium.Cartesian3;
const tmp6 = new Float64Array(6);
function x36Teme(t) {
  cr(D.x36, t, tmp6, 1000);
  return { r: new v3(tmp6[0], tmp6[1], tmp6[2]), v: new v3(tmp6[3], tmp6[4], tmp6[5]) };
}
const tmp3 = new Float64Array(3);
function relAt(t) {
  cr(D.rel, t, tmp3, 1);
  return [tmp3[0], tmp3[1], tmp3[2]];
}
function sepAt(t) {
  const x = Math.min(Math.max(t / DT, 0), NS - 2);
  const i = Math.floor(x);
  return D.sep_km[i] + (D.sep_km[i + 1] - D.sep_km[i]) * (x - i);
}
function litAt(t) {
  return D.lit[Math.round(Math.min(Math.max(t / DT, 0), NS - 1))] === '1';
}
function basis(r, v) {
  const R = v3.normalize(r, new v3());
  const N = v3.normalize(v3.cross(r, v, new v3()), new v3());
  const T = v3.cross(N, R, new v3());
  return { R, T, N };
}
// Curvilinear placement: along-track offset is an arc on the anchor orbit.
function place(anchor, B, rel) {
  const rm = v3.magnitude(anchor);
  const th = rel[1] / (D.a_ref_km * 1000);
  const c = Math.cos(th);
  const s = Math.sin(th);
  const Rp = new v3(B.R.x * c + B.T.x * s, B.R.y * c + B.T.y * s, B.R.z * c + B.T.z * s);
  const out = v3.multiplyByScalar(Rp, rm + rel[0], new v3());
  return v3.add(out, v3.multiplyByScalar(B.N, rel[2], new v3()), out);
}

// ---------------------------------------------------------------------------
// Time maps. tau(s): simulation clock. b(s): backdrop/anchor clock (Earth and
// lighting), equal to tau around closest approach.
// ---------------------------------------------------------------------------
const CA_T = sec(D.ca.t);
const VANTOR_T = sec(D.vantor.t);

function monotone(keys) {
  const n = keys.length;
  const xs = keys.map((k) => k[0]);
  const ys = keys.map((k) => k[1]);
  const d = [];
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  // Geometric-mean slopes keep huge rate swings smooth in log-space.
  const m = [d[0]];
  for (let i = 1; i < n - 1; i++) m.push(Math.sqrt(d[i - 1] * d[i]));
  m.push(d[n - 2]);
  for (let i = 0; i < n - 1; i++) {
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const h = a * a + b * b;
    if (h > 9) {
      const t = 3 / Math.sqrt(h);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }
  return (s) => {
    let i = 0;
    while (i < n - 2 && s > xs[i + 1]) i++;
    const hh = xs[i + 1] - xs[i];
    const t = Math.min(Math.max((s - xs[i]) / hh, 0), 1);
    const t2 = t * t;
    const t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * hh * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * hh * m[i + 1];
  };
}

// Shots own their clocks (see story.js). tau = simulation time; bclock = the
// clock the Earth, sun and X36's place on its orbit follow (== tau in `true` shots).
const STORY = buildStory({ sec, D });
const SHOTS = STORY.shots.map((sh) => ({ ...sh, tauF: monotone(sh.tau) }));
const DUR = STORY.duration;
const CUTS = SHOTS.slice(1).map((sh) => sh.s0);
function shotAt(s) {
  let k = 0;
  for (let i = 0; i < SHOTS.length; i++) if (s >= SHOTS[i].s0) k = i;
  return SHOTS[k];
}
const tau = (s) => shotAt(s).tauF(s);
function rate(s) {
  const sh = shotAt(s);
  const a = Math.max(sh.s0, s - 0.02);
  const b = Math.min(sh.s1 - 1e-4, s + 0.02);
  return (sh.tauF(b) - sh.tauF(a)) / (b - a);
}
function bclock(s) {
  const sh = shotAt(s);
  return sh.mode === 'true' ? sh.tauF(s) : sh.tauF(sh.s0) + (s - sh.s0) * (sh.bgRate || 140);
}
// Video time at which simulation time t is shown (skipping the cold open).
function sOfTau(t) {
  for (let i = SHOTS.length - 1; i >= 1; i--) {
    const sh = SHOTS[i];
    const a = sh.tauF(sh.s0);
    const b = sh.tauF(sh.s1);
    if (t >= a && t <= b) {
      let lo = sh.s0;
      let hi = sh.s1;
      for (let k = 0; k < 40; k++) {
        const mid = (lo + hi) / 2;
        if (sh.tauF(mid) < t) lo = mid;
        else hi = mid;
      }
      return lo;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Story: captions, events, camera
// ---------------------------------------------------------------------------
const BURNS = D.burns.map((b) => ({ ...b, t: sec(b.t) }));

const smooth = (x) => x * x * x * (x * (x * 6 - 15) + 10);
function camAt(s) {
  const keys = shotAt(s).cam;
  let i = 0;
  while (i < keys.length - 2 && s > keys[i + 1].s) i++;
  const a = keys[i];
  const b = keys[Math.min(i + 1, keys.length - 1)];
  const u = b === a ? 0 : smooth(Math.min(Math.max((s - a.s) / (b.s - a.s), 0), 1));
  const lerp = (x, y) => x + (y - x) * u;
  const lg = (x, y) => Math.exp(lerp(Math.log(x), Math.log(y)));
  const ar = a.aimRel || [0, 0, 0];
  const br = b.aimRel || [0, 0, 0];
  return {
    frame: a.frame || 'rtn',
    dist: lg(a.dist, b.dist),
    f: lerp(a.f || 0, b.f || 0),
    az: lerp(a.az, b.az),
    el: lerp(a.el, b.el),
    look: lerp(a.look || 0, b.look || 0),
    earth: lerp(a.earth || 0, b.earth || 0),
    fov: lerp(a.fov, b.fov),
    mag: lerp(a.mag || 0, b.mag || 0),
    mx: lg(a.mx || 1, b.mx || 1),
    rtrail: lerp(a.rtrail || 0, b.rtrail || 0),
    atrail: lerp(a.atrail || 0, b.atrail || 0),
    sun: lerp(a.sun || 0, b.sun || 0),
    vup: lerp(a.vup || 0, b.vup || 0),
    comp: lerp(a.comp ?? 1, b.comp ?? 1),
    pairD: lerp(a.pairD || 0, b.pairD || 0),
    pairTh: lerp(a.pairTh || 0, b.pairTh || 0),
    aimRel: [0, 1, 2].map((k) => lerp(ar[k], br[k])),
  };
}

// ---------------------------------------------------------------------------
// Cesium scene
// ---------------------------------------------------------------------------
const esri = await Cesium.ArcGisMapServerImageryProvider.fromUrl(
  'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer',
  { enablePickFeatures: false, maximumLevel: 9 },
);
const viewer = new Cesium.Viewer('globe', {
  baseLayer: new Cesium.ImageryLayer(esri, { brightness: 0.92, contrast: 1.08, gamma: 1.05 }),
  animation: false, timeline: false, baseLayerPicker: false, geocoder: false, homeButton: false,
  sceneModePicker: false, navigationHelpButton: false, fullscreenButton: false, infoBox: false,
  selectionIndicator: false, useDefaultRenderLoop: false, shouldAnimate: false,
  contextOptions: { webgl: { preserveDrawingBuffer: true, alpha: false } },
  msaaSamples: 1,
});
const scene = viewer.scene;
// Motion-blur accumulator: sub-frames are averaged here, above the WebGL canvas.
const accum = document.createElement('canvas');
accum.width = W;
accum.height = H;
accum.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;visibility:hidden';
document.getElementById('globe').appendChild(accum);
const actx = accum.getContext('2d');
// Night side: NASA Black Marble city lights (keyless GIBS tiles).
const nightLayer = viewer.imageryLayers.addImageryProvider(new Cesium.UrlTemplateImageryProvider({
  url: 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png',
  maximumLevel: 8, credit: 'NASA Black Marble',
}));
nightLayer.dayAlpha = 0.0;
nightLayer.nightAlpha = 1.0;
nightLayer.brightness = 1.6;
viewer.imageryLayers.get(0).nightAlpha = 0.0;
// Sky: ESO Milky Way cube (stars removed) + Yale Bright Star Catalogue points.
scene.skyBox = new Cesium.SkyBox({ sources: Object.fromEntries(
  [['positiveX', 'px'], ['negativeX', 'nx'], ['positiveY', 'py'], ['negativeY', 'ny'], ['positiveZ', 'pz'], ['negativeZ', 'nz']]
    .map(([k, f]) => [k, `/sky/milkyway_${f}.webp`])) });
const starData = await (await fetch('/sky/bright_stars.json')).json();
const starArr = Array.isArray(starData) ? starData : starData.stars || starData.data;
const stars = scene.primitives.add(new Cesium.PointPrimitiveCollection({ blendOption: Cesium.BlendOption.TRANSLUCENT }));
const starDirs = [];
for (let i = 0; i + 3 < starArr.length; i += 4) {
  const [ra, dec, vm, bv] = [starArr[i], starArr[i + 1], starArr[i + 2], starArr[i + 3]];
  const r = Cesium.Math.toRadians(ra);
  const d = Cesium.Math.toRadians(dec);
  const dir = new Cesium.Cartesian3(Math.cos(d) * Math.cos(r), Math.cos(d) * Math.sin(r), Math.sin(d));
  const b = Math.min(1, Math.sqrt(10 ** (-0.4 * ((Number.isFinite(vm) ? vm : 6.5) - 6.5))) / 9);
  const t = Math.min(Math.max(((Number.isFinite(bv) ? bv : 0.6) + 0.3) / 2.0, 0), 1);
  const col = new Cesium.Color(0.78 + 0.22 * t, 0.84 + 0.06 * (1 - Math.abs(t - 0.4)), 1.0 - 0.3 * t, 0.25 + 0.75 * b);
  starDirs.push(dir);
  stars.add({ position: dir, color: col, pixelSize: 0.9 + 2.6 * b });
}

const globe = scene.globe;
globe.enableLighting = true;
globe.dynamicAtmosphereLighting = true;
globe.dynamicAtmosphereLightingFromSun = true;
globe.showGroundAtmosphere = true;
globe.atmosphereLightIntensity = 9;
globe.lightingFadeOutDistance = 1;
globe.lightingFadeInDistance = 2;
globe.nightFadeOutDistance = 1e10;
globe.nightFadeInDistance = 1e10;
globe.maximumScreenSpaceError = 2.2;
globe.tileCacheSize = 1500;
globe.preloadSiblings = false;
globe.baseColor = Cesium.Color.fromCssColorString('#04070d');
scene.fog.enabled = false;
scene.skyAtmosphere.show = true;
scene.skyAtmosphere.atmosphereLightIntensity = 10;
scene.highDynamicRange = false;
scene.sun.glowFactor = 1.6;
scene.moon.show = true;
scene.postProcessStages.fxaa.enabled = true;
scene.backgroundColor = Cesium.Color.BLACK;
scene.screenSpaceCameraController.enableInputs = false;
scene.camera.frustum.near = 0.5;
scene.camera.frustum.far = 1e9;
viewer.resolutionScale = Number(params.get('rs') || 1);
const bloom = scene.postProcessStages.bloom;
bloom.enabled = false;
bloom.uniforms.contrast = 119;
bloom.uniforms.brightness = -0.42;
bloom.uniforms.glowOnly = false;
bloom.uniforms.delta = 1.0;
bloom.uniforms.sigma = 3.2;
bloom.uniforms.stepSize = 1.0;

const COL_X36 = Cesium.Color.fromCssColorString('#5ce1e6');
const COL_COS = Cesium.Color.fromCssColorString('#ff5a3c');
const COL_BURN = Cesium.Color.fromCssColorString('#ffb547');

const modelOpts = { upAxis: Cesium.Axis.Z, forwardAxis: Cesium.Axis.X, shadows: Cesium.ShadowMode.DISABLED };
const mX36 = await Cesium.Model.fromGltfAsync({ url: 'iceye-x36.glb', ...modelOpts });
const mCos = await Cesium.Model.fromGltfAsync({ url: 'cosmos-2612.glb', ...modelOpts });
scene.primitives.add(mX36);
scene.primitives.add(mCos);
for (const m of [mX36, mCos]) {
  m.environmentMapOptions = { enabled: false };
  m.imageBasedLighting.sphericalHarmonicCoefficients = undefined;
}

function glowCanvas(color, core = 0.18) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(core, color.withAlpha(1).toCssColorString());
  grd.addColorStop(0.45, color.withAlpha(0.28).toCssColorString());
  grd.addColorStop(1, color.withAlpha(0).toCssColorString());
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  return c;
}
const billboards = scene.primitives.add(new Cesium.BillboardCollection({ scene }));
const bX36 = billboards.add({ image: glowCanvas(COL_X36), scale: 0.3 * U, disableDepthTestDistance: 0 });
const bCos = billboards.add({ image: glowCanvas(COL_COS), scale: 0.3 * U, disableDepthTestDistance: 0 });
const bBurn = billboards.add({ image: glowCanvas(COL_BURN, 0.08), scale: 0, disableDepthTestDistance: 0 });

let dynamic = [];
function clearDynamic() {
  for (const p of dynamic) scene.primitives.remove(p);
  dynamic = [];
}
function polyline(positions, colors, width) {
  if (positions.length < 2) return;
  const p = new Cesium.Primitive({
    geometryInstances: new Cesium.GeometryInstance({
      geometry: new Cesium.PolylineGeometry({
        positions, colors, colorsPerVertex: true, width: width * U, arcType: Cesium.ArcType.NONE,
      }),
    }),
    appearance: new Cesium.PolylineColorAppearance({ translucent: true }),
    asynchronous: false,
  });
  scene.primitives.add(p);
  dynamic.push(p);
}

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------
function project(world) {
  const p = Cesium.SceneTransforms.worldToWindowCoordinates(scene, world);
  if (!p) return null;
  // Behind-camera / occluded test
  const cam = scene.camera;
  const d = v3.subtract(world, cam.positionWC, new v3());
  if (v3.dot(d, cam.directionWC) <= 0) return null;
  const ray = v3.normalize(d, new v3());
  const hit = Cesium.IntersectionTests.rayEllipsoid(new Cesium.Ray(cam.positionWC, ray), Cesium.Ellipsoid.WGS84);
  if (hit && hit.start * 1.0005 < v3.magnitude(d)) return { ...p, hidden: true };
  return p;
}
const hud = createHud({
  D, W, H, U, PORTRAIT, sec, rate, sOfTau, sepAt, CA_T, VANTOR_T, BURNS, CUTS, SHOTS, shotAt, DUR, project,
});

// ---------------------------------------------------------------------------
// Frame
// ---------------------------------------------------------------------------
const M = new Cesium.Matrix3();
function toWorld(teme, jd) {
  return Cesium.Matrix3.multiplyByVector(M, teme, new v3());
}

function modelMatrix(pos, X, Y, scale) {
  const Z = v3.cross(X, Y, new v3());
  const m = new Cesium.Matrix4(
    X.x * scale, Y.x * scale, Z.x * scale, pos.x,
    X.y * scale, Y.y * scale, Z.y * scale, pos.y,
    X.z * scale, Y.z * scale, Z.z * scale, pos.z,
    0, 0, 0, 1,
  );
  return m;
}

function eclipseLight(worldPos, sunW) {
  // Cylindrical shadow with a soft edge.
  const p = v3.dot(worldPos, sunW);
  if (p > 0) return 1;
  const perp = v3.magnitude(v3.subtract(worldPos, v3.multiplyByScalar(sunW, p, new v3()), new v3()));
  const e = (perp - 6.371e6) / 6e4;
  return Math.min(1, Math.max(0, 0.5 + e));
}

// Orbital speed from vis-viva, using each satellite's own SMA (m/s).
const MU = 3.986004418e14;
function smaOffsetAt(t) {
  const arr = D.sma_offset_km;
  const x = Math.min(Math.max(t / (DT * 10), 0), arr.length - 1);
  return arr[Math.round(x)] * 1000;
}

// Set every scene element for video time s. Returns state for the HUD.
function setState(s) {
  const sh = shotAt(s);
  const t = tau(s);
  const b = bclock(s);
  const jd = Cesium.JulianDate.addSeconds(Cesium.JulianDate.fromIso8601(D.t0), b, new Cesium.JulianDate());
  Cesium.Transforms.computeTemeToPseudoFixedMatrix(jd, M);
  const cam = camAt(s);

  // Anchor (X36 on the shot's display clock) and relative state at simulation time.
  const A = x36Teme(b);
  const B = basis(A.r, A.v);
  const rel = relAt(t);
  const x36W = toWorld(A.r);
  const cosW = toWorld(place(A.r, B, rel));
  const RW = toWorld(B.R);
  const TW = toWorld(B.T);
  const NW = toWorld(B.N);
  const sep = v3.distance(x36W, cosW);
  // Inertial camera basis: X36's frame frozen at the shot start.
  let cR = RW;
  let cT = TW;
  let cN = NW;
  if (cam.frame === 'inertial') {
    const A0 = x36Teme(bclock(sh.s0));
    const B0 = basis(A0.r, A0.v);
    cR = toWorld(B0.R);
    cT = toWorld(B0.T);
    cN = toWorld(B0.N);
  }

  const sunW = v3.normalize(Cesium.Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(jd, new v3()), new v3());
  Cesium.Matrix3.multiplyByVector(Cesium.Transforms.computeIcrfToFixedMatrix(jd) || M, sunW, sunW);
  v3.normalize(sunW, sunW);

  // Frame on Cosmos's guiding centre (its loop averaged over one orbit) and the
  // loop's size: both change slowly, so the shot doesn't pump every orbit.
  const P = 5730;
  const gc = [0, 0, 0];
  const relS = [];
  for (let k = 0; k < 16; k++) {
    const rk = relAt(t - P / 2 + (k + 0.5) * (P / 16));
    relS.push(rk);
    gc[0] += rk[0] / 16;
    gc[1] += rk[1] / 16;
    gc[2] += rk[2] / 16;
  }
  let loop = 0;
  for (const rk of relS) loop = Math.max(loop, Math.hypot(rk[0] - gc[0], rk[1] - gc[1], rk[2] - gc[2]));
  const gcW = toWorld(place(A.r, B, gc));
  const sepG = v3.distance(x36W, gcW) + loop;
  const pivot = v3.lerp(x36W, gcW, cam.look, new v3());
  v3.lerp(pivot, v3.ZERO, cam.earth, pivot);
  const aim = v3.clone(pivot);
  v3.add(aim, v3.multiplyByScalar(RW, cam.aimRel[0], new v3()), aim);
  v3.add(aim, v3.multiplyByScalar(TW, cam.aimRel[1], new v3()), aim);
  v3.add(aim, v3.multiplyByScalar(NW, cam.aimRel[2], new v3()), aim);
  const dist = Math.max(cam.dist, cam.f * sepG) * (PORTRAIT && cam.earth > 0.5 ? 0.74 : 1);
  const az = Cesium.Math.toRadians(cam.az);
  const el = Cesium.Math.toRadians(cam.el);
  const off = new v3();
  v3.add(off, v3.multiplyByScalar(cT, -Math.cos(el) * Math.cos(az), new v3()), off);
  v3.add(off, v3.multiplyByScalar(cN, Math.cos(el) * Math.sin(az), new v3()), off);
  v3.add(off, v3.multiplyByScalar(cR, Math.sin(el), new v3()), off);
  if (cam.sun > 0) {
    v3.normalize(v3.add(v3.multiplyByScalar(off, 1 - cam.sun, off), v3.multiplyByScalar(sunW, cam.sun, new v3()), off), off);
  }
  const camPos = v3.add(pivot, v3.multiplyByScalar(off, dist, new v3()), new v3());
  if (cam.pairD > 0) {
    // Pair-locked: camera just off X36, angled pairTh from the X36->Cosmos line
    // (sideways, in the orbit's horizontal), aimed at the bisector of the two.
    const u = v3.normalize(v3.subtract(cosW, x36W, new v3()), new v3());
    const perp = v3.normalize(v3.subtract(NW, v3.multiplyByScalar(u, v3.dot(NW, u), new v3()), new v3()), new v3());
    const th = Cesium.Math.toRadians(cam.pairTh);
    v3.add(x36W, v3.multiplyByScalar(u, -cam.pairD * Math.cos(th), new v3()), camPos);
    v3.add(camPos, v3.multiplyByScalar(perp, cam.pairD * Math.sin(th), new v3()), camPos);
    const a1 = v3.normalize(v3.subtract(x36W, camPos, new v3()), new v3());
    const a2 = v3.normalize(v3.subtract(cosW, camPos, new v3()), new v3());
    v3.add(camPos, v3.add(a1, a2, new v3()), aim);
  }
  const minR = 6.371e6 + 1.2e5;
  if (v3.magnitude(camPos) < minR) v3.multiplyByScalar(v3.normalize(camPos, camPos), minR, camPos);
  const dir = v3.normalize(v3.subtract(aim, camPos, new v3()), new v3());
  // Up: local zenith; in portrait chase shots, the direction of flight (so the
  // pair travels up the tall frame and Earth's limb runs down one side).
  const vup = PORTRAIT ? cam.vup : 0;
  const upHint = v3.normalize(v3.lerp(RW, TW, vup, new v3()), new v3());
  let right = v3.normalize(v3.cross(dir, upHint, new v3()), new v3());
  let up = v3.cross(right, dir, new v3());
  {
    // Composition: put the aim point right of centre in 16:9 (caption column on the left).
    const fovR = Cesium.Math.toRadians(PORTRAIT ? cam.fov * 1.55 : cam.fov);
    const aspect = W / H;
    const tanH = PORTRAIT ? Math.tan(fovR / 2) * aspect : Math.tan(fovR / 2);
    const tanV = PORTRAIT ? Math.tan(fovR / 2) : Math.tan(fovR / 2) / aspect;
    const ndcX = (PORTRAIT ? 0 : 0.18) * cam.comp;
    const ndcY = (PORTRAIT ? -0.04 : 0.06) * cam.comp;
    v3.normalize(v3.add(v3.add(dir, v3.multiplyByScalar(right, -ndcX * tanH, new v3()), new v3()),
      v3.multiplyByScalar(up, -ndcY * tanV, new v3()), new v3()), dir);
    right = v3.normalize(v3.cross(dir, upHint, new v3()), new v3());
    up = v3.cross(right, dir, new v3());
  }
  scene.camera.setView({ destination: camPos, orientation: { direction: dir, up } });
  scene.camera.frustum.fov = Cesium.Math.toRadians(PORTRAIT ? cam.fov * 1.55 : cam.fov);
  {
    const icrf = Cesium.Transforms.computeIcrfToFixedMatrix(jd) || M;
    const tmp = new v3();
    for (let i = 0; i < starDirs.length; i++) {
      Cesium.Matrix3.multiplyByVector(icrf, starDirs[i], tmp);
      stars.get(i).position = v3.add(camPos, v3.multiplyByScalar(tmp, 3e8, tmp), new v3());
    }
  }
  scene.camera.frustum.near = Math.max(0.2, Math.min(dist * 0.02, 1000));

  // Models: attitude, fixed per-shot enlargement, lighting
  const camDistX = v3.distance(camPos, x36W);
  const camDistC = v3.distance(camPos, cosW);
  const pxPerRad = W / (2 * Math.tan(scene.camera.frustum.fov / 2));
  const mag = cam.mag > 0.5 ? cam.mx : 1;
  mX36.show = cam.mag > 0.01 || camDistX < 3000;
  mCos.show = cam.mag > 0.01 || camDistC < 6000;
  mX36.modelMatrix = modelMatrix(x36W, TW, RW, mag);
  const toX = v3.normalize(v3.subtract(x36W, cosW, new v3()), new v3());
  const w = Math.min(1, Math.max(0, (60e3 - sep) / 40e3));
  const cx = v3.normalize(v3.lerp(TW, toX, w, new v3()), new v3());
  const cy = v3.normalize(v3.subtract(RW, v3.multiplyByScalar(cx, v3.dot(RW, cx), new v3()), new v3()), new v3());
  mCos.modelMatrix = modelMatrix(cosW, cx, cy, mag);
  const lx = eclipseLight(x36W, sunW);
  const lc = eclipseLight(cosW, sunW);
  const lightFor = (l) => new v3(0.6 + (2.3 - 0.6) * l, 0.66 + (2.3 - 0.66) * l, 0.92 + (2.3 - 0.92) * l);
  mX36.lightColor = lightFor(lx);
  mCos.lightColor = lightFor(lc);

  // Glows: always on as "lights"; they shrink when the model is big enough to read.
  const pxX = (3.25 * mag * pxPerRad) / camDistX;
  const pxC = (3.6 * mag * pxPerRad) / camDistC;
  bX36.position = x36W;
  bCos.position = cosW;
  bX36.scale = (pxX > 24 ? 0.16 : 0.5) * U;
  bCos.scale = (pxC > 24 ? 0.16 : 0.5) * U;
  bX36.color = Cesium.Color.WHITE.withAlpha(pxX > 60 ? 0.35 : 1);
  bCos.color = Cesium.Color.WHITE.withAlpha(pxC > 60 ? 0.35 : 1);

  // Burn flare
  let flare = 0;
  for (const bn of BURNS) {
    const sb = sOfTauCached(bn.t);
    if (sb === null) continue;
    const k = (s - sb) / 0.9;
    if (k > -0.08 && k < 1) flare = Math.max(flare, k < 0 ? 1 + k / 0.08 : (1 - k) ** 1.6);
  }
  bBurn.position = cosW;
  bBurn.scale = flare * 1.1 * U;
  bBurn.color = Cesium.Color.WHITE.withAlpha(flare);

  // Trails
  clearDynamic();
  // Orbit trails (inertial): where each satellite has actually flown in the last
  // `atrail` minutes. Only meaningful when the shot runs on one clock.
  if (cam.atrail > 0 && sh.mode === 'true') {
    const span = cam.atrail * 60;
    const n = Math.min(400, Math.max(40, Math.round(span / 15)));
    for (const which of ['x36', 'cos']) {
      const pts = [];
      const cols = [];
      const col = which === 'x36' ? COL_X36 : COL_COS;
      for (let k = 0; k <= n; k++) {
        const tt = t - span + (k / n) * span;
        if (tt < 0) continue;
        const Ak = x36Teme(tt);
        const p = which === 'x36' ? Ak.r : place(Ak.r, basis(Ak.r, Ak.v), relAt(tt));
        pts.push(toWorld(p));
        cols.push(col.withAlpha(0.02 + 0.8 * (k / n) ** 2.2));
      }
      pts.push(which === 'x36' ? x36W : cosW);
      cols.push(col.withAlpha(0.85));
      polyline(pts, cols, which === 'x36' ? 3 : 3);
    }
  }
  // Cosmos relative trail (its path as seen from X36), in the current anchor frame
  if (cam.rtrail > 0) {
    const span = cam.rtrail * 3600;
    const n = Math.min(1200, Math.max(60, Math.round(span / 40)));
    const pts = [];
    const cols = [];
    for (let k = 0; k <= n; k++) {
      const tt = t - span + (k / n) * span;
      if (tt < 0) continue;
      pts.push(toWorld(place(A.r, B, relAt(tt))));
      cols.push(COL_COS.withAlpha(0.05 + 0.9 * (k / n) ** 1.6));
    }
    pts.push(cosW);
    cols.push(COL_COS.withAlpha(1));
    polyline(pts, cols, 2.6);
  }
  // X36 orbit ring for wide shots (inertial, at the anchor epoch)
  const ringA = Math.min(1, Math.max(0, (camDistX - 1.5e4) / 6e4)) * (cam.atrail > 0 && sh.mode === 'true' ? 0.35 : 1);
  if (ringA > 0.01) {
    const P = 5730;
    const pts = [];
    const cols = [];
    for (let k = 0; k <= 240; k++) {
      pts.push(toWorld(x36Teme(b - P + (k / 240) * P).r));
      cols.push(COL_X36.withAlpha((0.05 + 0.3 * (k / 240) ** 2) * ringA));
    }
    polyline(pts, cols, 1.4);
  }
  // RIC reference rings (orbital plane) during proximity
  const gridA = Math.min(1, Math.max(0, (8e3 - Math.max(sep, camDistX)) / 3e3)) * (cam.mag > 0.4 ? 1 : 0.35);
  if (gridA > 0.01) {
    for (const r of [500, 1000, 2000]) {
      const pts = [];
      const cols = [];
      for (let k = 0; k <= 120; k++) {
        const a = (k / 120) * Math.PI * 2;
        const p = v3.add(x36W, v3.multiplyByScalar(RW, r * Math.sin(a), new v3()), new v3());
        v3.add(p, v3.multiplyByScalar(TW, r * Math.cos(a), new v3()), p);
        pts.push(p);
        cols.push(Cesium.Color.WHITE.withAlpha(0.14 * gridA));
      }
      polyline(pts, cols, 1);
    }
  }

  // Speeds: X36 from its state vector; Cosmos by vis-viva with its own SMA.
  const rC = v3.magnitude(place(A.r, B, rel));
  const aC = D.a_km * 1000 + smaOffsetAt(t);
  const vC = Math.sqrt(MU * (2 / rC - 1 / aC));
  const vXv = Math.sqrt(MU * (2 / v3.magnitude(A.r) - 1 / (D.a_km * 1000)));
  const r1 = relAt(t + 30);
  const r0 = relAt(t - 30);
  const relSpeed = Math.hypot(r1[0] - r0[0], r1[1] - r0[1], r1[2] - r0[2]) / 60;

  return { sh, t, b, jd, x36W, cosW, RW, TW, NW, rel, sep, mag, gridA, lx, camDistX, vX: vXv, vC, relSpeed };
}

async function frame(s) {
  const sh = shotAt(s);
  const K = Math.max(1, (sh.blur | 0) % 2 ? sh.blur | 0 : (sh.blur | 0) + 1);
  globe.maximumScreenSpaceError = K > 1 ? 4 : 2.2;
  const mid = Math.floor(K / 2);
  let hudState = null;
  accum.style.visibility = K > 1 ? 'visible' : 'hidden';
  for (let k = 0; k < K; k++) {
    // Sub-frames spread across the shutter, clamped inside the shot.
    const sk = K === 1 ? s : Math.min(sh.s1 - 1e-4, Math.max(sh.s0, s + ((k + 0.5) / K - 0.5) * (SHUTTER / FPS)));
    const st = setState(k === mid ? s : sk);
    scene.render(st.jd);
    if (k === 0 || K === 1) {
      for (let j = 0; j < SETTLE && !(globe.tilesLoaded && mX36.ready && mCos.ready); j++) {
        await new Promise((r) => setTimeout(r, 60));
        scene.render(st.jd);
      }
    }
    if (k === mid) {
      hud.update(s, st.t, st.b, st);
      hudState = st;
    }
    if (K > 1) {
      actx.globalAlpha = 1 / (k + 1);
      actx.drawImage(viewer.canvas, 0, 0, W, H);
    }
  }
  const gl = scene.context._gl;
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
  return { s, t: hudState.t, sep: hudState.sep, mag: hudState.mag, shot: sh.id, K };
}

const sOfTauMemo = new Map();
function sOfTauCached(t) {
  if (!sOfTauMemo.has(t)) sOfTauMemo.set(t, sOfTau(t));
  return sOfTauMemo.get(t);
}

await document.fonts.ready;
window.rpo = { frame, tau, bclock, duration: DUR, ready: true, SHOTS };
