import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { findPickOwner } from '../../data/pickRegistry.js';
import { createDriveBcLayer } from './index.js';

const makeSnapshot = () => ({
  stale: false,
  partial: false,
  events: [
    {
      id: 'drivebc.ca/closure-1',
      headline: 'ROAD CLOSURE',
      status: 'ACTIVE',
      eventType: 'INCIDENT',
      subtypes: ['ROAD_CONDITION'],
      severity: 'MAJOR',
      description: '<script>not trusted</script> Highway 1 closed.',
      updated: '2026-10-11T09:00:00-07:00',
      url: 'https://api.open511.gov.bc.ca/events/drivebc.ca/closure-1',
      geometry: { type: 'Point', coordinates: [-121.44, 49.38] },
    },
    {
      id: 'drivebc.ca/work-2',
      headline: 'CONSTRUCTION',
      status: 'ACTIVE',
      eventType: 'CONSTRUCTION',
      subtypes: ['ROAD_CONSTRUCTION'],
      severity: 'MINOR',
      description: 'Work along Highway 1.',
      updated: null,
      url: null,
      geometry: {
        type: 'LineString',
        coordinates: Array.from({ length: 1001 }, (_, index) => [-123 + index * 0.0001, 49 + index * 0.0001]),
      },
    },
  ],
});

function viewerFixture() {
  const dataSources = [];
  return {
    viewer: {
      dataSources: {
        add: (source) => { dataSources.push(source); return Promise.resolve(source); },
        remove: (source, destroy) => {
          const index = dataSources.indexOf(source);
          if (index >= 0) dataSources.splice(index, 1);
          if (destroy) source.destroy?.();
          return index >= 0;
        },
      },
    },
    dataSources,
  };
}

test('DriveBC layer exposes a severity legend matching its map palette', () => {
  const layer = createDriveBcLayer({ source: { getSnapshot: async () => makeSnapshot() } });
  const controls = layer.getRowControls?.();
  assert.deepEqual(
    controls?.legend?.map(({ label, color }) => [label, color]),
    [
      ['Critical', '#ff3131'],
      ['Major', '#ff5b36'],
      ['Moderate', '#ffb020'],
      ['Minor', '#ffd166'],
      ['Unspecified', '#59d9ff'],
    ],
  );
  assert.match(controls?.info || '', /not traffic speed/i);
});

test('clicking a DriveBC road event opens its details at the click position', async () => {
  let onClick;
  let opened;
  let destroyed = false;
  const popup = {
    show: (event, position) => { opened = { event, position }; },
    hide() {},
    destroy: () => { destroyed = true; },
  };
  const source = { getSnapshot: async () => makeSnapshot() };
  const layer = createDriveBcLayer({
    source,
    createEventPopup: () => popup,
    createClickHandler: () => ({
      setInputAction: (handler) => { onClick = handler; },
      destroy() {},
    }),
    isPointerFree: () => true,
  });
  const f = viewerFixture();
  f.viewer.scene = { canvas: {}, pick: () => null };
  layer.init(f.viewer);
  layer.enable();
  assert.equal(findPickOwner('drivebc:some-event:line:0'), 'drivebc-road-conditions');
  await layer.update();
  const line = f.dataSources[0].entities.values.find((entity) => entity.polyline);
  f.viewer.scene.pick = () => ({ id: line });
  onClick({ position: { x: 44, y: 88 } });
  assert.equal(opened.event.id, 'drivebc.ca/work-2');
  assert.equal(opened.event.severity, 'MINOR');
  assert.deepEqual(opened.position, { x: 44, y: 88 });
  layer.disable();
  assert.equal(findPickOwner('drivebc:some-event:line:0'), null);
  layer.destroy(f.viewer);
  assert.equal(destroyed, true);
});

test('DriveBC layer renders road-event points and bounded line geometry only while enabled', async () => {
  const source = { getSnapshot: async () => makeSnapshot() };
  const layer = createDriveBcLayer({ source });
  const f = viewerFixture();
  layer.init(f.viewer);
  assert.equal(layer.id, 'drivebc-road-conditions');
  assert.equal(layer.name, 'DriveBC Road Conditions');
  assert.equal(f.dataSources.length, 1);
  assert.equal(f.dataSources[0].show, false);

  layer.enable(f.viewer);
  await layer.update(f.viewer);
  assert.equal(f.dataSources[0].show, true);
  assert.equal(f.dataSources[0].entities.values.length, 2);
  assert.equal(layer.getStats().count, 2);
  assert.equal(layer.getStats().partial, false);

  const point = f.dataSources[0].entities.values.find((entity) => entity.point);
  assert.ok(point);
  assert.equal(point.name, 'ROAD CLOSURE');
  assert.equal(point.point.color.getValue(Cesium.JulianDate.now()).red, 1);
  assert.match(point.description.getValue(Cesium.JulianDate.now()), /&lt;script&gt;/);
  assert.doesNotMatch(point.description.getValue(Cesium.JulianDate.now()), /<script>/);

  const line = f.dataSources[0].entities.values.find((entity) => entity.polyline);
  const positions = line.polyline.positions.getValue(Cesium.JulianDate.now());
  assert.ok(positions.length <= 200);
  assert.ok(positions.length >= 2);
  assert.equal(line.polyline.clampToGround.getValue(), true);

  layer.disable();
  assert.equal(f.dataSources[0].show, false);
  layer.destroy(f.viewer);
  assert.equal(f.dataSources.length, 0);
});

test('DriveBC layer exposes stale and partial source state in its row stats', async () => {
  const layer = createDriveBcLayer({
    source: { getSnapshot: async () => ({ ...makeSnapshot(), stale: true, partial: true }) },
  });
  const f = viewerFixture();
  layer.init(f.viewer);
  layer.enable(f.viewer);
  await layer.update(f.viewer);
  assert.equal(layer.getStats().stale, true);
  assert.equal(layer.getStats().partial, true);
  assert.equal(layer.getStats().count, 2);
  layer.destroy(f.viewer);
});
