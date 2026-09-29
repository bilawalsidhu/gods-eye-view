import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { CZIB_LIST_URL, createCzibLayer, czibLabelTitle } from './index.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 29);

const bulletin = (id, title, countries, extra = {}) => {
  const area = title.replace(/^Airspace of (?:the )?/, '');
  return {
    id,
    number: `CZIB-2026-${id.padStart(2, '0')}`,
    title,
    area,
    partial: /\s[–—-]\s/.test(area),
    status: 'active',
    countries,
    issuedMs: NOW - 30 * DAY,
    revisedMs: NOW - Number(id) * DAY,
    validUntilMs: NOW + 30 * DAY,
    validity: '31/10/2026, unless reviewed earlier.',
    url: `${CZIB_LIST_URL}/czib-2026-${id.padStart(2, '0')}`,
    ...extra,
  };
};

const MALI = bulletin('1', 'Airspace of Mali', ['Mali']);
const GULF = bulletin('2', 'Airspace of the Persian Gulf', ['Qatar', 'Oman']);
const YEMEN = bulletin('3', 'Airspace of Yemen – Sana’a FIR', ['Yemen']);
const OLD = bulletin('4', 'Airspace of Kenya', ['Kenya'], {
  status: 'withdrawn',
});

/** A square country of `size` degrees; Oman has an exclave. */
function square(lon, lat, size = 4) {
  return [
    [lon, lat],
    [lon + size, lat],
    [lon + size, lat + size],
    [lon, lat + size],
  ];
}
const AREAS = {
  Mali: { lon: -4, lat: 17, polygons: [[square(-6, 15)]] },
  Qatar: { lon: 51, lat: 25, polygons: [[square(50, 24, 2)]] },
  Oman: {
    lon: 57,
    lat: 21,
    polygons: [[square(55, 19)], [square(56, 26, 1)]],
  },
  Yemen: {
    lon: 47,
    lat: 15,
    // A hole, to check that inner rings reach the hierarchy.
    polygons: [[square(44, 13), square(45, 14, 1)]],
  },
};

function resolver(calls = [], { fail = () => false } = {}) {
  return async (name) => {
    calls.push(name);
    if (fail(name)) throw new Error('boundaries');
    const area = AREAS[name];
    return area
      ? {
          id: `ne:${name}`,
          name,
          polygons: area.polygons,
          areaKm2: 100_000,
          label: { lon: area.lon, lat: area.lat },
        }
      : null;
  };
}

function harness(
  getSnapshot,
  {
    picking = null,
    reducedMotion = false,
    resolveCountry = resolver(),
    now = () => NOW,
  } = {},
) {
  const sources = [];
  const flights = [];
  const opened = [];
  const handlers = [];
  let picked;
  const overlay = {
    entries: new Map(),
    visible: new Map(),
    setEntries(sourceId, entries, options) {
      assert.equal(sourceId, 'easa-czib');
      assert.equal(options.moving, false);
      overlay.entries.set(sourceId, entries);
    },
    setVisible(sourceId, visible) {
      overlay.visible.set(sourceId, visible);
    },
    clearSource(sourceId) {
      overlay.entries.delete(sourceId);
    },
  };
  class FakeHandler {
    constructor(canvas) {
      this.canvas = canvas;
      this.actions = new Map();
      this.destroyed = false;
      handlers.push(this);
    }
    setInputAction(callback, type) {
      this.actions.set(type, callback);
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyed = true;
    }
  }
  const viewer = {
    dataSources: {
      add(value) {
        sources.push(value);
      },
      remove(value) {
        sources.splice(sources.indexOf(value), 1);
      },
    },
    camera: {
      flyTo(options) {
        flights.push(options);
      },
    },
    scene: { canvas: {}, requestRender() {}, pick: () => picked },
  };
  const layer = createCzibLayer({
    source: { getSnapshot },
    cesium: { ...Cesium, ScreenSpaceEventHandler: FakeHandler },
    now,
    resolveCountry,
    matchMedia: () => ({ matches: reducedMotion }),
    openExternal: (url) => opened.push(url),
    picking,
    pointer: { isPointerFree: () => true },
    overlayHost: overlay,
  });
  layer.init(viewer);
  return {
    layer,
    overlay,
    labels: () =>
      (overlay.entries.get('easa-czib') || []).map(
        ({ id, title, protected: active }) => [id, title, active],
      ),
    entities: () => sources[0]?.entities.values ?? [],
    sources,
    flights,
    opened,
    handlers,
    click(pick) {
      picked = pick;
      handlers.at(-1).actions.get(Cesium.ScreenSpaceEventType.LEFT_CLICK)({
        position: new Cesium.Cartesian2(1, 1),
      });
    },
  };
}

function fakePicking() {
  const owners = new Map();
  return {
    owners,
    registerPickOwner(id, predicate) {
      owners.set(id, predicate);
    },
    unregisterPickOwner(id) {
      owners.delete(id);
    },
    resolvePickId: (picked) => picked?.id?.id ?? picked?.id ?? null,
    isOwnedByOtherLayer: (layerId, pickedId) =>
      [...owners].some(([id, owns]) => id !== layerId && owns(pickedId)),
  };
}

const snapshot =
  (bulletins, extra = {}) =>
  async () => ({ bulletins, linksMissing: false, stale: false, ...extra });

test('the layer requires a snapshot source and cannot be initialized twice', () => {
  assert.throws(() => createCzibLayer({}), TypeError);
  const { layer } = harness(snapshot([]));
  assert.throws(() => layer.init({ dataSources: { add() {} } }), /already/);
});

test('an enabled refresh shades each named country of every active bulletin', async () => {
  const calls = [];
  const { layer, sources, overlay, labels, entities } = harness(
    snapshot([MALI, GULF, YEMEN, OLD]),
    { resolveCountry: resolver(calls) },
  );
  assert.equal(overlay.visible.get('easa-czib'), false);
  assert.equal(await layer.update(), false, 'disabled layers do not fetch');
  layer.enable();
  assert.equal(sources[0].show, true);
  assert.equal(overlay.visible.get('easa-czib'), true);
  assert.equal(await layer.update(), true);
  assert.deepEqual(
    calls.sort(),
    ['Mali', 'Oman', 'Qatar', 'Yemen'],
    'withdrawn bulletins are not resolved',
  );
  assert.deepEqual(
    entities().map(({ id }) => id),
    [
      'easa-czib:1:ne:Mali:0',
      'easa-czib:2:ne:Qatar:0',
      'easa-czib:2:ne:Oman:0',
      'easa-czib:2:ne:Oman:1',
      'easa-czib:3:ne:Yemen:0',
    ],
  );
  const yemen = entities().at(-1);
  assert.equal(yemen.polygon.hierarchy.getValue().holes.length, 1);
  assert.equal(
    yemen.polygon.classificationType.getValue(),
    Cesium.ClassificationType.BOTH,
  );
  assert.ok(
    yemen.polyline.material instanceof Cesium.PolylineDashMaterialProperty,
    'a part-country bulletin is dashed',
  );
  assert.ok(
    entities()[0].polyline.material instanceof Cesium.ColorMaterialProperty,
  );
  assert.deepEqual(labels(), [
    ['1', 'Mali', false],
    ['2', 'Persian Gulf', false],
    ['3', 'Yemen (part)', false],
  ]);
  const [label] = overlay.entries.get('easa-czib');
  assert.equal(label.variant, 'label');
  assert.equal(label.horizonCull, true);
  assert.equal(label.interactive, false);
  const controls = layer.getRowControls();
  assert.deepEqual(
    controls.legend.map(({ label, count }) => [label, count]),
    [
      ['Whole country named', 2],
      ['Part of a country (dashed)', 1],
    ],
  );
  assert.match(controls.legend[0].blurb, /not the exact airspace/);
  assert.match(controls.infoTitle, /Dashed outlines/);
  assert.deepEqual(
    controls.list.items.map(({ lead, text, params }) => [lead, text, params]),
    [
      ['', 'Mali · 2026-01', { bulletinId: '1', focus: true }],
      [
        '',
        'Persian Gulf · 2026-02 · 2 countries',
        { bulletinId: '2', focus: true },
      ],
      ['', 'Yemen – Sana’a FIR · 2026-03', { bulletinId: '3', focus: true }],
    ],
  );
  assert.deepEqual(controls.chips, []);
  assert.equal(
    controls.info,
    '3 active bulletins · 4 countries named · Shading marks the countries named, not the exact airspace',
  );
  assert.deepEqual(layer.getStats(), {
    count: 3,
    lastUpdate: NOW,
    error: null,
    stale: false,
    partial: false,
  });
});

test('an identical snapshot neither re-resolves nor redraws', async () => {
  const calls = [];
  const { layer, entities } = harness(snapshot([MALI, GULF]), {
    resolveCountry: resolver(calls),
  });
  layer.enable();
  await layer.update();
  const [first] = entities();
  await layer.update();
  assert.equal(entities()[0], first);
  assert.equal(calls.length, 3, 'resolved countries are remembered');
});

test('unmatched countries, missing numbers, cached copies and a failed refresh are reported', async () => {
  let fail = false;
  const kenya = bulletin('5', 'Airspace of Kenya', ['Kenya']);
  const { layer, entities } = harness(async () => {
    if (fail) throw new Error('EASA CZIB HTTP 502');
    return {
      bulletins: [MALI, kenya, bulletin('6', 'Nowhere', [])],
      linksMissing: true,
      stale: true,
    };
  });
  layer.enable();
  await layer.update();
  assert.equal(
    layer.getRowControls().info,
    [
      '3 active bulletins · 2 countries named',
      'Not drawn: Kenya',
      'Bulletin numbers unavailable this refresh',
      'Showing a cached copy',
      'Shading marks the countries named, not the exact airspace',
    ].join(' · '),
  );
  assert.deepEqual(layer.getStats().partial, true);
  assert.deepEqual(layer.getStats().stale, true);
  assert.deepEqual(layer.getDiagnostics().labels, ['1']);
  layer.setParams({ bulletinId: '6' });
  assert.match(
    layer.getRowControls().info,
    /No country named; see the bulletin for its area/,
  );
  fail = true;
  assert.equal(await layer.update(), false);
  assert.equal(entities().length, 1, 'the last drawing stays');
  assert.equal(layer.getStats().error, 'EASA CZIB HTTP 502');
  layer.setParams({ clear: true });
  assert.match(
    layer.getRowControls().info,
    /Last refresh failed: EASA CZIB HTTP 502/,
  );
});

test('a boundary load failure is reported and retried on the next refresh', async () => {
  let broken = true;
  const calls = [];
  const { layer, entities } = harness(snapshot([MALI]), {
    resolveCountry: resolver(calls, { fail: () => broken }),
  });
  layer.enable();
  await layer.update();
  assert.equal(entities().length, 0);
  assert.match(
    layer.getRowControls().info,
    /Country outlines unavailable this refresh/,
  );
  assert.equal(layer.getStats().partial, true);
  broken = false;
  await layer.update();
  assert.equal(entities().length, 1);
  assert.deepEqual(calls, ['Mali', 'Mali']);
  assert.equal(layer.getStats().partial, false);
});

test('without a resolver the bulletins are listed and nothing is drawn', async () => {
  const layer = createCzibLayer({ source: { getSnapshot: snapshot([MALI]) } });
  const sources = [];
  layer.init({
    dataSources: { add: (value) => sources.push(value) },
    scene: { requestRender() {} },
  });
  layer.enable();
  assert.equal(await layer.update(), true);
  assert.equal(sources[0].entities.values.length, 0);
  assert.equal(layer.getRowControls().list.items.length, 1);
  assert.match(layer.getRowControls().info, /Not drawn: Mali/);
  assert.deepEqual(layer.getDiagnostics().labels, []);
});

test('choosing a list row selects the bulletin, moves the camera and offers the bulletin', async () => {
  const { layer, flights, opened, labels, entities } = harness(
    snapshot([MALI, GULF]),
  );
  let navigations = 0;
  layer.attachShellServices({
    runNavigation: (navigate) => {
      navigations += 1;
      return navigate();
    },
  });
  layer.enable();
  await layer.update();
  layer.setParams({ bulletinId: '2', focus: true });
  assert.equal(navigations, 1);
  assert.equal(flights.length, 1);
  assert.equal(flights[0].duration, 1.4);
  const destination = Cesium.Cartographic.fromCartesian(flights[0].destination);
  assert.equal(Math.round(Cesium.Math.toDegrees(destination.longitude)), 54);
  assert.equal(Math.round(Cesium.Math.toDegrees(destination.latitude)), 23);
  assert.equal(
    Math.round(destination.height),
    1_200_000,
    'the minimum framing height',
  );
  const selected = entities().find(({ id }) => id === 'easa-czib:2:ne:Qatar:0');
  assert.equal(selected.polyline.width.getValue(), 3);

  const controls = layer.getRowControls();
  assert.equal(controls.list.items[1].active, true);
  assert.deepEqual(
    controls.chips.map(({ id, label }) => [id, label]),
    [['bulletin', 'EASA bulletin ↗']],
  );
  assert.equal(
    controls.info,
    [
      'Airspace of the Persian Gulf',
      'CZIB-2026-02',
      'Countries named: Qatar, Oman',
      'Valid until 29 Oct 2026, unless reviewed earlier',
      'Revised 27 Sep 2026',
      'Shading marks the countries named, not the exact airspace',
    ].join(' · '),
  );
  assert.deepEqual(labels(), [
    ['2', 'Persian Gulf', true],
    ['1', 'Mali', false],
  ]);
  layer.setParams(controls.chips[0].params);
  assert.deepEqual(opened, [GULF.url]);

  layer.setParams({ bulletinId: 'nope', focus: true });
  assert.equal(
    layer.getDiagnostics().selectedId,
    '2',
    'an unknown id keeps the selection',
  );
  layer.setParams({ clear: true });
  assert.deepEqual(layer.getRowControls().chips, []);
  assert.equal(selected.polyline.width.getValue(), 1.5);
});

test('a bulletin without a page links to the EASA list; an expired one says so', async () => {
  const lapsed = bulletin('7', 'Airspace of Mali', ['Mali'], {
    url: null,
    number: '',
    validUntilMs: NOW - 2 * DAY,
  });
  const { layer, opened } = harness(snapshot([lapsed]));
  layer.enable();
  await layer.update();
  layer.setParams({ bulletinId: '7' });
  const controls = layer.getRowControls();
  assert.equal(controls.chips[0].label, 'EASA CZIBs ↗');
  assert.match(controls.info, /Validity ended 27 Sep 2026; check EASA/);
  layer.setParams({ bulletin: true });
  assert.deepEqual(opened, [CZIB_LIST_URL]);
});

test('focus honours reduced motion and does nothing without the shell', async () => {
  const quiet = harness(snapshot([MALI]), { reducedMotion: true });
  quiet.layer.attachShellServices({ runNavigation: (navigate) => navigate() });
  quiet.layer.enable();
  await quiet.layer.update();
  quiet.layer.setParams({ bulletinId: '1', focus: true });
  assert.equal(quiet.flights[0].duration, 0);

  const detached = harness(snapshot([MALI]));
  detached.layer.enable();
  await detached.layer.update();
  detached.layer.setParams({ bulletinId: '1', focus: true });
  assert.equal(detached.flights.length, 0);
  assert.equal(detached.layer.getRowControls().list.items[0].active, true);
});

test('a superseded or cancelled navigation does not fly', async () => {
  const { layer, flights } = harness(snapshot([MALI, GULF]));
  const queued = [];
  layer.attachShellServices({
    runNavigation: (navigate) => queued.push(navigate),
  });
  layer.enable();
  await layer.update();
  layer.setParams({ bulletinId: '1', focus: true });
  layer.setParams({ bulletinId: '2' });
  queued[0]();
  assert.equal(flights.length, 0);
  layer.setParams({ bulletinId: '2', focus: true });
  layer.disable();
  queued[1]();
  assert.equal(flights.length, 0);
});

test('globe clicks select owned countries, yield to sibling picks and clear on empty map', async () => {
  const picking = fakePicking();
  picking.registerPickOwner('flights', (id) => id === 'aircraft-1');
  const { layer, handlers, click, entities } = harness(snapshot([MALI, GULF]), {
    picking,
  });
  layer.enable();
  await layer.update();
  assert.equal(handlers.length, 1);
  const owns = picking.owners.get('easa-czib');
  assert.equal(owns('easa-czib:1:ne:Mali:0'), true);
  assert.equal(owns('aircraft-1'), false);

  click({ id: entities()[2] });
  assert.equal(layer.getDiagnostics().selectedId, '2');
  click({ id: 'aircraft-1' });
  assert.equal(
    layer.getDiagnostics().selectedId,
    '2',
    'sibling picks are not empty map',
  );
  click(undefined);
  assert.equal(layer.getDiagnostics().selectedId, null);

  layer.disable();
  assert.equal(handlers[0].destroyed, true);
  assert.equal(picking.owners.has('easa-czib'), false);
});

test('globe selection stays off without the application pick registry', async () => {
  const { layer, handlers } = harness(snapshot([MALI]));
  layer.enable();
  await layer.update();
  assert.equal(handlers.length, 0);
  assert.equal(layer.getDiagnostics().selectionActive, false);
});

test('globe labels shorten part-country titles to the country', () => {
  assert.equal(czibLabelTitle(MALI), 'Mali');
  assert.equal(czibLabelTitle(YEMEN), 'Yemen (part)');
  assert.equal(
    czibLabelTitle({ area: 'Egypt, North Sinai Governorate', partial: true }),
    'Egypt (part)',
  );
  const long = czibLabelTitle({ area: 'X'.repeat(60), partial: false });
  assert.equal(long.length, 40);
  assert.ok(long.endsWith('…'));
});

test('disable clears the labels and hides the overlay source', async () => {
  const { layer, overlay, labels } = harness(snapshot([MALI, GULF]));
  layer.enable();
  await layer.update();
  assert.equal(labels().length, 2);
  layer.disable();
  assert.deepEqual(labels(), []);
  assert.equal(overlay.visible.get('easa-czib'), false);
  assert.deepEqual(layer.getDiagnostics().labels, []);
  layer.enable();
  assert.equal(labels().length, 2, 'enable republishes the kept bulletins');
});

test('a vanished bulletin clears the selection, and disable aborts the request in flight', async () => {
  let pending;
  const { layer, sources } = harness(
    ({ signal }) =>
      new Promise((resolve, reject) => {
        pending = { resolve };
        signal.addEventListener('abort', () => reject(signal.reason));
      }),
  );
  layer.enable();
  let result = layer.update();
  pending.resolve({ bulletins: [MALI, GULF] });
  assert.equal(await result, true);
  layer.setParams({ bulletinId: '1' });
  result = layer.update();
  pending.resolve({ bulletins: [GULF] });
  assert.equal(await result, true);
  assert.equal(layer.getDiagnostics().selectedId, null);
  assert.deepEqual(layer.getDiagnostics().labels, ['2']);

  result = layer.update();
  layer.disable();
  assert.equal(await result, false);
  assert.equal(sources[0].show, false);
  assert.equal(layer.getStats().error, null);
});

test('destroy releases the data source and every reference', async () => {
  const { layer, sources } = harness(snapshot([MALI]));
  layer.enable();
  await layer.update();
  layer.destroy();
  assert.equal(sources.length, 0);
  assert.equal(layer.getStats().count, 0);
  assert.equal(layer.getDiagnostics().entities, 0);
});
