import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { createWorkZonesLayer } from './index.js';
import { layerFeedState } from '../../data/feedState.js';
import { WORK_ZONE_BANDS, workZoneBand } from './presentation.js';

const HOUR = 3600_000;
const now = Date.now();
const event = (id, extra = {}) => ({
  id: `mn:${id}`,
  feed: 'mn',
  type: 'work-zone',
  roads: ['I-94'],
  direction: 'eastbound',
  description: 'Bridge Construction, Head To Head Traffic On The Roadway',
  start: now - 24 * HOUR,
  end: now + 24 * HOUR,
  impact: 'all-lanes-closed',
  workers: true,
  updated: now - 2 * HOUR,
  anchor: [-93.25, 44.98],
  lines: [
    [
      [-93.2, 44.95],
      [-93.3, 45.0],
    ],
  ],
  ...extra,
});
const feed = (id, status = 'live', extra = {}) => ({
  id,
  name: { mn: 'Minnesota', ks: 'Kansas' }[id] ?? id,
  publisher: { mn: 'Minnesota DOT', ks: 'Kansas DOT' }[id] ?? id,
  status,
  count: 1,
  ageMs: 60_000,
  ...extra,
});
const snapshot = (events, feeds = [feed('mn')]) => ({
  feeds,
  events,
  ageMs: 0,
  linesDropped: 0,
});

/** The real layer and Cesium entities over a viewer stand-in. */
function harness(getSnapshot) {
  const originals = {
    window: globalThis.window,
    document: globalThis.document,
  };
  globalThis.window = new EventTarget();
  globalThis.document = { addEventListener() {}, removeEventListener() {} };
  const added = [];
  const owners = new Map();
  const contexts = new Map();
  let selected = null;
  let picked;
  let click = null;
  const viewer = {
    trackedEntity: null,
    camera: { positionWC: Cesium.Cartesian3.fromDegrees(-93.25, 44.98, 5000) },
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
  const layer = createWorkZonesLayer({
    source: { getSnapshot, label: 'WZDx · US state DOTs' },
    services: {
      render: { governorRequestRender() {} },
      picking: {
        registerPickOwner: (id, owns) => owners.set(id, owns),
        unregisterPickOwner: (id) => owners.delete(id),
      },
      context: {
        registerEntityContext: (entity, record) =>
          contexts.set(record.id, { ...record, entity }),
        removeEntityContextsForLayer(layerId) {
          for (const [id, record] of contexts)
            if (record.layerId === layerId) contexts.delete(id);
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
      groundFloor: { cachedGroundFloor: () => 250 },
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
    owners,
    contexts,
    get selected() {
      return selected;
    },
    set selected(value) {
      selected = value;
    },
    entities: () => added[0]?.entities.values ?? [],
    entity: (id) => added[0].entities.getById(id),
    click(id) {
      const entity = id ? added[0].entities.getById(id) : null;
      picked = entity ? { id: entity } : undefined;
      click({ position: new Cesium.Cartesian2() });
    },
    restore() {
      layer.destroy();
      for (const name of ['window', 'document']) {
        if (originals[name] === undefined) delete globalThis[name];
        else globalThis[name] = originals[name];
      }
    },
  };
}

test('markers and ground-clamped lines take the colour of their lane impact', async (t) => {
  const events = [
    event('closed'),
    event('open', { impact: 'all-lanes-open' }),
    event('detour', { type: 'detour', impact: null, workers: null }),
    event('point', { impact: 'flagging', lines: [] }),
  ];
  const h = harness(async () => snapshot(events));
  t.after(() => h.restore());
  assert.equal(await h.layer.update(), true);
  assert.equal(h.entities().length, 4 + 3);
  const closed = h.entity('work-zones:mn:closed');
  assert.equal(
    closed.point.heightReference.getValue(),
    Cesium.HeightReference.CLAMP_TO_GROUND,
  );
  assert.equal(
    closed.point.color.getValue().toCssHexString(),
    WORK_ZONE_BANDS[0].color,
  );
  const line = h.entity('work-zones:mn:closed|line|0');
  assert.equal(line.polyline.clampToGround.getValue(), true);
  const detourLine = h.entity('work-zones:mn:detour|line|0');
  assert.ok(
    detourLine.polyline.material instanceof Cesium.PolylineDashMaterialProperty,
  );
  // Open-lane work draws thinner and fainter than a closure.
  const openLine = h.entity('work-zones:mn:open|line|0');
  assert.ok(
    openLine.polyline.width.getValue() < line.polyline.width.getValue(),
  );
  assert.ok(
    openLine.polyline.material.color.getValue().alpha <
      line.polyline.material.color.getValue().alpha,
  );
  const legend = h.layer.getRowControls().legend;
  assert.deepEqual(
    legend.map(({ count }) => count),
    [1, 0, 1, 1, 0, 1],
  );
  assert.match(legend[0].blurb, /not traffic speed/);
  const stats = h.layer.getStats();
  assert.equal(stats.count, 4);
  assert.equal(stats.countLabel, '4 work zones');
  assert.equal(layerFeedState(stats), 'nominal');
  assert.ok(h.owners.get('work-zones')('work-zones:mn:closed|line|0'));
});

test('a click on a marker or its line opens the card; a second click closes it', async (t) => {
  const h = harness(async () => snapshot([event('a'), event('b')]));
  t.after(() => h.restore());
  await h.layer.update();
  h.click('work-zones:mn:a|line|0');
  assert.equal(h.selected?.id, 'work-zones:mn:a');
  const marker = h.entity('work-zones:mn:a');
  const card = marker.gevLabelModel;
  assert.equal(card.title, 'I-94');
  assert.deepEqual(card.details.slice(0, 2), [
    'WORK ZONE · EASTBOUND',
    'All lanes closed',
  ]);
  assert.ok(card.details.includes('Workers present'));
  assert.ok(
    card.details.some((line) => line.startsWith('Bridge Construction')),
  );
  assert.ok(card.details.some((line) => /^Updated /.test(line)));
  assert.equal(card.details.at(-1), 'Minnesota DOT · WZDx');
  assert.equal(marker.point.color.getValue().toCssHexString(), '#ffffff');
  // Lifted to the cached ground floor.
  const height = Cesium.Cartographic.fromCartesian(
    marker.gevDisplayPosition(),
  ).height;
  assert.ok(Math.abs(height - 250) < 1);
  h.click('work-zones:mn:b');
  assert.equal(h.selected?.id, 'work-zones:mn:b');
  assert.equal(
    marker.point.color.getValue().toCssHexString(),
    WORK_ZONE_BANDS[0].color,
  );
  h.click('work-zones:mn:b');
  assert.equal(h.selected, null);
  assert.equal(h.contexts.size, 0);
});

test('a refresh keeps unchanged entities and closes the card of a vanished event', async (t) => {
  let events = [event('a'), event('b')];
  const h = harness(async () => snapshot(events));
  t.after(() => h.restore());
  await h.layer.update();
  const kept = h.entity('work-zones:mn:a');
  h.click('work-zones:mn:b');
  events = [event('a'), event('c', { impact: 'some-lanes-closed' })];
  await h.layer.update();
  assert.equal(h.entity('work-zones:mn:a'), kept, 'unchanged entity reused');
  assert.equal(h.entity('work-zones:mn:b'), undefined);
  assert.equal(h.selected, null);
  assert.equal(h.layer.getStats().count, 2);
});

test('a changed selected event reopens its card on the new entities', async (t) => {
  let events = [event('a')];
  const h = harness(async () => snapshot(events));
  t.after(() => h.restore());
  await h.layer.update();
  h.click('work-zones:mn:a');
  events = [event('a', { impact: 'some-lanes-closed' })];
  await h.layer.update();
  assert.equal(h.selected?.id, 'work-zones:mn:a');
  assert.equal(
    h.entity('work-zones:mn:a').gevLabelModel.details[1],
    'Some lanes closed',
  );
});

test('failed feeds read partial; a failed refresh keeps events as stale', async (t) => {
  let mode = 'partial';
  const h = harness(async () => {
    if (mode === 'down') throw new Error('WZDx HTTP 503');
    return snapshot(
      [event('a')],
      [
        feed('mn'),
        feed('ks', 'unavailable', { count: 0, ageMs: null }),
        feed('nd', 'stale'),
      ],
    );
  });
  t.after(() => h.restore());
  await h.layer.update();
  let stats = h.layer.getStats();
  assert.equal(stats.partial, true);
  assert.equal(stats.stale, false);
  assert.equal(layerFeedState(stats), 'partial');
  assert.equal(
    h.layer.getRowControls().info,
    '1 feed live · feed nd stale · feed Kansas unreachable',
  );
  mode = 'down';
  assert.equal(await h.layer.update(), false);
  stats = h.layer.getStats();
  assert.equal(stats.stale, true);
  assert.equal(stats.error, 'WZDx HTTP 503');
  assert.equal(stats.count, 1, 'events from the last read stay up');
  assert.equal(layerFeedState(stats), 'stale');
});

test('with nothing shown a failure reads unavailable', async (t) => {
  const h = harness(async () => {
    throw new Error('WZDx HTTP 503');
  });
  t.after(() => h.restore());
  await h.layer.update();
  assert.equal(layerFeedState(h.layer.getStats()), 'unavailable');
});

test('every feed stale reads stale even when the read succeeded', async (t) => {
  const h = harness(async () =>
    snapshot([event('a')], [feed('mn', 'stale'), feed('ks', 'unavailable')]),
  );
  t.after(() => h.restore());
  await h.layer.update();
  assert.equal(layerFeedState(h.layer.getStats()), 'stale');
});

test('a response landing after disable draws nothing', async (t) => {
  let resolve;
  const h = harness(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  t.after(() => h.restore());
  const pending = h.layer.update();
  h.layer.disable();
  resolve(snapshot([event('late')]));
  assert.equal(await pending, false);
  assert.equal(h.entities().length, 0);
  assert.equal(h.owners.has('work-zones'), false);
});

test('bands: unknown and missing impacts fall back to the unreported band', () => {
  assert.equal(
    workZoneBand({ type: 'work-zone', impact: 'weird' }).id,
    'unknown',
  );
  assert.equal(workZoneBand({ type: 'detour', impact: null }).id, 'detour');
  assert.equal(
    workZoneBand({ type: 'work-zone', impact: 'some-lanes-closed-split' }).id,
    'lanes',
  );
});
