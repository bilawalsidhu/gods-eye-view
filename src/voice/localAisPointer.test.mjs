// Pointing at a Local AIS marker whose fix is unvalidated or approximate must
// not give the hosted model the cursor's ground point: that point is where the
// flagged marker is drawn. Default-deny: only `validated === true &&
// approx === false` sends a position. These tests drive the real pointer
// picker, the gesture item and the real get_entity_context action.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { createGevActionRunner } from './gevActions.js';
import { createLocalAisLayer } from '../layers/localAis/index.js';
import { fakeDrawPort } from '../testSupport/fakeDrawPort.mjs';
import { bindFakeCesiumCamera } from '../testSupport/fakeCameraPort.mjs';
import { analystHeadline, analystNounFor } from './speech.js';
import { createPointerPicker } from './pointerPick.js';
import { createPointerTracker, pointerTurnContext } from './pointerContext.js';
import { getContextStore } from '../data/contextStore.js';
import { positionWithheld } from '../data/positionTrust.js';
import {
  describeEntity,
  entityKind,
  layerBreakdown,
  layerMatches,
  layerRecords,
  nearbyByKind,
  recordKind,
  searchEntities,
  viewSummary,
} from '../data/entityContext.js';
import { resolveDeicticArgs } from './deixis.js';
import {
  registerPickOwner,
  unregisterPickOwner,
} from '../data/pickRegistry.js';

const SERVER_NOW = 1_800_000_000_000;
const CURSOR = { lat: 30.52001, lon: -40.52002 };
const vessel = (n, extra = {}) => ({
  id: `local-ais:20000000${n}`,
  mmsi: `20000000${n}`,
  name: `TEST ${n}`,
  lat: 30.5,
  lon: -40.5,
  speed: 9.4,
  course: 77,
  validated: true,
  approx: false,
  lastSeenAt: SERVER_NOW - 5000,
  source: 'local-ais',
  ...extra,
});

function makeViewer(centre = null, { height = 300_000, project = null } = {}) {
  globalThis.window = globalThis.window || {
    clearTimeout,
    setTimeout,
    requestIdleCallback: null,
  };
  const viewer = {
    canvas: {
      clientWidth: 1000,
      clientHeight: 500,
      addEventListener() {},
      removeEventListener() {},
    },
    scene: {
      canvas: { addEventListener() {}, removeEventListener() {} },
      // With a centre, the depth pick under the view centre answers there.
      ...(centre
        ? {
            pickPositionSupported: true,
            pickPosition: () =>
              Cesium.Cartesian3.fromDegrees(centre.lon, centre.lat, 0),
          }
        : {}),
    },
    clock: { onTick: { addEventListener: () => () => {} } },
    camera: {
      moveEnd: { addEventListener() {} },
      positionWC: Cesium.Cartesian3.fromDegrees(-40.5, 30.5, 1000),
      positionCartographic: {
        height,
        latitude: 0.5323,
        longitude: -0.7069,
      },
    },
  };
  return bindFakeCesiumCamera(viewer, {
    draw: fakeDrawPort(),
    ...(centre
      ? {
          query: {
            pickPosition: () =>
              Cesium.Cartesian3.fromDegrees(centre.lon, centre.lat, 0),
            pickEllipsoid: () =>
              Cesium.Cartesian3.fromDegrees(centre.lon, centre.lat, 0),
            pickGlobe: () =>
              Cesium.Cartesian3.fromDegrees(centre.lon, centre.lat, 0),
            pickRay: () => ({}),
            project: project || (() => null),
          },
        }
      : {}),
  });
}

async function setup(records, { centre = null, height, project } = {}) {
  const viewer = makeViewer(centre, { height, project });
  const layer = createLocalAisLayer({
    now: () => SERVER_NOW,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        configured: true,
        generatedAt: SERVER_NOW,
        feeds: [
          {
            label: 'AIS receiver 1',
            status: 'live',
            count: records.length,
            dropped: 0,
            rejected: 0,
            heardAt: SERVER_NOW - 5000,
          },
        ],
        records,
      }),
    }),
    overlayHost: { setEntries() {}, setVisible() {} },
  });
  layer.init(viewer);
  layer.enable();
  await layer.update();
  const dataManager = {
    layers: new Map([['local-ais', { module: layer }]]),
    isEnabled: (id) => id === 'local-ais',
    getAll: () => [
      {
        id: 'local-ais',
        name: 'Local AIS',
        enabled: true,
        stats: layer.getStats(),
      },
    ],
  };
  registerPickOwner('local-ais', (id) => String(id).startsWith('local-ais:'));
  return {
    viewer,
    layer,
    dataManager,
    done() {
      unregisterPickOwner('local-ais');
      layer.destroy();
    },
  };
}

/** A gesture turn's pointer item, as the voice controller builds it. */
function gestureItem(h, mmsi) {
  const pick = createPointerPicker({
    viewer: h.viewer,
    dataManager: h.dataManager,
    pickAt: () => ({ meta: { pick: `local-ais:${mmsi}` } }),
    pickWorldFromScreen: () => ({ ...CURSOR, height: 3 }),
  });
  const timers = [];
  const tracker = createPointerTracker({
    element: h.viewer.canvas,
    pick,
    now: () => 1000,
    setTimer: (fn) => timers.push(fn) && timers.length,
    clearTimer() {},
  });
  tracker.moveTo(500, 250);
  const snapshot = tracker.capture('keydown');
  return {
    snapshot,
    turn: pointerTurnContext(snapshot, {
      at: 'keydown',
      gesture: true,
      sentKey: null,
    }),
  };
}

const flagged = [
  ['an unvalidated fix', { validated: false }],
  ['an approximate fix', { approx: true }],
  ['a fix with no validated flag', { validated: undefined }],
  ['a fix with a non-boolean approx', { approx: 'false' }],
  ['a fix with a numeric approx', { approx: 0 }],
  // Only the boolean true is a validation: 1 and 'true' are not.
  ['a fix with validated 1', { validated: 1 }],
  ['a fix with validated "true"', { validated: 'true' }],
  ['a fix with validated 0', { validated: 0 }],
];

for (const [label, extra] of flagged) {
  test(`pointer gesture: ${label} sends the vessel id and no ground point`, async () => {
    const h = await setup([vessel(2, extra)]);
    try {
      const { snapshot, turn } = gestureItem(h, '200000002');
      assert.equal(snapshot.fresh, true, 'the vessel is still the referent');
      assert.equal(snapshot.lat, null);
      assert.equal(snapshot.lon, null);
      assert.equal(turn.item.target.label, 'local-ais:200000002');
      assert.equal(turn.item.ground, undefined, 'no ground coordinates');
      assert.doesNotMatch(
        JSON.stringify(turn.item),
        /30\.52|40\.52/,
        'the cursor position is nowhere in the item',
      );
    } finally {
      h.done();
    }
  });
}

test('pointer gesture: a validated exact fix still sends the ground point', async () => {
  const h = await setup([vessel(1)]);
  try {
    const { turn } = gestureItem(h, '200000001');
    assert.deepEqual(turn.item.ground, { lat: 30.52, lon: -40.52 });
  } finally {
    h.done();
  }
});

test('pointer gesture: a Local AIS pick with no reachable layer is withheld', async () => {
  const h = await setup([vessel(1)]);
  try {
    const pick = createPointerPicker({
      viewer: h.viewer,
      dataManager: {
        layers: new Map(),
        isEnabled: () => true,
      },
      pickAt: () => ({ meta: { pick: 'local-ais:200000001' } }),
      pickWorldFromScreen: () => ({ ...CURSOR }),
    });
    const picked = pick(500, 250);
    assert.equal(picked.entity.layerId, 'local-ais');
    assert.equal(picked.ground, null);
  } finally {
    h.done();
  }
});

test('positionWithheld: only an explicit true from the layer sends', () => {
  const dm = (isPositionTrusted) => ({
    layers: new Map([['local-ais', { module: { isPositionTrusted } }]]),
  });
  assert.equal(
    positionWithheld(
      dm(() => true),
      'local-ais',
      'x',
    ),
    false,
  );
  for (const answer of [false, 1, 'true', undefined, null])
    assert.equal(
      positionWithheld(
        dm(() => answer),
        'local-ais',
        'x',
      ),
      true,
    );
  assert.equal(
    positionWithheld(
      dm(() => {
        throw new Error('boom');
      }),
      'local-ais',
      'x',
    ),
    true,
  );
  assert.equal(positionWithheld(null, 'local-ais', 'x'), true);
  assert.equal(positionWithheld(null, 'flights', 'x'), false);
  assert.equal(positionWithheld(null, null, null), false);
});

async function pointerContext(h, target) {
  const runner = createGevActionRunner({
    viewer: h.viewer,
    styleManager: {
      activeStyle: 'normal',
      getContextModeState: () => ({ mode: null, active: false }),
      getCockpitState: () => ({ active: false }),
      getControlState: () => null,
    },
    dataManager: h.dataManager,
    deixis: {
      pointer: {
        activeSnapshot: () => ({
          fresh: true,
          at: 'keydown',
          entity: {
            layerId: 'local-ais',
            id: target.id,
            label: target.id,
            kind: 'vessel',
          },
          lat: target.lat,
          lon: target.lon,
          radiusKm: 10,
        }),
      },
      referents: null,
    },
  });
  return runner('get_entity_context', { scope: 'pointer' });
}

for (const [label, extra] of flagged) {
  test(`get_entity_context pointer: ${label} returns no pointer coordinates`, async () => {
    const h = await setup([vessel(2, extra)]);
    try {
      // The snapshot carries the cursor position, as an older or other capture
      // path could: the action itself must still refuse to forward it.
      const result = await pointerContext(h, {
        id: 'local-ais:200000002',
        ...CURSOR,
      });
      assert.equal(result.ok, true);
      assert.equal(result.scope, 'pointer');
      assert.equal(result.pointer, undefined, 'no pointer coordinates');
      assert.deepEqual(result.pointedAt, {
        layerId: 'local-ais',
        id: 'local-ais:200000002',
      });
      assert.doesNotMatch(
        JSON.stringify(result.selected ?? null) +
          JSON.stringify(result.pointer ?? null),
        /30\.52|40\.52|30\.5\b|40\.5\b/,
      );
    } finally {
      h.done();
    }
  });
}

test('get_entity_context pointer: a validated exact fix keeps its pointer coordinates', async () => {
  const h = await setup([vessel(1)]);
  try {
    const result = await pointerContext(h, {
      id: 'local-ais:200000001',
      ...CURSOR,
    });
    assert.deepEqual(result.pointer, {
      latitude: CURSOR.lat,
      longitude: CURSOR.lon,
    });
    assert.equal(result.pointedAt, undefined);
  } finally {
    h.done();
  }
});

test('entity context lists, nearby lists and search hold only validated exact vessels', async () => {
  const h = await setup([
    vessel(1),
    vessel(2, { validated: false }),
    vessel(3, { approx: true }),
    vessel(4, { approx: 'false' }),
  ]);
  try {
    // layerRecords feeds nearby lists, the omnibar search and the card.
    assert.deepEqual(
      layerRecords(h.dataManager, 'local-ais').map((r) => r.mmsi),
      ['200000001'],
    );
  } finally {
    h.done();
  }
});

const beacon = (n, kind = 'sart', extra = {}) =>
  vessel(n, {
    id: `local-ais:97000000${n}`,
    mmsi: `97000000${n}`,
    name: '',
    shipClass: 13,
    beaconType: kind,
    ...extra,
  });

test('pointer gesture: a validated beacon sends its ground point like a vessel', async () => {
  const h = await setup([beacon(1)]);
  try {
    const { snapshot, turn } = gestureItem(h, '970000001');
    assert.equal(snapshot.fresh, true);
    assert.ok(Math.abs(turn.item.ground?.lat - CURSOR.lat) < 1e-3);
  } finally {
    h.done();
  }
});

for (const [label, extra] of flagged) {
  test(`pointer gesture: a beacon with ${label} sends no ground point`, async () => {
    const h = await setup([beacon(2, 'mob', extra)]);
    try {
      const { snapshot, turn } = gestureItem(h, '970000002');
      assert.equal(snapshot.fresh, true, 'the beacon is still the referent');
      assert.equal(snapshot.lat, null);
      assert.equal(turn.item.ground, undefined);
      assert.doesNotMatch(JSON.stringify(turn.item), /30\.52|40\.52/);
    } finally {
      h.done();
    }
  });
}

test('entity context names a beacon as a beacon, and lists only validated exact ones', async () => {
  const h = await setup([
    beacon(1),
    beacon(2, 'epirb', { validated: false }),
    vessel(1),
  ]);
  try {
    assert.deepEqual(
      layerRecords(h.dataManager, 'local-ais').map((r) => r.mmsi),
      ['970000001', '200000001'],
    );
    const result = await pointerContext(h, {
      id: 'local-ais:970000001',
      ...CURSOR,
    });
    assert.equal(result.selected, null);
    assert.equal(result.pointer?.latitude, CURSOR.lat);
  } finally {
    h.done();
  }
});

test('a withheld position is named as withheld, not as "nothing under the pointer"', async () => {
  const pointer = {
    fresh: true,
    entity: {
      layerId: 'local-ais',
      id: 'local-ais:200000002',
      label: 'TEST 2',
      withheld: true,
    },
    lat: null,
    lon: null,
    radiusKm: 10,
  };
  const cases = [
    ['analyst_query', { scope: { kind: 'pointer' } }],
    [
      'annotate_map',
      { annotations: [{ type: 'marker', target: 'pointer', label: 'x' }] },
    ],
    ['find_imagery', { area: 'pointer' }],
  ];
  for (const [name, args] of cases) {
    const { error } = resolveDeicticArgs(name, args, { pointer });
    assert.match(error, /withheld/i, name);
    assert.match(error, /not validated or is approximate/i, name);
    assert.doesNotMatch(error, /Nothing is under the pointer/, name);
  }
  // With no entity at all the old message is still the true one.
  const empty = resolveDeicticArgs(
    'analyst_query',
    { scope: { kind: 'pointer' } },
    { pointer: { fresh: true, entity: null, lat: null, lon: null } },
  );
  assert.match(empty.error, /Nothing is under the pointer/);
});

test('flying to a withheld vessel says its position is withheld, not that it is gone', async () => {
  const h = await setup([vessel(2, { validated: false }), vessel(1)]);
  try {
    const runner = createGevActionRunner({
      viewer: h.viewer,
      styleManager: {
        activeStyle: 'normal',
        getContextModeState: () => ({ mode: null, active: false }),
        getCockpitState: () => ({ active: false }),
        getControlState: () => null,
      },
      dataManager: h.dataManager,
    });
    const withheld = await runner('fly_to_location', {
      entity: {
        layerId: 'local-ais',
        id: 'local-ais:200000002',
        label: 'TEST 2',
      },
    });
    assert.equal(withheld.ok, false);
    assert.match(withheld.error, /position withheld/);
    assert.doesNotMatch(withheld.error, /no longer loaded/);
    // A vessel that is really gone still says so.
    const gone = await runner('fly_to_location', {
      entity: { layerId: 'flights', id: 'zz', label: 'ZZ' },
    });
    assert.match(gone.error, /no longer loaded/);
  } finally {
    h.done();
  }
});

test('a beacon card says beacon, a vessel card says vessel', async () => {
  const h = await setup([beacon(1), vessel(1)]);
  try {
    const identity = (id) => ({ layerId: 'local-ais', id });
    const card = describeEntity(h.dataManager, identity('970000001'));
    assert.equal(card.kind, 'beacon');
    assert.equal(card.icon, 'warning');
    const ship = describeEntity(h.dataManager, identity('200000001'));
    assert.equal(ship.kind, 'vessel');
    assert.equal(
      recordKind('local-ais', { beaconType: 'sart' }).kind,
      'beacon',
    );
    assert.equal(
      recordKind('local-ais', { beaconType: null }),
      entityKind('local-ais'),
    );
    // Only Local AIS has beacons.
    assert.equal(
      recordKind('ais-live-vessels', { beaconType: 'sart' }).kind,
      'vessel',
    );
  } finally {
    h.done();
  }
});

// A pointed item with no place is "withheld" only when the picker says so: a
// Local ADS-B aircraft picked against the sky has no position either, and
// "withheld, not validated" would be false for it.
const pointerWith = (entity) => ({
  fresh: true,
  entity,
  lat: null,
  lon: null,
  radiusKm: 10,
});

test('the withheld message is for a picker-flagged fix only, never a Local ADS-B sky pick', () => {
  const ask = (pointer) =>
    resolveDeicticArgs(
      'analyst_query',
      { scope: { kind: 'pointer' } },
      { pointer },
    ).error;
  // A Local ADS-B aircraft picked against the sky: no place, nothing withheld.
  assert.match(
    ask(pointerWith({ layerId: 'local-adsb', id: 'abc123', label: 'ABC123' })),
    /Nothing is under the pointer/,
  );
  // No entity at all, and an entity the picker did not flag: the same.
  assert.match(ask(pointerWith(null)), /Nothing is under the pointer/);
});

for (const [label, extra] of [
  ['not validated', { validated: false }],
  ['approximate', { approx: true }],
]) {
  test(`a ${label} fix picked by the real picker is named as withheld`, async () => {
    const h = await setup([vessel(2, extra)]);
    try {
      const { snapshot } = gestureItem(h, '200000002');
      assert.equal(snapshot.entity.withheld, true);
      const { error } = resolveDeicticArgs(
        'analyst_query',
        { scope: { kind: 'pointer' } },
        { pointer: snapshot },
      );
      assert.match(error, /Position withheld/);
      assert.match(error, /not validated or is approximate/);
    } finally {
      h.done();
    }
  });
}

test('a trusted vessel pick carries no withheld flag', async () => {
  const h = await setup([vessel(1)]);
  try {
    const { snapshot } = gestureItem(h, '200000001');
    assert.equal('withheld' in snapshot.entity, false);
  } finally {
    h.done();
  }
});

// The text tool falls back to the depth pick under the view centre when the
// target gives no place. With the flagged marker at the centre, that pick is
// the marker's own position, so a withheld target must use no view target.
const CENTRE = { lat: 31.222, lon: -41.222 };
const centrePattern = /31\.22|41\.22/;
for (const [label, make] of [
  ['vessel', () => vessel(2, { ...CENTRE, validated: false })],
  ['beacon', () => beacon(2, 'sart', { ...CENTRE, approx: true })],
]) {
  test(`get_entity_context pointer: a withheld ${label} at the view centre gives no coordinates`, async () => {
    const record = make();
    const h = await setup([record], { centre: CENTRE });
    try {
      const result = await pointerContext(h, {
        id: record.id,
        lat: null,
        lon: null,
      });
      assert.equal(result.ok, true);
      assert.equal(result.pointer, undefined);
      assert.deepEqual(result.pointedAt, {
        layerId: 'local-ais',
        id: record.id,
      });
      assert.doesNotMatch(JSON.stringify(result), centrePattern);
      assert.deepEqual(result.scene.basemap.viewportSamples, []);
      assert.equal(result.scene.basemap.target, null);
      // The camera is often centred on the marker: height only.
      assert.deepEqual(Object.keys(result.scene.camera), ['heightM']);
      assert.doesNotMatch(JSON.stringify(result), /30\.4985|40\.5023/);
    } finally {
      h.done();
    }
  });
}

// The shortlist of nearby records is ordered by distance from the target. For
// a withheld fix the target must be null: ordered from the view centre, the
// shortlist would favour whatever sits next to the flagged marker.
test('a withheld pointer target gives the visible list no view-centre target', async () => {
  const record = vessel(2, { ...CENTRE, validated: false });
  const h = await setup([record], {
    centre: CENTRE,
    height: 50_000,
    project: (position) => ({ x: 500 + position.i, y: 250 }),
  });
  const store = getContextStore();
  const ids = [];
  try {
    // 66 records, inserted far to near the view centre; on screen the first is
    // the closest to the centre. Nothing is drawn by a layer, so no layerId.
    for (let i = 0; i < 66; i += 1) {
      const id = `shortlist-${i}`;
      ids.push(id);
      store.entities.set(id, {
        id,
        label: id,
        latitude: CENTRE.lat + (65 - i) * 0.01,
        longitude: CENTRE.lon,
        targetPosition: { i },
      });
    }
    const result = await pointerContext(h, {
      id: record.id,
      lat: null,
      lon: null,
    });
    assert.equal(result.ok, true);
    assert.equal(result.count, 5);
    // Unordered by distance (target null) the first 64 inserted are kept, so
    // the record drawn at the centre of the screen is in the answer. With the
    // view centre as the target, the 64 nearest would drop it.
    assert.deepEqual(
      result.visible.map((row) => row.id),
      [
        'shortlist-0',
        'shortlist-1',
        'shortlist-2',
        'shortlist-3',
        'shortlist-4',
      ],
    );
  } finally {
    for (const id of ids) store.entities.delete(id);
    h.done();
  }
});

test('the view-centre pick is used again for a target that is not withheld', async () => {
  // The control for the test above: the fixture really does expose the centre.
  const h = await setup([vessel(1, { ...CENTRE })], { centre: CENTRE });
  try {
    const result = await pointerContext(h, {
      id: 'local-ais:200000001',
      lat: null,
      lon: null,
    });
    assert.ok(
      result.pointer || result.scene.basemap,
      'a trusted fix has a place',
    );
    assert.match(JSON.stringify(result), centrePattern);
    assert.equal(typeof result.scene.camera.latitude, 'number');
    assert.equal(typeof result.scene.camera.longitude, 'number');
  } finally {
    h.done();
  }
});

// Beacons are their own kind: not in a vessel list, not a ship type, and the
// card says beacon even when the fix is withheld.
test('a beacon is kept out of every vessel list and ship-type count', async () => {
  const h = await setup([vessel(1), beacon(1)]);
  try {
    const here = { lat: 30.5, lon: -40.5 };
    const near = nearbyByKind(h.dataManager, here);
    assert.deepEqual(
      near.vessels.items.map((row) => row.key),
      ['local-ais:200000001'],
    );
    assert.equal(near.vessels.count, 1);
    const sart = near.other.find((row) => row.key === 'local-ais:970000001');
    assert.equal(sart.icon, 'warning');
    // Search finds the beacon, with the beacon icon.
    const hit = searchEntities(h.dataManager, '970000001');
    assert.equal(hit.length, 1);
    assert.equal(hit[0].icon, 'warning');
    // The view summary and the ship-type split count only the vessel.
    const rect = { west: -50, south: 20, east: -30, north: 40 };
    const groups = viewSummary(h.dataManager, rect, here);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].count, 1);
    assert.deepEqual(
      groups[0].items.map((row) => row.key),
      ['local-ais:200000001'],
    );
    const split = layerBreakdown(h.dataManager, 'local-ais');
    assert.equal(split.total, 1);
    assert.equal(
      split.splits[0].parts.reduce((sum, part) => sum + part.count, 0),
      1,
    );
    // A layer match lists it with the beacon icon, not the boat.
    const matches = layerMatches(h.dataManager, 'local-ais', {
      center: here,
      radiusKm: 50,
    });
    const icons = Object.fromEntries(
      matches.items.map((row) => [row.key, row.icon]),
    );
    assert.equal(icons['local-ais:970000001'], 'warning');
    assert.equal(icons['local-ais:200000001'], 'directions_boat');
  } finally {
    h.done();
  }
});

test('a withheld beacon card says beacon, with its kind and the caveat', async () => {
  const h = await setup([
    beacon(2, 'epirb', { validated: false }),
    vessel(2, { validated: false }),
  ]);
  try {
    // The record has no position, so it is not in layerRecords: the card must
    // still know it is a beacon.
    const card = describeEntity(h.dataManager, {
      layerId: 'local-ais',
      id: 'local-ais:970000002',
      label: 'local-ais:970000002',
    });
    assert.equal(card.kind, 'beacon');
    assert.equal(card.icon, 'warning');
    assert.equal(card.lat, null);
    assert.equal(card.lon, null);
    assert.ok(card.facts.some((fact) => fact.field === 'beaconCaveat'));
    const type = card.facts.find((fact) => fact.field === 'beaconType');
    assert.equal(type.label, 'Beacon type');
    assert.equal(type.value, 'EPIRB beacon');
    // A flagged vessel is still a vessel, and has no caveat.
    const ship = describeEntity(h.dataManager, {
      layerId: 'local-ais',
      id: 'local-ais:200000002',
      label: 'local-ais:200000002',
    });
    assert.equal(ship.kind, 'vessel');
    assert.equal(
      ship.facts.some((fact) => fact.field === 'beaconCaveat'),
      false,
    );
  } finally {
    h.done();
  }
});

test('a beacon card carries the caveat and a translatable type', async () => {
  const h = await setup([beacon(1, 'mob')]);
  try {
    const card = describeEntity(h.dataManager, {
      layerId: 'local-ais',
      id: 'local-ais:970000001',
    });
    const caveat = card.facts.find((fact) => fact.field === 'beaconCaveat');
    assert.match(caveat.value, /Heard by your receiver/);
    assert.match(caveat.value, /Test transmissions are common/);
    assert.match(caveat.value, /not a verified emergency/);
    assert.match(caveat.value, /active or a test is unknown/);
    assert.equal(caveat.words.text, caveat.value, 'the UI translates it');
    const type = card.facts.find((fact) => fact.field === 'beaconType');
    assert.equal(type.value, 'Man-overboard (MOB) beacon');
    assert.equal(type.words.text, type.value);
    assert.ok(card.facts.length <= 8);
  } finally {
    h.done();
  }
});

// What the voice model is told about a pointed beacon, and how a Local AIS
// count is worded: a beacon is never sent as a vessel and never counted as a
// ship.
test('a pointed beacon reaches voice as kind beacon, a vessel as vessel', async () => {
  const h = await setup([
    beacon(1, 'mob'),
    beacon(2, 'sart', { validated: false }),
    vessel(1),
  ]);
  try {
    assert.equal(gestureItem(h, '970000001').snapshot.entity.kind, 'beacon');
    assert.equal(gestureItem(h, '970000002').snapshot.entity.kind, 'beacon');
    assert.equal(gestureItem(h, '200000001').snapshot.entity.kind, 'vessel');
    const turn = gestureItem(h, '970000001').turn;
    assert.doesNotMatch(JSON.stringify(turn), /vessel/);
  } finally {
    h.done();
  }
});

// The layer holds up to 5000 records but getAnalystRecords defaults to 2000:
// a beacon heard after 2000 vessels must still reach voice as a beacon, and a
// pick the lookup cannot find is a neutral feature, never a vessel.
test('a beacon after 2000 vessels still reaches voice as a beacon', async () => {
  const many = Array.from({ length: 2100 }, (_, i) =>
    vessel(i + 1, {
      id: `local-ais:3${String(i).padStart(8, '0')}`,
      mmsi: `3${String(i).padStart(8, '0')}`,
    }),
  );
  const h = await setup([...many, beacon(1, 'sart')]);
  try {
    const item = gestureItem(h, '970000001');
    assert.equal(item.snapshot.entity.kind, 'beacon');
    assert.doesNotMatch(JSON.stringify(item.turn), /vessel/);
    assert.equal(gestureItem(h, '300002099').snapshot.entity.kind, 'vessel');
    // A pick the layer does not hold is neutral, not a vessel.
    assert.equal(gestureItem(h, '999999999').snapshot.entity.kind, 'feature');
  } finally {
    h.done();
  }
});

test('a Local AIS count is not worded as ships', () => {
  assert.equal(analystNounFor(['local-ais']), 'results');
  assert.equal(analystNounFor(['ais-live-vessels']), 'ships');
  const headline = analystHeadline({
    count: 2,
    scopeLabel: 'anywhere in the loaded data',
    coverage: { layersQueried: [{ layerKey: 'local-ais' }] },
  });
  assert.doesNotMatch(headline, /ship/);
  assert.match(headline, /^2 results/);
});
