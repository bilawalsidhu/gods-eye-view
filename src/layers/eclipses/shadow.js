import * as Cesium from 'cesium';
import { EARTH_RADIUS_M } from './besselian.js';

/** The Moon's radius in Earth equatorial radii, as the elements take it. */
export const MOON_RADIUS = 0.2725076;

/**
 * Where the Sun and the Moon stand for a shadow frame, Earth-fixed, in radii:
 * each `[x, y, z, radius]`. Both cones touch the Moon and the Sun, so the
 * cones' radii and angles place the two bodies along the axis.
 */
export function sunAndMoon(frame) {
  const moonHeight = (frame.l1 - MOON_RADIUS) / frame.tanF1;
  const apart = (2 * MOON_RADIUS) / (frame.tanF1 - frame.tanF2);
  const sunRadius =
    (MOON_RADIUS * (frame.tanF1 + frame.tanF2)) / (frame.tanF1 - frame.tanF2);
  const at = (height) => [
    frame.origin[0] + frame.k[0] * height,
    frame.origin[1] + frame.k[1] * height,
    frame.origin[2] + frame.k[2] * height,
  ];
  return {
    moon: [...at(moonHeight), MOON_RADIUS],
    sun: [...at(moonHeight + apart), sunRadius],
  };
}

/**
 * The Moon's shadow, drawn over the finished frame.
 *
 * Each pixel's view ray is met with the WGS84 ellipsoid, and the ground point
 * is tested against the two shadow cones (see besselian.js): how far it lies
 * from the shadow axis, against the penumbra's and umbra's radii at its
 * height. So the shading is the eclipse itself, not a drawn shape: the
 * penumbra darkens toward the axis as more of the Sun is covered, the umbra
 * is the dark core, and both fall on terrain and 3D tiles alike. Moving the
 * shadow is seven numbers a frame; no geometry is rebuilt.
 */
export const SHADOW_SHADER = /* glsl */ `
uniform sampler2D colorTexture;
in vec2 v_textureCoordinates;

// The camera, Earth-fixed, in equatorial radii. Right and up are scaled by
// the tangent of half the field of view.
uniform vec3 u_cameraPosition;
uniform vec3 u_cameraDirection;
uniform vec3 u_cameraRight;
uniform vec3 u_cameraUp;
// The shadow axis: a point on it and its direction (toward the Sun).
uniform vec3 u_axisOrigin;
uniform vec3 u_axisDirection;
// l1, l2, tan f1, tan f2.
uniform vec4 u_cones;
// How deep in shadow the camera's own ground point is, for the sky.
uniform float u_skyShade;
// The Sun and the Moon: centre (Earth-fixed, radii) and radius.
uniform vec4 u_sun;
uniform vec4 u_moon;
// 1 while the camera faces the Sun and the layer draws both discs; 0 leaves
// the sky to the scene's own Sun and Moon.
uniform float u_sunView;
// The share of the Sun's disc hidden from the camera's ground point.
uniform float u_covered;
// A lunar eclipse: 1 while one is drawn, the Moon's centre (Earth-fixed,
// radii) and radius, and where its centre stands from the Earth's shadow
// (east, north) with the umbra's and penumbra's radii.
uniform float u_lunar;
uniform vec4 u_lunarMoon;
uniform vec4 u_lunarShadow;
// How much of the Moon's diameter is inside the umbra, 0 to 1.
uniform float u_lunarDepth;
// 1 while the camera faces the Moon and the layer draws it.
uniform float u_lunarView;

const float POLAR_STRETCH = 1.0 / (1.0 - 1.0 / 298.257223563);
const vec3 TWILIGHT = vec3(0.74, 0.84, 1.12);
const vec3 HORIZON_GLOW = vec3(1.0, 0.56, 0.22);
const vec3 RING_OF_FIRE = vec3(1.0, 0.42, 0.08);

// A soft mottling for the Moon's seas.
float mottle(vec2 at) {
  vec2 cell = floor(at);
  vec2 f = fract(at);
  f = f * f * (3.0 - 2.0 * f);
  float a = fract(sin(dot(cell, vec2(127.1, 311.7))) * 43758.5453);
  float b = fract(sin(dot(cell + vec2(1.0, 0.0), vec2(127.1, 311.7))) * 43758.5453);
  float c = fract(sin(dot(cell + vec2(0.0, 1.0), vec2(127.1, 311.7))) * 43758.5453);
  float d = fract(sin(dot(cell + vec2(1.0, 1.0), vec2(127.1, 311.7))) * 43758.5453);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

void main() {
  vec4 color = texture(colorTexture, v_textureCoordinates);
  vec2 ndc = v_textureCoordinates * 2.0 - 1.0;
  vec3 dir = normalize(
    u_cameraDirection + ndc.x * u_cameraRight + ndc.y * u_cameraUp
  );

  // Meet the ray with the ellipsoid, as a unit sphere once z is stretched.
  vec3 os = vec3(u_cameraPosition.xy, u_cameraPosition.z * POLAR_STRETCH);
  vec3 ds = vec3(dir.xy, dir.z * POLAR_STRETCH);
  float a = dot(ds, ds);
  float b = dot(os, ds);
  float c = dot(os, os) - 1.0;
  float disc = b * b - a * c;
  float root = sqrt(max(disc, 0.0));
  float s = (-b - root) / a;
  if (s < 0.0) s = (-b + root) / a;
  float hit = step(0.0, disc) * step(0.0, s);
  vec3 p = u_cameraPosition + s * dir;

  // The ground point against the cones.
  float zeta = dot(p, u_axisDirection);
  vec3 r = p - u_axisOrigin;
  float m = length(r - dot(r, u_axisDirection) * u_axisDirection);
  float penumbra = u_cones.x - zeta * u_cones.z;
  float umbra = u_cones.y - zeta * u_cones.w;
  float core = abs(umbra);
  // The share of the Sun's diameter the Moon covers.
  float g = (penumbra - m) / (penumbra + umbra);
  float mag = clamp(g, 0.0, 1.0);
  // The shadow only falls where the Sun is up.
  float day = smoothstep(-0.015, 0.09, zeta) * hit * (1.0 - u_lunar);
  float total = step(umbra, 0.0);

  float soft = fwidth(m) * 1.5 + core * 0.06;
  float inside = 1.0 - smoothstep(core - soft, core + soft, m);
  float shade = 0.7 * pow(mag, 1.1);
  shade = mix(shade, mix(0.76, 0.95, total), inside);

  // A warm band round the core: the sunset that circles the horizon in
  // totality, or the ring of sunlight left in an annular eclipse.
  float reach = core * 0.45 + 0.0025;
  float ring = exp(-pow((m - core) / reach, 2.0)) * (1.0 - inside * 0.65);
  vec3 glow = mix(RING_OF_FIRE * 0.5, HORIZON_GLOW * 0.3, total) * ring;

  // Fine lines: the penumbra's edge and each quarter of the Sun covered.
  float facing = smoothstep(0.03, 0.14, dot(normalize(p), -dir));
  float width = max(fwidth(g), 1e-6);
  float edge = 1.0 - smoothstep(0.0, 1.6, abs(g) / width);
  float q = g * 4.0;
  float nearest = abs(q - floor(q + 0.5));
  float quarter =
    (1.0 - smoothstep(0.0, 1.4, nearest / max(fwidth(q), 1e-6))) *
    step(0.1, g) * step(g, 0.9);
  float lines = (edge * 0.26 + quarter * 0.11) * facing * (1.0 - inside);

  vec3 lit = color.rgb * (1.0 - shade);
  lit = mix(lit, lit * TWILIGHT, shade * 0.6);
  lit += glow + vec3(0.92, 0.95, 1.0) * lines;
  vec3 ground = mix(color.rgb, lit, day);

  // A lunar eclipse looks the same from everywhere the Moon is up: tint that
  // half of the Earth with the eclipsed Moon's light, and mark its edge,
  // where the Moon sits on the horizon.
  if (u_lunar > 0.0) {
    float moonUp = dot(normalize(p), normalize(u_lunarMoon.xyz)) - 0.00698;
    float under = smoothstep(0.0, 0.05, moonUp);
    vec3 moonlight = mix(
      vec3(0.72, 0.8, 1.0),
      vec3(1.0, 0.36, 0.2),
      clamp(u_lunarDepth, 0.0, 1.0)
    );
    vec3 tinted = mix(
      vec3(0.86, 0.9, 1.0),
      vec3(1.0, 0.72, 0.62),
      clamp(u_lunarDepth, 0.0, 1.0)
    );
    ground = mix(ground, ground * tinted + moonlight * 0.05, under);
    float rim =
      1.0 - smoothstep(0.0, 1.6, abs(moonUp) / max(fwidth(moonUp), 1e-6));
    ground += moonlight * rim * 0.45 * facing;
  }

  // Looking up from inside the shadow, the sky darkens with it.
  vec3 sky = color.rgb * (1.0 - u_skyShade);

  // Facing the Sun: its disc, its glare or corona, and the Moon's disc in
  // front, each where it stands in space as seen from the camera.
  if (u_sunView > 0.0) {
    vec3 toSun = u_sun.xyz - u_cameraPosition;
    vec3 toMoon = u_moon.xyz - u_cameraPosition;
    vec3 sunDir = normalize(toSun);
    vec3 moonDir = normalize(toMoon);
    // Sines of the angles off each centre: exact for these small angles,
    // where an arc cosine would lose them.
    float fromSun = length(cross(dir, sunDir));
    float fromMoon = length(cross(dir, moonDir));
    float sunSize = u_sun.w / length(toSun);
    float moonSize = u_moon.w / length(toMoon);
    float ahead = step(0.0, dot(dir, sunDir));
    float r = fromSun / sunSize;
    float aa = max(fwidth(fromSun), 1e-7);

    float disc = 1.0 - smoothstep(sunSize - aa, sunSize + aa, fromSun);
    float limb = sqrt(max(1.0 - r * r, 0.0));
    vec3 sunlight = vec3(1.0, 0.96, 0.86) * (0.7 + 0.5 * limb) * 1.25 * disc;

    float total = smoothstep(0.985, 1.0, u_covered);
    // From the ground the sky is blue by day; it holds its light until most
    // of the Sun is gone, then falls to the scene's own night sky and stars.
    float dusk = mix(0.82 * pow(u_covered, 6.0), 1.0, total);
    vec3 daySky = vec3(0.3, 0.56, 0.9) * (1.0 - 0.35 * dusk);
    sky = mix(sky, mix(daySky, color.rgb, dusk), u_sunView);
    float outside = max(r - 1.0, 0.0);
    // Daylight glare, fading as the Moon covers the Sun.
    vec3 glare =
      vec3(1.0, 0.95, 0.82) *
      exp(-outside * 0.8) * 0.55 * (1.0 - 0.92 * u_covered) * (1.0 - total);
    // The corona: brightest at the limb, with streamers reaching out.
    vec3 east = normalize(cross(sunDir, vec3(0.0, 0.0, 1.0)));
    vec3 north = cross(east, sunDir);
    float around = atan(dot(dir, north), dot(dir, east));
    float streamers =
      0.5 +
      0.5 * pow(abs(cos(around * 2.0 + 0.6)), 4.0) *
        (0.65 + 0.35 * cos(around * 5.0 + 1.3));
    vec3 corona =
      vec3(0.92, 0.95, 1.0) *
      (exp(-outside * 5.0) * 0.95 +
        pow(1.0 / max(r, 1.0), 2.2) * 1.5 * streamers) *
      total;

    float moon = 1.0 - smoothstep(moonSize - aa, moonSize + aa, fromMoon);
    // The Moon's near side is unlit: it only hides what is behind it.
    sky += (sunlight + glare + corona) * (1.0 - moon) * ahead * u_sunView;
  }
  // Facing the Moon: its disc, with the Earth's shadow across it.
  if (u_lunarView > 0.0) {
    vec3 toMoon = u_lunarMoon.xyz - u_cameraPosition;
    vec3 moonDir = normalize(toMoon);
    float size = u_lunarMoon.w / length(toMoon);
    vec3 east = normalize(cross(vec3(0.0, 0.0, 1.0), moonDir));
    vec3 north = cross(moonDir, east);
    // This pixel on the Moon's disc, in Moon radii.
    vec2 on = vec2(dot(dir, east), dot(dir, north)) / size;
    float rr = length(on);
    float aa = max(fwidth(rr), 1e-5);
    float disc =
      (1.0 - smoothstep(1.0 - aa, 1.0 + aa, rr)) * step(0.0, dot(dir, moonDir));
    float seas = mottle(on * 2.3 + 7.0) * 0.6 + mottle(on * 5.1) * 0.4;
    vec3 surface =
      vec3(0.9, 0.89, 0.84) *
      (0.72 + 0.28 * sqrt(max(1.0 - rr * rr, 0.0))) *
      (0.78 + 0.22 * seas);
    // The same pixel from the shadow's axis, in Earth radii.
    float from = length(u_lunarShadow.xy + on * u_lunarMoon.w);
    float penumbra = 1.0 - smoothstep(u_lunarShadow.z, u_lunarShadow.w, from);
    float umbra =
      1.0 - smoothstep(u_lunarShadow.z - 0.02, u_lunarShadow.z + 0.02, from);
    // Sunlight bent through the Earth's air reddens the umbra, darkest at
    // its centre.
    vec3 copper =
      vec3(0.62, 0.17, 0.07) *
      (0.3 + 0.7 * smoothstep(0.0, u_lunarShadow.z, from)) *
      (0.78 + 0.22 * seas);
    vec3 moonlit = mix(surface * (1.0 - 0.5 * penumbra), copper, umbra);
    sky = mix(sky, moonlit, disc * u_lunarView);
  }

  out_FragColor = vec4(mix(sky, ground, hit), color.a);
}
`;

const scaled = (source, factor, result) =>
  Cesium.Cartesian3.multiplyByScalar(source, factor, result);

/**
 * Own the shadow's post-process stage on one viewer. `show(frame)` draws the
 * shadow of that moment (see `shadowFrame`); `hide()` takes the stage out of
 * the frame, so an idle layer costs nothing.
 */
export function createEclipseShadow(
  viewer,
  { createStage = (options) => new Cesium.PostProcessStage(options) } = {},
) {
  const camera = viewer.camera;
  const position = new Cesium.Cartesian3();
  const right = new Cesium.Cartesian3();
  const up = new Cesium.Cartesian3();
  const axisOrigin = new Cesium.Cartesian3();
  const axisDirection = new Cesium.Cartesian3(0, 0, 1);
  const cones = new Cesium.Cartesian4();
  let skyShade = 0;
  const sun = new Cesium.Cartesian4();
  const moon = new Cesium.Cartesian4();
  let sunView = 0;
  let covered = 0;
  let lunar = 0;
  const lunarMoon = new Cesium.Cartesian4();
  const lunarShadow = new Cesium.Cartesian4();
  let lunarDepth = 0;
  let lunarView = 0;
  const halfHeight = () => Math.tan((camera.frustum.fovy ?? 1) / 2);
  const stage = createStage({
    name: 'gev_eclipse_shadow',
    fragmentShader: SHADOW_SHADER,
    uniforms: {
      u_cameraPosition: () =>
        scaled(camera.positionWC, 1 / EARTH_RADIUS_M, position),
      u_cameraDirection: () => camera.directionWC,
      u_cameraRight: () =>
        scaled(
          camera.rightWC,
          halfHeight() * (camera.frustum.aspectRatio ?? 1),
          right,
        ),
      u_cameraUp: () => scaled(camera.upWC, halfHeight(), up),
      u_axisOrigin: () => axisOrigin,
      u_axisDirection: () => axisDirection,
      u_cones: () => cones,
      u_skyShade: () => skyShade,
      u_sun: () => sun,
      u_moon: () => moon,
      u_sunView: () => sunView,
      u_covered: () => covered,
      u_lunar: () => lunar,
      u_lunarMoon: () => lunarMoon,
      u_lunarShadow: () => lunarShadow,
      u_lunarDepth: () => lunarDepth,
      u_lunarView: () => lunarView,
    },
  });
  stage.enabled = false;
  viewer.scene.postProcessStages.add(stage);

  return {
    /**
     * @param {object} frame The shadow at this moment.
     * @param {number} [sky] How dark the sky over the camera is, 0 to 1.
     * @param {{covered: number} | null} [facingSun] Set while the camera
     *   faces the Sun: the layer then draws the Sun and the Moon itself, with
     *   `covered` the share of the Sun hidden from where the camera stands.
     */
    show(frame, sky = 0, facingSun = null) {
      // The view ray is only built for a perspective camera on the globe.
      const drawable =
        viewer.scene.mode === Cesium.SceneMode.SCENE3D &&
        Number.isFinite(camera.frustum.fovy);
      stage.enabled = drawable;
      if (!drawable) return;
      Cesium.Cartesian3.fromArray(frame.origin, 0, axisOrigin);
      Cesium.Cartesian3.fromArray(frame.k, 0, axisDirection);
      cones.x = frame.l1;
      cones.y = frame.l2;
      cones.z = frame.tanF1;
      cones.w = frame.tanF2;
      skyShade = sky;
      const bodies = sunAndMoon(frame);
      Cesium.Cartesian4.fromArray(bodies.sun, 0, sun);
      Cesium.Cartesian4.fromArray(bodies.moon, 0, moon);
      sunView = facingSun ? 1 : 0;
      covered = facingSun?.covered ?? 0;
      lunar = 0;
      lunarView = 0;
    },
    /**
     * Draw a lunar eclipse instead: the half of the Earth with the Moon in
     * its sky, and the Moon itself while the camera faces it.
     * @param {{moon: number[], shadow: number[], depth: number,
     *   facing?: boolean}} shown `moon` is the Moon's centre and radius
     *   (Earth-fixed, radii); `shadow` its centre's offset from the Earth's
     *   shadow (east, north) and the umbra's and penumbra's radii; `depth`
     *   the share of its diameter in the umbra.
     */
    showLunar({ moon: body, shadow, depth, facing = false }) {
      const drawable =
        viewer.scene.mode === Cesium.SceneMode.SCENE3D &&
        Number.isFinite(camera.frustum.fovy);
      stage.enabled = drawable;
      if (!drawable) return;
      Cesium.Cartesian4.fromArray(body, 0, lunarMoon);
      Cesium.Cartesian4.fromArray(shadow, 0, lunarShadow);
      lunarDepth = depth;
      lunar = 1;
      lunarView = facing ? 1 : 0;
      skyShade = 0;
      sunView = 0;
    },
    hide() {
      stage.enabled = false;
    },
    isShown: () => stage.enabled,
    destroy() {
      const stages = viewer.scene?.postProcessStages;
      if (stages && !stages.isDestroyed?.()) stages.remove(stage);
    },
  };
}
