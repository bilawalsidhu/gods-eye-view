/**
 * @module render/cesium/eclipseShadow
 * @description The Cesium draw port's `eclipseShadow` field: the Moon's
 * shadow on the Earth in a solar eclipse, or the half of the Earth with the
 * eclipsed Moon in its sky in a lunar one, drawn over the finished frame by
 * one full-screen `PostProcessStage`.
 *
 * Each pixel's view ray is met with the WGS84 ellipsoid, and the ground point
 * is tested against the two shadow cones: how far it lies from the shadow
 * axis, against the penumbra's and umbra's radii at its height. So the
 * shading is the eclipse itself, not a drawn shape: the penumbra darkens
 * toward the axis as more of the Sun is covered, the umbra is the dark core,
 * and both fall on terrain and 3D tiles alike. Moving the shadow is a few
 * numbers a frame; no geometry is rebuilt. The stage is off whenever there is
 * nothing to draw, so an idle field costs nothing.
 */
import * as Cesium from 'cesium';

/** The WGS84 equatorial radius: the field's lengths are in these. */
const EARTH_RADIUS_M = 6_378_137;

export const ECLIPSE_SHADOW_SHADER = /* glsl */ `
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
// A lunar eclipse: 1 while one is drawn, and the Moon's centre
// (Earth-fixed, radii) and radius.
uniform float u_lunar;
uniform vec4 u_lunarMoon;
// How much of the Moon's diameter is inside the umbra, 0 to 1.
uniform float u_lunarDepth;

const float POLAR_STRETCH = 1.0 / (1.0 - 1.0 / 298.257223563);
const vec3 TWILIGHT = vec3(0.74, 0.84, 1.12);
const vec3 HORIZON_GLOW = vec3(1.0, 0.56, 0.22);
const vec3 RING_OF_FIRE = vec3(1.0, 0.42, 0.08);

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

  out_FragColor = vec4(mix(sky, ground, hit), color.a);
}
`;

/** Whether `v` is a contract vector the shader can take. */
const finite3 = (v) => [v?.x, v?.y, v?.z].every(Number.isFinite);

const copy3 = ({ x, y, z }, out) => {
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
};

/**
 * One `eclipseShadow` field.
 * @param {{scene: object, spec: object, cesium?: object,
 *   createStage?: (options: object) => object, onDispose?: () => void}} options
 *   `spec.solar`: `{origin, axis, cones, skyShade}` (the axis's point and
 *   direction, `[l1, l2, tanF1, tanF2]`, and how dark the sky over the
 *   camera is, 0..1), or null. `spec.lunar`: `{moon, depth}` (the Moon's
 *   centre and radius, and the share of its diameter in the umbra), or null.
 *   Lengths are in Earth equatorial radii, Earth-fixed.
 */
export function createEclipseShadowField({
  scene,
  spec,
  cesium = Cesium,
  createStage = (options) => new cesium.PostProcessStage(options),
  onDispose = () => {},
}) {
  const camera = scene.camera;
  const position = new cesium.Cartesian3();
  const right = new cesium.Cartesian3();
  const up = new cesium.Cartesian3();
  const axisOrigin = new cesium.Cartesian3();
  const axisDirection = new cesium.Cartesian3(0, 0, 1);
  const cones = new cesium.Cartesian4();
  const lunarMoon = new cesium.Cartesian4();
  let skyShade = 0;
  let lunar = 0;
  let lunarDepth = 0;
  let solarState = null;
  let lunarState = null;
  let shown = spec.show !== false;
  let disposed = false;
  const drawnListeners = new Set();
  let drawnOwed = false;
  const halfHeight = () => Math.tan((camera.frustum.fovy ?? 1) / 2);
  const scaled = (source, factor, result) =>
    cesium.Cartesian3.multiplyByScalar(source, factor, result);
  const stage = createStage({
    name: `gev_eclipse_shadow_${spec.id}`,
    fragmentShader: ECLIPSE_SHADOW_SHADER,
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
      u_lunar: () => lunar,
      u_lunarMoon: () => lunarMoon,
      u_lunarDepth: () => lunarDepth,
    },
  });
  stage.enabled = false;
  scene.postProcessStages.add(stage);

  const removePostRender = scene.postRender?.addEventListener?.(() => {
    if (!drawnOwed || !stage.enabled) return;
    drawnOwed = false;
    for (const cb of [...drawnListeners]) cb();
  });

  function apply() {
    // The view ray is only built for a perspective camera on the globe.
    const drawable =
      shown &&
      Boolean(solarState || lunarState) &&
      scene.mode === cesium.SceneMode.SCENE3D &&
      Number.isFinite(camera.frustum?.fovy);
    stage.enabled = drawable;
    if (solarState) {
      copy3(solarState.origin, axisOrigin);
      copy3(solarState.axis, axisDirection);
      [cones.x, cones.y, cones.z, cones.w] = solarState.cones;
      skyShade = solarState.skyShade ?? 0;
      lunar = 0;
    } else if (lunarState) {
      [lunarMoon.x, lunarMoon.y, lunarMoon.z, lunarMoon.w] = lunarState.moon;
      lunarDepth = Math.max(0, Math.min(1, lunarState.depth ?? 0));
      lunar = 1;
      skyShade = 0;
    }
    drawnOwed = drawable;
    if (!scene.isDestroyed?.()) scene.requestRender();
  }

  function take(patch) {
    if (patch.kind !== undefined && patch.kind !== 'eclipseShadow')
      throw new TypeError('a field keeps its kind');
    // Checked before it is kept: a value the shader cannot take would stop
    // every frame after it.
    if (
      patch.solar &&
      !(finite3(patch.solar.origin) && finite3(patch.solar.axis))
    )
      throw new TypeError('an eclipse shadow needs finite x, y and z');
    if ('solar' in patch) solarState = patch.solar ?? null;
    if ('lunar' in patch) lunarState = patch.lunar ?? null;
    if (solarState && lunarState) lunarState = null;
  }

  take(spec);
  apply();

  return {
    id: spec.id,
    get show() {
      return shown;
    },
    set show(value) {
      const next = Boolean(value);
      if (disposed || next === shown) return;
      shown = next;
      apply();
    },
    update(patch = {}) {
      if (disposed) return;
      take(patch);
      if (patch.show !== undefined) shown = patch.show !== false;
      apply();
    },
    on(event, cb) {
      if (event !== 'drawn' || typeof cb !== 'function') return () => {};
      drawnListeners.add(cb);
      return () => drawnListeners.delete(cb);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      removePostRender?.();
      drawnListeners.clear();
      const stages = scene.postProcessStages;
      if (stages && !stages.isDestroyed?.()) stages.remove(stage);
      onDispose();
    },
  };
}
