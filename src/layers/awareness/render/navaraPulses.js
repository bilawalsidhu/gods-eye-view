// The Global Context range pulses on Navara: the pulse disc the Cesium globe
// draws as a translucent ellipse primitive (rendering.js), drawn here over
// visible terrain and 3D tiles by one non-pickable classification pass.
// Each surface pixel's distance from the subject along the Earth sets where
// it lies within the range, and the same pulse lines, halos and inward band
// as Cesium's material are drawn there. Nothing above the surface is touched.
import { Effect, EffectAttribute } from 'postprocessing';
import { Matrix4, Uniform, Vector3, Vector4 } from 'three';
import {
  groundSurfaceUniforms,
  updateGroundSurface,
} from '../../shared/render/navaraGroundSurface.js';

const KEY = 'gevAwarenessPulses';
const registeredViews = new WeakSet();
const MEAN_EARTH_RADIUS_M = 6_371_000;

const fragmentShader = /* glsl */ `
uniform sampler2D tAllDepth;
uniform sampler2D tSurfaceDepth;
uniform mat4 uInverseProjection;
uniform mat4 uInverseView;
uniform float uLogDepthFC;
uniform vec3 uCenter;
uniform float uRadiusAngle;
uniform vec4 uColor;
uniform vec4 uLineColor;
uniform vec4 uHaloColor;
uniform vec4 uRadii;
uniform vec4 uAlphas;
uniform float uDepth;
uniform float uLineWidth;
uniform float uHaloWidth;
uniform float uPixelRatio;
vec3 toDisplay(vec3 c) {
  return mix(12.92*c,1.055*pow(max(c,vec3(0.0)),vec3(1.0/2.4))-0.055,step(vec3(0.0031308),c));
}
vec3 toLinear(vec3 c) {
  return mix(c/12.92,pow(max((c+0.055)/1.055,vec3(0.0)),vec3(2.4)),step(vec3(0.04045),c));
}
vec4 over(vec4 top, vec4 under) {
  float a = top.a + under.a * (1.0 - top.a);
  if (a <= 0.0) return vec4(0.0);
  return vec4((top.rgb * top.a + under.rgb * under.a * (1.0 - top.a)) / a, a);
}
void mainImage(const in vec4 inputColor,const in vec2 uv,out vec4 outputColor) {
  outputColor=inputColor;
  float depth=unpackRGBAToDepth(texture2D(tAllDepth,uv));
  float distance=exp2(2.0*depth/uLogDepthFC)-1.0;
  vec4 ray=uInverseProjection*vec4(uv*2.0-1.0,-1.0,1.0);
  vec3 point=ray.xyz*(distance/-ray.z);
  vec3 world=(uInverseView*vec4(point,1.0)).xyz;
  vec3 up=normalize(world);
  // The angle to the subject along the Earth, well conditioned near it too;
  // r is the fraction of the range, as the Cesium disc's texture radius.
  float r=atan(length(cross(up,uCenter)),dot(up,uCenter))/uRadiusAngle;
  // Change in r per CSS pixel, taken before any branch.
  float cssPx=max(length(vec2(dFdx(r),dFdy(r))),1e-7)*uPixelRatio;
  if(depth>=1.0||r>1.0) return;
  float surface=texture2D(tSurfaceDepth,uv).r;
  if(depth<surface-2e-7) return;
  float band=0.0;
  for(int i=0;i<4;i++) {
    float inside=uRadii[i]-r;
    if(inside>=0.0&&inside<=uDepth) {
      float t=1.0-inside/uDepth;
      band+=uAlphas[i]*t*t;
    }
  }
  vec4 result=vec4(uColor.rgb,clamp(band*uColor.a,0.0,1.0));
  float outerHalf=uLineWidth*0.5;
  float coreHalf=max(uLineWidth-uHaloWidth,0.0)*0.5;
  for(int i=0;i<4;i++) {
    float d=abs(uRadii[i]-r)/cssPx;
    float cover=clamp(outerHalf+0.5-d,0.0,1.0);
    if(cover<=0.0) continue;
    float core=clamp(coreHalf+0.5-d,0.0,1.0);
    vec4 pulse=mix(uHaloColor,uLineColor,core);
    result=over(vec4(pulse.rgb,pulse.a*cover*uAlphas[i]),result);
  }
  if(result.a<=0.0) return;
  vec3 color=mix(toDisplay(inputColor.rgb),result.rgb,result.a);
  outputColor=vec4(toLinear(color),inputColor.a);
}
`;

function pulseEffectClass(EffectDesc, NavaraEffect) {
  return class AwarenessPulseEffectDesc extends EffectDesc {
    static key = KEY;
    static insertAfter = [
      'gevEarthquakeGround',
      'gevObservedWeather',
      'gevNepalEvent',
      'gevRecentImagery',
      'gevFirmsHeat',
      'gevFirmsGround',
      'toneMapping',
    ];
    static insertBefore = [
      'gevPreSharpenOverlay',
      'gevSharpen',
      'smaa',
      'fxaa',
      'gevOverlay',
      'final',
    ];
    constructor(view, context, config) {
      super(view, context, config);
      this.owner = config[KEY].owner;
    }
    createPass() {
      this.effect = new Effect('GevAwarenessPulses', fragmentShader, {
        attributes: EffectAttribute.CONVOLUTION,
        uniforms: new Map([
          ...groundSurfaceUniforms(),
          ['uInverseView', new Uniform(new Matrix4())],
          ['uCenter', new Uniform(new Vector3(1, 0, 0))],
          ['uRadiusAngle', new Uniform(1)],
          ['uColor', new Uniform(new Vector4())],
          ['uLineColor', new Uniform(new Vector4())],
          ['uHaloColor', new Uniform(new Vector4())],
          ['uRadii', new Uniform(new Vector4())],
          ['uAlphas', new Uniform(new Vector4())],
          ['uDepth', new Uniform(0.35)],
          ['uLineWidth', new Uniform(3)],
          ['uHaloWidth', new Uniform(1)],
          ['uPixelRatio', new Uniform(1)],
        ]),
      });
      return new NavaraEffect(this.view.camera.raw, this.effect);
    }
    updateFrame() {
      const owner = this.owner,
        camera = this.view.camera.raw;
      if (!this.effect || !camera) return;
      updateGroundSurface(this.effect, camera, this.ctx, this.find('mrt'));
      const u = this.effect.uniforms;
      u.get('uInverseView').value.copy(camera.matrixWorld);
      u.get('uCenter').value.copy(owner.center);
      u.get('uRadiusAngle').value = owner.radiusAngle;
      u.get('uColor').value.fromArray(owner.color);
      u.get('uLineColor').value.fromArray(owner.lineColor);
      u.get('uHaloColor').value.fromArray(owner.haloColor);
      u.get('uRadii').value.fromArray(owner.radii);
      u.get('uAlphas').value.fromArray(owner.alphas);
      u.get('uDepth').value = owner.depth;
      u.get('uLineWidth').value = owner.lineWidth;
      u.get('uHaloWidth').value = owner.haloWidth;
      // Buffer pixels per CSS pixel: the pass can run above the canvas's
      // CSS size, and the pulse widths are in CSS pixels.
      const cssWidth = owner.cssWidth();
      u.get('uPixelRatio').value =
        cssWidth > 0
          ? this.ctx.getInputBuffer().width / cssWidth
          : globalThis.devicePixelRatio || 1;
    }
    onDestroy() {
      this.effect?.dispose();
      super.onDestroy();
    }
  };
}

/**
 * The pulse disc on one Navara view around `center` (Earth-fixed metres):
 * `draw({ radii, alphas, level })` each frame with the fronts as fractions of
 * `radiusM` and their opacities, `move(center)`, and `destroy()`. Colors are
 * rgba arrays in 0..1: the band, the pulse line and its halo.
 */
export function createAwarenessPulseDisc(
  engine,
  { view, EffectDesc, NavaraEffect },
  { center, radiusM, color, lineColor, haloColor, depth, lineWidth, haloWidth },
) {
  if (!registeredViews.has(view)) {
    view.registerEffect(KEY, pulseEffectClass(EffectDesc, NavaraEffect));
    registeredViews.add(view);
  }
  const owner = {
    cssWidth: () => engine.host?.canvas?.clientWidth ?? 0,
    center: new Vector3(),
    radiusAngle: radiusM / MEAN_EARTH_RADIUS_M,
    color,
    lineColor,
    haloColor,
    radii: [0, 0, 0, 0],
    alphas: [0, 0, 0, 0],
    depth,
    lineWidth,
    haloWidth,
  };
  let handle = null,
    shown = false,
    destroyed = false;
  const move = (next) => owner.center.set(next.x, next.y, next.z).normalize();
  move(center);
  return {
    move(next) {
      if (!destroyed) move(next);
    },
    draw({ radii, alphas, level }) {
      if (destroyed) return;
      for (let i = 0; i < 4; i++) {
        owner.radii[i] = radii[i] ?? 0;
        owner.alphas[i] = alphas[i] ?? 0;
      }
      const show = level > 0;
      if (show === shown) return;
      shown = show;
      if (!handle && show)
        handle = view.addEffect({ [KEY]: { owner }, visible: true });
      else handle?.update({ visible: show });
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      handle?.delete();
      handle = null;
      engine.render.request('awareness-pulses-destroy');
    },
  };
}
