// engine.ground's screen pass on Navara: one public EffectDesc after tone
// mapping, before the sharpening, anti-aliasing and gev's overlays. Each
// pixel's world position comes from Navara's packed scene depth (terrain,
// 3D tiles); where that is the ground (not a mesh in front of it), the
// candidates of its screen cell (pack.js) are tested in their own gnomonic
// planes: a disc against its radius, an area against its segments (even-odd
// inside, distance to the nearest edge), a corridor tile (corridors.js),
// when the pixel's ground is in its cell, against the runs of the pixel's
// bin: each item's distance to its nearest segment there. Fills, outlines
// and corridors are anti-aliased over one pixel across the boundary and
// blended in display space, in draw order, as Cesium blends translucent
// ground primitives; a corridor's glow, pulse and dash follow Cesium's
// materials, from the time uniform (src/globe/ground.js groundSeconds).
// No effect remains in the chain while no item is drawn.

import { DISPLAY_COLOR_GLSL, VIEW_POSITION_GLSL } from '../shaderChunks.js';
import { EffectDesc, Effect as NavaraEffect } from '@navaramap/three';
import { Effect, EffectAttribute } from 'postprocessing';
import {
  DataTexture,
  FloatType,
  Matrix4,
  NearestFilter,
  RGBAFormat,
  Uniform,
} from 'three';
import { DASH_EDGE, groundSeconds } from '../../ground.js';
import {
  GROUND_SURFACE_GLSL,
  groundSurfaceUniforms,
  updateGroundSurface,
} from './surface.js';
import { withFrameUpdates, withPassDisposal } from '../frameDescriptor.js';
import { REVEAL_OFFSET, ITEM_TEXELS, LOOK, MARGIN_RATIO } from './corridors.js';
import {
  GRID_COLS,
  GRID_ROWS,
  KIND,
  ROW,
  STYLE_TEXELS,
  TEXELS,
} from './pack.js';

export const GROUND_EFFECT_KEY = 'gevGround';

const float = (value) => (Number.isInteger(value) ? `${value}.0` : `${value}`);

const fragmentShader = /* glsl */ `
uniform sampler2D tAllDepth;
uniform sampler2D tSurfaceDepth;
uniform sampler2D tGlobeDepth;
uniform highp sampler2D tFrames;
uniform highp sampler2D tStyles;
uniform highp sampler2D tSegments;
uniform highp sampler2D tBins;
uniform highp sampler2D tRuns;
uniform highp sampler2D tItems;
uniform highp sampler2D tGrid;
uniform highp sampler2D tCandidates;
uniform mat4 uInverseProjection;
uniform mat4 uViewToWorld;
uniform float uLogDepthFC;
uniform float uTime;
uniform float uPixelRatio;
// Rows of ${ROW} texels (pack.js texelStorage).
vec4 atSlot(highp sampler2D image, int slot) {
  return texelFetch(image, ivec2(slot & ${ROW - 1}, slot >> ${Math.log2(ROW)}), 0);
}
${DISPLAY_COLOR_GLSL}
${VIEW_POSITION_GLSL}
${GROUND_SURFACE_GLSL}
// A corridor item over the colour, nearest metres from its line and along
// metres from its start: its width, glow, pulse and dash, in LDR and
// premultiplied, as Cesium writes ground polylines.
vec3 blendCorridor(vec3 color, int item, float nearest, vec2 normal, float along, vec2 localDx, vec2 localDy) {
  int at = item * ${ITEM_TEXELS};
  vec4 shape = atSlot(tItems, at + 1);
  if (along / max(shape.z, 1e-6) > atSlot(tItems, at + 5).x) return color;
  // Metres a pixel spans across the line (the screen gradient of the
  // distance to it): its width in pixels the same at any angle, as Cesium's.
  float pixel = max(length(vec2(dot(normal, localDx), dot(normal, localDy))), 1e-4);
  float halfWidth = shape.x > 0.0 ? shape.x * uPixelRatio * 0.5 * pixel : shape.y * 0.5;
  float cover = clamp((halfWidth - nearest) / pixel + 0.5, 0.0, 1.0);
  if (cover <= 0.0) return color;
  vec4 fill = atSlot(tItems, at);
  vec3 rgb = fill.rgb;
  float alpha = fill.a * cover;
  int look = int(shape.w + 0.5);
  if (look != 0) {
    vec4 glowPulse = atSlot(tItems, at + 2);
    vec4 pulseDash = atSlot(tItems, at + 3);
    vec4 dash = atSlot(tItems, at + 4);
    float s = clamp(along / max(shape.z, 1e-6), 0.0, 1.0);
    if ((look & ${LOOK.pulse}) != 0)
      alpha *= mix(glowPulse.w, pulseDash.x, 0.5 + 0.5 * sin(6.283185307179586 * uTime / glowPulse.z));
    if ((look & ${LOOK.glow}) != 0) {
      float glow = glowPulse.x / max(nearest / (2.0 * halfWidth), 1e-6) - glowPulse.x / 0.5;
      if (glowPulse.y <= 0.99999)
        glow *= min(1.0, glowPulse.y / (0.5 - s * 0.5) - glowPulse.y / 0.5);
      rgb = max(vec3(glow - 1.0) + rgb, rgb);
      alpha *= clamp(glow, 0.0, 1.0);
    }
    if ((look & ${LOOK.pattern}) != 0) {
      // A screen-aligned 16-bit mask, as the ground PolylineDash material.
      vec2 tangent = normalize(vec2(-dot(normal, localDy), dot(normal, localDx)));
      float across = dot(gl_FragCoord.xy, tangent);
      float bit = floor(fract(across / (dash.z * uPixelRatio)) * 16.0);
      alpha *= mod(floor(dash.w / exp2(bit)), 2.0);
    }
    if ((look & ${LOOK.dash}) != 0) {
      float flow = fract(s * pulseDash.y - uTime * pulseDash.w);
      float on = 1.0 - smoothstep(pulseDash.z - ${float(DASH_EDGE)}, pulseDash.z + ${float(DASH_EDGE)}, flow);
      rgb *= 1.0 + dash.y * on;
      alpha *= max(on, dash.x);
    }
  }
  float core = atSlot(tItems, at + 5).y;
  if (core < 1.0 && nearest / max(halfWidth, 1e-6) > core) {
    vec4 backing = atSlot(tItems, at + 6);
    rgb = backing.rgb;
    alpha = backing.a * cover;
  }
  return min(color * (1.0 - alpha) + min(rgb * alpha, vec3(1.0)), vec3(1.0));
}
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  outputColor = inputColor;
  // All three depths must name one pixel, including at tile boundaries.
  ivec2 depthPixel = ivec2(uv * vec2(textureSize(tAllDepth, 0)));
  float depth = unpackRGBAToDepth(texelFetch(tAllDepth, depthPixel, 0));
  float distance = viewDistance(depth, uLogDepthFC);
  vec4 ray = uInverseProjection * vec4(uv * 2.0 - 1.0, -1.0, 1.0);
  vec3 point = viewPosition(ray, distance);
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
  float surface = texelFetch(tSurfaceDepth, depthPixel, 0).r;
  float globeDepth = unpackRGBAToDepth(texelFetch(tGlobeDepth, depthPixel, 0));
  float surfaceType = groundSurfaceType(depth, surface, globeDepth);
  if (surfaceType == 0.0) return;
  vec3 color = toDisplay(inputColor.rgb);
  // The pixel's ground in world space, once: every corridor tile tests the
  // same value, so exactly one tile of a set holds it.
  bool placed = false;
  vec3 world = vec3(0.0);
  float sinLatitude = 0.0;
  int first = int(range.x);
  int candidates = int(range.y);
  for (int k = 0; k < candidates; k++) {
    int id = int(atSlot(tCandidates, first + k).x);
    vec4 origin = atSlot(tFrames, id * ${TEXELS});
    vec4 east = atSlot(tFrames, id * ${TEXELS} + 1);
    vec4 north = atSlot(tFrames, id * ${TEXELS} + 2);
    vec4 surfaceFrame = atSlot(tFrames, id * ${TEXELS} + 3);
    if (surfaceFrame.w != 0.0 && surfaceFrame.w != surfaceType) continue;
    vec3 up = surfaceFrame.xyz;
    vec4 span = atSlot(tStyles, id * ${STYLE_TEXELS} + 3);
    vec3 delta = point - origin.xyz;
    float height = dot(delta, up);
    if (height < span.x || height > span.y) continue;
    vec4 fillColor = atSlot(tStyles, id * ${STYLE_TEXELS});
    vec4 lineColor = atSlot(tStyles, id * ${STYLE_TEXELS} + 1);
    vec4 shape = atSlot(tStyles, id * ${STYLE_TEXELS} + 2);
    int kind = int(shape.x + 0.5);
    if (kind == ${KIND.corridorTile}) {
      if (!placed) {
        world = (uViewToWorld * vec4(point, 1.0)).xyz;
        sinLatitude = world.z / length(world);
        placed = true;
      }
      // The tile's cell: east of its west meridian, west of its east one,
      // between its parallels (fillColor and lineColor hold them); an open
      // side takes everything beyond it.
      vec4 open = atSlot(tStyles, id * ${STYLE_TEXELS} + 5);
      if (dot(world.xy, fillColor.xy) + open.x < 0.0 || dot(world.xy, fillColor.zw) + open.y <= 0.0 ||
          sinLatitude < lineColor.x || sinLatitude >= lineColor.y) continue;
    }
    // Along the ray from the Earth's centre onto the item's plane.
    float scale = origin.w / (origin.w + height);
    vec2 local = vec2(dot(delta, east.xyz), dot(delta, north.xyz)) * scale;
    vec2 localDx = vec2(dot(pointDx, east.xyz), dot(pointDx, north.xyz)) * scale;
    vec2 localDy = vec2(dot(pointDy, east.xyz), dot(pointDy, north.xyz)) * scale;
    // Beyond the item's extent and its padding in pixels: not this item.
    float reach = east.w + north.w * (length(localDx) + length(localDy));
    if (dot(local, local) > reach * reach) continue;
    if (kind == ${KIND.corridorTile}) {
      // The finest level whose margin covers the set's thinnest reach in
      // the pixel's widest metres per pixel (a wider corridor's runs are
      // listed with a wider margin).
      vec4 place = atSlot(tStyles, id * ${STYLE_TEXELS} + 4);
      vec4 open = atSlot(tStyles, id * ${STYLE_TEXELS} + 5);
      float pixelMax = max(length(localDx + localDy), length(localDx - localDy));
      // A pixel past the bins (beyond an open side) takes the bin nearest
      // it, with a margin that reaches it too.
      float past = length(max(vec2(0.0), max(place.xy - local, local - open.zw)));
      float need = (lineColor.z * uPixelRatio * pixelMax + past) / (${float(MARGIN_RATIO)} * shape.y);
      int level = need <= 1.0 ? 0 : min(int(lineColor.w + 0.5), int(ceil(log2(need))));
      int columns = int(shape.z + 0.5);
      int rows = int(shape.w + 0.5);
      int dir = int(place.z + 0.5);
      for (int z = 0; z < level; z++) {
        dir += columns * rows;
        columns = (columns + 1) >> 1;
        rows = (rows + 1) >> 1;
      }
      float size = shape.y * exp2(float(level));
      ivec2 cell = clamp(ivec2(floor((local - place.xy) / size)), ivec2(0), ivec2(columns - 1, rows - 1));
      vec4 bin = atSlot(tBins, dir + cell.y * columns + cell.x);
      int runStart = int(span.w + 0.5) + int(bin.x + 0.5);
      int runCount = int(bin.y + 0.5);
      int segmentBase = int(span.z + 0.5);
      int itemBase = int(place.w + 0.5);
      int item = -1;
      float best = 1e30;
      vec2 bestNormal = vec2(1.0, 0.0);
      float bestAlong = 0.0;
      for (int r = 0; r < runCount; r++) {
        vec4 run = atSlot(tRuns, runStart + r);
        int runItem = itemBase + int(run.x + 0.5);
        if (runItem != item) {
          if (item >= 0)
            color = blendCorridor(color, item, best, bestNormal, bestAlong, localDx, localDy);
          item = runItem;
          best = 1e30;
        }
        float along = run.w;
        int start = segmentBase + int(run.y + 0.5);
        int count = int(run.z + 0.5);
        for (int s = 0; s < count; s++) {
          vec4 segment = atSlot(tSegments, start + s);
          vec2 a = segment.xy;
          vec2 ab = segment.zw - a;
          vec2 ap = local - a;
          float lengthSq = dot(ab, ab);
          float t = clamp(dot(ap, ab) / max(lengthSq, 1e-12), 0.0, 1.0);
          vec2 off = ap - ab * t;
          float d = length(off);
          float segmentLength = sqrt(lengthSq);
          if (d < best) {
            best = d;
            if (d > 0.0) bestNormal = off / d;
            bestAlong = along + t * segmentLength;
          }
          along += segmentLength;
        }
      }
      if (item >= 0)
        color = blendCorridor(color, item, best, bestNormal, bestAlong, localDx, localDy);
      continue;
    }
    float nearest = 1e30;
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
      vec4 grid = atSlot(tStyles, id * ${STYLE_TEXELS} + 4);
      if (grid.x > 0.5 &&
          (length(localDx) + length(localDy)) * (shape.y * uPixelRatio * 0.5 + 1.5) <= grid.z * 0.5) {
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
    float inward = inside ? nearest : -nearest;
    if (kind == ${KIND.disc} && shape.z > 0.5) {
      vec4 radial = atSlot(tStyles, id * ${STYLE_TEXELS} + 4);
      float emission = atSlot(tStyles, id * ${STYLE_TEXELS} + 5).x;
      float radius = length(local) / shape.w;
      float inside = 1.0 - smoothstep(radial.w, 1.0, radius);
      float rim = smoothstep(radial.z, radial.w, radius) * inside;
      float alpha = fillColor.a * inside * mix(radial.x, radial.y, rim);
      color = min(color * (1.0 - alpha) + fillColor.rgb * (1.0 + rim * emission) * alpha, vec3(1.0));
    } else
    if (fillColor.a > 0.0)
      color = mix(color, fillColor.rgb, fillColor.a * clamp(inward / pixel + 0.5, 0.0, 1.0));
    if (lineColor.a > 0.0 && shape.y > 0.0)
      color = mix(color, lineColor.rgb, lineColor.a * clamp(shape.y * uPixelRatio * 0.5 - nearest / pixel + 0.5, 0.0, 1.0));
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
    runs: dataTexture(state.runs),
    items: dataTexture(state.items),
    frames: dataTexture(state.frames),
    grid: dataTexture(state.grid),
    candidates: dataTexture(state.candidates),
    candidateData: state.candidates.data,
    dispose() {
      for (const key of [
        'styles',
        'segments',
        'bins',
        'runs',
        'items',
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
        state.runs,
        state.items,
        state.frames,
        state.grid,
        state.candidates,
      ].reduce((total, { data }) => total + data.byteLength, 0)
    : 0;

class GroundEffectDesc extends withPassDisposal(withFrameUpdates(EffectDesc)) {
  static key = GROUND_EFFECT_KEY;
  // Navara takes the first anchor that exists: the latest first.
  static insertAfter = ['gevImagery', 'toneMapping'];
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
        ...groundSurfaceUniforms(),
        ['tGlobeDepth', new Uniform(null)],
        ['tFrames', new Uniform(null)],
        ['tStyles', new Uniform(null)],
        ['tSegments', new Uniform(null)],
        ['tBins', new Uniform(null)],
        ['tRuns', new Uniform(null)],
        ['tItems', new Uniform(null)],
        ['tGrid', new Uniform(null)],
        ['tCandidates', new Uniform(null)],
        ['uViewToWorld', new Uniform(new Matrix4())],
        ['uTime', new Uniform(0)],
        ['uPixelRatio', new Uniform(1)],
      ]),
    });
    return new NavaraEffect(camera, this.effect);
  }

  updateFrame() {
    const camera = this.view.camera.raw;
    const owner = this.owner;
    if (!this.effect || !camera || !owner.state) return;
    const mrt = this.find('mrt');
    updateGroundSurface(this.effect, camera, this.ctx, mrt);
    const input = this.ctx.getInputBuffer();
    const { state } = owner;
    const cssWidth = this.view.canvas?.clientWidth;
    const pixelRatio = cssWidth > 0 ? input.width / cssWidth : 1;
    if (
      state.update(
        camera.matrixWorldInverse.elements,
        camera.projectionMatrix.elements,
        input.width,
        input.height,
        pixelRatio,
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
    u.get('uViewToWorld').value.copy(camera.matrixWorld);
    u.get('uTime').value = groundSeconds();
    u.get('uPixelRatio').value = pixelRatio;
    u.get('tFrames').value = owner.textures.frames;
    u.get('tStyles').value = owner.textures.styles;
    u.get('tSegments').value = owner.textures.segments;
    u.get('tBins').value = owner.textures.bins;
    u.get('tRuns').value = owner.textures.runs;
    u.get('tItems').value = owner.textures.items;
    u.get('tGrid').value = owner.textures.grid;
    u.get('tCandidates').value = owner.textures.candidates;
  }
}

const registered = new WeakSet();

/**
 * The pass of one view: set(state) shows a composed state (null: nothing,
 * the effect removed) and disposes the one before.
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
      if (!visible) {
        handle?.delete();
        handle = null;
      } else if (!handle)
        handle = view.addEffect({
          [GROUND_EFFECT_KEY]: { owner },
          visible: true,
        });
      else handle?.update({ visible });
      previous?.dispose();
    },
    reveal(offset, count, fraction) {
      if (!owner.state) return;
      for (let i = 0; i < count; i++)
        owner.state.items.data[offset + i * ITEM_TEXELS * 4 + REVEAL_OFFSET] =
          fraction;
      owner.textures.items.needsUpdate = true;
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
