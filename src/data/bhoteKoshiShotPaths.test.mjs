import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildSourceShotPaths, SOURCE_PATH_BEAT_IDS } from './bhoteKoshiShotPaths.js';
import { BHOTE_KOSHI_FLOOD_PATH } from './bhoteKoshiFloodPath.js';

const event = JSON.parse(await readFile(new URL('../../public/events/bhote-koshi-2026/event.json', import.meta.url)));

test('overview and evidence paths start at the lake reach, never the earlier trigger reach', () => {
  const lakeStart = [85.48476, 28.33255];
  assert.deepEqual(BHOTE_KOSHI_FLOOD_PATH[0], lakeStart);
  assert.equal(BHOTE_KOSHI_FLOOD_PATH.some(([lon, lat]) => lon === 85.5306 && lat === 28.2916), false);
  const paths = buildSourceShotPaths(event);
  const first = paths.get('debris-dammed-lake')[0];
  assert.deepEqual([first.lon, first.lat], lakeStart);
  assert.deepEqual(BHOTE_KOSHI_FLOOD_PATH.slice(0, paths.get('debris-dammed-lake').length),
    paths.get('debris-dammed-lake').map(({lon, lat}) => [lon, lat]));
});

test('ten shot paths use only the existing centreline and join at shared endpoints', () => {
  const paths = buildSourceShotPaths(event);
  assert.deepEqual([...paths.keys()], SOURCE_PATH_BEAT_IDS);
  const vertices = new Set(BHOTE_KOSHI_FLOOD_PATH.map(([lon, lat]) => `${lon},${lat}`));
  const boundary = event.reconstruction.corridor.at(-1);
  vertices.add(`${boundary.lon},${boundary.lat}`); // Exact sourced comparison handoff.
  for (const points of paths.values()) {
    assert.ok(points.length >= 2);
    assert.ok(points.every(({ lon, lat, fallbackElevationM }) => (
      vertices.has(`${lon},${lat}`) && Number.isFinite(fallbackElevationM)
    )));
  }
  const coordinate = (point) => [point.lon, point.lat];
  for (const ids of [SOURCE_PATH_BEAT_IDS.slice(0, 2), SOURCE_PATH_BEAT_IDS.slice(2)]) {
    for (let index = 1; index < ids.length; index++) {
      assert.deepEqual(coordinate(paths.get(ids[index - 1]).at(-1)), coordinate(paths.get(ids[index])[0]));
    }
  }
  assert.deepEqual(coordinate(paths.get('bidur-trishuli-bridge').at(-1)), BHOTE_KOSHI_FLOOD_PATH.at(-1));
  for (const id of ['immediate-collapse-viewpoint', 'devighat-taadi-khola-bridge', 'charaudi']) {
    assert.equal(paths.has(id), false, 'out-of-coverage media must not gain a fabricated river route');
  }
});

test('missing and distant observations fail closed without connecting witness coordinates', () => {
  const broken = structuredClone(event);
  broken.evidenceSpine.find(({ id }) => id === 'dhunche').lon = 0;
  const paths = buildSourceShotPaths(broken);
  assert.equal(paths.has('dhunche'), false);
  assert.equal(paths.has('mailung-upper-trishuli'), false);
  assert.equal(buildSourceShotPaths({}).size, 0);
});

test('Dhunche starts at the exact comparison endpoint without stepping upstream first', () => {
  const boundary = event.reconstruction.corridor.at(-1);
  const path = buildSourceShotPaths(event).get('dhunche');
  assert.deepEqual([path[0].lon, path[0].lat], [boundary.lon, boundary.lat]);
  assert.ok(path[1].lat < boundary.lat, 'the first new vertex is downstream of the comparison endpoint');
});
