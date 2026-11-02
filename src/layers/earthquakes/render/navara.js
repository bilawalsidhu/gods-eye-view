// Classify the real visible terrain/Google-tiles surface in a public
// Navara post-effect. Native ground colour blends in display space; doing
// it explicitly preserves translucent colours and overlap order.
import { Effect, EffectAttribute } from 'postprocessing';
import { Uniform } from 'three';
import {
  createGroundTexture as texture,
  createGroundStorage as storage,
  groundSurfaceUniforms,
  updateGroundSurface,
} from '../../shared/render/navaraGroundSurface.js';
import * as geo from '../../../geo/index.js';
import {
  DISC_EDGES,
  discFrame,
  viewFrame,
  discClipBounds,
} from './navaraGeometry.js';
import { createDiscGrid, GRID_COLS, GRID_ROWS } from './navaraGrid.js';
const KEY = 'gevEarthquakeGround';
const registeredViews = new WeakSet();
const fragmentShader = /* glsl */ `
uniform sampler2D tAllDepth;
uniform sampler2D tSurfaceDepth;
uniform sampler2D tEdges;
uniform sampler2D tFrames;
uniform sampler2D tGrid;
uniform sampler2D tCandidates;
uniform vec2 uEdgeSize;
uniform vec2 uFrameSize;
uniform vec2 uCandidateSize;
uniform mat4 uInverseProjection;
uniform float uLogDepthFC;
vec4 atSlot(sampler2D image,vec2 size,float slot) {
  return texture2D(image,(vec2(mod(slot,size.x),floor(slot/size.x))+0.5)/size);
}
vec3 toDisplay(vec3 c) {
  return mix(12.92*c,1.055*pow(max(c,vec3(0.0)),vec3(1.0/2.4))-0.055,step(vec3(0.0031308),c));
}
vec3 toLinear(vec3 c) {
  return mix(c/12.92,pow((c+0.055)/1.055,vec3(2.4)),step(vec3(0.04045),c));
}
void mainImage(const in vec4 inputColor,const in vec2 uv,out vec4 outputColor) {
  outputColor=inputColor;
  float depth=unpackRGBAToDepth(texture2D(tAllDepth,uv));
  float distance=exp2(2.0*depth/uLogDepthFC)-1.0;
  vec4 ray=uInverseProjection*vec4(uv*2.0-1.0,-1.0,1.0);
  vec3 point=ray.xyz*(distance/-ray.z);
  // Derivatives must be evaluated before divergent cell/feature branches.
  // Inside the candidate loop adjacent pixels may be testing different IDs.
  vec3 pointDx=dFdx(point),pointDy=dFdy(point);
  if(depth>=1.0) return;
  vec2 cell=clamp(floor(uv*vec2(${GRID_COLS}.0,${GRID_ROWS}.0)),vec2(0.0),vec2(${GRID_COLS - 1}.0,${GRID_ROWS - 1}.0));
  vec2 range=texture2D(tGrid,(cell+0.5)/vec2(${GRID_COLS}.0,${GRID_ROWS}.0)).xy;
  if(range.y<0.5) return;
  float surface=texture2D(tSurfaceDepth,uv).r;
  // Public MRT depth excludes forward custom meshes, which are not ground.
  if(depth<surface-2e-7) return;
  vec3 color=toDisplay(inputColor.rgb);
  for(int k=0;k<int(range.y);k++) {
    float id=atSlot(tCandidates,uCandidateSize,range.x+float(k)).x;
    vec4 center=atSlot(tFrames,uFrameSize,id*5.0);
    vec4 east=atSlot(tFrames,uFrameSize,id*5.0+1.0);
    vec4 north=atSlot(tFrames,uFrameSize,id*5.0+2.0);
    vec4 up=atSlot(tFrames,uFrameSize,id*5.0+3.0);
    vec3 delta=point-center.xyz;
    vec3 local=vec3(dot(delta,east.xyz),dot(delta,north.xyz),dot(delta,up.xyz));
    vec2 localDx=vec2(dot(pointDx,east.xyz),dot(pointDx,north.xyz));
    vec2 localDy=vec2(dot(pointDy,east.xyz),dot(pointDy,north.xyz));
    if(local.z<east.w || local.z>north.w) continue;
    float coverage=1.0;
    // A convex boundary intersects a ray from its centre on exactly one
    // edge. For large discs, binary-search that edge and its two neighbours;
    // all other edges lie beyond the one-pixel AA band. Small/subpixel discs
    // retain the full supporting-plane coverage calculation.
    bool large=center.w>128.0*max(length(pointDx),length(pointDy));
    int first=0;
    if(large) {
      float angle=mod(atan(local.x,-local.y)-up.w+6.28318530718,6.28318530718);
      int low=0,high=${DISC_EDGES - 1};
      for(int step=0;step<6;step++) {
        int middle=(low+high+1)/2;
        float start=atSlot(tEdges,uEdgeSize,id*${DISC_EDGES}.0+float(middle)).w;
        if(angle>=start) low=middle;else high=middle-1;
      }
      first=low-1;
    }
    int count=large?3:${DISC_EDGES};
    for(int k=0;k<count;k++) {
      int i=(first+k+${DISC_EDGES})%${DISC_EDGES};
      vec3 edge=atSlot(tEdges,uEdgeSize,id*${DISC_EDGES}.0+float(i)).xyz;
      float d=edge.z-dot(edge.xy,local.xy);
      float pixel=abs(dot(edge.xy,localDx))+abs(dot(edge.xy,localDy));
      coverage=min(coverage,clamp(d/max(pixel,0.001)+0.5,0.0,1.0));
      if(coverage<=0.0) break;
    }
    if(coverage<=0.0) continue;
    vec4 fill=atSlot(tFrames,uFrameSize,id*5.0+4.0);
    color=mix(color,fill.rgb,fill.a*coverage);
  }
  outputColor=vec4(toLinear(color),inputColor.a);
}
`;
function buildState(discs) {
  const frames = discs.map(discFrame);
  const edges = storage(discs.length * DISC_EDGES);
  const packed = storage(discs.length * 5);
  const grid = createDiscGrid(discs.length);
  const gridData = new Float32Array(GRID_COLS * GRID_ROWS * 4);
  const gridTexture = texture(gridData, GRID_COLS, GRID_ROWS);
  let candidates = storage(1);
  const scratch = new Float64Array(12),
    bounds = new Float64Array(4);
  const lastView = new Float64Array(16).fill(Number.NaN);
  const lastProjection = new Float64Array(16).fill(Number.NaN);
  let lastWidth = 0,
    lastHeight = 0;
  frames.forEach((frame, i) => edges.data.set(frame.edges, i * DISC_EDGES * 4));
  const state = {
    count: discs.length,
    edges,
    packed,
    gridTexture,
    get candidates() {
      return candidates;
    },
    update(camera, ctx) {
      const input = ctx.getInputBuffer();
      const view = camera.matrixWorldInverse.elements;
      const projection = camera.projectionMatrix.elements;
      let changed = input.width !== lastWidth || input.height !== lastHeight;
      for (let i = 0; i < 16 && !changed; i++)
        changed =
          view[i] !== lastView[i] || projection[i] !== lastProjection[i];
      // All features are static. Depth still refreshes each frame, but their
      // screen index/coordinates only change with the camera or viewport.
      if (!changed) return;
      lastView.set(view);
      lastProjection.set(projection);
      lastWidth = input.width;
      lastHeight = input.height;
      frames.forEach((frame, i) => {
        viewFrame(frame, camera.matrixWorldInverse, scratch);
        discClipBounds(frame, scratch, camera.projectionMatrix, bounds);
        if (bounds[0] <= 1) {
          bounds[0] -= 2 / Math.max(1, input.width);
          bounds[2] += 2 / Math.max(1, input.width);
          bounds[1] -= 2 / Math.max(1, input.height);
          bounds[3] += 2 / Math.max(1, input.height);
        }
        grid.bounds.set(bounds, i * 4);
        const offset = i * 20;
        packed.data.set(
          [scratch[0], scratch[1], scratch[2], frame.radius],
          offset,
        );
        packed.data.set(
          [scratch[3], scratch[4], scratch[5], frame.floor],
          offset + 4,
        );
        packed.data.set(
          [scratch[6], scratch[7], scratch[8], frame.ceiling],
          offset + 8,
        );
        packed.data.set(
          [scratch[9], scratch[10], scratch[11], frame.phase],
          offset + 12,
        );
        const d = discs[i];
        packed.data.set(
          [d.color.red, d.color.green, d.color.blue, d.fillAlpha],
          offset + 16,
        );
      });
      const total = grid.pack();
      if (candidates.data.length / 4 < total) {
        candidates.texture.dispose();
        candidates = storage(Math.max(total, (2 * candidates.data.length) / 4));
      }
      for (let i = 0; i < total; i++) candidates.data[i * 4] = grid.indices[i];
      for (let i = 0; i < grid.counts.length; i++) {
        gridData[i * 4] = grid.offsets[i];
        gridData[i * 4 + 1] = grid.counts[i];
      }
      packed.texture.needsUpdate = true;
      gridTexture.needsUpdate = true;
      candidates.texture.needsUpdate = true;
    },
    dispose() {
      edges.texture.dispose();
      packed.texture.dispose();
      gridTexture.dispose();
      candidates.texture.dispose();
    },
  };
  return state;
}

function groundEffectClass(EffectDesc, NavaraEffect) {
  return class GroundEffectDesc extends EffectDesc {
    static key = KEY;
    static insertAfter = ['gevObservedWeather', 'gevNepalEvent', 'gevRecentImagery', 'toneMapping'];
    static insertBefore = [
      'gevFirmsGround',
      'gevPreSharpenOverlay',
      'gevSharpen',
      'smaa',
      'fxaa',
      'gevOverlay',
      'final',
    ];
    constructor(view, ctx, config) {
      super(view, ctx, config);
      this.owner = config[KEY].owner;
    }
    createPass() {
      this.effect = new Effect('GevEarthquakeGround', fragmentShader, {
        // Keep a separate pass: inputColor is the already tone-mapped frame.
        attributes: EffectAttribute.CONVOLUTION,
        uniforms: new Map([
          ...groundSurfaceUniforms(),
          ['tEdges', new Uniform(null)],
          ['tFrames', new Uniform(null)],
          ['tGrid', new Uniform(null)],
          ['tCandidates', new Uniform(null)],
          ['uEdgeSize', new Uniform([1, 1])],
          ['uFrameSize', new Uniform([1, 1])],
          ['uCandidateSize', new Uniform([1, 1])],
        ]),
      });
      return new NavaraEffect(this.view.camera.raw, this.effect);
    }
    update() {
      const state = this.owner.state,
        camera = this.view.camera.raw,
        mrt = this.find('mrt');
      if (!this.effect || !camera || !state) return;
      updateGroundSurface(this.effect, camera, this.ctx, mrt);
      state.update(camera, this.ctx);
      const u = this.effect.uniforms;
      u.get('tEdges').value = state.edges.texture;
      u.get('uEdgeSize').value = [state.edges.width, state.edges.height];
      u.get('tFrames').value = state.packed.texture;
      u.get('uFrameSize').value = [state.packed.width, state.packed.height];
      u.get('tGrid').value = state.gridTexture;
      u.get('tCandidates').value = state.candidates.texture;
      u.get('uCandidateSize').value = [
        state.candidates.width,
        state.candidates.height,
      ];
    }
    onDestroy() {
      this.effect?.dispose();
      super.onDestroy();
    }
  };
}

export function createEarthquakesNavaraRenderer(
  engine,
  { view, EffectDesc, NavaraEffect } = {},
) {
  if (!view?.camera || !engine?.render || !EffectDesc || !NavaraEffect)
    throw new TypeError('Earthquakes require a Navara view');
  if (!registeredViews.has(view)) {
    view.registerEffect(KEY, groundEffectClass(EffectDesc, NavaraEffect));
    registeredViews.add(view);
  }
  let destroyed = false,
    visible = false,
    rows = [],
    handle = null;
  const owner = { state: buildState([]) };
  const sync = () => {
    const show = visible && owner.state.count > 0;
    if (show && !handle)
      handle = view.addEffect({ [KEY]: { owner }, visible: true });
    else handle?.update({ visible: show });
  };
  return {
    kind: 'navara',
    setVisible(show) {
      if (destroyed) return;
      visible = show !== false;
      sync();
      engine.render.request('earthquake-visibility');
    },
    replace(discs) {
      if (destroyed) return;
      const nextRows = discs.map((d) => {
        const place = geo.cartographic.fromCartesian(d.position);
        return {
          id: d.usgsId ?? null,
          mag: d.mag,
          place: d.place,
          time: d.time,
          depth: d.depthKm,
          lat: place ? geo.math.toDegrees(place.latitude) : null,
          lon: place ? geo.math.toDegrees(place.longitude) : null,
        };
      });
      const next = buildState(discs),
        previous = owner.state;
      owner.state = next;
      rows = nextRows;
      sync();
      previous.dispose();
      engine.render.request('earthquake-refresh');
    },
    records(limit) {
      return !destroyed && visible
        ? rows.slice(0, limit).map((row) => ({ ...row }))
        : [];
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      visible = false;
      rows = [];
      handle?.delete();
      owner.state.dispose();
      engine.render.request('earthquake-destroy');
    },
  };
}
