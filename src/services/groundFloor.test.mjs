import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGroundFloor } from './groundFloor.js';
import { createTerrainHeights } from './terrainHeights.js';

/**
 * The floor read as it was before the cell became an integer: the coarse cell
 * through `toFixed(3)`, mesh cells and DEM cells under string keys.
 */
function referenceFloor() {
  const mesh = new Map();
  const dem = new Map();
  const coarse = (lat, lon) => ({
    lat: Number(lat.toFixed(3)),
    lon: Number(lon.toFixed(3)),
  });
  const demKey = (lat, lon) => `${lat.toFixed(5)},${lon.toFixed(5)}`;
  return {
    reportMesh(lat, lon, h) {
      const c = coarse(lat, lon);
      const key = `${c.lat},${c.lon}`;
      if (!mesh.has(key)) mesh.set(key, [{ lat, lon, h }]);
    },
    storeDem(lat, lon, h) {
      dem.set(demKey(lat, lon), h);
    },
    read(lat, lon, meshPreferred = true) {
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      const c = coarse(lat, lon);
      const readings = meshPreferred ? mesh.get(`${c.lat},${c.lon}`) : null;
      if (readings) return readings[0].h;
      return dem.get(demKey(c.lat, c.lon)) ?? null;
    },
  };
}

/** A real terrain cache whose every resolved point takes the height asked for. */
async function warmTerrain(points) {
  const heights = new Map(points.map((p) => [`${p.lat},${p.lon}`, p.h]));
  const terrain = createTerrainHeights({
    source: {
      async getHeights(chunk) {
        return chunk.map((item) => ({
          ellipsoid: heights.get(`${item.lat},${item.lon}`),
        }));
      },
    },
  });
  await terrain.resolveEllipsoidalGround(
    points.map(({ lat, lon }) => ({ lat, lon })),
  );
  return terrain;
}

/** Deterministic pseudo-random numbers in [0, 1). */
function random(seed) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

/** Coordinates that land on, and just either side of, a coarse-cell edge. */
function edgeCoordinates() {
  const out = [];
  for (const base of [0, 0.0005, -0.0005, 12.3455, -12.3455, 89.9995, 179.9995])
    for (const nudge of [0, 1e-13, -1e-13, 1e-9, -1e-9, 1e-7, -1e-7, 4e-4])
      out.push(base + nudge);
  // Thousandths whose doubles sit a hair either side of the half.
  for (let k = -40; k <= 40; k += 1) out.push((k + 0.5) / 1000);
  out.push(-0, 1.0005, 1.0015, 2.5, -2.5, 1e-7, -1e-7);
  return out;
}

test('the floor read answers exactly as the string-keyed read did', async () => {
  const next = random(20261113);
  const cells = [];
  for (let i = 0; i < 400; i += 1) {
    cells.push({
      lat: Number((next() * 170 - 85).toFixed(3)),
      lon: Number((next() * 360 - 180).toFixed(3)),
      h: Math.round(next() * 4000),
    });
  }
  // Cells on and a hair either side of coarse-cell edges, along lon 10 and
  // lat 10. Each has its own height, so a read that lands in the
  // neighbouring cell gets the wrong one.
  for (const edge of edgeCoordinates()) {
    const deg = Number(edge.toFixed(3));
    const lat = Math.max(-89, Math.min(89, deg));
    cells.push({ lat, lon: 10, h: 5000 + Math.round(lat * 1000) });
    cells.push({ lat: 10, lon: deg, h: 5000 + Math.round(deg * 1000) });
  }
  const reference = referenceFloor();
  for (const c of cells) reference.storeDem(c.lat, c.lon, c.h);
  const terrain = await warmTerrain(cells);
  const groundFloor = createGroundFloor({ terrain });

  // A rendered-surface reading in every seventh cell, taken off its centre.
  cells.forEach((c, i) => {
    if (i % 7) return;
    const lat = c.lat + 0.0002;
    const lon = c.lon - 0.0003;
    reference.reportMesh(lat, lon, c.h + 3);
    groundFloor.reportMeshFloorCell(lat, lon, c.h + 3);
  });

  const probes = [];
  for (const c of cells) {
    probes.push([c.lat, c.lon]);
    probes.push([c.lat + (next() - 0.5) * 0.002, c.lon + (next() - 0.5) * 0.002]);
  }
  for (const a of edgeCoordinates())
    for (const b of [10, 10.0004, -0, 0.0005, -0.0005]) {
      probes.push([a, b]);
      probes.push([b, a]);
    }
  probes.push([NaN, 1], [1, Infinity], [95, 400], [10, 720.1234]);

  for (const meshPreferred of [true, false]) {
    groundFloor.setMeshFloorPreferred(meshPreferred);
    let hits = 0;
    for (const [lat, lon] of probes) {
      const expected = reference.read(lat, lon, meshPreferred);
      assert.equal(
        groundFloor.cachedGroundFloor(lat, lon),
        expected,
        `floor at ${lat}, ${lon} (mesh ${meshPreferred})`,
      );
      if (expected !== null) hits += 1;
    }
    assert.ok(hits > 400, `${hits} probes found a floor`);
  }
});

test('reading a floor formats no numbers, hit or miss', async (t) => {
  const cell = { lat: 51.47, lon: -0.454, h: 25 };
  const terrain = await warmTerrain([cell]);
  const groundFloor = createGroundFloor({ terrain });
  groundFloor.reportMeshFloorCell(48.3537, 11.7861, 453);

  const toFixed = t.mock.method(Number.prototype, 'toFixed');
  // The DEM cell, a rendered-surface cell, and open ocean with neither.
  assert.equal(groundFloor.cachedGroundFloor(51.4702, -0.4541), 25);
  assert.equal(groundFloor.cachedGroundFloor(48.3538, 11.7862), 453);
  for (let i = 0; i < 1000; i += 1)
    assert.equal(groundFloor.cachedGroundFloor(30 + i * 0.011, -40.2), null);
  toFixed.mock.restore();
  assert.equal(toFixed.mock.callCount(), 0);
});
