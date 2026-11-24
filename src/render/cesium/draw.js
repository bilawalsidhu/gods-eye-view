/**
 * @module render/cesium/draw
 * @description The Cesium renderer's draw port
 * (`src/render/contract/draw.d.ts`): batched sets of items, each set one
 * primitive collection in the scene, rebuilt when its items change (icon
 * sets, unclamped points restyled or moved, and models, change in place;
 * `drawModels.js`). Every
 * item carries a pick id `{set, id, meta}`, which the query port
 * (`ports.js`) reads picks back through.
 *
 * Clamped items follow the ground as Cesium's own entities do: a clamped
 * point is a billboard of a drawn dot, a draped line a ground polyline, a
 * clamped fill a ground primitive (packed so no two fills in one overlap,
 * so overlapping translucent fills blend as they did). A rebuilt set keeps
 * drawing its last ground primitives until the new ones are ready, so a
 * refresh never blinks. `horizonCull` hides a set's points and icons past
 * the ellipsoid's horizon, each frame before it draws, tested at the
 * position each was given (not where clamping put it). The ground fills and
 * draped lines of a set made with `pickable: false` stay out of the pick
 * pass, so they never hide the ground geometry drawn under them from picks.
 *
 * Solid lines in space start in a polyline collection, which costs every
 * line every frame; once a set's lines stop changing for a few frames they
 * settle into static batches that cost nothing until they change, and a
 * line that moves again goes back to the collection (`settleLines`).
 *
 * Icon sets that recede, or whose items move, glide, pick by proxy or switch images
 * by size, or that take columns, draw on the GPU instead (`gpuIcons.js`).
 *
 * Built over a scene by `createCesiumPorts`, and on its own over a Cesium
 * viewer with no renderer bound, when code first asks
 * `findDraw` for one (`rendererOf.js`).
 */
import * as Cesium from 'cesium';
import { temeToPseudoFixed } from '../../geo/celestial.js';
import { alongLength } from '../../geo/polyline.js';
import { clusterScreenPoints } from '../../geo/screenCluster.js';
import { provideUnboundDraw } from '../rendererOf.js';
import { blobUrl, listenerList, toCartesian, uncaught } from './common.js';
import { createGpuIcons, GPU_ICON_CAPABILITIES } from './gpuIcons.js';
import { blendHost } from './setBlend.js';
import { createModelSets } from './drawModels.js';
import { materialTexture } from './internals.js';
import { createMeshSets } from './drawMeshes.js';
import { createQuadSets } from './drawQuads.js';
import { createCesiumFields } from './drawFields.js';

/** The contract's colour as Cesium's. */
export function toColor(color, alpha = 1) {
  if (color === undefined || color === null)
    return Cesium.Color.WHITE.withAlpha(alpha);
  const c =
    typeof color === 'string'
      ? Cesium.Color.fromCssColorString(color)
      : new Cesium.Color(color[0], color[1], color[2], color[3] ?? 1);
  return c.withAlpha(c.alpha * alpha);
}

/**
 * A split line style's colours and split as its material's uniforms: `at`
 * outside 0..1 draws it all in `color`, as a split before the start does.
 */
function splitUniforms(style) {
  const at = Number.isFinite(style.at) && style.at >= 0 && style.at <= 1;
  return {
    color: toColor(style.color),
    behind: toColor(style.behind),
    splitAt: at ? style.at : -1,
    direction: at && style.reverse ? -1 : 1,
  };
}

/**
 * An image reference as something a billboard or material takes: a URL, an
 * SVG as a data URL, a blob as its object URL, or the canvas itself. An
 * atlas slot is read through the draw port's atlases first
 * (`createCesiumDraw`'s `imageAt`).
 */
export function toImage(image) {
  if (typeof image === 'string') return image;
  if (image?.svg)
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(image.svg)}`;
  if (image?.blob) return blobUrl(image.blob);
  if (image?.canvas) return image.canvas;
  if (typeof image?.atlas === 'string')
    throw new TypeError(
      `atlas ${image.atlas} has no slot ${image.slot} registered`,
    );
  throw new TypeError('an image is a URL, SVG, blob, canvas or atlas slot');
}

/** Cesium's height reference for an item's `height` and `clampTo`. */
export function heightReferenceOf(height, clampTo = 'both') {
  const H = Cesium.HeightReference;
  if (height === 'clampGround')
    return (
      { terrain: H.CLAMP_TO_TERRAIN, tiles: H.CLAMP_TO_3D_TILE }[clampTo] ??
      H.CLAMP_TO_GROUND
    );
  if (height === 'relativeGround')
    return (
      { terrain: H.RELATIVE_TO_TERRAIN, tiles: H.RELATIVE_TO_3D_TILE }[
        clampTo
      ] ?? H.RELATIVE_TO_GROUND
    );
  return H.NONE;
}

/** Cesium's classification for what clamped lines and fills drape onto. */
const classificationOf = (clampTo = 'both') =>
  ({
    terrain: Cesium.ClassificationType.TERRAIN,
    tiles: Cesium.ClassificationType.CESIUM_3D_TILE,
  })[clampTo] ?? Cesium.ClassificationType.BOTH;

/**
 * A distance curve as Cesium's, or undefined. Cesium's curves hold the same
 * end values but ease between them (not linearly, as the contract's do):
 * points and icons draw them as Cesium's own entities always have. A curve
 * whose far end is not past its near one is left out.
 */
const nearFarOf = (curve) =>
  // One that ends where it starts is no curve, which Cesium refuses.
  curve && curve.far > curve.near
    ? new Cesium.NearFarScalar(
        curve.near,
        curve.nearValue,
        curve.far,
        curve.farValue,
      )
    : undefined;

/** Whether a `displayRange` shows anything: `[near, far)` is not empty. */
const displayable = (range) => !range || range[1] > range[0];

/**
 * A `displayRange` as Cesium's, or undefined for none (or an empty one).
 * Cesium still shows an item at exactly its far distance.
 */
const displayConditionOf = (range) =>
  range && displayable(range)
    ? new Cesium.DistanceDisplayCondition(range[0], range[1])
    : undefined;

/**
 * `columns` on a set drawn from items: column `i` is row `ids[i]`, the item
 * of that id the set holds with the columns' fields over it (`pos`,
 * `course`, `show`, `scale`, `alpha`, `color` as 0..1, `meta`). Rows not
 * named are gone, as `set` replaces every item.
 * @param {import('../contract/draw').Columns} columns
 * @param {Map<string, object>} items
 */
export function columnRows(columns, items) {
  const {
    positions: p,
    courses,
    shown,
    scales,
    alphas,
    colors,
    meta,
  } = columns;
  return columns.ids.map((id, i) => {
    const key = String(id);
    const row = { ...(items.get(key) ?? { id: key }) };
    if (p) row.pos = { x: p[i * 3], y: p[i * 3 + 1], z: p[i * 3 + 2] };
    if (courses) row.course = courses[i];
    if (shown) row.show = shown[i] !== 0;
    if (scales) row.scale = scales[i];
    if (alphas) row.alpha = alphas[i];
    if (colors) row.color = [0, 1, 2, 3].map((k) => colors[i * 4 + k] / 255);
    if (meta) row.meta = meta[i];
    return row;
  });
}

/**
 * Cesium's point blending for a set's `blend`: additive ones are built
 * translucent, a command a set, and added where they draw (`setBlend.js`).
 */
const pointBlendOf = (blend) =>
  ({
    opaque: Cesium.BlendOption.OPAQUE,
    translucent: Cesium.BlendOption.TRANSLUCENT,
    additive: Cesium.BlendOption.TRANSLUCENT,
  })[blend] ?? Cesium.BlendOption.OPAQUE_AND_TRANSLUCENT;

/**
 * Ground fills of a set that never takes part in picks (`pickable: false`).
 * `allowPicking: false` drops their ids, but a ground primitive still draws
 * its stencil in the pick pass, which would erase picks of ground geometry
 * under it; these skip the pick pass altogether.
 */
class UnpickableGroundPrimitive extends Cesium.GroundPrimitive {
  update(frameState) {
    if (!frameState.passes.pick) super.update(frameState);
  }
}

/**
 * Images an icon set's collection may hold, or twice those it draws when
 * that is more, before it is built anew holding only those it draws.
 */
/**
 * A static batch of lines (`settleLines`): a build that fails keeps its
 * error and draws nothing, where a primitive would throw it every frame.
 */
class StaticLines extends Cesium.Primitive {
  update(frameState) {
    if (this.failed) return;
    try {
      super.update(frameState);
    } catch (error) {
      this.failed = error;
    }
  }
}

const MAX_SPARE_IMAGES = 64;

const ANCHORS = {
  center: Cesium.VerticalOrigin.CENTER,
  bottom: Cesium.VerticalOrigin.BOTTOM,
  top: Cesium.VerticalOrigin.TOP,
};

/** The longest straight step of a geodesic line, metres: a degree of arc. */
const GEODESIC_STEP_M =
  Cesium.Ellipsoid.WGS84.maximumRadius * Cesium.Math.RADIANS_PER_DEGREE;
/** The fewest straight steps a geodesic line is drawn in. */
const GEODESIC_LINE_STEPS = 64;

/** The `flow` line material's type. */
const FLOW_MATERIAL = 'DrawFlowLine';

/**
 * Along the line (`st.s`, 0 at its start, 1 at its end) the pattern repeats
 * `repeat` times, each cell lit for its first `duty`, scrolled toward the
 * end by `time * speed` cells; between the dashes the line stays faintly
 * drawn, and the lit cells glow.
 */
const FLOW_SOURCE = `
czm_material czm_getMaterial(czm_materialInput materialInput) {
  czm_material m = czm_getDefaultMaterial(materialInput);
  float s = materialInput.st.s;
  float flow = fract(s * repeat - time * speed);
  float on = smoothstep(duty + 0.08, duty - 0.08, flow);
  float a = max(on, 0.18);
  m.diffuse = color.rgb;
  m.emission = color.rgb * on * 0.9;
  m.alpha = color.a * a;
  return m;
}`;

const SPLIT_MATERIAL = 'DrawSplitLine';

/**
 * Along the line (`st.s`, 0 at its start, 1 at its end, by length on the
 * ground) `color` from `splitAt` on and `behind` before it (`direction`
 * -1: the other way); across it (`st.t`) the outer `rimFraction` in all is
 * each colour's shade.
 */
const SPLIT_SOURCE = `
czm_material czm_getMaterial(czm_materialInput materialInput) {
  czm_material m = czm_getDefaultMaterial(materialInput);
  float s = materialInput.st.s;
  bool before = direction > 0.0 ? s < splitAt : s > splitAt;
  vec4 c = before ? behind : color;
  bool rim = abs(materialInput.st.t - 0.5) > 0.5 - rimFraction * 0.5;
  m.diffuse = czm_gammaCorrect(rim ? c.rgb * rimShade : c.rgb);
  m.alpha = c.a;
  return m;
}`;

/**
 * How finely a clamped ellipse with an image fill is cut, radians, so an
 * image's round edge (a zone's rim) runs round.
 */
const IMAGE_ELLIPSE_GRANULARITY = Cesium.Math.toRadians(0.08);

/**
 * An image fill's material. The image carries its own alpha, so it draws in
 * the translucent pass whatever its colour, as the entities' image
 * materials did.
 */
function imageMaterial(image, repeat = [1, 1]) {
  // Typed first and given its uniforms after, as `Material.fromType` does:
  // the image loads when first drawn, not here.
  const material = new Cesium.Material({
    fabric: { type: 'Image' },
    translucent: true,
  });
  material.uniforms.image = image;
  material.uniforms.repeat = new Cesium.Cartesian2(...repeat);
  return material;
}

/**
 * A shape's `animate`, checked: the Cesium renderer pulses alpha, forever.
 * Null for a shape that does not pulse.
 */
function pulseOf(item) {
  const pulse = item.animate;
  if (!pulse) return null;
  if (pulse.property !== 'alpha' || pulse.repeat !== undefined)
    throw new Error('the Cesium renderer pulses alpha only, forever');
  if (
    !Number.isFinite(pulse.from) ||
    !Number.isFinite(pulse.to) ||
    !(pulse.periodMs > 0 && Number.isFinite(pulse.periodMs))
  )
    throw new Error(
      'the Cesium renderer pulses between finite alphas, over a positive period',
    );
  return pulse;
}

/**
 * A pulse's alpha now: a sine between `from` and `to` on the wall clock,
 * `periodMs` a swing and back, at their middle at each whole period.
 * @param {{from: number, to: number, periodMs: number}} pulse
 * @param {number} now
 */
export function pulseAlpha(pulse, now) {
  const turn = pulse.periodMs > 0 ? (2 * Math.PI * now) / pulse.periodMs : 0;
  return pulse.from + (pulse.to - pulse.from) * (0.5 + 0.5 * Math.sin(turn));
}

/**
 * How much of a set's motion clock passes before its draped lines in the
 * sky's frame are draped again where the sky has turned to (the Earth turns
 * about 465 m at the equator in a second).
 */
export const DRAPED_INERTIAL_STEP_MS = 1000;

/** The line styles the port drapes. */
const DRAPED_STYLES = new Set([
  'solid',
  'glow',
  'dash',
  'flow',
  'arrow',
  'pattern',
  'split',
]);

// Whether Cesium's approximate terrain heights have been asked for.
let terrainHeightsAsked = false;

/**
 * Whether a ground polyline can be built in the frame it is made: Cesium
 * needs its approximate terrain heights loaded for that. The first time
 * one is wanted they are asked for (as Cesium's entities ask, which then
 * build those lines the same way); until they load, false.
 */
function groundSyncs() {
  if (Cesium.ApproximateTerrainHeights.initialized) return true;
  if (!terrainHeightsAsked) {
    terrainHeightsAsked = true;
    try {
      Cesium.GroundPolylinePrimitive.initializeTerrainHeights().catch(() => {});
    } catch {
      // Nowhere to load them from: such lines are rebuilt as before.
    }
  }
  return false;
}

/** The prefix of a revealed line's material types, one per style kind. */
const REVEAL_MATERIAL = 'DrawRevealLine';

/**
 * A line drawn only up to `reveal` along its texture (`st.s`, 0 at its
 * start, 1 at its end), in its own style past that: the rest is discarded,
 * so it neither draws nor picks.
 */
const REVEAL_SOURCE = `
czm_material czm_getMaterial(czm_materialInput materialInput) {
  if (materialInput.st.s > reveal) discard;
  return revealed;
}`;

/**
 * Where along a drawn line's texture its first `fraction` of length ends,
 * for the reveal material. A ground polyline's texture runs along its
 * length; a polyline's runs evenly per vertex, so `positions` (as drawn)
 * map the length onto it. Nothing past 0, everything from 1.
 * @param {number} fraction
 * @param {Array<{x: number, y: number, z: number}>} [positions]
 */
export function revealUniform(fraction, positions) {
  if (!(fraction > 0)) return -1;
  if (fraction >= 1) return 2;
  if (!positions) return fraction;
  // As a polyline draws them: neighbours at one place are one vertex.
  positions = Cesium.arrayRemoveDuplicates(
    positions,
    Cesium.Cartesian3.equalsEpsilon,
  );
  const at = alongLength(positions, fraction);
  return at ? (at.index + at.t) / (positions.length - 1) : 2;
}

/**
 * The material a line's style draws with, inside the age and reveal
 * materials wrapped round it.
 */
function styleMaterial(material) {
  let drawn = material;
  while (drawn.materials?.aged || drawn.materials?.revealed)
    drawn = drawn.materials.aged ?? drawn.materials.revealed;
  return drawn;
}

/** A line's material inside its age material: the one a reveal is set on. */
const unaged = (material) => material.materials?.aged ?? material;

/** The prefix of an age-faded line's material types (`LineItem.ageFade`). */
const AGE_MATERIAL = 'DrawAgedLine';

/** Points an age texture's row holds; a longer line takes more rows. */
const AGE_TEXTURE_WIDTH = 1024;

/**
 * A line faded with the age of its points (`LineItem.ageFade`), in its own
 * style otherwise. `ages` holds a texel a drawn point: where along the
 * line's texture it lies (`st.s`) and its time, seconds after `ageNow`'s
 * zero. A polyline's texture runs evenly per vertex, so its point is found
 * at once; a ground polyline's runs along its length (`ageByLength`), so
 * its point is searched for. Its time runs evenly to the next point's, and
 * its recency eases the alpha (smoothstep to `ageAlphaFloor`, recency
 * squared to `ageSquaredFloor` where that is not negative) and the width
 * (to `ageWidthFloor` of it, about its middle: outside it is discarded, so
 * it neither draws nor picks). With a window (`ageShow`, `LineAgeFade.showMs`,
 * seconds; negative, no older bound; 0, none) a fragment whose time is after
 * now, or older than the window, is discarded too.
 */
const AGE_SOURCE = `
vec4 drawAgeTexel(float i) {
  float row = floor(i / ageWidth);
  return texture(ages, vec2((i - row * ageWidth + 0.5) / ageWidth, (row + 0.5) / ageRows));
}

czm_material czm_getMaterial(czm_materialInput materialInput) {
  float s = clamp(materialInput.st.s, 0.0, 1.0);
  float last = max(ageCount - 1.0, 0.0);
  float lo = 0.0;
  float hi = last;
  float u = 0.0;
  if (ageByLength > 0.5) {
    for (int k = 0; k < 24; k++) {
      if (hi - lo <= 1.0) break;
      float mid = floor((lo + hi) * 0.5);
      if (drawAgeTexel(mid).r <= s) lo = mid;
      else hi = mid;
    }
    vec2 a = drawAgeTexel(lo).rg;
    vec2 b = drawAgeTexel(hi).rg;
    u = b.r > a.r ? clamp((s - a.r) / (b.r - a.r), 0.0, 1.0) : 0.0;
  } else {
    float f = s * last;
    lo = min(floor(f), max(last - 1.0, 0.0));
    hi = min(lo + 1.0, last);
    u = clamp(f - lo, 0.0, 1.0);
  }
  float when = mix(drawAgeTexel(lo).g, drawAgeTexel(hi).g, u);
  if (ageShow != 0.0 && (when > ageNow || (ageShow > 0.0 && ageNow - when > ageShow)))
    discard;
  float recency = 1.0 - clamp((ageNow - when) / ageWindow, 0.0, 1.0);
  float fade = mix(ageAlphaFloor, 1.0, smoothstep(0.0, 1.0, recency));
  if (ageSquaredFloor >= 0.0)
    fade *= mix(ageSquaredFloor, 1.0, recency * recency);
  float width = max(mix(ageWidthFloor, 1.0, recency), 0.001);
  float across = (materialInput.st.t - 0.5) / width;
  if (abs(across) > 0.5) discard;
  materialInput.st.t = across + 0.5;
  czm_material m = aged;
  m.alpha *= fade;

  return m;
}`;

/**
 * What an age-faded line's material draws from: a texel a drawn point (see
 * `AGE_SOURCE`), packed four floats each (where along the line, its time in
 * seconds after `base`, and two unused), `width` to a row; and the fade's
 * uniforms. `points` are the line as drawn and `times` theirs; a polyline
 * drops a point at the place of the one before it, as Cesium does, and
 * takes the rest evenly along its texture; `byLength`, the points lie along
 * it by their distance over the ellipsoid, as a ground polyline's texture
 * runs. `base` is the newest time, so the times a texel holds are small.
 * `windowed`, the line draws only within its `showMs` of now (`ageShow`).
 * @param {Array<{x: number, y: number, z: number}>} points
 * @param {ArrayLike<number>} times Epoch ms, one a point.
 * @param {import('../contract/draw').LineAgeFade} fade
 * @param {boolean} [byLength]
 * @param {boolean} [windowed]
 */
export function lineAgeData(
  points,
  times,
  fade,
  byLength = false,
  windowed = false,
) {
  let kept = Array.from(times);
  let along = points;
  if (!byLength) {
    const removed = [];
    Cesium.arrayRemoveDuplicates(
      points,
      Cesium.Cartesian3.equalsEpsilon,
      false,
      removed,
    );
    if (removed.length) {
      const gone = new Set(removed);
      kept = kept.filter((_, i) => !gone.has(i));
      along = points.filter((_, i) => !gone.has(i));
    }
  }
  const count = kept.length;
  const fractions = new Float64Array(count);
  if (byLength) {
    let total = 0;
    let previous = null;
    for (let i = 0; i < count; i++) {
      const here = Cesium.Cartographic.fromCartesian(along[i]);
      if (previous && here)
        total += new Cesium.EllipsoidGeodesic(previous, here).surfaceDistance;
      fractions[i] = total;
      if (here) previous = here;
    }
    for (let i = 0; i < count; i++)
      fractions[i] = total > 0 ? fractions[i] / total : 0;
  } else
    for (let i = 0; i < count; i++)
      fractions[i] = count > 1 ? i / (count - 1) : 0;
  let base = -Infinity;
  for (const time of kept) if (time > base) base = time;
  if (!Number.isFinite(base)) base = 0;
  const width = Math.max(1, Math.min(count, AGE_TEXTURE_WIDTH));
  const rows = Math.max(1, Math.ceil(count / width));
  const data = new Float32Array(width * rows * 4);
  for (let i = 0; i < count; i++) {
    data[i * 4] = fractions[i];
    data[i * 4 + 1] = (kept[i] - base) / 1000;
  }
  return {
    data,
    width,
    rows,
    count,
    base,
    uniforms: {
      ageCount: count,
      ageWidth: width,
      ageRows: rows,
      ageByLength: byLength ? 1 : 0,
      ageWindow: fade.windowMs / 1000,
      ageAlphaFloor: fade.alphaFloor,
      ageSquaredFloor: fade.squaredAlphaFloor ?? -1,
      ageWidthFloor: fade.widthFloor ?? 1,
      ageShow: showUniform(windowed ? fade.showMs : undefined),
    },
  };
}

/**
 * A window's `ageShow` uniform: its seconds; -1 for an endless one, cut at
 * now alone; 0 for none.
 * @param {number|undefined} showMs
 */
const showUniform = (showMs) =>
  showMs === undefined ? 0 : Number.isFinite(showMs) ? showMs / 1000 : -1;

/**
 * A line's `ageFade`, checked: one finite time a position, over a positive
 * window, its floors from 0 to 1, and a `showMs` positive where it has one.
 * Refused otherwise.
 * @param {import('../contract/draw').LineItem} item
 */
function checkAgeFade(item) {
  const fade = item.ageFade;
  if (fade == null) return;
  const count =
    item.positions instanceof Float64Array
      ? item.positions.length / 3
      : item.positions.length;
  const floor = (value) => value === undefined || (value >= 0 && value <= 1);
  if (
    !fade.times ||
    fade.times.length !== count ||
    !Array.prototype.every.call(fade.times, Number.isFinite) ||
    !(fade.windowMs > 0 && Number.isFinite(fade.windowMs)) ||
    !(fade.alphaFloor >= 0 && fade.alphaFloor <= 1) ||
    !floor(fade.squaredAlphaFloor) ||
    !floor(fade.widthFloor) ||
    !(fade.showMs === undefined || fade.showMs > 0)
  )
    throw new TypeError(
      'a line fades with one finite time a position, over a positive window, with floors from 0 to 1, shown over a positive span',
    );
}

/**
 * Make a material of `fabric`'s type on its own once, before one is a part
 * of a composite material. Cesium keeps a type's uniform names, for all the
 * page's materials of that type, from the first it makes, and a part has
 * them numbered as the composite's: a plain material of that type made
 * later then fails in a polyline collection (`material._uniforms[uniform]
 * is not a function`), stopping the frame.
 * @param {{type: string}} fabric
 */
function ownUniforms(fabric) {
  if (!Cesium.Material._uniformList[fabric.type])
    new Cesium.Material({ fabric }).destroy();
}

/**
 * A line's `breaks`, checked: strictly increasing whole position indices,
 * each past the first position and within the line (`0 < i < count`).
 * Refused otherwise.
 * @param {import('../contract/draw').LineItem} item
 */
function checkBreaks(item) {
  const breaks = item.breaks;
  if (breaks == null) return;
  const count =
    item.positions instanceof Float64Array
      ? item.positions.length / 3
      : item.positions.length;
  let previous = 0;
  const fits =
    (Array.isArray(breaks) || breaks instanceof Uint32Array) &&
    Array.prototype.every.call(breaks, (at) => {
      const ok = Number.isInteger(at) && at > previous && at < count;
      previous = at;
      return ok;
    });
  if (!fits)
    throw new TypeError(
      'a line breaks at whole, increasing position indices after its first position and before its end',
    );
}

/**
 * The `flow` lines' clock, seconds, for a line flowing at `speed` cells a
 * second: wrapped to one cell's time, which draws the same dashes, so the
 * single-precision uniform never runs out of digits over a long session.
 */
function flowTime(speed) {
  if (!speed) return 0;
  const cells = (performance.now() / 1000) * speed;
  return (cells - Math.floor(cells)) / speed;
}

/**
 * Milliseconds a line set's lines stay unchanged before the solid ones
 * among them settle into a static batch (`settleLines`), and a shape set's
 * moved shapes go back into its batches (`settleShapes`). Timed, so a
 * batch builds as soon at every refresh rate.
 */
export const SETTLE_MS = 500;

/**
 * Fewer lines than this left in the collection beside a static batch wait
 * `LONG_SETTLE_MS` to settle, as rebuilding the batch for them costs
 * more than drawing them in the collection for a while.
 */
export const FEW_LOOSE_LINES = 64;
export const LONG_SETTLE_MS = 5000;

/** A line set's settling: waiting the short time, the long one, or done. */
const SETTLE_SHORT = 0;
const SETTLE_LONG = 1;
const SETTLE_DONE = 2;

/**
 * Clamped fills a set draws alone at most, each where it last moved
 * (`moveShape`): an upsert that would draw more alone rebuilds the set's
 * batches instead, as each costs a primitive and is built in the frame.
 */
export const MOVING_SHAPES = 16;

/** What `syncIcons` did: icons added or removed, or only changed in place. */
const ICONS_CHANGED = 'changed';
const ICONS_KEPT = 'kept';

/** What `patchPoints` did: points added too, or only changed in place. */
const POINTS_ADDED = 'added';
const POINTS_KEPT = 'kept';

/** Whether a set's GPU icons move on in the frames that follow. */
const animating = (record) => record.gpu?.animating();

/**
 * The draw port over `scene`, and what the other ports read of it: the live
 * sets by id, a version that changes with what height queries see through
 * in them, the scene's 3D tilesets and
 * the clamp-state watch the frame loop runs after each draw.
 * @param {{scene: object, report: (error: unknown) => void,
 *   capabilities?: ReadonlySet<string>,
 *   requestRender?: (reason: string) => void,
 *   date?: () => number,
 *   now?: () => number}} options `capabilities` gate
 *   the GPU icon sets' members (by default they all are); `requestRender`,
 *   the frame port's, asks for the frames a GPU icon set needs on its own
 *   (its images packed), under the reason `icons:<set id>` (by default the
 *   scene's, with no reason); `date`, the epoch ms a `live` motion clock
 *   reads (by default the system clock's); `now`, the milliseconds settling
 *   waits are timed by (`performance.now` by default).
 */
export function createCesiumDraw({
  scene,
  report,
  capabilities = new Set(GPU_ICON_CAPABILITIES),
  requestRender: requestFrame = null,
  date = null,
  now = () => performance.now(),
}) {
  const sets = new Map();
  // Lines fade with the age of their points (`LineItem.ageFade`).
  const ageFades = capabilities.has('lineAgeFade');
  // And draw only within a span of the scene clock (`LineAgeFade.showMs`).
  const timeWindows = ageFades && capabilities.has('lineTimeWindow');
  // And as several runs, not joined across their breaks (`LineItem.breaks`).
  const lineBreaks = capabilities.has('lineBreaks');
  // Fields share the sets' ids.
  const fieldPart = createCesiumFields({
    scene,
    report,
    resolveImage: (ref) =>
      typeof ref?.atlas === 'string'
        ? (atlases.get(ref.atlas)?.[ref.slot] ?? ref)
        : ref,
  });
  let setSeq = 0;
  // Bumped whenever what height queries see through may have changed: a
  // set made, rebuilt, restyled or gone, or items added or removed (icons
  // changed in place keep their pick ids, so they do not bump it).
  let setsVersion = 0;
  // A viewer can be destroyed before the layers drawing on it
  // let their sets go; those calls then have nothing left to do.
  const live = () => !scene.isDestroyed?.();
  const requestRender = () => {
    if (live()) scene.requestRender();
  };
  // Once the port is disposed (its renderer destroyed), every set does
  // nothing, and so does a set asked for after that.
  let portDisposed = false;

  /** A disposed set's listeners hear nothing more, even mid-delivery. */
  function silence(record) {
    record.listeners.ready.clear();
    record.listeners.loadFailed.clear();
  }

  function makeSet(kind, spec, build) {
    if (sets.has(spec.id) || fieldPart.has(spec.id))
      throw new Error(`a set with id ${spec.id} is live`);
    const items = new Map();
    const listeners = {
      ready: listenerList(report),
      loadFailed: listenerList(report),
    };
    const record = {
      kind,
      spec,
      items,
      listeners,
      host: null,
      // When it was made: `drawOrder`'s ties keep that order.
      seq: (setSeq += 1),
      pickIds: [],
      // What it drew before its ground primitives were ready, still shown.
      retiring: null,
      pending: null,
      // The host's ground primitives, and the collection beside them.
      ground: null,
      own: null,
      // Each point or icon at its position, for the horizon cull.
      placed: [],
    };
    // Each build records its items' pick ids, for height queries to see
    // through.
    const rebuild = () => {
      record.pickIds = [];
      record.placed = [];
      record.patchable = null;
      record.pointHost = null;
      // The lines as the host this build replaces draws them.
      record.drawnParts = record.lineParts;
      record.lineParts = null;
      build(record);
      setsVersion += 1;
    };
    record.rebuild = rebuild;
    // A set whose owner asks for its frames is changed in place without
    // asking for one: the owner writes it as a frame begins (asking then
    // would draw that frame twice), or its next frame draws the change.
    const ownerFrames = () => spec.motionClock?.frames === 'owner';
    // Changed in place: what height queries see through may have changed.
    const patched = () => {
      setsVersion += 1;
      if (!ownerFrames()) requestRender();
    };
    // Icons changed in place: height queries see through the sets' pick
    // ids, which an icon keeps, so only icons added or gone change them.
    const iconsPatched = (synced) => {
      if (synced === ICONS_CHANGED) setsVersion += 1;
      if (!ownerFrames()) requestRender();
    };
    // A shape's pulse the renderer cannot run is refused before anything
    // changes.
    const checkPulses = (list) => {
      if (kind === 'lines')
        for (const item of list) {
          if (item.style?.kind === 'split' && item.mode !== 'draped')
            throw new TypeError('a split line is draped');
          if (ageFades) checkAgeFade(item);
          if (lineBreaks) checkBreaks(item);
        }
      if (kind !== 'shapes') return;
      for (const item of list) pulseOf(item);
      if (list.some((item) => item.animate)) record.mayPulse = true;
    };
    const handle = {
      id: spec.id,
      set(list) {
        checkPulses(list);
        if (onGpu(record, list, true)) {
          items.clear();
          for (const item of list) items.set(item.id, item);
          record.gpu.sync();
          return patched();
        }
        items.clear();
        for (const item of list) items.set(item.id, item);
        // Icons are changed where they are, when they can be.
        const synced = syncIcons(record, items.keys(), true);
        if (synced) return iconsPatched(synced);
        rebuild();
        requestRender();
      },
      upsert(list) {
        checkPulses(list);
        if (onGpu(record, list)) {
          for (const item of list) items.set(item.id, item);
          record.gpu.write(list);
          return patched();
        }
        // Icons drawn already, with the images they are drawn with, each
        // changed where it is.
        if (patchDrawnIcons(record, list)) return iconsPatched(ICONS_KEPT);
        // Points restyled, moved or added keep the pick ids they had, so
        // only points added change what height queries see through.
        const points = patchPoints(record, list);
        if (points) {
          for (const item of list) items.set(item.id, item);
          if (points === POINTS_ADDED) setsVersion += 1;
          requestRender();
          return;
        }
        // Models are changed where they are; moved or restyled they keep
        // their pick ids, so only models added change what height queries
        // see through.
        if (kind === 'models') {
          const added = modelSets.upsert(record, list);
          for (const item of list) items.set(item.id, item);
          if (added) setsVersion += 1;
          requestRender();
          return;
        }
        // Lines that only change how they show or where an undraped one
        // runs, and clamped shapes that only show or hide, or a few colour
        // fills that only move (`moveShape`), are changed where they are.
        if (
          patchLines(record, list) ||
          patchShapes(record, list) ||
          (kind === 'quads' && quadSets.upsert(record, list)) ||
          (kind === 'meshes' && meshSets.upsert(record, list))
        ) {
          for (const item of list) items.set(item.id, item);
          if (kind === 'lines') noteFlows(record);
          setsVersion += 1;
          requestRender();
          return;
        }
        for (const item of list) items.set(item.id, item);
        const synced = syncIcons(
          record,
          list.map((item) => item.id),
        );
        if (synced) return iconsPatched(synced);
        rebuild();
        requestRender();
      },
      remove(ids) {
        for (const id of ids) items.delete(id);
        if (removePoints(record, ids)) return patched();
        if (record.gpu) {
          record.gpu.drop(ids);
          return patched();
        }
        const synced = syncIcons(record, []);
        if (synced) return iconsPatched(synced);
        rebuild();
        requestRender();
      },
      clear() {
        items.clear();
        if (record.gpu) {
          record.gpu.sync();
          return patched();
        }
        const synced = syncIcons(record, []);
        if (synced) return iconsPatched(synced);
        rebuild();
        requestRender();
      },
      setOptions(options) {
        // A live clock's new delay only: every frame reads the clock from
        // the spec, so nothing is rebuilt or restyled (a layer moves its
        // display delay a little every frame).
        if (
          Object.keys(options).every((key) => key === 'motionClock') &&
          options.motionClock?.kind === 'live' &&
          spec.motionClock?.kind === 'live'
        ) {
          spec.motionClock = options.motionClock;
          // A set whose owner asks for its frames reads the new delay in
          // the owner's next one: the delay alone asks for none.
          if (options.motionClock.frames !== 'owner') requestRender();
          return;
        }
        // Refused, changing nothing, where icons on the GPU cannot take it
        // (all of them, for billboards told to recede, which go onto it).
        const toGpu =
          kind === 'icons' && !record.gpu && Boolean(options.recede);
        if (record.gpu) gpu.check([], { ...spec, ...options });
        else if (toGpu) gpu.check(items.values(), { ...spec, ...options });
        const culled = spec.horizonCull;
        const clampTo = spec.clampTo;
        const blend = spec.blend;
        const pickable = spec.pickable !== false;
        const drawOrder = spec.drawOrder ?? 0;
        Object.assign(spec, options);
        // What clamped items clamp to, how points blend, and whether ground
        // primitives pick, are built into them. Models clamp nothing, only
        // points and icons build in the blend (every set's commands are
        // turned to it each frame, `setBlend.js`), and only shapes and lines have ground
        // primitives: other kinds are not rebuilt for those (models would
        // load again).
        if (
          (kind !== 'models' && spec.clampTo !== clampTo) ||
          ((kind === 'points' || kind === 'icons') && spec.blend !== blend) ||
          ((kind === 'shapes' ||
            kind === 'lines' ||
            kind === 'quads' ||
            kind === 'meshes') &&
            (spec.pickable !== false) !== pickable)
        )
          rebuild();
        // A set that stops picking lets its old ground go now: still drawn
        // while the new builds, it would keep hiding the ground from picks.
        if (pickable && spec.pickable === false) retire(record);
        if (toGpu) {
          onGpu(record, [], true, true);
          record.gpu.sync();
        }
        record.gpu?.restyle();
        if (kind === 'models') modelSets.restyle(record);
        setsVersion += 1;
        showHosts(record);
        // No longer culled: what the cull hid comes back.
        if (culled && !spec.horizonCull) uncull(record);
        if ((spec.drawOrder ?? 0) !== drawOrder) orderHosts(true);
        requestRender();
      },
      size: () => items.size,
      get show() {
        return spec.show !== false;
      },
      set show(value) {
        spec.show = value;
        showHosts(record);
        requestRender();
      },
      on(event, cb) {
        return listeners[event]?.on(cb) ?? (() => {});
      },
      dispose() {
        if (record.host && !record.host.isDestroyed?.() && live())
          scene.primitives.remove(record.host);
        record.host = null;
        retire(record);
        // A newer set under the same id is not this handle's to remove.
        if (sets.get(spec.id) === record) sets.delete(spec.id);
        setsVersion += 1;
        requestRender();
      },
    };
    // `columns`: column updates of an icon set, on the GPU.
    if (kind === 'icons' && capabilities.has('columns'))
      handle.setColumns = (columns) => {
        onGpu(record, [], false, true);
        record.gpu.columns(columns);
        patched();
      };
    // Any other set takes columns as the rows they make, replacing its items.
    else if (capabilities.has('columns'))
      handle.setColumns = (columns) => handle.set(columnRows(columns, items));
    // A clustered set clusters again in the next frame drawn after a change
    // (`setColumns` too: set before this, so it is wrapped with the rest).
    for (const name of [
      'set',
      'upsert',
      'remove',
      'clear',
      'setOptions',
      'setColumns',
    ]) {
      const call = handle[name];
      if (!call) continue;
      handle[name] = (...args) => {
        record.clusterKey = null;
        return call(...args);
      };
    }
    const dispose = handle.dispose;
    handle.dispose = () => {
      dropClusters(record);
      dispose();
    };
    // Draped lines in the sky's frame are draped where the sky is: held as
    // given, drawn turned into the fixed frame, and draped again each
    // `DRAPED_INERTIAL_STEP_MS` of their motion clock (`beforeRender`).
    if (kind === 'lines') {
      const { set, upsert, remove, clear } = handle;
      record.inertialDraped = new Map();
      const fixedNow = (list) => {
        const ms = motionMs(record);
        let axes = null;
        const given = new Map();
        const drawn = list.map((item) => {
          if (item.frame !== 'inertial' || item.mode !== 'draped') return item;
          given.set(item.id, item);
          axes ??= temeToPseudoFixed(ms);
          return fixedLine(item, axes);
        });
        return { drawn, given, ms };
      };
      const keep = (list, given, ms) => {
        for (const item of list) record.inertialDraped.delete(item.id);
        for (const [id, item] of given) record.inertialDraped.set(id, item);
        if (given.size) record.inertialTurnMs = ms;
      };
      handle.set = (list) => {
        const { drawn, given, ms } = fixedNow(list);
        const result = set(drawn);
        record.inertialDraped.clear();
        keep(list, given, ms);
        return result;
      };
      handle.upsert = (list) => {
        const { drawn, given, ms } = fixedNow(list);
        const result = upsert(drawn);
        keep(list, given, ms);
        return result;
      };
      handle.remove = (ids) => {
        const result = remove(ids);
        for (const id of ids) record.inertialDraped.delete(id);
        return result;
      };
      handle.clear = () => {
        const result = clear();
        record.inertialDraped.clear();
        return result;
      };
      record.drapeInertial = () => {
        if (!record.inertialDraped.size) return;
        const ms = motionMs(record);
        if (Math.abs(ms - record.inertialTurnMs) < DRAPED_INERTIAL_STEP_MS)
          return;
        handle.upsert([...record.inertialDraped.values()]);
      };
    }
    // A disposed set does nothing on later calls: one would draw what
    // nothing removes.
    record.disposed = portDisposed;
    for (const name of [
      'set',
      'upsert',
      'remove',
      'clear',
      'setOptions',
      'setColumns',
    ]) {
      const call = handle[name];
      if (!call) continue;
      handle[name] = (...args) => {
        if (!record.disposed) return call(...args);
      };
    }
    const { set: showSet } = Object.getOwnPropertyDescriptor(handle, 'show');
    Object.defineProperty(handle, 'show', {
      get: () => spec.show !== false,
      set(value) {
        if (!record.disposed) showSet.call(handle, value);
      },
      enumerable: true,
    });
    const on = handle.on;
    handle.on = (event, cb) => (record.disposed ? () => {} : on(event, cb));
    const disposeOnce = handle.dispose;
    handle.dispose = () => {
      if (record.disposed) return;
      record.disposed = true;
      // A listener that disposes the set stops the rest of that delivery.
      silence(record);
      disposeOnce();
    };
    if (record.disposed) return handle;
    sets.set(spec.id, record);
    setsVersion += 1;
    return handle;
  }

  const gpu = createGpuIcons({
    scene,
    capabilities,
    date,
    toColor,
    imageOf: (record, image) => iconImage(record, image),
    peekImage: (image) => atlases.get(image.atlas)?.[image.slot],
    requestRender: (reason) => {
      if (!live()) return;
      if (requestFrame) requestFrame(reason);
      else scene.requestRender();
    },
  });

  /**
   * Whether an icon set draws `list` on the GPU: it already does, or the
   * items (or `force`, for columns) need it to, when its billboards give way
   * to a GPU host in their place. Refuses, changing nothing, what the GPU
   * cannot draw: of `list`, and, unless `replacing` them, of the items the
   * set already holds.
   */
  function onGpu(record, list, replacing = false, force = false) {
    if (record.kind !== 'icons') return false;
    if (!record.gpu && !force && !gpu.wants(list, record.spec)) return false;
    gpu.check(list, record.spec);
    if (record.gpu) return true;
    if (!replacing) gpu.check(record.items.values(), record.spec);
    record.gpu = gpu.attach(record);
    record.billboards = null;
    record.billboardHost = null;
    record.placed = [];
    // Icons on the GPU stay out of offscreen passes: height queries never
    // see them, so there is nothing to see through.
    record.pickIds = [];
    replaceHost(record, record.gpu.host);
    return true;
  }

  function pickId(record, item) {
    const id = {
      set: record.spec.id,
      id: item.id,
      meta: item.meta,
    };
    record.pickIds.push(id);
    return id;
  }

  /**
   * Draw `host` for the set in place of what it drew. With `ground` (its
   * ground primitives), the new host's ground primitives stay hidden and
   * the old host keeps drawing until every one is ready, then they swap in
   * one frame, as the entities' ground batches do; a host still waiting
   * when the next one comes is dropped. With `groundShown` false, the new
   * ground primitives show nothing yet (all their items are hidden), so
   * the old host goes at once rather than wait for them.
   */
  function replaceHost(
    record,
    host,
    ground = null,
    own = null,
    groundShown = true,
  ) {
    const old = record.host;
    const waiting = ground?.length ? ground : null;
    // The set keeps its place among the scene's primitives: a rebuild draws
    // where it drew, so stacking (and picks among overlapping items) does
    // not change with each update. Its place is under whatever was above
    // the host it replaces (indices shift as older hosts go).
    const slot = old ? slotOf(old) : -1;
    const above =
      slot >= 0 && slot + 1 < scene.primitives.length
        ? scene.primitives.get(slot + 1)
        : null;
    // Named for code that finds a set's host among the scene's primitives
    // (`uploadProbe.js`).
    host.drawSetId = record.spec.id;
    // `blend`: its commands turned to the set's blend each frame drawn.
    blendSetHost(record, host);
    // Only old ground primitives wait for the new ones: the rest of the old
    // host goes now, as the new host's own parts draw at once.
    if (
      old &&
      waiting &&
      groundShown &&
      !record.retiring &&
      !record.pending &&
      record.ground
    ) {
      record.retiring = old;
      if (record.own) old.remove(record.own);
    } else if (old) {
      scene.primitives.remove(old);
      // Shapes drawn alone in the host that goes show again where the host
      // still retiring draws them, until the new one is ready.
      showRetiringShapes(record);
    }
    if (!waiting || !groundShown) retire(record);
    // Hidden one by one: a hidden collection would not build them.
    if (waiting) for (const primitive of waiting) primitive.show = false;
    record.pending = waiting;
    record.ground = waiting;
    record.own = waiting ? own : null;
    record.host = host;
    const at = above ? slotOf(above) : -1;
    if (at >= 0) scene.primitives.add(host, at);
    else scene.primitives.add(host);
    showHosts(record);
    // A new set's host comes in last; it takes its place by draw order.
    if (!old) orderHosts();
  }

  /** A set's host drawn in the set's `blend`, as it is each frame. */
  function blendSetHost(record, host) {
    blendHost(host, () => record.spec.blend ?? undefined);
  }

  /**
   * `SetSpec.drawOrder`: the sets' hosts stacked in the scene's primitives
   * by their draw order. Of opaque billboards and points that skip the
   * depth test, Cesium draws the one in the earlier primitive on top (both
   * at the near plane, the later fails the depth test) and picks it, so a
   * higher order goes earlier; of one order, in the order they were made.
   * The hosts trade places among the slots they hold, so nothing else in
   * the scene moves. Nothing moves while every set is at 0 (unless an order
   * just changed, `changed`), so sets at 0 stack as they were first drawn;
   * nor while the hosts are already in order.
   * Translucent ones blend order-independently, whatever their order, and
   * items in different view frustums stack nearer frustum first.
   * @param {boolean} [changed]
   */
  function orderHosts(changed = false) {
    if (!live()) return;
    let ordered = changed;
    for (const record of sets.values())
      if ((record.spec.drawOrder ?? 0) !== 0) ordered = true;
    if (!ordered) return;
    const placed = [];
    for (const record of sets.values()) {
      if (!record.host || record.host.isDestroyed?.()) continue;
      const slot = slotOf(record.host);
      if (slot >= 0) placed.push({ record, slot });
    }
    const slots = placed.map(({ slot }) => slot).sort((a, b) => a - b);
    const wanted = [...placed].sort(
      (a, b) =>
        (b.record.spec.drawOrder ?? 0) - (a.record.spec.drawOrder ?? 0) ||
        a.record.seq - b.record.seq,
    );
    if (wanted.every(({ slot }, i) => slot === slots[i])) return;
    // Each slot, lowest first, takes its host by trading places with the
    // host in it (taken out and put back, not destroyed): what lies between
    // them, and every slot already filled, stays where it is.
    const primitives = scene.primitives;
    const destroys = primitives.destroyPrimitives;
    primitives.destroyPrimitives = false;
    try {
      wanted.forEach(({ record }, i) => {
        const to = slots[i];
        const from = slotOf(record.host);
        if (from === to) return;
        // `from` is later: the hosts still to place sit after the filled slots.
        const other = primitives.get(to);
        primitives.remove(record.host);
        primitives.add(record.host, to);
        primitives.remove(other);
        primitives.add(other, from);
      });
    } finally {
      primitives.destroyPrimitives = destroys;
    }
  }

  /** Where `primitive` is among the scene's primitives, or -1. */
  function slotOf(primitive) {
    const primitives = scene.primitives;
    const n = primitives?.length ?? 0;
    for (let i = 0; i < n; i++) if (primitives.get(i) === primitive) return i;
    return -1;
  }

  function showHosts(record) {
    const show = record.spec.show !== false;
    if (record.host) record.host.show = show;
    if (record.retiring) record.retiring.show = show;
  }

  function retire(record) {
    if (record.retiring && !record.retiring.isDestroyed?.() && live())
      scene.primitives.remove(record.retiring);
    record.retiring = null;
    record.retiringFlows = null;
    record.retiringParts = null;
    record.retiringShapeParts = null;
    record.retiringHiddenShapes = null;
  }

  /**
   * After a draw: a set whose ground primitives are all ready shows them,
   * and lets go of what drew in their place.
   */
  function swapReady() {
    for (const record of sets.values()) {
      const ground = record.pending;
      if (!ground || ground.some((p) => !p.isDestroyed() && !p.ready)) continue;
      showPending(record);
      for (const primitive of ground) primitive.show = true;
      record.pending = null;
      retire(record);
      requestRender();
    }
  }

  // The horizon cull: a point or icon past the ellipsoid's horizon from the
  // eye is hidden, as layers drawn without depth test used to do themselves.
  let occluder = null;
  function cullHorizon() {
    cullOverlayLines();
    for (const record of sets.values()) {
      if (!record.spec.horizonCull || !record.placed.length) continue;
      const horizon = horizonNow();
      if (!horizon) return;
      for (const placed of record.placed) {
        const show =
          placed.shown &&
          !placed.clustered &&
          horizon.isPointVisible(placed.position);
        if (placed.primitive.show !== show) placed.primitive.show = show;
      }
    }
  }

  /**
   * Draped lines drawn over the surface (where the scene cannot drape) show
   * while any of their ends or middle is this side of the horizon.
   */
  function cullOverlayLines() {
    let horizon;
    for (const record of sets.values()) {
      if (!record.overlayLines?.length) continue;
      horizon ??= horizonNow();
      for (const line of record.overlayLines) {
        // With no horizon (2D) every line shows as it was asked to.
        const show =
          line.shown &&
          (!horizon || line.ends.some((p) => horizon.isPointVisible(p)));
        if (line.part.deep && line.part.deep.show !== show)
          line.part.deep.show = show;
      }
    }
  }

  // --- Clusters (`cluster`) --------------------------------------------------

  /** The default cluster badge: the count on a disc. */
  const clusterBadge = (count) => ({
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><circle cx="24" cy="24" r="22" fill="#1d4f91" stroke="#ffffff" stroke-width="3"/><text x="24" y="31" font-family="sans-serif" font-size="${count > 99 ? 15 : 20}" font-weight="bold" fill="#ffffff" text-anchor="middle">${count}</text></svg>`,
  });

  /** Whether an icon set clusters now. */
  const clusters = (record) =>
    record.kind === 'icons' &&
    Boolean(record.spec.cluster) &&
    capabilities.has('cluster');

  /** Let go of a set's cluster icons, and show its members again. */
  function dropClusters(record) {
    const host = record.clusterHost;
    if (host && !host.isDestroyed() && live()) scene.primitives.remove(host);
    record.clusterHost = null;
    record.clusterState = null;
    record.clusterKey = null;
    for (const placed of record.placed) placed.clustered = false;
    record.gpu?.setClustered(new Set());
  }

  const clusterScratch = new Cesium.Cartesian2();
  /**
   * Each frame, before it draws: every clustered icon set clusters its
   * icons again where the camera moved or the set changed since it last
   * did (`ClusterSpec`), hiding the members and drawing an icon a cluster.
   */
  function clusterIcons(frameState = scene.frameState) {
    let pose;
    for (const record of sets.values()) {
      if (!clusters(record)) {
        if (record.clusterHost || record.clusterState) {
          dropClusters(record);
          for (const placed of record.placed)
            placed.primitive.show = shownNow(record, placed);
        }
        continue;
      }
      // A rebuilt collection (or the GPU's host in its place) starts afresh.
      const host = record.gpu?.host ?? record.billboardHost;
      if (!host || host.isDestroyed()) continue;
      if (host !== record.clusteredHost) {
        record.clusterState = null;
        record.clusterKey = null;
        record.clusteredHost = host;
      }
      pose ??= clusterPoseNow();
      // Rows still moving on their segments cluster again every frame (NaN,
      // a frame with no number, is never the last).
      const frameKey = record.gpu?.moving(frameState)
        ? (frameState?.frameNumber ?? NaN)
        : null;
      if (record.clusterKey === pose && record.clusterFrame === frameKey) {
        if (record.clusterHost)
          record.clusterHost.show = record.spec.show !== false;
        continue;
      }
      record.clusterKey = pose;
      record.clusterFrame = frameKey;
      reclusterIcons(record, frameState);
    }
  }

  // The eye and canvas the clusters were last measured at, and a count of
  // their changes: a set clusters again when the count it clustered at is
  // not the count now.
  const clusterPose = new Float64Array(8).fill(NaN);
  let clusterPoseVersion = 0;
  let clusterPoseAt = 0;
  let clusterPoseSame = true;
  function putClusterPose(value) {
    if (!Object.is(clusterPose[clusterPoseAt], value)) {
      clusterPoseSame = false;
      clusterPose[clusterPoseAt] = value;
    }
    clusterPoseAt += 1;
  }
  function clusterPoseNow() {
    const eye = scene.camera?.positionWC;
    const dir = scene.camera?.directionWC;
    clusterPoseAt = 0;
    clusterPoseSame = true;
    putClusterPose(eye?.x ?? NaN);
    putClusterPose(eye?.y ?? NaN);
    putClusterPose(eye?.z ?? NaN);
    putClusterPose(dir?.x ?? NaN);
    putClusterPose(dir?.y ?? NaN);
    putClusterPose(dir?.z ?? NaN);
    putClusterPose(scene.canvas?.clientWidth ?? NaN);
    putClusterPose(scene.canvas?.clientHeight ?? NaN);
    if (!clusterPoseSame) clusterPoseVersion += 1;
    return clusterPoseVersion;
  }

  /** The points a GPU set clusters: its shown rows where they are drawn. */
  function gpuClusterPoints(record, frameState, horizon) {
    const points = [];
    for (const { id, item, position } of record.gpu.drawnRows(frameState)) {
      const at = toCartesian(position);
      if (horizon && !horizon.isPointVisible(at)) continue;
      const screen = Cesium.SceneTransforms.worldToWindowCoordinates(
        scene,
        at,
        clusterScratch,
      );
      if (!screen) continue;
      points.push({
        id,
        position: at,
        screen: { x: screen.x, y: screen.y },
        pixelSize: Math.max(item.size[0], item.size[1]) * (item.scale ?? 1),
      });
    }
    return points;
  }

  function reclusterIcons(record, frameState) {
    const spec = record.spec.cluster;
    const horizon = horizonNow();
    const points = record.gpu
      ? gpuClusterPoints(record, frameState, horizon)
      : [];
    const entries = new Map();
    for (const [id, entry] of record.gpu ? [] : record.billboards) {
      const item = record.items.get(id);
      const placed = entry.placed;
      if (!item || !placed.shown) continue;
      if (horizon && !horizon.isPointVisible(placed.position)) continue;
      const screen = Cesium.SceneTransforms.worldToWindowCoordinates(
        scene,
        placed.position,
        clusterScratch,
      );
      if (!screen) continue;
      points.push({
        id,
        position: placed.position,
        screen: { x: screen.x, y: screen.y },
        pixelSize: Math.max(item.size[0], item.size[1]) * (item.scale ?? 1),
      });
      entries.set(id, entry);
    }
    const result = clusterScreenPoints({
      points,
      pixelRange: spec.pixelRange,
      minimumClusterSize: spec.minimumSize,
      viewHeight: scene.canvas?.clientHeight ?? 0,
      eyeHeight: scene.camera.positionCartographic?.height ?? 0,
      previous: record.clusterState,
      project: (position) => {
        const p = Cesium.SceneTransforms.worldToWindowCoordinates(
          scene,
          toCartesian(position),
          new Cesium.Cartesian2(),
        );
        return p ? { x: p.x, y: p.y } : null;
      },
      isOccluded: (position) =>
        horizon ? !horizon.isPointVisible(toCartesian(position)) : false,
    });
    record.clusterState = result.state;
    const inCluster = new Set(result.clusters.flatMap((c) => c.ids));
    record.gpu?.setClustered(inCluster);
    for (const placed of record.placed) placed.clustered = false;
    for (const id of inCluster) {
      const entry = entries.get(id);
      if (entry) entry.placed.clustered = true;
    }
    for (const placed of record.placed) {
      const show = shownNow(record, placed);
      if (placed.primitive.show !== show) placed.primitive.show = show;
    }
    let host = record.clusterHost;
    if (!host || host.isDestroyed()) {
      host = new Cesium.BillboardCollection({
        scene,
        blendOption: pointBlendOf(record.spec.blend),
      });
      record.clusterHost = host;
      blendSetHost(record, host);
      scene.primitives.add(host);
    }
    host.removeAll();
    host.show = record.spec.show !== false;
    for (const cluster of result.clusters) {
      const seed = record.items.get(cluster.ids[0]);
      const position = toCartesian(cluster.position);
      const given = spec.icon?.(cluster.ids.length);
      const image =
        given === undefined
          ? clusterBadge(cluster.ids.length)
          : typeof given?.atlas === 'string'
            ? atlases.get(given.atlas)?.[given.slot]
            : given;
      if (image === undefined) continue;
      const scale = seed.scale ?? 1;
      const billboard = host.add({
        position,
        width: seed.size[0] * scale,
        height: seed.size[1] * scale,
        disableDepthTestDistance: seed.disableDepthTest ?? 0,
        id: {
          set: record.spec.id,
          id: cluster.ids[0],
          get meta() {
            return record.items.get(cluster.ids[0])?.meta;
          },
          cluster: {
            ids: cluster.ids.slice(),
            position: { x: position.x, y: position.y, z: position.z },
          },
        },
      });
      if (isKeyed(image)) billboard.setImage(image.key, image.canvas);
      else billboard.image = toImage(image);
    }
  }

  /** The horizon from the eye as it is now; null where there is none (2D). */
  function horizonNow() {
    const eye = scene.camera?.positionWC;
    // The eye is ECEF in 3D only.
    if (
      !eye ||
      (scene.mode ?? Cesium.SceneMode.SCENE3D) !== Cesium.SceneMode.SCENE3D
    )
      return null;
    occluder ??= new Cesium.EllipsoidalOccluder(
      scene.globe?.ellipsoid ?? Cesium.Ellipsoid.WGS84,
      eye,
    );
    occluder.cameraPosition = eye;
    return occluder;
  }

  /**
   * Whether a point or icon updated in place shows now: past the horizon
   * of a culled set it stays hidden, even when the update comes after this
   * frame's cull (a frame listener that moves its items).
   */
  function shownNow(record, placed) {
    if (!placed.shown || placed.clustered) return false;
    if (!record.spec.horizonCull) return placed.shown;
    return horizonNow()?.isPointVisible(placed.position) ?? true;
  }

  /** Each frame, before it draws: the flow lines' clock. */
  function runFlows() {
    for (const record of sets.values()) {
      for (const material of record.flowMaterials ?? [])
        material.uniforms.time = flowTime(material.uniforms.speed);
      for (const material of record.retiringFlows ?? [])
        material.uniforms.time = flowTime(material.uniforms.speed);
    }
  }

  /** Whether a shown set shows flow lines, which draw on in later frames. */
  const flowing = () =>
    anySet((record) => record.spec.show !== false && record.flowShown);

  /** Whether any set passes `test`, without copying the sets (per frame). */
  function anySet(test) {
    for (const record of sets.values()) if (test(record)) return true;
    return false;
  }

  /** Note whether a line set shows any flow line, once its lines change. */
  function noteFlows(record) {
    record.flowShown = false;
    if (!record.flowMaterials?.length) return;
    for (const item of record.items.values())
      if (item.style?.kind === 'flow' && item.show !== false) {
        record.flowShown = true;
        return;
      }
  }

  function uncull(record) {
    for (const placed of record.placed) placed.primitive.show = placed.shown;
  }

  /** Remember a drawn point or icon for the horizon cull. */
  function place(record, primitive, position, shown) {
    const placed = { primitive, position, shown };
    record.placed.push(placed);
    return placed;
  }

  // Atlases icons name images from, by id: `{atlas, slot}` reads the slot
  // when its icon is drawn, and registering an atlas again swaps the images
  // of the icons that drew from it.
  const atlases = new Map();
  /** The blob each material or quad draws, held while it lives (`holdImage`). */
  const heldBlobs = new WeakMap();

  /**
   * An icon's image: an atlas slot read through its atlas, or undefined
   * while its atlas or slot is not registered (it draws once it is).
   */
  function iconImage(record, image) {
    if (typeof image?.atlas !== 'string') return image;
    record.atlases.add(image.atlas);
    return atlases.get(image.atlas)?.[image.slot];
  }

  /**
   * What a line pattern, a shape's fill or a quad draws: `toImage` of the
   * image, an atlas slot as the slot holds it when it is drawn (one not
   * registered is refused, as an image it cannot read).
   */
  function imageAt(image) {
    return toImage(slotImage(image));
  }

  /** An atlas slot as the image it holds now; any other image as it is. */
  function slotImage(image) {
    return typeof image?.atlas === 'string'
      ? (atlases.get(image.atlas)?.[image.slot] ?? image)
      : image;
  }

  /**
   * Keep the blob behind `image` (itself, or the atlas slot's now) alive
   * while `holder` (a material, a quad) lives. A material loads its image
   * from the blob's URL on its first draw, which may come long after it was
   * built (hidden till then), and a blob's URL is revoked once the blob is
   * collected: an atlas slot given a new image no longer holds the old one.
   */
  function holdImage(holder, image) {
    const blob = slotImage(image)?.blob;
    if (holder && blob) heldBlobs.set(holder, blob);
    return holder;
  }

  function buildIcons(record) {
    // A GPU host keeps drawing: what a rebuild changes, it reads live.
    if (record.gpu) return;
    const host = new Cesium.BillboardCollection({
      scene,
      blendOption: pointBlendOf(record.spec.blend),
    });
    record.atlases = new Set();
    // Each drawn icon's billboard, in the order the collection draws them.
    record.billboards = new Map();
    record.billboardHost = host;
    // Every image loaded into the collection's texture atlas, which keeps
    // each until the collection goes.
    record.imageKeys = new Set();
    for (const item of record.items.values()) {
      const image = iconImage(record, item.image);
      if (image !== undefined) addIcon(record, item, image);
    }
    replaceHost(record, host);
  }

  /** A generated image, drawn as one texture under its key. */
  const isKeyed = (image) => image?.canvas && typeof image.key === 'string';

  /** What tells one image from another, for an icon whose image changes. */
  function imageKeyOf(image) {
    if (typeof image === 'string') return image;
    if (typeof image?.svg === 'string') return `\u0000svg\u0000${image.svg}`;
    if (isKeyed(image)) return `\u0000key\u0000${image.key}`;
    return image?.canvas ?? image?.blob ?? image;
  }

  /** How a billboard draws an icon item at `position`, but its image and id. */
  function iconLook(record, item, position) {
    const look = {
      position,
      width: item.size[0] * (item.scale ?? 1),
      height: item.size[1] * (item.scale ?? 1),
      // Focus emphasis as the GPU icons draw it: a fade, at most to none.
      color: toColor(
        item.color,
        (item.alpha ?? 1) * Math.min(1, Math.max(0, item.focus ?? 1)),
      ),
      verticalOrigin: ANCHORS[item.anchor ?? 'center'],
      disableDepthTestDistance: item.disableDepthTest ?? 0,
      heightReference: heightReferenceOf(item.height, record.spec.clampTo),
      // An empty range shows it nowhere.
      show: item.show !== false && displayable(item.displayRange),
      scaleByDistance: nearFarOf(item.scaleByDistance),
      // Its offset shrinks with it, as Cesium's KML icons' did.
      pixelOffsetScaleByDistance: item.offsetScalesByDistance
        ? nearFarOf(item.scaleByDistance)
        : undefined,
      translucencyByDistance: nearFarOf(item.fadeByDistance),
      distanceDisplayCondition: displayConditionOf(item.displayRange),
      // The defaults, so a restyle in place puts back what an item dropped.
      rotation: 0,
      alignedAxis: Cesium.Cartesian3.ZERO,
      // CSS pixels, y down, as the billboard takes them.
      pixelOffset: new Cesium.Cartesian2(
        item.pixelOffset?.x ?? 0,
        item.pixelOffset?.y ?? 0,
      ),
    };
    if (item.rotationMode === 'screen' || item.rotationMode === 'axis')
      look.rotation = item.rotation ?? 0;
    // Its up turned along the axis on screen, as Cesium's own aligned
    // billboards stand, then by its rotation; an axis of zero length stands
    // upright.
    if (item.rotationMode === 'axis' && item.alignedAxis) {
      const { x = 0, y = 0, z = 0 } = item.alignedAxis;
      const axis = new Cesium.Cartesian3(x, y, z);
      const length = Cesium.Cartesian3.magnitude(axis);
      if (length > 0)
        look.alignedAxis = Cesium.Cartesian3.divideByScalar(axis, length, axis);
    }
    if (item.rotationMode === 'course') {
      const enu = Cesium.Transforms.eastNorthUpToFixedFrame(position);
      look.alignedAxis = Cesium.Matrix4.multiplyByPointAsVector(
        enu,
        Cesium.Cartesian3.UNIT_Y,
        new Cesium.Cartesian3(),
      );
      look.rotation = -Cesium.Math.toRadians(item.course ?? 0);
    }
    return look;
  }

  /**
   * What a billboard draws of an icon item but its position, image and
   * `meta`, as plain values: the course rotation follows the
   * position, so it is written with it.
   */
  function iconStyleOf(record, item) {
    const color = item.color;
    const curve = (c) =>
      c ? [c.near, c.nearValue, c.far, c.farValue] : undefined;
    return {
      width: item.size[0],
      height: item.size[1],
      scale: item.scale,
      color:
        Array.isArray(color) || ArrayBuffer.isView(color) ? [...color] : color,
      alpha: item.alpha,
      focus: item.focus,
      anchor: item.anchor,
      disableDepthTest: item.disableDepthTest,
      heightMode: item.height,
      clampTo: record.spec.clampTo,
      show: item.show,
      displayRange: item.displayRange ? [...item.displayRange] : undefined,
      scaleByDistance: curve(item.scaleByDistance),
      offsetScalesByDistance: item.offsetScalesByDistance,
      fadeByDistance: curve(item.fadeByDistance),
      rotationMode: item.rotationMode,
      rotation: item.rotation,
      alignedAxis: item.alignedAxis
        ? [item.alignedAxis.x, item.alignedAxis.y, item.alignedAxis.z]
        : undefined,
      course: item.course,
      pixelOffset: item.pixelOffset
        ? [item.pixelOffset.x ?? 0, item.pixelOffset.y ?? 0]
        : undefined,
    };
  }

  /** Two lists, or two missing ones, alike element by element. */
  function sameList(a, b) {
    if (!a || !b) return a === b;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  /** A curve as `iconStyleOf` keeps it, and one as an item gives it. */
  function sameCurve(a, c) {
    return !a || !c
      ? !a && !c
      : a[0] === c.near &&
          a[1] === c.nearValue &&
          a[2] === c.far &&
          a[3] === c.farValue;
  }

  /**
   * Whether `item` draws as `style` (`iconStyleOf`) says, but its position
   * and, turned on screen, its rotation (`moveIcon` writes both).
   */
  function sameIconStyle(style, record, item) {
    const color = item.color;
    return (
      style.width === item.size[0] &&
      style.height === item.size[1] &&
      style.scale === item.scale &&
      (Array.isArray(color) || ArrayBuffer.isView(color)
        ? Array.isArray(style.color) && sameList(style.color, color)
        : style.color === color) &&
      style.alpha === item.alpha &&
      style.focus === item.focus &&
      style.anchor === item.anchor &&
      style.disableDepthTest === item.disableDepthTest &&
      style.heightMode === item.height &&
      style.clampTo === record.spec.clampTo &&
      style.show === item.show &&
      sameList(style.displayRange, item.displayRange) &&
      sameCurve(style.scaleByDistance, item.scaleByDistance) &&
      style.offsetScalesByDistance === item.offsetScalesByDistance &&
      sameCurve(style.fadeByDistance, item.fadeByDistance) &&
      style.rotationMode === item.rotationMode &&
      (item.rotationMode === 'screen' || style.rotation === item.rotation) &&
      (item.alignedAxis
        ? style.alignedAxis?.[0] === item.alignedAxis.x &&
          style.alignedAxis[1] === item.alignedAxis.y &&
          style.alignedAxis[2] === item.alignedAxis.z
        : style.alignedAxis === undefined) &&
      style.course === item.course &&
      (item.pixelOffset
        ? style.pixelOffset?.[0] === (item.pixelOffset.x ?? 0) &&
          style.pixelOffset[1] === (item.pixelOffset.y ?? 0)
        : style.pixelOffset === undefined)
    );
  }

  const movedEnu = new Cesium.Matrix4();
  const movedAxis = new Cesium.Cartesian3();
  /**
   * Move a drawn icon whose look is unchanged (`sameIconStyle`): its
   * position, the course rotation that follows it or the screen rotation
   * it is given, and its pick record.
   */
  function moveIcon(record, entry, item) {
    const { billboard, placed } = entry;
    const position = toCartesianInto(item.pos, placed.position);
    billboard.position = position;
    if (item.rotationMode === 'course') {
      Cesium.Transforms.eastNorthUpToFixedFrame(position, undefined, movedEnu);
      // The billboard copies the axis it is given.
      billboard.alignedAxis = Cesium.Matrix4.multiplyByPointAsVector(
        movedEnu,
        Cesium.Cartesian3.UNIT_Y,
        movedAxis,
      );
    }
    if (item.rotationMode === 'screen') {
      billboard.rotation = item.rotation ?? 0;
      entry.style.rotation = item.rotation;
    }
    billboard.id.meta = item.meta;
    billboard.show = shownNow(record, placed);
  }

  /** Give a billboard its image: a generated one under its key. */
  function setIconImage(record, billboard, image) {
    if (isKeyed(image)) billboard.setImage(image.key, image.canvas);
    else billboard.image = toImage(image);
    record.imageKeys.add(imageKeyOf(image));
  }

  /** Draw an icon item as a new billboard, after the set's others. */
  function addIcon(record, item, image) {
    const position = toCartesian(item.pos);
    const options = {
      ...iconLook(record, item, position),
      id: pickId(record, item),
    };
    const billboard = record.billboardHost.add(options);
    setIconImage(record, billboard, image);
    const placed = place(record, billboard, position, options.show);
    record.billboards.set(item.id, {
      billboard,
      placed,
      image: imageKeyOf(image),
      canvas: image?.canvas,
      // What it is drawn as, for `patchIcon`'s quick path.
      style: iconStyleOf(record, item),
    });
  }

  /**
   * Draw a drawn icon as its item now is, on the billboard it has: its
   * image is loaded again only when it changes, so restyled icons never
   * blink. An SVG drawn at a new size keeps the raster it was loaded at, as
   * Cesium's entities do.
   */
  function patchIcon(record, entry, item, image) {
    const { billboard, placed } = entry;
    // Drawn as it was but for where it is: only that is written, so a set
    // whose icons move every frame costs little more than the moves.
    if (
      entry.style &&
      imageKeyOf(image) === entry.image &&
      sameIconStyle(entry.style, record, item)
    ) {
      moveIcon(record, entry, item);
      return;
    }
    entry.style = iconStyleOf(record, item);
    const position = toCartesian(item.pos);
    const look = iconLook(record, item, position);
    // Sized first: a new SVG image rasterises at the billboard's size.
    Object.assign(billboard, look);
    const key = imageKeyOf(image);
    if (key !== entry.image) {
      setIconImage(record, billboard, image);
      entry.image = key;
      entry.canvas = image?.canvas;
    }
    // Picks and height queries hold this id object: changed, not replaced.
    billboard.id.meta = item.meta;
    placed.position = position;
    placed.shown = look.show;
    billboard.show = shownNow(record, placed);
  }

  // What `patchDrawnIcons` looks up for each item, kept between upserts so
  // a set whose icons move every frame makes no lists for the move.
  const patchedEntries = [];
  const patchedImages = [];

  /**
   * `upsert`'s quick case for an icon set on billboards: every item is
   * drawn, every one of `list` keeps the image it is drawn with, and
   * nothing drawn has gone, so each of `list` is changed where it is
   * (`patchIcon`: only moved, when that is all that changed) and nothing is
   * added, removed or reordered. Each item is read once: a layer moves its
   * icons every frame. The items are taken as the set's. False, changing
   * nothing, otherwise.
   * @param {object} record
   * @param {readonly object[]} list
   */
  function patchDrawnIcons(record, list) {
    const drawn = record.billboards;
    const host = record.billboardHost;
    // Nothing to remove: every item drawn, and nothing drawn but items.
    if (
      record.kind !== 'icons' ||
      !drawn ||
      !host ||
      record.host !== host ||
      host.isDestroyed() ||
      list.length === 0 ||
      drawn.size !== record.items.size
    )
      return false;
    const n = list.length;
    const entries = patchedEntries;
    const images = patchedImages;
    let ok = true;
    for (let i = 0; i < n; i++) {
      const entry = drawn.get(list[i].id);
      if (!entry) {
        ok = false;
        break;
      }
      const image = iconImage(record, list[i].image);
      if (
        image === undefined ||
        imageKeyOf(image) !== entry.image ||
        (isKeyed(image) && image.canvas !== entry.canvas)
      ) {
        ok = false;
        break;
      }
      entries[i] = entry;
      images[i] = image;
    }
    if (ok)
      for (let i = 0; i < n; i++) {
        record.items.set(list[i].id, list[i]);
        patchIcon(record, entries[i], list[i], images[i]);
      }
    // Held only for this pass: what it looked up is let go.
    entries.fill(undefined, 0, n);
    images.fill(undefined, 0, n);
    return ok;
  }

  /**
   * Bring an icon set's billboards in line with its items without a
   * rebuild: those of items gone (or whose image is gone) are removed, the
   * items `touched` are drawn as they now are, and new ones are added. A
   * collection draws in the order its billboards were added, so this is
   * done only when that stays the items' order: new icons come after every
   * one kept and, with `reordered` (a `set`), the kept ones keep their
   * order. A collection keeps every image it loaded, so it is also rebuilt
   * (anew, holding only what it draws) when it would hold many more images
   * than it draws, when it is emptied, and when a generated image under a
   * key it has comes as a new canvas (its key's texture would not change).
   * False, changing nothing, otherwise, and when the set has no live
   * collection of its own. When done, `ICONS_CHANGED` if icons were added
   * or removed (the set's pick ids changed), else `ICONS_KEPT`.
   * @param {object} record
   * @param {Iterable<string>} touched Ids of items that may have changed.
   * @param {boolean} [reordered] The items were replaced, in a new order.
   */
  function syncIcons(record, touched, reordered = false) {
    const drawn = record.billboards;
    const host = record.billboardHost;
    if (
      record.kind !== 'icons' ||
      !drawn ||
      !host ||
      record.host !== host ||
      host.isDestroyed()
    )
      return false;
    const images = new Map();
    for (const id of touched) {
      const item = record.items.get(id);
      if (item) images.set(id, iconImage(record, item.image));
    }
    if (record.items.size === 0) return false;
    const keeps = (id) =>
      record.items.has(id) && (!images.has(id) || images.get(id) !== undefined);
    const adds = (id) =>
      !drawn.has(id) && images.has(id) && images.get(id) !== undefined;
    let adding = false;
    const kept = [];
    for (const id of record.items.keys()) {
      if (adds(id)) adding = true;
      else if (drawn.has(id) && keeps(id)) {
        if (adding) return false;
        kept.push(id);
      }
    }
    if (reordered) {
      let at = 0;
      for (const id of drawn.keys())
        if (keeps(id) && kept[at++] !== id) return false;
    }
    // The images drawn once this is done, and those it would load.
    const drawing = new Set();
    let loading = 0;
    for (const id of kept) {
      const entry = drawn.get(id);
      if (!images.has(id)) {
        drawing.add(entry.image);
        continue;
      }
      const image = images.get(id);
      const key = imageKeyOf(image);
      if (
        isKeyed(image) &&
        key === entry.image &&
        image.canvas !== entry.canvas
      )
        return false;
      drawing.add(key);
    }
    for (const [id, image] of images)
      if (image !== undefined && !drawn.has(id)) drawing.add(imageKeyOf(image));
    for (const key of drawing) if (!record.imageKeys.has(key)) loading += 1;
    if (
      record.imageKeys.size + loading >
      Math.max(MAX_SPARE_IMAGES, 2 * drawing.size)
    )
      return false;
    const gone = new Set();
    for (const [id, entry] of drawn)
      if (!keeps(id)) {
        host.remove(entry.billboard);
        drawn.delete(id);
        gone.add(entry.billboard);
      }
    if (gone.size) {
      record.placed = record.placed.filter((p) => !gone.has(p.primitive));
      const ids = new Set([...gone].map((billboard) => billboard.id));
      record.pickIds = record.pickIds.filter((id) => !ids.has(id));
    }
    let added = false;
    for (const [id, item] of record.items) {
      const image = images.get(id);
      if (image === undefined) continue;
      const entry = drawn.get(id);
      if (entry) patchIcon(record, entry, item, image);
      else {
        addIcon(record, item, image);
        added = true;
      }
    }
    return added || gone.size ? ICONS_CHANGED : ICONS_KEPT;
  }

  function buildPoints(record) {
    let points = null;
    let dots = null;
    for (const item of record.items.values()) {
      const position = toCartesian(item.pos);
      // An empty range shows it nowhere.
      const show = item.show !== false && displayable(item.displayRange);
      const heightReference = heightReferenceOf(
        item.height,
        record.spec.clampTo,
      );
      if (heightReference === Cesium.HeightReference.NONE) {
        points ??= new Cesium.PointPrimitiveCollection({
          blendOption: pointBlendOf(record.spec.blend),
        });
        addPoint(record, points, item, position, show);
        continue;
      }
      // Point primitives cannot follow the ground.
      dots ??= new Cesium.BillboardCollection({ scene });
      const primitive = addDot(dots, item, {
        position,
        heightReference,
        show,
        distanceDisplayCondition: displayConditionOf(item.displayRange),
        id: pickId(record, item),
      });
      record.patchable ??= new Map();
      record.patchable.set(item.id, {
        primitive,
        placed: place(record, primitive, position, show),
        at: placeOf(item),
        dot: dotLook(item).key,
        heightReference,
      });
    }
    // With no clamped dots, its points are drawn by one collection that
    // takes points added later where it is.
    if (!dots)
      points ??= new Cesium.PointPrimitiveCollection({
        blendOption: pointBlendOf(record.spec.blend),
      });
    record.patchable ??= new Map();
    record.pointHost = dots ? null : points;
    let host = points ?? dots;
    if (points && dots) {
      host = new Cesium.PrimitiveCollection();
      host.add(points);
      host.add(dots);
    }
    replaceHost(record, host);
  }

  /** Draw an unclamped point item on `points`, the set's collection. */
  function addPoint(record, points, item, position, show) {
    const primitive = points.add({
      position,
      ...pointLook(item),
      show,
      id: pickId(record, item),
    });
    record.patchable ??= new Map();
    record.patchable.set(item.id, {
      primitive,
      placed: place(record, primitive, position, show),
      at: placeOf(item),
      look: pointLookOf(item),
    });
  }

  /** How a point primitive draws an unclamped point item. */
  function pointLook(item) {
    return {
      pixelSize: item.pixelSize,
      color: toColor(item.color),
      outlineColor: toColor(item.outlineColor ?? [0, 0, 0, 0]),
      outlineWidth: item.outlineWidth ?? 0,
      disableDepthTestDistance: item.disableDepthTest ?? 0,
      scaleByDistance: nearFarOf(item.scaleByDistance),
      translucencyByDistance: nearFarOf(item.fadeByDistance),
      distanceDisplayCondition: displayConditionOf(item.displayRange),
    };
  }

  // An unclamped point's look, by the item's members each primitive member
  // is drawn from: an upsert sets only the members whose values changed,
  // so a set moving every point each frame makes nothing new for the look.
  const LOOK = [
    ['pixelSize', (item) => item.pixelSize],
    ['color', (item) => toColor(item.color)],
    ['outlineColor', (item) => toColor(item.outlineColor ?? [0, 0, 0, 0])],
    ['outlineWidth', (item) => item.outlineWidth ?? 0],
    ['disableDepthTestDistance', (item) => item.disableDepthTest ?? 0],
    ['scaleByDistance', (item) => nearFarOf(item.scaleByDistance)],
    ['translucencyByDistance', (item) => nearFarOf(item.fadeByDistance)],
    [
      'distanceDisplayCondition',
      (item) => displayConditionOf(item.displayRange),
    ],
  ];
  const LOOK_FROM = [
    'pixelSize',
    'color',
    'outlineColor',
    'outlineWidth',
    'disableDepthTest',
    'scaleByDistance',
    'fadeByDistance',
    'displayRange',
  ];

  /**
   * What a point's look keeps of an item member: a frozen value of plain
   * members (a frozen colour or curve) as it is, since it cannot change and
   * is then told unchanged by identity; anything else as a `plainCopy`.
   */
  function lookCopy(value) {
    if (!value || typeof value !== 'object' || !Object.isFrozen(value))
      return plainCopy(value);
    // Only plain data cannot change: no getters, nothing inherited.
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== Array.prototype)
      return plainCopy(value);
    for (const key of Reflect.ownKeys(value)) {
      const member = Object.getOwnPropertyDescriptor(value, key);
      if (
        !('value' in member) ||
        (member.value !== null && typeof member.value === 'object')
      )
        return plainCopy(value);
    }
    return value;
  }

  /** A copy of the item members a point's look is drawn from. */
  const pointLookOf = (item) => LOOK_FROM.map((key) => lookCopy(item[key]));

  /**
   * Whether `value` holds what `kept` (a `plainCopy` of a colour, curve or
   * range) holds, read without allocating: points moved every frame
   * compare their looks every frame.
   */
  function sameLookValue(kept, value) {
    if (Object.is(kept, value)) return true;
    if (
      !kept ||
      !value ||
      typeof kept !== 'object' ||
      typeof value !== 'object'
    )
      return false;
    if (Array.isArray(kept) !== Array.isArray(value)) return false;
    if (Array.isArray(value)) {
      // Colours, read by index: a `for...in` over an array is far slower.
      if (kept.length !== value.length) return false;
      for (let i = 0; i < value.length; i++)
        if (!Object.is(kept[i], value[i])) return false;
      return true;
    }
    let count = 0;
    for (const key in value) {
      if (value[key] === undefined) continue;
      count += 1;
      if (!Object.is(kept[key], value[key])) return false;
    }
    for (const key in kept) if (kept[key] !== undefined) count -= 1;
    return count === 0;
  }

  /** Set the members of a point's look whose item values changed. */
  function patchLook(was, item) {
    for (let i = 0; i < LOOK.length; i++) {
      const value = item[LOOK_FROM[i]];
      if (sameLookValue(was.look[i], value)) continue;
      was.primitive[LOOK[i][0]] = LOOK[i][1](item);
      was.look[i] = lookCopy(value);
    }
  }

  /**
   * Where an item is, as its values when drawn: a caller may change the
   * position object it passes and send the same one again.
   */
  const placeOf = (item) => {
    const pos = item.pos;
    return [
      pos?.x,
      pos?.y,
      pos?.z,
      pos?.lon,
      pos?.lat,
      pos?.height,
      item.height,
    ];
  };

  /**
   * Whether an item is somewhere else than `at`; if so, `at` takes it. Read
   * member by member, by name: points moved every frame are compared every
   * frame.
   */
  function movedFrom(at, item) {
    const pos = item.pos;
    const x = pos?.x;
    const y = pos?.y;
    const z = pos?.z;
    const lon = pos?.lon;
    const lat = pos?.lat;
    const height = pos?.height;
    if (
      Object.is(x, at[0]) &&
      Object.is(y, at[1]) &&
      Object.is(z, at[2]) &&
      Object.is(lon, at[3]) &&
      Object.is(lat, at[4]) &&
      Object.is(height, at[5]) &&
      Object.is(item.height, at[6])
    )
      return false;
    at[0] = x;
    at[1] = y;
    at[2] = z;
    at[3] = lon;
    at[4] = lat;
    at[5] = height;
    at[6] = item.height;
    return true;
  }

  /** A position as Cesium's, written into `result`. */
  function toCartesianInto(pos, result) {
    if ('x' in pos)
      return Cesium.Cartesian3.fromElements(pos.x, pos.y, pos.z, result);
    return Cesium.Cartesian3.fromDegrees(
      pos.lon,
      pos.lat,
      pos.height ?? 0,
      undefined,
      result,
    );
  }

  /**
   * Upsert points in place, without a rebuild, when every item is one the
   * set draws now, in the same LOD group, and stays drawn the same way: an
   * unclamped point stays unclamped (then how it looks changes on the point
   * it has, member by member), a clamped dot clamps the same way and keeps
   * its look (the dot image it is drawn with). Where it is, its `meta`, its
   * display range and whether it shows change in place; a dot moved follows
   * the ground where it now is. A new unclamped item joins a set drawn by
   * one point collection where it is. `POINTS_ADDED` when items were
   * added, `POINTS_KEPT` when all were changed in place; false, changing
   * nothing, otherwise.
   */
  function patchPoints(record, list) {
    const patchable = record.patchable;
    if (record.kind !== 'points' || !patchable) return false;
    // New ids, to tell one sent twice (a rebuild keeps the last).
    let added = null;
    for (const item of list) {
      const was = patchable.get(item.id);
      const heightReference = heightReferenceOf(
        item.height,
        record.spec.clampTo,
      );
      if (!was) {
        // Only an unclamped point joins, on the set's one collection.
        if (
          !record.pointHost ||
          record.host !== record.pointHost ||
          record.pointHost.isDestroyed?.() ||
          heightReference !== Cesium.HeightReference.NONE ||
          added?.has(item.id)
        )
          return false;
        (added ??= new Set()).add(item.id);
        continue;
      }
      if (was.dot === undefined) {
        if (heightReference !== Cesium.HeightReference.NONE) return false;
      } else if (
        heightReference !== was.heightReference ||
        dotLook(item).key !== was.dot
      )
        return false;
    }
    for (const item of list) {
      const was = patchable.get(item.id);
      const show = item.show !== false && displayable(item.displayRange);
      if (!was) {
        const position = toCartesian(item.pos);
        addPoint(record, record.pointHost, item, position, show);
        const placed = patchable.get(item.id).placed;
        placed.primitive.show = shownNow(record, placed);
        continue;
      }
      if (movedFrom(was.at, item)) {
        // The cull's own copy of where it is; the primitive copies it.
        toCartesianInto(item.pos, was.placed.position);
        was.primitive.position = was.placed.position;
      }
      if (was.dot === undefined) patchLook(was, item);
      else {
        was.primitive.distanceDisplayCondition = displayConditionOf(
          item.displayRange,
        );
        was.primitive.disableDepthTestDistance = item.disableDepthTest ?? 0;
      }
      was.primitive.id.meta = item.meta;
      was.placed.shown = show;
      was.primitive.show = shownNow(record, was.placed);
    }
    return added ? POINTS_ADDED : POINTS_KEPT;
  }

  /**
   * Remove points from a set drawn by one point collection where they are,
   * as the items that stay keep drawing. False, changing nothing, for a set
   * drawn otherwise.
   */
  function removePoints(record, ids) {
    if (
      record.kind !== 'points' ||
      !record.pointHost ||
      record.host !== record.pointHost ||
      record.pointHost.isDestroyed?.()
    )
      return false;
    const gone = new Set();
    for (const id of ids) {
      const was = record.patchable.get(id);
      if (!was) continue;
      record.patchable.delete(id);
      record.pointHost.remove(was.primitive);
      gone.add(was.primitive);
    }
    if (gone.size) {
      record.pickIds = record.pickIds.filter((pick) =>
        record.patchable.has(pick.id),
      );
      record.placed = record.placed.filter(
        (placed) => !gone.has(placed.primitive),
      );
    }
    return true;
  }

  /**
   * How a clamped point's dot is drawn: its image (by key) and the scale
   * it is drawn at.
   */
  function dotLook(item) {
    const color = toColor(item.color);
    const outlineColor = toColor(item.outlineColor ?? [0, 0, 0, 0]);
    const outlineWidth = Math.round(item.outlineWidth ?? 0);
    let pixelSize = Math.max(1, Math.round(item.pixelSize));
    let scale = 1;
    if (outlineWidth <= 0) {
      // Drawn large and scaled down, as the entity points are.
      scale = pixelSize / 50;
      pixelSize = 50;
    }
    const css = color.toCssColorString();
    const cssOutline = outlineColor.toCssColorString();
    return {
      key: JSON.stringify([css, pixelSize, cssOutline, outlineWidth, scale]),
      image: JSON.stringify([css, pixelSize, cssOutline, outlineWidth]),
      alpha: color.alpha,
      css,
      cssOutline,
      outlineWidth,
      pixelSize,
      scale,
    };
  }

  /**
   * A clamped point as Cesium's entity points draw one: a billboard of a
   * dot drawn at its pixel size, one texture per look.
   */
  function addDot(collection, item, options) {
    const look = dotLook(item);
    const billboard = collection.add({
      ...options,
      scale: look.scale,
      disableDepthTestDistance: item.disableDepthTest ?? 0,
    });
    billboard.setImage(
      look.image,
      Cesium.createBillboardPointCallback(
        look.alpha,
        look.css,
        look.cssOutline,
        look.outlineWidth,
        look.pixelSize,
      ),
    );
    return billboard;
  }

  /**
   * A line's material; with `reveal` (where along its texture the line
   * ends, `revealUniform`), one drawing only that far. A flow material
   * (the route annotations' dashes, which run toward the line's end on the
   * clock `flowTime` keeps) is noted for the frame clock.
   */
  function lineMaterial(record, style, reveal, age) {
    const fabric = lineFabric(style);
    // Built from its type, then given its values, as `fromType` does:
    // values in the fabric would be merged into copies of the type's.
    const template = ({ type, source, uniforms }) =>
      source ? { type, source, uniforms } : { type };
    // A pattern's image carries its own alpha, a split line's colours may
    // each have one, and an aged line fades: drawn in the translucent pass,
    // whatever its colour.
    const translucent =
      style.kind === 'pattern' || style.kind === 'split' || age
        ? { translucent: true }
        : {};
    let built = template(fabric);
    if (reveal !== undefined) {
      ownUniforms(built);
      built = {
        type: `${REVEAL_MATERIAL}_${style.kind}`,
        materials: { revealed: built },
        uniforms: { reveal },
        source: REVEAL_SOURCE,
      };
    }
    if (age) {
      ownUniforms(built);
      built = {
        type: `${AGE_MATERIAL}_${reveal === undefined ? '' : 'revealed_'}${style.kind}`,
        materials: { aged: built },
        uniforms: {
          ...age.uniforms,
          ages: Cesium.Material.DefaultImageId,
          ageNow: 0,
        },
        source: AGE_SOURCE,
      };
    }
    const material = new Cesium.Material({ fabric: built, ...translucent });
    const drawn = styleMaterial(material);
    Object.assign(drawn.uniforms, fabric.uniforms);
    if (age) {
      // Translucent whatever its style's colour: a composite material is
      // translucent only where all of its parts are.
      material.translucent = true;
      noteAge(record, material, age);
    }
    const flow = flowOf(material, style);
    if (flow) record.flowMaterials.push(flow);
    if (style.kind === 'pattern') holdImage(material, style.image);
    return material;
  }

  /**
   * The flow material a line's material runs on (itself, or what a revealed
   * line draws), for the frame clock; null for other styles.
   */
  const flowOf = (material, style) =>
    style.kind !== 'flow' ? null : styleMaterial(material);

  /** Stop running the clock of a line material that no longer draws. */
  function dropFlow(record, material, style) {
    const flow = material && flowOf(material, style);
    if (flow)
      record.flowMaterials = record.flowMaterials.filter((m) => m !== flow);
  }

  /** Whether a line draws only the first part of its length. */
  const revealed = (item) => item.revealFraction !== undefined;

  /**
   * Note an age-faded line's material, which takes the scene's time each
   * frame (`runAges`) and its points' times as a texture. `owner`, the
   * primitive drawing it where that is not a polyline collection's (which
   * destroys the materials of the lines it lets go): the material goes with
   * it (`claimAges`).
   */
  function noteAge(record, material, age) {
    (record.ages ??= new Map()).set(material, {
      age,
      texture: null,
      dirty: true,
      owner: null,
    });
    (record.unclaimedAges ??= []).push(material);
    material.uniforms.ageNow = (sceneMs() - age.base) / 1000;
  }

  /** The aged materials made since the last claim are `owner`'s. */
  function claimAges(record, owner) {
    for (const material of record.unclaimedAges?.splice(0) ?? []) {
      const entry = record.ages.get(material);
      if (entry && owner) entry.owner = owner;
    }
  }

  /** An aged line's material takes its line's new points and times. */
  function writeAge(record, material, age) {
    const entry = record.ages?.get(material);
    if (!entry) return;
    const was = entry.age;
    Object.assign(material.uniforms, age.uniforms);
    entry.age = age;
    material.uniforms.ageNow = (sceneMs() - age.base) / 1000;
    if (
      was.width === age.width &&
      was.rows === age.rows &&
      was.data.every((value, i) => Object.is(value, age.data[i]))
    )
      return;
    entry.dirty = true;
    requestRender();
  }

  /** The scene's time now, epoch ms: the frame's, once one has drawn. */
  const sceneMs = () =>
    Cesium.JulianDate.toDate(
      scene.frameState?.time ?? Cesium.JulianDate.now(),
    ).getTime();

  /**
   * Each frame, before it draws: every aged line's material takes the
   * scene's time, and its points' times where they changed (written into
   * its texture, or a new one where it changed size). A material whose
   * line is gone goes, with its texture.
   */
  function runAges() {
    let ms = null;
    for (const record of sets.values()) {
      if (!record.ages?.size) continue;
      ms ??= sceneMs();
      for (const [material, entry] of record.ages) {
        if (dropAge(record, material, entry)) continue;
        material.uniforms.ageNow = (ms - entry.age.base) / 1000;
        if (entry.dirty && scene.context) uploadAge(material, entry);
      }
    }
  }

  /** Let an aged material go if its line is gone; true if it went. */
  function dropAge(record, material, entry) {
    if (!material.isDestroyed() && !entry.owner?.isDestroyed()) return false;
    if (!material.isDestroyed()) material.destroy();
    // One handed over but never taken is no one's.
    if (entry.texture && !entry.texture.isDestroyed()) entry.texture.destroy();
    record.ages.delete(material);
    return true;
  }

  /** Write an aged material's times into its texture, made as needed. */
  function uploadAge(material, entry) {
    const { data, width, rows } = entry.age;
    const source = { width, height: rows, arrayBufferView: data };
    entry.dirty = false;
    const texture = entry.texture;
    if (
      texture &&
      !texture.isDestroyed() &&
      texture.width === width &&
      texture.height === rows
    ) {
      texture.copyFrom({ source });
      return;
    }
    if (
      texture &&
      !texture.isDestroyed() &&
      materialTexture(material, 'ages') !== texture
    )
      texture.destroy();
    entry.texture = new Cesium.Texture({
      context: scene.context,
      width,
      height: rows,
      pixelFormat: Cesium.PixelFormat.RGBA,
      pixelDatatype: Cesium.PixelDatatype.FLOAT,
      flipY: false,
      source,
      sampler: new Cesium.Sampler({
        wrapS: Cesium.TextureWrap.CLAMP_TO_EDGE,
        wrapT: Cesium.TextureWrap.CLAMP_TO_EDGE,
        minificationFilter: Cesium.TextureMinificationFilter.NEAREST,
        magnificationFilter: Cesium.TextureMagnificationFilter.NEAREST,
      }),
    });
    // The material destroys the texture it held once it takes this one.
    material.uniforms.ages = entry.texture;
  }

  /** The fabric of a line style's material. */
  function lineFabric(style) {
    switch (style.kind) {
      case 'flow':
        return {
          type: FLOW_MATERIAL,
          uniforms: {
            color: toColor(style.color),
            time: flowTime(style.speed),
            repeat: style.repeat,
            duty: style.duty,
            speed: style.speed,
          },
          source: FLOW_SOURCE,
        };
      case 'split':
        return {
          type: SPLIT_MATERIAL,
          uniforms: {
            ...splitUniforms(style),
            rimShade: style.rim?.shade ?? 1,
            rimFraction: style.rim?.widthFraction ?? 0,
          },
          source: SPLIT_SOURCE,
        };
      case 'solid':
        // An outlined line keeps its edge in one material: two lines
        // stacked would darken where their translucent passes overlap.
        return style.outline
          ? {
              type: 'PolylineOutline',
              uniforms: {
                color: toColor(style.color),
                outlineColor: toColor(style.outline.color),
                outlineWidth: style.outline.widthPx,
              },
            }
          : { type: 'Color', uniforms: { color: toColor(style.color) } };
      case 'glow':
        return {
          type: 'PolylineGlow',
          uniforms: {
            color: toColor(style.color),
            glowPower: style.power,
            taperPower: style.taper ?? 1,
          },
        };
      case 'dash':
        return {
          type: 'PolylineDash',
          uniforms: {
            color: toColor(style.color),
            gapColor: toColor([0, 0, 0, 0]),
            dashLength: style.length,
            ...(style.pattern16 !== undefined
              ? { dashPattern: style.pattern16 }
              : {}),
          },
        };
      case 'arrow':
        return {
          type: 'PolylineArrow',
          uniforms: { color: toColor(style.color) },
        };
      case 'pattern':
        // The image along the line `repeat` times, across its width once.
        return {
          type: 'Image',
          uniforms: {
            image: imageAt(style.image),
            repeat: new Cesium.Cartesian2(style.repeat, 1),
          },
        };
      default:
        throw new Error(`the Cesium renderer has no ${style.kind} lines`);
    }
  }

  /**
   * A line's positions as drawn: a geodesic one cut along its arc. With
   * `times` (one a position), `timesOut` takes the time of each point drawn,
   * running evenly between the positions'.
   */
  function linePositions(item, times = null, timesOut = null) {
    const flat = item.positions instanceof Float64Array;
    const points = [];
    const n = flat ? item.positions.length / 3 : item.positions.length;
    for (let i = 0; i < n; i++)
      points.push(
        flat
          ? new Cesium.Cartesian3(
              item.positions[i * 3],
              item.positions[i * 3 + 1],
              item.positions[i * 3 + 2],
            )
          : toCartesian(item.positions[i]),
      );
    if (item.mode !== 'geodesic') {
      if (timesOut) for (let i = 0; i < n; i++) timesOut.push(times[i]);
      return points;
    }
    const dense = [];
    for (let i = 0; i + 1 < points.length; i++) {
      const a = Cesium.Cartographic.fromCartesian(points[i]);
      const b = Cesium.Cartographic.fromCartesian(points[i + 1]);
      const geodesic = new Cesium.EllipsoidGeodesic(a, b);
      // At least a step a degree of arc, as Cesium's own geodesic
      // polylines are cut, and 64 steps over the whole line: a long trail
      // of short legs stays as light as its positions.
      const steps = Math.max(
        Math.ceil((geodesic.surfaceDistance || 0) / GEODESIC_STEP_M),
        Math.ceil(GEODESIC_LINE_STEPS / (points.length - 1)),
      );
      for (let k = 0; k < steps; k++) {
        const s = k / steps;
        if (timesOut) timesOut.push(times[i] + (times[i + 1] - times[i]) * s);
        const at = geodesic.interpolateUsingFraction(s);
        dense.push(
          Cesium.Cartesian3.fromRadians(
            at.longitude,
            at.latitude,
            a.height + (b.height - a.height) * s,
          ),
        );
      }
    }
    dense.push(points.at(-1));
    if (timesOut) timesOut.push(times[n - 1]);
    return dense;
  }

  /** Whether a line fades with age here: it asks, and the port lists it. */
  const aged = (item) => ageFades && item.ageFade != null;

  /**
   * What an age-faded line's material draws from (`lineAgeData`), for the
   * line drawn along `positions` (as `linePositions` made them from it, by
   * default); undefined for a line that does not fade. A draped line, and
   * one drawn over the surface for it, lies along its texture by length.
   */
  function ageOf(item, positions) {
    if (!aged(item)) return undefined;
    const times = [];
    const drawn = linePositions(item, item.ageFade.times, times);
    return lineAgeData(
      positions ?? drawn,
      times,
      item.ageFade,
      item.mode === 'draped' || item.overlaid === true,
      timeWindows,
    );
  }

  /**
   * Whether `positions` make a line: two or more of them, not all at one
   * place.
   */
  const drawable = (positions) =>
    positions.length >= 2 &&
    positions.some((p) => !Cesium.Cartesian3.equals(p, positions[0]));

  /**
   * A line not draped that has a `depthFail` style: a primitive of its own,
   * drawn in that style where the surface hides it. Built at once, so one
   * built anew where it moves draws in the frame it replaces the old one.
   * Null when its positions make no line.
   */
  function depthFailLine(record, item, id) {
    const positions = linePositions(item);
    if (!drawable(positions)) return null;
    const reveal = revealed(item)
      ? revealUniform(item.revealFraction, positions)
      : undefined;
    const age = ageOf(item, positions);
    const material = lineMaterial(record, item.style, reveal, age);
    const primitive = new Cesium.Primitive({
      geometryInstances: new Cesium.GeometryInstance({
        geometry: new Cesium.PolylineGeometry({
          positions,
          width: item.widthPx,
          vertexFormat: Cesium.PolylineMaterialAppearance.VERTEX_FORMAT,
          // Straight between the positions, as the collection's lines are
          // (geodesic ones come densified); one drawn for a draped line
          // follows the surface's curve between them, as draping does.
          arcType: item.overlaid
            ? Cesium.ArcType.GEODESIC
            : Cesium.ArcType.NONE,
        }),
        id,
      }),
      appearance: new Cesium.PolylineMaterialAppearance({ material }),
      depthFailAppearance: item.depthFail
        ? new Cesium.PolylineMaterialAppearance({
            material: lineMaterial(record, item.depthFail, reveal, age),
          })
        : undefined,
      show: item.show !== false,
      asynchronous: false,
      // A set that never picks keeps these out of the pick pass too.
      allowPicking: record.spec.pickable !== false,
    });
    claimAges(record, primitive);
    return primitive;
  }

  /**
   * A draped line's geometry instance under its pick id: coloured per
   * instance when `solid` (batched with others), else drawn by its
   * primitive's material.
   */
  function drapedInstance(item, part, solid, positions = linePositions(item)) {
    const show = new Cesium.ShowGeometryInstanceAttribute(item.show !== false);
    return new Cesium.GeometryInstance({
      geometry: new Cesium.GroundPolylineGeometry({
        positions,
        width: item.widthPx,
        arcType: Cesium.ArcType.GEODESIC,
      }),
      attributes: solid
        ? {
            color: Cesium.ColorGeometryInstanceAttribute.fromColor(
              toColor(item.style.color),
            ),
            show,
          }
        : { show },
      id: part.id,
    });
  }

  /**
   * Whether a draped line draws in a batch of solid ones: a batch draws
   * colours only, so an outlined line draws by its own material.
   */
  const batchable = (item) =>
    item.style.kind === 'solid' &&
    !item.style.outline &&
    !revealed(item) &&
    !aged(item);

  /**
   * A ground primitive of a draped line's own, drawn by a material (a
   * style, or a reveal, a batch cannot draw) or, solid, by its colour. With
   * `sync` it is built in the first frame it is updated in, as Cesium's
   * entities build ground lines whose positions change: only once Cesium's
   * approximate terrain heights are loaded (`groundSyncs`).
   */
  function drapedPrimitive(record, item, part, sync, positions) {
    const solid = batchable(item);
    let appearance;
    if (solid) {
      appearance = new Cesium.PolylineColorAppearance();
      part.material = null;
    } else {
      part.material = lineMaterial(
        record,
        item.style,
        revealed(item) ? revealUniform(item.revealFraction) : undefined,
        ageOf(item, positions),
      );
      appearance = new Cesium.PolylineMaterialAppearance({
        material: part.material,
      });
    }
    const primitive = new Cesium.GroundPolylinePrimitive({
      geometryInstances: [drapedInstance(item, part, solid, positions)],
      appearance,
      classificationType: classificationOf(part.clampTo),
      allowPicking: record.spec.pickable !== false,
      asynchronous: !sync,
    });
    claimAges(record, primitive);
    return primitive;
  }

  /**
   * Turn a line set's inertial lines to the sky at its motion clock's time
   * now: the frame rotated by sidereal time from the Earth-fixed one.
   */
  /** The time a set's motion clock reads now, epoch ms. */
  function motionMs(record) {
    const clock = record.spec.motionClock;
    return clock?.kind === 'scene'
      ? Cesium.JulianDate.toDate(
          scene.frameState?.time ?? Cesium.JulianDate.now(),
        ).getTime()
      : (date ? date() : Date.now()) - (clock?.delayMs ?? 0);
  }

  /**
   * A draped line in the sky's frame as a fixed one where the sky is at
   * `axes` (`temeToPseudoFixed`): its positions turned into the fixed frame.
   */
  function fixedLine(item, axes) {
    const { x, y, z } = axes;
    const flat =
      item.positions instanceof Float64Array
        ? item.positions
        : item.positions.flatMap((p) => {
            const c = toCartesian(p);
            return [c.x, c.y, c.z];
          });
    const turned = new Float64Array(flat.length);
    for (let i = 0; i < flat.length; i += 3) {
      const a = flat[i];
      const b = flat[i + 1];
      const c = flat[i + 2];
      turned[i] = x.x * a + y.x * b + z.x * c;
      turned[i + 1] = x.y * a + y.y * b + z.y * c;
      turned[i + 2] = x.z * a + y.z * b + z.z * c;
    }
    return { ...item, frame: 'fixed', positions: turned };
  }

  function turnInertial(record) {
    const lines = record.inertialLines;
    const pieces = record.inertialPieces ?? [];
    if ((!lines || lines.isDestroyed()) && !pieces.length) return;
    const { x, y, z } = temeToPseudoFixed(motionMs(record));
    const turn = Cesium.Matrix4.fromRotationTranslation(
      new Cesium.Matrix3(x.x, y.x, z.x, x.y, y.y, z.y, x.z, y.z, z.z),
      Cesium.Cartesian3.ZERO,
    );
    if (lines && !lines.isDestroyed())
      lines.modelMatrix = Cesium.Matrix4.clone(turn, lines.modelMatrix);
    for (const primitive of pieces)
      if (!primitive.isDestroyed())
        primitive.modelMatrix = Cesium.Matrix4.clone(
          turn,
          primitive.modelMatrix,
        );
  }

  /**
   * Whether a line draws piece by piece, each piece a primitive with a
   * material of its own (`linePieces`): a segmented line that is not a
   * draped solid one (those are ground instances a segment), and an
   * inertial line with a depth-fail style (a primitive turned each frame).
   */
  const piecewise = (item) =>
    (segmented(item) &&
      !(
        item.mode === 'draped' &&
        item.style.kind === 'solid' &&
        !item.style.outline &&
        !revealed(item) &&
        !aged(item)
      )) ||
    (item.frame === 'inertial' && item.mode !== 'draped' && item.depthFail) ||
    // A line in runs with no segments of its own: a piece a run.
    (broken(item) && !segmented(item));

  /** Whether a line is drawn in runs, not joined across its breaks. */
  const broken = (item) =>
    lineBreaks && item.breaks != null && item.breaks.length > 0;

  /** The positions that start a run of a line in runs, or null. */
  const runStarts = (item) => (broken(item) ? new Set(item.breaks) : null);

  /**
   * Where a line drawn piece by piece is cut into pieces, by position
   * index: `[a, b]` from position `a` to `b`, `j` its segment (its pair of
   * positions, for its colour and show), `last` whether it ends its run (an
   * arrow's head is drawn there). A segmented line has a piece a segment,
   * but for those across a break; one in runs a piece a run; any other one
   * piece. A run of one position draws nothing, and has no piece.
   */
  function pieceSpans(item, count, bySegment) {
    const starts = runStarts(item);
    const spans = [];
    if (bySegment) {
      for (let j = 0; j + 1 < count; j++)
        if (!starts?.has(j + 1))
          spans.push({
            a: j,
            b: j + 1,
            j,
            last: j + 2 >= count || Boolean(starts?.has(j + 2)),
          });
      return spans;
    }
    if (!starts) return [{ a: 0, b: count - 1, j: 0, last: true }];
    let a = 0;
    for (const at of [...starts, count]) {
      if (at - 1 > a) spans.push({ a, b: at - 1, j: -1, last: true });
      a = at;
    }
    return spans;
  }

  /**
   * The style a segment of a line draws in: the line's, in the segment's
   * colour. An arrow's head is on its last segment only, the others solid;
   * a pattern keeps its image.
   */
  function pieceStyle(item, j, last) {
    const style = item.style;
    if (style.kind === 'pattern') return style;
    const color = item.segmentColors?.[j] ?? style.color;
    if (style.kind === 'arrow' && !last) return { kind: 'solid', color };
    return { ...style, color };
  }

  /**
   * A line drawn piece by piece: a segment a piece for a segmented line
   * (each its own primitive and material, under a pick id of its own that
   * reads as the line's, so a segment's colour and show change in place),
   * a run a piece for a line in runs (`pieceSpans`), else one piece for
   * the whole line. A revealed line reveals each piece by its share of the
   * line's length. Draped pieces are ground polylines; the undraped pieces
   * of a line in runs with no depth-fail style, in the Earth's frame, are
   * polylines in the set's collection (`polylines`), the rest primitives
   * in `host`. Inertial pieces turn with the sky (`turnInertial`).
   */
  function linePieces(record, item, host, groundOut, polylines) {
    const id = pickId(record, item);
    // Its own positions: a geodesic piece is cut along its arc as it is drawn.
    const points = linePositions({ ...item, mode: '3d' });
    const part = {
      look: lineLook(item),
      id,
      from: flatPositions(item.positions),
      ageFrom: aged(item) ? Array.from(item.ageFade.times) : null,
      reveal: item.revealFraction,
      pieces: [],
    };
    const bySegment = segmented(item);
    const spans = pieceSpans(item, points.length, bySegment);
    const lengths = spans.map(({ a, b }) => {
      let length = 0;
      for (let k = a; k < b; k++)
        length += Cesium.Cartesian3.distance(points[k], points[k + 1]);
      return length;
    });
    // The revealed length runs along the pieces, the gaps between runs
    // having none.
    const total = lengths.reduce((sum, length) => sum + length, 0);
    // Several pieces of one line: each under a pick id of its own that
    // reads as the line's.
    const several = bySegment || spans.length > 1;
    // Runs of a line drawn in the collection, as a line of one run is.
    const inCollection =
      broken(item) &&
      item.mode !== 'draped' &&
      !item.depthFail &&
      item.frame !== 'inertial';
    let start = 0;
    spans.forEach(({ a, b, j, last }, k) => {
      const positions = points.slice(a, b + 1);
      const begins = start;
      start += lengths[k];
      if (!drawable(positions)) {
        part.pieces.push(null);
        return;
      }
      // Its share of the revealed length, 0..1.
      const shown = revealed(item)
        ? Math.min(
            1,
            Math.max(
              0,
              (item.revealFraction * total - begins) / (lengths[k] || 1),
            ),
          )
        : 1;
      const pieceId = several ? Object.create(id) : id;
      if (several) record.pickIds.push(pieceId);
      const sub = {
        ...item,
        positions,
        style: pieceStyle(item, j, last),
        ...(revealed(item) && shown < 1 ? { revealFraction: shown } : {}),
        // Its own points' times.
        ...(aged(item)
          ? {
              ageFade: {
                ...item.ageFade,
                times: Array.prototype.slice.call(item.ageFade.times, a, b + 1),
              },
            }
          : {}),
      };
      delete sub.breaks;
      if (!(revealed(item) && shown < 1)) delete sub.revealFraction;
      const draped = item.mode === 'draped';
      const showing = pieceShows(item, j, shown);
      // A ground piece is built shown, and hidden by its instance's show
      // once it is ready (before the set's ground shows): one built hidden
      // would never show. Showing it later needs no build.
      const primitive = draped
        ? groundPiece(record, sub, pieceId, true)
        : inCollection
          ? addPolyline(record, polylines, sub, pieceId).polyline
          : depthFailLine(record, sub, pieceId);
      if (!draped) primitive.show = showing;
      // Ground pieces swap in with the set's other ground primitives.
      if (draped) groundOut.push(primitive);
      else if (!inCollection) host.add(primitive);
      if (item.frame === 'inertial' && item.mode !== 'draped')
        (record.inertialPieces ??= []).push(primitive);
      // Drawn over the surface for a draped line: hidden past the horizon
      // (`cullOverlayLines`), as a line of one run is.
      const overlay =
        item.overlaid && record.overlayLines
          ? {
              part: { deep: primitive },
              shown: showing,
              ends: overlayEnds(positions),
            }
          : undefined;
      if (overlay) record.overlayLines.push(overlay);
      part.pieces.push({
        primitive,
        // The collection it is drawn in, for a polyline there.
        home: inCollection ? polylines : null,
        overlay,
        j,
        last,
        shown,
        draped,
        id: pieceId,
        pendingShow: draped && !showing ? false : undefined,
      });
    });
    return part;
  }

  /** Whether a piece of a line is gone (with its viewer, say). */
  const pieceGone = (piece) => (piece.home ?? piece.primitive).isDestroyed();

  /** Whether a piece shows: its line, its segment and some of it revealed. */
  const pieceShows = (item, j, shown = 1) =>
    item.show !== false &&
    item.segmentShow?.[j] !== false &&
    !(revealed(item) && shown <= 0);

  /** A draped piece: a ground polyline drawn by its style's material. */
  function groundPiece(record, item, id, show) {
    const reveal = revealed(item)
      ? revealUniform(item.revealFraction)
      : undefined;
    const primitive = new Cesium.GroundPolylinePrimitive({
      geometryInstances: [
        new Cesium.GeometryInstance({
          geometry: new Cesium.GroundPolylineGeometry({
            positions: item.positions,
            width: item.widthPx,
            arcType: Cesium.ArcType.GEODESIC,
          }),
          attributes: { show: new Cesium.ShowGeometryInstanceAttribute(show) },
          id,
        }),
      ],
      appearance: new Cesium.PolylineMaterialAppearance({
        material: lineMaterial(record, item.style, reveal, ageOf(item)),
      }),
      classificationType: classificationOf(
        item.clampTo ?? record.spec.clampTo ?? 'both',
      ),
      allowPicking: record.spec.pickable !== false,
    });
    claimAges(record, primitive);
    return primitive;
  }

  /** A pieced line's colours and shows, written in place. */
  function writePieces(part, item) {
    for (const piece of part.pieces) {
      if (!piece || pieceGone(piece)) continue;
      const style = pieceStyle(item, piece.j, piece.last);
      const material = piece.home
        ? piece.primitive.material
        : piece.primitive.appearance.material;
      if (style.kind !== 'pattern') paintLine(material, style);
      const show = pieceShows(item, piece.j, piece.shown);
      if (piece.overlay) piece.overlay.shown = show;
      else if (!piece.draped) piece.primitive.show = show;
      else if (piece.primitive.ready) {
        showOn(piece.primitive, piece.id, show);
        piece.pendingShow = undefined;
      } else piece.pendingShow = show;
    }
  }

  /** Whether the scene can drape lines (Cesium's ground polylines need
   *  depth textures, which every WebGL 2 context has). */
  const drapes = () => scene.frameState?.context?.depthTexture !== false;

  /**
   * A draped line as drawn where the scene cannot drape: undraped along its
   * positions, in its colour where the surface hides it (so it draws over
   * the surface), as one colour where it had segments of its own. One with
   * segments runs from its first shown segment to its last, and is hidden
   * with none shown.
   */
  function overlayLine(item) {
    if (item.mode !== 'draped') return item;
    const { segmentColors, segmentShow, clampTo, ...rest } = item;
    const line = {
      ...rest,
      mode: '3d',
      depthFail: { kind: 'solid', color: item.style.color },
      overlaid: true,
    };
    if (segmentShow?.length) {
      const first = segmentShow.indexOf(true);
      const last = segmentShow.lastIndexOf(true);
      if (first < 0) line.show = false;
      else if (first > 0 || last < segmentShow.length - 1) {
        line.positions = linePositions(item).slice(first, last + 2);
        // Its runs' starts, among the positions it keeps.
        if (broken(item))
          line.breaks = Array.from(item.breaks)
            .filter((at) => at > first && at < last + 2)
            .map((at) => at - first);
        if (item.ageFade)
          line.ageFade = {
            ...item.ageFade,
            times: Array.prototype.slice.call(
              item.ageFade.times,
              first,
              last + 2,
            ),
          };
      }
    }
    return line;
  }

  /**
   * Recolour, in place, a line drawn over the surface for a draped one whose
   * positions are the ones it was built from. False, changing nothing, for
   * one that moved or is revealed.
   */
  function overlayRecoloured(record, part, item) {
    const deep = part.deep;
    // An aged one may have new times: built anew.
    if (!item.overlaid || !deep || revealed(item) || aged(item)) return false;
    if (!flatEquals(item.positions, part.overlayFrom)) return false;
    // Only its colour may have changed (`patchLines` checked its look).
    paintLine(deep.appearance.material, item.style);
    styleMaterial(deep.depthFailAppearance.material).uniforms.color = toColor(
      item.style.color,
    );
    const line = record.overlayLines.find((entry) => entry.part === part);
    if (line) line.shown = item.show !== false;
    else deep.show = item.show !== false;
    return true;
  }

  /** An overlay line's look but its colours (its depth-fail style is its
   *  colour too). */
  const overlayShape = (item) => lineLook({ ...item, depthFail: null }, true);

  /** Stop tracking a line no longer drawn over the surface for a draped
   *  one. */
  function overlayLeft(record, part) {
    const lines = record.overlayLines;
    const at = lines ? lines.findIndex((line) => line.part === part) : -1;
    if (at >= 0) lines.splice(at, 1);
    part.overlayFrom = undefined;
    part.overlayShape = undefined;
  }

  /** Track a patched overlay line for the horizon cull, as built now. */
  function overlayMoved(record, part, item) {
    part.overlayFrom = flatPositions(item.positions);
    part.overlayShape = overlayShape(item);
    const lines = record.overlayLines;
    const at = lines.findIndex((line) => line.part === part);
    if (at >= 0) lines.splice(at, 1);
    if (!part.deep) return;
    lines.push({
      part,
      shown: item.show !== false,
      ends: overlayEnds(item.positions),
    });
  }

  /**
   * Points along a line for the horizon test: up to 16 of its positions,
   * evenly spread, and between each two the point on the surface's curve
   * halfway (so a long arc under the eye is not taken as past the horizon).
   */
  function overlayEnds(positions) {
    const all = linePositions({ positions });
    if (!all.length) return [];
    const picks = Math.min(all.length, 16);
    const probes = [];
    let previous = null;
    for (let k = 0; k < picks; k++) {
      const at =
        all[Math.round((k * (all.length - 1)) / Math.max(1, picks - 1))];
      if (previous) {
        const mid = Cesium.Cartesian3.midpoint(
          previous,
          at,
          new Cesium.Cartesian3(),
        );
        const radius =
          (Cesium.Cartesian3.magnitude(previous) +
            Cesium.Cartesian3.magnitude(at)) /
          2;
        if (Cesium.Cartesian3.magnitude(mid) > 0)
          probes.push(
            Cesium.Cartesian3.multiplyByScalar(
              Cesium.Cartesian3.normalize(mid, mid),
              radius,
              mid,
            ),
          );
      }
      probes.push(at);
      previous = at;
    }
    return probes;
  }

  function buildLines(record) {
    // Refused before anything changes, so the set keeps drawing as it was.
    for (const item of record.items.values())
      if (item.mode === 'draped' && !DRAPED_STYLES.has(item.style.kind))
        throw new Error(`the Cesium renderer has no ${item.style.kind} lines`);
      else if (
        item.mode !== 'draped' &&
        item.depthFail &&
        item.depthFail.kind !== 'solid' &&
        item.depthFail.kind !== 'dash'
      )
        throw new Error(
          'the Cesium renderer draws solid and dashed lines behind the surface only',
        );

    // Where the scene cannot drape at all, draped lines draw over the
    // surface instead (`overlay`): undraped, in their own colour where the
    // surface hides them, and hidden past the horizon (`cullOverlayLines`).
    const overlay = !drapes();
    const items = overlay
      ? [...record.items.values()].map(overlayLine)
      : [...record.items.values()];
    record.overlayLines = overlay ? [] : null;
    const polylines = new Cesium.PolylineCollection();
    // Lines in the inertial frame, turned with the sky each frame.
    let inertial = null;
    const draped = new Map();
    // Draped glow lines that look alike: one ground primitive and one
    // material for them all, so they recolour together in place.
    const glows = new Map();
    // Draped lines a batch cannot draw, each with a primitive of its own.
    const alone = [];
    // Each line as drawn, for upserts that change it in place.
    const parts = new Map();
    // What the old host's flow lines run on, while it still draws; a host
    // already retiring keeps drawing in its place, with its own.
    if (!record.retiring) {
      record.retiringFlows = record.flowMaterials ?? null;
      record.retiringParts = record.drawnParts ?? null;
    }
    record.flowMaterials = [];
    record.lineParts = parts;
    // Lines with a depth-fail colour, beside the collection.
    let deep = null;
    const looks = lineLooks();
    // Lines drawn piece by piece, beside the collection.
    let pieces = null;
    const groundPieces = [];
    record.inertialPieces = [];
    for (const item of items) {
      if (piecewise(item)) {
        if (item.mode !== 'draped') pieces ??= new Cesium.PrimitiveCollection();
        parts.set(
          item.id,
          linePieces(record, item, pieces, groundPieces, polylines),
        );
        continue;
      }
      if (item.mode === 'draped') {
        const clampTo = item.clampTo ?? record.spec.clampTo ?? 'both';
        const part = {
          look: lineLook(item),
          shape: lineLook(item, true),
          positions: flatPositions(item.positions),
          clampTo,
          id: pickId(record, item),
          // Its ground primitive: its batch's, or its own.
          ground: null,
          batch: null,
          material: null,
          // Moved in place: drawn by a primitive of its own built at once.
          solo: false,
        };
        parts.set(item.id, part);
        if (segmented(item)) {
          // A line of no length builds no ground primitive (it would
          // never be ready, and hold the swap).
          const instances = segmentInstances(record, item, part);
          if (!instances.length) continue;
          if (!draped.has(clampTo)) draped.set(clampTo, []);
          draped.get(clampTo).push(...instances);
          continue;
        }
        if (item.style.kind === 'glow' && !revealed(item) && !aged(item)) {
          if (!glows.has(part.look)) glows.set(part.look, []);
          glows.get(part.look).push({ item, part });
          continue;
        }
        if (!batchable(item)) {
          alone.push({ item, part });
          continue;
        }
        if (!draped.has(clampTo)) draped.set(clampTo, []);
        draped.get(clampTo).push(drapedInstance(item, part, true));
        continue;
      }
      if (item.depthFail) {
        deep ??= new Cesium.PrimitiveCollection();
        const id = pickId(record, item);
        const primitive = depthFailLine(record, item, id);
        if (primitive) deep.add(primitive);
        const part = { look: lineLook(item), id, deep: primitive };
        if (item.overlaid) {
          part.overlayFrom = flatPositions(item.positions);
          part.overlayShape = overlayShape(item);
        }
        parts.set(item.id, part);
        if (item.overlaid && primitive)
          record.overlayLines.push({
            part,
            shown: item.show !== false,
            ends: overlayEnds(item.positions),
          });
        continue;
      }
      const id = pickId(record, item);
      if (item.frame === 'inertial') {
        inertial ??= new Cesium.PolylineCollection();
        const { polyline, reveal, parked } = addPolyline(
          record,
          inertial,
          item,
          id,
          true,
        );
        // Never settled into a static batch, which would not turn.
        parts.set(item.id, {
          look: lineLook(item),
          shape: null,
          positions: null,
          id,
          polyline,
          reveal,
          parked,
          home: inertial,
          batched: null,
        });
        continue;
      }
      const settled = settles(item);
      const { polyline, reveal, parked } = addPolyline(
        record,
        polylines,
        item,
        id,
        !settled,
      );
      parts.set(item.id, {
        look: lineLook(item),
        // How it draws but for its colour, and where it runs, to tell a
        // change it takes in place: kept for lines that can settle.
        shape: settled ? looks.shape(item) : null,
        positions: settled ? flatPositions(item.positions) : null,
        // An outlined line, which never settles, takes its colours in
        // place too: how it draws but for them; and so does an aged one.
        outlined: item.style.outline || aged(item) ? looks.shape(item) : null,
        id,
        polyline,
        reveal,
        // Hidden, out of the collection until it shows (`addPolyline`).
        parked,
        home: polylines,
        // Drawn in the set's static batch instead (`settleLines`).
        batched: null,
      });
    }
    let own = polylines;
    // Lines in the collection that can settle into a static batch draw
    // beside it once they do.
    const settling = items.some(settles);
    if (deep || settling || inertial || pieces) {
      own = new Cesium.PrimitiveCollection();
      own.add(polylines);
      if (deep) own.add(deep);
      if (inertial) own.add(inertial);
      if (pieces) own.add(pieces);
    }
    record.deepLines = deep;
    record.inertialLines = inertial;
    if (inertial || record.inertialPieces.length) turnInertial(record);
    record.polylines = polylines;
    record.lineBox = settling ? own : null;
    record.batch = null;
    record.batchPending = null;
    record.changedAt = now();
    record.settleStage = SETTLE_SHORT;
    if (!draped.size && !glows.size && !alone.length && !groundPieces.length) {
      noteFlows(record);
      return replaceHost(record, own);
    }
    // Draped lines drape as the entities' clamped polylines do.
    const byClamp = new Map();
    const ground = [...draped].map(([clampTo, geometryInstances]) => {
      const primitive = new Cesium.GroundPolylinePrimitive({
        geometryInstances,
        appearance: new Cesium.PolylineColorAppearance(),
        classificationType: classificationOf(clampTo),
        allowPicking: record.spec.pickable !== false,
      });
      byClamp.set(clampTo, primitive);
      return primitive;
    });
    for (const part of parts.values())
      if (part.clampTo && byClamp.has(part.clampTo)) {
        part.ground = byClamp.get(part.clampTo);
        part.batch = part.ground;
      }
    for (const lines of glows.values()) {
      const [{ item, part: first }] = lines;
      const material = lineMaterial(record, item.style);
      const primitive = new Cesium.GroundPolylinePrimitive({
        geometryInstances: lines.map(({ item, part }) =>
          drapedInstance(item, part, false),
        ),
        appearance: new Cesium.PolylineMaterialAppearance({ material }),
        classificationType: classificationOf(first.clampTo),
        allowPicking: record.spec.pickable !== false,
      });
      // A batch as the solid ones are: a line moved leaves it, hidden.
      for (const { part } of lines) {
        part.ground = primitive;
        part.batch = primitive;
        part.material = material;
        part.shared = true;
      }
      ground.push(primitive);
    }
    for (const { item, part } of alone) {
      part.ground = drapedPrimitive(record, item, part, false);
      ground.push(part.ground);
    }
    ground.push(...groundPieces);
    noteFlows(record);
    replaceHost(record, collect(own, ground), ground, own);
  }

  /**
   * A line style but for its colours (and a split line's split), which its
   * material takes in place.
   */
  const colourlessStyle = (style) =>
    style.outline
      ? {
          ...style,
          color: undefined,
          outline: { ...style.outline, color: undefined },
        }
      : style.kind === 'split'
        ? {
            ...style,
            color: undefined,
            behind: undefined,
            at: undefined,
            reverse: undefined,
          }
        : { ...style, color: undefined };

  /** Give a line's material its style's colours, its outline's too. */
  function paintLine(material, style) {
    material = styleMaterial(material);
    material.uniforms.color = toColor(style.color);
    if (style.outline && 'outlineColor' in material.uniforms)
      material.uniforms.outlineColor = toColor(style.outline.color);
    if (style.kind === 'split' && 'splitAt' in material.uniforms)
      Object.assign(material.uniforms, splitUniforms(style));
  }

  /**
   * How a line draws, but for where it runs, whether it shows and how much
   * of it is revealed: lines that keep it can be changed in place.
   */
  const lineLook = (item, colourless = false) =>
    JSON.stringify([
      item.mode,
      item.widthPx,
      item.clampTo,
      colourless ? colourlessStyle(item.style) : item.style,
      // The same depth-fail style in any key order.
      item.depthFail
        ? [
            item.depthFail.kind,
            item.depthFail.color,
            item.depthFail.length,
            item.depthFail.pattern16,
          ]
        : null,
      // Segment colours and shows change in place.
      item.segmentColors != null,
      item.segmentShow != null,
      revealed(item),
      item.frame,
      // Where its runs start.
      broken(item) ? Array.from(item.breaks) : null,
      // How it fades with age (its times change with its positions).
      aged(item)
        ? [
            item.ageFade.windowMs,
            item.ageFade.alphaFloor,
            item.ageFade.squaredAlphaFloor,
            item.ageFade.widthFloor,
            showUniform(timeWindows ? item.ageFade.showMs : undefined),
          ]
        : null,
    ]);

  /**
   * Whether two lines have the same `lineLook` by the identity of what it
   * is drawn from, read without stringifying either.
   */
  const sameLookFrom = (a, b) =>
    a.mode === b.mode &&
    Object.is(a.widthPx, b.widthPx) &&
    a.clampTo === b.clampTo &&
    a.style === b.style &&
    a.depthFail === b.depthFail &&
    (a.segmentColors != null) === (b.segmentColors != null) &&
    (a.segmentShow != null) === (b.segmentShow != null) &&
    revealed(a) === revealed(b) &&
    a.frame === b.frame &&
    (broken(a) ? a.breaks : null) === (broken(b) ? b.breaks : null) &&
    sameAgeLook(a, b);

  /** Whether two lines fade with age alike, but for their times. */
  const sameAgeLook = (a, b) => {
    if (aged(a) !== aged(b)) return false;
    if (!aged(a)) return true;
    const x = a.ageFade;
    const y = b.ageFade;
    return (
      x.windowMs === y.windowMs &&
      x.alphaFloor === y.alphaFloor &&
      x.squaredAlphaFloor === y.squaredAlphaFloor &&
      x.widthFloor === y.widthFloor &&
      (!timeWindows || x.showMs === y.showMs)
    );
  };

  /**
   * `lineLook`, kept for the last item asked for: within one upsert, lines
   * sent with one style object (lines pulsing together) are stringified
   * once. Not across upserts, where a caller may have changed the style
   * object it sends again.
   */
  function lineLooks() {
    let last = null;
    let look = '';
    let shape = '';
    return {
      look(item) {
        if (!last || !sameLookFrom(last, item)) {
          last = item;
          look = lineLook(item);
          shape = '';
        }
        return look;
      },
      shape(item) {
        this.look(item);
        shape ||= lineLook(item, true);
        return shape;
      },
    };
  }

  /** A line's positions as one flat array of numbers, to compare. */
  function flatPositions(positions) {
    if (positions instanceof Float64Array) return Array.from(positions);
    const flat = [];
    for (const p of positions)
      if ('x' in p) flat.push(p.x, p.y, p.z);
      else flat.push(p.lon, p.lat, p.height ?? 0, NaN);
    return flat;
  }

  /** Whether a line's age times are `times` (null: it does not fade). */
  const sameTimes = (item, times) =>
    aged(item)
      ? times !== null &&
        item.ageFade.times.length === times.length &&
        Array.prototype.every.call(item.ageFade.times, (time, i) =>
          Object.is(time, times[i]),
        )
      : times === null;

  const samePositions = (a, b) =>
    a === b ||
    (a.length === b.length && a.every((value, i) => Object.is(value, b[i])));

  /**
   * Whether a line's positions are those `flat` (a `flatPositions`) holds,
   * read without flattening them: lines sent again every frame, unmoved,
   * make nothing new.
   */
  function flatEquals(positions, flat) {
    const same = (value, at) => at < flat.length && Object.is(value, flat[at]);
    if (positions instanceof Float64Array) {
      if (positions.length !== flat.length) return false;
      for (let i = 0; i < positions.length; i++)
        if (!same(positions[i], i)) return false;
      return true;
    }
    let at = 0;
    for (let i = 0; i < positions.length; i++) {
      const p = positions[i];
      if ('x' in p) {
        if (!same(p.x, at) || !same(p.y, at + 1) || !same(p.z, at + 2))
          return false;
        at += 3;
        continue;
      }
      if (
        !same(p.lon, at) ||
        !same(p.lat, at + 1) ||
        !same(p.height ?? 0, at + 2) ||
        !same(NaN, at + 3)
      )
        return false;
      at += 4;
    }
    return at === flat.length;
  }

  /**
   * Whether a draped line drawn by a material of its own (not a batch's,
   * nor revealed or in segments) changes only its colour: its material
   * takes the new one in place.
   */
  const recolourable = (was, item, looks) =>
    Boolean(was.clampTo && was.material && !was.segments) &&
    !revealed(item) &&
    was.shape === (looks ? looks.shape(item) : lineLook(item, true));

  /**
   * Whether an undraped line that can settle (in the collection or a
   * static batch), or an outlined one in the collection, changes only its
   * colours: it takes the new ones in place.
   */
  const recolourableSolid = (was, item, looks) =>
    (Boolean((was.polyline || was.batched) && was.shape) &&
      was.shape === looks.shape(item)) ||
    (Boolean(was.polyline && was.outlined) &&
      !revealed(item) &&
      was.outlined === looks.shape(item));

  /**
   * Whether a line drawn over the surface for a draped one changes only its
   * colour where it runs: it takes the new one in place
   * (`overlayRecoloured`).
   */
  const recolourableOverlay = (was, item, looks) =>
    Boolean(item.overlaid && was.deep && was.overlayShape) &&
    flatEquals(item.positions, was.overlayFrom) &&
    !revealed(item) &&
    was.overlayShape === overlayShape(item);

  /**
   * The colours the glow lines sharing a material that `list` recolours
   * are given together: each such material and the item whose colour it
   * takes, when every line it draws ends the upsert with one look (its
   * last in `list`); null when they would not, as the material draws them
   * all. Lines that move then draw on a material of their own.
   */
  function sharedRecolours(parts, list, looks) {
    const recolours = new Map();
    // Each shared line's last look in `list`, and the item it is from.
    let final = null;
    for (let k = 0; k < list.length; k++) {
      const was = parts.get(list[k].id);
      if (was.shared && !was.solo) (final ??= new Map()).set(list[k].id, k);
    }
    if (!final) return recolours;
    const lookOf = new Map();
    for (const [id, k] of final) {
      const was = parts.get(id);
      if (looks[k] === was.look) continue;
      recolours.set(was.material, list[k]);
      lookOf.set(was.material, looks[k]);
    }
    for (const [id, part] of parts) {
      if (!part.shared || part.solo || !lookOf.has(part.material)) continue;
      if (looks[final.get(id)] !== lookOf.get(part.material)) return null;
    }
    return recolours;
  }

  /**
   * Whether a draped line's upsert can change it in place: its ground
   * primitive is still there and, unless it moves, ready or building as
   * the set's pending one (or drawn alone); one that moves is built anew
   * at once, which needs Cesium's terrain heights loaded.
   */
  function drapedPatchable(record, was, flat) {
    if (was.ground?.isDestroyed() || was.batch?.isDestroyed()) return false;
    if (!samePositions(flat, was.positions))
      return groundSyncs() && typeof record.host?.add === 'function';
    if (was.solo) return true;
    return was.ground.ready || record.pending?.includes(was.ground);
  }

  /**
   * Upsert lines in place, without a rebuild, when every item is drawn now
   * and looks the same: then only whether it shows, its `meta`, how much of
   * it is revealed and where it runs change. An undraped line moves on the
   * polyline it has (one with a depth-fail colour is built anew, alone); a
   * draped one that moves is drawn by a ground primitive of its own, built
   * anew in the frame it moves (`drapedPatchable`). False, changing
   * nothing, otherwise.
   */
  function patchLines(record, list) {
    const parts = record.lineParts;
    if (record.kind !== 'lines' || !parts) return false;
    // Where the scene cannot drape, draped lines are patched as the lines
    // drawn over the surface for them, each built anew alone where it
    // changes (as any line with a depth-fail colour is).
    if (record.overlayLines) list = list.map(overlayLine);
    // Each draped line's positions, flattened once for both passes.
    const flats = new Map();
    // Each item's look, in order: an item sent twice is changed twice.
    const looks = [];
    const lookOf = lineLooks();
    for (const item of list) {
      const was = parts.get(item.id);
      if (!was) return false;
      // A pieced line takes new colours, shows and meta in place; anything
      // else about it is built anew.
      if (was.pieces) {
        if (
          !piecewise(item) ||
          lookOf.look(item) !== was.look ||
          !flatEquals(item.positions, was.from) ||
          !sameTimes(item, was.ageFrom) ||
          item.revealFraction !== was.reveal ||
          was.pieces.some((piece) => piece && pieceGone(piece))
        )
          return false;
        looks.push(was.look);
        continue;
      }
      const look = lookOf.look(item);
      // Only its colour may change: its material takes it in place.
      if (
        was.look !== look &&
        !recolourable(was, item, lookOf) &&
        !recolourableSolid(was, item, lookOf) &&
        !recolourableOverlay(was, item, lookOf)
      )
        return false;
      // A viewer destroyed under the set took its batch with it.
      if (was.batched?.isDestroyed()) return false;
      if (was.home?.isDestroyed()) return false;
      looks.push(look);
      if (was.deep !== undefined && record.deepLines?.isDestroyed())
        return false;
      if (!was.clampTo) continue;
      // A draped line that fades with age is built anew: its times may
      // have changed with or without its positions.
      if (aged(item)) return false;
      const flat = flatEquals(item.positions, was.positions)
        ? was.positions
        : flatPositions(item.positions);
      // A segmented line that moves is built anew, segment by segment (so
      // one that moves every frame is not drawn until it stops: segments
      // are for lines that move only now and then).
      if (was.segments && !samePositions(flat, was.positions)) return false;
      // One with no length draws nothing, whatever its segments' looks.
      if (was.segments && !was.ground) continue;
      if (!drapedPatchable(record, was, flat)) return false;
      flats.set(item.id, flat);
    }
    const shared = sharedRecolours(parts, list, looks);
    if (!shared) return false;
    // Shared materials take their one colour once, before lines move off
    // them.
    for (const [material, item] of shared) paintLine(material, item.style);
    for (let k = 0; k < list.length; k++) {
      const item = list[k];
      const was = parts.get(item.id);
      const show = item.show !== false;
      if (was.pieces) {
        was.id.meta = item.meta;
        writePieces(was, item);
        continue;
      }
      if (was.polyline || was.parked || was.batched) {
        patchUndraped(record, was, item, looks[k]);
        continue;
      }
      if (was.look !== looks[k] && was.deep === undefined) {
        // A line drawing on a shared material took its colour above.
        if (!was.shared || was.solo) paintLine(was.material, item.style);
        was.look = looks[k];
      }
      if (was.deep !== undefined) {
        was.id.meta = item.meta;
        was.look = looks[k];
        // One drawn for a draped line that runs where it ran takes its new
        // look in place (heat-lines pulse every frame).
        if (overlayRecoloured(record, was, item)) continue;
        // Built anew where it now runs, under the same pick id.
        const deep = record.deepLines;
        const old = was.deep;
        if (old) {
          dropFlow(record, old.appearance.material, item.style);
          dropFlow(record, old.depthFailAppearance.material, item.style);
        }
        was.deep = depthFailLine(record, item, was.id);
        if (was.deep) deep.add(was.deep);
        if (old) deep.remove(old);
        if (item.overlaid) overlayMoved(record, was, item);
        else if (was.overlayFrom) overlayLeft(record, was);
        continue;
      }
      was.id.meta = item.meta;
      if (was.segments) {
        if (!was.ground) continue;
        // A newer write supersedes one queued while the ground built.
        was.pendingItem = was.ground.ready ? undefined : item;
        if (was.ground.ready) writeSegments(was, item);
        continue;
      }
      const flat = flats.get(item.id);
      if (!samePositions(flat, was.positions)) {
        moveDraped(record, was, item, flat);
        continue;
      }
      if (was.material && revealed(item))
        unaged(was.material).uniforms.reveal = revealUniform(
          item.revealFraction,
        );
      if (was.solo) {
        // Not yet drawn, it is built again showing as asked.
        if (was.ground && was.ground.ready) showPart(was, show);
        else if (was.ground) moveDraped(record, was, item, flat);
        continue;
      }
      // A ground primitive still building takes its show once it is ready
      // (`swapReady`), so a show change never restarts the build.
      // A show queued while it built is stale once a newer one is applied.
      if (was.ground.ready) {
        showPart(was, show);
        was.pendingShow = undefined;
      } else was.pendingShow = show;
    }
    return true;
  }

  /**
   * An undraped line without a depth-fail colour in the set's polyline
   * collection, under pick id `id`; `reveal` is the material its reveal
   * is set on, or null. A hidden line that never settles (`park`) is
   * parked instead, out of the collection (`polyline` null, `parked`
   * true): the collection draws every line it holds, shown or not, each
   * on a material and command of its own, every frame; a hidden line
   * that settles costs nothing once in its static batch.
   */
  function addPolyline(record, polylines, item, id, park = false) {
    if (park && item.show === false)
      return { polyline: null, reveal: null, parked: true };
    const positions = linePositions(item);
    const reveal = revealed(item)
      ? revealUniform(item.revealFraction, positions)
      : undefined;
    const material = lineMaterial(
      record,
      item.style,
      reveal,
      ageOf(item, positions),
    );
    const polyline = polylines.add({
      positions,
      width: item.widthPx,
      material,
      show: item.show !== false,
      id,
    });
    // The collection destroys the material when it lets the line go.
    claimAges(record, null);
    return {
      polyline,
      reveal: reveal === undefined ? null : unaged(material),
      parked: false,
    };
  }

  /**
   * Whether an undraped line can be drawn in a static batch: solid, all of
   * it shown, at least half a pixel wide, and without a depth-fail colour
   * (those draw alone).
   */
  const settles = (item) =>
    item.mode !== 'draped' &&
    item.frame !== 'inertial' &&
    !item.depthFail &&
    // A line in runs draws a piece a run.
    !broken(item) &&
    // A batch draws one colour per line, unfaded.
    !aged(item) &&
    item.style.kind === 'solid' &&
    // A batch draws one colour per line, no outline.
    !item.style.outline &&
    !revealed(item) &&
    // The collection draws no line under half a pixel wide; a batch
    // would.
    item.widthPx >= 0.5;

  const finitePoint = (p) =>
    Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);

  /** Whether a line's colour is drawn in a batch's translucent pass. */
  const translucentLine = (item) => toColor(item.style.color).alpha < 1;

  /**
   * Stop waiting for a set's lines to settle: they changed. A static batch
   * still building drew them as they were, so it is dropped.
   */
  function unsettle(record) {
    record.changedAt = now();
    record.settleStage = SETTLE_SHORT;
    const pending = record.batchPending;
    if (!pending) return;
    record.batchPending = null;
    if (record.lineBox && !record.lineBox.isDestroyed())
      for (const primitive of pending.primitives)
        record.lineBox.remove(primitive);
  }

  /**
   * Change an undraped line drawn in the collection or a static batch in
   * place: its show and colour, and where it runs. A batched line that
   * moves, or whose colour leaves its batch's pass, leaves the batch,
   * hidden there, for the collection, until the set settles again.
   */
  function patchUndraped(record, was, item, look) {
    const show = item.show !== false;
    // The polyline's pick id and the batch instance's are this one.
    was.id.meta = item.meta;
    const recolour = was.look !== look;
    was.look = look;
    if (was.batched) {
      const stays =
        flatEquals(item.positions, was.positions) &&
        (!recolour || translucentLine(item) === was.translucent);
      const attributes = was.batched.getGeometryInstanceAttributes(was.id);
      if (stays) {
        // A batch still building draws the colour it was built with.
        if (recolour) {
          if (record.batchPending) unsettle(record);
          attributes.color = Cesium.ColorGeometryInstanceAttribute.toValue(
            toColor(item.style.color),
            attributes.color,
          );
        }
        attributes.show = Cesium.ShowGeometryInstanceAttribute.toValue(
          show,
          attributes.show,
        );
        return;
      }
      attributes.show = Cesium.ShowGeometryInstanceAttribute.toValue(
        false,
        attributes.show,
      );
      was.batched = null;
      was.positions = flatPositions(item.positions);
      Object.assign(was, addPolyline(record, record.polylines, item, was.id));
      unsettle(record);
      return;
    }
    if (!show && !was.shape) {
      // Parked out of the collection, which would draw it on regardless
      // (a line that settles is hidden in its batch instead).
      if (was.polyline) {
        dropFlow(record, was.polyline.material, item.style);
        was.home.remove(was.polyline);
        was.polyline = null;
        was.reveal = null;
        requestRender();
      }
      was.parked = true;
      return;
    }
    if (was.parked) {
      // Back in the collection, as it now is.
      Object.assign(was, addPolyline(record, was.home, item, was.id));
      requestRender();
      return;
    }
    // Only a change a batch would draw unsettles the set: a show is taken
    // when the batch swaps in, and lines that cannot settle are not in it.
    if (was.shape && (recolour || !flatEquals(item.positions, was.positions))) {
      was.positions = flatPositions(item.positions);
      unsettle(record);
    }
    // A line sent again where it runs keeps its positions: writing them
    // would have the collection rewrite its vertices.
    const drawn = was.polyline.positions;
    const unmoved = drawnAt(drawn, item.positions);
    // One that moves by as many points (a front stepping out) is written
    // into the points it has, which the polyline then takes again.
    const positions =
      unmoved || rewrite(drawn, item) ? drawn : linePositions(item);
    if (!unmoved) was.polyline.positions = positions;
    was.polyline.show = show;
    if (recolour) paintLine(was.polyline.material, item.style);
    // Its points' times, with its points.
    if (aged(item))
      writeAge(record, was.polyline.material, ageOf(item, positions));
    if (was.reveal)
      was.reveal.uniforms.reveal = revealUniform(
        item.revealFraction,
        positions,
      );
  }

  /**
   * Write a line's new positions into `drawn`, the Cartesians a polyline
   * draws (made by `linePositions`), when they are as many and convert one
   * for one (not geodesic): true if written, else false, writing nothing.
   */
  function rewrite(drawn, item) {
    if (item.mode === 'geodesic' || !Array.isArray(drawn)) return false;
    const positions = item.positions;
    if (positions instanceof Float64Array) {
      if (positions.length !== drawn.length * 3) return false;
      for (let i = 0; i < drawn.length; i++)
        Cesium.Cartesian3.fromElements(
          positions[i * 3],
          positions[i * 3 + 1],
          positions[i * 3 + 2],
          drawn[i],
        );
      return true;
    }
    if (positions.length !== drawn.length) return false;
    for (let i = 0; i < drawn.length; i++)
      toCartesianInto(positions[i], drawn[i]);
    return true;
  }

  /**
   * Whether `positions` (an item's, ECEF points or packed triples) are the
   * Cartesians a polyline already draws. False for any given by longitude
   * and latitude, which are converted, not compared.
   */
  function drawnAt(drawn, positions) {
    if (!Array.isArray(drawn)) return false;
    if (positions instanceof Float64Array) {
      if (positions.length !== drawn.length * 3) return false;
      for (let i = 0; i < drawn.length; i++) {
        const p = drawn[i];
        if (
          !Object.is(p.x, positions[i * 3]) ||
          !Object.is(p.y, positions[i * 3 + 1]) ||
          !Object.is(p.z, positions[i * 3 + 2])
        )
          return false;
      }
      return true;
    }
    if (positions.length !== drawn.length) return false;
    for (let i = 0; i < drawn.length; i++) {
      const p = positions[i];
      const q = drawn[i];
      if (
        !('x' in p) ||
        !Object.is(p.x, q.x) ||
        !Object.is(p.y, q.y) ||
        !Object.is(p.z, q.z)
      )
        return false;
    }
    return true;
  }

  /**
   * After a draw: a line set whose lines have not changed for `SETTLE_MS`
   * starts building its static batch, of all its lines that `settles`, once
   * some are still in the collection (when it has a batch and only a few
   * are, after `LONG_SETTLE_MS`); one
   * built swaps in for the collection's lines it draws (`swapBatch`).
   * Unchanged lines in a polyline collection cost a material id a line
   * every frame; in a batch they cost nothing until they change.
   */
  function settleLines(record) {
    if (!record.lineBox || record.lineBox.isDestroyed()) return;
    if (record.batchPending) {
      swapBatch(record);
      return;
    }
    if (record.settleStage === SETTLE_DONE) return;
    const wait =
      record.settleStage === SETTLE_SHORT ? SETTLE_MS : LONG_SETTLE_MS;
    if (now() - record.changedAt < wait) return;
    // The lines that can settle still in the collection: a batch is
    // rebuilt whole for them, so a few wait longer, as a few cost little.
    let loose = 0;
    for (const part of record.lineParts.values())
      if (part.polyline && part.shape) loose += 1;
    if (
      record.batch &&
      loose < FEW_LOOSE_LINES &&
      record.settleStage === SETTLE_SHORT
    ) {
      record.settleStage = SETTLE_LONG;
      return;
    }
    record.settleStage = SETTLE_DONE;
    if (!loose) return;
    const members = [];
    for (const [itemId, part] of record.lineParts) {
      if (!part.shape || (!part.polyline && !part.batched)) continue;
      const item = record.items.get(itemId);
      if (!item || !settles(item)) continue;
      const positions = linePositions(item);
      // A batch that fails to build would throw in every frame after.
      if (!drawable(positions) || !positions.every(finitePoint)) continue;
      members.push({ part, item, positions });
    }
    if (!members.some(({ part }) => part.polyline)) return;
    const groups = [[], []];
    for (const member of members) {
      member.translucent = translucentLine(member.item);
      member.show = member.item.show !== false;
      groups[member.translucent ? 1 : 0].push(
        new Cesium.GeometryInstance({
          geometry: new Cesium.PolylineGeometry({
            positions: member.positions,
            width: member.item.widthPx,
            vertexFormat: Cesium.PolylineColorAppearance.VERTEX_FORMAT,
            // Straight between the positions, as the collection's lines
            // are (geodesic ones come densified).
            arcType: Cesium.ArcType.NONE,
          }),
          attributes: {
            color: Cesium.ColorGeometryInstanceAttribute.fromColor(
              toColor(member.item.style.color),
            ),
            show: new Cesium.ShowGeometryInstanceAttribute(member.show),
          },
          id: member.part.id,
        }),
      );
      member.flat = flatPositions(member.item.positions);
    }
    const primitives = [];
    for (const [translucent, geometryInstances] of groups.entries()) {
      if (!geometryInstances.length) continue;
      const primitive = new StaticLines({
        geometryInstances,
        appearance: new Cesium.PolylineColorAppearance({
          translucent: Boolean(translucent),
        }),
        // Hidden while it builds: the collection draws its lines.
        show: false,
      });
      primitive.translucentLines = Boolean(translucent);
      primitives.push(primitive);
      record.lineBox.add(primitive);
    }
    record.batchPending = { primitives, members };
  }

  /**
   * A static batch built: it draws its lines in place of the collection's
   * polylines and the batch before it, each line showing as its item now
   * asks (shows changed while it built).
   */
  function swapBatch(record) {
    const { primitives, members } = record.batchPending;
    const failed = primitives.find((p) => p.failed);
    if (failed) {
      // The collection draws on; the set settles no more.
      unsettle(record);
      record.lineBox = null;
      throw failed.failed;
    }
    if (primitives.some((p) => !p.ready)) return;
    record.batchPending = null;
    const box = record.lineBox;
    for (const primitive of record.batch ?? []) box.remove(primitive);
    record.batch = primitives;
    const byPass = new Map(primitives.map((p) => [p.translucentLines, p]));
    let removed = 0;
    for (const { part, item, translucent, show, flat } of members) {
      const batch = byPass.get(translucent);
      if (part.polyline) {
        record.polylines.remove(part.polyline);
        part.polyline = null;
        part.reveal = null;
        removed += 1;
      }
      part.batched = batch;
      part.translucent = translucent;
      part.positions = flat;
      const now = record.items.get(item.id)?.show !== false;
      if (now !== show) {
        const attributes = batch.getGeometryInstanceAttributes(part.id);
        attributes.show = Cesium.ShowGeometryInstanceAttribute.toValue(
          now,
          attributes.show,
        );
      }
    }
    for (const primitive of primitives) primitive.show = true;
    if (removed) requestRender();
  }

  /**
   * Draw a draped line where it now runs, in this frame: on a ground
   * primitive of its own built at once, in place of its own one (or of its
   * place in its batch, hidden there). Positions that make no line draw
   * nothing until they do again.
   */
  function moveDraped(record, part, item, flat) {
    const host = record.host;
    const old = part.ground;
    if (old && old !== part.batch) {
      dropFlow(record, part.material, item.style);
      for (const list of new Set([record.pending, record.ground])) {
        const at = list?.indexOf(old) ?? -1;
        if (at >= 0) list.splice(at, 1);
      }
      host.remove(old);
    } else if (old) {
      // Its batch draws on without it, hidden now or once it is ready.
      part.batchHidden = true;
      if (old.ready) showOn(old, part.id, false);
    }
    hideRetiring(record, item.id);
    part.solo = true;
    part.positions = flat;
    part.pendingShow = undefined;
    const positions = linePositions(item);
    part.material = null;
    part.ground = drawable(positions)
      ? drapedPrimitive(record, item, part, true, positions)
      : null;
    if (part.ground) host.add(part.ground);
  }

  /**
   * Hide where the host a set is rebuilding from still draws a draped line,
   * once the line is drawn where it now is: else both would draw (and
   * pick) until the rebuild is ready.
   */
  function hideRetiring(record, id) {
    const part = record.retiring && record.retiringParts?.get(id);
    const ground = part?.ground;
    if (!ground || ground.isDestroyed() || !ground.ready) return;
    // A segmented line draws under a pick id a segment.
    if (part.segments)
      for (const segment of part.segments) {
        if (segment) showOn(ground, segment, false);
      }
    else showOn(ground, part.id, false);
  }

  /** A draped line part's show, on its ready ground primitive. */
  const showPart = (part, show) => showOn(part.ground, part.id, show);

  /** The show of the instance under pick id `id` in a ready ground primitive. */
  function showOn(ground, id, show) {
    const attributes = ground.getGeometryInstanceAttributes(id);
    attributes.show = Cesium.ShowGeometryInstanceAttribute.toValue(
      show,
      attributes.show,
    );
  }

  /**
   * The shows patched in while a set's ground primitives were building,
   * and the lines drawn alone since, hidden in their batches.
   */
  function showPending(record) {
    for (const part of record.shapeParts?.values() ?? []) {
      // A shape drawn alone since it moved stays hidden in its batch.
      if (part.batchHidden && part.batch && !part.batch.isDestroyed())
        showOn(part.batch, part.id, false);
      if (
        part.pendingShow !== undefined &&
        part.ground &&
        !part.ground.isDestroyed()
      ) {
        showOn(part.ground, part.id, part.pendingShow);
        part.pendingShow = undefined;
      }
      if (
        part.pendingColour !== undefined &&
        part.ground &&
        !part.ground.isDestroyed()
      ) {
        colourOn(part.ground, part.id, part.pendingColour);
        part.pendingColour = undefined;
      }
    }
    for (const part of record.lineParts?.values() ?? []) {
      for (const piece of part.pieces ?? [])
        if (
          piece?.pendingShow !== undefined &&
          !piece.primitive.isDestroyed() &&
          piece.primitive.ready
        ) {
          showOn(piece.primitive, piece.id, piece.pendingShow);
          piece.pendingShow = undefined;
        }
      if (part.batchHidden && part.batch && !part.batch.isDestroyed())
        showOn(part.batch, part.id, false);
      if (
        part.pendingShow !== undefined &&
        part.ground &&
        !part.ground.isDestroyed()
      ) {
        showPart(part, part.pendingShow);
        part.pendingShow = undefined;
      }
      if (part.pendingItem && part.ground && !part.ground.isDestroyed()) {
        writeSegments(part, part.pendingItem);
        part.pendingItem = undefined;
      }
    }
  }

  /** Whether a line is drawn segment by segment, in colours or shows of their own. */
  const segmented = (item) =>
    item.segmentColors != null || item.segmentShow != null;

  /** A segment's colour and whether it shows. */
  const segmentLook = (item, j) => ({
    color: toColor(item.segmentColors?.[j] ?? item.style.color),
    show: item.show !== false && item.segmentShow?.[j] !== false,
  });

  /** What a segment draws, to tell whether an upsert changes it. */
  const segmentKey = ({ color, show }) =>
    `${color.red},${color.green},${color.blue},${color.alpha},${show}`;

  /**
   * A draped line drawn segment by segment: a ground polyline instance a
   * segment, each with a pick id of its own that reads as the line's (and
   * that height queries see through), so its colour and show change in
   * place. A segment of no length draws nothing.
   */
  function segmentInstances(record, item, part) {
    const points = linePositions(item);
    const instances = [];
    const starts = runStarts(item);
    part.segments = [];
    part.drawn = [];
    for (let j = 0; j + 1 < points.length; j++) {
      // Nothing across a break, between two runs.
      if (
        starts?.has(j + 1) ||
        Cesium.Cartesian3.equals(points[j], points[j + 1])
      ) {
        part.segments.push(null);
        part.drawn.push(null);
        continue;
      }
      const id = Object.create(part.id);
      record.pickIds.push(id);
      const look = segmentLook(item, j);
      part.segments.push(id);
      part.drawn.push(segmentKey(look));
      instances.push(
        new Cesium.GeometryInstance({
          geometry: new Cesium.GroundPolylineGeometry({
            positions: [points[j], points[j + 1]],
            width: item.widthPx,
            arcType: Cesium.ArcType.GEODESIC,
          }),
          attributes: {
            color: Cesium.ColorGeometryInstanceAttribute.fromColor(look.color),
            show: new Cesium.ShowGeometryInstanceAttribute(look.show),
          },
          id,
        }),
      );
    }
    return instances;
  }

  /** A segmented line's colours and shows, on its ready ground primitive. */
  function writeSegments(part, item) {
    for (let j = 0; j < part.segments.length; j++) {
      const id = part.segments[j];
      if (!id) continue;
      const look = segmentLook(item, j);
      const key = segmentKey(look);
      if (key === part.drawn[j]) continue;
      part.drawn[j] = key;
      const attributes = part.ground.getGeometryInstanceAttributes(id);
      attributes.color = Cesium.ColorGeometryInstanceAttribute.toValue(
        look.color,
        attributes.color,
      );
      attributes.show = Cesium.ShowGeometryInstanceAttribute.toValue(
        look.show,
        attributes.show,
      );
    }
  }

  /** One host for a set's own collection and its ground primitives. */
  function collect(own, ground) {
    const host = new Cesium.PrimitiveCollection();
    if (own) host.add(own);
    for (const primitive of ground) host.add(primitive);
    return host;
  }

  const heightOf = (pos) =>
    'x' in pos
      ? Cesium.Cartographic.fromCartesian(toCartesian(pos)).height
      : (pos.height ?? 0);

  function shapeGeometry(item, vertexFormat) {
    const g = item.geometry;
    const extrudedHeight = item.extrudeHeight;
    switch (g.kind) {
      case 'polygon': {
        const [outer, ...holes] = g.rings.map((ring) => ring.map(toCartesian));
        const hierarchy = new Cesium.PolygonHierarchy(
          outer,
          holes.map((h) => new Cesium.PolygonHierarchy(h)),
        );
        const polygon = {
          polygonHierarchy: hierarchy,
          height: g.perPositionHeight ? undefined : heightOf(g.rings[0][0]),
          extrudedHeight,
          perPositionHeight: g.perPositionHeight,
        };
        return {
          fill: new Cesium.PolygonGeometry({ ...polygon, vertexFormat }),
          // Extruded, its outline is the volume's edges (both faces and the
          // walls' corners), as the entities' extruded polygons draw it.
          outline:
            item.outline && extrudedHeight !== undefined
              ? new Cesium.PolygonOutlineGeometry(polygon)
              : undefined,
          // Its holes are outlined too, as the entities' polygons outline them.
          rings: [outer, ...holes],
        };
      }
      case 'ellipse': {
        const ellipse = {
          center: toCartesian(g.center),
          semiMajorAxis: g.semiMajor,
          semiMinorAxis: g.semiMinor,
          rotation: g.rotation ?? 0,
          height: heightOf(g.center),
          extrudedHeight,
        };
        return {
          fill: new Cesium.EllipseGeometry({ ...ellipse, vertexFormat }),
          // Its outline is an outline geometry, as the entities' ellipses draw it.
          outline: item.outline
            ? new Cesium.EllipseOutlineGeometry(ellipse)
            : undefined,
        };
      }
      case 'rectangle':
        return {
          fill: new Cesium.RectangleGeometry({
            rectangle: Cesium.Rectangle.fromDegrees(
              g.rect.west,
              g.rect.south,
              g.rect.east,
              g.rect.north,
            ),
            height: g.height ?? 0,
            extrudedHeight,
            // An image fill turns with the rectangle, as a KML overlay's does.
            rotation: g.rotation ?? 0,
            stRotation: g.rotation ?? 0,
            vertexFormat,
          }),
        };
      case 'wall': {
        // Up from `minimumHeights` (the ellipsoid) to `maximumHeights` (the
        // positions' own), as the entities' walls draw.
        const wall = {
          positions: g.positions.map(toCartesian),
          minimumHeights: g.minimumHeights,
          maximumHeights: g.maximumHeights,
        };
        return {
          fill: new Cesium.WallGeometry({ ...wall, vertexFormat }),
          outline: item.outline
            ? new Cesium.WallOutlineGeometry(wall)
            : undefined,
        };
      }
      default:
        throw new Error(`the Cesium renderer has no ${g.kind} shapes`);
    }
  }

  /**
   * A clamped shape's fill geometry, on the ellipsoid for draping; an
   * ellipse with an image fill is cut finely, so a round image's edge runs
   * round.
   */
  function groundGeometry(item, imageFill = false) {
    const g = item.geometry;
    switch (g.kind) {
      case 'polygon': {
        const [outer, ...holes] = g.rings.map((ring) => ring.map(toCartesian));
        return new Cesium.PolygonGeometry({
          polygonHierarchy: new Cesium.PolygonHierarchy(
            outer,
            holes.map((h) => new Cesium.PolygonHierarchy(h)),
          ),
        });
      }
      case 'ellipse': {
        const major = g.semiMajor;
        const minor = g.semiMinor;
        // A semi-minor axis longer than the semi-major one is drawn as
        // Cesium's semi-major axis, a quarter turn on.
        const crossed = minor > major;
        return new Cesium.EllipseGeometry({
          center: toCartesian(g.center),
          semiMajorAxis: crossed ? minor : major,
          semiMinorAxis: crossed ? major : minor,
          rotation: (g.rotation ?? 0) + (crossed ? Math.PI / 2 : 0),
          ...(imageFill
            ? {
                granularity: IMAGE_ELLIPSE_GRANULARITY,
                vertexFormat:
                  Cesium.MaterialAppearance.MaterialSupport.TEXTURED
                    .vertexFormat,
              }
            : {}),
        });
      }
      case 'rectangle':
        return new Cesium.RectangleGeometry({
          rectangle: Cesium.Rectangle.fromDegrees(
            g.rect.west,
            g.rect.south,
            g.rect.east,
            g.rect.north,
          ),
          rotation: g.rotation ?? 0,
          stRotation: g.rotation ?? 0,
        });
      default:
        throw new Error(`the Cesium renderer cannot clamp ${g.kind} shapes`);
    }
  }

  /** The surface's height under a position now, metres; 0 where unknown. */
  function surfaceHeight(cartesian, clampTo) {
    const at = Cesium.Cartographic.fromCartesian(cartesian);
    if (!at) return 0;
    const globe = scene.globe;
    if (clampTo !== 'tiles' && globe?.show !== false) {
      const h = globe?.getHeight?.(at);
      if (Number.isFinite(h)) return h;
    }
    if (clampTo !== 'terrain' && scene.sampleHeightSupported) {
      try {
        const h = scene.sampleHeight(at);
        if (Number.isFinite(h)) return h;
      } catch {
        // No depth to sample in this scene: the ellipsoid.
      }
    }
    return 0;
  }

  /**
   * A clamped shape a ground primitive cannot drape, as one standing on the
   * surface, unclamped: an extruded one (its base at the lowest surface
   * height under it, up to its `extrudeHeight`), a wall (its foot on the
   * surface under each position, its heights above it), and an image fill
   * where the scene cannot drape materials (on the surface under it). The
   * surface is read when the set is built. Any other item is itself.
   */
  function standing(record, item) {
    if (item.height !== 'clampGround') return item;
    const g = item.geometry;
    const imageFill =
      item.fill && typeof item.fill === 'object' && !Array.isArray(item.fill);
    if (
      item.extrudeHeight === undefined &&
      g.kind !== 'wall' &&
      !(imageFill && scene.context?.depthTexture === false)
    )
      return item;
    const clampTo = item.clampTo ?? record.spec.clampTo ?? 'both';
    const at = (cartesian, height) => {
      const c = Cesium.Cartographic.fromCartesian(cartesian);
      return {
        lon: Cesium.Math.toDegrees(c.longitude),
        lat: Cesium.Math.toDegrees(c.latitude),
        height,
      };
    };
    const lowest = (points) =>
      Math.min(...points.map((p) => surfaceHeight(p, clampTo)));
    let geometry;
    switch (g.kind) {
      case 'polygon': {
        const rings = g.rings.map((ring) => ring.map(toCartesian));
        const base = lowest(rings.flat());
        geometry = {
          kind: 'polygon',
          rings: rings.map((ring) => ring.map((p) => at(p, base))),
        };
        break;
      }
      case 'ellipse': {
        const center = toCartesian(g.center);
        geometry = { ...g, center: at(center, lowest([center])) };
        break;
      }
      case 'rectangle': {
        const r = g.rect;
        const corners = [
          [r.west, r.south],
          [r.east, r.south],
          [r.east, r.north],
          [r.west, r.north],
          [(r.west + r.east) / 2, (r.south + r.north) / 2],
        ].map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat));
        geometry = { ...g, height: lowest(corners) };
        break;
      }
      case 'wall': {
        const points = g.positions.map(toCartesian);
        const feet = points.map((p) => surfaceHeight(p, clampTo));
        geometry = {
          kind: 'wall',
          positions: points.map((p, i) => at(p, feet[i])),
          minimumHeights: feet.map((h, i) => h + (g.minimumHeights?.[i] ?? 0)),
          maximumHeights: feet.map(
            (h, i) => h + (g.maximumHeights?.[i] ?? heightOf(g.positions[i])),
          ),
        };
        break;
      }
      default:
        return item;
    }
    return { ...item, geometry, height: 'absolute' };
  }

  /**
   * A clamped shape's outline as rings on the surface, each closed: a
   * polygon's rings, an ellipse cut in 64, a rectangle's turned corners.
   */
  function outlineRings(item) {
    const g = item.geometry;
    const closed = (ring) =>
      ring.length && !Cesium.Cartesian3.equals(ring[0], ring.at(-1))
        ? [...ring, ring[0]]
        : ring;
    switch (g.kind) {
      case 'polygon':
        return g.rings.map((ring) => closed(ring.map(toCartesian)));
      case 'ellipse': {
        const center = toCartesian(g.center);
        const enu = Cesium.Transforms.eastNorthUpToFixedFrame(center);
        const turn = g.rotation ?? 0;
        const ring = [];
        for (let k = 0; k < 64; k++) {
          const a = (k / 64) * 2 * Math.PI;
          // Along the semi-major axis at `rotation` counter-clockwise from north.
          const major = g.semiMajor * Math.cos(a);
          const minor = g.semiMinor * Math.sin(a);
          const east = -major * Math.sin(turn) + minor * Math.cos(turn);
          const north = major * Math.cos(turn) + minor * Math.sin(turn);
          ring.push(
            Cesium.Matrix4.multiplyByPoint(
              enu,
              new Cesium.Cartesian3(east, north, 0),
              new Cesium.Cartesian3(),
            ),
          );
        }
        return [closed(ring)];
      }
      case 'rectangle': {
        const r = g.rect;
        const cx = (r.west + r.east) / 2;
        const cy = (r.south + r.north) / 2;
        const c = Math.cos(g.rotation ?? 0);
        const sn = Math.sin(g.rotation ?? 0);
        const ring = [
          [r.west, r.south],
          [r.east, r.south],
          [r.east, r.north],
          [r.west, r.north],
        ].map(([lon, lat]) => {
          const dx = lon - cx;
          const dy = lat - cy;
          return Cesium.Cartesian3.fromDegrees(
            cx + dx * c - dy * sn,
            cy + dx * sn + dy * c,
          );
        });
        return [closed(ring)];
      }
      default:
        return [];
    }
  }

  /**
   * A set's clamped fills as ground primitives, packed as the entities'
   * ground batches are: a fill goes in the first batch it overlaps nothing
   * in, so overlapping translucent fills blend over each other.
   */
  function groundFills(record, items) {
    const batches = [];
    // Each clamped item as drawn, for upserts that only show or hide it;
    // the set keeps them once every one is built.
    const parts = new Map();
    // The shapes as the host this build replaces draws them, while it
    // still draws; a host already retiring keeps its own.
    if (!record.retiring) record.retiringShapeParts = record.shapeParts ?? null;
    record.shapeParts = null;
    // Clamped outlines, drawn as draped lines: a ground polyline each.
    const outlines = [];
    for (const item of items) {
      if (item.outline) outlines.push(item);
      if (!item.fill || item.outlineOnly) {
        parts.set(item.id, {
          look: lookOf(item),
          id: null,
          ground: null,
          pulse: pulseOf(item),
          show: item.show !== false,
        });
        continue;
      }
      const objectFill =
        typeof item.fill === 'object' && !Array.isArray(item.fill)
          ? item.fill
          : null;
      const imageFill = objectFill;
      if (imageFill && !imageFill.image)
        throw new Error('the Cesium renderer fills shapes with colours only');
      // Refused before anything is made, so nothing is left half built.
      const image = imageFill ? imageAt(imageFill.image) : null;
      // Hidden colour fills are built too, hidden, so showing them is a
      // change of their show, not a rebuild of every fill; a hidden one it
      // cannot build stays out, as before, and showing it rebuilds. Hidden
      // image fills are not passed in (`hiddenFillBuilds`): their textures
      // load when they show.
      let geometry;
      try {
        geometry = groundGeometry(item, Boolean(imageFill));
      } catch (error) {
        if (item.show === false) continue;
        throw error;
      }
      const part = {
        look: lookOf(item),
        id: pickId(record, item),
        ground: null,
        pulse: pulseOf(item),
        show: item.show !== false,
      };
      parts.set(item.id, part);
      const show = new Cesium.ShowGeometryInstanceAttribute(
        item.show !== false,
      );
      const instance = new Cesium.GeometryInstance({
        geometry,
        attributes: imageFill
          ? { show }
          : {
              color: Cesium.ColorGeometryInstanceAttribute.fromColor(
                toColor(item.fill),
              ),
              show,
            },
        id: part.id,
      });
      const clampTo = item.clampTo ?? record.spec.clampTo ?? 'both';
      if (imageFill) {
        // An image fill is a ground primitive of its own, with its material.
        // (Cesium turns its texture wrongly across the antimeridian: its
        // rotation points are taken against a centre wrapped to ±180°.)
        batches.push({
          clampTo,
          instances: [instance],
          parts: [part],
          image,
          imageFill,
        });
        continue;
      }
      const rectangle = instance.geometry.rectangle;
      let batch = batches.find(
        (b) =>
          b.rectangles &&
          b.clampTo === clampTo &&
          !b.rectangles.collides(rectangle),
      );
      if (!batch) {
        batch = {
          clampTo,
          instances: [],
          parts: [],
          rectangles: new Cesium.RectangleCollisionChecker(),
        };
        batches.push(batch);
      }
      batch.rectangles.insert(String(batch.instances.length), rectangle);
      batch.instances.push(instance);
      batch.parts.push(part);
    }
    const pickable = record.spec.pickable !== false;
    const Ground = pickable
      ? Cesium.GroundPrimitive
      : UnpickableGroundPrimitive;
    const grounds = batches.map((batch) => {
      const material = batch.imageFill
        ? holdImage(
            imageMaterial(batch.image, batch.imageFill.repeat),
            batch.imageFill.image,
          )
        : null;
      const ground = new Ground({
        geometryInstances: batch.instances,
        classificationType: classificationOf(batch.clampTo),
        allowPicking: pickable,
        ...(material
          ? {
              appearance: new Cesium.MaterialAppearance({
                material,
                materialSupport:
                  Cesium.MaterialAppearance.MaterialSupport.TEXTURED,
                translucent: true,
                flat: true,
              }),
            }
          : {}),
      });
      // Its material holds the texture, which the primitive leaves alone:
      // it goes with the primitive, which may outlive the host that built it
      // while a rebuild's ground primitives get ready.
      if (material) {
        const destroyGround = ground.destroy.bind(ground);
        ground.destroy = () => {
          if (!material.isDestroyed()) material.destroy();
          return destroyGround();
        };
      }
      for (const part of batch.parts) part.ground = ground;
      return ground;
    });
    for (const item of outlines) {
      const rings = outlineRings(item).filter((ring) => ring.length >= 2);
      if (!rings.length) continue;
      const part = parts.get(item.id);
      // Picked as its shape.
      part.id ??= pickId(record, item);
      // A pulsing outline's rings share one colour, its material's.
      const pulsing = Boolean(part.pulse);
      const outline = new Cesium.GroundPolylinePrimitive({
        geometryInstances: rings.map(
          (positions) =>
            new Cesium.GeometryInstance({
              geometry: new Cesium.GroundPolylineGeometry({
                positions,
                width: item.outlineWidth ?? 1,
                arcType: Cesium.ArcType.GEODESIC,
              }),
              attributes: {
                color: Cesium.ColorGeometryInstanceAttribute.fromColor(
                  toColor(item.outline),
                ),
                show: new Cesium.ShowGeometryInstanceAttribute(
                  item.show !== false,
                ),
              },
              id: part.id,
            }),
        ),
        appearance: pulsing
          ? new Cesium.PolylineMaterialAppearance({
              material: Cesium.Material.fromType('Color', {
                color: toColor(item.outline),
              }),
            })
          : new Cesium.PolylineColorAppearance(),
        classificationType: classificationOf(
          item.clampTo ?? record.spec.clampTo ?? 'both',
        ),
        allowPicking: pickable,
      });
      // Any change to an outlined clamped shape rebuilds the set.
      part.outlineGround = outline;
      grounds.push(outline);
    }
    record.shapeParts = parts;
    return grounds;
  }

  /**
   * How a clamped shape draws, but for whether it shows and its `meta`: a
   * copy of its values, so an item changed in place still reads as changed.
   */
  const lookOf = (item) => {
    const { show, meta, ...look } = item;
    return plainCopy(look);
  };

  /** A copy of plain data: arrays and objects copied, the rest kept. */
  function plainCopy(value) {
    if (Array.isArray(value) || ArrayBuffer.isView(value))
      return Array.from(value, plainCopy);
    if (!value || typeof value !== 'object') return value;
    const out = {};
    for (const key of Object.keys(value))
      if (value[key] !== undefined) out[key] = plainCopy(value[key]);
    return out;
  }

  /** Whether `value` holds what `look` (a `plainCopy`) holds. */
  function sameValues(look, value) {
    if (Array.isArray(look)) {
      if (!(Array.isArray(value) || ArrayBuffer.isView(value))) return false;
      if (look.length !== value.length) return false;
      for (let i = 0; i < look.length; i++)
        if (!sameValues(look[i], value[i])) return false;
      return true;
    }
    if (look && typeof look === 'object') {
      if (!value || typeof value !== 'object' || Array.isArray(value))
        return false;
      let count = 0;
      for (const key of Object.keys(value)) {
        if (value[key] === undefined) continue;
        count += 1;
        if (!(key in look) || !sameValues(look[key], value[key])) return false;
      }
      return count === Object.keys(look).length;
    }
    return look === value || (Number.isNaN(look) && Number.isNaN(value));
  }

  /** Whether `item` draws as the part's item did, but for show and `meta`. */
  function sameLook(part, item) {
    const { show, meta, ...look } = item;
    return sameValues(part.look, look);
  }

  /**
   * Upsert clamped shapes in place, without a rebuild, when every item is
   * drawn now and looks the same: then only whether it shows and its
   * `meta` change. A ground primitive still building takes the show once
   * it is ready (`swapReady`). A plain colour fill whose geometry alone
   * changed is drawn alone where it now is (`moveShape`), while no more
   * than `MOVING_SHAPES` would be. False, changing nothing, otherwise.
   */
  function patchShapes(record, list) {
    const parts = record.shapeParts;
    const solids = record.solidParts;
    if (record.kind !== 'shapes' || (!parts && !solids)) return false;
    // Each item's way in: `true` moves it (`moveShape`), `'solid'` changes
    // an unclamped one in place, `'recolour'` recolours a clamped one in
    // place, else it only shows, hides or takes its `meta`.
    const moves = [];
    for (const item of list) {
      const solid = solids?.get(item.id);
      if (solid) {
        if (!solidPatchable(solid, item)) return false;
        moves.push('solid');
        continue;
      }
      const was = parts?.get(item.id);
      if (!was || was.outlineGround) return false;
      if (was.ground?.isDestroyed() || was.batch?.isDestroyed()) return false;
      if (sameLook(was, item)) {
        moves.push(false);
        continue;
      }
      if (groundRecolourable(was, item)) {
        moves.push('recolour');
        continue;
      }
      if (!movable(record, was, item)) return false;
      moves.push(true);
    }
    // Drawn alone after this upsert: a few at most, or the batches rebuild.
    const alone = new Set();
    for (const [id, part] of parts ?? []) if (part.solo) alone.add(id);
    list.forEach((item, k) => moves[k] === true && alone.add(item.id));
    // Those the host still retiring draws alone count too, until it goes.
    let retiringAlone = 0;
    if (record.retiring)
      for (const part of record.retiringShapeParts?.values() ?? [])
        if (part.solo && part.ground && !part.ground.isDestroyed())
          retiringAlone += 1;
    if (alone.size + retiringAlone > MOVING_SHAPES) return false;
    list.forEach((item, k) => {
      if (moves[k] === 'solid') return patchSolid(solids.get(item.id), item);
      const was = parts.get(item.id);
      if (moves[k] === true) return moveShape(record, was, item);
      if (moves[k] === 'recolour') recolourGround(was, item);
      if (!was.ground) return;
      was.id.meta = item.meta;
      const show = item.show !== false;
      was.show = show;
      if (was.ground.ready) {
        showOn(was.ground, was.id, show);
        was.pendingShow = undefined;
      } else if (was.solo) {
        // Not yet drawn, it is built again showing as asked.
        moveShape(record, was, item);
      } else was.pendingShow = show;
    });
    return true;
  }

  /** Whether a fill or outline is a plain colour (or none). */
  const plainColour = (value) =>
    value == null || typeof value === 'string' || Array.isArray(value);

  /**
   * How a shape draws but for its colours, pulse, show and `meta`, and
   * whether it has a fill and an outline: shapes alike in it draw alike,
   * but for their colours.
   */
  const colourlessLookOf = (item) => {
    const { show, meta, fill, outline, animate, ...look } = item;
    return plainCopy({
      ...look,
      filled: fill != null,
      outlined: outline != null,
    });
  };

  /**
   * Whether an upsert changes a shape's colours, its pulse, its show or its
   * `meta` and nothing else, its fill and outline staying plain colours:
   * those it takes in place.
   */
  function colourOnly(look, item) {
    if (!plainColour(item.fill) || !plainColour(item.outline)) return false;
    if (!plainColour(look.fill) || !plainColour(look.outline)) return false;
    return sameValues(colourlessLookOf(look), colourlessLookOf(item));
  }

  /**
   * Whether a clamped colour fill's upsert recolours it (or changes its
   * pulse), and changes nothing else but its show and `meta`.
   */
  const groundRecolourable = (was, item) =>
    Boolean(was.id && was.ground) &&
    colourFill(item) &&
    colourFill(was.look) &&
    colourOnly(was.look, item) &&
    !sameValues(
      plainCopy({ fill: was.look.fill, animate: was.look.animate ?? null }),
      { fill: item.fill, animate: item.animate ?? null },
    );

  /**
   * Whether an unclamped shape's upsert only recolours, pulses, shows or
   * hides it: a colour drawn opaque cannot become translucent in place.
   */
  function solidPatchable(part, item) {
    if (part.image) return imagePatchable(part, item);
    if (!colourOnly(part.look, item)) return false;
    if (part.fill?.isDestroyed?.() || part.outline?.isDestroyed?.())
      return false;
    // Not yet drawn: it has no colours to write, and rebuilds instead.
    if (
      (part.fill && !part.fill.ready) ||
      (part.outline && !part.outline.ready)
    )
      return false;
    const pulses = Boolean(item.animate);
    const fits = (translucent, colour) =>
      colour == null || translucent || (!pulses && toColor(colour).alpha >= 1);
    // Ring outlines are polylines, whose materials take any alpha in place.
    return (
      fits(part.translucent.fill, item.fill) &&
      fits(part.translucent.outline || !part.outline, item.outline)
    );
  }

  /**
   * Whether an unclamped image fill's upsert changes only its image (a
   * canvas, under a new key for new content), its show or its `meta`: its
   * texture takes a new canvas in place.
   */
  function imagePatchable(part, item) {
    const fill = item.fill;
    if (!fill || typeof fill !== 'object' || Array.isArray(fill)) return false;
    if (!fill.image?.canvas || item.animate || part.pulse) return false;
    if (!part.fill || part.fill.isDestroyed() || !part.fill.ready) return false;
    const { fill: was, ...look } = part.look;
    const { fill: now, show, meta, ...next } = item;
    return (
      sameValues(look, next) &&
      sameValues(was.repeat ?? null, fill.repeat ?? null)
    );
  }

  /**
   * An image fill's texture takes `canvas`: copied into the texture it has
   * where the size is the same, else a texture of its own, which the
   * material holds (and destroys) from this frame on. Without a drawing
   * context (a scene with no WebGL), the material takes the canvas, as it
   * did when built.
   */
  function writeImage(part, canvas) {
    const image = part.image;
    const context = scene.context;
    if (!context) {
      image.material.uniforms.image = canvas;
      return;
    }
    const texture = image.texture;
    if (
      texture &&
      !texture.isDestroyed() &&
      texture.width === canvas.width &&
      texture.height === canvas.height
    ) {
      texture.copyFrom({ source: canvas });
      return;
    }
    dropPendingTexture(image);
    image.texture = new Cesium.Texture({ context, source: canvas });
    image.material.uniforms.image = image.texture;
  }

  /**
   * Destroys an image fill's newest texture if its material has not taken
   * it yet. A material takes a texture (and destroys it later) only when it
   * next updates, so one replaced or disposed before then is no one's.
   */
  function dropPendingTexture(image) {
    const texture = image.texture;
    if (!texture || texture.isDestroyed()) return;
    if (materialTexture(image.material, 'image') === texture) return;
    texture.destroy();
    image.texture = null;
  }

  /** An instance's colour, in a ready primitive. */
  function colourOn(primitive, id, color) {
    const attributes = primitive.getGeometryInstanceAttributes(id);
    attributes.color = Cesium.ColorGeometryInstanceAttribute.toValue(
      color,
      attributes.color,
    );
  }

  /** An unclamped shape changed in place: its colours, pulse, show and `meta`. */
  function patchSolid(part, item) {
    const image = part.image ? item.fill.image : null;
    if (image && (image.key !== part.look.fill.image.key || !image.key))
      writeImage(part, image.canvas);
    part.look = lookOf(item);
    part.pulse = pulseOf(item);
    part.id.meta = item.meta;
    part.show = item.show !== false;
    for (const primitive of [part.fill, part.outline])
      if (primitive) primitive.show = part.show;
    for (const polyline of part.rings) polyline.show = part.show;
    paintSolid(
      part,
      part.pulse ? pulseAlpha(part.pulse, performance.now()) : null,
    );
  }

  /**
   * Write an unclamped shape's colours where it draws: its own, or with
   * `alpha` (a pulse's) in place of theirs. A primitive not yet ready
   * takes them when it is (`runPulses`, or its next patch).
   */
  function paintSolid(part, alpha) {
    const look = part.look;
    // Primitives copy the colour they are given; polylines keep theirs.
    const tint = (colour, result) => {
      const base = baseColour(part, colour);
      return alpha === null
        ? Cesium.Color.clone(base, result)
        : base.withAlpha(alpha, result);
    };
    if (
      look.fill &&
      !part.image &&
      part.fill?.ready &&
      !part.fill.isDestroyed()
    )
      colourOn(part.fill, part.id, tint(look.fill, scratchColour));
    // An image fill pulses through its material's colour, white at rest.
    if (part.image)
      part.image.material.uniforms.color = Cesium.Color.WHITE.withAlpha(
        alpha ?? 1,
      );
    if (look.outline) {
      if (part.outline?.ready && !part.outline.isDestroyed())
        colourOn(part.outline, part.id, tint(look.outline, scratchColour));
      for (const polyline of part.rings)
        polyline.material.uniforms.color = tint(look.outline);
    }
  }

  /**
   * A clamped colour fill recoloured in place, on its ground primitive when
   * it is ready, else once it is (`showPending`).
   */
  function recolourGround(part, item) {
    part.look = lookOf(item);
    part.pulse = pulseOf(item);
    const colour = toColor(item.fill);
    if (part.ground.ready) {
      colourOn(part.ground, part.id, colour);
      part.pendingColour = undefined;
    } else part.pendingColour = colour;
  }

  /**
   * Before a frame draws: pulsing shapes take their alpha now, where they
   * draw (on primitives that are ready). Whether any pulses, so frames go
   * on being asked for.
   */
  function runPulses() {
    const now = performance.now();
    let pulsing = false;
    for (const record of sets.values()) {
      if (record.kind !== 'shapes' || record.spec.show === false) continue;
      if (!record.mayPulse && !record.retiring) continue;
      for (const part of record.solidParts?.values() ?? []) {
        if (!part.pulse || !part.show) continue;
        // Only what it draws pulses: a shape with nothing drawn asks for
        // no frames.
        const live = (primitive) => primitive && !primitive.isDestroyed();
        if (!live(part.fill) && !live(part.outline) && !part.rings.length)
          continue;
        pulsing = true;
        paintSolid(part, pulseAlpha(part.pulse, now));
      }
      for (const parts of [record.shapeParts, record.retiringShapeParts])
        for (const part of parts?.values() ?? []) {
          if (!part.pulse || !part.show) continue;
          const ground = part.ground;
          const imageFill =
            typeof part.look.fill === 'object' &&
            !Array.isArray(part.look.fill);
          if (ground && !ground.isDestroyed() && imageFill) {
            // An image fill, a ground primitive of its own, pulses through
            // its material's colour.
            pulsing = true;
            ground.appearance.material.uniforms.color =
              Cesium.Color.WHITE.withAlpha(pulseAlpha(part.pulse, now));
          } else if (ground && !ground.isDestroyed()) {
            // One still building asks for frames, to pulse once it is ready.
            pulsing = true;
            if (ground.ready)
              colourOn(
                ground,
                part.id,
                baseColour(part, part.look.fill).withAlpha(
                  pulseAlpha(part.pulse, now),
                  scratchColour,
                ),
              );
          }
          // A clamped outline pulses through its material's colour.
          const outline = part.outlineGround;
          if (outline && !outline.isDestroyed() && part.look.outline) {
            pulsing = true;
            outline.appearance.material.uniforms.color = baseColour(
              part,
              part.look.outline,
            ).withAlpha(pulseAlpha(part.pulse, now));
          }
        }
    }
    return pulsing;
  }

  const scratchColour = new Cesium.Color();

  /**
   * A part's colour as a Cesium colour, parsed once for each colour its
   * look holds (a patch gives it a new look, and new values).
   */
  function baseColour(part, colour) {
    const cache = part.baseColours ?? (part.baseColours = new Map());
    let base = cache.get(colour);
    if (!base) {
      if (cache.size > 4) cache.clear();
      base = toColor(colour);
      cache.set(colour, base);
    }
    return base;
  }

  /** Whether a clamped item is a plain colour fill, drawn in a batch. */
  const colourFill = (item) =>
    item.height === 'clampGround' &&
    Boolean(item.fill) &&
    !item.outlineOnly &&
    !item.outline &&
    item.extrudeHeight === undefined &&
    (typeof item.fill !== 'object' || Array.isArray(item.fill));

  /** How a clamped shape draws, but for its geometry, show and `meta`. */
  const placedLookOf = (item) => {
    const { show, meta, geometry, ...look } = item;
    return plainCopy(look);
  };

  /**
   * Whether a clamped colour fill's upsert moves or reshapes it and nothing
   * else: then it is drawn alone where it now is, built in this frame,
   * which needs Cesium's terrain heights loaded.
   */
  function movable(record, was, item) {
    if (!was.id || !was.ground || !colourFill(item)) return false;
    if (!colourFill(was.look)) return false;
    if (!sameValues(placedLookOf(was.look), placedLookOf(item))) return false;
    const g = item.geometry;
    if (!['polygon', 'ellipse', 'rectangle'].includes(g?.kind)) return false;
    return groundSyncs() && typeof record.host?.add === 'function';
  }

  /**
   * Draw a clamped colour fill where it now is, in this frame: on a ground
   * primitive of its own built at once, in place of its own one (or of its
   * place in its batch, hidden there), as a moved draped line is drawn
   * (`moveDraped`). A shape dragged every frame draws every frame, where a
   * rebuild would build its batch anew each time and never finish.
   */
  function moveShape(record, part, item) {
    const host = record.host;
    // Built first: geometry it cannot build leaves the part as it was.
    const geometry = groundGeometry(item);
    if (part.solo) {
      if (part.ground && !part.ground.isDestroyed()) host.remove(part.ground);
    } else {
      part.batch = part.ground;
      part.batchHidden = true;
      // Its batch draws on without it, hidden now or once it is ready.
      if (part.batch.ready) showOn(part.batch, part.id, false);
    }
    hideRetiringShape(record, item.id);
    record.shapesMovedAt = now();
    part.solo = true;
    part.pendingShow = undefined;
    part.look = lookOf(item);
    part.pulse = pulseOf(item);
    part.show = item.show !== false;
    part.pendingColour = undefined;
    part.id.meta = item.meta;
    const pickable = record.spec.pickable !== false;
    const Ground = pickable
      ? Cesium.GroundPrimitive
      : UnpickableGroundPrimitive;
    part.ground = new Ground({
      geometryInstances: [
        new Cesium.GeometryInstance({
          geometry,
          attributes: {
            color: Cesium.ColorGeometryInstanceAttribute.fromColor(
              toColor(item.fill),
            ),
            show: new Cesium.ShowGeometryInstanceAttribute(item.show !== false),
          },
          id: part.id,
        }),
      ],
      classificationType: classificationOf(
        item.clampTo ?? record.spec.clampTo ?? 'both',
      ),
      allowPicking: pickable,
      asynchronous: false,
    });
    host.add(part.ground);
  }

  /**
   * Hide where the host a set is rebuilding from still draws a clamped
   * shape, once it is drawn where it now is: else both would draw (and
   * pick) until the rebuild is ready.
   */
  function hideRetiringShape(record, id) {
    const part = record.retiring && record.retiringShapeParts?.get(id);
    const ground = part?.ground;
    if (!ground || ground.isDestroyed() || !ground.ready) return;
    const hidden = (record.retiringHiddenShapes ??= new Set());
    // Only one it drew: one hidden there already stays hidden.
    if (!hidden.has(id) && !shownOn(ground, part.id)) return;
    showOn(ground, part.id, false);
    hidden.add(id);
  }

  /** Whether the instance under pick id `id` in a ready ground primitive shows. */
  const shownOn = (ground, id) =>
    ground.getGeometryInstanceAttributes(id).show[0] !== 0;

  /**
   * Show again the shapes `hideRetiringShape` hid where the retiring host
   * draws them: the host that drew them alone is gone before it was ready.
   */
  function showRetiringShapes(record) {
    const hidden = record.retiringHiddenShapes;
    record.retiringHiddenShapes = null;
    if (!record.retiring || !hidden) return;
    for (const id of hidden) {
      const ground = record.retiringShapeParts?.get(id)?.ground;
      if (!ground || ground.isDestroyed() || !ground.ready) continue;
      // As it is now: one since hidden or removed stays hidden.
      const item = record.items.get(id);
      if (!item || item.show === false) continue;
      showOn(ground, record.retiringShapeParts.get(id).id, true);
    }
  }

  /**
   * After a draw: a shape set whose shapes drawn alone have not moved for
   * `SETTLE_MS` rebuilds, so they go back into its
   * batches; the host drawing them alone draws until the rebuild is ready.
   */
  function settleShapes(record) {
    if (record.pending || !record.shapeParts) return;
    let alone = false;
    for (const part of record.shapeParts.values())
      if (part.solo) {
        alone = true;
        break;
      }
    if (!alone) return;
    if (now() - record.shapesMovedAt < SETTLE_MS) return;
    record.shapesMovedAt = now();
    record.rebuild();
    requestRender();
  }

  /** Whether a hidden clamped item is a plain colour fill `groundFills` builds. */
  const hiddenFillBuilds = (item) =>
    Boolean(item.fill) &&
    !item.outlineOnly &&
    !item.outline &&
    item.extrudeHeight === undefined &&
    (typeof item.fill !== 'object' || Array.isArray(item.fill));

  function buildShapes(record) {
    // Refused before anything is built: a pulse it cannot run.
    record.mayPulse = false;
    for (const item of record.items.values())
      if (pulseOf(item)) record.mayPulse = true;
    const host = new Cesium.PrimitiveCollection();
    const outlines = new Cesium.PolylineCollection();
    const clamped = [];
    // Each unclamped item as drawn, for upserts that only recolour, show or
    // hide it (`patchShapes`), and its pulse.
    // Published once the build has gone through.
    const solids = new Map();
    record.solidParts = null;
    // Image fills' materials hold their textures, which primitives leave
    // alone: the host destroys them as it goes.
    const materials = [];
    // Image fills, whose newest texture the material may not hold yet.
    const images = [];
    const ownMaterial = (material) => {
      if (!materials.length) {
        const destroyHost = host.destroy.bind(host);
        host.destroy = () => {
          for (const image of images.splice(0)) dropPendingTexture(image);
          for (const owned of materials.splice(0))
            if (!owned.isDestroyed()) owned.destroy();
          return destroyHost();
        };
      }
      materials.push(material);
      return material;
    };
    for (const given of record.items.values()) {
      const item = standing(record, given);
      // Clamped ones are built hidden as well (`groundFills`), when they
      // are a colour fill it can draw: others hidden stay out, as before.
      if (
        item.height === 'clampGround' &&
        (item.show !== false || hiddenFillBuilds(item))
      ) {
        clamped.push(item);
        continue;
      }
      if (item.show === false) continue;
      const imageFill =
        item.fill && typeof item.fill === 'object' && !Array.isArray(item.fill)
          ? item.fill
          : null;
      if (imageFill && !imageFill.image)
        throw new Error('the Cesium renderer fills shapes with colours only');
      // A colour fill's geometry carries what its appearance reads, as the
      // entities' do. With texture coordinates too, Cesium packs them with
      // the normals, which a colour appearance then misreads: a lit colour
      // fill shaded darker than the same entity.
      const shape = shapeGeometry(
        item,
        imageFill
          ? Cesium.MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat
          : Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
      );
      const id = pickId(record, item);
      const pulse = pulseOf(item);
      const part = {
        look: lookOf(item),
        id,
        fill: null,
        outline: null,
        rings: [],
        pulse,
        // A pulsing colour is drawn translucent whatever its alpha now.
        translucent: { fill: false, outline: false },
        show: true,
      };
      solids.set(item.id, part);
      const solid = item.extrudeHeight !== undefined;
      // `lit`: shaded by Cesium's light, or flat; by default solids are lit.
      const lit = item.lit ?? solid;
      if (imageFill && !item.outlineOnly) {
        const material = holdImage(
          ownMaterial(
            imageMaterial(imageAt(imageFill.image), imageFill.repeat),
          ),
          imageFill.image,
        );
        // Its image is changed in place (`writeImage`); it never recolours.
        part.image = { material, texture: null };
        images.push(part.image);
        part.translucent.fill = true;
        part.fill = host.add(
          new Cesium.Primitive({
            geometryInstances: new Cesium.GeometryInstance({
              geometry: shape.fill,
              modelMatrix: shape.modelMatrix,
              id,
            }),
            appearance: new Cesium.MaterialAppearance({
              material,
              materialSupport:
                Cesium.MaterialAppearance.MaterialSupport.TEXTURED,
              translucent: true,
              closed: solid,
              flat: !lit,
            }),
            asynchronous: false,
          }),
        );
      } else if (item.fill && !item.outlineOnly) {
        const color = toColor(item.fill);
        part.translucent.fill = color.alpha < 1 || Boolean(pulse);
        part.fill = host.add(
          new Cesium.Primitive({
            geometryInstances: new Cesium.GeometryInstance({
              geometry: shape.fill,
              modelMatrix: shape.modelMatrix,
              attributes: {
                color: Cesium.ColorGeometryInstanceAttribute.fromColor(color),
              },
              id,
            }),
            appearance: new Cesium.PerInstanceColorAppearance({
              translucent: part.translucent.fill,
              closed: solid,
              // Flat shapes unlit by default: lit, their faces shade by
              // the light (a lit block's sides differ, an unlit one's match).
              flat: !lit,
              faceForward: !solid,
            }),
            asynchronous: false,
          }),
        );
      }
      if (item.outline && shape.outline) {
        const color = toColor(item.outline);
        part.translucent.outline = color.alpha < 1 || Boolean(pulse);
        part.outline = host.add(
          new Cesium.Primitive({
            geometryInstances: new Cesium.GeometryInstance({
              geometry: shape.outline,
              attributes: {
                color: Cesium.ColorGeometryInstanceAttribute.fromColor(color),
              },
              id,
            }),
            appearance: new Cesium.PerInstanceColorAppearance({
              flat: true,
              translucent: part.translucent.outline,
              renderState: {
                // Clamped to what the context draws, as entities do.
                lineWidth:
                  typeof scene.clampLineWidth === 'function'
                    ? scene.clampLineWidth(item.outlineWidth ?? 1)
                    : Math.min(
                        item.outlineWidth ?? 1,
                        scene.maximumAliasedLineWidth ?? 1,
                      ),
              },
            }),
            asynchronous: false,
          }),
        );
      } else if (item.outline && shape.rings)
        for (const ring of shape.rings)
          part.rings.push(
            outlines.add({
              positions: [...ring, ring[0]],
              width: item.outlineWidth ?? 1,
              material: Cesium.Material.fromType('Color', {
                color: toColor(item.outline),
              }),
              id,
            }),
          );
    }
    host.add(outlines);
    const ground = groundFills(record, clamped);
    record.solidParts = solids;
    if (!ground.length) return replaceHost(record, host);
    replaceHost(
      record,
      collect(host, ground),
      ground,
      host,
      clamped.some(
        (item) => item.show !== false && item.fill && !item.outlineOnly,
      ),
    );
  }

  const modelSets = createModelSets({
    scene,
    toColor,
    pickId,
    replaceHost,
    horizonNow,
    requestRender,
    parts: capabilities.has('modelParts'),
    now,
  });
  const buildModels = (record) => modelSets.build(record);
  // Whether shapes pulsed in the last frame, which draws on in the next.
  let pulsing = false;
  // Whether a shown model's parts spun in the last frame, likewise.
  let spinning = false;
  const lineWidth = (px) =>
    typeof scene.clampLineWidth === 'function'
      ? scene.clampLineWidth(px)
      : Math.min(px, scene.maximumAliasedLineWidth ?? 1);
  const quadSets = createQuadSets({
    toColor,
    toImage: imageAt,
    holdImage,
    pickId,
    replaceHost,
    lineWidth,
    requestRender,
  });
  const meshSets = createMeshSets({
    toColor,
    pickId,
    replaceHost,
    requestRender,
  });

  /** The 3D tilesets in the scene, shown or not. */
  function tilesets() {
    const found = [];
    const primitives = scene.primitives;
    const n = primitives?.length ?? 0;
    for (let i = 0; i < n; i++) {
      const primitive = primitives.get(i);
      if (primitive instanceof Cesium.Cesium3DTileset) found.push(primitive);
    }
    return found;
  }

  /**
   * The Cesium port draws clamped items where it is given them; it does not
   * drape them onto 3D tiles yet, so over shown tiles it is `overlay`.
   * Terrain and the ellipsoid take draped items wherever Cesium drapes at
   * all: its draped lines and image fills need depth textures, which every
   * WebGL 2 context has; without them it says `overlay`, and draws draped
   * lines over the surface (`overlayLine`). Clamped shapes there are still
   * built as ground primitives: only a WebGL 1 context without the
   * extension lacks depth textures.
   */
  const clampState = () =>
    !drapes() || tilesets().some((tileset) => tileset.show)
      ? 'overlay'
      : 'draped';
  const clampListeners = listenerList(report);
  // The state last told, while anyone listens; measured after each drawn
  // frame, when what the base holds can have changed.
  let toldClamp = null;
  function watchClamp() {
    if (clampListeners.size === 0) return;
    const state = clampState();
    if (state === toldClamp) return;
    toldClamp = state;
    clampListeners.fire(state);
  }

  const draw = {
    icons: (spec) => makeSet('icons', { ...spec }, buildIcons),
    points: (spec) => makeSet('points', { ...spec }, buildPoints),
    lines: (spec) => makeSet('lines', { ...spec }, buildLines),
    shapes: (spec) => makeSet('shapes', { ...spec }, buildShapes),
    models: (spec) => makeSet('models', { ...spec }, buildModels),
    quads: (spec) =>
      makeSet('quads', { ...spec }, (record) => quadSets.build(record)),
    meshes: (spec) =>
      makeSet('meshes', { ...spec }, (record) => meshSets.build(record)),
    ...(capabilities.has('fields')
      ? {
          field(spec) {
            if (sets.has(spec?.id))
              throw new Error(`a set with id ${spec.id} is live`);
            return fieldPart.field(spec);
          },
        }
      : {}),
    clampState,
    on(event, cb) {
      if (event !== 'clampState') return () => {};
      if (clampListeners.size === 0) toldClamp = clampState();
      return clampListeners.on(cb);
    },
    atlas(id, images) {
      atlases.set(id, { ...images });
      let changed = false;
      for (const record of [...sets.values()])
        if (record.kind === 'icons' && record.atlases?.has(id)) {
          if (record.gpu) {
            record.gpu.reatlas(id);
            setsVersion += 1;
            changed = true;
            continue;
          }
          // Its icons that draw from the atlas take their new images where
          // they are; a set that cannot is rebuilt.
          const drawing = [];
          for (const [itemId, item] of record.items)
            if (item.image?.atlas === id) drawing.push(itemId);
          const synced = syncIcons(record, drawing);
          if (!synced) record.rebuild();
          else if (synced === ICONS_CHANGED) setsVersion += 1;
          changed = true;
        }
      if (changed) scene.requestRender();
    },
  };

  return {
    port: draw,
    sets,
    version: () => setsVersion,
    tilesets,
    /**
     * Where a GPU icon set draws an item it moves itself, `aheadMs` after
     * `time` (a Julian date; now without one), on its segment; null for any
     * other item, whose own position stays the answer.
     */
    drawnPosition(ref, aheadMs = 0, time = undefined) {
      const record = sets.get(ref?.set);
      if (!record || record.kind !== 'icons' || !record.gpu) return null;
      return record.gpu.drawnAt(ref.id, aheadMs, time ? { time } : undefined);
    },
    /** Whether a set's ground primitives are still being built. */
    building: () => anySet((record) => record.pending),
    /** Each frame, before it draws: the horizon cull. */
    beforeRender() {
      pulsing = runPulses();
      cullHorizon();
      clusterIcons();
      runFlows();
      runAges();
      for (const record of sets.values()) {
        if (record.inertialLines || record.inertialPieces?.length)
          turnInertial(record);
        record.drapeInertial?.();
      }
      spinning = modelSets.beforeRender(sets.values());
      quadSets.beforeRender(sets.values());
    },
    /** Each frame, after it drew: clamp state, and ground swaps. */
    afterRender() {
      watchClamp();
      swapReady();
      // Clamped GPU icons take the ground under their segments.
      const budget = gpu.groundBudget();
      let grounded = false;
      for (const record of sets.values())
        if (record.gpu?.ground(budget)) grounded = true;
      if (grounded) requestRender();
      for (const record of sets.values())
        if (record.kind === 'lines')
          try {
            settleLines(record);
          } catch (error) {
            // Its lines stay in the collection, which draws them all.
            record.lineBox = null;
            report(error);
          }
        else if (record.kind === 'shapes')
          try {
            settleShapes(record);
          } catch (error) {
            report(error);
          }
      // Rows moving on a live clock, and flowing lines, draw on in the
      // frames that follow.
      const playing = quadSets.afterRender(sets.values());
      if (anySet(animating) || flowing() || pulsing || spinning || playing)
        requestRender();
    },
    /**
     * Let go of the sets; with `removeHosts`, take what they draw out of
     * the scene too (a scene the port does not own outlives it).
     */
    dispose({ removeHosts = false } = {}) {
      portDisposed = true;
      clampListeners.clear();
      // Fields go with the port, and their frame listeners with them.
      fieldPart.dispose();
      // Part shaders and their textures go with it too.
      modelSets.dispose();
      // Aged lines' materials whose lines are gone, with their textures.
      for (const record of sets.values())
        for (const [material, entry] of record.ages ?? [])
          dropAge(record, material, entry);
      // Late model loads find no host and destroy themselves.
      for (const record of sets.values()) {
        if (removeHosts && !scene.isDestroyed?.()) {
          if (record.host) scene.primitives.remove(record.host);
          retire(record);
        }
        record.host = null;
        record.disposed = true;
        silence(record);
      }
      sets.clear();
    },
  };
}

/** The parts of the draw ports built for viewers with no renderer, by port. */
const unboundParts = new WeakMap();

/**
 * The draw port part (its sets) behind a port built for a viewer with no
 * renderer, for that viewer's query port to pick and see through; null for
 * any other port.
 * @param {object|null|undefined} port
 */
export const unboundDrawPart = (port) =>
  (port && unboundParts.get(port)) ?? null;

// A Cesium viewer with no renderer bound to it gets a
// draw port over its scene when code first asks `findDraw` for one. A
// renderer bound later supersedes it: released, its sets keep drawing until
// their owners dispose them; gone with the viewer, it lets them go.
provideUnboundDraw((viewer) => {
  const scene = viewer.scene;
  // By shape, not `instanceof`: the viewer may come from another
  // copy of Cesium.
  if (
    typeof scene?.primitives?.add !== 'function' ||
    typeof scene.postRender?.addEventListener !== 'function' ||
    typeof scene.requestRender !== 'function'
  )
    return null;
  const part = createCesiumDraw({
    scene,
    report: uncaught,
    capabilities: new Set([...GPU_ICON_CAPABILITIES, 'fields', 'modelParts']),
  });
  unboundParts.set(part.port, part);
  const offs = [
    scene.preRender?.addEventListener?.(() => part.beforeRender()),
    scene.postRender.addEventListener(() => part.afterRender()),
  ];
  const off = () => offs.splice(0).forEach((remove) => remove?.());
  return {
    port: part.port,
    dispose() {
      off();
      part.dispose({ removeHosts: true });
    },
    // Released, its sets still draw, culled and swapped as before; the
    // hooks go with the scene.
    release() {},
  };
});
