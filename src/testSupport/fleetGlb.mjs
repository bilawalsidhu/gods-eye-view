/**
 * Reads the procedural fleet models' GLBs in Node: their JSON chunk, and their
 * triangles in scene space (raw glTF axes, node transforms applied, metres).
 *
 * The GLBs use EXT_meshopt_compression and KHR_mesh_quantization, so their
 * buffers are decoded with the meshoptimizer decoder Cesium itself ships (a
 * dependency of `@cesium/engine`, resolved through it rather than named as one
 * of this package's own).
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

let decoderPromise = null;

/** The meshoptimizer decoder Cesium decodes these models with. */
async function meshoptDecoder() {
  decoderPromise ??= (async () => {
    const fromHere = createRequire(import.meta.url);
    const fromCesium = createRequire(fromHere.resolve('cesium/package.json'));
    const fromEngine = createRequire(
      fromCesium.resolve('@cesium/engine/package.json'),
    );
    const module = await import(
      pathToFileURL(fromEngine.resolve('meshoptimizer')).href
    );
    await module.MeshoptDecoder.ready;
    return module.MeshoptDecoder;
  })();
  return decoderPromise;
}

/**
 * A GLB's JSON and binary chunks.
 * @param {string} file
 * @returns {{json: object, bin: Uint8Array}}
 */
export function readGlb(file) {
  const bytes = fs.readFileSync(file);
  if (bytes.readUInt32LE(0) !== 0x46546c67)
    throw new Error(`${file}: not a GLB`);
  const jsonLength = bytes.readUInt32LE(12);
  const json = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8'));
  const binStart = 20 + jsonLength;
  const bin =
    binStart + 8 <= bytes.length
      ? new Uint8Array(
          bytes.buffer,
          bytes.byteOffset + binStart + 8,
          bytes.readUInt32LE(binStart),
        )
      : new Uint8Array(0);
  return { json, bin };
}

/** Column-major node matrix from a glTF node's TRS (or its matrix). */
function nodeMatrix(node) {
  if (node.matrix) return node.matrix;
  const t = node.translation || [0, 0, 0];
  const [x, y, z, w] = node.rotation || [0, 0, 0, 1];
  const s = node.scale || [1, 1, 1];
  return [
    (1 - 2 * (y * y + z * z)) * s[0],
    2 * (x * y + z * w) * s[0],
    2 * (x * z - y * w) * s[0],
    0,
    2 * (x * y - z * w) * s[1],
    (1 - 2 * (x * x + z * z)) * s[1],
    2 * (y * z + x * w) * s[1],
    0,
    2 * (x * z + y * w) * s[2],
    2 * (y * z - x * w) * s[2],
    (1 - 2 * (x * x + y * y)) * s[2],
    0,
    t[0],
    t[1],
    t[2],
    1,
  ];
}

function multiply(a, b) {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return out;
}

const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
const READERS = {
  5120: ['getInt8', 1, 127],
  5121: ['getUint8', 1, 255],
  5122: ['getInt16', 2, 32767],
  5123: ['getUint16', 2, 65535],
  5125: ['getUint32', 4, 4294967295],
  5126: ['getFloat32', 4, 1],
};

/**
 * Every element of accessor `index`, normalised integers mapped to -1..1 or
 * 0..1 the way a renderer reads them.
 */
function readAccessor(gltf, views, index) {
  const accessor = gltf.accessors[index];
  const view = gltf.bufferViews[accessor.bufferView];
  const bytes = views[accessor.bufferView];
  const [getter, size, max] = READERS[accessor.componentType];
  const components = COMPONENTS[accessor.type];
  const stride = view.byteStride || size * components;
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float64Array(accessor.count * components);
  for (let i = 0; i < accessor.count; i++)
    for (let c = 0; c < components; c++) {
      const value = data[getter](
        (accessor.byteOffset || 0) + i * stride + c * size,
        true,
      );
      out[i * components + c] = accessor.normalized
        ? Math.max(value / max, -1)
        : value;
    }
  return out;
}

/** Each buffer view's bytes, meshopt-compressed ones decoded. */
async function bufferViews(gltf, bin) {
  const decoder = await meshoptDecoder();
  return gltf.bufferViews.map((view) => {
    const meshopt = view.extensions?.EXT_meshopt_compression;
    if (!meshopt)
      return bin.subarray(
        view.byteOffset || 0,
        (view.byteOffset || 0) + view.byteLength,
      );
    const source = bin.subarray(
      meshopt.byteOffset || 0,
      (meshopt.byteOffset || 0) + meshopt.byteLength,
    );
    const target = new Uint8Array(meshopt.count * meshopt.byteStride);
    decoder.decodeGltfBuffer(
      target,
      meshopt.count,
      meshopt.byteStride,
      source,
      meshopt.mode,
      meshopt.filter,
    );
    return target;
  });
}

/**
 * A fleet model's triangles in scene space: raw glTF axes (X along the body,
 * nose toward -X; Y up; Z across), node transforms applied, metres.
 * @param {string} file
 * @returns {Promise<{verts: number[][], tris: number[][]}>}
 */
export async function fleetMesh(file) {
  const { json: gltf, bin } = readGlb(file);
  const views = await bufferViews(gltf, bin);
  const verts = [];
  const tris = [];
  const visit = (index, parent) => {
    const node = gltf.nodes[index];
    const m = multiply(parent, nodeMatrix(node));
    if (node.mesh != null) {
      for (const primitive of gltf.meshes[node.mesh].primitives) {
        const base = verts.length;
        const positions = readAccessor(
          gltf,
          views,
          primitive.attributes.POSITION,
        );
        for (let i = 0; i < positions.length; i += 3) {
          const [x, y, z] = [positions[i], positions[i + 1], positions[i + 2]];
          verts.push([
            m[0] * x + m[4] * y + m[8] * z + m[12],
            m[1] * x + m[5] * y + m[9] * z + m[13],
            m[2] * x + m[6] * y + m[10] * z + m[14],
          ]);
        }
        const indices = readAccessor(gltf, views, primitive.indices);
        for (let i = 0; i + 2 < indices.length; i += 3)
          tris.push([
            base + indices[i],
            base + indices[i + 1],
            base + indices[i + 2],
          ]);
      }
    }
    for (const child of node.children || []) visit(child, m);
  };
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (const root of gltf.scenes[gltf.scene ?? 0].nodes) visit(root, identity);
  return { verts, tris };
}

/** Axis-aligned bounds of a vertex list. */
export function vertexBounds(verts) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const v of verts)
    for (let a = 0; a < 3; a++) {
      if (v[a] < min[a]) min[a] = v[a];
      if (v[a] > max[a]) max[a] = v[a];
    }
  return { min, max };
}

const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Closest point of triangle abc to p (Ericson, Real-Time Collision Detection). */
function closestOnTriangle(p, a, b, c) {
  const sub = (u, v) => [u[0] - v[0], u[1] - v[1], u[2] - v[2]];
  const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const ab = sub(b, a);
  const ac = sub(c, a);
  const ap = sub(p, a);
  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = sub(p, b);
  const d3 = dot(ab, bp);
  const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return [a[0] + ab[0] * v, a[1] + ab[1] * v, a[2] + ab[2] * v];
  }
  const cp = sub(p, c);
  const d5 = dot(ab, cp);
  const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return [a[0] + ac[0] * w, a[1] + ac[1] * w, a[2] + ac[2] * w];
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return [
      b[0] + (c[0] - b[0]) * w,
      b[1] + (c[1] - b[1]) * w,
      b[2] + (c[2] - b[2]) * w,
    ];
  }
  const den = 1 / (va + vb + vc);
  const v = vb * den;
  const w = vc * den;
  return [
    a[0] + ab[0] * v + ac[0] * w,
    a[1] + ab[1] * v + ac[1] * w,
    a[2] + ab[2] * v + ac[2] * w,
  ];
}

/** How far a point lies from the nearest triangle of the mesh. */
export function distanceToSurface(p, verts, tris) {
  let best = Infinity;
  for (const [i, j, k] of tris) {
    const d = dist3(p, closestOnTriangle(p, verts[i], verts[j], verts[k]));
    if (d < best) best = d;
  }
  return best;
}

/** The segments where the mesh's triangles cross the z = 0 (centreline) plane. */
export function centrelineSegments(verts, tris) {
  const segments = [];
  for (const [i, j, k] of tris) {
    const t = [verts[i], verts[j], verts[k]];
    const points = [];
    for (let e = 0; e < 3; e++) {
      const a = t[e];
      const b = t[(e + 1) % 3];
      if (a[2] === 0) points.push(a);
      if ((a[2] < 0 && b[2] > 0) || (a[2] > 0 && b[2] < 0)) {
        const s = a[2] / (a[2] - b[2]);
        points.push([a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s, 0]);
      }
    }
    if (points.length >= 2) segments.push([points[0], points[1]]);
  }
  return segments;
}

/** Closest point of the centreline segments to `target`, or null. */
export function closestCentrelinePoint(target, segments) {
  let best = null;
  let bestD = Infinity;
  for (const [a, b] of segments) {
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const den = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
    let q = a;
    if (den > 0) {
      let s =
        ((target[0] - a[0]) * ab[0] +
          (target[1] - a[1]) * ab[1] +
          (target[2] - a[2]) * ab[2]) /
        den;
      s = Math.max(0, Math.min(1, s));
      q = [a[0] + ab[0] * s, a[1] + ab[1] * s, a[2] + ab[2] * s];
    }
    const d = dist3(target, q);
    if (d < bestD) {
      bestD = d;
      best = q;
    }
  }
  return best;
}

/**
 * The trail attachment point a model's construction gives: the point of its
 * centreline profile nearest its aft-belly bounding-box corner, in scene
 * space (raw glTF axes, metres). Null when the centreline crosses no triangle.
 * @param {{verts: number[][], tris: number[][]}} mesh
 * @returns {number[]|null}
 */
export function measuredTrailAnchor({ verts, tris }) {
  const { min, max } = vertexBounds(verts);
  return closestCentrelinePoint(
    [max[0], min[1], 0],
    centrelineSegments(verts, tris),
  );
}

/** The repository's `public/` directory, where the fleet set is served from. */
const PUBLIC_DIR = new URL('../../public/', import.meta.url);

/**
 * A `fetch` that serves the repository's `public/` files from disk, for
 * loading the fleet model set in Node.
 * @param {string} url Site path, e.g. `/models/fleet/catalog.json`.
 * @returns {Promise<{ok: boolean, status: number, json: () => Promise<object>,
 *   arrayBuffer: () => Promise<ArrayBuffer>}>}
 */
export async function fetchPublicFile(url) {
  const file = new URL(String(url).replace(/^\//, ''), PUBLIC_DIR);
  let body;
  try {
    body = fs.readFileSync(file);
  } catch {
    return { ok: false, status: 404 };
  }
  return {
    ok: true,
    status: 200,
    json: async () => JSON.parse(body.toString('utf8')),
    arrayBuffer: async () =>
      body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  };
}
