import { createLayerSceneContext } from './layerSceneBinding.js';
import * as geo from '../geo/index.js';
import { createApplicationScene } from '../app/scene.js';
import { createLayerSession } from '../app/layerSession.js';
import * as context from './contextStore.js';
import * as picking from './pickRegistry.js';
import * as selection from './selectionDispatcher.js';
import { createLocalAdsbLayer } from '../layers/localAdsb/index.js';
import { createLocalAdsbDisplay } from '../layers/localAdsb/render/display.js';
import { aircraftAtlasLayout } from '../layers/aircraft/render/display.js';
import { createAlprDisplay } from '../layers/alpr/render/display.js';
import { createFirmsHeatmapLayer } from '../layers/firms/index.js';
import { createFirmsDisplay } from '../layers/firms/render/display.js';
import { CONTEXT_TOP_N } from '../layers/firms/policy.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { GROUND_HARNESSES } from '../testSupport/groundDisplayEngines.mjs';
import { createSceneServices, sceneServicesFor } from './sceneServices.js';
import { getSelectedEntityContext } from './contextStore.js';
import { trackedReadoutFor, refreshTrackedReadout } from './trackedReadout.js';

function recorder() {
  const calls = [];
  return {
    calls,
    setEntries(source, entries) {
      calls.push({ source, entry: entries[0] });
    },
    setVisible() {},
    clearSource(source) {
      calls.push({ source, entry: null });
    },
    last: () => calls.at(-1)?.entry,
  };
}

function subject(title = 'Camera') {
  return {
    gevTrackedId: 'shared-id',
    gevLabelModel: { title, details: ['Original'] },
    gevDisplayPosition: () => ({ x: 6378137, y: 0, z: 100 }),
  };
}

function select(context, entity, layerId = 'alpr-cameras') {
  const record = context.registerEntityContext(entity, {
    id: 'shared-id',
    layerId,
  });
  context.selectEntityContext(entity);
  return record;
}

for (const makeHarness of GROUND_HARNESSES) {
  function setup(t) {
    const original = globalThis.window;
    const page = new EventTarget();
    globalThis.window = page;
    const harnesses = [makeHarness(), makeHarness()];
    const hosts = [recorder(), recorder()];
    const services = harnesses.map(({ engine }, i) =>
      createSceneServices(engine, { trackedOverlay: hosts[i] }),
    );
    services.forEach((s) => s.trackedReadout.init());
    t.after(() => {
      for (const { engine } of harnesses) sceneServicesFor(engine).destroy();
      harnesses.forEach((h) => h.destroy());
      globalThis.window = original;
    });
    return { harnesses, hosts, services, page };
  }

  test(`${makeHarness.name}: simultaneous follows refresh only their own card and cached anchor`, (t) => {
    const { harnesses, services, hosts } = setup(t);
    const models = [
      { title: 'First', details: ['100 km'] },
      { title: 'Second', details: ['200 km'] },
    ];
    const anchors = [
      { x: 6378137, y: 0, z: 100 },
      { x: 6378137, y: 100, z: 200 },
    ];
    const handles = harnesses.map(({ engine }, i) =>
      engine.camera.follow({
        position: () => anchors[i],
        viewFrom: { x: 0, y: -5000, z: 2000 },
        label: {
          id: 'same-follow-id',
          model: () => models[i],
          position: () => anchors[i],
        },
      }),
    );
    assert.equal(
      trackedReadoutFor(harnesses[0].engine),
      services[0].trackedReadout,
    );
    assert.deepEqual(
      hosts.map((h) => h.last().title),
      ['First', 'Second'],
    );
    assert.equal(hosts[0].last().position(), anchors[0]);
    assert.equal(hosts[1].last().position(), anchors[1]);
    models[0] = { title: 'First refreshed', details: ['101 km'] };
    const before = hosts[1].calls.length;
    refreshTrackedReadout(handles[0], harnesses[0].engine);
    assert.equal(hosts[0].last().title, 'First refreshed');
    assert.equal(hosts[1].calls.length, before);
    models[1] = { title: 'Second refreshed', details: ['201 km'] };
    refreshTrackedReadout({ gevFollowHandle: handles[1] }, harnesses[1].engine);
    assert.equal(hosts[1].last().title, 'Second refreshed');
    refreshTrackedReadout(handles[1], harnesses[0].engine);
    assert.equal(hosts[0].last().title, 'First refreshed');
    handles[0].stop();
    assert.equal(hosts[0].last(), null);
    assert.equal(services[1].trackedReadout.activeId(), 'same-follow-id');
    services[1].destroy();
    const callsAfterDestroy = hosts[1].calls.length;
    handles[1].stop();
    refreshTrackedReadout(handles[1], harnesses[1].engine);
    assert.equal(hosts[1].last(), null);
    assert.equal(
      hosts[1].calls.length,
      callsAfterDestroy,
      'follow changes after teardown cannot republish',
    );
  });

  test(`${makeHarness.name}: scoped selections, clears and aircraft events preserve page notifications`, (t) => {
    const {
      services: [a, b],
      hosts,
      page,
    } = setup(t);
    const notifications = [];
    const clears = [];
    for (const scene of [a, b])
      scene.context.events.addEventListener(
        'gev:entity-selection-cleared',
        ({ detail }) => clears.push(detail),
      );
    for (const type of [
      'gev:entity-selected',
      'gev:entity-selection-cleared',
      'gev:awareness-subject-selected',
    ])
      page.addEventListener(type, ({ detail }) =>
        notifications.push({ type, detail }),
      );
    const first = subject('First camera');
    const second = subject('Second camera');
    const firstRecord = select(a.context, first);
    assert.equal(notifications[0].detail, firstRecord);
    assert.equal(getSelectedEntityContext(), firstRecord);
    // Registering an identical id in another scene does not replace the page selection.
    b.context.registerEntityContext(second, {
      id: 'shared-id',
      layerId: 'alpr-cameras',
    });
    assert.equal(getSelectedEntityContext(), firstRecord);
    const secondRecord = b.context.selectEntityContext(second);
    assert.equal(getSelectedEntityContext(), secondRecord);
    assert.deepEqual(
      hosts.map((h) => h.last().title),
      ['First camera', 'Second camera'],
    );
    first.gevLabelModel = { title: 'First refreshed' };
    a.trackedReadout.refresh(first);
    assert.equal(hosts[0].last().title, 'First refreshed');
    assert.equal(hosts[1].last().title, 'Second camera');
    a.context.clearSelectedEntityContextForLayer('local-adsb');
    assert.equal(hosts[0].last().title, 'First refreshed');
    const beforeBackgroundClear = notifications.length;
    a.context.clearSelectedEntityContextForLayer('alpr-cameras');
    assert.equal(notifications.length, beforeBackgroundClear);
    assert.equal(hosts[0].last(), null);
    assert.equal(hosts[1].last().title, 'Second camera');
    assert.equal(getSelectedEntityContext(), secondRecord);
    assert.deepEqual(clears.at(-1), {
      layerId: 'alpr-cameras',
      reason: 'deliberate',
    });
    select(a.context, first, 'local-adsb');
    const beforeBackgroundEviction = notifications.length;
    b.context.removeEntityContextsForLayer('alpr-cameras');
    assert.equal(notifications.length, beforeBackgroundEviction);
    assert.equal(hosts[1].last(), null);
    assert.deepEqual(clears.at(-1), {
      layerId: 'alpr-cameras',
      reason: 'evicted',
    });
    context.clearSelectedEntityContextForLayer('local-adsb');
    assert.deepEqual(notifications.at(-1).detail, {
      layerId: 'local-adsb',
      reason: 'deliberate',
    });
    select(b.context, second);
    a.context.publishAwareness('gev:awareness-subject-selected', {
      layerId: 'flights',
      id: 'plane',
    });
    assert.equal(hosts[0].last(), null);
    assert.equal(hosts[1].last().title, 'Second camera');
    assert.deepEqual(notifications.at(-1).detail, {
      layerId: 'flights',
      id: 'plane',
    });
    select(a.context, first, 'local-adsb');
    select(a.context, subject('Other layer'), 'local-datacenters');
    assert.equal(
      hosts[0].last(),
      null,
      'another layer selection clears only its scene readout',
    );
    assert.equal(hosts[1].last().title, 'Second camera');
    page.dispatchEvent(
      new CustomEvent('gev:entity-selection-cleared', {
        detail: { layerId: 'alpr-cameras' },
      }),
    );
    assert.equal(
      hosts[1].last().title,
      'Second camera',
      'unscoped page notifications cannot mutate scene readouts',
    );
  });

  test(`${makeHarness.name}: a handoff carries only the page selection and respects a clear between scenes`, (t) => {
    const {
      harnesses,
      services: [a, b],
      page,
    } = setup(t);
    const notifications = [];
    for (const type of ['gev:entity-selected', 'gev:entity-selection-cleared'])
      page.addEventListener(type, (event) => notifications.push(event.detail));
    const entity = subject('Retained camera');
    const record = select(a.context, entity);
    const selectedAt = page.__gevContextStore.selectedAt;
    const retained = a.destroy({ retainSelection: true });
    assert.equal(retained, record);
    assert.equal(getSelectedEntityContext(), record);
    assert.equal(page.__gevContextStore.selectedAt, selectedAt);
    const host = recorder();
    const next = createSceneServices(harnesses[0].engine, {
      trackedOverlay: host,
      retainedSelection: retained,
    });
    next.trackedReadout.init();
    assert.equal(next.context.getSelectedEntityContext(), record);
    assert.equal(host.last().title, 'Retained camera');
    assert.equal(b.context.getSelectedEntityContext(), null);
    assert.equal(notifications.length, 1, 'handoff is not another selection');
    const cleared = next.destroy({ retainSelection: true });
    context.clearSelectedEntityContextForLayer('alpr-cameras');
    const replacement = createSceneServices(harnesses[0].engine, {
      retainedSelection: cleared,
    });
    assert.equal(replacement.context.getSelectedEntityContext(), null);
    assert.equal(getSelectedEntityContext(), null);
    assert.equal(notifications.at(-1).reason, 'deliberate');
  });

  test(`${makeHarness.name}: application scene release and creation carry the session selection`, async (t) => {
    const original = globalThis.window;
    globalThis.window = new EventTarget();
    const first = makeHarness();
    const second = makeHarness();
    const session = createLayerSession();
    session.chrome.sceneChrome = true;
    session.operations = {
      surface: {
        groundFloor: {
          clearMeshFloorCells() {},
          setMeshFloorPreferred() {},
        },
      },
    };
    session.handoff = {
      layers: new Map(),
      cameraOwners: [],
      selection: null,
      director: null,
    };
    const cleanups = [];
    const open = (engine) =>
      createApplicationScene({
        layerSession: session,
        defer: (cleanup) => cleanups.push(cleanup),
        rendererCache: {
          acquire: async () => ({
            engine,
            mapStackController: { getActiveId: () => 'osm' },
          }),
        },
      });
    t.after(() => {
      while (cleanups.length) cleanups.pop()();
      first.destroy();
      second.destroy();
      globalThis.window = original;
    });
    const outgoing = await open(first.engine);
    const record = select(outgoing.services.context, subject());
    cleanups.pop()();
    assert.equal(session.handoff.selection, record);
    assert.equal(getSelectedEntityContext(), record);
    const incoming = await open(second.engine);
    assert.equal(session.handoff.selection, null);
    assert.equal(incoming.services.context.getSelectedEntityContext(), record);
    assert.equal(getSelectedEntityContext(), record);
    session.lifetime.abort();
    cleanups.pop()();
    assert.equal(
      getSelectedEntityContext(),
      null,
      'page teardown does not retain selection',
    );
  });

  test(`${makeHarness.name}: terminal teardown rejects stale notifications and parked reattachment gets fresh state`, (t) => {
    const {
      harnesses,
      services: [a, b],
      hosts,
      page,
    } = setup(t);
    const first = subject('Old camera');
    const second = subject('Sibling camera');
    select(a.context, first);
    const siblingRecord = select(b.context, second);
    let pageEvents = 0;
    page.addEventListener('gev:entity-selected', () => pageEvents++);
    a.destroy();
    a.destroy();
    const calls = hosts[0].calls.length;
    a.trackedReadout.init();
    a.trackedReadout.refresh(first);
    select(a.context, first);
    a.context.events.dispatchEvent(
      new CustomEvent('gev:entity-selected', {
        detail: { entity: first, layerId: 'alpr-cameras' },
      }),
    );
    a.context.publishAwareness('gev:awareness-subject-selected', {
      layerId: 'flights',
    });
    assert.equal(hosts[0].calls.length, calls);
    assert.equal(pageEvents, 0);
    assert.equal(getSelectedEntityContext(), siblingRecord);
    assert.equal(b.trackedReadout.activeId(), 'shared-id');
    const nextHost = recorder();
    const next = createSceneServices(harnesses[0].engine, {
      trackedOverlay: nextHost,
    });
    next.trackedReadout.init();
    assert.notEqual(next.trackedReadout, a.trackedReadout);
    assert.equal(next.trackedReadout.activeId(), null);
    select(next.context, subject('New camera'));
    a.context.clearSelectedEntityContextForLayer('alpr-cameras');
    a.context.removeEntityContextsForLayer('alpr-cameras');
    a.destroy();
    assert.equal(nextHost.last().title, 'New camera');
    assert.equal(hosts[1].last().title, 'Sibling camera');
    b.destroy();
    assert.equal(nextHost.last().title, 'New camera');
  });
}

for (const makeHarness of GROUND_HARNESSES) {
  test(`${makeHarness.name}: Local ADS-B publishes and refreshes through its attached readout`, async (t) => {
    const original = globalThis.window;
    globalThis.window = new EventTarget();
    const first = makeHarness();
    const second = makeHarness();
    const a = createSceneServices(first.engine);
    const b = createSceneServices(second.engine);
    a.trackedReadout.init();
    b.trackedReadout.init();
    const hosts = [recorder(), recorder()];
    const scenes = [a, b];
    // Observe publications while keeping the production overlay as the destination.
    scenes.forEach((scene, i) => {
      const setEntries = scene.overlay.setEntries;
      scene.overlay.setEntries = (...args) => {
        hosts[i].setEntries(...args);
        return setEntries(...args);
      };
    });
    const layout = aircraftAtlasLayout();
    let changed;
    const aircraft = {
      icao: 'abc123',
      callsign: 'LOCAL1',
      lat: 0,
      lon: 0,
      altitudeFt: 10000,
      groundSpeedKt: 180,
      trackDeg: 0,
      verticalRateFpm: 0,
      lastPositionAt: 100000,
      lastMessageAt: 100000,
      messageCount: 12,
      band: '1090',
      source: 'webusb',
    };
    const snapshot = () => ({
      connected: true,
      mode: 'adsb',
      status: 'ready',
      aircraft: [aircraft],
    });
    const layer = createLocalAdsbLayer({
      receiver: {
        getState: snapshot,
        subscribe(fn) {
          changed = fn;
          return () => {};
        },
        async setMode() {},
      },
      now: () => 100000,
      services: {
        context,
        picking,
        selection,
        render: { governorRequestRender() {} },
        overlays: { refreshReadout: refreshTrackedReadout },
        renderer: {
          create: ({ engine }) =>
            createLocalAdsbDisplay(engine, {
              drawAtlas: async () => ({
                canvas: { width: layout.width, height: layout.height },
                cells: layout.cells,
              }),
            }),
        },
      },
    });
    t.after(() => {
      layer.destroy();
      a.destroy();
      b.destroy();
      first.destroy();
      second.destroy();
      globalThis.window = original;
    });
    layer.init(null, { engine: first.engine });
    await layer.enable();
    assert.equal(layer.selectById('abc123'), true);
    assert.equal(a.trackedReadout.activeId(), 'local-adsb:abc123');
    assert.equal(b.trackedReadout.activeId(), null);
    assert.equal(a.overlay.getDiagnostics().entryCount, 1);
    aircraft.callsign = 'LOCAL2';
    changed(snapshot());
    await layer.update();
    assert.equal(hosts[0].last().title, 'LOCAL2');
    layer.detachRenderer();
    assert.equal(a.trackedReadout.activeId(), null);
    await layer.attachRenderer({ engine: second.engine });
    assert.equal(layer.selectById('abc123'), true);
    assert.equal(b.trackedReadout.activeId(), 'local-adsb:abc123');
    assert.equal(a.trackedReadout.activeId(), null);
    aircraft.callsign = 'LOCAL3';
    changed(snapshot());
    await layer.update();
    assert.equal(hosts[1].last().title, 'LOCAL3');
    a.destroy();
    assert.equal(b.overlay.getDiagnostics().entryCount, 1);
    layer.disable();
    assert.equal(b.trackedReadout.activeId(), null);
  });

  test(`${makeHarness.name}: a selected fire survives scene handoff before viewport restoration`, async (t) => {
    const originalWindow = globalThis.window;
    const originalDocument = globalThis.document;
    globalThis.window = new EventTarget();
    globalThis.document = {
      createElement: () => ({
        getContext: () => ({
          createRadialGradient: () => ({ addColorStop() {} }),
          fillRect() {},
        }),
        toDataURL: () => 'fire-glow',
      }),
    };
    const first = makeHarness();
    const second = makeHarness();
    const session = createLayerSession();
    session.chrome.sceneChrome = true;
    session.operations = {
      surface: {
        groundFloor: {
          clearMeshFloorCells() {},
          setMeshFloorPreferred() {},
        },
      },
    };
    session.handoff = {
      layers: new Map(),
      cameraOwners: [],
      selection: null,
      director: null,
    };
    const cleanups = [];
    const open = (engine) =>
      createApplicationScene({
        layerSession: session,
        defer: (cleanup) => cleanups.push(cleanup),
        rendererCache: {
          acquire: async () => ({
            engine,
            mapStackController: { getActiveId: () => 'osm' },
          }),
        },
      });
    const fire = {
      index: 0,
      lat: 37.77,
      lon: -122.42,
      acqMs: 1792137600000,
      satellite: 'N20',
      sensor: 'VIIRS',
      frp: 999,
      confidence: 0.9,
    };
    const id = 'firms:37.7700:-122.4200:1792137600000:N20';
    let snapshot = null;
    const notifications = [];
    for (const type of ['gev:entity-selected', 'gev:entity-selection-cleared'])
      window.addEventListener(type, (event) => notifications.push(event.type));
    const layer = createFirmsHeatmapLayer({
      id: 'local-firms',
      name: 'Fires',
      feed: {
        getSnapshot: async () => {
          assert.ok(snapshot, 'a retained fire needs no refetch');
          return snapshot;
        },
      },
      services: {
        context,
        picking,
        render: { governorRequestRender() {} },
        focus: { requestWorldFocus() {} },
        anchors: {
          fireAnchorHeight: () => 0,
          warmFireAnchorFloors: async () => false,
        },
      },
      overlayHost: recorder(),
      renderer: {
        create: ({ engine, id }) =>
          createFirmsDisplay(engine, {
            id,
            loadImage: async () => ({ width: 16, height: 16 }),
            createCanvas: () => ({ getContext: () => ({ drawImage() {} }) }),
          }),
      },
    });
    t.after(() => {
      layer.destroy();
      session.lifetime.abort();
      while (cleanups.length) cleanups.pop()();
      first.destroy();
      second.destroy();
      globalThis.window = originalWindow;
      globalThis.document = originalDocument;
    });
    const outgoing = await open(first.engine);
    outgoing.services.trackedReadout.init();
    layer._bindInteractionForTest(first.engine, [fire]);
    first.click({ id: 'firms-0' });
    assert.equal(window.__gevContextStore.selectedEntityId, id);
    const selectedAt = window.__gevContextStore.selectedAt;
    layer.detachRenderer();
    cleanups.pop()();
    assert.equal(session.handoff.selection.id, id);
    const incoming = await open(second.engine);
    let restoreView;
    const attachmentContext = createLayerSceneContext({
      engine: second.engine,
      viewRestored: new Promise((resolve) => {
        restoreView = resolve;
      }),
    });
    layer.attachRenderer(attachmentContext);
    // The shell initializes readouts before restoring the camera and resuming layers.
    incoming.services.trackedReadout.init();
    assert.equal(window.__gevContextStore.selectedEntityId, id);
    assert.equal(window.__gevContextStore.selectedAt, selectedAt);
    second.engine.camera.setView({
      destination: geo.cartesian3.fromDegrees(fire.lon, fire.lat, 100_000),
    });
    restoreView();
    await attachmentContext.viewRestored;
    layer.resumeViewport();
    assert.equal(layer.getSelectedInfo().id, id);
    assert.equal(incoming.services.context.getSelectedEntityContext().id, id);
    assert.equal(getSelectedEntityContext().id, id);
    assert.equal(window.__gevContextStore.selectedAt, selectedAt);
    // Refreshing top-N context records must also keep a selected weaker fire.
    const row = {
      ...fire,
      acqDate: '2026-10-16',
      acqTime: '0800',
      instrument: 'VIIRS',
      confidence: 'h',
    };
    snapshot = {
      fires: [
        row,
        ...Array.from({ length: CONTEXT_TOP_N }, (_, index) => ({
          ...row,
          lat: fire.lat + (index + 1) * 0.001,
          frp: fire.frp + index + 1,
        })),
      ],
    };
    await layer.update();
    assert.equal(layer.getStats().error, null);
    assert.equal(window.__gevContextStore.selectedEntityId, id);
    assert.equal(getSelectedEntityContext().id, id);
    assert.equal(window.__gevContextStore.selectedAt, selectedAt);
    assert.deepEqual(notifications, ['gev:entity-selected']);
    layer.disable();
    assert.equal(window.__gevContextStore.selectedEntityId, null);
  });

  test(`${makeHarness.name}: a selected ALPR camera survives a switch and refreshes the incoming card`, (t) => {
    const original = globalThis.window;
    globalThis.window = new EventTarget();
    const first = makeHarness();
    const second = makeHarness();
    const hosts = [recorder(), recorder()];
    const a = createSceneServices(first.engine, { trackedOverlay: hosts[0] });
    a.trackedReadout.init();
    const record = {
      id: 'alpr:9000079',
      latitude: 30,
      longitude: -97,
      osmId: 9000079,
      operator: 'Retained operator',
    };
    const state = {
      enabled: true,
      selectedId: null,
      lastAnchorSampleAt: 0,
      renderRevision: 0,
      records: [record],
      recordById: new Map([[record.id, record]]),
    };
    function displayFor(engine) {
      engine.surface.terrainHeight = () => 150;
      engine.camera.setView({
        destination: geo.cartesian3.fromDegrees(-97, 30, 2000),
      });
      const display = createAlprDisplay(engine, {
        state,
        source: { label: 'Fixture' },
        services: {
          context,
          render: { governorRequestRender() {} },
          groundFloor: { cachedGroundFloor: () => 150 },
          overlays: { refreshReadout: refreshTrackedReadout },
        },
      });
      display.init({ onMove() {} });
      display.setVisible(true);
      display.renderRecords();
      return display;
    }
    const outgoing = displayFor(first.engine);
    let incoming, b;
    t.after(() => {
      outgoing.destroy();
      incoming?.destroy();
      a.destroy();
      b?.destroy();
      first.destroy();
      second.destroy();
      globalThis.window = original;
    });
    outgoing.selectRecord(record.id);
    const oldEntity = getSelectedEntityContext().entity;
    outgoing.destroy({ retainContext: true });
    const retainedSelection = a.destroy({ retainSelection: true });
    assert.equal(window.__gevContextStore.selectedEntityId, record.id);
    b = createSceneServices(second.engine, {
      retainedSelection,
      trackedOverlay: hosts[1],
    });
    incoming = displayFor(second.engine);
    // The shell initializes its readout after the layer's scene attachment.
    b.trackedReadout.init();
    assert.equal(state.selectedId, record.id);
    assert.equal(window.__gevContextStore.selectedEntityId, record.id);
    const selected = b.context.getSelectedEntityContext();
    assert.equal(selected.id, record.id);
    assert.equal(getSelectedEntityContext(), selected);
    assert.notEqual(selected.entity, oldEntity);
    assert.equal(hosts[1].last().id, record.id);
    assert.equal(a.trackedReadout.activeId(), null);
    const moved = { x: 6378000, y: 0, z: 100 };
    selected.entity.displayPosition = moved;
    assert.equal(hosts[1].last().position(), moved);
    context.clearSelectedEntityContextForLayer('alpr-cameras');
    assert.equal(b.context.getSelectedEntityContext(), null);
    assert.equal(hosts[1].last(), null);
    assert.equal(window.__gevContextStore.selectedEntityId, null);
  });

  test(`${makeHarness.name}: ALPR selection and refresh keep their attachment after replacement`, (t) => {
    const original = globalThis.window;
    globalThis.window = new EventTarget();
    const h = makeHarness();
    h.engine.surface.terrainHeight = () => 150;
    h.engine.camera.setView({
      destination: geo.cartesian3.fromDegrees(-97, 30, 2000),
    });
    const host = recorder();
    const a = createSceneServices(h.engine, { trackedOverlay: host });
    a.trackedReadout.init();
    const records = [
      {
        id: 'alpr:0',
        latitude: 30,
        longitude: -97,
        osmId: 0,
        operator: 'First operator',
      },
    ];
    const state = {
      enabled: true,
      selectedId: null,
      lastAnchorSampleAt: 0,
      renderRevision: 0,
      records,
      recordById: new Map(records.map((r) => [r.id, r])),
    };
    const display = createAlprDisplay(h.engine, {
      state,
      source: { label: 'Fixture' },
      services: {
        context,
        render: { governorRequestRender() {} },
        groundFloor: { cachedGroundFloor: () => 150 },
        overlays: { refreshReadout: refreshTrackedReadout },
      },
    });
    let next;
    t.after(() => {
      display.destroy();
      a.destroy();
      next?.destroy();
      h.destroy();
      globalThis.window = original;
    });
    display.init({ onMove() {} });
    display.setVisible(true);
    display.renderRecords();
    display.selectRecord('alpr:0');
    assert.equal(a.trackedReadout.activeId(), 'alpr:0');
    const before = host.calls.length;
    records[0] = { ...records[0], operator: 'Changed operator' };
    state.recordById.set(records[0].id, records[0]);
    display.renderRecords();
    assert.ok(
      host.calls.length > before,
      'the active card receives its refreshed model',
    );
    assert.ok(
      host.last().details.some((line) => line.includes('CHANGED OPERATOR')),
    );
    next = createSceneServices(h.engine);
    next.trackedReadout.init();
    select(next.context, subject('Replacement'));
    display.clearSelection();
    display.selectRecord('alpr:0');
    assert.equal(
      next.trackedReadout.activeId(),
      'shared-id',
      'the old display cannot publish into the replacement context',
    );
  });
}
