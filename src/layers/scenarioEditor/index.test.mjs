import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EDITOR_POINTER_OWNER, createScenarioEditorLayer } from './index.js';

const bundled = JSON.parse(
  readFileSync(
    new URL('../../../public/scenarios/fleet-week-sf.json', import.meta.url),
    'utf8',
  ),
);

function fakeSimulation({ document = bundled } = {}) {
  const listeners = new Set();
  return {
    replacements: [],
    document,
    getDocument() {
      return this.document ? structuredClone(this.document) : null;
    },
    replaceScenario(doc, options) {
      this.replacements.push({ doc, options });
      return doc.aircraft.length ? { ok: true } : { ok: false, error: 'empty' };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit() {
      for (const listener of listeners) listener();
    },
  };
}

function fakeInput({ busy = null } = {}) {
  let current = busy;
  return {
    claimPointer(owner) {
      if (current) return null;
      current = owner;
      return { owner, id: 1 };
    },
    releasePointer(lease) {
      if (lease && current === lease.owner) current = null;
    },
    pointerOwner: () => current,
  };
}

function harness({ input = fakeInput(), simulation = fakeSimulation(), pickedLatLon = [37.8, -122.4] } = {}) {
  const clicks = [];
  const handlers = [];
  const downloads = [];
  const toRad = (deg) => (deg * Math.PI) / 180;
  const cesium = {
    Math: { toDegrees: (rad) => (rad * 180) / Math.PI },
    Cartographic: {
      fromCartesian: (c) => ({ latitude: toRad(c.lat), longitude: toRad(c.lon) }),
    },
    ScreenSpaceEventType: { LEFT_CLICK: 'LEFT_CLICK' },
  };
  const viewer = {
    scene: {
      canvas: {},
      pickPositionSupported: true,
      pickPosition: () => ({ lat: pickedLatLon[0], lon: pickedLatLon[1] }),
      camera: { pickEllipsoid: () => null },
      globe: { ellipsoid: {} },
    },
  };
  const cameras = { getSessionCameras: () => [{ id: 'session-1', type: 'ground', lat: 1, lon: 1, heightM: 5, altitudeReference: 'ellipsoid', target: 'angel1', title: 'Camera 1' }] };
  const layer = createScenarioEditorLayer({
    simulation,
    cameras,
    services: { input },
    cesium,
    download: (name, text) => downloads.push({ name, text }),
    pickFile: async () => JSON.stringify(bundled),
    createInputHandler: () => {
      const handler = {
        destroyed: false,
        actions: {},
        setInputAction(fn, type) {
          this.actions[type] = fn;
        },
        destroy() {
          this.destroyed = true;
        },
      };
      handlers.push(handler);
      return handler;
    },
  });
  layer.init(viewer);
  return {
    layer,
    simulation,
    input,
    handlers,
    downloads,
    clicks,
    click(x = 10, y = 10) {
      handlers.at(-1)?.actions.LEFT_CLICK?.({ position: { x, y } });
    },
  };
}

test('enable adopts the loaded scenario and lists its aircraft with editor actions', () => {
  const h = harness();
  h.layer.enable();
  const controls = h.layer.getRowControls();
  assert.equal(controls.list.items[0].id, 'angel1');
  assert.equal(controls.list.items[0].active, true);
  assert.ok(controls.list.items.some((item) => item.id === 'export-json'));
  assert.equal(controls.segmented.options.find((o) => o.active).id, 'mode-off');
  assert.equal(controls.slider.value, 2400, 'altitude follows the selected aircraft');
  assert.match(controls.info, /Fleet Week .* 5 aircraft .* 35 waypoints/);
  assert.equal(h.layer.diagnostics().dirty, false);
});

test('Add waypoints takes the pointer, appends on click and flies the draft live', () => {
  const h = harness();
  h.layer.enable();
  h.layer.setParams({ select: 'sfpd-helo', altFt: 900, mode: 'add' });
  assert.equal(h.layer.diagnostics().mode, 'add');
  assert.equal(h.input.pointerOwner(), EDITOR_POINTER_OWNER);
  h.click();
  const doc = h.layer.getDocument();
  const helo = doc.aircraft.find((entry) => entry.id === 'sfpd-helo');
  assert.equal(helo.waypoints.length, 6);
  assert.deepEqual(helo.waypoints.at(-1), { lat: 37.8, lon: -122.4, altFt: 900, speedKt: 55 });
  assert.equal(h.simulation.replacements.length, 1);
  assert.equal(h.simulation.replacements[0].options.keepTime, true);
  assert.equal(h.layer.diagnostics().dirty, true);
  assert.match(h.layer.getRowControls().info, /unsaved/);
  h.layer.setParams({ mode: 'off' });
  assert.equal(h.input.pointerOwner(), null);
  assert.equal(h.handlers.at(-1).destroyed, true);
  h.click();
  assert.equal(h.layer.getDocument().aircraft.find((entry) => entry.id === 'sfpd-helo').waypoints.length, 6);
});

test('a busy pointer refuses Add waypoints and says who holds it', () => {
  const h = harness({ input: fakeInput({ busy: 'draw' }) });
  h.layer.enable();
  h.layer.setParams({ mode: 'add' });
  assert.equal(h.layer.diagnostics().mode, 'off');
  assert.match(h.layer.getRowControls().info, /Draw is using the pointer/);
  assert.match(h.layer.getStats().error, /draw/);
});

test('new aircraft, undo, loop, clear and remove keep the live scenario playable', () => {
  const h = harness();
  h.layer.enable();
  h.layer.setParams({ action: 'new-aircraft' });
  assert.equal(h.layer.diagnostics().selectedId, 'aircraft-6');
  h.layer.setParams({ mode: 'add' });
  h.click();
  // One waypoint is not flyable yet: the live scenario omits the new aircraft.
  let last = h.simulation.replacements.at(-1).doc;
  assert.equal(last.aircraft.some((entry) => entry.id === 'aircraft-6'), false);
  h.click();
  last = h.simulation.replacements.at(-1).doc;
  assert.equal(last.aircraft.some((entry) => entry.id === 'aircraft-6'), true);
  h.layer.setParams({ action: 'toggle-loop' });
  assert.equal(h.layer.getDocument().aircraft.at(-1).loop, false);
  h.layer.setParams({ action: 'undo-waypoint' });
  assert.equal(h.layer.getDocument().aircraft.at(-1).waypoints.length, 1);
  h.layer.setParams({ action: 'clear-path' });
  assert.equal(h.layer.getDocument().aircraft.at(-1).waypoints.length, 0);
  h.layer.setParams({ action: 'remove-aircraft' });
  assert.equal(h.layer.getDocument().aircraft.length, 5);
  assert.equal(h.layer.diagnostics().selectedId, 'angel1');
});

test('export writes the draft with session cameras; import replaces it', async () => {
  const h = harness();
  h.layer.enable();
  h.layer.setParams({ action: 'export-json' });
  assert.equal(h.downloads.length, 1);
  assert.equal(h.downloads[0].name, 'fleet-week-sf.json');
  const exported = JSON.parse(h.downloads[0].text);
  assert.equal(exported.cameras.length, bundled.cameras.length + 1);
  assert.equal(exported.cameras.at(-1).id, 'session-1');
  assert.equal(h.layer.diagnostics().dirty, false);
  h.layer.setParams({ action: 'import-json' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(h.simulation.replacements.length, 1);
  assert.equal(h.layer.diagnostics().dirty, true);
});

test('a scenario change refreshes a clean draft but never a dirty one; disable frees the pointer', () => {
  const h = harness();
  h.layer.enable();
  h.simulation.document = { ...bundled, title: 'Renamed' };
  h.simulation.emit();
  assert.match(h.layer.getRowControls().info, /Renamed/);
  h.layer.setParams({ mode: 'add' });
  h.click();
  h.simulation.document = { ...bundled, title: 'Again' };
  h.simulation.emit();
  assert.doesNotMatch(h.layer.getRowControls().info, /Again/);
  h.layer.disable();
  assert.equal(h.input.pointerOwner(), null);
  assert.equal(h.layer.diagnostics().mode, 'off');
  h.layer.destroy();
});

test('without a loaded scenario the editor starts an empty one and creates an aircraft on first add', () => {
  const h = harness({ simulation: fakeSimulation({ document: null }) });
  h.layer.enable();
  assert.equal(h.layer.getRowControls().list.items[0].id, 'new-aircraft');
  h.layer.setParams({ mode: 'add' });
  assert.equal(h.layer.diagnostics().selectedId, 'aircraft-1');
  h.click();
  h.click();
  assert.equal(h.simulation.replacements.length, 1);
  assert.equal(h.simulation.replacements[0].doc.id, 'my-scenario');
});
