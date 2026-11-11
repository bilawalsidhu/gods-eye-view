// The Cyber HUD's contact sonar on Navara (render.setContactSonar): the
// sweep's treatment of contacts, drawn by the sprite and point movers'
// shaders (movers/moverMesh.js) from uniforms every overlay of a view
// shares. The rings and the sweep itself are the HUD's own (CSS,
// src/cyberSonar.js); this is the contact side, the counterpart of the
// Cesium command adapter (src/globe/cesium/sonarCommands.js), with the same
// maths: each contact's factor from its anchor's place on screen against
// the sweep (the sampler of src/cyberSonar.js createCyberSonarSampler), its
// colour pulled toward the scanner tint by that factor and its alpha scaled
// by it.
// Positions, picks and the instance data stay as the layers set them.
// Models apply the same treatment after lighting (movers/modelTint.js).

const views = new WeakMap();

/**
 * The sonar uniforms of a view, one object for all its overlays (overlay.js
 * spreads them into each overlay's uniforms):
 * - uGevSonar: angle (deg, clockwise from screen up), range (fraction of
 *   the keyhole radius min(0.4 width, 0.52 height)), opacity floor (0..1),
 *   sweep on (1) or off (0);
 * - uGevSonarSector: the sector's width (deg);
 * - uGevSonarEnabled: 1 while the Cyber contact treatment applies.
 */
export function sonarUniformsFor(view) {
  let uniforms = views.get(view);
  if (!uniforms) {
    uniforms = {
      uGevSonar: { value: [0, 1, 0.84, 0] },
      uGevSonarSector: { value: 24 },
      uGevSonarEnabled: { value: 0 },
    };
    views.set(view, uniforms);
  }
  return uniforms;
}

/** Sonar uniforms of a mesh drawn outside an overlay (tests): off. */
export const DETACHED_SONAR = Object.freeze({
  uGevSonar: { value: [0, 1, 0.84, 0] },
  uGevSonarSector: { value: 24 },
  uGevSonarEnabled: { value: 0 },
});

/**
 * Vertex declarations and gevSonarFactor(anchor, resolution): the factor of
 * a contact whose anchor is at clip position `anchor`, in a target of
 * `resolution` pixels; 1 when the treatment is off.
 */
export const SONAR_VERTEX = /* glsl */ `
uniform vec4 uGevSonar;
uniform float uGevSonarSector;
uniform float uGevSonarEnabled;
float gevSonarFactor(vec4 anchor, vec2 resolution) {
  if (uGevSonarEnabled < 0.5) return 1.0;
  float floorValue = uGevSonar.z;
  if (uGevSonar.w < 0.5) return floorValue + (1.0 - floorValue) * 0.46;
  // Invalid projections fail open, as the CPU sampler does.
  if (anchor.w <= 0.0 || resolution.x < 1.0 || resolution.y < 1.0) return 1.0;
  vec2 pixel = anchor.xy / anchor.w * resolution * 0.5;
  float radius = min(resolution.x * 0.4, resolution.y * 0.52) * uGevSonar.y;
  float distanceSquared = dot(pixel, pixel);
  float radiusSquared = radius * radius;
  if (distanceSquared > radiusSquared) return floorValue;
  if (distanceSquared < radiusSquared * 0.000625) return 1.0;
  float delta = mod(degrees(atan(pixel.x, pixel.y)) - uGevSonar.x + 360.0, 360.0);
  if (delta > 359.9999) delta = 0.0;
  if (delta > uGevSonarSector) return floorValue;
  float feather = min(10.0, uGevSonarSector * 0.42);
  return floorValue + (1.0 - floorValue) * min(1.0, (uGevSonarSector - delta) / feather);
}
vec4 gevSonarColor(vec4 color, float factor) {
  if (uGevSonarEnabled < 0.5) return color;
  float floorValue = uGevSonar.z;
  float coverage = floorValue >= 0.9999 ? 1.0 : clamp((factor - floorValue) / (1.0 - floorValue), 0.0, 1.0);
  vec3 tint = color.rgb * 0.28 + (vec3(0.62, 0.68, 0.72) + vec3(0.38, 0.16, 0.12) * coverage) * 0.72;
  return vec4(tint, color.a * factor);
}
`;

/**
 * gevSonarFactor in JS, line for line (tests hold it to the CPU sampler of
 * src/cyberSonar.js): `x`, `y` CSS pixels from the top-left of a
 * `width` × `height` view; `state` as render.setContactSonar takes it.
 */
export function sonarFactorAt(x, y, width, height, state) {
  if (!state.enabled) return 1;
  const floor = state.opacity / 100;
  if (!state.active) return floor + (1 - floor) * 0.46;
  if (![x, y].every(Number.isFinite) || width < 1 || height < 1) return 1;
  // Screen up is +y here, as in clip space.
  const px = x - width / 2;
  const py = height / 2 - y;
  const radius = (Math.min(width * 0.4, height * 0.52) * state.range) / 100;
  const distanceSquared = px * px + py * py;
  const radiusSquared = radius * radius;
  if (distanceSquared > radiusSquared) return floor;
  if (distanceSquared < radiusSquared * 0.000625) return 1;
  let delta =
    ((((Math.atan2(px, py) * 180) / Math.PI - state.angleDeg + 360) % 360) +
      360) %
    360;
  if (delta > 359.9999) delta = 0;
  if (delta > state.sector) return floor;
  const feather = Math.min(10, state.sector * 0.42);
  return floor + (1 - floor) * Math.min(1, (state.sector - delta) / feather);
}

/**
 * The sonar port createNavaraEngine takes: `set(state)` (already checked)
 * writes the view's sonar uniforms; `destroy()` turns the treatment off.
 * @param {object} view an initialised ThreeView
 */
export function createNavaraSonar(view) {
  const uniforms = sonarUniformsFor(view);
  return {
    set({ enabled, active, angleDeg, range, opacity, sector }) {
      const sonar = uniforms.uGevSonar.value;
      sonar[0] = angleDeg;
      sonar[1] = range / 100;
      sonar[2] = opacity / 100;
      sonar[3] = active ? 1 : 0;
      uniforms.uGevSonarSector.value = sector;
      uniforms.uGevSonarEnabled.value = enabled ? 1 : 0;
    },
    destroy() {
      uniforms.uGevSonarEnabled.value = 0;
    },
  };
}
