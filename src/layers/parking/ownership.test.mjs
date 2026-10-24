import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import {
  createParkingLayer,
  parkingCardDetails,
  PARKING_POLL_MS,
} from './index.js';
import { layerFeedState } from '../../data/feedState.js';

const READ_AT = Date.UTC(2026, 9, 24, 2, 12);
/** A live garage unless `extra` says otherwise. */
const site = (id, extra = {}) => ({
  id: `parking:${id}`,
  siteId: Number(String(id).replace(/\D/g, '')) || 1,
  sourceId: 64,
  name: id,
  operator: null,
  address: null,
  type: 'UNDERGROUND',
  latitude: 48.776,
  longitude: 9.18,
  capacity: 200,
  free: 120,
  liveCapacity: 200,
  updatedAt: READ_AT,
  disabled: null,
  charging: null,
  url: null,
  contributor: null,
  ...extra,
});
const snapshot = (records, extra = {}) => ({
  records,
  zoomIn: false,
  partial: false,
  saturated: false,
  observedAt: READ_AT,
  ...extra,
});

/**
 * The real layer and Cesium entities over a viewer stand-in. Only the canvas,
 * the view rectangle, picking and the shared context store are substituted.
 */
function harness(getSites) {
  const originals = {
    window: globalThis.window,
    document: globalThis.document,
  };
  globalThis.window = new EventTarget();
  globalThis.document = { addEventListener() {}, removeEventListener() {} };
  const added = [];
  const credits = [];
  const owners = new Map();
  const contexts = new Map();
  const opened = [];
  const refreshed = [];
  let selected = null;
  let picked;
  let click = null;
  let destroyed = 0;
  const flights = [];
  const viewer = {
    trackedEntity: null,
    camera: {
      moveEnd: new Cesium.Event(),
      positionWC: Cesium.Cartesian3.fromDegrees(9.18, 48.776, 2000),
      heading: 0,
      computeViewRectangle: () =>
        Cesium.Rectangle.fromDegrees(9.15, 48.76, 9.2, 48.79),
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
  const layer = createParkingLayer({
    source: {
      getSites,
      destroy: () => destroyed++,
      label: 'MobiData BW · ParkAPI',
      attribution: { description: 'MobiData BW · ParkAPI, dl-de/by-2-0' },
    },
    openLink: (url) => opened.push(url),
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
        PARKING_CREDIT: { key: 'mobidata-bw-parkapi', html: 'credit' },
        registerDynamicCredit: (_viewer, credit) => credits.push(credit.key),
      },
      readout: { refreshTrackedReadout: (entity) => refreshed.push(entity.id) },
      groundFloor: { cachedGroundFloor: () => 245 },
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
    owners,
    contexts,
    flights,
    opened,
    refreshed,
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
    entity: (id) => added[0].entities.getById(id),
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

const css = (entity) => entity.point.color.getValue().toCssHexString();

test('the layer requires a parking-site source', () => {
  assert.throws(() => createParkingLayer(), /parking-site source/);
});

test('a read renders one marker per site, coloured by its free share', async () => {
  const h = harness(async () =>
    snapshot([
      site('plenty', { free: 150 }),
      site('filling', { free: 30 }),
      site('full', { free: 3 }),
      site('static', { free: null, liveCapacity: null, updatedAt: null }),
    ]),
  );
  try {
    assert.equal(await h.layer.update(), true);
    assert.equal(h.entities().length, 4);
    assert.equal(css(h.entity('parking:plenty')), '#3ddc84');
    assert.equal(css(h.entity('parking:filling')), '#ffb02e');
    assert.equal(css(h.entity('parking:full')), '#ff4d4f');
    assert.equal(css(h.entity('parking:static')), '#9aa4ad');
    const stats = h.layer.getStats();
    assert.equal(stats.count, 4);
    assert.equal(stats.countLabel, '4 sites · 3 live');
    assert.equal(stats.status, 'ready');
    assert.equal(stats.observedAt, READ_AT);
    assert.equal(layerFeedState(stats), 'nominal');
    assert.deepEqual(h.credits, ['mobidata-bw-parkapi']);
    assert.equal(h.owners.get('parking')('parking:plenty'), true);
    assert.deepEqual(
      h.layer.getRowControls().legend.map((entry) => entry.count),
      [1, 1, 1, 1],
    );
  } finally {
    h.layer.destroy();
    h.restore();
  }
});

test('an empty read outside coverage says so honestly', async () => {
  const h = harness(async () => snapshot([], { observedAt: null }));
  try {
    assert.equal(await h.layer.update(), true);
    const stats = h.layer.getStats();
    assert.equal(stats.status, 'empty');
    assert.equal(stats.countLabel, '0 sites');
    assert.equal(stats.loadingLabel, 'No ParkAPI coverage in this view');
    assert.equal(layerFeedState(stats), 'nominal');
    assert.deepEqual(h.credits, []);
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
    return snapshot([site('a')]);
  });
  try {
    const pending = h.layer.update();
    h.layer.disable();
    assert.equal(seen.aborted, true, 'disable aborts the request in flight');
    release();
    assert.equal(await pending, false);
    assert.equal(h.entities().length, 0);
    assert.equal(h.layer.getStats().count, 0);
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
    releases[1](snapshot([site('new')]));
    releases[0](snapshot([site('old')]));
    assert.equal(await older, false);
    assert.equal(await newer, true);
    assert.deepEqual(
      h.entities().map((entity) => entity.id),
      ['parking:new'],
    );
  } finally {
    h.layer.destroy();
    h.restore();
  }
});

test('a view too wide to read asks to zoom in and clears the markers', async () => {
  let reply = snapshot([site('a')]);
  const h = harness(async () => reply);
  try {
    await h.layer.update();
    h.click('parking:a');
    reply = snapshot([], { zoomIn: true, observedAt: null });
    await h.layer.update();
    assert.equal(h.selected, null, 'the card closes with its marker');
    const stats = h.layer.getStats();
    assert.equal(stats.status, 'zoom-in');
    assert.equal(stats.count, 0);
    assert.equal(stats.countLabel, '');
    assert.equal(stats.observedAt, null);
    assert.equal(stats.loadingLabel, 'Zoom in to load parking sites');
    assert.equal(layerFeedState(stats), 'nominal');
    assert.equal(h.entities().length, 0);
  } finally {
    h.layer.destroy();
    h.restore();
  }
});

test('a failed refresh keeps earlier sites as stale; with none it is unavailable', async () => {
  let fail = false;
  const h = harness(async () => {
    if (fail) throw new Error('ParkAPI HTTP 503');
    return snapshot([site('a')]);
  });
  try {
    await h.layer.update();
    fail = true;
    assert.equal(await h.layer.update(), false);
    let stats = h.layer.getStats();
    assert.equal(stats.stale, true);
    assert.equal(stats.status, 'stale');
    assert.equal(stats.error, 'ParkAPI HTTP 503');
    assert.equal(stats.count, 1, 'the markers stay');
    assert.equal(layerFeedState(stats), 'stale');
    assert.equal(stats.loadingLabel, 'Showing cached locations');
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
    throw new Error('ParkAPI network error');
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

test('a capped read says so', async () => {
  const h = harness(async () => snapshot([site('a')], { saturated: true }));
  try {
    await h.layer.update();
    const stats = h.layer.getStats();
    assert.equal(stats.saturated, true);
    assert.equal(stats.loadingLabel, 'Coverage limited — zoom in');
  } finally {
    h.layer.destroy();
    h.restore();
  }
});

test('a click opens the card with the live count, type and restrictions', async () => {
  const h = harness(async () =>
    snapshot([
      site('a', {
        name: 'LBBW (Hbf.)',
        free: 992,
        capacity: 1290,
        liveCapacity: 1280,
        updatedAt: Date.now() - 4 * 60_000,
        disabled: 12,
        charging: 1,
        operator: 'Stuttgarter Parkraum GmbH',
        address: 'Heilbronner Straße 9, 70173 Stuttgart',
        contributor: 'Stadt Stuttgart',
      }),
      site('b', {
        name: null,
        type: 'OFF_STREET_PARKING_GROUND',
        free: null,
        liveCapacity: null,
        updatedAt: null,
        capacity: 40,
      }),
    ]),
  );
  try {
    await h.layer.update();
    h.click('parking:a');
    assert.equal(h.selected?.id, 'parking:a');
    const entity = h.entity('parking:a');
    assert.equal(entity.gevLabelModel.title, 'LBBW (Hbf.)');
    assert.deepEqual(entity.gevLabelModel.details, [
      'PARKING · UNDERGROUND GARAGE',
      '992 FREE OF 1,280',
      'LIVE · UPDATED 4M AGO',
      '12 DISABLED SPACES · 1 CHARGING SPACE',
      'Stuttgarter Parkraum GmbH',
      'Heilbronner Straße 9, 70173 Stuttgart',
      'MobiData BW · ParkAPI, dl-de/by-2-0 · Stadt Stuttgart',
    ]);
    assert.equal(css(entity), '#ffffff');
    // The card leads to the cached floor, not to sea level.
    const anchor = Cesium.Cartographic.fromCartesian(
      entity.gevDisplayPosition(),
    );
    assert.ok(Math.abs(anchor.height - 245) < 1e-6);
    h.click('parking:b');
    const unnamed = h.entity('parking:b');
    assert.equal(unnamed.gevLabelModel.title, 'Parking site');
    assert.deepEqual(unnamed.gevLabelModel.details, [
      'PARKING · SURFACE CAR PARK',
      '40 SPACES · NO LIVE COUNT',
      'MobiData BW · ParkAPI, dl-de/by-2-0',
    ]);
    assert.equal(css(entity), '#3ddc84', 'the first is released');
    h.click(null);
    assert.equal(h.selected, null);
    assert.equal(css(unnamed), '#9aa4ad');
  } finally {
    h.layer.destroy();
    h.restore();
  }
});

test('a site without a known capacity says only that it has no live count', () => {
  assert.deepEqual(
    parkingCardDetails(
      site('x', {
        type: 'OTHER',
        capacity: null,
        free: null,
        liveCapacity: null,
        updatedAt: null,
      }),
    ),
    ['PARKING', 'NO LIVE COUNT', 'MobiData BW · ParkAPI, dl-de/by-2-0'],
  );
});

test('a poll that keeps the selected site refreshes its card in place', async () => {
  let free = 120;
  const h = harness(async () => snapshot([site('a', { free })]));
  try {
    await h.layer.update();
    h.click('parking:a');
    free = 4;
    await h.layer.update();
    const entity = h.entity('parking:a');
    assert.equal(h.selected?.id, 'parking:a');
    assert.equal(entity.gevLabelModel.details[1], '4 FREE OF 200');
    assert.deepEqual(h.refreshed, ['parking:a']);
    assert.equal(css(entity), '#ffffff', 'still drawn as selected');
  } finally {
    h.layer.destroy();
    h.restore();
  }
});

test('a read without the selected site closes its card', async () => {
  // Flying from one city to another replaces every record; a card left on
  // the shared selection would point at a site no longer drawn.
  let reads = 0;
  const h = harness(async () =>
    snapshot(
      (reads += 1) === 1
        ? [site('a', { name: 'Stuttgart' })]
        : [site('b', { latitude: 49.01, longitude: 8.4, name: 'Karlsruhe' })],
    ),
  );
  try {
    await h.layer.update();
    h.click('parking:a');
    assert.equal(h.selected?.id, 'parking:a');
    await h.layer.update();
    assert.equal(h.selected, null);
    assert.equal(css(h.entity('parking:b')), '#3ddc84');
  } finally {
    h.layer.destroy();
    h.restore();
  }
});

test('another layer taking the selection releases this one', async () => {
  const h = harness(async () => snapshot([site('a')]));
  try {
    await h.layer.update();
    h.click('parking:a');
    h.selected = { id: 'flight:abc', layerId: 'flights' };
    globalThis.window.dispatchEvent(new Event('gev:entity-selected'));
    assert.equal(css(h.entity('parking:a')), '#3ddc84');
  } finally {
    h.layer.destroy();
    h.restore();
  }
});

test('SHOW NEAREST selects the closest loaded site and flies to it', async () => {
  const h = harness(async () =>
    snapshot([
      site('far', { latitude: 48.79, longitude: 9.2 }),
      site('near', { latitude: 48.7761, longitude: 9.1801 }),
    ]),
  );
  try {
    await h.layer.update();
    const [chip] = h.layer.getRowControls().chips;
    assert.equal(chip.label, 'SHOW NEAREST');
    assert.equal(chip.disabled, false);
    assert.equal(chip.onClick(), true);
    assert.equal(h.selected?.id, 'parking:near');
    assert.equal(h.flights.length, 1);
    h.viewer.trackedEntity = {};
    assert.equal(h.layer.getRowControls().chips[0].disabled, true);
  } finally {
    h.layer.destroy();
    h.restore();
  }
});

test('OPERATOR PAGE opens only the selected site’s published link', async () => {
  const h = harness(async () =>
    snapshot([
      site('a', { url: 'https://example.org/garage' }),
      site('b', { url: null }),
    ]),
  );
  try {
    await h.layer.update();
    const page = () => h.layer.getRowControls().chips[1];
    assert.equal(page().disabled, true, 'nothing selected');
    h.click('parking:b');
    assert.equal(page().disabled, true, 'no published page');
    h.click('parking:a');
    assert.equal(page().disabled, false);
    assert.equal(page().onClick(), true);
    assert.deepEqual(h.opened, ['https://example.org/garage']);
  } finally {
    h.layer.destroy();
    h.restore();
  }
});

test('the layer re-reads free counts on its own poll until disabled', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let reads = 0;
  const h = harness(async () => {
    reads += 1;
    return snapshot([site('a', { free: 100 - reads })]);
  });
  try {
    await h.layer.update();
    assert.equal(reads, 1);
    t.mock.timers.tick(PARKING_POLL_MS);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(reads, 2);
    assert.equal(h.layer.getStats().count, 1);
    h.layer.disable();
    t.mock.timers.tick(PARKING_POLL_MS * 2);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(reads, 2, 'no poll after disable');
    // Re-enabling runs one poll, not the old one beside a new one.
    h.layer.enable();
    t.mock.timers.tick(PARKING_POLL_MS);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(reads, 3);
    // The manager ticks the row itself only for a layer without an interval.
    assert.equal(h.layer.updateInterval, 0);
  } finally {
    h.layer.destroy();
    h.restore();
  }
});

test('destroy releases the data source, listeners, pick owner and source cache', async () => {
  const h = harness(async () => snapshot([site('a')]));
  try {
    await h.layer.update();
    assert.equal(h.viewer.camera.moveEnd.numberOfListeners, 1);
    h.layer.destroy();
    assert.equal(h.added.length, 0);
    assert.equal(h.viewer.camera.moveEnd.numberOfListeners, 0);
    assert.equal(h.owners.size, 0);
    assert.equal(h.contexts.size, 0);
    assert.equal(h.destroyed, 1);
    // A fresh init on the same layer is allowed after destroy.
    h.layer.init(h.viewer);
    assert.equal(h.added.length, 1);
    h.layer.destroy();
  } finally {
    h.restore();
  }
});
