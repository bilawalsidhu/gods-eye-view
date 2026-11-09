// engine.imagery's screen pass on Navara: one public EffectDesc right after
// tone mapping, under every other surface pass (the remaining layer drapes,
// engine.ground) and before the sharpening, anti-aliasing and gev's
// overlays. Each pixel's world position comes from Navara's packed scene
// depth (terrain, 3D tiles); where that is the ground (not a mesh in front
// of it), up to MAX_IMAGERY_SLOTS layers are sampled in draw order at its
// longitude and latitude, each in its rectangle, on its side of the split:
// an image or a geographic atlas in longitude and latitude, a Web Mercator
// atlas in Web Mercator. A raised slot is sampled where the pixel's ray
// meets the ellipsoid grown by its height, wherever nothing of the scene
// is nearer (over 3D tiles and the sky's edge too). A slot followed by its
// detail draws nothing inside the detail's rectangle. Texels are blended
// in display space by their alpha times the layer's, as Cesium's globe
// blends imagery layers. Mip levels come from the derivatives of each
// slot's position, taken outside any divergent branch. Costs nothing while
// no layer is drawn (the effect is hidden).

import { DISPLAY_COLOR_GLSL, VIEW_POSITION_GLSL } from '../shaderChunks.js';
import { EffectDesc, Effect as NavaraEffect } from '@navaramap/three';
import { Effect, EffectAttribute } from 'postprocessing';
import { DataTexture, Matrix4, Uniform } from 'three';
import {
  groundSurfaceUniforms,
  updateGroundSurface,
} from '../ground/surface.js';
import { withFrameUpdates, withPassDisposal } from '../frameDescriptor.js';
import { MAX_IMAGERY_SLOTS } from './index.js';

const IMAGERY_EFFECT_KEY = 'gevImagery';

const SLOTS = Array.from({ length: MAX_IMAGERY_SLOTS }, (_, index) => index);

const fragmentShader = /* glsl */ `
uniform sampler2D tAllDepth;
uniform sampler2D tSurfaceDepth;
uniform mat4 uInverseProjection;
uniform mat4 uWorld;
uniform float uLogDepthFC;
uniform float uSplit;
${SLOTS.map(
  (i) => `uniform sampler2D tImage${i};
uniform vec4 uRect${i};
uniform vec4 uBounds${i};
uniform vec4 uLook${i};
uniform float uRaise${i};`,
).join('\n')}
${DISPLAY_COLOR_GLSL}
${VIEW_POSITION_GLSL}
// Geodetic longitude and latitude (Bowring) of a world point, degrees.
vec2 geodetic(vec3 point) {
  float p = length(point.xy);
  float theta = atan(point.z * 6378137.0, p * 6356752.314245);
  float st = sin(theta);
  float ct = cos(theta);
  float latitude = atan(point.z + 42841.311513 * st * st * st, p - 42697.672707 * ct * ct * ct);
  return vec2(atan(point.y, point.x), latitude) * 57.29577951308232;
}
vec2 mercator(vec2 geo) {
  float clamped = clamp(geo.y * 0.017453292519943295, -1.4844222297, 1.4844222297);
  return vec2((geo.x + 180.0) / 360.0,
    (1.0 - log(tan(0.7853981633974483 + clamped * 0.5)) / 3.141592653589793) / 2.0);
}
// Where the ray from the camera meets the ellipsoid grown by raise metres,
// in front of the scene (sceneRange along the ray); 0 when it does not.
float raised(float raise, vec3 origin, vec3 ray, float sceneRange, out vec2 geo) {
  vec3 radii = vec3(6378137.0, 6378137.0, 6356752.314245) + raise;
  vec3 o = origin / radii;
  vec3 d = ray / radii;
  float a = dot(d, d);
  float b = dot(o, d);
  float c = dot(o, o) - 1.0;
  float disc = b * b - a * c;
  float root = sqrt(max(disc, 0.0));
  float range = (-b - root) / a;
  if (range <= 0.0) range = (-b + root) / a;
  geo = geodetic(origin + max(range, 0.0) * ray);
  return step(0.0, disc) * step(1e-3, range) * step(range, sceneRange + 1.0);
}
bool inRect(vec2 geo, vec4 rect) {
  float lon = geo.x < rect.x ? geo.x + 360.0 : geo.x;
  return lon <= rect.z && geo.y >= rect.y && geo.y <= rect.w;
}
// One slot over the colour: rect is where it draws (degrees, east past
// west), bounds the image's extent (degrees) or the atlas's (Web Mercator
// x, y, width, height), look its alpha, side (-1 left, 1 right, 0 both),
// projection (1 Web Mercator) and whether the next slot is its detail
// (cut, that slot's rect: it draws nothing there).
vec3 paint(vec3 color, sampler2D image, vec4 rect, vec4 bounds, vec4 look, vec4 cut,
    vec2 geo, vec2 geoDx, vec2 geoDy, vec2 merc, vec2 mercDx, vec2 mercDy, float x, float drawn) {
  if (look.x <= 0.0 || drawn < 0.5) return color;
  if ((look.y < 0.0 && x > uSplit) || (look.y > 0.0 && x < uSplit)) return color;
  if (!inRect(geo, rect)) return color;
  if (look.w > 0.5 && inRect(geo, cut)) return color;
  vec2 at;
  vec2 dx;
  vec2 dy;
  if (look.z > 0.5) {
    vec2 m = vec2(merc.x < bounds.x ? merc.x + 1.0 : merc.x, merc.y);
    at = (m - bounds.xy) / bounds.zw;
    dx = mercDx / bounds.zw;
    dy = mercDy / bounds.zw;
  } else {
    vec2 span = vec2(bounds.z - bounds.x, bounds.y - bounds.w);
    float lon = geo.x < bounds.x ? geo.x + 360.0 : geo.x;
    at = vec2(lon - bounds.x, geo.y - bounds.w) / span;
    dx = geoDx / span;
    dy = geoDy / span;
  }
  if (any(lessThan(at, vec2(0.0))) || any(greaterThan(at, vec2(1.0)))) return color;
  vec4 texel = textureGrad(image, at, dx, dy);
  return mix(color, texel.rgb, texel.a * look.x);
}
// Derivatives of a position, the antimeridian's longitude step wrapped and
// none across the edge of what is drawn.
void derivatives(vec2 geo, vec2 merc, float drawn, out vec2 geoDx, out vec2 geoDy,
    out vec2 mercDx, out vec2 mercDy) {
  geoDx = dFdx(geo);
  geoDy = dFdy(geo);
  mercDx = dFdx(merc);
  mercDy = dFdy(merc);
  geoDx.x -= 360.0 * floor(geoDx.x / 360.0 + 0.5);
  geoDy.x -= 360.0 * floor(geoDy.x / 360.0 + 0.5);
  mercDx.x -= floor(mercDx.x + 0.5);
  mercDy.x -= floor(mercDy.x + 0.5);
  float edge = 1.0 - step(0.5, abs(dFdx(drawn)) + abs(dFdy(drawn)));
  geoDx *= edge;
  geoDy *= edge;
  mercDx *= edge;
  mercDy *= edge;
}
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  outputColor = inputColor;
  float depth = unpackRGBAToDepth(texture2D(tAllDepth, uv));
  float distance = viewDistance(depth, uLogDepthFC);
  vec4 ray = uInverseProjection * vec4(uv * 2.0 - 1.0, -1.0, 1.0);
  vec3 point = (uWorld * vec4(viewPosition(ray, distance), 1.0)).xyz;
  // The ground: the scene depth where it is the surface (the packed depth
  // also holds forward meshes, which are not ground).
  float ground = (1.0 - step(1.0, depth)) *
    step(texture2D(tSurfaceDepth, uv).r - 2e-7, depth);
  vec2 geo = geodetic(point);
  vec2 merc = mercator(geo);
  // Derivatives before any divergent branch.
  vec2 geoDx;
  vec2 geoDy;
  vec2 mercDx;
  vec2 mercDy;
  derivatives(geo, merc, ground, geoDx, geoDy, mercDx, mercDy);
  // A raised slot's ray, and the scene's range along it (the sky: none).
  vec3 origin = uWorld[3].xyz;
  vec3 direction = normalize(mat3(uWorld) * ray.xyz);
  float sceneRange = depth >= 1.0 ? 1.0e12 : distance * length(ray.xyz) / -ray.z;
  vec3 color = toDisplay(inputColor.rgb);
  vec3 start = color;
  ${SLOTS.map((i) => {
    const cut = i + 1 < SLOTS.length ? `uRect${i + 1}` : 'vec4(0.0)';
    return `{
    vec2 g = geo;
    vec2 m = merc;
    vec2 gx = geoDx;
    vec2 gy = geoDy;
    vec2 mx = mercDx;
    vec2 my = mercDy;
    float drawn = ground;
    // A uniform branch: the derivatives inside it are defined.
    if (uRaise${i} > 0.0) {
      drawn = raised(uRaise${i}, origin, direction, sceneRange, g);
      m = mercator(g);
      derivatives(g, m, drawn, gx, gy, mx, my);
    }
    color = paint(color, tImage${i}, uRect${i}, uBounds${i}, uLook${i}, ${cut}, g, gx, gy, m, mx, my, uv.x, drawn);
  }`;
  }).join('\n  ')}
  if (color != start) outputColor = vec4(toLinear(color), inputColor.a);
}
`;

class ImageryEffectDesc extends withPassDisposal(withFrameUpdates(EffectDesc)) {
  static key = IMAGERY_EFFECT_KEY;
  // Navara takes the first anchor that exists: right after tone mapping.
  static insertAfter = ['toneMapping'];
  static insertBefore = [
    'gevGroundPulses',
    'gevGround',
    'gevPreSharpenOverlay',
    'gevSharpen',
    'smaa',
    'fxaa',
    'gevOverlay',
    'final',
  ];

  constructor(view, ctx, config) {
    super(view, ctx, config);
    this.owner = config[IMAGERY_EFFECT_KEY].owner;
  }

  createPass() {
    const camera = this.view.camera.raw;
    if (!camera) throw new Error('Camera not available for the imagery pass');
    this.effect = new Effect('GevImagery', fragmentShader, {
      // Its own pass: inputColor is the tone-mapped frame.
      attributes: EffectAttribute.CONVOLUTION,
      uniforms: new Map([
        ...groundSurfaceUniforms(),
        ['uWorld', new Uniform(new Matrix4())],
        ['uSplit', new Uniform(0.5)],
        ...SLOTS.flatMap((i) => [
          [`tImage${i}`, new Uniform(null)],
          [`uRect${i}`, new Uniform([0, 0, 0, 0])],
          [`uBounds${i}`, new Uniform([0, 0, 1, 1])],
          [`uLook${i}`, new Uniform([0, 0, 0, 0])],
          [`uRaise${i}`, new Uniform(0)],
        ]),
      ]),
    });
    return new NavaraEffect(camera, this.effect);
  }

  updateFrame() {
    const camera = this.view.camera.raw;
    const owner = this.owner;
    if (!this.effect || !camera) return;
    const mrt = this.find('mrt');
    updateGroundSurface(this.effect, camera, this.ctx, mrt);
    const u = this.effect.uniforms;
    u.get('uWorld').value.copy(camera.matrixWorld);
    u.get('uSplit').value = owner.split;
    for (const i of SLOTS) {
      const slot = owner.slots[i];
      u.get(`tImage${i}`).value = slot?.texture ?? owner.empty;
      u.get(`uRect${i}`).value = slot?.rect ?? [0, 0, 0, 0];
      u.get(`uBounds${i}`).value = slot?.bounds ?? [0, 0, 1, 1];
      u.get(`uLook${i}`).value = slot?.look ?? [0, 0, 0, 0];
      u.get(`uRaise${i}`).value = slot?.raise ?? 0;
    }
  }
}

const registered = new WeakSet();

/**
 * The pass of one view: set(slots, split) draws up to MAX_IMAGERY_SLOTS
 * slots ({ texture, rect, bounds, look, raise }, bottom first; none: the
 * effect hidden) with the split at `split` (a fraction of the width from
 * the left). `raise` is the slot's shell height in metres (0: draped).
 */
export function createImageryPass(view) {
  if (!registered.has(view)) {
    view.registerEffect(IMAGERY_EFFECT_KEY, ImageryEffectDesc);
    registered.add(view);
  }
  const empty = new DataTexture(new Uint8Array(4), 1, 1);
  empty.needsUpdate = true;
  const owner = { slots: [], split: 0.5, empty };
  let handle = null;
  return {
    owner,
    set(slots, split) {
      owner.slots = slots.slice(0, MAX_IMAGERY_SLOTS);
      owner.split = split;
      const visible = owner.slots.length > 0;
      if (visible && !handle)
        handle = view.addEffect({
          [IMAGERY_EFFECT_KEY]: { owner },
          visible: true,
        });
      else handle?.update({ visible });
    },
    destroy() {
      handle?.delete();
      handle = null;
      owner.slots = [];
      empty.dispose();
    },
  };
}
