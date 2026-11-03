import { Effect, EffectAttribute } from 'postprocessing';
import { Uniform } from 'three';
import * as geo from '../../../geo/index.js';
import { rgbaFromCss } from '../../shared/color.js';
import {
  createGroundStorage,
  createGroundTexture,
  groundSurfaceUniforms,
  updateGroundSurface,
} from '../../shared/render/navaraGroundSurface.js';
import {
  createGroundGrid,
  GRID_COLS,
  GRID_ROWS,
} from '../../shared/render/navaraGroundGrid.js';
import {
  viewFrame,
  groundClipBounds,
} from '../../shared/render/navaraGroundGeometry.js';

const KEY = 'gevTransitGround',
  registered = new WeakSet();
const shader = /* glsl */ `
uniform sampler2D tAllDepth,tSurfaceDepth,tSegments,tGrid,tCandidates;
uniform vec2 uSegmentSize,uCandidateSize;
uniform mat4 uInverseProjection;
uniform float uLogDepthFC,uDisplayT,uActive,uPixelRatio;
uniform vec3 uColor;
vec4 slot(sampler2D image,vec2 size,float index) {
  return texture2D(image,(vec2(mod(index,size.x),floor(index/size.x))+0.5)/size);
}
vec3 displayColor(vec3 c) {
  return mix(c*12.92,1.055*pow(max(c,vec3(0.0)),vec3(1.0/2.4))-0.055,step(vec3(0.0031308),c));
}
vec3 linearColor(vec3 c) {
  return mix(c/12.92,pow(max((c+0.055)/1.055,vec3(0.0)),vec3(2.4)),step(vec3(0.04045),c));
}
float ageAlpha(float age) {
  if(age<120000.0) return mix(0.8,0.45,clamp(age/120000.0,0.0,1.0));
  if(age<600000.0) return mix(0.45,0.2,(age-120000.0)/480000.0);
  if(age<900000.0) return mix(0.2,0.08,(age-600000.0)/300000.0);
  return 0.08;
}
void mainImage(const in vec4 inputColor,const in vec2 uv,out vec4 outputColor) {
  outputColor=inputColor;
  float depth=unpackRGBAToDepth(texture2D(tAllDepth,uv));
  float distance=exp2(2.0*depth/uLogDepthFC)-1.0;
  vec4 ray=uInverseProjection*vec4(uv*2.0-1.0,-1.0,1.0);
  vec3 point=ray.xyz*(distance/-ray.z);
  vec3 dx=dFdx(point),dy=dFdy(point);
  float onSurface=1.0-step(1.0,depth);
  float derivativeMask=1.0-step(0.5,abs(dFdx(onSurface))+abs(dFdy(onSurface)));
  if(depth>=1.0 || derivativeMask<0.5) return;
  if(depth<texture2D(tSurfaceDepth,uv).r-2e-7) return;
  vec2 tile=clamp(floor(uv*vec2(${GRID_COLS}.0,${GRID_ROWS}.0)),vec2(0.0),vec2(${GRID_COLS - 1}.0,${GRID_ROWS - 1}.0));
  vec2 range=texture2D(tGrid,(tile+0.5)/vec2(${GRID_COLS}.0,${GRID_ROWS}.0)).xy;
  vec3 color=displayColor(inputColor.rgb);
  for(int k=0;k<int(range.y);k++) {
    float id=slot(tCandidates,uCandidateSize,range.x+float(k)).x;
    vec4 center=slot(tSegments,uSegmentSize,id*4.0);
    vec4 along=slot(tSegments,uSegmentSize,id*4.0+1.0);
    vec4 across=slot(tSegments,uSegmentSize,id*4.0+2.0);
    vec4 times=slot(tSegments,uSegmentSize,id*4.0+3.0);
    bool completed=times.y<=uDisplayT;
    bool isHead=abs(id-uActive)<0.5;
    if(!completed&&!isHead) continue;
    float fraction=completed?1.0:clamp((uDisplayT-times.x)/(times.y-times.x),0.0,1.0);
    vec3 delta=point-center.xyz;
    float s=dot(delta,along.xyz)+center.w;
    if(s<0.0||s>center.w*2.0*fraction) continue;
    float metresPerPixel=length(vec2(dot(across.xyz,dx),dot(across.xyz,dy)));
    float lateral=abs(dot(delta,across.xyz))/max(metresPerPixel,1e-6);
    float coverage=clamp(2.5*uPixelRatio+0.5-lateral,0.0,1.0);
    if(coverage<=0.0) continue;
    float core=clamp(1.5*uPixelRatio+0.5-lateral,0.0,1.0);
    float alpha=isHead?0.8:ageAlpha(uDisplayT-times.y);
    color=mix(color,mix(vec3(0.02,0.03,0.05),uColor,core),alpha*coverage);
  }
  outputColor=vec4(linearColor(color),inputColor.a);
}
`;

/** Short prepared corridors are extruded along the geodetic normal. */
export function transitTrailFrame(segment) {
  const [a, b] = segment.positions;
  const center = geo.cartesian3.midpoint(a, b, geo.cartesian3.create());
  const up = geo.ellipsoid.WGS84.geodeticSurfaceNormal(
    center,
    geo.cartesian3.create(),
  );
  const delta = geo.cartesian3.subtract(b, a, geo.cartesian3.create());
  const vertical = geo.cartesian3.dot(delta, up);
  delta.x -= up.x * vertical;
  delta.y -= up.y * vertical;
  delta.z -= up.z * vertical;
  const length = geo.cartesian3.magnitude(delta);
  const east = geo.cartesian3.normalize(delta, delta);
  const north = geo.cartesian3.cross(up, east, geo.cartesian3.create());
  return {
    center,
    east,
    north,
    up,
    length,
    radius: length / 2,
    floor: -12000,
    ceiling: 20000,
  };
}

function storage(segments) {
  const frames = segments.map(transitTrailFrame);
  const packed = createGroundStorage(segments.length * 4);
  const grid = createGroundGrid(segments.length);
  const gridData = new Float32Array(GRID_COLS * GRID_ROWS * 4);
  const gridTexture = createGroundTexture(gridData, GRID_COLS, GRID_ROWS);
  let candidates = createGroundStorage(1);
  const matrix = new Float64Array(32).fill(NaN),
    scratch = new Float64Array(12),
    bounds = new Float64Array(4);
  let width = 0,
    height = 0;
  const epoch = segments[0]?.fromT ?? 0;
  return {
    packed,
    gridTexture,
    epoch,
    get candidates() {
      return candidates;
    },
    update(camera, context) {
      const input = context.getInputBuffer(),
        v = camera.matrixWorldInverse.elements,
        p = camera.projectionMatrix.elements;
      let changed = width !== input.width || height !== input.height;
      for (let i = 0; i < 16 && !changed; i++)
        changed = matrix[i] !== v[i] || matrix[i + 16] !== p[i];
      if (!changed) return;
      matrix.set(v);
      matrix.set(p, 16);
      width = input.width;
      height = input.height;
      frames.forEach((frame, i) => {
        viewFrame(frame, camera.matrixWorldInverse, scratch);
        const offset = i * 16,
          segment = segments[i];
        packed.data.set(
          [
            scratch[0],
            scratch[1],
            scratch[2],
            frame.length / 2,
            scratch[3],
            scratch[4],
            scratch[5],
            0,
            scratch[6],
            scratch[7],
            scratch[8],
            0,
            segment.fromT - epoch,
            segment.toT - epoch,
            0,
            0,
          ],
          offset,
        );
        // Bound all possible 5 CSS-pixel widths over the height extrusion.
        const radius = frame.radius;
        frame.radius +=
          Math.max(
            1,
            (Math.abs(scratch[2]) + 32000) /
              Math.max(1, Math.abs(p[5]) * height),
          ) * 32;
        groundClipBounds(frame, scratch, camera.projectionMatrix, bounds);
        frame.radius = radius;
        grid.bounds.set(bounds, i * 4);
      });
      packed.texture.needsUpdate = true;
      const count = grid.pack();
      if (candidates.data.length / 4 < count) {
        candidates.texture.dispose();
        candidates = createGroundStorage(count);
      }
      for (let i = 0; i < count; i++) candidates.data[i * 4] = grid.indices[i];
      for (let i = 0; i < grid.counts.length; i++) {
        gridData[i * 4] = grid.offsets[i];
        gridData[i * 4 + 1] = grid.counts[i];
      }
      candidates.texture.needsUpdate = gridTexture.needsUpdate = true;
    },
    dispose() {
      packed.texture.dispose();
      gridTexture.dispose();
      candidates.texture.dispose();
    },
  };
}

function descriptor(EffectDesc, NavaraEffect) {
  return class TransitGroundEffect extends EffectDesc {
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
      this.effect = new Effect('GevTransitGround', shader, {
        attributes: EffectAttribute.CONVOLUTION,
        uniforms: new Map([
          ...groundSurfaceUniforms(),
          ['tSegments', new Uniform(null)],
          ['tGrid', new Uniform(null)],
          ['tCandidates', new Uniform(null)],
          ['uSegmentSize', new Uniform([1, 1])],
          ['uCandidateSize', new Uniform([1, 1])],
          ['uDisplayT', new Uniform(0)],
          ['uActive', new Uniform(-1)],
          ['uColor', new Uniform([1, 1, 1])],
          ['uPixelRatio', new Uniform(1)],
        ]),
      });
      return new NavaraEffect(this.view.camera.raw, this.effect);
    }
    updateFrame() {
      if (!this.effect) return;
      const { state, displayT, active, color, pixelRatio } = this.owner;
      const camera = this.view.camera.raw;
      updateGroundSurface(this.effect, camera, this.ctx, this.find('mrt'));
      state.update(camera, this.ctx);
      const u = this.effect.uniforms;
      for (const [name, data] of [
        ['Segments', state.packed],
        ['Candidates', state.candidates],
      ]) {
        u.get(`t${name}`).value = data.texture;
        const size = u.get(
          name === 'Segments' ? 'uSegmentSize' : 'uCandidateSize',
        ).value;
        size[0] = data.width;
        size[1] = data.height;
      }
      u.get('tGrid').value = state.gridTexture;
      u.get('uDisplayT').value = displayT - state.epoch;
      u.get('uActive').value = active;
      u.get('uColor').value = color;
      u.get('uPixelRatio').value = pixelRatio();
    }
    onDestroy() {
      this.effect?.dispose();
      super.onDestroy();
    }
  };
}

/** A static corridor texture; playback only updates time and active uniforms. */
export function createTransitNavaraTrail(
  engine,
  { view, EffectDesc, NavaraEffect },
) {
  if (!view || !EffectDesc || !NavaraEffect)
    throw new TypeError('Transit trails require the Navara ground effect API');
  if (!registered.has(view)) {
    view.registerEffect(KEY, descriptor(EffectDesc, NavaraEffect));
    registered.add(view);
  }
  let segments = [],
    revision = -1,
    rebuilds = 0,
    visible = true,
    destroyed = false,
    handle = null;
  const owner = {
    state: storage([]),
    displayT: 0,
    active: -1,
    color: [0.37, 0.94, 0.54],
    pixelRatio: () =>
      engine.host.canvas.width / Math.max(1, engine.host.size().width),
  };
  const body = { show: true, ready: true },
    head = { show: false, positions: [], width: 3 },
    backing = { show: false, positions: [], width: 5 };
  const endpoint = geo.cartesian3.create(),
    headPositions = [null, endpoint];
  const sync = () => {
    const show = visible && segments.length > 0;
    if (show && !handle)
      handle = view.addEffect({ [KEY]: { owner }, visible: true });
    else handle?.update({ visible: show });
  };
  return {
    replaceHistory(next) {
      if (destroyed || next.revision === revision) return;
      const nextState = storage(next.segments);
      const previous = owner.state;
      owner.state = nextState;
      segments = next.segments;
      revision = next.revision;
      owner.active = -1;
      head.show = backing.show = false;
      rebuilds++;
      sync();
      previous.dispose();
      engine.render.request('transit-trail-history');
    },
    setDisplaySample(sample, renderedPosition) {
      if (destroyed) return;
      if (!sample || !renderedPosition) {
        owner.active = -1;
        head.show = backing.show = false;
        return;
      }
      let lo = 0,
        hi = segments.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (segments[mid].toT <= sample.displayT) lo = mid + 1;
        else hi = mid;
      }
      const segment = segments[lo];
      const active =
        segment &&
        segment.fromT <= sample.displayT &&
        segment.fromSeq === sample.fromSeq &&
        segment.toSeq === sample.toSeq &&
        sample.fraction < 1
          ? lo
          : -1;
      if (owner.displayT === sample.displayT && owner.active === active) return;
      owner.displayT = sample.displayT;
      owner.active = active;
      head.show = backing.show = visible && active >= 0;
      if (active >= 0) {
        headPositions[0] = segment.positions[0];
        geo.cartesian3.clone(renderedPosition, endpoint);
        head.positions = backing.positions = headPositions;
      }
      engine.render.request('transit-trail-playback');
    },
    setStyle(css) {
      const color = rgbaFromCss(css).rgba().slice(0, 3);
      if (color.every((value, i) => value === owner.color[i])) return;
      owner.color = color;
      engine.render.request('transit-trail-style');
    },
    setVisible(next) {
      if (destroyed || visible === next) return;
      visible = next;
      body.show = next;
      head.show = backing.show = next && owner.active >= 0;
      sync();
      engine.render.request('transit-trail-visible');
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      handle?.delete();
      handle = null;
      owner.state.dispose();
      segments = [];
      engine.render.request('transit-trail-destroy');
    },
    diagnostics: () => ({
      revision,
      rebuilds,
      segments: segments.length,
      body: segments.length ? body : null,
      head,
      backing,
      headPrimitive: null,
      ground: true,
      headStrategy: 'surface-depth corridor with time clip',
      headRebuilds: 0,
      entitiesAdded: 0,
    }),
  };
}
