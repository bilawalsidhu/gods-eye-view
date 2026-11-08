import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalInfrastructureOverlayEntry } from '../../data/localGeojsonCore.js';
import { createDisplayHarness } from './render/displayHarness.mjs';
import { GROUND_HARNESSES } from '../../testSupport/groundDisplayEngines.mjs';

// The named-area markers on the fake engine: its camera events, frames and
// window projection (scripted per test) drive the discs.
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
  const h = createDisplayHarness(GROUND_HARNESSES[0], { overlayHost });
  const { engine } = h;
  engine.fake.script('worldToWindow', (_point, scratch) => { projections.add(scratch); scratch.x = x; scratch.y = 300; return scratch; });
  engine.fake.setSize(1280, 800);
  const base = {
    changed: engine.camera.changed.numberOfListeners,
    moveEnd: engine.camera.moveEnd.numberOfListeners,
    preRender: engine.frames.preRender.numberOfListeners,
  };
  h.state.contextAnchor = { latitude: 0, longitude: 0 };
  h.start();
  let height = 1e7;
  const records = [1, 2].map((n) => ({ id: `osm:military:w${n}`, name: `Site ${n}`, namedArea: true, areaM2: 100 / n, latitude: 0, longitude: 0, pointOnly: true }));
  t.after(() => h.destroy());
  return {
    state: h.state, engine, base,
    get labels() { return labels; }, get options() { return options; }, get visible() { return visible; },
    projections, records, markers: h.parts.display?.namedMarkers, lifecycle: h.parts.display,
    setX: (value) => { x = value; },
    /** A pose change too small for a camera event. */
    nudge() { height += 1; engine.fake.setPose({ height }); },
    frame: () => engine.fake.emit('frames.preRender', 0),
    cameraChanged() { engine.fake.emit('camera.changed'); engine.fake.emit('camera.moveEnd'); },
    publications: () => publications, loads: h.loads,
  };
}

test('Contacts camera motion reprojects and declutters existing labels without source loads or primitive replacement', (t) => {
  const h = setup(t);
  h.markers.sync(h.records);
  assert.equal(h.markers.stats().pointsOnScreen, 0);
  h.setX(600); h.cameraChanged();
  assert.equal(h.markers.stats().pointsOnScreen, 2);
  assert.equal(h.labels.length, 2);
  assert.equal(h.options.collisionCapacity, 24);
  assert.equal(h.options.cohortLimit, 512);
  assert.equal(h.visible, true);
  assert.equal(h.loads(), 0);
  assert.equal(h.publications(), 3);
  assert.equal(h.projections.size, 1);
  h.setX(1400); h.nudge(); h.frame();
  assert.equal(h.markers.stats().pointsOnScreen, 0, 'small pose changes refresh before render');
  h.lifecycle.disable();
  assert.equal(h.engine.camera.changed.numberOfListeners, h.base.changed + 1, 'only the viewport listener remains');
  assert.equal(h.engine.frames.preRender.numberOfListeners, h.base.preRender);
  assert.equal(h.labels.length, 0);
  assert.equal(h.visible, false);
  h.state.records = h.records;
  h.setX(600); h.lifecycle.enable();
  assert.equal(h.labels.length, 2);
  assert.equal(h.publications(), 5);
  h.lifecycle.destroy();
  assert.equal(h.engine.camera.changed.numberOfListeners, h.base.changed);
  assert.equal(h.engine.camera.moveEnd.numberOfListeners, h.base.moveEnd);
  assert.equal(h.engine.frames.preRender.numberOfListeners, h.base.preRender);
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
    h.nudge();
    h.frame();
  }
  assert.equal(h.labels[0], first);
  assert.equal(h.publications(), publications, 'camera frames never rebuild host entries');
  assert.equal(h.projections.size, 1, 'point projection reuses scratch storage');
  h.lifecycle.destroy();
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
});

test('selected markers without an explicit namedArea flag stay hidden safely', (t) => {
  const h = setup(t);
  const record = {
    id: 'google:places-qa-01',
    name: 'Candidate',
    latitude: 0,
    longitude: 0,
  };
  h.state.selectedId = record.id;
  assert.doesNotThrow(() => h.markers.sync([record]));
  h.markers.visit((_id, point) => assert.equal(point.show, false));
});
