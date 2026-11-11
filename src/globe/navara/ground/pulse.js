// Ground pulse fields over the visible globe, after tone mapping.
import { DISPLAY_COLOR_GLSL, VIEW_POSITION_GLSL } from '../shaderChunks.js';
import { Matrix4, Uniform, Vector3, Vector4 } from 'three';
import { groundSurfaceUniforms, updateGroundSurface } from './surface.js';
import { EffectDesc, Effect as NavaraEffect } from '@navaramap/three';
import { Effect, EffectAttribute } from 'postprocessing';
import { withFrameUpdates, withPassDisposal } from '../frameDescriptor.js';

const KEY = 'gevGroundPulses';

const fragmentShader = /* glsl */ `
uniform sampler2D tAllDepth;
uniform mat4 uInverseProjection;
uniform mat4 uInverseView;
uniform float uLogDepthFC;
uniform vec3 uCenter;
uniform float uRadiusAngle;
uniform vec3 uRadiiM;
uniform vec4 uColor;
uniform vec4 uLineColor;
uniform vec4 uHaloColor;
uniform vec4 uRadii;
uniform vec4 uAlphas;
uniform float uDepth;
uniform float uLineWidth;
uniform float uHaloWidth;
uniform float uPixelRatio;
${DISPLAY_COLOR_GLSL}
${VIEW_POSITION_GLSL}
vec4 over(vec4 top, vec4 under) {
  float a = top.a + under.a * (1.0 - top.a);
  if (a <= 0.0) return vec4(0.0);
  return vec4((top.rgb * top.a + under.rgb * under.a * (1.0 - top.a)) / a, a);
}
void mainImage(const in vec4 inputColor,const in vec2 uv,out vec4 outputColor) {
  outputColor=inputColor;
  float depth=unpackRGBAToDepth(texture2D(tAllDepth,uv));
  float distance=viewDistance(depth, uLogDepthFC);
  vec4 ray=uInverseProjection*vec4(uv*2.0-1.0,-1.0,1.0);
  vec3 point=viewPosition(ray, distance);
  vec3 origin=uInverseView[3].xyz;
  vec3 direction=normalize((uInverseView*vec4(ray.xyz,0.0)).xyz);
  vec3 o=origin/uRadiiM;
  vec3 d=direction/uRadiiM;
  float a=dot(d,d);
  float b=dot(o,d);
  float c=dot(o,o)-1.0;
  float discriminant=b*b-a*c;
  float hit=(-b-sqrt(max(discriminant,0.0)))/a;
  vec3 world=origin+direction*hit;
  vec3 up=normalize(world);
  float r=length(cross(up,uCenter))/sin(uRadiusAngle);
  float cssPx=max(length(vec2(dFdx(r),dFdy(r))),1e-7)*uPixelRatio;
  if(discriminant<0.0||hit<=0.0||dot(up,uCenter)<=0.0||r>1.0) return;
  // The raised ellipsoid is depth tested, as the material disc is.
  if(depth<1.0 && hit>length(point)+1.0) return;
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

class PulseEffectDesc extends withPassDisposal(withFrameUpdates(EffectDesc)) {
  static allowDuplication = true;
  static key = KEY;
  static insertAfter = ['gevGround', 'gevImagery', 'toneMapping'];
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
    this.effect = new Effect('GevGroundPulses', fragmentShader, {
      // Input color is the tone-mapped frame.
      attributes: EffectAttribute.CONVOLUTION,
      uniforms: new Map([
        ...groundSurfaceUniforms({ surface: false }),
        ['uInverseView', new Uniform(new Matrix4())],
        ['uCenter', new Uniform(new Vector3(1, 0, 0))],
        ['uRadiusAngle', new Uniform(1)],
        ['uRadiiM', new Uniform(new Vector3())],
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
    u.get('uRadiiM').value.set(
      6378137 + owner.heightM,
      6378137 + owner.heightM,
      6356752.314245179 + owner.heightM,
    );
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
}

const registered = new WeakSet();

/**
 * The pulse disc on one Navara view around `center` (Earth-fixed metres):
 * `draw({ radii, alphas, level })` each frame with the fronts as fractions of
 * `radiusM` and their opacities, `move(center)`, and `destroy()`. Colors are
 * rgba arrays in 0..1: the band, the pulse line and its halo.
 */
export function createNavaraPulseField(
  { view, canvas },
  {
    center,
    radiusM,
    heightM,
    color,
    lineColor,
    haloColor,
    depth,
    lineWidth,
    haloWidth,
  },
) {
  if (!registered.has(view)) {
    view.registerEffect(KEY, PulseEffectDesc);
    registered.add(view);
  }
  const owner = {
    cssWidth: () => canvas?.clientWidth ?? 0,
    center: new Vector3(),
    radiusAngle: radiusM / Math.hypot(center.x, center.y, center.z),
    heightM,
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
      view.forceUpdate();
    },
  };
}
