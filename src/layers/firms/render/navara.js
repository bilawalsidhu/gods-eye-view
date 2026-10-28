// FIRMS terrain/tiles classification and actual engine mover glows.
import { Effect, EffectAttribute } from 'postprocessing';
import { Matrix4, Uniform } from 'three';
import { createEngineLayerView } from '../../shared/render/engineView.js';
import { selectionDispatcherFor } from '../../../data/selectionDispatcher.js';
import { LOD_LEVELS } from '../policy.js';
import { createFirmsSpriteBank } from './navaraSprites.js';
import { rectangleFrame } from './navaraGeometry.js';
import {
  viewFrame,
  groundClipBounds,
} from '../../shared/render/navaraGroundGeometry.js';
import {
  createGroundGrid,
  GRID_COLS,
  GRID_ROWS,
} from '../../shared/render/navaraGroundGrid.js';
import {
  createGroundTexture,
  createGroundStorage,
  groundSurfaceUniforms,
  updateGroundSurface,
} from '../../shared/render/navaraGroundSurface.js';
const KEY = 'gevFirmsGround';
const registeredViews = new WeakSet();
const fragmentShader = /* glsl */ `
uniform sampler2D tAllDepth;
uniform sampler2D tSurfaceDepth;
uniform sampler2D tCells;
uniform sampler2D tGrid;
uniform sampler2D tCandidates;
uniform vec2 uCellSize;
uniform vec2 uCandidateSize;
uniform mat4 uInverseProjection;
uniform mat4 uInverseView;
uniform float uLogDepthFC;
vec4 atSlot(sampler2D image,vec2 size,float slot) {
  return texture2D(image,(vec2(mod(slot,size.x),floor(slot/size.x))+0.5)/size);
}
vec3 toDisplay(vec3 c) {
  return mix(12.92*c,1.055*pow(max(c,vec3(0.0)),vec3(1.0/2.4))-0.055,step(vec3(0.0031308),c));
}
vec3 toLinear(vec3 c) {
  return mix(c/12.92,pow(max((c+0.055)/1.055,vec3(0.0)),vec3(2.4)),step(vec3(0.04045),c));
}
vec3 pixelPlane(float distance,vec3 normal,vec3 dx,vec3 dy) {
  return vec3(distance,dot(normal,dx),dot(normal,dy));
}
float rectangleCoverage(vec3 west,vec3 east,vec3 south,vec3 north) {
  vec3 edges[4];
  edges[0]=west;edges[1]=east;edges[2]=south;edges[3]=north;
  float coverage=1.0;
  int partial=0;
  for(int i=0;i<4;i++) {
    float width=abs(edges[i].y)+abs(edges[i].z);
    coverage=min(coverage,clamp(edges[i].x/max(width,0.001)+0.5,0.0,1.0));
    if(coverage<=0.0) return 0.0;
    if(edges[i].x<=width*0.5) partial++;
  }
  if(partial<2) return coverage;
  // Intersect the SAME pixel square with all sides. Minimum soft-edge
  // coverage creates long miter halos at acute/polar rectangle corners.
  vec2 polygon[8],clipped[8];
  polygon[0]=vec2(-0.5,-0.5);polygon[1]=vec2(0.5,-0.5);
  polygon[2]=vec2(0.5,0.5);polygon[3]=vec2(-0.5,0.5);
  int count=4;
  for(int side=0;side<4;side++) {
    int nextCount=0;
    vec2 previous=polygon[count-1];
    float before=edges[side].x+dot(edges[side].yz,previous);
    for(int i=0;i<8;i++) {
      if(i>=count) break;
      vec2 current=polygon[i];
      float after=edges[side].x+dot(edges[side].yz,current);
      if((before>0.0&&after<0.0)||(before<0.0&&after>0.0))
        clipped[nextCount++]=mix(previous,current,before/(before-after));
      if(after>=0.0) clipped[nextCount++]=current;
      previous=current;before=after;
    }
    count=nextCount;
    if(count<3) return 0.0;
    for(int i=0;i<8;i++) { if(i>=count) break;polygon[i]=clipped[i]; }
  }
  float area=0.0;
  vec2 previous=polygon[count-1];
  for(int i=0;i<8;i++) {
    if(i>=count) break;
    area+=previous.x*polygon[i].y-previous.y*polygon[i].x;
    previous=polygon[i];
  }
  return clamp(abs(area)*0.5,0.0,1.0);
}
void mainImage(const in vec4 inputColor,const in vec2 uv,out vec4 outputColor) {
  outputColor=inputColor;
  float depth=unpackRGBAToDepth(texture2D(tAllDepth,uv));
  float distance=exp2(2.0*depth/uLogDepthFC)-1.0;
  vec4 ray=uInverseProjection*vec4(uv*2.0-1.0,-1.0,1.0);
  vec3 point=ray.xyz*(distance/-ray.z);
  // Evaluate derivatives before divergent candidate branches, as in quakes.
  vec3 world=(uInverseView*vec4(point,1.0)).xyz;
  vec3 dx=(uInverseView*vec4(dFdx(point),0.0)).xyz;
  vec3 dy=(uInverseView*vec4(dFdy(point),0.0)).xyz;
  // A quad crossing the sky has no surface derivative. Keep exact halfspaces
  // there; otherwise its far-plane lane spreads cell AA along the globe limb.
  float onSurface=1.0-step(1.0,depth);
  float derivativeMask=1.0-step(0.5,abs(dFdx(onSurface))+abs(dFdy(onSurface)));
  dx*=derivativeMask;
  dy*=derivativeMask;
  if(depth>=1.0) return;
  vec2 tile=clamp(floor(uv*vec2(${GRID_COLS}.0,${GRID_ROWS}.0)),vec2(0.0),vec2(${GRID_COLS - 1}.0,${GRID_ROWS - 1}.0));
  vec2 range=texture2D(tGrid,(tile+0.5)/vec2(${GRID_COLS}.0,${GRID_ROWS}.0)).xy;
  if(range.y<0.5) return;
  float surface=texture2D(tSurfaceDepth,uv).r;
  if(depth<surface-2e-7) return;
  float rho=length(world.xy);
  vec2 radial=world.xy/max(rho,0.001);
  vec3 color=toDisplay(inputColor.rgb);
  for(int k=0;k<int(range.y);k++) {
    float id=atSlot(tCandidates,uCandidateSize,range.x+float(k)).x;
    vec4 longitude=atSlot(tCells,uCellSize,id*4.0);
    vec3 south=atSlot(tCells,uCellSize,id*4.0+1.0).xyz;
    vec3 north=atSlot(tCells,uCellSize,id*4.0+2.0).xyz;
    vec3 westNormal=vec3(-longitude.x,longitude.y,0.0);
    vec3 eastNormal=vec3(longitude.z,-longitude.w,0.0);
    float coverage=rectangleCoverage(
      pixelPlane(dot(westNormal,world),westNormal,dx,dy),
      pixelPlane(dot(eastNormal,world),eastNormal,dx,dy),
      pixelPlane(world.z*south.y-rho*south.x+south.z,vec3(-south.x*radial,south.y),dx,dy),
      pixelPlane(rho*north.x-world.z*north.y-north.z,vec3(north.x*radial,-north.y),dx,dy));
    if(coverage<=0.0) continue;
    vec4 fill=atSlot(tCells,uCellSize,id*4.0+3.0);
    color=mix(color,fill.rgb,fill.a*coverage);
  }
  outputColor=vec4(toLinear(color),inputColor.a);
}
`;
function buildState(cells) {
  const frames = cells.map(rectangleFrame),
    packed = createGroundStorage(cells.length * 4);
  const grid = createGroundGrid(cells.length),
    gridData = new Float32Array(GRID_COLS * GRID_ROWS * 4);
  const gridTexture = createGroundTexture(gridData, GRID_COLS, GRID_ROWS);
  let candidates = createGroundStorage(1);
  const scratch = new Float64Array(12),
    bounds = new Float64Array(4);
  const lastView = new Float64Array(16).fill(NaN),
    lastProjection = new Float64Array(16).fill(NaN);
  let lastWidth = 0,
    lastHeight = 0;
  frames.forEach((frame, index) => {
    const offset = index * 16,
      color = cells[index].color;
    packed.data.set(frame.bounds.longitude, offset);
    packed.data.set(frame.bounds.south, offset + 4);
    packed.data.set(frame.bounds.north, offset + 8);
    packed.data.set(
      [color.red, color.green, color.blue, color.alpha],
      offset + 12,
    );
  });
  return {
    count: cells.length,
    packed,
    gridTexture,
    get candidates() {
      return candidates;
    },
    update(camera, context) {
      const input = context.getInputBuffer(),
        view = camera.matrixWorldInverse.elements,
        projection = camera.projectionMatrix.elements;
      let changed = input.width !== lastWidth || input.height !== lastHeight;
      for (let i = 0; i < 16 && !changed; i++)
        changed =
          view[i] !== lastView[i] || projection[i] !== lastProjection[i];
      if (!changed) return;
      lastView.set(view);
      lastProjection.set(projection);
      lastWidth = input.width;
      lastHeight = input.height;
      frames.forEach((frame, index) => {
        viewFrame(frame, camera.matrixWorldInverse, scratch);
        groundClipBounds(frame, scratch, camera.projectionMatrix, bounds);
        if (bounds[0] <= 1) {
          bounds[0] -= 2 / Math.max(1, input.width);
          bounds[2] += 2 / Math.max(1, input.width);
          bounds[1] -= 2 / Math.max(1, input.height);
          bounds[3] += 2 / Math.max(1, input.height);
        }
        grid.bounds.set(bounds, index * 4);
      });
      const total = grid.pack();
      if (candidates.data.length / 4 < total) {
        candidates.texture.dispose();
        candidates = createGroundStorage(
          Math.max(total, candidates.data.length / 2),
        );
      }
      for (let i = 0; i < total; i++) candidates.data[i * 4] = grid.indices[i];
      for (let i = 0; i < grid.counts.length; i++) {
        gridData[i * 4] = grid.offsets[i];
        gridData[i * 4 + 1] = grid.counts[i];
      }
      gridTexture.needsUpdate = true;
      candidates.texture.needsUpdate = true;
    },
    dispose() {
      packed.texture.dispose();
      gridTexture.dispose();
      candidates.texture.dispose();
    },
  };
}
function groundEffectClass(EffectDesc, NavaraEffect) {
  return class FirmsGroundEffectDesc extends EffectDesc {
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
      this.effect = new Effect('GevFirmsGround', fragmentShader, {
        attributes: EffectAttribute.CONVOLUTION,
        uniforms: new Map([
          ...groundSurfaceUniforms(),
          ['tCells', new Uniform(null)],
          ['tGrid', new Uniform(null)],
          ['tCandidates', new Uniform(null)],
          ['uCellSize', new Uniform([1, 1])],
          ['uCandidateSize', new Uniform([1, 1])],
          ['uInverseView', new Uniform(new Matrix4())],
        ]),
      });
      return new NavaraEffect(this.view.camera.raw, this.effect);
    }
    update() {
      const state = this.owner.state,
        camera = this.view.camera.raw;
      if (!this.effect || !state || !camera) return;
      updateGroundSurface(this.effect, camera, this.ctx, this.find('mrt'));
      state.update(camera, this.ctx);
      const u = this.effect.uniforms;
      u.get('tCells').value = state.packed.texture;
      u.get('uCellSize').value[0] = state.packed.width;
      u.get('uCellSize').value[1] = state.packed.height;
      u.get('tGrid').value = state.gridTexture;
      u.get('tCandidates').value = state.candidates.texture;
      u.get('uCandidateSize').value[0] = state.candidates.width;
      u.get('uCandidateSize').value[1] = state.candidates.height;
      u.get('uInverseView').value.copy(camera.matrixWorld);
    }
    onDestroy() {
      this.effect?.dispose();
      super.onDestroy();
    }
  };
}
export function createFirmsNavaraRenderer(
  engine,
  { view: nativeView, EffectDesc, NavaraEffect, id = 'local-firms' } = {},
) {
  if (!engine?.movers || !nativeView?.camera || !EffectDesc || !NavaraEffect)
    throw new TypeError('FIRMS requires a Navara view');
  if (!registeredViews.has(nativeView)) {
    nativeView.registerEffect(KEY, groundEffectClass(EffectDesc, NavaraEffect));
    registeredViews.add(nativeView);
  }
  let destroyed = false,
    visible = false,
    cells = [],
    queued = false,
    handle = null,
    sprites = null;
  const owner = { state: buildState([]) },
    dataSource = { show: false },
    handlers = new Set();
  const adapter = createEngineLayerView(engine, {
    layerId: id,
    isDestroyed: () => destroyed,
  });
  adapter.view.camera.moveEnd = engine.camera.moveEnd;
  adapter.view.scene.preRender = engine.frames.preRender;
  const sync = () => {
    const show = visible && owner.state.count > 0;
    if (show && !handle)
      handle = nativeView.addEffect({ [KEY]: { owner }, visible: true });
    else handle?.update({ visible: show });
  };
  const scheduleCells = () => {
    if (queued || destroyed) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (destroyed) return;
      const next = buildState(cells),
        previous = owner.state;
      owner.state = next;
      sync();
      previous.dispose();
      if (visible) engine.render.request('firms-cells');
    });
  };
  const removeSprites = () => {
    sprites?.destroy();
    sprites = null;
  };
  return {
    kind: 'navara',
    view: adapter.view,
    dataSource,
    clickType: 'click',
    project: (position, result) =>
      engine.projector.worldToWindow(position, result),
    viewRectangle(result) {
      const rect = engine.camera.viewRectangle();
      return rect ? Object.assign(result ?? {}, rect) : null;
    },
    horizon: () => ({
      isPointVisible: (position) => engine.projector.horizonVisible(position),
    }),
    createInputHandler() {
      let remove = null;
      const handler = {
        setInputAction(callback) {
          remove?.();
          remove = selectionDispatcherFor(engine).register(id, {
            owns: (pickId) => {
              const collection = sprites?.collection;
              if (!collection) return false;
              for (let i = 0; i < collection.length; i++)
                if (collection.get(i).id === pickId) return true;
              return false;
            },
            onClick: (event) => {
              if (!destroyed && visible) callback(event);
            },
          });
        },
        destroy() {
          remove?.();
          remove = null;
          handlers.delete(handler);
        },
      };
      handlers.add(handler);
      return handler;
    },
    pick: (position, event) => event?.picked,
    setVisible(show) {
      if (destroyed) return;
      const next = show !== false;
      if (visible === next) return;
      visible = next;
      dataSource.show = next;
      sprites?.setVisible(next);
      sync();
      engine.render.request('firms-visibility');
    },
    clearCells() {
      if (destroyed) return;
      cells = [];
      scheduleCells();
    },
    addCell(cell) {
      if (destroyed) return null;
      cells.push(cell);
      scheduleCells();
      return cell;
    },
    ensureSprites() {
      if (destroyed) return null;
      if (!sprites) {
        sprites = createFirmsSpriteBank(engine, {
          id: `firms:${id}`,
          capacity: Math.max(
            ...LOD_LEVELS.map((lod) => lod.maxDetections ?? 0),
          ),
        });
        sprites.setVisible(visible);
      }
      return sprites.collection;
    },
    addSprite(description) {
      return destroyed ? null : sprites.add(description);
    },
    removeSprites,
    onEnable() {},
    destroy() {
      if (destroyed) return;
      destroyed = true;
      visible = false;
      dataSource.show = false;
      cells = [];
      for (const handler of [...handlers]) handler.destroy();
      removeSprites();
      handle?.delete();
      owner.state.dispose();
      adapter.destroy();
      engine.render.request('firms-destroy');
    },
  };
}
