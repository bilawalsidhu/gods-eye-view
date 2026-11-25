// src/ui/views/mountApplicationViews.test.mjs — a page's view hosts render
// their views, and an application can leave views out, over happy-dom.
import '../../testSupport/registerDom.mjs';
import '../../testSupport/stubMgrs.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { nextTick } from 'vue';
import { createApplication } from 'gods-eye-view/application';
import { StyleManager } from 'gods-eye-view/ui/shell';
import { LayerLifecycle } from '../../data/lifecycle.js';
import { bindRenderer } from '../../render/rendererOf.js';
import { fakeInput } from '../../input/testDoubles.mjs';
import { fakeCameraPort } from '../../testSupport/fakeCameraPort.mjs';
import { configureApplicationServices } from '../../services/application.js';
import { createApplicationRequestServices } from '../../services/requests.js';
import { ShareLinkManager } from '../../sharelink.js';
import { LocationSearch } from '../location.js';
import { useEntityCardStore } from '../stores/entityCard.js';
import { LAYER_COUNTS_REFETCH_MS } from '../layerCounts.js';
import { applicationPinia } from '../vueRuntime.js';
import { mountApplicationViews } from './index.js';

function page(names) {
  document.body.replaceChildren();
  for (const name of names) {
    const host = document.createElement('div');
    host.className = 'gev-view';
    host.setAttribute('data-gev-view', name);
    document.body.append(host);
  }
}

const hostNames = () =>
  [...document.querySelectorAll('[data-gev-view]')].map((host) =>
    host.getAttribute('data-gev-view'),
  );

test('omitted views lose their hosts and the rest render', () => {
  page(['welcome', 'provider-settings']);
  mountApplicationViews(document, { omit: ['provider-settings'] });
  assert.deepEqual(hostNames(), ['welcome']);
  assert.equal(document.getElementById('key-setup-chip') === null, true);
  assert.ok(
    document.querySelector('[data-gev-view="welcome"]').children.length,
  );
});

test('a view an earlier call rendered is unmounted when a later call omits it', () => {
  page(['welcome', 'provider-settings']);
  mountApplicationViews(document);
  assert.ok(document.getElementById('key-setup-chip'));
  mountApplicationViews(document, { omit: ['provider-settings'] });
  assert.deepEqual(hostNames(), ['welcome']);
  assert.equal(document.getElementById('key-setup-chip') === null, true);
});

test('unknown view names are refused, in the page or in the omit list', () => {
  page([]);
  for (const name of ['toString', 'constructor'])
    assert.throws(
      () => mountApplicationViews(document, { omit: [name] }),
      /Unknown application view/,
    );
  page(['toString']);
  assert.throws(
    () => mountApplicationViews(document),
    /Unknown application view/,
  );
  assert.throws(
    () => mountApplicationViews(document, { omit: ['nope'] }),
    /Unknown application view: nope/,
  );
  page(['nope']);
  assert.throws(
    () => mountApplicationViews(document),
    /Unknown application view: nope/,
  );
});

test('createApplication leaves out the views its omitViews names', () => {
  page(['welcome', 'provider-settings']);
  const noop = () => ({});
  createApplication({
    createScene: noop,
    createControls: noop,
    createData: noop,
    createTools: noop,
    omitViews: ['provider-settings'],
  });
  assert.deepEqual(hostNames(), ['welcome']);
});

// Boot the stock Context host without WebGL or live layers. The custom
// factory supplies the normal shell service bag; standard controls build
// their own bag over the same fake renderer and pass the ordinary requests.
async function countInspector(t, requestServices, constructControls) {
  page(['context']);
  const host = document.querySelector('[data-gev-view="context"]');
  const viewer = { scene: {} };
  const input = fakeInput(viewer);
  const noop = () => {};
  const { port, setPose, emit } = fakeCameraPort({
    pose: { height: 20_000_000 },
  });
  const flyToBounds = t.mock.fn(noop);
  const unbind = bindRenderer(viewer, {
    camera: { ...port, setView: noop, cancelFlight: noop, flyToBounds },
    frame: { on: () => noop, requestRender: noop },
    globe: { weather: {} },
  });
  const services = {
    ShareLinkManager,
    LocationSearch,
    interruptCameraMotion: noop,
    CITY_POIS: {},
    flightsLayer: {},
    militaryFlightsLayer: {},
    satellitesLayer: {},
    cctvLayer: {},
    radioLayer: { endTuning: noop },
    IntelHUD: class {
      getVariant() {
        return 'tactical';
      }
      setVariant() {}
      setMode() {}
      attachDataManager() {}
      destroy() {}
    },
    CelestialRing: class {
      setEnabled() {}
      destroy() {}
    },
    OrbitController: class {
      stop() {}
    },
    initWorldOverlay: noop,
    subscribeWorldOverlayActions: () => noop,
    initDetection: noop,
    initTrackedReadout: noop,
    setDetectionStyle: noop,
    setDetectionTuning: noop,
    setDetectionModeByLabel: noop,
    setKeyholeFadeTuning: noop,
    getKeyholeFadeTuning: () => ({}),
    getDetectionTuning: () => ({ allocationStrategy: 'ELASTIC' }),
    getDetectionMode: () => 'OFF',
    isScopeMaskEnabled: () => false,
    isCelestialRingStyleSupported: () => false,
    getScopeMaskFeather: () => 0,
    getScopeTerminusOverride: () => null,
    governorRequestRender: noop,
    holdContinuousRender: noop,
    releaseContinuousRender: noop,
    destroyTrackedReadout: noop,
    destroyDetection: noop,
    destroyWorldOverlay: noop,
  };
  const app = createApplication({
    createScene: () => ({
      viewer,
      operations: {
        surface: { controlServices: {} },
        requests: requestServices,
      },
    }),
    createControls: async ({ scene, defer }) => {
      if (requestServices) {
        const makeControls =
          constructControls ??
          (await import('gods-eye-view/application/controls'))
            .createApplicationControls;
        return makeControls({
          scene,
          defer,
          services,
          catalog: {
            get: (id) =>
              id === 'wildlife-sightings'
                ? { subscribeSelection: () => noop }
                : { id, endTuning: noop },
          },
          loaderStatus: document.createElement('span'),
        });
      }
      const styleManager = new StyleManager(scene.viewer, { services });
      defer(() => styleManager.dispose());
      return { styleManager };
    },
    createData: noop,
    createTools: noop,
  });
  const stop = async () => {
    if (!host.isConnected) return;
    try {
      await app.destroy();
    } finally {
      mountApplicationViews(document, { omit: ['context'] });
      unbind();
      input.destroy();
    }
  };
  t.after(stop);
  const {
    controls: { styleManager },
  } = await app.start();
  return {
    host,
    styleManager,
    flyToBounds,
    stop,
    count: () =>
      host.querySelector('.view-context__tile[data-layer="satellites"] strong')
        ?.textContent,
    async show() {
      styleManager.setPanelCollapsed('global-context-panel', false);
      await new Promise((resolve) => setImmediate(resolve));
      await nextTick();
    },
    async hide() {
      styleManager.setPanelCollapsed('global-context-panel', true);
      await nextTick();
    },
    async point(lat, lon, height = 40_000) {
      setPose({ lat, lon, height });
      emit('moveEnd');
      await nextTick();
    },
  };
}

test('mounted Context updates Nearby and In View when the shell replaces its data manager', async (t) => {
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response(null, { status: 503 }),
  );
  const { host, styleManager, point, show } = await countInspector(t);
  async function attach(name, kinds = []) {
    const id = kinds.length ? 'flights' : 'local-dams';
    const rows = kinds.length
      ? kinds.map((aircraftClass, index) => ({
          id: String(index),
          callsign: `${name}-${index}`,
          aircraftClass,
          lat: 47.6 + index,
          lon: -122.3,
        }))
      : [{ id: 'dam', name, lat: 47.6, lon: -122.3 }];
    const manager = new LayerLifecycle();
    manager.register({
      id,
      name: kinds.length ? 'Live Flights' : 'Dams',
      init() {},
      enable() {},
      update() {},
      disable() {},
      getStats: () => ({ count: rows.length, lastUpdate: 1 }),
      getAnalystRecords: () => rows,
    });
    manager.finalizeRegistrations([{ id, disposition: 'enabled-only' }]);
    assert.equal(await manager.setEnabled(id, true), true);
    styleManager.attachDataManager(manager);
    await new Promise((resolve) => setImmediate(resolve));
  }
  const nearby = () =>
    host.querySelector('.nearby-lists [data-row-key]')?.textContent;
  const inView = () =>
    host.querySelector('.view-context__blocks [data-row-key]')?.textContent;

  await attach('First dam');
  await show();
  await point(47.6, -122.3);
  assert.match(nearby(), /First dam/);
  await attach('Second dam');
  assert.match(nearby(), /Second dam/);

  await point(47.6, -122.3, 6_000_000);
  assert.match(inView(), /Second dam/);
  await attach('Third dam');
  assert.match(inView(), /Third dam/);

  const breakdown = () =>
    host.querySelector('.view-context__bar')?.getAttribute('aria-label');
  await attach('FIRST', ['airliner', 'helicopter']);
  assert.match(breakdown(), /Airliners 1.*Helicopters 1/);
  await attach('SECOND', ['bizjet', 'fastjet']);
  assert.match(inView(), /SECOND/);
  assert.match(breakdown(), /Business jets 1.*Fast jets 1/);
});

function attachSatellites(styleManager) {
  const manager = new LayerLifecycle();
  manager.register({
    id: 'satellites',
    name: 'Satellites',
    init() {},
    enable() {},
    update() {},
    disable() {},
  });
  manager.finalizeRegistrations([
    { id: 'satellites', disposition: 'enabled-only' },
  ]);
  styleManager.attachDataManager(manager);
}

test('stock Context uses the configured layer counts through either public shell path', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const countResponse = (count) => ({
    counts: [{ layerId: 'satellites', count, at: Date.now() }],
  });
  const fetchStub = t.mock.method(globalThis, 'fetch', async (url) =>
    url === '/api/layer-counts'
      ? Response.json(countResponse(1900))
      : new Response(null, { status: 503 }),
  );
  const first = t.mock.fn(async () => countResponse(1272));
  const releaseFirst = configureApplicationServices({
    layerCounts: { getCounts: first },
  });
  t.after(releaseFirst);
  const direct = await countInspector(t);
  attachSatellites(direct.styleManager);
  await direct.show();
  assert.equal(direct.count(), '1,272');
  assert.equal(
    document.querySelector(
      '.view-context__suggest-open, .view-context__pointer',
    ),
    null,
    'there is no link to a layer panel the host did not mount',
  );
  assert.equal(first.mock.callCount(), 1);

  await direct.hide();
  await direct.show();
  assert.equal(direct.count(), '1,272');
  assert.equal(
    first.mock.callCount(),
    1,
    'same-source reopening keeps its cooldown',
  );
  await direct.hide();

  await direct.stop();
  releaseFirst();
  t.mock.timers.tick(LAYER_COUNTS_REFETCH_MS);

  const ordinary = t.mock.fn(async () => countResponse(9999));
  const configured = t.mock.fn(async () => Response.json(countResponse(1400)));
  const adapter = createApplicationRequestServices({
    fetchImpl: configured,
    endpoints: { layerCounts: '/host/counts' },
  }).layerCounts;
  t.after(configureApplicationServices({ layerCounts: adapter }));
  const standard = await countInspector(t, {
    layerCounts: { getCounts: ordinary },
  });
  attachSatellites(standard.styleManager);
  await standard.show();
  assert.equal(standard.count(), '1,400');
  assert.equal(configured.mock.callCount(), 1);
  assert.equal(configured.mock.calls[0].arguments[0], '/host/counts');
  assert.equal(ordinary.mock.callCount(), 0);
  assert.ok(
    !fetchStub.mock.calls.some(
      ({ arguments: [url] }) => url === '/api/layer-counts',
    ),
  );
});

test('stock controls use host weather in both the Inspector and the card', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fetchStub = t.mock.method(
    globalThis,
    'fetch',
    async () => new Response(null, { status: 503 }),
  );
  const conditions = (temperatureC) => ({
    weather: { temperatureC, weatherCode: 0 },
  });
  const pending = Promise.withResolvers();
  const weather = {
    getConditions: t.mock.fn(async (lat) => {
      if (lat === 47.5) return conditions(15);
      if (lat === 47.6) return pending.promise;
      return lat === 47.7 ? conditions(24) : null;
    }),
  };
  const regional = { getBrief: t.mock.fn(async () => conditions(15)) };
  const scoped = t.mock.fn(async () => conditions(9));
  t.after(configureApplicationServices({ weather: { getConditions: scoped } }));
  const inspector = await countInspector(t, { weather, regional });
  const advance = async (ms) => {
    t.mock.timers.tick(ms);
    await new Promise((resolve) => setImmediate(resolve));
    await nextTick();
  };
  const facts = ({ host }) =>
    host.querySelector('.view-context__tiles--facts').textContent;

  await inspector.show();
  await inspector.point(47.6, -122.3);
  await advance(400);
  assert.equal(weather.getConditions.mock.callCount(), 1);
  const first = weather.getConditions.mock.calls[0];
  const [lat, lon, { signal }] = first.arguments;
  assert.deepEqual([lat, lon], [47.6, -122.3]);
  assert.equal(first.this, weather);
  assert.equal(signal.aborted, false);

  const cards = useEntityCardStore(applicationPinia());
  assert.ok(
    cards.select({
      layerId: 'local-dams',
      id: 'host-site',
      label: 'Host site',
      lat: 47.5,
      lon: -122.4,
    }),
  );
  await nextTick();
  assert.equal(signal.aborted, true);
  pending.resolve(conditions(31));
  await advance(350);
  assert.match(
    inspector.host.querySelector('.spot-conditions').textContent,
    /15°C/,
  );
  assert.deepEqual(
    weather.getConditions.mock.calls[1].arguments.slice(0, 2),
    [47.5, -122.4],
  );

  await inspector.point(47.7, -122.3);
  inspector.host.querySelector('.entity-card__close').click();
  await nextTick();
  await advance(400);
  assert.match(facts(inspector), /24 °C/);
  assert.equal(
    inspector.host.querySelector('.view-context__weather-credit'),
    null,
  );

  await inspector.point(47.8, -122.3);
  await advance(400);
  assert.match(facts(inspector), /No weather reading here/);
  assert.equal(scoped.mock.callCount(), 0);
  assert.equal(regional.getBrief.mock.callCount(), 0);
  await inspector.stop();

  const { createStandaloneControls } =
    await import('../../standalone/controls.js');
  const standalone = await countInspector(
    t,
    { weather, regional },
    createStandaloneControls,
  );
  await standalone.show();
  await standalone.point(47.6, -122.3);
  await advance(400);
  assert.match(facts(standalone), /9 °C/);
  assert.equal(scoped.mock.callCount(), 1);
  assert.equal(weather.getConditions.mock.callCount(), 4);
  assert.ok(
    !fetchStub.mock.calls.some(({ arguments: [url] }) =>
      String(url).startsWith('/api/weather-effects'),
    ),
  );
});

test('the composed Inspector respects the host weather and regional readers', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fetchStub = t.mock.method(
    globalThis,
    'fetch',
    async () => new Response(null, { status: 503 }),
  );
  const { StyleManager: ComposedStyleManager } =
    await import('../composition.js');
  const conditions = (temperatureC) =>
    t.mock.fn(async (_lat, _lon, { signal }) => {
      assert.equal(signal.aborted, false);
      return { weather: { temperatureC, weatherCode: 0 } };
    });
  const weather = { getConditions: conditions(17) };
  const regional = conditions(21);
  for (const [requests, overrides, reader, temperature] of [
    [{ weather }, {}, weather.getConditions, '17 °C'],
    [{ weather }, { fetchSpotWeather: null }, regional, '21 °C'],
    [undefined, {}, regional, '21 °C'],
  ]) {
    const inspector = await countInspector(
      t,
      requests ?? {},
      ({ scene, services, defer }) => {
        const styleManager = new ComposedStyleManager(scene.viewer, {
          services: { ...services, fetchRegionalBrief: regional, ...overrides },
          requestServices: requests,
        });
        defer(() => styleManager.dispose());
        return { styleManager };
      },
    );
    await inspector.show();
    await inspector.point(47.6, -122.3);
    t.mock.timers.tick(400);
    await new Promise((resolve) => setImmediate(resolve));
    await nextTick();

    assert.equal(reader.mock.callCount(), 1);
    const [lat, lon] = reader.mock.calls[0].arguments;
    assert.deepEqual([lat, lon], [47.6, -122.3]);
    assert.ok(
      inspector.host
        .querySelector('.view-context__tiles--facts')
        .textContent.includes(temperature),
    );
    if (reader === weather.getConditions) {
      assert.equal(reader.mock.calls[0].this, weather);
      assert.equal(regional.mock.callCount(), 0);
    } else {
      assert.equal(weather.getConditions.mock.callCount(), 0);
    }
    await inspector.stop();
    reader.mock.resetCalls();
  }
  assert.ok(
    !fetchStub.mock.calls.some(({ arguments: [url] }) =>
      String(url).startsWith('/api/weather-effects'),
    ),
  );
});

test('re-enabling a layer at globe scale makes only its new rows selectable', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response(null, { status: 503 }),
  );
  const { host, styleManager, point, show, flyToBounds } =
    await countInspector(t);
  const id = 'local-dams';
  let current;
  const manager = new LayerLifecycle();
  manager.register({
    id,
    name: 'Dams',
    init() {},
    enable() {},
    update() {},
    disable() {},
    getStats: () => ({ count: 1, lastUpdate: 1 }),
    getAnalystRecords: () => [current],
  });
  manager.finalizeRegistrations([{ id, disposition: 'enabled-only' }]);
  async function setEnabled(enabled) {
    assert.equal(await manager.setEnabled(id, enabled), true);
    await nextTick();
  }
  const row = () => host.querySelector('.view-context__blocks [data-row-key]');
  current = { id: 'first', name: 'First dam', lat: 47.6, lon: -122.3 };
  await setEnabled(true);
  styleManager.attachDataManager(manager);
  await show();
  await point(47.6, -122.3, 6_000_000);
  assert.match(row().textContent, /First dam/);
  await setEnabled(false);
  assert.equal(row(), null);

  current = { id: 'second', name: 'Second dam', lat: 48.6, lon: -122.3 };
  await setEnabled(true);
  assert.match(row().textContent, /Second dam/);
  row().click();
  assert.equal(
    useEntityCardStore(applicationPinia()).card.identity.id,
    'second',
  );
  assert.equal(flyToBounds.mock.callCount(), 1);
});
