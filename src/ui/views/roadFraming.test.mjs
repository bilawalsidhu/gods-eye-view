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


test('a Local road picked from Nearby is framed below the all-roads height', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 503 }));
  const inspector = await countInspector(t, {});
  await inspector.show();
  await inspector.point(48.8566, 2.3522, 2_500);
  const cards = useEntityCardStore(applicationPinia());
  const record = { id: 'road-1', name: 'Local road', roadType: 'residential', lat: 48.8567, lon: 2.3523 };
  assert.ok(cards.select({ layerId: 'traffic', id: 'road-1', label: 'Local road', lat: record.lat, lon: record.lon, record }, { fly: true }));
  await nextTick();
  assert.equal(cards.card.kind, 'road segment');
  assert.equal(inspector.flyToBounds.mock.callCount(), 1);
  const { offset } = inspector.flyToBounds.mock.calls[0].arguments[1];
  const heightM = offset.range * Math.sin(Math.abs(offset.pitch));
  console.log('range', offset.range, 'pitch', offset.pitch, 'camera height m', Math.round(heightM));
  // src/layers/traffic/rendering.js visibleRoadsForAltitude keeps residential roads only at or below 5,000 m.
  assert.ok(heightM <= 5000, `camera height ${Math.round(heightM)} m drops residential roads`);
});
