import assert from 'node:assert/strict';
import { createWildlifeBillboardModel } from '../layers/wildlifeSightings/billboardModel.js';
import { buildWildlifeIconModel } from '../layers/wildlifeSightings/model.js';

export const WILDLIFE_BENCHMARK_REFRESHES = 10;
const ICONICS = ['Aves', 'Mammalia', 'Reptilia', 'Plantae', 'Unknown'];

export function syntheticRows(n) {
  return Array.from({ length: n }, (_, i) => ({
    stableId: `synthetic:${i}`,
    lat: -60 + (i % 1000) * 0.12,
    lon: -179 + (i % 2000) * 0.179,
    iconic: ICONICS[i % ICONICS.length],
    quality: 'research',
    count: null,
    obscured: false,
    cell: null,
  }));
}

export function harness() {
  const points = new Set();
  const counters = { created: 0, destroyed: 0, writes: 0, positions: 0 };
  const collection = {
    add(options) {
      const point = new Proxy(
        { show: true, ...options },
        {
          set(target, key, value) {
            counters.writes += 1;
            target[key] = value;
            return true;
          },
        },
      );
      points.add(point);
      counters.created += 1;
      return point;
    },
    remove(point) {
      assert.equal(points.delete(point), true);
      counters.destroyed += 1;
    },
    removeAll() {
      throw new Error('A refresh must never clear the billboard collection');
    },
  };
  const appearance = new Map(
    ICONICS.map((iconic) => [
      iconic,
      {
        image: `cached:${iconic}`,
        color: iconic,
        scale: 1,
      },
    ]),
  );
  const pointById = new Map();
  const model = createWildlifeBillboardModel({
    collection,
    pointById,
    positions: new Map(),
    positionForRow(row) {
      counters.positions += 1;
      return { x: row.lon, y: row.lat };
    },
    appearanceForGroup: (group) => appearance.get(group),
  });
  const apply = (rows) => {
    const population = buildWildlifeIconModel({ rows });
    return model.update(population.rows);
  };
  return { apply, counters, model, pointById, points };
}

export function changePositions(rows, refresh) {
  return rows.map((row, i) =>
    i % 10 === 0
      ? { ...row, lat: row.lat + (refresh % 2 ? 0.001 : -0.001) }
      : row,
  );
}
