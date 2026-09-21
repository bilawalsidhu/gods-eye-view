// CLIENT TERRAIN CACHE — the ceiling on a map nothing ever removed from.
//
// `createTerrainHeights` keeps a Map keyed by 5-decimal "lat,lon". Every new
// coordinate a session resolves added a key, and nothing ever took one out, so
// the map grew for as long as the tab stayed open.
//
// The ceiling is gated here as behaviour: an evicted point must cost exactly
// one re-resolve, and a point still inside the ceiling must cost nothing.
// Eviction is by insertion order, so these cases assert on which coordinates
// the source is asked for again — never on the map's internals.
//
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTerrainHeights } from './services/terrainHeights.js';

/**
 * A source that answers every point and records what it was asked for.
 * `getHeights` receives the resolver's own work items (`{key, lat, lon}`),
 * so record the key — the same string the cache is keyed by.
 */
function recordingSource() {
  const batches = [];
  return {
    batches,
    asked: () => batches.flat(),
    getHeights(points) {
      batches.push(points.map((p) => p.key));
      return Promise.resolve(points.map(() => ({ ellipsoid: 100 })));
    },
  };
}

const at = (i) => ({ lat: 30 + i / 1000, lon: -97 });

test('a resolved point is warm, and costs no second lookup', async () => {
  const source = recordingSource();
  const { resolveEllipsoidalGround } = createTerrainHeights({ source });

  await resolveEllipsoidalGround([at(1), at(2)]);
  assert.equal(source.asked().length, 2);

  await resolveEllipsoidalGround([at(1), at(2)]);
  assert.equal(source.asked().length, 2, 'warm points are not re-requested');
});

test('the cache stops growing, and an evicted point is simply re-resolved', async () => {
  const source = recordingSource();
  // A ceiling of 3 exercises the same path 50,000 does, in four points.
  const { resolveEllipsoidalGround } = createTerrainHeights({
    source,
    cacheMaxEntries: 3,
  });

  for (let i = 1; i <= 4; i += 1) await resolveEllipsoidalGround([at(i)]);
  assert.equal(source.asked().length, 4, 'four distinct points, four lookups');

  // The newest is still warm...
  await resolveEllipsoidalGround([at(4)]);
  assert.equal(source.asked().length, 4);

  // ...and the oldest was evicted, so it costs one re-resolve. Never a wrong
  // height: terrain does not move, so the answer is the same one.
  const again = await resolveEllipsoidalGround([at(1)]);
  assert.equal(source.asked().length, 5);
  assert.equal(
    source.asked()[4],
    `${at(1).lat.toFixed(5)},${at(1).lon.toFixed(5)}`,
  );
  assert.equal(again[0].ellipsoid, 100, 're-resolving returns the real value');
});

test('a batch larger than the ceiling still answers every point it was given', async () => {
  const source = recordingSource();
  const { resolveEllipsoidalGround } = createTerrainHeights({
    source,
    cacheMaxEntries: 3,
  });

  const coords = Array.from({ length: 10 }, (_, i) => at(i));
  const results = await resolveEllipsoidalGround(coords);
  assert.equal(results.length, 10, 'eviction must not truncate a response');
  assert.ok(
    results.every((r) => r.ellipsoid === 100),
    'every position carries its resolved height',
  );
});

test('the default ceiling leaves ordinary sessions entirely warm', async () => {
  const source = recordingSource();
  const { resolveEllipsoidalGround } = createTerrainHeights({ source });

  // Roughly the working set this project's own proxy cache reached in real
  // use (6,189 points). Nothing here should ever be evicted.
  const coords = Array.from({ length: 6200 }, (_, i) => ({
    lat: 30 + i / 100000,
    lon: -97,
  }));
  await resolveEllipsoidalGround(coords);
  const firstPass = source.asked().length;
  assert.equal(firstPass, 6200, 'the first pass really did resolve them all');
  await resolveEllipsoidalGround(coords);
  assert.equal(
    source.asked().length,
    firstPass,
    'a real working set stays warm under the shipped ceiling',
  );
});
