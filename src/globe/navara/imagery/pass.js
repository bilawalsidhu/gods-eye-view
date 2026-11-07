// engine.imagery's screen pass on Navara: one public EffectDesc right after
// tone mapping, under every other surface pass (the remaining layer drapes,
// engine.ground) and before the sharpening, anti-aliasing and gev's
// overlays. Each pixel's world position comes from Navara's packed scene
// depth (terrain, 3D tiles); where that is the ground (not a mesh in front
// of it), up to MAX_IMAGERY_SLOTS layers are sampled in draw order at its
// longitude and latitude, each in its rectangle, on its side of the split:
// an image in longitude and latitude, a tile atlas in Web Mercator. Texels
// are blended in display space by their alpha times the layer's, as
// Cesium's globe blends imagery layers. Mip levels come from the
// derivatives of the ground position, taken before any branch. Costs
// nothing while no layer is drawn (the effect is hidden).

import { EffectDesc, Effect as NavaraEffect } from '@navaramap/three';
import { Effect, EffectAttribute } from 'postprocessing';
import { DataTexture, Matrix4, RGBADepthPacking, Uniform } from 'three';
import { withFrameUpdates, withPassDisposal } from '../frameDescriptor.js';
import { MAX_IMAGERY_SLOTS } from './index.js';

export const IMAGERY_EFFECT_KEY = 'gevImagery';

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
uniform vec4 uLook${i};`,
).join('\n')}
vec3 toDisplay(vec3 c) {
  return mix(12.92*c,1.055*pow(max(c,vec3(0.0)),vec3(1.0/2.4))-0.055,step(vec3(0.0031308),c));
}
vec3 toLinear(vec3 c) {
  return mix(c/12.92,pow(max((c+0.055)/1.055,vec3(0.0)),vec3(2.4)),step(vec3(0.04045),c));
}
// One layer over the colour: rect is where it draws (degrees, east past
// west), bounds the image's extent (degrees) or the atlas's (Web Mercator
// x, y, width, height), look its alpha, side (-1 left, 1 right, 0 both)
// and projection (1 Web Mercator).
vec3 paint(vec3 color, sampler2D image, vec4 rect, vec4 bounds, vec4 look,
    vec2 geo, vec2 geoDx, vec2 geoDy, vec2 merc, vec2 mercDx, vec2 mercDy, float x) {
  if (look.x <= 0.0) return color;
  if ((look.y < 0.0 && x > uSplit) || (look.y > 0.0 && x < uSplit)) return color;
  float lon = geo.x < rect.x ? geo.x + 360.0 : geo.x;
  if (lon > rect.z || geo.y < rect.y || geo.y > rect.w) return color;
  vec2 at;
  vec2 dx;
  vec2 dy;
  if (look.z > 0.5) {
    vec2 m = vec2(merc.x + (lon - geo.x) / 360.0, merc.y);
    at = (m - bounds.xy) / bounds.zw;
    dx = mercDx / bounds.zw;
    dy = mercDy / bounds.zw;
  } else {
    vec2 span = vec2(bounds.z - bounds.x, bounds.y - bounds.w);
    at = vec2(lon - bounds.x, geo.y - bounds.w) / span;
    dx = geoDx / span;
    dy = geoDy / span;
  }
  if (any(lessThan(at, vec2(0.0))) || any(greaterThan(at, vec2(1.0)))) return color;
  vec4 texel = textureGrad(image, at, dx, dy);
  return mix(color, texel.rgb, texel.a * look.x);
}
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  outputColor = inputColor;
  float depth = unpackRGBAToDepth(texture2D(tAllDepth, uv));
  float distance = exp2(2.0 * depth / uLogDepthFC) - 1.0;
  vec4 ray = uInverseProjection * vec4(uv * 2.0 - 1.0, -1.0, 1.0);
  vec3 point = (uWorld * vec4(ray.xyz * (distance / -ray.z), 1.0)).xyz;
  // Geodetic longitude and latitude (Bowring), degrees.
  float p = length(point.xy);
  float theta = atan(point.z * 6378137.0, p * 6356752.314245);
  float st = sin(theta);
  float ct = cos(theta);
  float latitude = atan(point.z + 42841.311513 * st * st * st, p - 42697.672707 * ct * ct * ct);
  vec2 geo = vec2(atan(point.y, point.x), latitude) * 57.29577951308232;
  float clamped = clamp(latitude, -1.4844222297, 1.4844222297);
  vec2 merc = vec2((geo.x + 180.0) / 360.0,
    (1.0 - log(tan(0.7853981633974483 + clamped * 0.5)) / 3.141592653589793) / 2.0);
  // Derivatives before any divergent branch; across the antimeridian a
  // longitude step wraps; across the sky's edge there is none.
  vec2 geoDx = dFdx(geo);
  vec2 geoDy = dFdy(geo);
  vec2 mercDx = dFdx(merc);
  vec2 mercDy = dFdy(merc);
  geoDx.x -= 360.0 * floor(geoDx.x / 360.0 + 0.5);
  geoDy.x -= 360.0 * floor(geoDy.x / 360.0 + 0.5);
  mercDx.x -= floor(mercDx.x + 0.5);
  mercDy.x -= floor(mercDy.x + 0.5);
  float onSurface = 1.0 - step(1.0, depth);
  float edge = 1.0 - step(0.5, abs(dFdx(onSurface)) + abs(dFdy(onSurface)));
  geoDx *= edge;
  geoDy *= edge;
  mercDx *= edge;
  mercDy *= edge;
  if (depth >= 1.0) return;
  // The packed depth also holds forward meshes, which are not ground.
  if (depth < texture2D(tSurfaceDepth, uv).r - 2e-7) return;
  vec3 color = toDisplay(inputColor.rgb);
  ${SLOTS.map(
    (i) =>
      `color = paint(color, tImage${i}, uRect${i}, uBounds${i}, uLook${i}, geo, geoDx, geoDy, merc, mercDx, mercDy, uv.x);`,
  ).join('\n  ')}
  outputColor = vec4(toLinear(color), inputColor.a);
}
`;

class ImageryEffectDesc extends withPassDisposal(withFrameUpdates(EffectDesc)) {
  static key = IMAGERY_EFFECT_KEY;
  // Navara takes the first anchor that exists: right after tone mapping.
  static insertAfter = ['toneMapping'];
  static insertBefore = [
    'gevNepalEvent',
    'gevObservedWeather',
    'gevEarthquakeGround',
    'gevAwarenessPulses',
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
        ['tAllDepth', new Uniform(null)],
        ['tSurfaceDepth', new Uniform(null)],
        ['uInverseProjection', new Uniform(new Matrix4())],
        ['uWorld', new Uniform(new Matrix4())],
        ['uLogDepthFC', new Uniform(1)],
        ['uSplit', new Uniform(0.5)],
        ...SLOTS.flatMap((i) => [
          [`tImage${i}`, new Uniform(null)],
          [`uRect${i}`, new Uniform([0, 0, 0, 0])],
          [`uBounds${i}`, new Uniform([0, 0, 1, 1])],
          [`uLook${i}`, new Uniform([0, 0, 0, 0])],
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
    if (mrt?.depthBufferPacking !== RGBADepthPacking)
      throw new Error('The imagery pass needs packed scene depth');
    const u = this.effect.uniforms;
    u.get('tAllDepth').value = mrt.depthBuffer;
    u.get('tSurfaceDepth').value = this.ctx.getRenderTarget().depthTexture;
    u.get('uInverseProjection').value.copy(camera.projectionMatrixInverse);
    u.get('uWorld').value.copy(camera.matrixWorld);
    u.get('uLogDepthFC').value = 2 / Math.log2(camera.far + 1);
    u.get('uSplit').value = owner.split;
    for (const i of SLOTS) {
      const slot = owner.slots[i];
      u.get(`tImage${i}`).value = slot?.texture ?? owner.empty;
      u.get(`uRect${i}`).value = slot?.rect ?? [0, 0, 0, 0];
      u.get(`uBounds${i}`).value = slot?.bounds ?? [0, 0, 1, 1];
      u.get(`uLook${i}`).value = slot?.look ?? [0, 0, 0, 0];
    }
  }
}

const registered = new WeakSet();

/**
 * The pass of one view: set(slots, split) draws up to MAX_IMAGERY_SLOTS
 * layers ({ texture, rect, bounds, look }, bottom first; none: the effect
 * hidden) with the split at `split` (a fraction of the width from the left).
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
