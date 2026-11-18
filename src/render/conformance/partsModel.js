/**
 * @module render/conformance/partsModel
 * @description A glTF model with moving parts, built in code for the
 * conformance checks (`PARTS_MODEL_TABLE` says what its parts are). One
 * mesh whose vertices carry their part index (`_PART`), its node scaled
 * (by ten unless told otherwise: the mesh is in tenths of the model's
 * metres), and the part table in that node's `extras`.
 */

/** Each cube face: its normal and two axes across it. */
const FACES = [
  [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ],
  [
    [-1, 0, 0],
    [0, 0, 1],
    [0, 1, 0],
  ],
  [
    [0, 1, 0],
    [0, 0, 1],
    [1, 0, 0],
  ],
  [
    [0, -1, 0],
    [1, 0, 0],
    [0, 0, 1],
  ],
  [
    [0, 0, 1],
    [1, 0, 0],
    [0, 1, 0],
  ],
  [
    [0, 0, -1],
    [0, 1, 0],
    [1, 0, 0],
  ],
];

/**
 * Append a cube of half size `half` centred at `centre` (the model's glTF
 * frame, metres) as part `part`, its vertices and normals put into the
 * mesh's own frame by `toMesh`.
 */
function cube(mesh, centre, half, part, toMesh) {
  for (const [n, u, v] of FACES) {
    const base = mesh.positions.length / 3;
    for (const [su, sv] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ]) {
      const p = [0, 1, 2].map(
        (i) => centre[i] + half * (n[i] + su * u[i] + sv * v[i]),
      );
      mesh.positions.push(...toMesh.point(p));
      mesh.normals.push(...toMesh.direction(n));
      mesh.parts.push(part);
    }
    // Counter-clockwise seen from outside: u × v is the normal.
    mesh.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
}

/**
 * The part table, in the model's glTF frame (forward −X, up +Y, right −Z):
 * a 20 m cube (`body`) centred on the origin; a 10 m cube on top of it
 * (`pod`) that spins about the vertical through its centre; a 6 m cube on
 * top of that (`ram`) that slides forward up to 20 m; and a 6 m cube 15 m
 * ahead of the body at its foot (`arm`), hinged about the vertical through
 * the body's centre, turning up to 45° to the left.
 */
export const PARTS_MODEL_TABLE = Object.freeze([
  { name: 'body', kind: 'body' },
  { name: 'pod', kind: 'spin', pivot: [0, 15, 0], axis: [0, 1, 0] },
  {
    name: 'ram',
    kind: 'slide',
    pivot: [0, 23, 0],
    axis: [-1, 0, 0],
    limits: [0, 20],
    rest: 0,
  },
  {
    name: 'arm',
    kind: 'hinge',
    pivot: [0, 3, 0],
    axis: [0, 1, 0],
    limits: [0, 45],
    rest: 0,
  },
]);

/** Each part's cube: its centre (glTF frame, metres) and half size. */
const CUBES = [
  [[0, 0, 0], 10],
  [[0, 15, 0], 5],
  [[0, 23, 0], 3],
  [[-15, 3, 0], 3],
];

/**
 * The model's GLB bytes. Its mesh node is scaled by `scale`, turned
 * `turnDeg` about its vertical and moved by `translation`; the mesh is
 * built in that node's own frame, so the model it draws is the same
 * whatever the node's transform. `paint` (RGB, 0..1) is every vertex's
 * colour (`COLOR_0`) over a white material, as the fleet models carry
 * their paint; without it the model has no vertex colours.
 * @param {{scale?: number, turnDeg?: number,
 *   translation?: [number, number, number],
 *   paint?: [number, number, number]}} [node]
 * @returns {Uint8Array}
 */
export function partsModelGlb({
  scale = 10,
  turnDeg = 0,
  translation = [0, 0, 0],
  paint,
} = {}) {
  const a = (turnDeg * Math.PI) / 180;
  const c = Math.cos(a);
  const sn = Math.sin(a);
  // The node's turn undone: about +Y by −turnDeg.
  const unturn = ([x, y, z]) => [c * x - sn * z, y, sn * x + c * z];
  const toMesh = {
    point: (p) =>
      unturn([0, 1, 2].map((i) => p[i] - translation[i])).map((v) => v / scale),
    direction: unturn,
  };
  const mesh = { positions: [], normals: [], parts: [], indices: [] };
  CUBES.forEach(([centre, half], part) =>
    cube(mesh, centre, half, part, toMesh),
  );
  const count = mesh.parts.length;
  const positions = new Float32Array(mesh.positions);
  const normals = new Float32Array(mesh.normals);
  // A vertex attribute's elements sit on 4-byte boundaries.
  const parts = new Uint8Array(count * 4);
  mesh.parts.forEach((part, i) => (parts[i * 4] = part));
  const indices = new Uint16Array(mesh.indices);
  // Normalised bytes, RGBA: four to a vertex, on its 4-byte boundary.
  const colors = paint ? new Uint8Array(count * 4) : null;
  if (colors)
    for (let i = 0; i < count; i++)
      colors.set([...paint.map((c) => Math.round(c * 255)), 255], i * 4);
  const chunks = [positions, normals, parts, indices];
  if (colors) chunks.push(colors);
  const offsets = [];
  let length = 0;
  for (const chunk of chunks) {
    offsets.push(length);
    length += Math.ceil(chunk.byteLength / 4) * 4;
  }
  const bin = new Uint8Array(length);
  chunks.forEach((chunk, i) =>
    bin.set(
      new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength),
      offsets[i],
    ),
  );
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i++) {
    min[i % 3] = Math.min(min[i % 3], positions[i]);
    max[i % 3] = Math.max(max[i % 3], positions[i]);
  }
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [
      {
        name: 'parts',
        mesh: 0,
        scale: [scale, scale, scale],
        rotation: [0, Math.sin(a / 2), 0, Math.cos(a / 2)],
        translation,
        extras: { parts: PARTS_MODEL_TABLE },
      },
    ],
    meshes: [
      {
        primitives: [
          {
            attributes: {
              POSITION: 0,
              NORMAL: 1,
              _PART: 2,
              ...(colors ? { COLOR_0: 4 } : {}),
            },
            indices: 3,
            material: 0,
          },
        ],
      },
    ],
    materials: [
      {
        pbrMetallicRoughness: {
          baseColorFactor: [1, 1, 1, 1],
          metallicFactor: 0,
          roughnessFactor: 1,
        },
      },
    ],
    buffers: [{ byteLength: length }],
    bufferViews: [
      {
        buffer: 0,
        byteOffset: offsets[0],
        byteLength: positions.byteLength,
        target: 34962,
      },
      {
        buffer: 0,
        byteOffset: offsets[1],
        byteLength: normals.byteLength,
        target: 34962,
      },
      {
        buffer: 0,
        byteOffset: offsets[2],
        byteLength: parts.byteLength,
        byteStride: 4,
        target: 34962,
      },
      {
        buffer: 0,
        byteOffset: offsets[3],
        byteLength: indices.byteLength,
        target: 34963,
      },
      ...(colors
        ? [
            {
              buffer: 0,
              byteOffset: offsets[4],
              byteLength: colors.byteLength,
              byteStride: 4,
              target: 34962,
            },
          ]
        : []),
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count,
        type: 'VEC3',
        min,
        max,
      },
      { bufferView: 1, componentType: 5126, count, type: 'VEC3' },
      { bufferView: 2, componentType: 5121, count, type: 'SCALAR' },
      {
        bufferView: 3,
        componentType: 5123,
        count: indices.length,
        type: 'SCALAR',
      },
      ...(colors
        ? [
            {
              bufferView: 4,
              componentType: 5121,
              normalized: true,
              count,
              type: 'VEC4',
            },
          ]
        : []),
    ],
  };
  let text = new TextEncoder().encode(JSON.stringify(json));
  const padded = new Uint8Array(Math.ceil(text.length / 4) * 4).fill(0x20);
  padded.set(text);
  text = padded;
  const total = 12 + 8 + text.length + 8 + bin.length;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, text.length, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.set(text, 20);
  const binAt = 20 + text.length;
  view.setUint32(binAt, bin.length, true);
  view.setUint32(binAt + 4, 0x004e4942, true);
  out.set(bin, binAt + 8);
  return out;
}
