import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createSaFireIncidentsLayer } from './index.js';
import { incidentStatusColor, warningCategoryColor } from './cards.js';

const NOW = Date.UTC(2026, 9, 13, 3, 5); // 13 Oct 13:35 ACDT
const FEED = Date.UTC(2026, 9, 13, 3, 0); // 13:30 ACDT

const incident = (overrides = {}) => ({
  id: 'F2610120119',
  agency: 'CFS',
  name: 'MOUNT COMPASS',
  lat: -35.354339,
  lon: 138.626986,
  region: 'R1',
  fireBanDistrict: 'MOUNT LOFTY RANGES',
  type: 'BURN OFF',
  status: 'Going',
  level: 'L1',
  ground: 2,
  aircraft: 0,
  messageCount: 0,
  reportedTime: Date.UTC(2026, 9, 12, 9, 0),
  ...overrides,
});
// SYNTHETIC warning rows (the live warnings layers were empty).
const warning = (overrides = {}) => ({
  id: 'g:1',
  kind: 'polygon',
  category: 'Watch and Act',
  headline: 'Bushfire - Mount Compass',
  name: 'Mount Compass',
  description: 'Synthetic test warning.',
  longDescription: null,
  expiryTime: NOW + 3_600_000,
  createdTime: NOW - 3_600_000,
  editedTime: NOW - 60_000,
  incidentRef: null,
  mfsIncidentRef: null,
  link: 'https://www.cfs.sa.gov.au/example',
  lat: -35.3,
  lon: 138.7,
  polygons: [
    [
      [
        [138.6, -35.4],
        [138.8, -35.4],
        [138.8, -35.2],
        [138.6, -35.4],
      ],
    ],
  ],
  ...overrides,
});
const snapshot = (overrides = {}) => ({
  incidents: [
    incident(),
    incident({
      id: 'F2608270132',
      agency: 'MFS',
      status: 'Safe',
      level: 'L3',
      lat: -34.83,
      lon: 138.71,
    }),
  ],
  warnings: [warning()],
  warningsAvailable: true,
  incidentsFetchedAt: FEED + 1000,
  warningsFetchedAt: FEED + 1000,
  upstreamModified: FEED,
  stale: false,
  ...overrides,
});

function harness(
  getSnapshot,
  { pick = () => null, cardHit = () => null } = {},
) {
  const sources = [];
  const overlay = { entries: new Map(), visible: null, options: null };
  const clicks = { handler: null, destroyed: 0 };
  const opened = [];
  const viewer = {
    scene: { pick },
    dataSources: {
      add: (value) => sources.push(value),
      remove: (value) => sources.splice(sources.indexOf(value), 1),
    },
  };
  const layer = createSaFireIncidentsLayer({
    source: { getSnapshot },
    now: () => NOW,
    overlayHost: {
      setEntries(sourceId, entries, options) {
        overlay.entries.set(sourceId, entries);
        overlay.options = options;
      },
      setVisible(sourceId, visible) {
        overlay.visible = visible;
      },
      clearSource: (sourceId) => overlay.entries.delete(sourceId),
      hitTest: (x, y, options) => cardHit(x, y, options),
    },
    screenSpaceEventHandlerFactory: () => ({
      setInputAction(callback) {
        clicks.handler = callback;
      },
      destroy() {
        clicks.destroyed += 1;
        clicks.handler = null;
      },
    }),
    picking: {
      resolvePickId: (picked) => picked?.id ?? null,
      isOwnedByOtherLayer: (layerId, pickedId) =>
        String(pickedId).startsWith('other-layer:'),
    },
    pointer: { isPointerFree: () => true },
    openExternal: (url) => opened.push(url),
  });
  layer.init(viewer);
  layer.enable(viewer);
  const entities = () => sources[0].entities.values;
  const byId = (id) => entities().find((entity) => entity.id === id);
  const cards = () => overlay.entries.get('sa-fire-incidents') ?? [];
  const click = (picked, position = { x: 10, y: 10 }) => {
    // Re-point the pick for this click.
    viewer.scene.pick = () => picked;
    clicks.handler({ position });
  };
  return {
    layer,
    viewer,
    sources,
    overlay,
    clicks,
    opened,
    entities,
    byId,
    cards,
    click,
  };
}
const value = (property) => property.getValue(Cesium.JulianDate.now());

test('incidents render as ground-clamped, depth-test-free points sized by level and coloured by status', async () => {
  const h = harness(async () => snapshot());
  assert.equal(await h.layer.update(), true);
  const going = h.byId('sa-fire-incident:F2610120119');
  const safe = h.byId('sa-fire-incident:F2608270132');
  for (const entity of [going, safe]) {
    assert.equal(
      value(entity.point.heightReference),
      Cesium.HeightReference.CLAMP_TO_GROUND,
    );
    assert.equal(
      value(entity.point.disableDepthTestDistance),
      Number.POSITIVE_INFINITY,
    );
  }
  assert.ok(
    value(safe.point.pixelSize) > value(going.point.pixelSize),
    'L3 is larger than L1',
  );
  assert.ok(
    Cesium.Color.equals(
      value(going.point.color),
      Cesium.Color.fromCssColorString(incidentStatusColor('Going')),
    ),
  );
  assert.ok(
    Cesium.Color.equals(
      value(safe.point.color),
      Cesium.Color.fromCssColorString(incidentStatusColor('Safe')),
    ),
  );
  assert.deepEqual(h.layer.getStats().count, 2);
  assert.equal(h.layer.id, 'sa-fire-incidents');
  assert.equal(h.layer.name, 'SA Fire Incidents');
  assert.equal(h.layer.source, 'SA CFS · MFS');
  assert.equal(h.layer.updateInterval, 60000);
});

test('warning polygons use ClassificationType.BOTH and carry a ground-clamped outline', async () => {
  const h = harness(async () =>
    snapshot({
      warnings: [
        warning(),
        warning({
          id: 'g:2',
          kind: 'polygon',
          category: 'Emergency Warning',
          polygons: [warning().polygons[0], warning().polygons[0]],
        }),
        warning({
          id: 'p:3',
          kind: 'point',
          polygons: undefined,
          lat: -35.1,
          lon: 138.2,
        }),
      ],
    }),
  );
  await h.layer.update();
  const fill = h.byId('sa-fire-warning:g:1');
  assert.equal(
    value(fill.polygon.classificationType),
    Cesium.ClassificationType.BOTH,
  );
  assert.equal(value(fill.polyline.clampToGround), true);
  assert.equal(
    value(fill.polyline.classificationType),
    Cesium.ClassificationType.BOTH,
  );
  const color = value(fill.polygon.material).color;
  assert.ok(color.alpha > 0 && color.alpha < 1, 'translucent fill');
  assert.equal(
    color.red,
    Cesium.Color.fromCssColorString(warningCategoryColor('Watch and Act')).red,
  );
  assert.ok(h.byId('sa-fire-warning:g:2'));
  assert.ok(
    h.byId('sa-fire-warning:g:2#1'),
    'multi-polygon parts are separate entities',
  );
  const point = h.byId('sa-fire-warning:p:3');
  assert.equal(
    value(point.point.heightReference),
    Cesium.HeightReference.CLAMP_TO_GROUND,
  );
});

test('a failed refresh keeps the previous entities and reports the error', async () => {
  let fail = false;
  const h = harness(async () => {
    if (fail) throw new Error('SA fire HTTP 502');
    return snapshot();
  });
  await h.layer.update();
  const before = [...h.entities()];
  fail = true;
  assert.equal(await h.layer.update(), false);
  assert.deepEqual(h.entities(), before);
  assert.equal(h.layer.getStats().count, 2);
  assert.equal(h.layer.getStats().error, 'SA fire HTTP 502');
  assert.match(h.layer.getRowControls().info, /SA fire HTTP 502/);
  fail = false;
  await h.layer.update();
  assert.equal(h.layer.getStats().error, null);
});

test('a first-ever failure leaves an empty layer with the error, not a fake empty feed', async () => {
  const h = harness(async () => {
    throw new Error('Malformed SA fire snapshot');
  });
  assert.equal(await h.layer.update(), false);
  assert.equal(h.entities().length, 0);
  assert.equal(h.layer.getStats().error, 'Malformed SA fire snapshot');
  const info = h.layer.getRowControls().info;
  assert.match(info, /Feed time unavailable/);
  assert.doesNotMatch(info, /No active public warnings/);
});

test('late refresh results cannot publish after disable or destroy', async () => {
  for (const action of ['disable', 'destroy']) {
    let resolve, signal;
    const h = harness((options) => {
      signal = options.signal;
      return new Promise((done) => {
        resolve = done;
      });
    });
    const pending = h.layer.update();
    h.layer[action](h.viewer);
    assert.equal(signal.aborted, true);
    if (action === 'disable') h.layer.enable(h.viewer);
    resolve(snapshot());
    assert.equal(await pending, false);
    assert.equal(h.layer.getStats().count, 0);
    h.layer.destroy(h.viewer);
  }
});

test('the row shows a visible "Feed updated HH:MM ACDT" time and the warning state', async () => {
  const h = harness(async () => snapshot());
  await h.layer.update();
  const controls = h.layer.getRowControls();
  const lines = controls.info.split(' · ');
  assert.equal(lines[0], 'Feed updated 13:30 ACDT');
  assert.equal(lines[1], '1 public warning');
  assert.equal(lines.length, 2, 'no stale notice for a healthy feed');
  assert.ok(controls.infoTitle);
});

test('feed time falls back to the proxy fetch time when the upstream sends no Last-Modified', async () => {
  const h = harness(async () => snapshot({ upstreamModified: null }));
  await h.layer.update();
  assert.equal(
    h.layer.getRowControls().info.split(' · ')[0],
    'Feed updated 13:30 ACDT',
  );
});

test('"warnings unavailable" is never presented as "no warnings"', async () => {
  const h = harness(async () =>
    snapshot({ warnings: [], warningsAvailable: false }),
  );
  await h.layer.update();
  let info = h.layer.getRowControls().info;
  assert.match(info, /Warnings unavailable/);
  assert.doesNotMatch(info, /No active public warnings/);

  const none = harness(async () => snapshot({ warnings: [] }));
  await none.layer.update();
  info = none.layer.getRowControls().info;
  assert.match(info, /No active public warnings/);
  assert.doesNotMatch(info, /unavailable/);
});

test('a stale snapshot shows a notice while still drawing last good data', async () => {
  const h = harness(async () => snapshot({ stale: true }));
  await h.layer.update();
  assert.match(h.layer.getRowControls().info, /last good data/);
  assert.equal(h.entities().length, 3);
  assert.equal(h.layer.getStats().stale, true);
});

test('warnings that expired since the server fetch are dropped locally', async () => {
  const h = harness(async () =>
    snapshot({
      warnings: [
        warning(),
        warning({ id: 'g:old', expiryTime: NOW - 1 }),
        warning({ id: 'g:none', expiryTime: null }),
      ],
    }),
  );
  await h.layer.update();
  assert.ok(h.byId('sa-fire-warning:g:1'));
  assert.ok(h.byId('sa-fire-warning:g:none'));
  assert.equal(h.byId('sa-fire-warning:g:old'), undefined);
  assert.match(h.layer.getRowControls().info, /2 public warnings/);
});

test('the legend lists status bands with counts and the agency chips filter markers', async () => {
  const h = harness(async () =>
    snapshot({
      incidents: [
        incident(),
        incident({ id: 'b', status: 'going' }),
        incident({ id: 'c', agency: 'MFS', status: 'Contained' }),
        incident({ id: 'd', agency: 'Forestry SA', status: 'Mystery' }),
      ],
    }),
  );
  await h.layer.update();
  let controls = h.layer.getRowControls();
  assert.deepEqual(
    controls.legend.map(({ label, count }) => [label, count]),
    [
      ['Going', 2],
      ['Contained', 1],
      ['Controlled', 0],
      ['Safe', 0],
      ['Other / unknown', 1],
    ],
  );
  assert.deepEqual(
    controls.legend.map(({ color }) => color),
    ['Going', 'Contained', 'Controlled', 'Safe', null].map(incidentStatusColor),
  );
  assert.ok(controls.legend[0].blurb);
  assert.deepEqual(
    controls.chips.map(({ id, label, active }) => [id, label, active]),
    [
      ['agency-cfs', 'CFS', true],
      ['agency-mfs', 'MFS', true],
    ],
  );

  let repaints = 0;
  h.layer.setRowControlsListener(() => repaints++);
  controls.chips[0].onClick(); // CFS off
  assert.equal(repaints, 1);
  assert.equal(h.byId('sa-fire-incident:F2610120119').show, false);
  assert.equal(h.byId('sa-fire-incident:c').show, true);
  assert.equal(
    h.byId('sa-fire-incident:d').show,
    true,
    'unknown agencies have no chip and stay visible',
  );
  controls = h.layer.getRowControls();
  assert.equal(controls.chips[0].active, false);
  assert.equal(controls.legend[0].count, 0);
  assert.deepEqual(
    h.layer.getAnalystRecords().map((record) => record.id),
    ['c', 'd'],
  );
  controls.chips[0].onClick(); // back on
  assert.equal(h.byId('sa-fire-incident:F2610120119').show, true);
  assert.equal(h.layer.getAnalystRecords().length, 4);
});

test('clicking an incident publishes its card with the feed time; empty space clears it', async () => {
  const h = harness(async () => snapshot());
  await h.layer.update();
  assert.equal(typeof h.clicks.handler, 'function');
  h.click({ id: 'sa-fire-incident:F2610120119' });
  assert.equal(h.cards().length, 1);
  const [card] = h.cards();
  assert.equal(card.id, 'sa-fire-incident-card:F2610120119');
  assert.equal(card.title, 'Burn Off · Mount Compass');
  assert.ok(card.details.includes('Reported 12 Oct 19:30 ACDT'));
  assert.ok(card.details.includes('Feed updated 13:30 ACDT'));
  assert.ok(card.position, 'card needs a world anchor');
  assert.equal(card.interactive, false);

  h.click({ id: 'other-layer:aircraft-1' });
  assert.equal(h.cards().length, 1, 'sibling-layer picks keep the selection');
  h.click({ id: 'sa-fire-incident:unknown' });
  assert.equal(h.cards().length, 0, 'an unknown id is empty space');
  h.click({ id: 'sa-fire-incident:F2610120119' });
  h.click(null);
  assert.equal(h.cards().length, 0);
});

test('a warning card opens its validated link by card click and by keyboard activation', async () => {
  const h = harness(async () => snapshot(), {
    cardHit: (x, y, options) => {
      assert.deepEqual(options, { sourceId: 'sa-fire-incidents' });
      return h.cards()[0] && x === 99 ? { entryId: h.cards()[0].id } : null;
    },
  });
  await h.layer.update();
  h.click({ id: 'sa-fire-warning:g:1#0' });
  const [card] = h.cards();
  assert.equal(card.id, 'sa-fire-warning-card:g:1');
  assert.equal(card.interactive, true);
  assert.equal(card.activate(), true);
  assert.deepEqual(h.opened, ['https://www.cfs.sa.gov.au/example']);
  h.click(null, { x: 99, y: 99 });
  assert.equal(h.opened.length, 2, 'clicking the card opens the link');
  assert.equal(h.cards().length, 1, 'and keeps the selection');

  const linkless = harness(
    async () => snapshot({ warnings: [warning({ link: null })] }),
    {
      cardHit: () => ({ entryId: 'sa-fire-warning-card:g:1' }),
    },
  );
  await linkless.layer.update();
  linkless.click({ id: 'sa-fire-warning:g:1' });
  assert.equal(linkless.cards()[0].interactive, false);
  assert.equal(linkless.cards()[0].activate, undefined);
  linkless.click(null);
  assert.deepEqual(linkless.opened, []);
});

test('a refresh that drops the selected row also drops its card', async () => {
  let rows = snapshot();
  const h = harness(async () => rows);
  await h.layer.update();
  h.click({ id: 'sa-fire-incident:F2610120119' });
  assert.equal(h.cards().length, 1);
  rows = snapshot({ incidents: [incident({ id: 'other' })] });
  await h.layer.update();
  assert.equal(h.cards().length, 0);
});

test('hiding an agency closes the selected incident card', async () => {
  const h = harness(async () => snapshot());
  await h.layer.update();
  h.click({ id: 'sa-fire-incident:F2610120119' });
  h.layer.getRowControls().chips[0].onClick();
  assert.equal(h.cards().length, 0);
});

test('disable removes the click handler and any card', async () => {
  const h = harness(async () => snapshot());
  await h.layer.update();
  h.click({ id: 'sa-fire-incident:F2610120119' });
  h.layer.disable(h.viewer);
  assert.equal(h.clicks.destroyed, 1);
  assert.equal(h.overlay.entries.has('sa-fire-incidents'), false);
  assert.equal(h.sources[0].show, false);
});

test('identical snapshots keep entity identity; changed ones rebuild', async () => {
  let rows = snapshot();
  const h = harness(async () => structuredClone(rows));
  await h.layer.update();
  const first = h.entities().map((entity) => entity);
  await h.layer.update();
  assert.deepEqual(h.entities(), first);
  assert.ok(h.entities().every((entity, index) => entity === first[index]));
  rows = snapshot({ incidents: [incident({ status: 'Safe' })] });
  await h.layer.update();
  assert.notEqual(h.entities()[0], first[0]);
  assert.equal(h.layer.getStats().count, 1);
});

test('analyst records expose incident facts, not geometry', async () => {
  const h = harness(async () => snapshot());
  await h.layer.update();
  const records = h.layer.getAnalystRecords();
  assert.deepEqual(records.map((record) => record.id).sort(), [
    'F2608270132',
    'F2610120119',
  ]);
  assert.deepEqual(Object.keys(records[0]).sort(), [
    'agency',
    'aircraft',
    'fireBanDistrict',
    'ground',
    'id',
    'lat',
    'level',
    'lon',
    'messageCount',
    'name',
    'region',
    'reportedTime',
    'status',
    'type',
  ]);
  assert.equal(h.layer.getAnalystRecords(1).length, 1);
  h.layer.disable(h.viewer);
  assert.deepEqual(h.layer.getAnalystRecords(), []);
});

test('a linked warning is named on the incident card', async () => {
  const h = harness(async () =>
    snapshot({
      incidents: [incident({ id: 'F2101010001' })],
      warnings: [warning({ incidentRef: 2101010001 })],
    }),
  );
  await h.layer.update();
  h.click({ id: 'sa-fire-incident:F2101010001' });
  assert.ok(h.cards()[0].details.includes('Warning: Watch and Act'));
  h.click({ id: 'sa-fire-warning:g:1' });
  assert.ok(
    h
      .cards()[0]
      .details.some((line) => line.startsWith('Incident F2101010001')),
  );
});

test('layers require a snapshot source and initialize once', () => {
  assert.throws(() => createSaFireIncidentsLayer({}), /snapshot source/);
  const h = harness(async () => snapshot());
  assert.throws(() => h.layer.init(h.viewer), /already initialized/);
});
