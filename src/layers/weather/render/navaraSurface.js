import { Effect, EffectAttribute } from 'postprocessing';
import {
  CanvasTexture,
  DataTexture,
  LinearFilter,
  Matrix4,
  Uniform,
} from 'three';
import {
  groundSurfaceUniforms,
  updateGroundSurface,
} from '../../shared/render/navaraGroundSurface.js';
import { shellLift } from '../shellRendering.js';

const KEY = 'gevObservedWeather';
const owners = new WeakMap();
const products = ['Wind', 'Satellite', 'Radar', 'Lightning'];
const slotFor = (p) =>
  p === 'wind' ? 'Wind' : p === 'radar' ? 'Radar' : p === 'lightning' ? 'Lightning' : 'Satellite';
const emptyRect = [0, 0, -1, -1];
const rectArray = (r) => (r ? [r.west, r.south, r.east, r.north] : emptyRect);

const shader = /* glsl */ `
uniform sampler2D tAllDepth,tSurfaceDepth;
uniform mat4 uInverseProjection,uWorld;
uniform float uLogDepthFC;
uniform bool uRaised;
${products
  .map(
    (p) => `uniform sampler2D t${p},tDetail${p};
uniform vec4 uBounds${p},uWindow${p};
uniform vec2 uLook${p};`,
  )
  .join('\n')}
vec3 toDisplay(vec3 x) {
  return mix(12.92*x,1.055*pow(max(x,vec3(0.0)),vec3(1.0/2.4))-0.055,step(vec3(0.0031308),x));
}
vec3 toLinear(vec3 x) {
  return mix(x/12.92,pow((x+0.055)/1.055,vec3(2.4)),step(vec3(0.04045),x));
}
vec2 geographic(vec3 point) {
  float r=length(point.xy),theta=atan(point.z*6378137.0,r*6356752.314245);
  float s=sin(theta),c=cos(theta);
  return vec2(atan(point.y,point.x),atan(point.z+42841.311513*s*s*s,r-42697.672707*c*c*c));
}
vec3 paint(vec3 color,sampler2D image,sampler2D detail,vec4 bounds,vec4 window,vec2 look,
    vec3 ray,float sceneRange,bool onSurface) {
  if(look.x<=0.0) return color;
  vec3 origin=uWorld[3].xyz;
  float range=sceneRange;
  if(uRaised) {
    vec3 radii=vec3(6378137.0,6378137.0,6356752.314245)+look.y;
    vec3 o=origin/radii,d=ray/radii;
    float a=dot(d,d),b=dot(o,d),c=dot(o,o)-1.0;
    float disc=b*b-a*c;
    if(disc<0.0) return color;
    float root=sqrt(disc);
    range=(-b-root)/a;
    if(range<=0.0) range=(-b+root)/a;
    if(range<=0.0 || range>sceneRange+1.0) return color;
  } else if(!onSurface) return color;
  vec2 uv=(geographic(origin+range*ray)-bounds.xy)/(bounds.zw-bounds.xy);
  if(any(lessThan(uv,vec2(0.0)))||any(greaterThan(uv,vec2(1.0)))) return color;
  vec2 delta=window.zw-window.xy;
  vec2 duv=(uv-window.xy)/max(delta,vec2(1e-6));
  bool useDetail=all(greaterThan(delta,vec2(0.0)))&&all(greaterThanEqual(duv,vec2(0.0)))&&all(lessThanEqual(duv,vec2(1.0)));
  vec4 sampleColor=useDetail ? texture2D(detail,duv) : texture2D(image,uv);
  return mix(color,sampleColor.rgb,look.x*sampleColor.a);
}
void mainImage(const in vec4 inputColor,const in vec2 uv,out vec4 outputColor) {
  outputColor=inputColor;
  float depth=unpackRGBAToDepth(texture2D(tAllDepth,uv));
  bool onSurface=depth<1.0 && depth>=texture2D(tSurfaceDepth,uv).r-2e-7;
  if(!uRaised && !onSurface) return;
  vec3 v=(uInverseProjection*vec4(uv*2.0-1.0,-1.0,1.0)).xyz;
  vec3 ray=normalize(mat3(uWorld)*v);
  float range=depth>=1.0 ? 1.0e12 : (exp2(2.0*depth/uLogDepthFC)-1.0)*length(v)/(-v.z);
  vec3 rgb=toDisplay(inputColor.rgb);
  ${products.map((p) => `rgb=paint(rgb,t${p},tDetail${p},uBounds${p},uWindow${p},uLook${p},ray,range,onSurface);`).join('\n')}
  outputColor=vec4(toLinear(rgb),inputColor.a);
}
`;

function weatherPass(engine, { view, EffectDesc, NavaraEffect }) {
  let shared = owners.get(view);
  if (shared) return shared;
  const surfaces = new Set();
  let handle = null,
    empty = null;
  class WeatherEffect extends EffectDesc {
    static key = KEY;
    static insertAfter = ['gevNepalEvent', 'gevRecentImagery', 'toneMapping'];
    static insertBefore = [
      'gevEarthquakeGround',
      'gevFirmsGround',
      'gevPreSharpenOverlay',
      'gevSharpen',
      'smaa',
      'fxaa',
      'gevOverlay',
      'final',
    ];
    createPass() {
      this.effect = new Effect('GevObservedWeather', shader, {
        attributes: EffectAttribute.CONVOLUTION,
        uniforms: new Map([
          ...groundSurfaceUniforms(),
          ['uWorld', new Uniform(new Matrix4())],
          ['uRaised', new Uniform(false)],
          ...products.flatMap((p) => [
            ['t' + p, new Uniform(empty)],
            ['tDetail' + p, new Uniform(empty)],
            ['uBounds' + p, new Uniform(emptyRect)],
            ['uWindow' + p, new Uniform(emptyRect)],
            ['uLook' + p, new Uniform([0, 0])],
          ]),
        ]),
      });
      return new NavaraEffect(this.view.camera.raw, this.effect);
    }
    update() {
      if (!this.effect) return;
      const camera = this.view.camera.raw,
        u = this.effect.uniforms;
      updateGroundSurface(this.effect, camera, this.ctx, this.find('mrt'));
      u.get('uWorld').value.copy(camera.matrixWorld);
      u.get('uRaised').value = engine.maps.photorealActive();
      const lift = shellLift(engine.camera.pose().cartographic.height);
      for (const frame of surfaces) frame.upload(this.ctx.getRenderer());
      for (const p of products) {
        let active = null;
        for (const f of surfaces)
          if (f.slot === p && f.visible && f.alpha > 0 && f.image) active = f;
        u.get('t' + p).value = active?.image ?? empty;
        u.get('tDetail' + p).value = active?.detail ?? empty;
        u.get('uBounds' + p).value = active?.bounds ?? emptyRect;
        u.get('uWindow' + p).value = active?.window ?? emptyRect;
        u.get('uLook' + p).value = active
          ? [active.alpha, active.height + lift]
          : [0, 0];
      }
    }
    onDestroy() {
      this.effect?.dispose();
      super.onDestroy();
    }
  }
  view.registerEffect(KEY, WeatherEffect);
  shared = {
    surfaces,
    sync() {
      if (surfaces.size && !handle) {
        empty = new DataTexture(new Uint8Array(4), 1, 1);
        empty.needsUpdate = true;
        handle = view.addEffect({ [KEY]: {}, visible: true });
      } else if (!surfaces.size && handle) {
        handle.delete();
        handle = null;
        empty.dispose();
        empty = null;
      }
      engine.render.request(KEY);
    },
  };
  owners.set(view, shared);
  return shared;
}

function imageTexture(canvas) {
  const texture = new CanvasTexture(canvas);
  texture.minFilter = texture.magFilter = LinearFilter;
  texture.generateMipmaps = false;
  return texture;
}

/** Own one weather frame. Upload staging images before replacing the last drawn frame. */
export function createWeatherSurface(
  engine,
  options,
  product,
  { rectangle, height, onSettled },
) {
  const shared = weatherPass(engine, options);
  let pending = false,
    ready = false;
  const frame = {
    slot: slotFor(product),
    bounds: rectArray(rectangle),
    height,
    alpha: 0,
    visible: true,
    image: null,
    detail: null,
    window: null,
    upload(renderer) {
      if (!pending) return;
      if (frame.image) renderer.initTexture(frame.image);
      if (frame.detail) renderer.initTexture(frame.detail);
      pending = false;
      ready = true;
      // Completing a frame can dispose its predecessor. Finish this pass first.
      queueMicrotask(() => {
        if (shared.surfaces.has(frame)) onSettled();
      });
    },
  };
  shared.surfaces.add(frame);
  shared.sync();
  return {
    setImage(canvas) {
      if (frame.image?.image === canvas) return;
      frame.image?.dispose();
      frame.image = imageTexture(canvas);
      ready = false;
      pending = true;
      shared.sync();
    },
    setDetail(canvas, rect) {
      if (frame.detail?.image !== canvas) {
        frame.detail?.dispose();
        frame.detail = canvas ? imageTexture(canvas) : null;
        pending = true;
      }
      frame.window = rect ? rectArray(rect) : null;
      shared.sync();
    },
    setAlpha(value) {
      frame.alpha = value;
      shared.sync();
    },
    setShow(value) {
      if (frame.visible === value) return false;
      frame.visible = value;
      shared.sync();
      return true;
    },
    getDiagnostics() {
      const [west, south, east, north] = frame.window ?? [];
      return {
        height,
        ready,
        uploaded: ready,
        show: frame.visible,
        alpha: frame.alpha,
        rendering: pending,
        detail: {
          uploaded: Boolean(frame.detail && !pending),
          window: frame.window && { west, south, east, north },
        },
      };
    },
    destroy() {
      if (!shared.surfaces.delete(frame)) return;
      frame.image?.dispose();
      frame.detail?.dispose();
      shared.sync();
    },
  };
}
