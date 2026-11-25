// Reproduction test (review 2026-11-25-1904); fixture copied from src/ui/views/mountApplicationViews.test.mjs.
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


async function openCard(t, requestServices, constructControls) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 503 }));
  const inspector = await countInspector(t, requestServices, constructControls);
  const advance = async (ms) => {
    t.mock.timers.tick(ms);
    await new Promise((resolve) => setImmediate(resolve));
    await nextTick();
  };
  await inspector.show();
  const cards = useEntityCardStore(applicationPinia());
  assert.ok(cards.select({ layerId: 'local-dams', id: 'host-site-' + Math.random(), label: 'Host site', lat: 12.34567 + Math.random(), lon: 45.6789 }));
  await nextTick();
  await advance(400);
  await advance(10);
  return inspector.host.querySelector('.spot-conditions')?.textContent || '';
}

test('a documented { signal } weather adapter renders card weather', async (t) => {
  const calls = [];
  const weather = {
    getConditions: t.mock.fn(async (_lat, _lon, { signal }) => {
      calls.push(signal);
      return { weather: { temperatureC: 17, weatherCode: 0 } };
    }),
  };
  const regional = { getBrief: t.mock.fn(async () => ({ weather: { temperatureC: 21, weatherCode: 0 } })) };
  const text = await openCard(t, { weather, regional });
  console.log('card text:', JSON.stringify(text.slice(0, 160)), 'weather calls', weather.getConditions.mock.callCount(), 'args', weather.getConditions.mock.calls.map((c) => c.arguments.length));
  assert.match(text, /17°C/);
});

test('control: adapter with a default options object renders card weather', async (t) => {
  const weather = {
    getConditions: t.mock.fn(async (_lat, _lon, { signal } = {}) => ({ weather: { temperatureC: 17, weatherCode: 0 } })),
  };
  const regional = { getBrief: t.mock.fn(async () => ({ weather: { temperatureC: 21, weatherCode: 0 } })) };
  const text = await openCard(t, { weather, regional });
  console.log('control text:', JSON.stringify(text.slice(0, 60)), 'third arg', weather.getConditions.mock.calls.map((c) => typeof c.arguments[2]));
  assert.match(text, /17°C/);
});
