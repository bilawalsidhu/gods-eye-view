// The Active Fires far-zoom heatmap on Navara: the same equirectangular heat
// raster the Cesium globe drapes as imagery (firmsHeatRaster.js), drawn over
// visible terrain and 3D tiles by one non-pickable classification pass. Only
// surface pixels take it, so the fire markers above stay untouched. The
// adapter has heatImagery.js's interface, so the layer drives both alike.
import {
  DataTexture,
  LinearFilter,
  Matrix4,
  RGBAFormat,
  RepeatWrapping,
  ClampToEdgeWrapping,
  Uniform,
  UnsignedByteType,
} from 'three';
import {
  groundSurfaceUniforms,
  updateGroundSurface,
} from '../../shared/render/navaraGroundSurface.js';
import { defineGroundEffect } from '../../shared/render/navaraGroundEffect.js';

const KEY = 'gevFirmsHeat';

// Row 0 of the raster is the north edge and column 0 is 180°W; the texture
// keeps that order (no flip), so v = 0 is north.
const fragmentShader = /* glsl */ `
uniform sampler2D tAllDepth;
uniform sampler2D tSurfaceDepth;
uniform sampler2D tHeat;
uniform mat4 uInverseProjection;
uniform mat4 uInverseView;
uniform float uLogDepthFC;
uniform float uOpacity;
// WGS84 first eccentricity squared: geodetic latitude of a near-surface point.
const float E2=0.0066943799901413165;
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
  float surface=texture2D(tSurfaceDepth,uv).r;
  if(depth<surface-2e-7) return;
  float distance=exp2(2.0*depth/uLogDepthFC)-1.0;
  vec4 ray=uInverseProjection*vec4(uv*2.0-1.0,-1.0,1.0);
  vec3 point=ray.xyz*(distance/-ray.z);
  vec3 world=(uInverseView*vec4(point,1.0)).xyz;
  float rho=length(world.xy);
  float longitude=atan(world.y,world.x);
  float latitude=atan(world.z,rho*(1.0-E2));
  // PI comes from three.js's shader chunks.
  vec2 st=vec2(longitude/(2.0*PI)+0.5,0.5-latitude/PI);
  vec4 heat=texture2D(tHeat,st);
  float alpha=heat.a*uOpacity;
  if(alpha<=0.0) return;
  vec3 color=mix(toDisplay(inputColor.rgb),heat.rgb,alpha);
  outputColor=vec4(toLinear(color),inputColor.a);
}
`;

const heatEffect = defineGroundEffect({
  key: KEY,
  name: 'GevFirmsHeat',
  fragmentShader,
  // Under the heat cells' and markers' place in the chain: after the other
  // surface drapes, before sharpening, anti-aliasing and overlays.
  insertAfter: [
    'gevEarthquakeGround',
    'gevObservedWeather',
    'gevNepalEvent',
    'gevRecentImagery',
    'toneMapping',
  ],
  insertBefore: [
    'gevFirmsGround',
    'gevPreSharpenOverlay',
    'gevSharpen',
    'smaa',
    'fxaa',
    'gevOverlay',
    'final',
  ],
  uniforms: () => [
    ...groundSurfaceUniforms(),
    ['tHeat', new Uniform(null)],
    ['uOpacity', new Uniform(1)],
    ['uInverseView', new Uniform(new Matrix4())],
  ],
  update() {
    const owner = this.owner,
      camera = this.view.camera.raw;
    if (!this.effect || !owner.texture || !camera) return;
    updateGroundSurface(this.effect, camera, this.ctx, this.find('mrt'));
    const u = this.effect.uniforms;
    u.get('tHeat').value = owner.texture;
    u.get('uOpacity').value = owner.opacity;
    u.get('uInverseView').value.copy(camera.matrixWorld);
  },
});

/**
 * The raster as a texture: linear between pixels, wrapping across 180°. Its
 * sRGB bytes are read as they are and blended in display space, as the heat
 * cells' colors are.
 */
function heatTexture(raster) {
  const texture = new DataTexture(
    raster.rgba,
    raster.width,
    raster.height,
    RGBAFormat,
    UnsignedByteType,
  );
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

/**
 * The heatmap drape on one Navara view, with heatImagery.js's interface:
 * setRaster, hasRaster, setShow, setOpacity (the hand-off fade), rehome and
 * destroy. Drawn only while shown, painted and above zero opacity.
 */
export function createFirmsHeatDrape(
  engine,
  { view, EffectDesc, NavaraEffect },
) {
  heatEffect.register(view, { EffectDesc, NavaraEffect });
  const owner = { texture: null, opacity: 1 };
  let raster = null,
    show = true,
    handle = null,
    destroyed = false;
  function sync() {
    if (destroyed) return;
    const visible = Boolean(owner.texture && show && owner.opacity > 0);
    if (!handle && visible)
      handle = view.addEffect({ [KEY]: { owner }, visible: true });
    else handle?.update({ visible });
    engine.render.request('firms-heat');
  }
  return {
    setRaster(next) {
      if (destroyed) return;
      raster = next;
      owner.texture?.dispose();
      owner.texture = next ? heatTexture(next) : null;
      sync();
    },
    /** True once a raster was handed over. */
    hasRaster() {
      return raster !== null;
    },
    setShow(value) {
      show = Boolean(value);
      sync();
    },
    /** Hand-off fade, 0..1. */
    setOpacity(value) {
      owner.opacity = Math.min(1, Math.max(0, Number(value) || 0));
      sync();
    },
    /** Navara drapes on its own surface; there is no imagery host to follow. */
    rehome() {},
    destroy() {
      if (destroyed) return;
      destroyed = true;
      handle?.delete();
      handle = null;
      owner.texture?.dispose();
      owner.texture = null;
      raster = null;
      engine.render.request('firms-heat-destroy');
    },
  };
}
