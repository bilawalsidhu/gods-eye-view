import test from 'node:test';
import assert from 'node:assert/strict';
import * as geo from '../../../geo/index.js';
import { createAlprNavaraRenderer } from './navara.js';

function event() {
  const listeners = new Set();
  return {
    listeners,
    addEventListener(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    fire() {
      for (const fn of listeners) fn();
    },
  };
}
function harness(t) {
  const sets = [],
    contexts = new Map(),
    inputs = new Map(),
    flights = [];
  const move = event(),
    frame = event();
  let commits = 0,
    selectedContext = null,
    following = false,
    credits = 0,
    renderRequested = false;
  const state = {
    enabled: true,
    selectedId: null,
    lastAnchorSampleAt: 0,
    renderRevision: 0,
    records: [],
    recordById: new Map(),
  };
  const engine = {
    host: { size: () => ({ width: 800, height: 600 }) },
    render: {
      request() {
        renderRequested = true;
      },
    },
    camera: {
      livePosition: geo.cartesian3.fromDegrees(-97, 30, 10000),
      pickEllipsoid: () => geo.cartesian3.fromDegrees(-97, 30),
      following: () => following,
      pose: () => ({ heading: 0.5 }),
      moveEnd: move,
      flyToSphere(sphere, options) {
        flights.push({ sphere, options });
      },
    },
    frames: { preRender: frame },
    input: {
      on(name, fn) {
        inputs.set(name, fn);
        return () => inputs.delete(name);
      },
    },
    projector: {
      horizonVisible: () => true,
      worldToWindow: () => ({ x: 400, y: 300 }),
    },
    surface: {
      supported: true,
      terrainHeightSupported: false,
      sampleHeight: () => 150,
    },
    credits: {
      addStatic(_markup, options) {
        assert.notEqual(
          options?.onScreen,
          true,
          'loading ALPR must not open an attribution popup over the map',
        );
        credits++;
        return () => credits--;
      },
    },
    movers: {
      createSet(options) {
        const set = {
          options,
          rows: [],
          count: 0,
          dead: false,
          setCount(n) {
            assert.ok(!this.dead);
            assert.ok(n <= options.capacity);
            this.count = n;
          },
          set(i, row) {
            assert.ok(i < this.count);
            this.rows[i] = row;
          },
          commit() {
            assert.ok(!this.dead);
            this.committedRows = this.rows.slice(0, this.count);
            commits++;
          },
          destroy() {
            assert.ok(!this.dead);
            this.dead = true;
          },
        };
        sets.push(set);
        return set;
      },
    },
  };
  const services = {
    groundFloor: { cachedGroundFloor: () => 150 },
    context: {
      getSelectedEntityContext: () => selectedContext,
      clearSelectedEntityContextForLayer() {
        if (selectedContext?.layerId === 'alpr-cameras') selectedContext = null;
      },
      removeEntityContextsForLayer(_id, { retainIds = new Set() } = {}) {
        for (const id of contexts.keys())
          if (!retainIds.has(id)) contexts.delete(id);
      },
      registerEntityContext(entity, metadata) {
        contexts.set(metadata.id, { ...metadata, entity });
      },
      selectEntityContext(entity) {
        selectedContext = contexts.get(entity.id);
      },
    },
  };
  const renderer = createAlprNavaraRenderer(engine, {
    state,
    services,
    source: {
      label: 'Fixture',
      attribution: {
        text: 'Fixture cameras',
        href: 'https://example.com/cameras',
      },
    },
  });
  renderer.init(null, { onMove() {} });
  renderer.setVisible(true);
  t.after(() => {
    state.enabled = false;
    renderer.setVisible(false);
    renderer.destroy();
  });
  const load = (records) => {
    state.records = records;
    state.recordById = new Map(records.map((r) => [r.id, r]));
    renderer.renderRecords();
    frame.fire();
  };
  return {
    renderer,
    state,
    services,
    engine,
    sets,
    contexts,
    inputs,
    flights,
    move,
    frame,
    load,
    get selected() {
      return selectedContext;
    },
    get commits() {
      return commits;
    },
    get credits() {
      return credits;
    },
    get renderRequested() {
      return renderRequested;
    },
    finishFrame() {
      renderRequested = false;
    },
    follow(value) {
      following = value;
    },
    otherSelection() {
      selectedContext = { id: 'flight:1', layerId: 'flights' };
    },
  };
}
const records = (count) =>
  Array.from({ length: count }, (_, i) => ({
    id: `alpr:${i}`,
    latitude: 30 + i * 0.00001,
    longitude: -97,
    osmId: i,
  }));

test('ALPR preserves a postRender update after the view clears its current frame request', async (t) => {
  const h = harness(t);
  h.load(records(1));
  h.inputs.get('click')({
    position: { x: 400, y: 300 },
    picked: { id: 'alpr:0' },
  });
  h.finishFrame();
  await Promise.resolve();
  assert.equal(h.renderRequested, true, 'the pending change wakes a new frame');
  h.frame.fire();
  assert.equal(h.sets[0].committedRows[0].show, false);
  assert.equal(h.sets[1].committedRows[0]?.pickId, 'alpr:0');
  const commits = h.commits;
  h.finishFrame();
  h.frame.fire();
  await Promise.resolve();
  assert.equal(
    h.commits,
    commits,
    'settled sprites do not keep requesting frames',
  );
  assert.equal(
    h.renderRequested,
    false,
    'settled sprites do not wake another frame',
  );
});

test('retired ALPR floor requests cannot rewrite a newer marker or a destroyed set', async (t) => {
  const h = harness(t);
  const pending = [];
  let cached;
  h.services.groundFloor.cachedGroundFloor = () => cached;
  h.services.groundFloor.resolveGroundFloorCells = (_points, { signal }) =>
    new Promise((resolve) => pending.push({ resolve, signal }));
  h.load(records(1));
  assert.equal(pending.length, 1);
  h.renderer.clearRendered();
  assert.equal(pending[0].signal.aborted, true);
  h.load([{ ...records(1)[0], latitude: 30.01 }]);
  assert.equal(pending.length, 2);
  const marker = h.contexts.get('alpr:0').entity;
  const position = marker.position;
  cached = 450;
  pending[0].resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    marker.position,
    position,
    'old completion cannot place the new marker',
  );
  h.renderer.destroy();
  assert.equal(pending[1].signal.aborted, true);
  const commits = h.commits;
  pending[1].resolve();
  await new Promise((resolve) => setImmediate(resolve));
  h.frame.fire();
  assert.equal(h.commits, commits);
  assert.equal(h.contexts.size, 0);
  assert.equal(h.inputs.size, 0);
  assert.equal(h.frame.listeners.size, 0);
  assert.equal(h.move.listeners.size, 0);
});

test('ALPR batches a dense viewport, respects the cap and never follows a tracked target', (t) => {
  const h = harness(t);
  const before = h.commits;
  h.load(records(1600));
  assert.equal(h.renderer.count(), 1500);
  assert.equal(h.state.renderSaturated, true);
  assert.ok(
    h.commits - before < 10,
    'one buffer commit per batch, not per marker',
  );
  assert.equal(h.credits, 1);
  h.follow(true);
  assert.equal(h.renderer.focusNearest(), false);
  assert.equal(h.flights.length, 0);
  h.follow(false);
  assert.equal(h.renderer.focusNearest(), true);
  assert.equal(h.flights[0].options.range, 800);
  assert.equal(h.flights[0].options.pitch, -Math.PI / 4);
  assert.equal(h.selected.id, 'alpr:0');
});

test('ALPR preserves selected metadata and releases an evicted or replaced selection', (t) => {
  const h = harness(t);
  h.load(records(2));
  h.inputs.get('click')({
    position: { x: 400, y: 300 },
    picked: { id: 'alpr:0' },
  });
  assert.equal(h.selected.id, 'alpr:0');
  h.load(records(2).map((r) => ({ ...r, operator: 'Updated' })));
  assert.equal(h.state.selectedId, 'alpr:0');
  assert.ok(
    h.contexts
      .get('alpr:0')
      .entity.gevLabelModel.details.some((line) => line.includes('UPDATED')),
  );
  h.otherSelection();
  h.load(records(2));
  assert.equal(h.state.selectedId, null);
  assert.equal(h.selected.id, 'flight:1');
  h.inputs.get('click')({
    position: { x: 400, y: 300 },
    picked: { id: 'alpr:1' },
  });
  h.load(records(1));
  assert.equal(h.state.selectedId, null);
  assert.equal(h.contexts.has('alpr:1'), false);
});

test('ten ALPR toggles clear contexts, picks and credits without allocating new sets', (t) => {
  const h = harness(t);
  for (let i = 0; i < 10; i++) {
    h.state.enabled = true;
    h.renderer.setVisible(true);
    h.load(records(3));
    h.state.enabled = false;
    h.renderer.setVisible(false);
    h.renderer.clearSelection();
    h.renderer.clearRendered();
    assert.equal(h.contexts.size, 0);
    assert.equal(h.inputs.size, 0);
    assert.equal(h.credits, 0);
    assert.ok(h.sets.every((set) => set.count === 0));
  }
  assert.equal(h.sets.length, 2);
});
