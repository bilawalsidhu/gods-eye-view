// engine.ground's screen pass on Navara: one public EffectDesc after tone
// mapping, before the sharpening, anti-aliasing and gev's overlays. Each
// pixel's world position comes from Navara's packed scene depth (terrain,
// 3D tiles); where that is the ground (not a mesh in front of it), the
// candidates of its screen cell (pack.js) are tested in their own gnomonic
// planes: a disc against its radius, an area against its segments (even-odd
// inside, distance to the nearest edge), a corridor against its distance to
// the line. Fills and outlines are anti-aliased over one pixel across the
// boundary and blended in display space, in draw order, as Cesium blends
// translucent ground primitives. Costs nothing while no item is drawn
// (the effect is hidden).

import { EffectDesc, Effect as NavaraEffect } from '@navaramap/three';
import { Effect, EffectAttribute } from 'postprocessing';
import {
  DataTexture,
  FloatType,
  Matrix4,
  NearestFilter,
  RGBADepthPacking,
  RGBAFormat,
  Uniform,
} from 'three';
import { withFrameUpdates, withPassDisposal } from '../frameDescriptor.js';
import { GRID_COLS, GRID_ROWS, KIND, STYLE_TEXELS, TEXELS } from './pack.js';

export const GROUND_EFFECT_KEY = 'gevGround';

const fragmentShader = /* glsl */ `
uniform sampler2D tAllDepth;
uniform sampler2D tSurfaceDepth;
uniform highp sampler2D tFrames;
uniform highp sampler2D tStyles;
uniform highp sampler2D tSegments;
uniform highp sampler2D tBins;
uniform highp sampler2D tGrid;
uniform highp sampler2D tCandidates;
uniform mat4 uInverseProjection;
uniform float uLogDepthFC;
vec4 atSlot(highp sampler2D image, int slot) {
  int width = textureSize(image, 0).x;
  return texelFetch(image, ivec2(slot % width, slot / width), 0);
}
vec3 toDisplay(vec3 c) {
  return mix(12.92*c,1.055*pow(max(c,vec3(0.0)),vec3(1.0/2.4))-0.055,step(vec3(0.0031308),c));
}
vec3 toLinear(vec3 c) {
  return mix(c/12.92,pow(max((c+0.055)/1.055,vec3(0.0)),vec3(2.4)),step(vec3(0.04045),c));
}
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  outputColor = inputColor;
  float depth = unpackRGBAToDepth(texture2D(tAllDepth, uv));
  float distance = exp2(2.0 * depth / uLogDepthFC) - 1.0;
  vec4 ray = uInverseProjection * vec4(uv * 2.0 - 1.0, -1.0, 1.0);
  vec3 point = ray.xyz * (distance / -ray.z);
  // Derivatives before any divergent branch: neighbours test other items.
  vec3 pointDx = dFdx(point);
  vec3 pointDy = dFdy(point);
  // A quad across the sky has no surface derivative.
  float onSurface = 1.0 - step(1.0, depth);
  float derivativeMask = 1.0 - step(0.5, abs(dFdx(onSurface)) + abs(dFdy(onSurface)));
  pointDx *= derivativeMask;
  pointDy *= derivativeMask;
  if (depth >= 1.0) return;
  ivec2 tile = clamp(ivec2(floor(uv * vec2(${GRID_COLS}.0, ${GRID_ROWS}.0))), ivec2(0), ivec2(${GRID_COLS - 1}, ${GRID_ROWS - 1}));
  vec2 range = texelFetch(tGrid, tile, 0).xy;
  if (range.y < 0.5) return;
  float surface = texture2D(tSurfaceDepth, uv).r;
  // The packed depth also holds forward meshes, which are not ground.
  if (depth < surface - 2e-7) return;
  vec3 color = toDisplay(inputColor.rgb);
  int first = int(range.x);
  int candidates = int(range.y);
  for (int k = 0; k < candidates; k++) {
    int id = int(atSlot(tCandidates, first + k).x);
    vec4 origin = atSlot(tFrames, id * ${TEXELS});
    vec4 east = atSlot(tFrames, id * ${TEXELS} + 1);
    vec4 north = atSlot(tFrames, id * ${TEXELS} + 2);
    vec3 up = atSlot(tFrames, id * ${TEXELS} + 3).xyz;
    vec4 span = atSlot(tStyles, id * ${STYLE_TEXELS} + 3);
    vec3 delta = point - origin.xyz;
    float height = dot(delta, up);
    if (height < span.x || height > span.y) continue;
    vec4 fillColor = atSlot(tStyles, id * ${STYLE_TEXELS});
    vec4 lineColor = atSlot(tStyles, id * ${STYLE_TEXELS} + 1);
    vec4 shape = atSlot(tStyles, id * ${STYLE_TEXELS} + 2);
    // Along the ray from the Earth's centre onto the item's plane.
    float scale = origin.w / (origin.w + height);
    vec2 local = vec2(dot(delta, east.xyz), dot(delta, north.xyz)) * scale;
    vec2 localDx = vec2(dot(pointDx, east.xyz), dot(pointDx, north.xyz)) * scale;
    vec2 localDy = vec2(dot(pointDy, east.xyz), dot(pointDy, north.xyz)) * scale;
    // Beyond the item's extent and its padding in pixels: not this item.
    float reach = east.w + north.w * (length(localDx) + length(localDy));
    if (dot(local, local) > reach * reach) continue;
    int kind = int(shape.x + 0.5);
    float nearest = 1e30;
    int nearestSegment = 0;
    vec2 normal = vec2(1.0, 0.0);
    bool inside = false;
    if (kind == ${KIND.disc}) {
      float r = length(local);
      if (r > 0.0) normal = local / r;
      nearest = abs(r - shape.w);
      inside = r < shape.w;
    } else {
      int start = int(span.z);
      int count = int(span.w);
      // A large area: only the segments of the pixel's bin, while its
      // reach (half the outline and the anti-aliasing) stays inside the
      // half bin the bin's list covers; inside-ness from the bin's centre.
      bool binned = false;
      bool centreInside = false;
      vec2 centre = vec2(0.0);
      if (kind == ${KIND.area}) {
        vec4 grid = atSlot(tStyles, id * ${STYLE_TEXELS} + 4);
        if (grid.x > 0.5 &&
            (length(localDx) + length(localDy)) * (shape.y * 0.5 + 1.5) <= grid.z * 0.5) {
          vec2 origin = atSlot(tStyles, id * ${STYLE_TEXELS} + 5).xy;
          ivec2 cell = ivec2(floor((local - origin) / grid.z));
          // Off the grid: outside the area, beyond any edge's reach.
          if (cell.x < 0 || cell.y < 0 || cell.x >= int(grid.x) || cell.y >= int(grid.y)) continue;
          vec4 bin = atSlot(tBins, int(grid.w) + cell.y * int(grid.x) + cell.x);
          start += int(bin.x);
          count = int(bin.y);
          centreInside = bin.z > 0.5;
          centre = origin + (vec2(cell) + 0.5) * grid.z;
          binned = true;
        }
      }
      for (int s = 0; s < count; s++) {
        vec4 segment = atSlot(tSegments, start + s);
        vec2 a = segment.xy;
        vec2 ab = segment.zw - a;
        vec2 ap = local - a;
        float t = clamp(dot(ap, ab) / max(dot(ab, ab), 1e-12), 0.0, 1.0);
        vec2 off = ap - ab * t;
        float d = length(off);
        if (d < nearest) {
          nearest = d;
          nearestSegment = s;
          if (d > 0.0) normal = off / d;
        }
        if (binned) {
          // The segment from the bin's centre to the pixel crosses it.
          vec2 cp = local - centre;
          float d1 = ab.x * (centre.y - a.y) - ab.y * (centre.x - a.x);
          float d2 = ab.x * (local.y - a.y) - ab.y * (local.x - a.x);
          float d3 = cp.x * (a.y - centre.y) - cp.y * (a.x - centre.x);
          float d4 = cp.x * (segment.w - centre.y) - cp.y * (segment.z - centre.x);
          if (d1 * d2 < 0.0 && d3 * d4 < 0.0) inside = !inside;
        } else if ((a.y > local.y) != (segment.w > local.y) &&
            local.x < ab.x * (local.y - a.y) / ab.y + a.x)
          inside = !inside;
      }
      if (binned) inside = inside != centreInside;
    }
    // Metres one pixel spans across the boundary.
    float pixel = max(abs(dot(normal, localDx)) + abs(dot(normal, localDy)), 1e-4);
    if (kind == ${KIND.corridorPx} || kind == ${KIND.corridorM}) {
      // A chunk of a long corridor draws where its own segments are nearest.
      vec2 owned = atSlot(tStyles, id * ${STYLE_TEXELS} + 4).xy;
      if (float(nearestSegment) < owned.x - 0.5 ||
          float(nearestSegment) > owned.x + owned.y - 0.5) continue;
      float halfWidth = kind == ${KIND.corridorPx} ? shape.z * 0.5 * pixel : shape.w * 0.5;
      float cover = clamp((halfWidth - nearest) / pixel + 0.5, 0.0, 1.0);
      color = mix(color, fillColor.rgb, fillColor.a * cover);
      continue;
    }
    float inward = inside ? nearest : -nearest;
    if (fillColor.a > 0.0)
      color = mix(color, fillColor.rgb, fillColor.a * clamp(inward / pixel + 0.5, 0.0, 1.0));
    if (lineColor.a > 0.0 && shape.y > 0.0)
      color = mix(color, lineColor.rgb, lineColor.a * clamp(shape.y * 0.5 - nearest / pixel + 0.5, 0.0, 1.0));
  }
  outputColor = vec4(toLinear(color), inputColor.a);
}
`;

function dataTexture({ data, width, height }) {
  const texture = new DataTexture(data, width, height, RGBAFormat, FloatType);
  texture.minFilter = NearestFilter;
  texture.magFilter = NearestFilter;
  texture.needsUpdate = true;
  return texture;
}

/** A composed state (pack.js composeGround) with its GPU textures. */
function texturesFor(state) {
  const textures = {
    styles: dataTexture(state.styles),
    segments: dataTexture(state.segments),
    bins: dataTexture(state.bins),
    frames: dataTexture(state.frames),
    grid: dataTexture(state.grid),
    candidates: dataTexture(state.candidates),
    candidateData: state.candidates.data,
    dispose() {
      for (const key of [
        'styles',
        'segments',
        'bins',
        'frames',
        'grid',
        'candidates',
      ])
        textures[key].dispose();
    },
  };
  return textures;
}

/** Bytes the pass's data textures hold on the GPU. */
export const textureBytes = (state) =>
  state
    ? [
        state.styles,
        state.segments,
        state.bins,
        state.frames,
        state.grid,
        state.candidates,
      ].reduce((total, { data }) => total + data.byteLength, 0)
    : 0;

class GroundEffectDesc extends withPassDisposal(withFrameUpdates(EffectDesc)) {
  static key = GROUND_EFFECT_KEY;
  // Navara takes the first anchor that exists: the latest first.
  static insertAfter = [
    'gevFirmsGround',
    'gevEarthquakeGround',
    'gevObservedWeather',
    'gevNepalEvent',
    'gevImagery',
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

  constructor(view, ctx, config) {
    super(view, ctx, config);
    this.owner = config[GROUND_EFFECT_KEY].owner;
  }

  createPass() {
    const camera = this.view.camera.raw;
    if (!camera) throw new Error('Camera not available for the ground pass');
    this.effect = new Effect('GevGround', fragmentShader, {
      // Its own pass: inputColor is the tone-mapped frame.
      attributes: EffectAttribute.CONVOLUTION,
      uniforms: new Map([
        ['tAllDepth', new Uniform(null)],
        ['tSurfaceDepth', new Uniform(null)],
        ['tFrames', new Uniform(null)],
        ['tStyles', new Uniform(null)],
        ['tSegments', new Uniform(null)],
        ['tBins', new Uniform(null)],
        ['tGrid', new Uniform(null)],
        ['tCandidates', new Uniform(null)],
        ['uInverseProjection', new Uniform(new Matrix4())],
        ['uLogDepthFC', new Uniform(1)],
      ]),
    });
    return new NavaraEffect(camera, this.effect);
  }

  updateFrame() {
    const camera = this.view.camera.raw;
    const owner = this.owner;
    if (!this.effect || !camera || !owner.state) return;
    const mrt = this.find('mrt');
    if (mrt?.depthBufferPacking !== RGBADepthPacking)
      throw new Error('The ground pass needs packed scene depth');
    const input = this.ctx.getInputBuffer();
    const { state } = owner;
    if (
      state.update(
        camera.matrixWorldInverse.elements,
        camera.projectionMatrix.elements,
        input.width,
        input.height,
      )
    ) {
      const textures = owner.textures;
      if (textures.candidateData !== state.candidates.data) {
        textures.candidates.dispose();
        textures.candidates = dataTexture(state.candidates);
        textures.candidateData = state.candidates.data;
      }
      textures.frames.needsUpdate = true;
      textures.grid.needsUpdate = true;
      textures.candidates.needsUpdate = true;
    }
    const u = this.effect.uniforms;
    u.get('tAllDepth').value = mrt.depthBuffer;
    u.get('tSurfaceDepth').value = this.ctx.getRenderTarget().depthTexture;
    u.get('uInverseProjection').value.copy(camera.projectionMatrixInverse);
    u.get('uLogDepthFC').value = 2 / Math.log2(camera.far + 1);
    u.get('tFrames').value = owner.textures.frames;
    u.get('tStyles').value = owner.textures.styles;
    u.get('tSegments').value = owner.textures.segments;
    u.get('tBins').value = owner.textures.bins;
    u.get('tGrid').value = owner.textures.grid;
    u.get('tCandidates').value = owner.textures.candidates;
  }
}

const registered = new WeakSet();

/**
 * The pass of one view: set(state) shows a composed state (null: nothing,
 * the effect hidden) and disposes the one before.
 */
export function createGroundPass(view) {
  if (!registered.has(view)) {
    view.registerEffect(GROUND_EFFECT_KEY, GroundEffectDesc);
    registered.add(view);
  }
  const owner = { state: null, textures: null };
  let handle = null;
  return {
    owner,
    set(state) {
      const previous = owner.textures;
      owner.state = state && state.count ? state : null;
      owner.textures = owner.state ? texturesFor(owner.state) : null;
      const visible = owner.state !== null;
      if (visible && !handle)
        handle = view.addEffect({
          [GROUND_EFFECT_KEY]: { owner },
          visible: true,
        });
      else handle?.update({ visible });
      previous?.dispose();
    },
    textureBytes: () => textureBytes(owner.state),
    destroy() {
      handle?.delete();
      handle = null;
      owner.textures?.dispose();
      owner.state = null;
      owner.textures = null;
    },
  };
}
