import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clipTileRing,
  militaryOutlineLines,
  mergeMilitaryFragments,
} from './militaryTileGeometry.js';
const ring = (w, s, e, n) => [
  [w, s],
  [e, s],
  [e, n],
  [w, n],
  [w, s],
];
const record = (id, footprint, extra = {}) => ({
  id,
  featureKey: id,
  footprint,
  sources: [{ name: 'OpenStreetMap', id }],
  ...extra,
});
test('tile cores discard buffers and their artificial outline edges', () => {
  const box = { west: 0, east: 1, south: 0, north: 1 };
  const clipped = clipTileRing(ring(-1, 0.2, 2, 0.8), box);
  assert.deepEqual(militaryOutlineLines(clipped, box), [
    [
      [0, 0.2],
      [1, 0.2],
    ],
    [
      [1, 0.8],
      [0, 0.8],
    ],
  ]);
});
test('touching parcels and tile fragments merge with weighted interior centroid and stable pan ids', () => {
  const aliases = new Map();
  const a = record('a', ring(0, 0, 1, 1)),
    b = record('b', ring(1, 0, 3, 1));
  const [first] = mergeMilitaryFragments([a, b], aliases);
  assert.equal(first.longitude, 1.5);
  assert.equal(first.latitude, 0.5);
  assert.equal(first.footprints.length, 2);
  const [pan] = mergeMilitaryFragments(
    [b, record('c', ring(3, 0, 4, 1))],
    aliases,
  );
  assert.equal(pan.id, first.id);
  assert.equal(
    mergeMilitaryFragments([a, record('far', ring(10, 10, 11, 11))]).length,
    2,
  );
});
test('centroid outside a concave footprint snaps inside instead of landing in the gap', () => {
  const r = [
    [0, 0],
    [3, 0],
    [3, 1],
    [1, 1],
    [1, 3],
    [0, 3],
    [0, 0],
  ];
  const [m] = mergeMilitaryFragments([record('u', r)]);
  assert.ok(m.longitude < 1 || m.latitude < 1);
});
test('holes remain holes and disconnected pieces of one mapped feature have one id', () => {
  const outer = ring(0, 0, 4, 4),
    hole = ring(1, 1, 3, 3);
  const a = record('a', outer, { rings: [outer, hole] });
  const [m] = mergeMilitaryFragments([a, record('a', ring(5, 0, 6, 1))]);
  assert.equal(m.footprints.length, 2);
  assert.equal(m.footprints[0].length, 2);
  assert.ok(
    !(m.longitude > 1 && m.longitude < 3 && m.latitude > 1 && m.latitude < 3),
  );
});

test('a pan that hides connecting parcels keeps one marker with its known installation id', () => {
  const aliases = new Map();
  const a = record('a', ring(0, 0, 1, 1));
  const bridge = record('bridge', ring(1, 0, 2, 1));
  const b = record('b', ring(2, 0, 3, 1));
  const [full] = mergeMilitaryFragments([a, bridge, b], aliases);
  const pan = mergeMilitaryFragments([a, b], aliases);
  assert.equal(pan.length, 1);
  assert.equal(pan[0].id, full.id);
  assert.equal(pan[0].footprints.length, 2);
});

test('joining known groups also updates aliases for their currently offscreen parcels', () => {
  const aliases = new Map();
  const a = record('a', ring(0, 0, 1, 1));
  const b = record('b', ring(2, 0, 3, 1));
  const c = record('c', ring(3, 0, 4, 1));
  assert.equal(mergeMilitaryFragments([a, b, c], aliases).length, 2);
  const [joined] = mergeMilitaryFragments(
    [a, record('bridge', ring(1, 0, 2, 1)), b],
    aliases,
  );
  assert.equal(aliases.get('unknown:c'), joined.id);
  const pan = mergeMilitaryFragments([a, c], aliases);
  assert.equal(pan.length, 1);
  assert.equal(pan[0].id, joined.id);
});

test('quantization gaps within a tile stay separate; coarse identities do not fuse detailed sites', () => {
  const aliases = new Map();
  const a = record('a', ring(0, 0, 1, 1), { tileZoom: 10, tileEpsilon: 0.1 });
  const b = record('b', ring(1.05, 0, 2, 1), {
    tileZoom: 10,
    tileEpsilon: 0.1,
  });
  assert.equal(mergeMilitaryFragments([a, b], aliases).length, 2);
  mergeMilitaryFragments([a, { ...b, footprint: ring(1, 0, 2, 1) }], aliases);
  const detail = mergeMilitaryFragments(
    [
      { ...a, tileZoom: 14 },
      { ...b, tileZoom: 14 },
    ],
    aliases,
  );
  assert.equal(detail.length, 2);
  assert.notEqual(detail[0].id, detail[1].id);
  const left = { ...a, tileBounds: { west: 0, east: 1, south: 0, north: 1 } };
  const right = {
    ...b,
    footprint: ring(1, 0.05, 2, 1),
    tileBounds: { west: 1, east: 2, south: 0, north: 1 },
  };
  assert.equal(mergeMilitaryFragments([left, right]).length, 1);
});

test('distinct named bases separated by one seam quantization step retain separate identities on revisit', () => {
  const aliases = new Map();
  const epsilon = 360 / 512 / 4096;
  const named = (n, footprint, tileBounds, areaM2) =>
    record(String(n * 10 + 2), footprint, {
      tileZoom: 9,
      tileEpsilon: epsilon,
      tileBounds,
      osmKey: `w${n}`,
      nameRecord: {
        id: `osm:military:w${n}`,
        osmKey: `w${n}`,
        name: `Site ${n}`,
        areaM2,
        longitude: footprint[0][0],
        latitude: footprint[0][1],
      },
    });
  const a = named(
    3,
    ring(0.99, 0.1, 1, 0.4),
    { west: 0, east: 1, south: 0, north: 1 },
    100,
  );
  const b = named(
    4,
    ring(1, 0.4 + epsilon, 1.01, 0.5),
    { west: 1, east: 2, south: 0, north: 1 },
    10,
  );
  for (const records of [[a, b], [b], [a, b]]) {
    const merged = mergeMilitaryFragments(records, aliases);
    assert.equal(merged.length, records.length);
    assert.deepEqual(
      merged.map((r) => r.name),
      records.map((r) => r.nameRecord.name),
    );
  }
  assert.notEqual(aliases.get('9:32'), aliases.get('9:42'));
  assert.equal(
    mergeMilitaryFragments([
      a,
      {
        ...b,
        featureKey: a.featureKey,
        osmKey: a.osmKey,
        nameRecord: a.nameRecord,
      },
    ]).length,
    1,
    'same identity stitches even across quantization',
  );
});

test('named A+B to B to A+B preserves canonical identity, parent title and selection', async () => {
  const C = await import('cesium');
  const { createRendering } =
    await import('../layers/installations/rendering.js');
  const aliases = new Map();
  const named = (n, footprint, areaM2) =>
    record(String(n * 10 + 2), footprint, {
      tileZoom: 9,
      osmKey: `w${n}`,
      kind: 'installation',
      class: 'military_land',
      nameRecord: {
        id: `osm:military:w${n}`,
        osmKey: `w${n}`,
        name: `Site ${n}`,
        areaM2,
        longitude: footprint[0][0] + 0.1,
        latitude: 0.5,
      },
    });
  const a = named(1, ring(0, 0, 1, 1), 100),
    b = named(2, ring(1, 0, 2, 1), 10);
  let selected = { id: 'osm:military:w1' };
  const state = {
    records: [],
    recordById: new Map(),
    selectedId: selected.id,
    renderedKeys: new Map(),
    dataSource: new C.CustomDataSource(),
  };
  const rendering = createRendering({
    state,
    source: {},
    parts: {
      model: {
        colorFor: () => C.Color.ORANGE,
        installationSourceLabel: () => 'OpenStreetMap',
      },
    },
    services: {
      ground: { floorAltitudeM: () => 0, cachedGroundFloor: () => 0 },
      context: {
        getSelectedEntityContext: () => selected,
        removeEntityContextsForLayer() {},
        registerEntityContext() {},
        selectEntityContext: (entity) => {
          selected = entity;
        },
      },
      render: { governorRequestRender() {} },
      anchors: {},
    },
  });
  for (const members of [[a, b], [b], [a, b]]) {
    state.records = mergeMilitaryFragments(members, aliases);
    state.recordById = new Map(state.records.map((r) => [r.id, r]));
    assert.equal(state.records[0].id, selected.id);
    assert.equal(state.records[0].name, 'Site 1');
    assert.deepEqual(state.records[0].memberNames, ['Site 2']);
    rendering.renderRecords();
    assert.equal(state.selectedId, 'osm:military:w1');
    assert.ok(state.dataSource.entities.getById(state.selectedId));
  }
  const [detail] = mergeMilitaryFragments([{ ...b, tileZoom: 12 }], aliases);
  assert.equal(detail.id, 'osm:military:w2');
  assert.equal(
    detail.name,
    'Site 2',
    'coarse parent metadata cannot override a detail split',
  );
});

test('cold names reconcile selection through enrichment, identical groups at another zoom and wide-point handoff', async () => {
  const C = await import('cesium');
  const { createRendering } =
    await import('../layers/installations/rendering.js');
  const { retainNamedHandoff } =
    await import('../layers/installations/ingestion.js');
  const aliases = new Map();
  const unnamed = [1, 2].map((n) =>
    record(String(n * 10 + 2), ring(n - 1, 0, n, 1), {
      tileZoom: 12,
      name: 'Military area',
      kind: 'installation',
      class: 'military_land',
    }),
  );
  const named = unnamed.map((r, i) => ({
    ...r,
    nameRecord: {
      id: `osm:military:w${i + 1}`,
      osmKey: `w${i + 1}`,
      name: `Site ${i + 1}`,
      areaM2: (i + 1) * 100,
      longitude: i + 0.5,
      latitude: 0.5,
      class: 'military_land',
    },
  }));
  const [warm] = mergeMilitaryFragments(named);
  let selected = null;
  const contexts = new Map();
  const state = {
    records: [],
    recordById: new Map(),
    selectedId: null,
    renderedKeys: new Map(),
    dataSource: new C.CustomDataSource(),
  };
  const rendering = createRendering({
    state,
    source: {},
    parts: {
      model: {
        colorFor: () => C.Color.ORANGE,
        installationSourceLabel: () => 'OpenStreetMap',
      },
    },
    services: {
      ground: { floorAltitudeM: () => 0, cachedGroundFloor: () => 0 },
      context: {
        getSelectedEntityContext: () => selected,
        removeEntityContextsForLayer: (_id, { retainIds } = {}) => {
          for (const id of contexts.keys())
            if (!retainIds?.has(id)) contexts.delete(id);
        },
        registerEntityContext: (_entity, context) =>
          contexts.set(context.id, context),
        selectEntityContext: (entity) => {
          selected = contexts.get(entity.id);
        },
      },
      render: { governorRequestRender() {} },
      anchors: {},
    },
  });
  const publish = (records, claimSelection = false) => {
    state.records = records;
    state.recordById = new Map(records.map((r) => [r.id, r]));
    rendering.renderRecords({ claimSelection });
    assert.equal(state.selectedId, records[0].id);
    assert.equal(selected.id, records[0].id);
    assert.ok(state.dataSource.entities.getById(state.selectedId));
    assert.ok(contexts.has(selected.id));
  };
  const cold = mergeMilitaryFragments(unnamed, aliases);
  state.selectedId = cold[0].id;
  publish(cold, true);
  const enriched = mergeMilitaryFragments(named, aliases);
  assert.equal(
    enriched[0].id,
    warm.id,
    'names timing must not choose the final canonical identity',
  );
  publish(enriched);
  assert.equal(selected.label, 'Site 2');
  for (const zoom of [10, 12]) {
    const records = mergeMilitaryFragments(
      named.map((r) => ({ ...r, tileZoom: zoom })),
      aliases,
    );
    assert.equal(records[0].id, warm.id);
    assert.equal(records[0].footprints.length, 2);
    publish(records);
  }
  const wide = {
    ...named[1].nameRecord,
    namedArea: true,
    pointOnly: true,
    sources: named[1].sources,
  };
  publish([wide]);
  const fresh = mergeMilitaryFragments(unnamed, new Map());
  publish(
    retainNamedHandoff([wide], fresh, {
      west: -1,
      east: 3,
      south: -1,
      north: 2,
    }),
  );
  assert.equal(
    state.records[0].name,
    'Site 2',
    'the unnamed group retains the wide parent label',
  );
  publish(enriched);
  selected = { id: 'aircraft:other', layerId: 'flights' };
  rendering.renderRecords();
  assert.equal(
    state.selectedId,
    null,
    'identity migration cannot reclaim another layer selection',
  );
  assert.equal(selected.id, 'aircraft:other');
});
