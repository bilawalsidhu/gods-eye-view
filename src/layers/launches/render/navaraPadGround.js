// The launch pad zone on Navara, classified onto the surface as Cesium's
// GroundPrimitive does (render/cesium.js): a screen-space pass reads the depth
// of each pixel, puts it back in the world and paints the pixels of the
// ground (terrain or 3D tiles, not a model in front of them) that lie within
// the zone's radius of the pad, with Cesium's fill, rim and emission. Nothing
// is drawn at a height, so the zone neither floats over nor sinks under the
// ground, and no height is sampled.
import { Matrix3, Uniform, Vector3 } from 'three';
import * as geo from '../../../geo/index.js';
import {
  groundSurfaceUniforms,
  updateGroundSurface,
} from '../../shared/render/navaraGroundSurface.js';
import { defineGroundEffect } from '../../shared/render/navaraGroundEffect.js';
import { rgbaFromCss } from '../../shared/color.js';
import { LAUNCH_PAD_ZONE_RADIUS_M, LAUNCH_PAD_ZONE_STYLE } from '../policy.js';

export const PAD_GROUND_KEY = 'gevLaunchPadGround';
// The surface above or below the pad that the zone still classifies, as
// Cesium's classification volume spans the terrain heights there.
const PAD_GROUND_BAND_M = 9000;
const glslFloat = (value) => Number(value).toFixed(4);

export const padGroundShader = /* glsl */ `
uniform sampler2D tAllDepth;
uniform sampler2D tSurfaceDepth;
uniform mat4 uInverseProjection;
uniform float uLogDepthFC;
uniform mat3 uViewToWorld;
uniform vec3 uPadOffset;
uniform vec3 uEast;
uniform vec3 uNorth;
uniform vec3 uUp;
uniform vec3 uPadColor;
vec3 toDisplay(vec3 c) {
  return mix(12.92*c,1.055*pow(max(c,vec3(0.0)),vec3(1.0/2.4))-0.055,step(vec3(0.0031308),c));
}
vec3 toLinear(vec3 c) {
  return mix(c/12.92,pow(max((c+0.055)/1.055,vec3(0.0)),vec3(2.4)),step(vec3(0.04045),c));
}
void mainImage(const in vec4 inputColor,const in vec2 uv,out vec4 outputColor) {
  outputColor=inputColor;
  float depth=unpackRGBAToDepth(texture2D(tAllDepth,uv));
  if(depth>=1.0) return;
  // Only the ground: a mesh or model in front of it keeps its own colour.
  float surface=texture2D(tSurfaceDepth,uv).r;
  if(depth<surface-2e-7) return;
  float distance=exp2(2.0*depth/uLogDepthFC)-1.0;
  vec4 ray=uInverseProjection*vec4(uv*2.0-1.0,-1.0,1.0);
  vec3 point=ray.xyz*(distance/-ray.z);
  // Relative to the pad, from offsets small enough for single precision.
  vec3 rel=uViewToWorld*point-uPadOffset;
  if(abs(dot(rel,uUp))>${glslFloat(PAD_GROUND_BAND_M)}) return;
  float radius=length(vec2(dot(rel,uEast),dot(rel,uNorth)))/${glslFloat(LAUNCH_PAD_ZONE_RADIUS_M)};
  if(radius>=1.0) return;
  // Cesium's GevLaunchPadZone material, blended as in its framebuffer.
  float inside=1.0-smoothstep(${glslFloat(LAUNCH_PAD_ZONE_STYLE.rimEnd)},1.0,radius);
  float rim=smoothstep(${glslFloat(LAUNCH_PAD_ZONE_STYLE.rimStart)},${glslFloat(LAUNCH_PAD_ZONE_STYLE.rimEnd)},radius)*inside;
  float alpha=inside*mix(${glslFloat(LAUNCH_PAD_ZONE_STYLE.fillAlpha)},${glslFloat(LAUNCH_PAD_ZONE_STYLE.rimAlpha)},rim);
  vec3 color=min(uPadColor*(1.0+${glslFloat(LAUNCH_PAD_ZONE_STYLE.emission)}*rim),vec3(1.0));
  outputColor=vec4(toLinear(mix(toDisplay(inputColor.rgb),color,alpha)),inputColor.a);
}
`;

/** The pad's ECEF position and its east, north and up axes. */
function padFrame(launch) {
  const m = geo.transforms.eastNorthUpToFixedFrame(
    geo.cartesian3.fromDegrees(launch.lon, launch.lat, 0),
    geo.ellipsoid.WGS84,
  );
  return {
    origin: [m[12], m[13], m[14]],
    east: [m[0], m[1], m[2]],
    north: [m[4], m[5], m[6]],
    up: [m[8], m[9], m[10]],
  };
}

const padGroundEffect = defineGroundEffect({
  key: PAD_GROUND_KEY,
  name: 'GevLaunchPadGround',
  fragmentShader: padGroundShader,
  insertAfter: [
    'gevEarthquakeGround',
    'gevObservedWeather',
    'gevNepalEvent',
    'gevRecentImagery',
    'gevFirmsGround',
    'toneMapping',
  ],
  insertBefore: [
    'gevPreSharpenOverlay',
    'gevSharpen',
    'smaa',
    'fxaa',
    'gevOverlay',
    'final',
  ],
  uniforms: () => [
    ...groundSurfaceUniforms(),
    ['uViewToWorld', new Uniform(new Matrix3())],
    ['uPadOffset', new Uniform(new Vector3())],
    ['uEast', new Uniform(new Vector3())],
    ['uNorth', new Uniform(new Vector3())],
    ['uUp', new Uniform(new Vector3())],
    [
      'uPadColor',
      // Display (sRGB) values, as Cesium's material reads the colour.
      new Uniform(
        new Vector3(...rgbaFromCss(LAUNCH_PAD_ZONE_STYLE.color).rgba()),
      ),
    ],
  ],
  update() {
    const frame = this.owner.frame,
      camera = this.view.camera.raw;
    if (!this.effect || !frame || !camera) return;
    updateGroundSurface(this.effect, camera, this.ctx, this.find('mrt'));
    const u = this.effect.uniforms;
    u.get('uViewToWorld').value.setFromMatrix4(camera.matrixWorld);
    const e = camera.matrixWorld.elements;
    u.get('uPadOffset').value.set(
      frame.origin[0] - e[12],
      frame.origin[1] - e[13],
      frame.origin[2] - e[14],
    );
    u.get('uEast').value.fromArray(frame.east);
    u.get('uNorth').value.fromArray(frame.north);
    u.get('uUp').value.fromArray(frame.up);
  },
});

/**
 * Show one pad zone on a Navara view; `show` toggles it, `destroy` removes it.
 * @param {object} view The Navara view.
 * @param {{ EffectDesc: Function, NavaraEffect: Function }} sdk
 * @param {{ lon: number, lat: number }} launch
 */
export function createPadGround(view, { EffectDesc, NavaraEffect }, launch) {
  padGroundEffect.register(view, { EffectDesc, NavaraEffect });
  const owner = { frame: padFrame(launch) };
  let handle = view.addEffect({
    [PAD_GROUND_KEY]: { owner },
    visible: true,
  });
  return {
    owner,
    set visible(value) {
      handle?.update({ visible: Boolean(value) });
    },
    destroy() {
      handle?.delete();
      handle = null;
      owner.frame = null;
    },
  };
}
