/**
 * @module render/cesium/drawModels
 * @description The Cesium draw port's `models` sets: one `Cesium.Model` per
 * item in the set's collection, changed where it is. An update that keeps an
 * item's `url` re-poses and restyles its model in place (position,
 * orientation, scale, `axisScale` and pixel bounds, `shading`, `tint`,
 * `colorBlend`, `maskColor`, `clip`, `environmentMap`, `displayRange`,
 * `nodes`, `show`); only a new `url` loads again, and the old model keeps drawing
 * until the new one is ready, so a swap never blinks. `ready` fires once per
 * load, when the model has loaded and is posed. An item with its `gltf`
 * bytes is built from them; its url is then not fetched.
 *
 * What Cesium has no option for runs each frame before the scene draws:
 * `maxPixelSize` (the scale capped so the bounding sphere spans at most that
 * many drawing-buffer pixels at its distance from the eye, as Cesium
 * measures `minPixelSize`), `scaleByDistance`, `fadeByDistance` (the tint's
 * alpha), the set's `horizonCull`, and its `recede`: the tint's alpha times
 * the focus and haze (`render/recession.js`), written again once that moves
 * by more than `RECEDE_WRITE_EPSILON`. A model of a set that does not
 * recede draws at its tint's alpha times its `focus`.
 *
 * A failed load fires `loadFailed` (after the frame Cesium reported it in,
 * so a listener may change the set), and is tried again when its item is
 * next updated, once `MODEL_RETRY_MS` has passed.
 *
 * `shading: 'thermal'` draws the model unlit and white-hot (its texture
 * left out), then tinted as asked: a hot target, as the thermal views draw
 * them. Heights are absolute: models clamp nothing.
 *
 * An item's `parts` (with `modelParts`) poses the moving parts of a model
 * whose mesh carries `_PART` and whose root node carries a part table
 * (`render/modelParts.js`): its model then draws with a custom shader of
 * its own whose vertex stage moves each vertex by its part's matrix, read
 * from a small float texture (`PARTS_VERTEX` says its layout), with the
 * item's mask, unlit or thermal look in the same shader; a moved part's
 * material normal turns with it. The texture is written again in place
 * when the part state changes, and each frame while a part of a model in
 * view spins (frames are asked for while one does). Spins keep their angle
 * across a change of rate. A model at rest, or without a part table, draws
 * exactly as it would without `parts`, on the shared shaders above. Cesium
 * culls and picks a model by its bounds as its file draws it, so a part
 * moved outside them is drawn only while those bounds are in view.
 */
import * as Cesium from 'cesium';
import {
  recedeFactors,
  recedeFrame,
  recedeParams,
  recededAlpha,
} from '../recession.js';
import { customShaderTexture } from './internals.js';
import {
  glbJson,
  gltfMeshMatrix,
  gltfPartTable,
  partMatrices,
  PART_HIGHLIGHT,
  asksHighlight,
} from '../modelParts.js';

const BLEND_MODES = {
  highlight: Cesium.ColorBlendMode.HIGHLIGHT,
  replace: Cesium.ColorBlendMode.REPLACE,
  mix: Cesium.ColorBlendMode.MIX,
};

/**
 * How long a failed load waits before an update of its item tries the url
 * again (a fleet updates every frame; a dropped request or a server
 * hiccup should not leave the item without its model for good).
 */
export const MODEL_RETRY_MS = 5000;

/**
 * How far a receding model's emphasis (focus and haze) moves before its
 * colour is written again: an eye in motion would otherwise write every
 * model's colour every frame.
 */
export const RECEDE_WRITE_EPSILON = 0.005;

/**
 * Each model's posed nodes (`ModelItem.nodes`): name → the 16 numbers last
 * written, so an update that keeps a node's matrix writes nothing.
 */
const posedNodes = new WeakMap();
/** A posed name the model has no node for: looked up once, then skipped. */
const NO_NODE = Symbol('no such node');
const scratchNodeMatrix = new Cesium.Matrix4();

/**
 * Write the item's node transforms to `model` once it is ready: changed
 * ones only, and a node whose name left the map back to its authored pose.
 * Names the model lacks are skipped.
 */
function poseNodes(item, model) {
  if (model.ready !== true) return;
  const wanted = item.nodes;
  let posed = posedNodes.get(model);
  if (!wanted && !posed) return;
  if (!posed) posedNodes.set(model, (posed = new Map()));
  for (const [name, last] of posed) {
    if (wanted && Object.hasOwn(wanted, name)) continue;
    posed.delete(name);
    if (last === NO_NODE) continue;
    const node = model.getNode(name);
    if (node) node.matrix = Cesium.Matrix4.clone(node.originalMatrix);
  }
  if (!wanted) return;
  for (const name of Object.keys(wanted)) {
    const matrix = wanted[name];
    if (!matrix || matrix.length < 16) continue;
    const last = posed.get(name);
    if (last === NO_NODE) continue;
    if (last && sameMatrix(last, matrix)) continue;
    const node = model.getNode(name);
    if (!node) {
      posed.set(name, NO_NODE);
      continue;
    }
    // The last matrix written, kept in one array per node, copied in place.
    let kept = last;
    if (!(kept instanceof Float64Array)) {
      kept = new Float64Array(16);
      posed.set(name, kept);
    }
    for (let i = 0; i < 16; i++) kept[i] = matrix[i];
    // The node copies the matrix it is given.
    node.matrix = Cesium.Matrix4.fromArray(matrix, 0, scratchNodeMatrix);
  }
}

function sameMatrix(a, b) {
  for (let i = 0; i < 16; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Cesium's own blend amount, for a `mix` that names none. */
const DEFAULT_MIX = 0.5;

let unlitShader = null;
let thermalShader = null;

/** Mask shaders by shading and colour: one per pair, shared by its models. */
const maskShaders = new Map();

/**
 * The custom shader that paints `mask` where a model's `_TINT` vertex
 * attribute marks it: drawn colour = colour × mix(1, mask, _TINT), unlit
 * under `unlit` shading.
 */
function maskShaderOf(shading, mask) {
  const key = `${shading === 'unlit' ? 'unlit' : 'pbr'}|${mask.toCssHexString()}`;
  let shader = maskShaders.get(key);
  if (!shader) {
    shader = new Cesium.CustomShader({
      mode: Cesium.CustomShaderMode.MODIFY_MATERIAL,
      ...(shading === 'unlit'
        ? { lightingModel: Cesium.LightingModel.UNLIT }
        : {}),
      uniforms: {
        u_maskColor: {
          type: Cesium.UniformType.VEC3,
          value: new Cesium.Cartesian3(mask.red, mask.green, mask.blue),
        },
      },
      fragmentShaderText: `
void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
  vec3 mask = czm_srgbToLinear(u_maskColor);
  material.diffuse *= mix(vec3(1.0), mask, fsInput.attributes.tint);
}`,
    });
    maskShaders.set(key, shader);
  }
  return shader;
}

/**
 * The custom shader an entry's item draws with: its mask colour's (but under
 * `thermal`), else its `shading`'s.
 */
function entryShader(entry) {
  const shading = entry.item.shading;
  // Kept while its shading and mask colour are: a fleet re-poses every
  // frame with the same look.
  if (entry.shaderShading === shading && entry.shaderMask === entry.mask)
    return entry.shader;
  entry.shader =
    entry.mask && shading !== 'thermal'
      ? maskShaderOf(shading, entry.mask)
      : shaderOf(shading);
  entry.shaderShading = shading;
  entry.shaderMask = entry.mask;
  return entry.shader;
}

/**
 * A clipping plane through the model's origin, keeping what is above it:
 * the planes sit in the model matrix's frame, whose origin is the item's
 * position and whose Z axis is the local vertical. One per model: a
 * collection belongs to the model it clips.
 */
function belowOriginClip() {
  return new Cesium.ClippingPlaneCollection({
    planes: [new Cesium.ClippingPlane(Cesium.Cartesian3.UNIT_Z, 0)],
    edgeWidth: 0,
  });
}

/** The custom shader a `shading` draws with; undefined for `pbr`. */
function shaderOf(shading) {
  if (shading === 'unlit')
    return (unlitShader ??= new Cesium.CustomShader({
      lightingModel: Cesium.LightingModel.UNLIT,
    }));
  if (shading === 'thermal')
    return (thermalShader ??= new Cesium.CustomShader({
      lightingModel: Cesium.LightingModel.UNLIT,
      fragmentShaderText: `
void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
  material.diffuse = vec3(1.0);
}`,
    }));
  return undefined;
}

/** The colour a part with `highlight: true` is drawn in. */
const PART_HIGHLIGHT_COLOR = '#ffc400';

/** How much of a highlighted part's colour the highlight replaces. */
const PART_HIGHLIGHT_MIX = 0.6;

/** Texels in a part's row of its texture. */
const PART_TEXELS = 8;
/** Floats in a part's row: `PART_TEXELS` RGBA texels. */
const PART_FLOATS = PART_TEXELS * 4;

/** A texel's centre across a part's row, as a texture coordinate. */
const texelAt = (i) => ((i + 0.5) / PART_TEXELS).toFixed(4);

/**
 * The vertex stage of a posed model. A part's row of the texture holds the
 * three rows of its matrix in the mesh's own frame (texels 0..2), the three
 * rows of that matrix's inverse transpose (3..5; texel 3's alpha is 1 where
 * the part is moved, 0 where it is at rest), and its highlight colour (6,
 * alpha 0 for none). Each vertex is moved by its part's matrix; the normal
 * turn is passed on in eye space, for the fragment stage to turn the
 * material's own normal (normal maps and back-face flips kept) by it.
 * Positions are the mesh's own (before its node's transform), as are the
 * matrices written for it, and as `czm_normal` takes them to eye space.
 */
const PARTS_VERTEX = `
void vertexMain(VertexInput vsInput, inout czm_modelVertexOutput vsOutput) {
  float row = (floor(vsInput.attributes.part + 0.5) + 0.5) / u_partRows;
  vec4 r0 = texture(u_partMatrices, vec2(${texelAt(0)}, row));
  vec4 r1 = texture(u_partMatrices, vec2(${texelAt(1)}, row));
  vec4 r2 = texture(u_partMatrices, vec2(${texelAt(2)}, row));
  vec4 n0 = texture(u_partMatrices, vec2(${texelAt(3)}, row));
  v_partHighlight = texture(u_partMatrices, vec2(${texelAt(6)}, row));
  vec4 p = vec4(vsOutput.positionMC, 1.0);
  vsOutput.positionMC = vec3(dot(r0, p), dot(r1, p), dot(r2, p));
  v_partMoved = n0.a;
  if (n0.a > 0.5) {
    vec4 n1 = texture(u_partMatrices, vec2(${texelAt(4)}, row));
    vec4 n2 = texture(u_partMatrices, vec2(${texelAt(5)}, row));
    mat3 turn = transpose(mat3(n0.xyz, n1.xyz, n2.xyz));
    v_partNormalEC = czm_normal * turn * inverse(czm_normal);
  } else {
    v_partNormalEC = mat3(1.0);
  }
}`;

/**
 * A posed model's custom shader: its parts moved (`PARTS_VERTEX`), drawn in
 * `shading` with `mask` painted where `_TINT` marks the model (not under
 * `thermal`), and its highlighted parts in their colour. Lit, a moved
 * part's material normal is turned with it; the body and parts at rest keep
 * theirs as the material made them. `data` is the part texture's first
 * contents, `rows` its parts.
 */
function partShaderOf(shading, mask, data, rows) {
  const lit = shading !== 'unlit' && shading !== 'thermal';
  const masked = Boolean(mask) && shading !== 'thermal';
  return new Cesium.CustomShader({
    mode: Cesium.CustomShaderMode.MODIFY_MATERIAL,
    ...(lit ? {} : { lightingModel: Cesium.LightingModel.UNLIT }),
    uniforms: {
      u_partMatrices: {
        type: Cesium.UniformType.SAMPLER_2D,
        value: partTexture(data, rows),
      },
      u_partRows: { type: Cesium.UniformType.FLOAT, value: rows },
      ...(masked
        ? {
            u_maskColor: {
              type: Cesium.UniformType.VEC3,
              value: new Cesium.Cartesian3(mask.red, mask.green, mask.blue),
            },
          }
        : {}),
    },
    varyings: {
      v_partNormalEC: Cesium.VaryingType.MAT3,
      v_partMoved: Cesium.VaryingType.FLOAT,
      v_partHighlight: Cesium.VaryingType.VEC4,
    },
    vertexShaderText: PARTS_VERTEX,
    fragmentShaderText: `
void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
${
  lit
    ? `  if (v_partMoved > 0.5)
    material.normalEC = normalize(v_partNormalEC * material.normalEC);`
    : ''
}
${shading === 'thermal' ? '  material.diffuse = vec3(1.0);' : ''}
${
  masked
    ? `  vec3 mask = czm_srgbToLinear(u_maskColor);
  material.diffuse *= mix(vec3(1.0), mask, fsInput.attributes.tint);`
    : ''
}
  if (v_partHighlight.a > 0.0) {
    vec3 highlight = czm_srgbToLinear(v_partHighlight.rgb);
    material.diffuse = mix(material.diffuse, highlight, ${PART_HIGHLIGHT_MIX.toFixed(2)});
    material.emissive = max(material.emissive, highlight * 0.5);
  }
}`,
  });
}

/** A part texture's contents as a texture uniform: `PART_TEXELS` float texels a row, read unfiltered. */
function partTexture(data, rows) {
  return new Cesium.TextureUniform({
    typedArray: data,
    width: PART_TEXELS,
    height: rows,
    pixelFormat: Cesium.PixelFormat.RGBA,
    pixelDatatype: Cesium.PixelDatatype.FLOAT,
    repeat: false,
    minificationFilter: Cesium.TextureMinificationFilter.NEAREST,
    magnificationFilter: Cesium.TextureMagnificationFilter.NEAREST,
  });
}

/** An affine column-major 4×4's inverse. */
function inverseAffine(m) {
  const [a, b, c] = [m[0], m[1], m[2]];
  const [d, e, f] = [m[4], m[5], m[6]];
  const [g, h, i] = [m[8], m[9], m[10]];
  const A = e * i - f * h;
  const B = -(b * i - c * h);
  const C = b * f - c * e;
  const det = a * A + d * B + g * C;
  if (!(Math.abs(det) > 1e-30)) return null;
  const r = 1 / det;
  const out = [
    A * r,
    B * r,
    C * r,
    0,
    -(d * i - f * g) * r,
    (a * i - c * g) * r,
    -(a * f - c * d) * r,
    0,
    (d * h - e * g) * r,
    -(a * h - b * g) * r,
    (a * e - b * d) * r,
    0,
    0,
    0,
    0,
    1,
  ];
  for (let row = 0; row < 3; row++)
    out[12 + row] = -(
      out[row] * m[12] +
      out[4 + row] * m[13] +
      out[8 + row] * m[14]
    );
  return out;
}

/** What a glTF document (or GLB) says of its parts: its table and mesh frame; null without a table. */
const partInfos = new WeakMap();

/** `source`'s part table and mesh frame, read once; null for a model without moving parts. */
function partInfoOf(source) {
  if (partInfos.has(source)) return partInfos.get(source);
  let info = null;
  try {
    const json = source instanceof Uint8Array ? glbJson(source) : source;
    const table = gltfPartTable(json);
    const mesh = table && gltfMeshMatrix(json);
    const meshInverse = mesh && inverseAffine(mesh);
    if (table && table.parts.length > 1 && meshInverse)
      info = { table, mesh, meshInverse };
  } catch {
    // A malformed table: the model draws whole.
    info = null;
  }
  partInfos.set(source, info);
  return info;
}

/** Whether a part state asks for anything. */
const asksParts = (state) =>
  Boolean(state) &&
  typeof state === 'object' &&
  ['spin', 'deploy', 'poses'].some(
    (key) => state[key] && Object.keys(state[key]).length > 0,
  );

/** Scratch for one model's part matrices and flags, and one matrix's rows. */
let scratchParts = new Float64Array(16 * 32);
let scratchFlags = new Uint8Array(32);
const scratchRow = new Float64Array(4);
const scratchL = new Float64Array(12);

/** How far from the identity a part's matrix may be and still be at rest. */
const AT_REST_EPSILON = 1e-9;

/** Highlight colours by what was asked, read once (a few at most). */
const highlightColors = new Map();

/**
 * The colour a part's `highlight` asks for, read once: `true` the
 * renderer's own, a colour that parses as itself; null for anything else
 * (drawn without a highlight).
 */
export function partHighlightColor(value) {
  if (!asksHighlight(value)) return null;
  const key = value === true ? PART_HIGHLIGHT_COLOR : String(value);
  let color = highlightColors.get(key);
  if (color === undefined) {
    if (value === true || typeof value === 'string')
      color = Cesium.Color.fromCssColorString(key.trim()) ?? null;
    else color = new Cesium.Color(value[0], value[1], value[2], 1);
    if (highlightColors.size >= 256) highlightColors.clear();
    highlightColors.set(key, color);
  }
  return color;
}

/**
 * Write a model's part texture into `data` (`PART_FLOATS` a part, the
 * layout `PARTS_VERTEX` reads) for `state` at `timeS`: for each part the
 * rows of its matrix in the mesh's own frame, L = meshInverse · X · mesh,
 * then the rows of L's inverse transpose (normals turn by it, exact under a
 * stretch or a mesh frame that is not a rotation) with whether the part is
 * moved, then its highlight colour. Whether any part is not at rest.
 */
export function writePartTexture(info, state, timeS, scale, data) {
  const { table, mesh, meshInverse } = info;
  const n = table.parts.length;
  if (scratchParts.length < n * 16) {
    scratchParts = new Float64Array(n * 16);
    scratchFlags = new Uint8Array(n);
  }
  const posed = partMatrices(table, state, timeS, scratchParts, {
    flags: scratchFlags,
    scale,
  });
  const poses = state?.poses;
  const x = scratchParts;
  const ix = scratchRow;
  const L = scratchL;
  for (let k = 0; k < n; k++) {
    const o = k * 16;
    const d = k * PART_FLOATS;
    let moved = false;
    for (let row = 0; row < 3; row++) {
      // (meshInverse · X) row `row`, as four column entries.
      for (let col = 0; col < 4; col++) {
        let sum = 0;
        for (let j = 0; j < 4; j++)
          sum += meshInverse[j * 4 + row] * x[o + col * 4 + j];
        ix[col] = sum;
      }
      for (let col = 0; col < 4; col++) {
        let sum = 0;
        for (let j = 0; j < 4; j++) sum += ix[j] * mesh[col * 4 + j];
        L[row * 4 + col] = sum;
        data[d + row * 4 + col] = sum;
        if (Math.abs(sum - (row === col ? 1 : 0)) > AT_REST_EPSILON)
          moved = true;
      }
    }
    // The inverse transpose of L's 3×3: its cofactors over its determinant.
    const a = L[0];
    const b = L[1];
    const c = L[2];
    const e = L[4];
    const f = L[5];
    const g = L[6];
    const h = L[8];
    const i = L[9];
    const j = L[10];
    const c00 = f * j - g * i;
    const c01 = -(e * j - g * h);
    const c02 = e * i - f * h;
    const c10 = -(b * j - c * i);
    const c11 = a * j - c * h;
    const c12 = -(a * i - b * h);
    const c20 = b * g - c * f;
    const c21 = -(a * g - c * e);
    const c22 = a * f - b * e;
    const det = a * c00 + b * c01 + c * c02;
    const nd = d + 12;
    // At rest, or hidden (collapsed to a point): normals as they are.
    const turned = moved && Math.abs(det) > 1e-12;
    const r = turned ? 1 / det : 0;
    data[nd] = turned ? c00 * r : 1;
    data[nd + 1] = turned ? c01 * r : 0;
    data[nd + 2] = turned ? c02 * r : 0;
    data[nd + 3] = turned ? 1 : 0;
    data[nd + 4] = turned ? c10 * r : 0;
    data[nd + 5] = turned ? c11 * r : 1;
    data[nd + 6] = turned ? c12 * r : 0;
    data[nd + 7] = 0;
    data[nd + 8] = turned ? c20 * r : 0;
    data[nd + 9] = turned ? c21 * r : 0;
    data[nd + 10] = turned ? c22 * r : 1;
    data[nd + 11] = 0;
    const color =
      scratchFlags[k] & PART_HIGHLIGHT
        ? partHighlightColor(poses?.[table.parts[k].name]?.highlight)
        : null;
    const hd = d + 24;
    data[hd] = color ? color.red : 0;
    data[hd + 1] = color ? color.green : 0;
    data[hd + 2] = color ? color.blue : 0;
    data[hd + 3] = color ? 1 : 0;
  }
  return posed;
}

/**
 * A posed model's spins, turned on to `timeS` (seconds): each spinning
 * part's angle moves on at its rate since it last did, so a change of rate
 * never makes a part jump. A part that stops spinning keeps its angle.
 */
export function advanceSpins(spins, timeS) {
  const dt = timeS - spins.at;
  spins.at = timeS;
  if (!(dt > 0)) return;
  for (const [name, rate] of spins.rates)
    spins.angles[name] = (spins.angles[name] + rate * dt) % 360;
}

/**
 * Spins at `state`'s rates from `timeS` on, carrying the angles reached; a
 * part starting to spin starts at an angle of `startAngle`'s (by default a
 * random one, so a fleet posed at once does not turn in step).
 */
export function respin(
  spins,
  table,
  state,
  timeS,
  startAngle = () => Math.random() * 360,
) {
  advanceSpins(spins, timeS);
  spins.rates.clear();
  for (const [name, rate] of Object.entries(state?.spin ?? {})) {
    const index = table.byName.get(name);
    if (
      index === undefined ||
      !table.parts[index].axis ||
      typeof rate !== 'number' ||
      !Number.isFinite(rate) ||
      rate === 0
    )
      continue;
    spins.rates.set(name, rate);
    if (!(name in spins.angles)) spins.angles[name] = startAngle();
  }
}

/** New spins: none yet, at `timeS`. */
export const newSpins = (timeS) => ({
  rates: new Map(),
  angles: {},
  at: timeS,
});

/** A contract distance curve's value at `distance`: linear, clamped. */
export function nearFarValue(curve, distance) {
  if (!curve) return 1;
  const { near, nearValue, far, farValue } = curve;
  if (!(far > near)) return distance <= near ? nearValue : farValue;
  const t = Math.min(1, Math.max(0, (distance - near) / (far - near)));
  return nearValue + (farValue - nearValue) * t;
}

/**
 * The scale that caps a model's bounding sphere (radius `radiusM` at scale
 * 1) at `maxPixelSize` pixels, `metresPerPixel` at its distance; `scale`
 * when it is under the cap already.
 */
export function cappedScale(scale, radiusM, metresPerPixel, maxPixelSize) {
  if (
    !(maxPixelSize > 0) ||
    !(radiusM > 0) ||
    !(metresPerPixel > 0) ||
    !Number.isFinite(metresPerPixel)
  )
    return scale;
  const cap = (maxPixelSize * metresPerPixel) / (2 * radiusM);
  return Math.min(scale, cap);
}

const scratchHpr = new Cesium.HeadingPitchRoll();
const scratchAxes = new Cesium.Cartesian3();
const scratchMatrix = new Cesium.Matrix4();
const scratchSphere = new Cesium.BoundingSphere();
const scratchColor = new Cesium.Color();
const scratchFactors = { scale: 1, alpha: 1, limbRatio: null };
const scratchFrame = { active: false, limbM: 1, strength: 0 };
/** The colour last written to each model. */
const writtenColors = new WeakMap();
/** Written to a model drawn in its own colours: no colour at all. */
const NO_COLOR = Symbol('drawModels.noColor');
/** What the per-frame pass found, for a model it does not run on. */
const STILL = Object.freeze({ scale: 1, alpha: 1, shown: true });

/** An item's position as Cesium's, into `result`. */
function positionOf(pos, result) {
  if ('x' in pos)
    return Cesium.Cartesian3.fromElements(pos.x, pos.y, pos.z, result);
  return Cesium.Cartesian3.fromDegrees(
    pos.lon,
    pos.lat,
    pos.height ?? 0,
    Cesium.Ellipsoid.WGS84,
    result,
  );
}

/** A tint as a key: a CSS string as it is, an RGBA array joined. */
const tintKey = (tint) =>
  tint === undefined || tint === null
    ? null
    : typeof tint === 'string'
      ? tint
      : tint.join(',');

/** Why a load failed, as `loadFailed` reports it. */
function failureMessage(error) {
  if (error instanceof Error && error.message) return error.message;
  const text = error === undefined || error === null ? '' : String(error);
  return text && text !== '[object Object]' ? text : 'the model did not load';
}

/** Whether an item needs the per-frame pass. */
const needsFrame = (item, spec) =>
  item.maxPixelSize > 0 ||
  Boolean(item.scaleByDistance) ||
  Boolean(item.fadeByDistance) ||
  Boolean(spec.horizonCull) ||
  Boolean(spec.recede);

/** An item's focus, 0..1. */
const focusOf = (item) =>
  Number.isFinite(item.focus) ? Math.min(1, Math.max(0, item.focus)) : 1;

/**
 * The models part of a Cesium draw port.
 * @param {{scene: object, toColor: Function, pickId: Function,
 *   replaceHost: Function, horizonNow: () => object|null,
 *   requestRender: () => void, parts?: boolean,
 *   now?: () => number}} options From the draw port: its colour
 *   conversion, pick ids, host swap, horizon and render request; whether it
 *   poses models' parts (`modelParts`), and the clock (milliseconds) spins
 *   are turned by.
 */
export function createModelSets({
  scene,
  toColor,
  pickId,
  replaceHost,
  horizonNow,
  requestRender,
  parts: posesParts = false,
  now = () => performance.now(),
}) {
  /** Each Cesium model drawn posed: its part shader, texture and spins. */
  const posings = new Map();
  /** The GLB bytes each model was built from, where it was. */
  const modelBytes = new WeakMap();
  /** Part shaders let go, destroyed once no draw uses them. */
  const retired = [];
  // Float textures carry the part matrices, and WebGL 2's shading language
  // turns the normals: without them models draw whole.
  const canPose = () =>
    scene.context?.floatingPointTexture !== false &&
    scene.context?.webgl2 !== false;

  /** A model's part table and mesh frame, or null. */
  function partInfoOfModel(model) {
    const bytes = modelBytes.get(model);
    if (bytes) return partInfoOf(bytes);
    const json = model.loader?.gltfJson;
    return json ? partInfoOf(json) : null;
  }

  /** Let go of a model's posing: its shader goes once no draw uses it. */
  function unpose(model) {
    const posing = posings.get(model);
    if (!posing) return;
    posings.delete(model);
    retired.push({ shader: posing.shader, frames: 0 });
  }

  /** Write a posing's texture where its shader reads it. */
  function upload(posing) {
    const texture = customShaderTexture(posing.shader, 'u_partMatrices');
    if (
      texture &&
      !texture.isDestroyed?.() &&
      texture.width === PART_TEXELS &&
      texture.height === posing.rows
    )
      texture.copyFrom({
        source: {
          arrayBufferView: posing.data,
          width: PART_TEXELS,
          height: posing.rows,
        },
      });
    else
      posing.shader.setUniform(
        'u_partMatrices',
        partTexture(posing.data, posing.rows),
      );
  }

  /**
   * The state a posing's texture is written for: its item's deploys and
   * poses, its spins as the angles they have reached (written at a time of
   * 1 s, each angle given as a rate).
   */
  function spunState(posing) {
    const drawn = posing.drawn;
    drawn.deploy = posing.state.deploy;
    drawn.poses = posing.state.poses;
    drawn.spin = posing.spins.angles;
    return drawn;
  }

  /** Write a posing's texture for now. Whether any part is not at rest. */
  function writePosing(posing, timeS) {
    advanceSpins(posing.spins, timeS);
    return writePartTexture(
      posing.info,
      spunState(posing),
      1,
      posing.scale,
      posing.data,
    );
  }

  /**
   * The shader `model` draws its entry's item's `parts` with, its texture
   * written for them now; undefined when the model draws whole (no `parts`,
   * no part table, or every part at rest), its posing let go.
   */
  function posedShader(entry, model) {
    const item = entry.item;
    const state = posesParts ? item.parts : undefined;
    const posing = posings.get(model);
    const info = asksParts(state) && canPose() ? partInfoOfModel(model) : null;
    if (!info) {
      unpose(model);
      return undefined;
    }
    const axes = item.axisScale;
    const scale =
      axes && (axes[0] !== 1 || axes[1] !== 1 || axes[2] !== 1)
        ? axes
        : undefined;
    const key = JSON.stringify(state);
    const scaleKey = scale ? scale.join(',') : '';
    const shading = item.shading;
    const sameLook =
      posing?.info === info &&
      posing.shading === shading &&
      posing.mask === entry.mask;
    // A fleet re-poses every frame with the same parts: written when they
    // change (a spin turns in the frame pass).
    if (sameLook && posing.key === key && posing.scaleKey === scaleKey)
      return posing.shader;
    const timeS = now() / 1000;
    // Spins go on from where they were, whatever else changed.
    const spins = posing?.info === info ? posing.spins : newSpins(timeS);
    respin(spins, info.table, state, timeS);
    const spinning = spins.rates.size > 0;
    const rows = info.table.parts.length;
    const next = {
      info,
      shader: sameLook ? posing.shader : null,
      shading,
      mask: entry.mask,
      data: sameLook ? posing.data : new Float32Array(rows * PART_FLOATS),
      rows,
      key,
      scaleKey,
      scale,
      spinning,
      state,
      spins,
      drawn: posing?.drawn ?? {},
    };
    const posed = writePosing(next, timeS);
    if (!posed && !spinning) {
      unpose(model);
      return undefined;
    }
    if (sameLook) {
      Object.assign(posing, next);
      upload(posing);
      return posing.shader;
    }
    unpose(model);
    next.shader = partShaderOf(shading, entry.mask, next.data, rows);
    posings.set(model, next);
    return next.shader;
  }

  /** Pixels across a model's bounds under which its spins are not turned. */
  const MIN_SPIN_PIXELS = 4;
  const scratchSpinSphere = new Cesium.BoundingSphere();

  /**
   * Whether a model is worth turning this frame: shown, in the view, and
   * at least `MIN_SPIN_PIXELS` across.
   */
  function seen(model, culling, width, height) {
    if (!model.show || !model.ready) return false;
    const sphere = model.boundingSphere;
    if (!sphere || !(sphere.radius > 0)) return false;
    if (
      culling &&
      culling.computeVisibility(sphere) === Cesium.Intersect.OUTSIDE
    )
      return false;
    if (!(width > 0 && height > 0)) return true;
    Cesium.BoundingSphere.clone(sphere, scratchSpinSphere);
    scratchSpinSphere.radius = 0;
    const metresPerPixel = scene.camera.getPixelSize(
      scratchSpinSphere,
      width,
      height,
    );
    return (
      !(metresPerPixel > 0) ||
      !Number.isFinite(metresPerPixel) ||
      (2 * sphere.radius) / metresPerPixel >= MIN_SPIN_PIXELS
    );
  }

  /**
   * Before a frame: turn the spinning parts of each model in view to now,
   * sweep the posings of models gone, and destroy part shaders no draw
   * uses any more. Whether any model in view spins (frames go on being
   * asked for; one out of view or too small to see asks for none).
   */
  function turnParts() {
    for (let i = retired.length - 1; i >= 0; i--)
      if ((retired[i].frames += 1) > 2) {
        const [{ shader }] = retired.splice(i, 1);
        shader.destroy?.();
      }
    if (!posings.size) return false;
    const timeS = now() / 1000;
    const camera = scene.camera;
    const culling =
      camera?.frustum?.computeCullingVolume && camera.positionWC
        ? camera.frustum.computeCullingVolume(
            camera.positionWC,
            camera.directionWC,
            camera.upWC,
          )
        : null;
    const width = scene.drawingBufferWidth ?? scene.canvas?.width ?? 0;
    const height = scene.drawingBufferHeight ?? scene.canvas?.height ?? 0;
    let spinning = false;
    for (const [model, posing] of posings) {
      if (model.isDestroyed?.()) {
        unpose(model);
        continue;
      }
      if (!posing.spinning || !seen(model, culling, width, height)) continue;
      spinning = true;
      writePosing(posing, timeS);
      upload(posing);
    }
    return spinning;
  }

  /**
   * Let go of every posing and part shader now, their textures with them:
   * the port is done, and no frame comes to retire them. A model still
   * drawn is left drawing whole.
   */
  function dispose() {
    for (const [model, posing] of posings) {
      if (!model.isDestroyed?.() && model.customShader === posing.shader)
        model.customShader = undefined;
      posing.shader.destroy?.();
    }
    posings.clear();
    for (const { shader } of retired.splice(0)) shader.destroy?.();
  }

  /** The set's host, made once: its models are changed where they are. */
  function hostOf(record) {
    if (record.host && !record.host.isDestroyed?.()) return record.host;
    const host = new Cesium.PrimitiveCollection();
    host.loading = 0;
    host.failed = 0;
    record.models = new Map();
    replaceHost(record, host);
    return host;
  }

  /** Each live entry's pick id, for height queries to see through. */
  function notePickIds(record) {
    record.pickIds = [];
    for (const entry of record.models.values())
      record.pickIds.push(entry.pickId);
  }

  function drop(record, id) {
    const entry = record.models.get(id);
    if (!entry) return;
    record.models.delete(id);
    unload(record, entry);
  }

  /** Let go of an entry's models and its load. */
  function unload(record, entry) {
    const host = record.host;
    cancel(record, entry);
    if (entry.model && host && !host.isDestroyed()) host.remove(entry.model);
    entry.model = null;
    entry.modelUrl = null;
  }

  /** Start loading `entry`'s url; the model it draws now stays until ready. */
  function load(record, entry) {
    const host = hostOf(record);
    cancel(record, entry);
    const token = {};
    entry.token = token;
    entry.url = entry.item.url;
    const url = entry.url;
    // A load counts until it is ready, fails or is superseded; once.
    host.loading += 1;
    let settled = false;
    const item = entry.item;
    const current = () =>
      entry.token === token && record.host === host && !host.isDestroyed();
    const settleLoad = () => settle(false);
    const settle = (failed, error) => {
      if (settled) return;
      settled = true;
      if (entry.settleLoad === settleLoad) entry.settleLoad = null;
      host.loading -= 1;
      if (failed && entry.token === token) {
        entry.failed = true;
        entry.failedAt = Date.now();
        host.failed += 1;
        // Told once Cesium is done with the frame it raised this in; not
        // when the item has moved on to another load meanwhile.
        const message = failureMessage(error);
        queueMicrotask(() => {
          if (current() && entry.failed)
            record.listeners.loadFailed.fire(item.id, message);
        });
      }
      requestRender();
    };
    entry.settleLoad = settleLoad;
    // Bytes loaded already are drawn from: the url is then only the base
    // path (Cesium's glTF cache keys by it, so each model keeps its own).
    const source = item.gltf
      ? { gltf: item.gltf, basePath: item.url }
      : { url: item.url };
    Cesium.Model.fromGltfAsync({
      ...source,
      modelMatrix: matrixOf(entry, new Cesium.Matrix4()),
      scale: item.scale ?? 1,
      minimumPixelSize: item.minPixelSize ?? 0,
      maximumScale: item.maxScale,
      customShader: entryShader(entry),
      clippingPlanes:
        item.clip === 'belowOrigin' ? belowOriginClip() : undefined,
      environmentMapOptions: { enabled: item.environmentMap !== false },
      // Shown once ready and placed: the pass below shows it.
      show: false,
      // All textures before ready, so a settled capture is the whole model.
      incrementallyLoadTextures: false,
      // Off the frame-spread job queue that photoreal tiles contend for, so
      // a model's readiness stays bounded while tiles stream.
      asynchronous: false,
      id: entry.pickId,
    }).then(
      (model) => {
        if (!current()) {
          settle(false);
          return model.destroy();
        }
        if (item.gltf) modelBytes.set(model, item.gltf);
        entry.next = model;
        entry.styled = null;
        style(record, entry, model, true);
        host.add(model);
        model.readyEvent.addEventListener(() => {
          if (!current() || entry.next !== model) return settle(false);
          // The old model goes as the new one draws.
          if (entry.model) host.remove(entry.model);
          entry.model = model;
          entry.modelUrl = url;
          entry.next = null;
          entry.radius = 0;
          entry.styled = null;
          style(record, entry, model, true);
          settle(false);
          record.listeners.ready.fire(item.id);
        });
        // A failed load is let go (Cesium would keep drawing frames for
        // it); the failure stays for `whenSettled` until the item changes.
        model.errorEvent.addEventListener((error) => {
          if (current() && entry.next === model) {
            entry.next = null;
            // Cesium raises this inside the model's update: removing it
            // (which destroys it) waits until that is done.
            queueMicrotask(() => {
              if (!host.isDestroyed() && host.contains(model))
                host.remove(model);
            });
          }
          settle(true, error);
        });
        requestRender();
      },
      (error) => settle(true, error),
    );
  }

  function matrixOf(entry, result) {
    const o = entry.item.orientation ?? {};
    scratchHpr.heading = o.heading ?? 0;
    scratchHpr.pitch = o.pitch ?? 0;
    scratchHpr.roll = o.roll ?? 0;
    Cesium.Transforms.headingPitchRollToFixedFrame(
      entry.at,
      scratchHpr,
      Cesium.Ellipsoid.WGS84,
      undefined,
      result,
    );
    const axes = entry.item.axisScale;
    if (axes && (axes[0] !== 1 || axes[1] !== 1 || axes[2] !== 1)) {
      // Cesium's glTF axis correction (Y up to Z up, then Z forward to X
      // forward) puts the model's own Z on local X, its X on local Y and
      // its Y on local Z.
      scratchAxes.x = axes[2];
      scratchAxes.y = axes[0];
      scratchAxes.z = axes[1];
      Cesium.Matrix4.multiplyByScale(result, scratchAxes, result);
    }
    return result;
  }

  /**
   * Pose and style `model` as its entry's item says. What the per-frame
   * pass sets (scale, colour alpha, show) is set here from what it found
   * last, so an update between frames draws the same.
   */
  function style(record, entry, model, force = false) {
    const item = entry.item;
    matrixOf(entry, scratchMatrix);
    Cesium.Matrix4.clone(scratchMatrix, model.modelMatrix);
    const was = force ? null : entry.styled;
    const minimum = item.minPixelSize ?? 0;
    if (model.minimumPixelSize !== minimum) model.minimumPixelSize = minimum;
    if (model.maximumScale !== item.maxScale)
      model.maximumScale = item.maxScale;
    const shader = posedShader(entry, model) ?? entryShader(entry);
    if (model.customShader !== shader) model.customShader = shader;
    const clip = item.clip === 'belowOrigin';
    if (Boolean(model.clippingPlanes) !== clip)
      model.clippingPlanes = clip ? belowOriginClip() : undefined;
    const environment = item.environmentMap !== false;
    const manager = model.environmentMapManager;
    if (manager && manager.enabled !== environment)
      manager.enabled = environment;
    const range = item.displayRange;
    const rangeKey = range ? `${range[0]},${range[1]}` : '';
    if (!was || was.range !== rangeKey)
      model.distanceDisplayCondition =
        range && range[1] > range[0]
          ? new Cesium.DistanceDisplayCondition(range[0], range[1])
          : undefined;
    // Without a tint there is nothing to blend in: the model's own colour.
    const blend = entry.tint ? item.colorBlend : undefined;
    const mode = BLEND_MODES[blend?.mode] ?? Cesium.ColorBlendMode.HIGHLIGHT;
    if (model.colorBlendMode !== mode) model.colorBlendMode = mode;
    const amount = blend?.mode === 'mix' ? (blend.amount ?? DEFAULT_MIX) : 0.5;
    if (model.colorBlendAmount !== amount) model.colorBlendAmount = amount;
    // An empty `displayRange` shows nothing.
    const hidden = range && !(range[1] > range[0]);
    if (entry.styled?.range !== rangeKey) entry.styled = { range: rangeKey };
    entry.dynamic = needsFrame(item, record.spec);
    poseNodes(item, model);
    apply(entry, model, entry.frame ?? STILL, hidden);
  }

  /**
   * The parts the per-frame pass computes: the scale (by distance and the
   * pixel cap), the tint's alpha (fade) and whether it shows (cull).
   */
  function apply(entry, model, frame, hidden = false) {
    const item = entry.item;
    const scale = (item.scale ?? 1) * frame.scale;
    if (model.scale !== scale) model.scale = scale;
    const color = Cesium.Color.clone(
      entry.tint ?? Cesium.Color.WHITE,
      scratchColor,
    );
    color.alpha *= frame.alpha * (entry.emphasis ?? focusOf(item));
    // An untinted model at full opacity is drawn without a colour: a colour
    // adds a colour stage to every draw of the model.
    const plain = !entry.tint && color.alpha === 1;
    // Written only when what is asked changes, so a theme's own write to a
    // model's colour stands until then.
    const written = writtenColors.get(model);
    if (plain) {
      if (written !== NO_COLOR) {
        writtenColors.set(model, NO_COLOR);
        model.color = undefined;
      }
    } else if (
      !written ||
      written === NO_COLOR ||
      !Cesium.Color.equals(written, color)
    ) {
      writtenColors.set(
        model,
        Cesium.Color.clone(color, written === NO_COLOR ? undefined : written),
      );
      model.color = color;
    }
    const show =
      item.show !== false && frame.shown && !hidden && model.ready === true;
    if (model.show !== show) model.show = show;
  }

  /**
   * Add or change items, by id. Whether any was added: models moved or
   * restyled keep their pick ids, so only one added changes what height
   * queries see through.
   */
  function upsert(record, list) {
    hostOf(record);
    let added = false;
    for (const item of list) if (put(record, item)) added = true;
    if (added) notePickIds(record);
    requestRender();
    return added;
  }

  /** Draw `item` on its entry, made when it has none; true when made. */
  function put(record, item) {
    let entry = record.models.get(item.id);
    const made = !entry;
    if (!entry) {
      entry = {
        item,
        url: null,
        modelUrl: null,
        model: null,
        at: new Cesium.Cartesian3(),
        tint: null,
        tintKey: undefined,
        mask: null,
        maskKey: undefined,
        radius: 0,
        next: null,
        token: null,
        failed: false,
        failedAt: 0,
        settleLoad: null,
        styled: null,
        // The custom shader drawn with, for the shading and mask it is of
        // (`entryShader`).
        shader: undefined,
        shaderShading: null,
        shaderMask: null,
        dynamic: false,
        frame: null,
        // Focus and haze in a set that recedes, else null (focus alone).
        emphasis: null,
        pickId: pickId(record, item),
      };
      record.models.set(item.id, entry);
    } else {
      entry.item = item;
      // The pick id is the model's own object: changed where it is.
      entry.pickId.meta = item.meta;
    }
    positionOf(item.pos, entry.at);
    // A fleet re-poses every frame with the same tint: parsed when it changes.
    const tint = tintKey(item.tint);
    if (entry.tintKey !== tint) {
      entry.tintKey = tint;
      entry.tint = tint === null ? null : toColor(item.tint);
    }
    const mask = tintKey(item.maskColor);
    if (entry.maskKey !== mask) {
      entry.maskKey = mask;
      entry.mask = mask === null ? null : toColor(item.maskColor);
    }
    if (entry.url !== item.url && item.url === entry.modelUrl) {
      // Back to the url it draws: the load in between is not wanted.
      cancel(record, entry);
      entry.url = entry.modelUrl;
    }
    // The model it draws keeps up while another loads.
    for (const model of [entry.model, entry.next])
      if (model) style(record, entry, model);
    const retry = entry.failed && Date.now() - entry.failedAt >= MODEL_RETRY_MS;
    if (entry.url !== item.url || retry) load(record, entry);
    return made;
  }

  /** Stop the entry's load in flight, keeping the model it draws. */
  function cancel(record, entry) {
    const host = record.host;
    entry.settleLoad?.();
    entry.token = null;
    if (entry.next && host && !host.isDestroyed()) host.remove(entry.next);
    entry.next = null;
    if (entry.failed && host) host.failed -= 1;
    entry.failed = false;
  }

  /**
   * The set's items as they are now (after a `set`, `remove` or `clear`):
   * models of items gone are dropped, the rest kept or changed in place.
   */
  function build(record) {
    hostOf(record);
    for (const id of [...record.models.keys()])
      if (!record.items.has(id)) drop(record, id);
    for (const item of record.items.values()) put(record, item);
    notePickIds(record);
  }

  /**
   * Each frame, before it draws: distance curves, pixel caps, the cull and
   * spinning parts. Whether any shown model spins.
   */
  function beforeRender(sets) {
    const spinning = turnParts();
    const eye = scene.camera?.positionWC;
    if (!eye) return spinning;
    const width = scene.drawingBufferWidth ?? scene.canvas?.width ?? 0;
    const height = scene.drawingBufferHeight ?? scene.canvas?.height ?? 0;
    let horizon;
    const eyeHeight = scene.camera.positionCartographic?.height;
    for (const record of sets) {
      if (record.kind !== 'models' || !record.models) continue;
      if (record.recedeFrom !== record.spec.recede) {
        record.recedeFrom = record.spec.recede;
        record.recede = recedeParams(record.spec.recede);
      }
      const recede = record.recede;
      const recedeNow = recede
        ? recedeFrame(eyeHeight, recede, scratchFrame)
        : null;
      for (const entry of record.models.values()) {
        if (!entry.dynamic) {
          if (entry.frame) {
            entry.frame = null;
            for (const model of [entry.model, entry.next])
              if (model) style(record, entry, model);
          }
          continue;
        }
        const item = entry.item;
        const at = entry.at;
        const distance = Cesium.Cartesian3.distance(eye, at);
        const frame = (entry.frame ??= { scale: 1, alpha: 1, shown: true });
        frame.alpha = item.fadeByDistance
          ? Math.min(
              1,
              Math.max(0, nearFarValue(item.fadeByDistance, distance)),
            )
          : 1;
        if (recede) {
          const haze = recedeFactors(
            distance,
            recedeNow,
            recede,
            scratchFactors,
          ).alpha;
          const emphasis = recededAlpha(focusOf(item), haze, recede);
          if (
            entry.emphasis === null ||
            Math.abs(entry.emphasis - emphasis) > RECEDE_WRITE_EPSILON
          )
            entry.emphasis = emphasis;
        } else entry.emphasis = null;
        let shown = frame.alpha > 0;
        if (record.spec.horizonCull) {
          horizon ??= horizonNow();
          if (horizon && !horizon.isPointVisible(at)) shown = false;
        }
        frame.shown = shown;
        let scale = item.scaleByDistance
          ? nearFarValue(item.scaleByDistance, distance)
          : 1;
        const model = entry.model;
        const itemScale = item.scale ?? 1;
        if (
          item.maxPixelSize > 0 &&
          itemScale > 0 &&
          model?.ready &&
          width > 0 &&
          height > 0
        ) {
          const radius = radiusOf(entry, model);
          // Pixels at the model's centre: a sphere around the eye has none.
          scratchSphere.center = at;
          scratchSphere.radius = 0;
          const metresPerPixel = scene.camera.getPixelSize(
            scratchSphere,
            width,
            height,
          );
          if (radius > 0)
            scale =
              cappedScale(
                itemScale * scale,
                radius,
                metresPerPixel,
                item.maxPixelSize,
              ) / itemScale;
        }
        frame.scale = scale;
        const hidden =
          item.displayRange && !(item.displayRange[1] > item.displayRange[0]);
        for (const m of [entry.model, entry.next])
          if (m) apply(entry, m, frame, hidden);
      }
    }
    return spinning;
  }

  /**
   * The model's bounding radius at scale 1, read once it is drawn at a
   * scale (Cesium's sphere is at its scale, capped by `maximumScale`); 0
   * until then.
   */
  function radiusOf(entry, model) {
    if (entry.radius > 0) return entry.radius;
    const own = Math.min(model.scale, model.maximumScale ?? Infinity);
    if (!(own > 0)) return 0;
    entry.radius = model.boundingSphere.radius / own;
    return entry.radius;
  }

  /** The set's options changed: whether models need the frame pass. */
  function restyle(record) {
    if (!record.models) return;
    for (const entry of record.models.values()) {
      entry.dynamic = needsFrame(entry.item, record.spec);
      if (!record.spec.recede) entry.emphasis = null;
    }
  }

  return { build, upsert, beforeRender, restyle, dispose };
}
