import { Effect, EffectAttribute } from 'postprocessing';
import { Uniform, Matrix4, DataTexture } from 'three';
import {
  groundSurfaceUniforms,
  updateGroundSurface,
} from '../../shared/render/navaraGroundSurface.js';

const KEY = 'gevRecentImagery',
  registered = new WeakSet();
const shader = /* glsl */ `
uniform sampler2D tAllDepth,tSurfaceDepth,tA,tB;
uniform mat4 uInverseProjection,uWorld;
uniform float uLogDepthFC,uSplit,uPixelRatio;
uniform vec4 uBoundsA,uBoundsB,uBoxA,uBoxB,uPreview;
uniform vec2 uLookA,uLookB;
uniform bool uPreviewVisible;
vec3 displayColor(vec3 c) {
  return mix(c*12.92,1.055*pow(max(c,vec3(0.0)),vec3(1.0/2.4))-0.055,step(vec3(0.0031308),c));
}
vec3 linearColor(vec3 c) {
  return mix(c/12.92,pow(max((c+0.055)/1.055,vec3(0.0)),vec3(2.4)),step(vec3(0.04045),c));
}
bool inBox(vec2 geo,vec4 box) { return geo.x>=box.x && geo.y>=box.y && geo.x<=box.z && geo.y<=box.w; }
vec3 imageColor(vec3 color,sampler2D image,vec4 bounds,vec4 box,vec2 look,vec2 geo,vec2 mercator,float x) {
  if(look.x<=0.0 || !inBox(geo,box)) return color;
  if((look.y<0.0 && x>uSplit)||(look.y>0.0 && x<uSplit)) return color;
  vec2 at=(mercator-bounds.xy)/bounds.zw;
  if(any(lessThan(at,vec2(0.0)))||any(greaterThan(at,vec2(1.0)))) return color;
  vec4 pixel=texture2D(image,at);
  return mix(color,pixel.rgb,pixel.a*look.x);
}
void mainImage(const in vec4 inputColor,const in vec2 uv,out vec4 outputColor) {
  outputColor=inputColor;
  float depth=unpackRGBAToDepth(texture2D(tAllDepth,uv));
  if(depth>=1.0 || depth<texture2D(tSurfaceDepth,uv).r-2e-7) return;
  float distance=exp2(2.0*depth/uLogDepthFC)-1.0;
  vec4 ray=uInverseProjection*vec4(uv*2.0-1.0,-1.0,1.0);
  vec3 point=(uWorld*vec4(ray.xyz*(distance/-ray.z),1.0)).xyz;
  float p=length(point.xy),theta=atan(point.z*6378137.0,p*6356752.314245);
  float st=sin(theta),ct=cos(theta);
  float latitude=atan(point.z+42841.311513*st*st*st,p-42697.672707*ct*ct*ct);
  vec2 geo=vec2(atan(point.y,point.x),latitude)*57.29577951308232;
  vec2 mercator=vec2((geo.x+180.0)/360.0,(1.0-log(tan(0.7853981633974483+latitude*0.5))/3.141592653589793)/2.0);
  vec3 color=displayColor(inputColor.rgb);
  color=imageColor(color,tA,uBoundsA,uBoxA,uLookA,geo,mercator,uv.x);
  color=imageColor(color,tB,uBoundsB,uBoxB,uLookB,geo,mercator,uv.x);
  if(uPreviewVisible && inBox(geo,uPreview)) {
    vec2 pixelWidth=max(fwidth(geo),vec2(1e-7));
    vec2 edges=min(geo-uPreview.xy,uPreview.zw-geo)/pixelWidth;
    float edge=1.0-step(2.0*uPixelRatio,min(edges.x,edges.y));
    float dash=step(0.5,fract((gl_FragCoord.x+gl_FragCoord.y)/(12.0*uPixelRatio)));
    color=mix(color,vec3(0.545,0.914,1.0),mix(0.12,0.95,edge*dash));
  }
  outputColor=vec4(linearColor(color),inputColor.a);
}
`;
const boxVector = (b) =>
  b ? [b.west, b.south, b.east, b.north] : [0, 0, 0, 0];

export function createImageryGround(
  engine,
  { view, EffectDesc, NavaraEffect },
  owner,
) {
  if (!view || !EffectDesc || !NavaraEffect)
    throw new TypeError('Imagery requires Navara ground effects');
  if (!registered.has(view)) {
    class ImageryEffect extends EffectDesc {
      static key = KEY;
      static insertAfter = ['toneMapping'];
      static insertBefore = [
        'gevSharpen',
        'smaa',
        'fxaa',
        'gevPreSharpenOverlay',
        'gevOverlay',
        'final',
      ];
      constructor(view, context, config) {
        super(view, context, config);
        this.owner = config[KEY].owner;
      }
      createPass() {
        this.effect = new Effect('GevRecentImagery', shader, {
          attributes: EffectAttribute.CONVOLUTION,
          uniforms: new Map([
            ...groundSurfaceUniforms(),
            ['uWorld', new Uniform(new Matrix4())],
            ['uSplit', new Uniform(0.5)],
            ['uPixelRatio', new Uniform(1)],
            ['uPreview', new Uniform([0, 0, 0, 0])],
            ['uPreviewVisible', new Uniform(false)],
            ...['A', 'B'].flatMap((id) => [
              [`t${id}`, new Uniform(null)],
              [`uBounds${id}`, new Uniform([0, 0, 1, 1])],
              [`uBox${id}`, new Uniform([0, 0, 0, 0])],
              [`uLook${id}`, new Uniform([0, 0])],
            ]),
          ]),
        });
        return new NavaraEffect(this.view.camera.raw, this.effect);
      }
      update() {
        if (!this.effect) return;
        const camera = this.view.camera.raw,
          u = this.effect.uniforms,
          o = this.owner;
        updateGroundSurface(this.effect, camera, this.ctx, this.find('mrt'));
        u.get('uWorld').value.copy(camera.matrixWorld);
        u.get('uSplit').value = o.split;
        u.get('uPixelRatio').value = o.pixelRatio();
        u.get('uPreview').value = boxVector(o.preview);
        u.get('uPreviewVisible').value = Boolean(o.preview);
        for (const id of ['A', 'B']) {
          const r = o.slots[id.toLowerCase()];
          u.get(`t${id}`).value = r?.atlas?.texture || o.empty;
          u.get(`uBounds${id}`).value = r?.atlas?.plan.bounds || [0, 0, 1, 1];
          u.get(`uBox${id}`).value = boxVector(r?.box);
          u.get(`uLook${id}`).value = [
            r?.atlas ? r.alpha : 0,
            r?.split === 'left' ? -1 : r?.split === 'right' ? 1 : 0,
          ];
        }
      }
      onDestroy() {
        this.effect?.dispose();
        super.onDestroy();
      }
    }
    view.registerEffect(KEY, ImageryEffect);
    registered.add(view);
  }
  owner.empty = new DataTexture(new Uint8Array(4), 1, 1);
  owner.empty.needsUpdate = true;
  owner.pixelRatio = () =>
    engine.host.canvas.width / Math.max(1, engine.host.size().width);
  let handle = null;
  return {
    sync() {
      const visible = Boolean(owner.slots.a || owner.slots.b || owner.preview);
      if (visible && !handle)
        handle = view.addEffect({ [KEY]: { owner }, visible: true });
      else handle?.update({ visible });
    },
    destroy() {
      handle?.delete();
      handle = null;
      owner.empty.dispose();
    },
  };
}
