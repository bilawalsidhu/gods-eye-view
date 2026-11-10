import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import * as geo from '../src/geo/index.js';

const directory = new URL('./fixtures/tiles3d/', import.meta.url);
const origin = { lon: -97.7431, lat: 30.2672 };
const transform = geo.transforms.eastNorthUpToFixedFrame(
  geo.cartesian3.fromDegrees(origin.lon, origin.lat),
);
const box = (west, south, east, north, bottom, top) => [
  [
    [west, south, top],
    [east, south, top],
    [east, north, top],
    [west, north, top],
  ],
  [
    [west, north, bottom],
    [east, north, bottom],
    [east, south, bottom],
    [west, south, bottom],
  ],
  [
    [west, south, bottom],
    [east, south, bottom],
    [east, south, top],
    [west, south, top],
  ],
  [
    [east, south, bottom],
    [east, north, bottom],
    [east, north, top],
    [east, south, top],
  ],
  [
    [east, north, bottom],
    [west, north, bottom],
    [west, north, top],
    [east, north, top],
  ],
  [
    [west, north, bottom],
    [west, south, bottom],
    [west, south, top],
    [west, north, top],
  ],
];

// glTF is Y-up; the tileset transform is east/north/up after the 3D Tiles
// loader's Y-to-Z rotation. Untextured flat faces need no external assets.
function glb(faces) {
  const positions = [],
    normals = [];
  for (const face of faces) {
    const vertices = face.map(([x, y, z]) => [x, z, -y]);
    const [a, b, c] = vertices;
    const u = b.map((v, i) => v - a[i]);
    const v = c.map((v, i) => v - a[i]);
    const normal = [
      u[1] * v[2] - u[2] * v[1],
      u[2] * v[0] - u[0] * v[2],
      u[0] * v[1] - u[1] * v[0],
    ];
    const length = Math.hypot(...normal);
    for (let i = 1; i < vertices.length - 1; i++)
      for (const vertex of [a, vertices[i], vertices[i + 1]]) {
        positions.push(...vertex);
        normals.push(...normal.map((n) => n / length));
      }
  }
  const bytes = Buffer.from(
    new Float32Array([...positions, ...normals]).buffer,
  );
  const bounds = (fn) =>
    [0, 1, 2].map((axis) => fn(...positions.filter((_, i) => i % 3 === axis)));
  const json = Buffer.from(
    JSON.stringify({
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [
        {
          primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, material: 0 }],
        },
      ],
      materials: [
        {
          pbrMetallicRoughness: {
            baseColorFactor: [0.5, 0.5, 0.5, 1],
            metallicFactor: 0,
            roughnessFactor: 1,
          },
        },
      ],
      buffers: [{ byteLength: bytes.length }],
      bufferViews: [0, 1].map((i) => ({
        buffer: 0,
        byteOffset: i * positions.length * 4,
        byteLength: positions.length * 4,
        target: 34962,
      })),
      accessors: [
        {
          bufferView: 0,
          componentType: 5126,
          count: positions.length / 3,
          type: 'VEC3',
          min: bounds(Math.min),
          max: bounds(Math.max),
        },
        {
          bufferView: 1,
          componentType: 5126,
          count: positions.length / 3,
          type: 'VEC3',
        },
      ],
    }),
  );
  const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4, 0x20);
  json.copy(padded);
  const result = Buffer.alloc(12 + 8 + padded.length + 8 + bytes.length);
  result.writeUInt32LE(0x46546c67, 0);
  result.writeUInt32LE(2, 4);
  result.writeUInt32LE(result.length, 8);
  result.writeUInt32LE(padded.length, 12);
  result.writeUInt32LE(0x4e4f534a, 16);
  padded.copy(result, 20);
  result.writeUInt32LE(bytes.length, 20 + padded.length);
  result.writeUInt32LE(0x004e4942, 24 + padded.length);
  bytes.copy(result, 28 + padded.length);
  return result;
}

function probe(x, y, z) {
  const position = geo.matrix4.multiplyByPoint(transform, { x, y, z }, {});
  const cartographic = geo.cartographic.fromCartesian(position);
  return {
    position,
    cartographic,
    lon: geo.math.toDegrees(cartographic.longitude),
    lat: geo.math.toDegrees(cartographic.latitude),
    height: cartographic.height,
  };
}

export function buildTilesFixture() {
  const roof = box(110, -60, 210, 60, 0, 60);
  roof.shift();
  roof.push(
    [
      [110, -60, 60],
      [160, -60, 100],
      [160, 60, 100],
      [110, 60, 60],
    ],
    [
      [160, -60, 100],
      [210, -60, 60],
      [210, 60, 60],
      [160, 60, 100],
    ],
    [
      [110, -60, 60],
      [210, -60, 60],
      [160, -60, 100],
    ],
    [
      [210, 60, 60],
      [110, 60, 60],
      [160, 60, 100],
    ],
  );
  const tiles = [
    [
      'plate',
      box(-300, -300, 300, 300, -2, 0),
      [0, 0, -1, 300, 0, 0, 0, 300, 0, 0, 0, 1],
    ],
    [
      'block50',
      box(-210, -60, -110, 60, 0, 50),
      [-160, 0, 25, 50, 0, 0, 0, 60, 0, 0, 0, 25],
    ],
    [
      'block200',
      box(-50, 120, 50, 220, 0, 200),
      [0, 170, 100, 50, 0, 0, 0, 50, 0, 0, 0, 100],
    ],
    ['roof', roof, [160, 0, 50, 50, 0, 0, 0, 60, 0, 0, 0, 50]],
  ];
  const tileset = {
    asset: { version: '1.1' },
    geometricError: 1000,
    root: {
      transform: Array.from(transform),
      boundingVolume: { box: [0, 0, 99, 300, 0, 0, 0, 300, 0, 0, 0, 101] },
      geometricError: 1000,
      refine: 'ADD',
      children: tiles.map(([name, , box]) => ({
        boundingVolume: { box },
        geometricError: 0,
        content: { uri: `${name}.glb` },
      })),
    },
    extras: {
      origin,
      datum: 'WGS84 ellipsoid; local ENU heights in metres',
      probes: {
        plate: probe(0, -170, 0),
        block50: probe(-160, 0, 50),
        block200: probe(0, 170, 200),
        roof: probe(180, 0, 84),
      },
      // More than one pass of surfacePoints, all away from the roof edges.
      points: Array.from({ length: 40 }, (_, i) => {
        const x = 140 + (i % 8) * 5;
        return probe(
          x,
          -40 + Math.floor(i / 8) * 20,
          100 - 0.8 * Math.abs(x - 160),
        );
      }),
    },
  };
  const files = new Map(
    tiles.map(([name, faces]) => [`${name}.glb`, glb(faces)]),
  );
  files.set(
    'tileset.json',
    Buffer.from(JSON.stringify(tileset, null, 2) + '\n'),
  );
  assert.ok(
    [...files.values()].reduce((sum, b) => sum + b.length, 0) < 200_000,
  );
  return files;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const check = process.argv.includes('--check');
  const files = buildTilesFixture();
  if (!check) mkdirSync(directory, { recursive: true });
  for (const [name, bytes] of files) {
    const file = new URL(name, directory);
    if (check)
      assert.deepEqual(readFileSync(file), bytes, `${name} is reproducible`);
    else writeFileSync(file, bytes);
  }
  console.log(
    `${check ? 'Checked' : 'Generated'} ${files.size} fixture files (${[...files.values()].reduce((sum, b) => sum + b.length, 0)} bytes)`,
  );
}
