import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { createEvChargingLayer } from './index.js';
import { layerFeedState } from '../../data/feedState.js';
import { tileToBBox } from '../../data/tomtomTiles.js';
import { encodePoiTile } from './poiTileFixture.mjs';
import { createChargingSource } from './source.js';
import { createOpenChargeMapClient } from './openChargeMap.js';

const BUILD_TIME = Date.UTC(2026, 9, 18, 8, 0, 1);
const POI_TEMPLATE =
  'https://tiles.openfreemap.org/planet/20261018_080001_pt/{z}/{x}/{y}.pbf';
const station = (id, latitude = 59.91, longitude = 10.75, name = id) => ({
  id: `ev-charging:${id}`,
  name,
  latitude,
  longitude,
});
const snapshot = (records, extra = {}) => ({
  records,
  zoomIn: false,
  partial: false,
  saturated: false,
  observedAt: BUILD_TIME,
  ...extra,
});

/**
 * The real layer and Cesium entities over a viewer stand-in. Only the canvas,
 * the view rectangle, picking and the shared context store are substituted.
 */
function harness(getStations) {
  const originals = {
    window: globalThis.window,
    document: globalThis.document,
  };
  globalThis.window = new EventTarget();
  globalThis.document = { addEventListener() {}, removeEventListener() {} };
  const added = [];
  const credits = new Set();
  const dynamicCredits = [];
  const owners = new Map();
  const contexts = new Map();
  let selected = null;
  let picked;
  let click = null;
  let destroyed = 0;
  const flights = [];
  const viewer = {
    trackedEntity: null,
    camera: {
      moveEnd: new Cesium.Event(),
      positionWC: Cesium.Cartesian3.fromDegrees(10.75, 59.91, 2000),
      heading: 0,
      computeViewRectangle: () =>
        Cesium.Rectangle.fromDegrees(10.73, 59.9, 10.77, 59.92),
      flyToBoundingSphere: (sphere) => flights.push(sphere),
    },
    scene: {
      canvas: { addEventListener() {}, removeEventListener() {} },
      globe: { ellipsoid: Cesium.Ellipsoid.WGS84 },
      pick: () => picked,
    },
    dataSources: {
      add: (value) => added.push(value),
      remove: (value) => added.splice(added.indexOf(value), 1),
    },
  };
  const layer = createEvChargingLayer({
    source: {
      getStations,
      destroy: () => destroyed++,
      label: 'OpenStreetMap · community mapped',
      attribution: { description: '© OpenStreetMap contributors, ODbL' },
    },
    services: {
      render: { governorRequestRender() {} },
      picking: {
        registerPickOwner: (id, owns) => owners.set(id, owns),
        unregisterPickOwner: (id) => owners.delete(id),
      },
      context: {
        registerEntityContext: (entity, record) =>
          contexts.set(record.id, { ...record, entity }),
        removeEntityContextsForLayer(layerId, { retainIds } = {}) {
          for (const [id, record] of contexts)
            if (record.layerId === layerId && !retainIds?.has(id))
              contexts.delete(id);
        },
        selectEntityContext(entity) {
          selected = contexts.get(entity.id);
          globalThis.window.dispatchEvent(new Event('gev:entity-selected'));
        },
        clearSelectedEntityContextForLayer(layerId) {
          if (selected?.layerId === layerId) selected = null;
        },
        getSelectedEntityContext: () => selected,
      },
      credits: {
        showOsmCredit: (_viewer, owner) => credits.add(owner),
        hideOsmCredit: (_viewer, owner) => credits.delete(owner),
        registerDynamicCredit: (_viewer, credit) => dynamicCredits.push(credit),
        openChargeMapCredit: (provider) => ({ key: `ocm-${provider.id}` }),
      },
      groundFloor: { cachedGroundFloor: () => 12 },
    },
  });
  const setInput = Cesium.ScreenSpaceEventHandler.prototype.setInputAction;
  Cesium.ScreenSpaceEventHandler.prototype.setInputAction = function (
    fn,
    type,
    modifier,
  ) {
    if (type === Cesium.ScreenSpaceEventType.LEFT_CLICK) click = fn;
    return setInput.call(this, fn, type, modifier);
  };
  try {
    layer.init(viewer);
  } finally {
    Cesium.ScreenSpaceEventHandler.prototype.setInputAction = setInput;
  }
  layer.enable();
  return {
    layer,
    viewer,
    added,
    credits,
    dynamicCredits,
    owners,
    contexts,
    flights,
    get selected() {
      return selected;
    },
    set selected(value) {
      selected = value;
    },
    get destroyed() {
      return destroyed;
    },
    entities: () => added[0]?.entities.values ?? [],
    click(id) {
      const entity = id ? added[0].entities.getById(id) : null;
      picked = entity ? { id: entity } : undefined;
      click({ position: new Cesium.Cartesian2() });
    },
    restore() {
      for (const name of ['window', 'document']) {
        if (originals[name] === undefined) delete globalThis[name];
        else globalThis[name] = originals[name];
      }
    },
  };
}

test('the layer requires a station source', () => {
  assert.throws(() => createEvChargingLayer(), /station source/);
});

test('a read renders one marker per station and reports the tile build time', async () => {
  const h = harness(async () =>
    snapshot([station('a'), station('b', 59.915, 10.76)]),
  );
  try {
    assert.equal(await h.layer.update(), true);
    assert.equal(h.entities().length, 2);
    const stats = h.layer.getStats();
    assert.equal(stats.count, 2);
    assert.equal(stats.status, 'ready');
    assert.equal(stats.observedAt, BUILD_TIME);
    assert.equal(stats.stale, false);
    assert.equal(stats.error, null);
    assert.equal(layerFeedState(stats), 'nominal');
    assert.ok(h.credits.has('ev-charging'), 'OSM credit while stations show');
    assert.equal(h.owners.get('ev-charging')('ev-charging:a'), true);
    assert.deepEqual([...h.contexts.keys()].sort(), [
      'ev-charging:a',
      'ev-charging:b',
    ]);
  } finally {
    h.layer.destroy();
    h.restore();
  }
});

test('a response landing after disable cannot redraw the scene', async () => {
  let release;
  let seen;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const h = harness(async (_box, { signal }) => {
    seen = signal;
    await gate;
    return snapshot([station('a')]);
  });
  try {
    const pending = h.layer.update();
    h.layer.disable();
    assert.equal(seen.aborted, true, 'disable aborts the request in flight');
    release();
    assert.equal(await pending, false);
    assert.equal(h.entities().length, 0);
    assert.equal(h.layer.getStats().count, 0);
    assert.equal(h.credits.size, 0);
  } finally {
    h.layer.destroy();
    h.restore();
  }
});

test('a superseded read never replaces the newer one', async () => {
  const releases = [];
  const h = harness(
    (_box, { signal }) =>
      new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason));
        releases.push(resolve);
      }),
  );
  try {
    const older = h.layer.update();
    const newer = h.layer.update();
    releases[1](snapshot([station('new')]));
    releases[0](snapshot([station('old')]));
    assert.equal(await older, false);
    assert.equal(await newer, true);
    assert.deepEqual(
      h.entities().map((entity) => entity.id),
      ['ev-charging:new'],
    );
  } finally {
    h.layer.destroy();
    h.restore();
  }
});

test('a view too wide for the tile cap asks to zoom in and clears the markers', async () => {
  let reply = snapshot([station('a')]);
  const h = harness(async () => reply);
  try {
    await h.layer.update();
    h.click('ev-charging:a');
    reply = snapshot([], { zoomIn: true, observedAt: null });
    await h.layer.update();
    assert.equal(h.selected, null, 'the card closes with its marker');
    const stats = h.layer.getStats();
    assert.equal(stats.status, 'zoom-in');
    assert.equal(stats.count, 0);
    assert.equal(stats.countLabel, '');
    assert.equal(stats.loadingLabel, 'Zoom in to load charging stations');
    assert.equal(layerFeedState(stats), 'nominal');
    assert.equal(h.entities().length, 0);
    assert.equal(h.credits.size, 0);
  } finally {
    h.layer.destroy();
    h.restore();
  }
});

test('a failed refresh keeps earlier stations as stale; with none it is unavailable', async () => {
  let fail = false;
  const h = harness(async () => {
    if (fail) throw new Error('OpenFreeMap HTTP 503');
    return snapshot([station('a')]);
  });
  try {
    await h.layer.update();
    fail = true;
    assert.equal(await h.layer.update(), false);
    let stats = h.layer.getStats();
    assert.equal(stats.stale, true);
    assert.equal(stats.status, 'stale');
    assert.equal(stats.error, 'OpenFreeMap HTTP 503');
    assert.equal(stats.count, 1, 'the markers stay');
    assert.equal(layerFeedState(stats), 'stale');
    assert.equal(stats.loadingLabel, 'Showing cached locations');
    // Once a good read lands the stale flag clears.
    fail = false;
    await h.layer.update();
    stats = h.layer.getStats();
    assert.equal(stats.stale, false);
    assert.equal(stats.error, null);
    assert.equal(layerFeedState(stats), 'nominal');
  } finally {
    h.layer.destroy();
    h.restore();
  }

  const empty = harness(async () => {
    throw new Error('OpenFreeMap network error');
  });
  try {
    await empty.layer.update();
    const stats = empty.layer.getStats();
    assert.equal(stats.stale, false);
    assert.equal(stats.status, 'unavailable');
    assert.equal(layerFeedState(stats), 'unavailable');
  } finally {
    empty.layer.destroy();
    empty.restore();
  }
});

test('a partial or capped read says so', async () => {
  const h = harness(async () =>
    snapshot([station('a')], { partial: true, saturated: true }),
  );
  try {
    await h.layer.update();
    const stats = h.layer.getStats();
    assert.equal(layerFeedState(stats), 'partial');
    assert.equal(stats.saturated, true);
    assert.equal(stats.loadingLabel, 'Coverage limited — zoom in');
  } finally {
    h.layer.destroy();
    h.restore();
  }
});

test('a click selects a station and shows its card; empty map releases it', async () => {
  const h = harness(async () =>
    snapshot([
      station('a', 59.91, 10.75, 'Oslo Sentrum'),
      station('b', 59.915, 10.76, null),
    ]),
  );
  try {
    await h.layer.update();
    h.click('ev-charging:a');
    assert.equal(h.selected?.id, 'ev-charging:a');
    const entity = h.added[0].entities.getById('ev-charging:a');
    assert.equal(entity.gevLabelModel.title, 'Oslo Sentrum');
    assert.deepEqual(entity.gevLabelModel.details, [
      'EV CHARGING · OSM MAPPED',
      '59.91000°N 10.75000°E',
      '© OpenStreetMap contributors',
    ]);
    assert.equal(entity.point.pixelSize.getValue(), 13);
    // The card leads to the cached floor, not to sea level.
    const anchor = Cesium.Cartographic.fromCartesian(
      entity.gevDisplayPosition(),
    );
    assert.ok(Math.abs(anchor.height - 12) < 1e-6);
    h.click('ev-charging:b');
    const unnamed = h.added[0].entities.getById('ev-charging:b');
    assert.equal(unnamed.gevLabelModel.title, 'EV charging station');
    assert.equal(entity.point.pixelSize.getValue(), 9, 'the first is released');
    h.click(null);
    assert.equal(h.selected, null);
    assert.equal(unnamed.point.pixelSize.getValue(), 9);
  } finally {
    h.layer.destroy();
    h.restore();
  }
});

test('a read without the selected station closes its card', async () => {
  // Flying from one city to another replaces every record; a card left on
  // the shared selection would point at a station no longer drawn.
  let reads = 0;
  const h = harness(async () =>
    snapshot(
      (reads += 1) === 1
        ? [station('a', 52.37, 4.89, 'Amsterdam')]
        : [station('b', 10.78, 106.7, 'Saigon')],
    ),
  );
  try {
    await h.layer.update();
    h.click('ev-charging:a');
    assert.equal(h.selected?.id, 'ev-charging:a');
    await h.layer.update();
    assert.equal(h.selected, null);
    assert.equal(
      h.added[0].entities.getById('ev-charging:b').point.pixelSize.getValue(),
      9,
    );
  } finally {
    h.layer.destroy();
    h.restore();
  }
});

test('another layer taking the selection releases this one', async () => {
  const h = harness(async () => snapshot([station('a')]));
  try {
    await h.layer.update();
    h.click('ev-charging:a');
    h.selected = { id: 'flight:abc', layerId: 'flights' };
    globalThis.window.dispatchEvent(new Event('gev:entity-selected'));
    const entity = h.added[0].entities.getById('ev-charging:a');
    assert.equal(entity.point.pixelSize.getValue(), 9);
  } finally {
    h.layer.destroy();
    h.restore();
  }
});

test('SHOW NEAREST selects the closest loaded station and flies to it', async () => {
  const h = harness(async () =>
    snapshot([station('far', 59.92, 10.77), station('near', 59.9101, 10.7501)]),
  );
  try {
    await h.layer.update();
    const [chip] = h.layer.getRowControls().chips;
    assert.equal(chip.label, 'SHOW NEAREST');
    assert.equal(chip.disabled, false);
    assert.equal(chip.onClick(), true);
    assert.equal(h.selected?.id, 'ev-charging:near');
    assert.equal(h.flights.length, 1);
    h.viewer.trackedEntity = {};
    assert.equal(h.layer.getRowControls().chips[0].disabled, true);
  } finally {
    h.layer.destroy();
    h.restore();
  }
});

test('destroy releases the data source, listeners, pick owner and source cache', async () => {
  const h = harness(async () => snapshot([station('a')]));
  try {
    await h.layer.update();
    assert.equal(h.viewer.camera.moveEnd.numberOfListeners, 1);
    h.layer.destroy();
    assert.equal(h.added.length, 0);
    assert.equal(h.viewer.camera.moveEnd.numberOfListeners, 0);
    assert.equal(h.owners.size, 0);
    assert.equal(h.contexts.size, 0);
    assert.equal(h.credits.size, 0);
    assert.equal(h.destroyed, 1);
    // A fresh init on the same layer is allowed after destroy.
    h.layer.init(h.viewer);
    assert.equal(h.added.length, 1);
    h.layer.destroy();
  } finally {
    h.restore();
  }
});

/** A trimmed Open Charge Map site as the proxy returns it. */
const ocmSite = (id, latitude, longitude, extra = {}) => ({
  id,
  latitude,
  longitude,
  title: `OCM ${id}`,
  operator: 'Charge & Drive (Fortum - NO)',
  address: 'Jernbanetorget 1, Oslo',
  status: { id: 50, operational: true },
  lastStatusUpdate: Date.UTC(2026, 5, 22),
  connections: [
    { type: 'Type 2 (Socket Only)', powerKw: 22, quantity: 4, status: null },
    { type: 'CCS (Type 2)', powerKw: 150, quantity: null, status: null },
    { type: 'Type 2 (Socket Only)', powerKw: 22, quantity: 2, status: null },
    { type: 'CCS (Type 2)', powerKw: 150, quantity: null, status: null },
    { type: null, powerKw: null, quantity: null, status: null },
    { type: 'CHAdeMO', powerKw: 50, quantity: 1, status: null },
    { type: 'Tesla (Model S/X)', powerKw: 120, quantity: 1, status: null },
  ],
  numberOfPoints: 8,
  usageCost: 'NOK 4/kWh',
  provider: {
    id: 1,
    name: 'Open Charge Map Contributors',
    licence: 'CC BY 4.0',
    licenceText: 'CC BY 4.0',
    url: 'http://openchargemap.org/',
  },
  ...extra,
});
const enrichment = (extra = {}) => ({
  source: 'ocm',
  error: null,
  matched: 1,
  added: 1,
  saturated: false,
  stale: false,
  ...extra,
});

test('without a key the layer, its row and its card are what they were', async () => {
  // The real source over the same injected tiles, once without an Open Charge
  // Map client and once with one whose local server has no key.
  const tileFetchImpl = async (url) => {
    if (url === 'https://tiles.openfreemap.org/planet')
      return Response.json({ tiles: [POI_TEMPLATE] });
    const [z, x, y] = url
      .match(/(\d+)\/(\d+)\/(\d+)\.pbf$/)
      .slice(1)
      .map(Number);
    const box = tileToBBox(z, x, y);
    return new Response(
      encodePoiTile({ z, x, y }, [
        {
          lon: (box.west + box.east) / 2,
          lat: (box.south + box.north) / 2,
          class: 'fuel',
          subclass: 'charging_station',
          name: `Station ${x}/${y}`,
        },
      ]),
    );
  };
  const ocmCalls = [];
  const sources = [
    createChargingSource({ tileFetchImpl }),
    createChargingSource({
      tileFetchImpl,
      ocm: createOpenChargeMapClient({
        fetchImpl: async (url) => {
          ocmCalls.push(url);
          return url === '/api/ocm/status'
            ? Response.json({ hasKey: false })
            : Response.json({ error: 'no_key' }, { status: 503 });
        },
      }),
    }),
  ];
  const views = [];
  for (const source of sources) {
    const h = harness((box, options) => source.getStations(box, options));
    try {
      await h.layer.update();
      await h.layer.update();
      const [first] = h.entities();
      h.click(first.id);
      const { lastUpdate, ...stats } = h.layer.getStats();
      assert.ok(lastUpdate > 0);
      const { chips, legend } = h.layer.getRowControls();
      views.push({
        ids: h.entities().map((entity) => entity.id),
        stats,
        legend,
        chip: chips.map(({ onClick, ...chip }) => chip),
        card: first.gevLabelModel,
        selected: h.selected?.id,
        source: h.contexts.get(first.id).source,
        credits: [...h.credits],
        dynamicCredits: h.dynamicCredits.length,
      });
    } finally {
      h.layer.destroy();
      h.restore();
    }
  }
  assert.ok(views[0].ids.length > 0);
  assert.deepEqual(views[1], views[0]);
  assert.equal(views[0].stats.source, undefined);
  assert.equal(views[0].legend.length, 1);
  assert.equal(views[0].card.details[0], 'EV CHARGING · OSM MAPPED');
  assert.equal(views[0].dynamicCredits, 0);
  // One status question for the session, and never a POI read.
  assert.deepEqual(ocmCalls, ['/api/ocm/status']);
});

test('an enriched station card adds connectors, power, status, operator and the OCM credit', async () => {
  const h = harness(async () => ({
    ...snapshot([
      {
        ...station('a', 59.91, 10.75, 'Oslo S P-hus'),
        ocm: ocmSite(68766, 59.9101, 10.7501),
      },
      {
        id: 'ev-charging:ocm:46188',
        name: 'Filmmuseet, Oslo',
        latitude: 59.90947,
        longitude: 10.74532,
        origin: 'ocm',
        ocm: ocmSite(46188, 59.90947, 10.74532, {
          operator: null,
          address: 'Dronningens gate 13, OSLO',
          status: null,
          connections: [
            {
              type: 'CEE 7/4 - Schuko - Type F',
              powerKw: 3.7,
              quantity: null,
              status: null,
            },
          ],
          numberOfPoints: 2,
          usageCost: null,
          provider: {
            id: 19,
            name: 'NOBIL',
            licence: 'CC BY 4.0',
            licenceText: 'NOBIL by Enova is licensed under CC BY 4.0',
            url: 'https://nobil.no/',
          },
        }),
      },
    ]),
    enrichment: enrichment(),
  }));
  try {
    await h.layer.update();
    h.click('ev-charging:a');
    const matched = h.added[0].entities.getById('ev-charging:a');
    // The OpenStreetMap name and position stay; OCM adds the detail.
    assert.equal(matched.gevLabelModel.title, 'Oslo S P-hus');
    assert.deepEqual(matched.gevLabelModel.details, [
      'EV CHARGING · OSM MAPPED · OPEN CHARGE MAP',
      'Charge & Drive (Fortum - NO)',
      'Operational · updated 2026-06-22',
      '6× Type 2 (Socket Only) 22 kW',
      '2× CCS (Type 2) 150 kW',
      'Connector',
      '+2 more connector types',
      '8 charge points',
      'Cost: NOK 4/kWh',
      '59.91000°N 10.75000°E',
      '© OpenStreetMap contributors',
      '© Open Charge Map contributors · CC BY 4.0',
    ]);
    assert.equal(matched.gevLabelModel.accent, '#9dff5c');

    h.click('ev-charging:ocm:46188');
    const added = h.added[0].entities.getById('ev-charging:ocm:46188');
    assert.equal(added.gevLabelModel.title, 'Filmmuseet, Oslo');
    assert.deepEqual(added.gevLabelModel.details, [
      'EV CHARGING · OPEN CHARGE MAP',
      'Dronningens gate 13, OSLO',
      'CEE 7/4 - Schuko - Type F 3.7 kW',
      '2 charge points',
      '59.90947°N 10.74532°E',
      'NOBIL via Open Charge Map · CC BY 4.0',
    ]);
    // An OCM-only site is amber and names Open Charge Map as its source.
    assert.equal(added.gevLabelModel.accent, '#ffb347');
    assert.equal(
      h.contexts.get('ev-charging:ocm:46188').source,
      'Open Charge Map',
    );
    h.click();
    assert.equal(added.point.color.getValue().toCssHexString(), '#ffb347');
    // Each provider shown is credited in the attribution popover.
    assert.deepEqual(
      h.dynamicCredits.map((credit) => credit.key),
      ['ocm-1', 'ocm-19'],
    );

    const stats = h.layer.getStats();
    assert.equal(stats.source, 'OpenStreetMap + Open Charge Map');
    assert.equal(stats.error, null);
    assert.equal(layerFeedState(stats), 'nominal');
    const legend = h.layer.getRowControls().legend;
    assert.deepEqual(
      legend.map(({ label, count, color }) => [label, count, color]),
      [
        ['Charging stations', 1, '#9dff5c'],
        ['Open Charge Map only', 1, '#ffb347'],
      ],
    );
  } finally {
    h.layer.destroy();
    h.restore();
  }
});

test('a failed Open Charge Map read keeps the stations and reports the fixed form', async () => {
  const h = harness(async () => ({
    ...snapshot([station('a'), station('b', 59.915, 10.76)]),
    enrichment: enrichment({
      error: 'Open Charge Map HTTP 403',
      matched: 0,
      added: 0,
    }),
  }));
  try {
    assert.equal(await h.layer.update(), true);
    assert.equal(h.entities().length, 2);
    const stats = h.layer.getStats();
    assert.equal(stats.status, 'ready');
    assert.equal(stats.stale, false);
    assert.equal(stats.error, 'Open Charge Map HTTP 403');
    // Stations are shown, the enrichment is missing: degraded, not down.
    assert.equal(layerFeedState(stats), 'degraded');
    h.click('ev-charging:a');
    assert.equal(
      h.added[0].entities.getById('ev-charging:a').gevLabelModel.details[0],
      'EV CHARGING · OSM MAPPED',
    );
  } finally {
    h.layer.destroy();
    h.restore();
  }
});

test('only Open Charge Map sites in view keep the OpenStreetMap credit off', async () => {
  const h = harness(async () => ({
    ...snapshot([
      {
        id: 'ev-charging:ocm:1',
        name: 'OCM 1',
        latitude: 59.91,
        longitude: 10.75,
        origin: 'ocm',
        ocm: ocmSite(1, 59.91, 10.75),
      },
    ]),
    enrichment: enrichment({ matched: 0 }),
  }));
  try {
    await h.layer.update();
    assert.equal(h.credits.has('ev-charging'), false);
    assert.equal(h.layer.getStats().count, 1);
  } finally {
    h.layer.destroy();
    h.restore();
  }
});
