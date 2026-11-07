import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from 'cesium';
import { createNamedMarkers } from './namedMarkers.js';
import { createLifecycle } from './lifecycle.js';
import { createLocalInfrastructureOverlayEntry } from '../../data/localGeojsonCore.js';

function setup(t) {
  let labels = [], options, publications = 0, visible = false;
  const overlayHost = {
    setEntries(id, entries, policy) {
      assert.equal(id, 'military-installations');
      labels = entries; options = policy; publications++;
    },
    clearSource() { labels = []; },
    setVisible(_id, value) { visible = value; },
  };
  let x = -100;
  const projections = new Set();
  t.mock.method(C.SceneTransforms, 'worldToWindowCoordinates', (_scene, _point, scratch) => { projections.add(scratch); scratch.x = x; scratch.y = 300; return scratch; });
  const camera = { changed: new C.Event(), moveEnd: new C.Event(), positionWC: C.Cartesian3.fromDegrees(0, 0, 1e6), viewMatrix: C.Matrix4.clone(C.Matrix4.IDENTITY) };
  const state = { viewer: { camera, dataSources: { add() {}, remove() {} }, scene: { canvas: { clientWidth: 1280, clientHeight: 800 }, preRender: new C.Event(), primitives: { add: (p) => p, remove() {} } } }, enabled: true, contextAnchor: { latitude: 0, longitude: 0 } };
  const services = { render: { governorRequestRender() {} }, picking: { registerPickOwner() {}, unregisterPickOwner() {} }, context: { clearSelectedEntityContextForLayer() {} } };
  let loads = 0;
  const parts = { model: { colorFor: () => C.Color.ORANGE }, rendering: { installationSurfaceHeightM: () => 0, clearRendered() {} }, viewport: { scheduleLoad: () => loads++, clearUnavailableRetry() {} }, selection: { installInteraction() {} }, ingestion: { setInstallationStatus() {} } };
  const ctx = { state, services, parts, source: {}, overlayHost };
  parts.namedMarkers = createNamedMarkers(ctx);
  const lifecycle = createLifecycle(ctx).methods;
  lifecycle.init(state.viewer); lifecycle.enable();
  const records = [1, 2].map((n) => ({ id: `osm:military:w${n}`, name: `Site ${n}`, namedArea: true, areaM2: 100 / n, latitude: 0, longitude: 0, pointOnly: true }));
  return { state, camera, get labels() { return labels; }, get options() { return options; }, get visible() { return visible; }, projections, records, markers: parts.namedMarkers, lifecycle, setX: (value) => { x = value; }, publications: () => publications, loads: () => loads };
}

test('Contacts camera motion reprojects and declutters existing labels without source loads or primitive replacement', (t) => {
  const h = setup(t);
  h.markers.sync(h.records);
  assert.equal(h.markers.stats().pointsOnScreen, 0);
  h.setX(600); h.camera.changed.raiseEvent(); h.camera.moveEnd.raiseEvent();
  assert.equal(h.markers.stats().pointsOnScreen, 2);
  assert.equal(h.labels.length, 2);
  assert.equal(h.options.collisionCapacity, 24);
  assert.equal(h.options.cohortLimit, 512);
  assert.equal(h.visible, true);
  assert.equal(h.loads(), 0);
  assert.equal(h.publications(), 3);
  assert.equal(h.projections.size, 1);
  h.setX(1400); h.camera.viewMatrix[12] = 1; h.state.viewer.scene.preRender.raiseEvent();
  assert.equal(h.markers.stats().pointsOnScreen, 0, 'small pose changes refresh before render');
  h.lifecycle.disable();
  assert.equal(h.camera.changed.numberOfListeners, 1, 'only the viewport listener remains');
  assert.equal(h.state.viewer.scene.preRender.numberOfListeners, 0);
  assert.equal(h.labels.length, 0);
  assert.equal(h.visible, false);
  h.state.records = h.records;
  h.setX(600); h.lifecycle.enable();
  assert.equal(h.labels.length, 2);
  assert.equal(h.publications(), 5);
  h.lifecycle.destroy(h.state.viewer);
  assert.equal(h.camera.changed.numberOfListeners, 0);
  assert.equal(h.camera.moveEnd.numberOfListeners, 0);
  assert.equal(h.state.viewer.scene.preRender.numberOfListeners, 0);
});

test('wide named markers retain primitives until close polygons publish with the same identity', async (t) => {
  const { retainNamedHandoff } = await import('./ingestion.js');
  const h = setup(t);
  h.setX(600); h.markers.sync(h.records);
  const first = h.labels[0];
  const box = { west: -1, east: 1, south: -1, north: 1 };
  h.markers.sync(retainNamedHandoff(h.records, [], box));
  assert.equal(h.labels[0], first);
  assert.equal(first.title, 'Site 1');
  const polygon = { ...h.records[0], namedArea: false, name: 'Military area', pointOnly: false, footprint: [[0, 0], [0.1, 0], [0, 0.1], [0, 0]] };
  const handed = retainNamedHandoff(h.records, [polygon], box);
  assert.equal(handed.length, 2);
  assert.equal(handed[0].name, 'Site 1');
  assert.equal(handed[0].pointOnly, false);
  h.markers.sync(handed);
  assert.equal(h.labels[0], first);
  assert.equal(first.title, 'Site 1');
  assert.equal(h.labels.length, 2, 'no duplicate title at handoff');
  assert.equal(retainNamedHandoff(h.records, [], { west: 1, east: 2, south: 1, north: 2 }).length, 0);
  h.lifecycle.destroy(h.state.viewer);
});

test('canonical aliases transfer named marker ownership without replacing primitives', (t) => {
  const h = setup(t);
  h.setX(600);
  const parent = h.records[1];
  h.markers.sync([parent]);
  let originalPoint;
  h.markers.visit((_id, point) => { originalPoint = point; });
  const label = h.labels[0];
  for (const record of [
    { ...parent, id: h.records[0].id, aliasIds: [parent.id], pointOnly: false },
    { ...parent, aliasIds: [h.records[0].id], pointOnly: false },
    parent,
  ]) {
    h.markers.sync([record]);
    h.markers.visit((id, point) => {
      const currentLabel = h.labels[0];
      assert.equal(id, record.id);
      assert.equal(point, originalPoint);
      assert.equal(currentLabel, label);
      assert.equal(point.id.installationId, record.id);
      assert.equal(currentLabel.id, record.id);
    });
  }
  assert.equal(h.labels.length, 1);
  h.lifecycle.destroy(h.state.viewer);
});


test('the bounded host cohort ranks wide points and polygon titles by area', (t) => {
  const h = setup(t);
  h.markers.sync(Array.from({ length: 600 }, (_, n) => ({
    ...h.records[0], id: `site:${n}`, name: `Site ${n}`, areaM2: n,
    pointOnly: n % 2 === 0,
  })));
  assert.equal(h.labels.length, 512);
  assert.equal(h.labels[0].id, 'site:599');
  assert.equal(h.labels.at(-1).id, 'site:88');
  assert.ok(h.labels.every((entry) => !entry.stateless && entry.horizonCull && entry.collisionGroup === 'ambient-card'));
  const first = h.labels[0];
  const publications = h.publications();
  for (let i = 0; i < 100; i++) {
    h.camera.viewMatrix[12] += 0.01;
    h.state.viewer.scene.preRender.raiseEvent();
  }
  assert.equal(h.labels[0], first);
  assert.equal(h.publications(), publications, 'camera frames never rebuild host entries');
  assert.equal(h.projections.size, 1, 'point projection reuses scratch storage');
  h.lifecycle.destroy(h.state.viewer);
  assert.equal(h.labels.length, 0);
});


test('wide and polygon titles use the Data Centers entry contract and persistent shared domain', (t) => {
  const h = setup(t);
  h.markers.sync([h.records[0], { ...h.records[1], pointOnly: false }]);
  assert.equal(h.options.moving, false);
  assert.equal(h.options.solveIntervalMs, undefined);
  assert.equal(h.options.maxVisible, 24);
  for (const entry of h.labels) {
    const reference = createLocalInfrastructureOverlayEntry({ id: entry.id, layerId: 'military-installations', position: entry.position, properties: { name: entry.title }, priority: entry.priority, accent: entry.accent });
    assert.deepEqual(entry, { ...reference, selected: false });
  }
  h.lifecycle.destroy(h.state.viewer);
});


test('selection promotes exactly one entry and deselection restores that same label', (t) => {
  const h = setup(t);
  h.markers.sync(h.records);
  const original = h.labels[0];
  h.state.selectedId = h.records[0].id;
  h.markers.sync(h.records);
  assert.equal(h.labels.length, 2);
  assert.equal(h.labels[0], original);
  assert.equal(original.variant, 'selected');
  assert.equal(h.labels.filter(e => e.selected).length, 1);
  assert.equal(h.options.maxVisible, 23);
  h.state.selectedId = null;
  h.markers.sync(h.records);
  assert.equal(h.labels[0], original);
  assert.equal(original.variant, 'card');
  assert.equal(original.selected, false);
  assert.deepEqual(original.details, []);
  h.lifecycle.destroy(h.state.viewer);
});

test('Contacts can select a point outside the normal title cap or an unnamed polygon', (t) => {
  const h = setup(t);
  const records = Array.from({ length: 520 }, (_, i) => ({ ...h.records[0], id: `site:${i}`, areaM2: 1000 - i }));
  records.push({ ...h.records[0], id: 'unnamed', name: 'Military area', namedArea: false, pointOnly: false });
  for (const id of ['site:519', 'unnamed']) {
    h.state.selectedId = id;
    h.markers.sync(records);
    assert.equal(h.labels[0].id, id);
    assert.equal(h.labels[0].variant, 'selected');
    assert.equal(h.labels.filter(e => e.selected).length, 1);
    assert.equal(h.labels.length, 512);
  }
  h.lifecycle.destroy(h.state.viewer);
});
