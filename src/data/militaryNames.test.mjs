import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import {
  loadMilitaryNames,
  militaryOsmKey,
  nameMilitaryFragment,
  militaryNamesInView,
  MILITARY_POINT_CAP,
} from './militaryNames.js';
import { decodeOpenFreeMapMilitaryTile } from '../sources/openFreeMap.js';
import { createControls } from '../layers/installations/controls.js';
import {
  mergeMilitaryFragments,
  militaryNameInView,
} from '../sources/militaryTileGeometry.js';

const sites = [
  ['w27894251', 'Camp Mabry'],
  ['r317712', 'Marine Corps Base Camp Pendleton'],
  ['r253814', 'Marine Corps Air Station Miramar'],
  ['w60546523', 'Ramstein Air Base'],
  ['w102826331', 'RAF Lakenheath'],
  ['r13529728', 'Fort Hood'],
];

test('wide-view counts report visible points rather than retained off-screen candidates', () => {
  const state = {
    wide: true,
    records: Array.from({ length: 8 }, () => ({ kind: 'installation' })),
    lastUpdate: 1,
    status: 'ready',
  };
  const { methods } = createControls({
    state,
    services: {},
    source: {},
    parts: {
      namedMarkers: {
        stats: () => ({
          namedMarkers: 8,
          pointsOnScreen: 3,
          labelsOnScreen: 2,
          labelCap: 24,
        }),
      },
    },
  });
  const stats = methods.getStats();
  assert.equal(stats.count, 3);
  assert.equal(stats.namedMarkers, 8);
  assert.equal(stats.statusMessage, '3 mapped sites in view');
});

test('the separately licensed pack has unique typed identities, areas, names and a pinned lean output', async () => {
  const raw = readFileSync(
    new URL('./local_data/osm_military_names/names.json', import.meta.url),
  );
  const hash = readFileSync(
    new URL('./local_data/osm_military_names/names.sha256', import.meta.url),
    'utf8',
  ).split(' ')[0];
  assert.equal(createHash('sha256').update(raw).digest('hex'), hash);
  assert.ok(gzipSync(raw, { level: 9 }).length <= 2_000_000);
  const names = await loadMilitaryNames();
  assert.equal(names.records.length, 36466);
  assert.equal(names.byId.size, names.records.length);
  assert.ok(
    names.records.every(
      (r) => r.areaM2 > 0 && Number.isFinite(r.latitude + r.longitude),
    ),
  );
  for (const [id, name] of sites) assert.equal(names.byId.get(id).name, name);
});

test('checked-in OpenFreeMap fixtures retain typed OSM feature ids and geographical identity', async () => {
  const names = await loadMilitaryNames();
  const bytes = readFileSync(
    new URL('./fixtures/ofm-camp-mabry-12-935-1685.pbf', import.meta.url),
  );
  const tile = decodeOpenFreeMapMilitaryTile(bytes, 12, 935, 1685);
  const mabry = tile.military.find((r) => r.featureKey === '278942512');
  assert.ok(mabry);
  assert.equal(militaryOsmKey(mabry.featureKey), 'w27894251');
  assert.equal(nameMilitaryFragment(mabry, names).name, 'Camp Mabry');
  assert.equal(militaryOsmKey('3177123'), 'r317712');
  for (const value of [
    'tile:12/935/1685:0',
    '278942510',
    '3177127',
    'bad',
    1e20,
  ])
    assert.equal(militaryOsmKey(value), null);
  assert.equal(
    nameMilitaryFragment({ ...mabry, featureKey: '3177123' }, names).name,
    'Military area',
    'a valid but distant id fails soft',
  );
  assert.equal(
    nameMilitaryFragment({ ...mabry, featureKey: '278942510' }, names).name,
    'Military area',
  );
});

test('a merged title uses the largest named member and exposes all other member names', async () => {
  const names = await loadMilitaryNames();
  const bytes = readFileSync(
    new URL('./fixtures/ofm-camp-mabry-12-935-1685.pbf', import.meta.url),
  );
  const fragment = decodeOpenFreeMapMilitaryTile(bytes, 12, 935, 1685)
    .military[0];
  const parent = nameMilitaryFragment(fragment, names);
  const child = {
    ...parent,
    featureKey: '12',
    osmKey: 'w1',
    nameRecord: {
      ...parent.nameRecord,
      id: 'osm:military:w1',
      osmKey: 'w1',
      name: 'Small barracks',
      areaM2: 1,
    },
  };
  for (const records of [
    [child, parent],
    [parent, child],
  ]) {
    const merged = mergeMilitaryFragments(records)[0];
    assert.equal(merged.name, 'Camp Mabry');
    assert.equal(merged.id, 'osm:military:w27894251');
    assert.deepEqual(
      [merged.longitude, merged.latitude],
      [parent.nameRecord.longitude, parent.nameRecord.latitude],
    );
    assert.deepEqual(merged.memberNames, ['Small barracks']);
  }
});

test('wide views rank and thin names within a bounded viewport, including the dateline', async () => {
  const names = await loadMilitaryNames();
  for (const box of [
    { west: -130, south: 20, east: -60, north: 60 },
    { west: -15, south: 35, east: 35, north: 65 },
    { west: 170, south: -60, east: -150, north: 70 },
  ]) {
    const view = militaryNamesInView(names, box);
    assert.ok(view.records.length > 0);
    assert.ok(view.records.length <= MILITARY_POINT_CAP);
    assert.ok(view.count >= view.records.length);
    assert.equal(
      new Set(view.records.map((r) => r.id)).size,
      view.records.length,
    );
    for (const r of view.records) {
      assert.ok(r.latitude >= box.south && r.latitude <= box.north);
      assert.ok(
        box.east < box.west
          ? r.longitude >= box.west || r.longitude <= box.east
          : r.longitude >= box.west && r.longitude <= box.east,
      );
    }
  }
});

test('a close view keeps the parent name inside its polygon when the usual label is off-screen', () => {
  const record = {
    id: 'osm:military:w1',
    namedArea: true,
    name: 'Parent base',
    longitude: 1,
    latitude: 1,
    footprints: [
      [
        [
          [0, 0],
          [10, 0],
          [10, 10],
          [0, 10],
          [0, 0],
        ],
      ],
    ],
  };
  const visible = militaryNameInView(record, {
    west: 5,
    south: 5,
    east: 6,
    north: 6,
  });
  assert.equal(visible.id, record.id);
  assert.deepEqual([visible.longitude, visible.latitude], [5.5, 5.5]);
  assert.equal(
    militaryNameInView(record, { west: 0, south: 0, east: 2, north: 2 }),
    record,
  );
  const hole = {
    ...record,
    footprints: [
      [
        record.footprints[0][0],
        [
          [4, 4],
          [7, 4],
          [7, 7],
          [4, 7],
          [4, 4],
        ],
      ],
    ],
  };
  assert.equal(
    militaryNameInView(hole, { west: 5, south: 5, east: 6, north: 6 }),
    hole,
  );
});
