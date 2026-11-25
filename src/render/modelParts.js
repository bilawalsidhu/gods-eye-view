/**
 * @module render/modelParts
 * @description A model's moving parts: the part table a glTF model carries
 * and the pure maths that turns a model item's `parts` (`ModelPartState`)
 * into one matrix per part. Plain JavaScript: no fetch, no DOM, no engine.
 *
 * **The model.** One glTF mesh whose vertices carry a part index (`_PART`, an
 * unsigned byte). The root node's glTF `extras.parts` lists the parts in
 * `_PART` index order: `{name, kind, pivot, axis, limits, rest, parent}`,
 * glTF Y-up, metres and degrees; index 0 is the body. A model that is only
 * its body carries no table.
 *
 * **Frames.** The table, and the matrices {@link partMatrices} writes, are
 * in the model's glTF frame (Y up, nose −X, so right is −Z), applied after
 * the mesh node's own transform (a packed model's dequantization;
 * {@link gltfMeshMatrix}). Poses are given in `[right, forward, up]` metres,
 * with yaw (clockwise from above, as a heading), pitch (nose up) and roll
 * (clockwise looking forward), applied yaw, then pitch, then roll.
 *
 * **A part's motion**, about its pivot, innermost first: its deploy
 * fraction, then its spin, then its pose, then its parent part's whole
 * motion, so a child rides its parent. A hinge or deploy part's turn about
 * its axis is clamped to its limits, as is a slide part's travel along its
 * axis; a part's other motion, and a spin, separable, marker or body part's,
 * is free.
 */

/** What a part does: what live data drives and what is offered first. */
export const PART_KINDS = Object.freeze([
  'body',
  'spin',
  'hinge',
  'slide',
  'deploy',
  'separable',
  'marker',
]);

/** {@link partMatrices}'s flags per part: not drawn. */
export const PART_HIDDEN = 1;
/** {@link partMatrices}'s flags per part: highlighted. */
export const PART_HIGHLIGHT = 2;

const isObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function vec3(value, what) {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    !value.every((n) => typeof n === 'number' && Number.isFinite(n))
  )
    throw new Error(`${what} is not three numbers`);
  return [value[0], value[1], value[2]];
}

/**
 * The part table in a node's glTF `extras` (`{parts: [...]}`); null when it
 * has none (a model that is only its body). Throws on a table that is
 * malformed: a missing or unknown kind, a repeated name, a parent that is
 * not an earlier part, a malformed pivot, axis or limits.
 * @param {unknown} extras
 * @returns {import('./modelParts').PartTable|null}
 */
export function partTableOf(extras) {
  if (!isObject(extras) || extras.parts === undefined) return null;
  const list = extras.parts;
  if (!Array.isArray(list) || list.length === 0)
    throw new Error('parts is not a list of parts');
  if (list.length > 256)
    throw new Error(`${list.length} parts: _PART is a byte`);
  const byName = new Map();
  const parts = list.map((entry, index) => {
    if (!isObject(entry)) throw new Error(`part ${index} is not an object`);
    const { name, kind } = entry;
    if (typeof name !== 'string' || name === '')
      throw new Error(`part ${index} has no name`);
    if (byName.has(name)) throw new Error(`part ${name} is named twice`);
    if (typeof kind !== 'string' || !PART_KINDS.includes(kind))
      throw new Error(`part ${name} has kind ${String(kind)}`);
    if ((index === 0) !== (kind === 'body'))
      throw new Error(`part ${name}: the body, and only it, is part 0`);
    const parentName = index === 0 ? null : (entry.parent ?? 'body');
    if (parentName !== null && typeof parentName !== 'string')
      throw new Error(`part ${name} has parent ${String(parentName)}`);
    const parentIndex =
      parentName === null ? -1 : (byName.get(parentName) ?? -2);
    if (parentIndex === -2)
      throw new Error(`part ${name} rides ${parentName}, not an earlier part`);
    const pivot =
      entry.pivot === undefined ? [0, 0, 0] : vec3(entry.pivot, name);
    let axis = null;
    if (entry.axis !== undefined) {
      const [x, y, z] = vec3(entry.axis, `${name} axis`);
      const length = Math.hypot(x, y, z);
      if (!(length > 0)) throw new Error(`part ${name} has a zero axis`);
      axis = [x / length, y / length, z / length];
    }
    let limits = null;
    const given = entry.limits;
    if (given !== undefined) {
      if (
        !Array.isArray(given) ||
        given.length !== 2 ||
        !given.every((n) => typeof n === 'number' && Number.isFinite(n))
      )
        throw new Error(`part ${name} limits are not two numbers`);
      limits = [given[0], given[1]];
    }
    const restGiven = entry.rest;
    if (
      restGiven !== undefined &&
      (typeof restGiven !== 'number' || !Number.isFinite(restGiven))
    )
      throw new Error(`part ${name} rest is not a number`);
    const rest = limits === null ? null : (restGiven ?? limits[0]);
    byName.set(name, index);
    return {
      index,
      name,
      kind,
      parent: parentName,
      parentIndex,
      pivot,
      axis,
      limits,
      rest,
    };
  });
  return { parts, byName };
}

/**
 * The glTF JSON of a GLB (its first chunk). Throws when the bytes are not a
 * GLB.
 * @param {Uint8Array|ArrayBuffer} glb
 * @returns {object}
 */
export function glbJson(glb) {
  const bytes = glb instanceof Uint8Array ? glb : new Uint8Array(glb);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67)
    throw new Error('not a GLB');
  const length = view.getUint32(12, true);
  if (view.getUint32(16, true) !== 0x4e4f534a || 20 + length > bytes.byteLength)
    throw new Error('GLB has no JSON chunk');
  const json = JSON.parse(
    new TextDecoder().decode(bytes.subarray(20, 20 + length)),
  );
  if (!isObject(json)) throw new Error('GLB JSON is not an object');
  return json;
}

/** The scene's root node indices, then every node's, in order. */
function nodeOrder(gltf) {
  const nodes = Array.isArray(gltf.nodes) ? gltf.nodes : [];
  const scenes = Array.isArray(gltf.scenes) ? gltf.scenes : [];
  const scene = scenes[typeof gltf.scene === 'number' ? gltf.scene : 0];
  const roots =
    isObject(scene) && Array.isArray(scene.nodes) ? scene.nodes : [];
  return { nodes, order: [...roots, ...nodes.keys()] };
}

/**
 * The part table of a glTF document: the first node with `extras.parts`,
 * the scene's root nodes first. Null when no node has one.
 * @param {object} gltf
 * @returns {import('./modelParts').PartTable|null}
 */
export function gltfPartTable(gltf) {
  const { nodes, order } = nodeOrder(gltf);
  for (const index of order) {
    const node = typeof index === 'number' ? nodes[index] : undefined;
    if (
      isObject(node) &&
      isObject(node.extras) &&
      node.extras.parts !== undefined
    )
      return partTableOf(node.extras);
  }
  return null;
}

/**
 * The part table of a GLB's bytes; null for a model without one. Throws on
 * bytes that are not a GLB, or on a malformed table.
 * @param {Uint8Array|ArrayBuffer} glb
 * @returns {import('./modelParts').PartTable|null}
 */
export function readPartTable(glb) {
  return gltfPartTable(glbJson(glb));
}

/** `a · b`, column-major 4×4, into a new array. */
function multiply4(a, b) {
  const out = new Array(16);
  for (let col = 0; col < 4; col++)
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[col * 4 + k];
      out[col * 4 + row] = sum;
    }
  return out;
}

/** A glTF node's local transform, column-major. */
function nodeMatrix(node) {
  if (Array.isArray(node.matrix) && node.matrix.length === 16)
    return [...node.matrix];
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  return [
    (1 - 2 * (y * y + z * z)) * sx,
    2 * (x * y + z * w) * sx,
    2 * (x * z - y * w) * sx,
    0,
    2 * (x * y - z * w) * sy,
    (1 - 2 * (x * x + z * z)) * sy,
    2 * (y * z + x * w) * sy,
    0,
    2 * (x * z + y * w) * sz,
    2 * (y * z - x * w) * sz,
    (1 - 2 * (x * x + y * y)) * sz,
    0,
    tx,
    ty,
    tz,
    1,
  ];
}

/**
 * Where the first mesh of a glTF document's scene is drawn: its node's
 * transform with every parent's, column-major 4×4. A vertex of the mesh is
 * at this matrix times its position in the model's glTF frame, where part
 * matrices apply. The identity for a document without a mesh.
 * @param {object} gltf
 * @returns {number[]}
 */
export function gltfMeshMatrix(gltf) {
  const { nodes } = nodeOrder(gltf);
  const scenes = Array.isArray(gltf.scenes) ? gltf.scenes : [];
  const scene = scenes[typeof gltf.scene === 'number' ? gltf.scene : 0];
  const roots =
    isObject(scene) && Array.isArray(scene.nodes)
      ? scene.nodes
      : [...nodes.keys()];
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  // Depth first, the scene's own order: the first node with a mesh.
  const stack = roots
    .slice()
    .reverse()
    .map((index) => [index, identity, 0]);
  while (stack.length) {
    const [index, parent, depth] = stack.pop();
    const node = nodes[index];
    if (!isObject(node) || depth > 64) continue;
    const world = multiply4(parent, nodeMatrix(node));
    if (typeof node.mesh === 'number') return world;
    const children = Array.isArray(node.children) ? node.children : [];
    for (let i = children.length - 1; i >= 0; i--)
      stack.push([children[i], world, depth + 1]);
  }
  return identity;
}

// ---------------------------------------------------------------- the maths

const DEG = Math.PI / 180;

/** The `[right, forward, up]` axes in the glTF frame (nose −X, Y up, right −Z). */
const RIGHT_G = [0, 0, -1];
const FORWARD_G = [-1, 0, 0];
const UP_G = [0, 1, 0];

/** Scratch quaternions `[x, y, z, w]` and vectors, reused between calls. */
const _q = new Float64Array(4);
const _p = new Float64Array(4);
const _v = new Float64Array(3);
/** A part's axis in the scaled model, and the instance's scale. */
const _a = new Float64Array(3);
const _s = new Float64Array(3);

/** `out` = the rotation by `deg` about the unit `axis`, right-handed. */
function axisAngle(out, axis, deg) {
  const half = (deg * DEG) / 2;
  const s = Math.sin(half);
  out[0] = axis[0] * s;
  out[1] = axis[1] * s;
  out[2] = axis[2] * s;
  out[3] = Math.cos(half);
}

/** `a` = `a · b`. */
function multiplyInto(a, b) {
  const ax = a[0];
  const ay = a[1];
  const az = a[2];
  const aw = a[3];
  const bx = b[0];
  const by = b[1];
  const bz = b[2];
  const bw = b[3];
  a[0] = aw * bx + ax * bw + ay * bz - az * by;
  a[1] = aw * by - ax * bz + ay * bw + az * bx;
  a[2] = aw * bz + ax * by - ay * bx + az * bw;
  a[3] = aw * bw - ax * bx - ay * by - az * bz;
}

/** `v` turned by the unit quaternion `q`, in place. */
function rotateInto(q, v) {
  const x = q[0];
  const y = q[1];
  const z = q[2];
  const w = q[3];
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  v[0] = v[0] + w * tx + (y * tz - z * ty);
  v[1] = v[1] + w * ty + (z * tx - x * tz);
  v[2] = v[2] + w * tz + (x * ty - y * tx);
}

/** A pose's number, or 0 where it is missing or not finite. */
const finite = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

/** Whether a pose turns or moves anything (a value not finite counts as 0). */
function isPosed(pose) {
  const o = pose.offsetM;
  return (
    finite(pose.yawDeg) !== 0 ||
    finite(pose.pitchDeg) !== 0 ||
    finite(pose.rollDeg) !== 0 ||
    (Array.isArray(o) &&
      (finite(o[0]) !== 0 || finite(o[1]) !== 0 || finite(o[2]) !== 0))
  );
}

/**
 * `q` = a pose's rotation in the glTF frame: yaw clockwise about up, then
 * pitch about the new right, then roll about the new forward. `t` = its
 * offset in the glTF frame.
 */
function poseInto(q, t, pose) {
  axisAngle(q, UP_G, -finite(pose.yawDeg));
  axisAngle(_p, RIGHT_G, finite(pose.pitchDeg));
  multiplyInto(q, _p);
  axisAngle(_p, FORWARD_G, finite(pose.rollDeg));
  multiplyInto(q, _p);
  const o = pose.offsetM;
  t[0] = 0;
  t[1] = 0;
  t[2] = 0;
  if (!Array.isArray(o)) return;
  t[0] = -finite(o[1]);
  t[1] = finite(o[2]);
  t[2] = -finite(o[0]);
}

/** `angle` (degrees) as the value nearest `[lo, hi]` among its turns, clamped into it. */
function clampAngle(angle, lo, hi) {
  let best = angle;
  let bestOut = Infinity;
  for (const turn of [-360, 0, 360]) {
    const a = angle + turn;
    const out = a < lo ? lo - a : a > hi ? a - hi : 0;
    if (out < bestOut) {
      best = a;
      bestOut = out;
    }
  }
  return Math.min(hi, Math.max(lo, best));
}

/**
 * Clamp the rotation `q`'s turn about the unit `axis` (its twist, degrees
 * from rest) so that `rest` plus it stays within `limits`, leaving the rest
 * of the rotation (its swing) as it is.
 */
function clampTwist(q, axis, rest, limits) {
  const d = q[0] * axis[0] + q[1] * axis[1] + q[2] * axis[2];
  const w = q[3];
  if (Math.abs(d) < 1e-12 && Math.abs(w) < 1e-12) return;
  let twist = (2 * Math.atan2(d, w)) / DEG;
  if (twist > 180) twist -= 360;
  else if (twist <= -180) twist += 360;
  const lo = Math.min(limits[0], limits[1]) - rest;
  const hi = Math.max(limits[0], limits[1]) - rest;
  const clamped = clampAngle(twist, lo, hi);
  if (Math.abs(clamped - twist) < 1e-9) return;
  // q = swing · twist, so q' = q · twist⁻¹ · twist'.
  axisAngle(_p, axis, clamped - twist);
  multiplyInto(q, _p);
}

/** The degrees or metres from rest a deploy fraction puts a part at. */
function deployedBy(part, fraction) {
  const limits = part.limits;
  const f = Math.min(1, Math.max(0, fraction));
  return limits[0] + (limits[1] - limits[0]) * f - part.rest;
}

/**
 * World (model frame) rotation and translation per part, 12 numbers each (R
 * row-major, then t), and whether each is hidden; reused between calls.
 */
let _world = new Float64Array(12 * 32);
let _hidden = new Uint8Array(32);
/** A pose's rotation, its translation, and one part's local affine, scratch. */
const _r = new Float64Array(4);
const _t = new Float64Array(3);
const _local = new Float64Array(12);

const IDENTITY = Float64Array.of(
  1,
  0,
  0,
  0,
  0,
  1,
  0,
  0,
  0,
  0,
  1,
  0,
  0,
  0,
  0,
  1,
);

const TURNS = new Set(['spin', 'hinge', 'deploy']);
const MOVES = new Set(['slide', 'separable']);

/** Write the unit quaternion `q` and translation `t` as an affine (R row-major, then t) into `m` at `at`. */
function affineInto(q, t, m, at) {
  const x = q[0];
  const y = q[1];
  const z = q[2];
  const w = q[3];
  m[at] = 1 - 2 * (y * y + z * z);
  m[at + 1] = 2 * (x * y - z * w);
  m[at + 2] = 2 * (x * z + y * w);
  m[at + 3] = 2 * (x * y + z * w);
  m[at + 4] = 1 - 2 * (x * x + z * z);
  m[at + 5] = 2 * (y * z - x * w);
  m[at + 6] = 2 * (x * z - y * w);
  m[at + 7] = 2 * (y * z + x * w);
  m[at + 8] = 1 - 2 * (x * x + y * y);
  m[at + 9] = t[0];
  m[at + 10] = t[1];
  m[at + 11] = t[2];
}

/**
 * Whether a highlight asks for one: true, or a colour (a non-empty string,
 * or three or four finite numbers). A renderer that cannot read the
 * colour draws the part without one.
 */
export function asksHighlight(value) {
  if (value === true) return true;
  if (typeof value === 'string') return value.trim() !== '';
  return (
    Array.isArray(value) &&
    (value.length === 3 || value.length === 4) &&
    value.every((v) => typeof v === 'number' && Number.isFinite(v))
  );
}

/**
 * Write each part's matrix (4×4, column-major) for a model whose item has
 * `state` as its `parts`, at `timeS` seconds of the renderer's clock, into
 * `out`: `table.parts.length` matrices, in `_PART` order, in the model's
 * glTF frame. A vertex of part k is drawn at matrix k times its position
 * (after the mesh node's transform). A hidden part's matrix, and every
 * part's riding it, is all zeros.
 *
 * With `options.scale` S (the model drawn stretched along its glTF axes,
 * `axisScale`), each matrix X is S⁻¹·Part_s·S, where Part_s is the part's
 * motion worked out in the stretched model (its pivot, axis and moves scaled
 * by S), so S·X·v = Part_s·S·v: a radar on a hull drawn twice its length
 * turns without stretching. Limits stay in the model's own units.
 *
 * A spin turns its part `rate × timeS` degrees about its axis (any part with
 * an axis); a deploy fraction puts a hinge or deploy part that far between
 * its limits, and a slide or separable part as far along its axis. A spin,
 * deploy or pose naming a part the table does not have is ignored.
 *
 * Returns whether any part is not at rest (moved, hidden or highlighted):
 * false means every matrix written is the identity and every flag 0.
 * @param {import('./modelParts').PartTable} table
 * @param {import('./contract/draw').ModelPartState|null|undefined} state
 * @param {number} timeS
 * @param {Float32Array|Float64Array} out
 * @param {import('./modelParts').PartMatricesOptions} [options]
 * @returns {boolean}
 */
export function partMatrices(table, state, timeS, out, options = {}) {
  const { offset = 0, flags, flagsOffset = 0, scale } = options;
  let scaled = false;
  if (scale !== undefined && scale !== null) {
    _s[0] = scale[0];
    _s[1] = scale[1];
    _s[2] = scale[2];
    // A scale that is not positive along an axis cannot be undone: parts
    // stay unscaled.
    scaled =
      (_s[0] !== 1 || _s[1] !== 1 || _s[2] !== 1) &&
      _s[0] > 0 &&
      _s[1] > 0 &&
      _s[2] > 0;
  }
  const parts = table.parts;
  const n = parts.length;
  if (_world.length < n * 12) {
    _world = new Float64Array(n * 12);
    _hidden = new Uint8Array(n);
  }
  const world = _world;
  const posed = state?.poses;
  const spin = state?.spin;
  const deploy = state?.deploy;
  if (posed == null && spin == null && deploy == null) {
    // Every part at rest.
    for (let k = 0; k < n; k++) out.set(IDENTITY, offset + k * 16);
    flags?.fill(0, flagsOffset, flagsOffset + n);
    return false;
  }
  let anyPosed = false;
  for (let k = 0; k < n; k++) {
    const part = parts[k];
    const name = part.name;
    const pose = posed?.[name];
    const parentIndex = part.parentIndex;
    const hidden =
      pose?.hidden === true || (parentIndex >= 0 && _hidden[parentIndex] === 1);
    const highlight = asksHighlight(pose?.highlight);
    _hidden[k] = hidden ? 1 : 0;
    if (flags !== undefined)
      flags[flagsOffset + k] =
        (hidden ? PART_HIDDEN : 0) | (highlight ? PART_HIGHLIGHT : 0);
    if (hidden) {
      out.fill(0, offset + k * 16, offset + k * 16 + 16);
      anyPosed = true;
      continue;
    }
    anyPosed ||= highlight;
    // The local motion about the pivot, rotation `_q` and translation `_t`,
    // in the (stretched) model: deploy, spin, then pose. `axis` is the
    // part's axis there, `stretch` its length over the model's own.
    let axis = part.axis;
    let stretch = 1;
    if (axis !== null && scaled) {
      _a[0] = axis[0] * _s[0];
      _a[1] = axis[1] * _s[1];
      _a[2] = axis[2] * _s[2];
      stretch = Math.hypot(_a[0], _a[1], _a[2]);
      _a[0] /= stretch;
      _a[1] /= stretch;
      _a[2] /= stretch;
      axis = _a;
    }
    const rate = spin?.[name];
    const fraction = deploy?.[name];
    let moves = false;
    _q.fill(0);
    _q[3] = 1;
    _t.fill(0);
    if (
      axis !== null &&
      typeof rate === 'number' &&
      rate !== 0 &&
      Number.isFinite(rate * timeS)
    ) {
      // Reduced in doubles first: a rate times an epoch clock is a large
      // number of degrees.
      axisAngle(_q, axis, (rate * timeS) % 360);
      moves = true;
    }
    if (
      axis !== null &&
      part.limits !== null &&
      typeof fraction === 'number' &&
      Number.isFinite(fraction)
    ) {
      const by = deployedBy(part, fraction);
      if (by !== 0 && TURNS.has(part.kind)) {
        axisAngle(_p, axis, by);
        multiplyInto(_q, _p);
        moves = true;
      } else if (by !== 0 && MOVES.has(part.kind)) {
        _t[0] = axis[0] * by * stretch;
        _t[1] = axis[1] * by * stretch;
        _t[2] = axis[2] * by * stretch;
        moves = true;
      }
    }
    if (pose !== undefined && pose !== null && isPosed(pose)) {
      // Pose over the rest: R = Rpose · R, t = tpose + Rpose · t.
      poseInto(_r, _v, pose);
      if (scaled) for (let i = 0; i < 3; i++) _v[i] = _v[i] * _s[i];
      rotateInto(_r, _t);
      _t[0] = _t[0] + _v[0];
      _t[1] = _t[1] + _v[1];
      _t[2] = _t[2] + _v[2];
      multiplyInto(_r, _q);
      _q.set(_r);
      moves = true;
    }
    if (moves && part.limits !== null && axis !== null) {
      if (part.kind === 'hinge' || part.kind === 'deploy')
        clampTwist(_q, axis, part.rest, part.limits);
      else if (part.kind === 'slide') {
        // Along the axis in the model's own metres, which its limits are in.
        const along =
          (_t[0] * axis[0] + _t[1] * axis[1] + _t[2] * axis[2]) / stretch;
        const lo = Math.min(part.limits[0], part.limits[1]) - part.rest;
        const hi = Math.max(part.limits[0], part.limits[1]) - part.rest;
        const shift = (Math.min(hi, Math.max(lo, along)) - along) * stretch;
        _t[0] = _t[0] + axis[0] * shift;
        _t[1] = _t[1] + axis[1] * shift;
        _t[2] = _t[2] + axis[2] * shift;
      }
    }
    anyPosed ||= moves;
    const w = k * 12;
    if (moves) {
      // Local L = R and p + t − R p, about the pivot.
      let [px, py, pz] = part.pivot;
      if (scaled) {
        px *= _s[0];
        py *= _s[1];
        pz *= _s[2];
      }
      _v[0] = px;
      _v[1] = py;
      _v[2] = pz;
      rotateInto(_q, _v);
      _t[0] = _t[0] + px - _v[0];
      _t[1] = _t[1] + py - _v[1];
      _t[2] = _t[2] + pz - _v[2];
    }
    if (parentIndex < 0) affineInto(_q, _t, world, w);
    else if (!moves)
      world.copyWithin(w, parentIndex * 12, parentIndex * 12 + 12);
    else {
      // World = parent's world · local.
      affineInto(_q, _t, _local, 0);
      const b = parentIndex * 12;
      for (let row = 0; row < 3; row++) {
        const a0 = world[b + row * 3];
        const a1 = world[b + row * 3 + 1];
        const a2 = world[b + row * 3 + 2];
        world[w + row * 3] = a0 * _local[0] + a1 * _local[3] + a2 * _local[6];
        world[w + row * 3 + 1] =
          a0 * _local[1] + a1 * _local[4] + a2 * _local[7];
        world[w + row * 3 + 2] =
          a0 * _local[2] + a1 * _local[5] + a2 * _local[8];
        world[w + 9 + row] =
          a0 * _local[9] +
          a1 * _local[10] +
          a2 * _local[11] +
          world[b + 9 + row];
      }
    }
    if (!scaled) writeMatrix(world, w, out, offset + k * 16);
    else {
      // X = S⁻¹ · World · S.
      for (let row = 0; row < 3; row++) {
        for (let col = 0; col < 3; col++)
          _local[row * 3 + col] =
            (world[w + row * 3 + col] * _s[col]) / _s[row];
        _local[9 + row] = world[w + 9 + row] / _s[row];
      }
      writeMatrix(_local, 0, out, offset + k * 16);
    }
  }
  return anyPosed;
}

/** Write the affine `m` (12 numbers from `at`: R row-major, then t) as a column-major 4×4 into `out` at `to`. */
function writeMatrix(m, at, out, to) {
  for (let col = 0; col < 3; col++) {
    out[to + col * 4] = m[at + col];
    out[to + col * 4 + 1] = m[at + 3 + col];
    out[to + col * 4 + 2] = m[at + 6 + col];
    out[to + col * 4 + 3] = 0;
  }
  out[to + 12] = m[at + 9];
  out[to + 13] = m[at + 10];
  out[to + 14] = m[at + 11];
  out[to + 15] = 1;
}
