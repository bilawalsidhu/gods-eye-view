// createApplicationControls hands the host's entity lookup through the
// shell to the search box.
import '../testSupport/registerDom.mjs';
import '../testSupport/stubMgrs.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplication } from 'gods-eye-view/application';
import { bindRenderer } from '../render/rendererOf.js';
import { fakeInput } from '../input/testDoubles.mjs';
import { fakeCameraPort } from '../testSupport/fakeCameraPort.mjs';
import { ShareLinkManager } from '../sharelink.js';
import { LocationSearch } from './location.js';
import { useOmnibarStore } from './stores/omnibar.js';
import { applicationPinia } from './vueRuntime.js';

async function shell(t, options) {
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response(null, { status: 503 }),
  );
  document.body.replaceChildren();
  const viewer = { scene: {} };
  const input = fakeInput(viewer);
  const noop = () => {};
  const { port } = fakeCameraPort({ pose: { height: 20_000_000 } });
  const unbind = bindRenderer(viewer, {
    camera: { ...port, setView: noop, cancelFlight: noop, flyToBounds: noop },
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
      operations: { surface: { controlServices: {} }, requests: {} },
    }),
    // The real hand-off: createApplicationControls builds the shell.
    createControls: async ({ scene, defer }) => {
      const { createApplicationControls } =
        await import('gods-eye-view/application/controls');
      return createApplicationControls({
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
        ...options,
      });
    },
    createData: noop,
    createTools: noop,
  });
  t.after(async () => {
    try {
      await app.destroy();
    } finally {
      unbind();
      input.destroy();
    }
  });
  await app.start();
  return useOmnibarStore(applicationPinia()).controls;
}

test("the shell gives the search box the host's entity lookup", async (t) => {
  const asked = [];
  const lookup = async (request) => {
    asked.push(request);
    return [{ kind: 'vessel', id: '353136000', lat: 1, lon: 2 }];
  };
  const controls = await shell(t, { entityLookup: lookup });
  const signal = new AbortController().signal;
  const answer = await controls.lookupEntities({ text: 'Ever Given', signal });
  assert.deepEqual(asked, [{ text: 'Ever Given', signal }]);
  assert.equal(answer[0].id, '353136000');
  assert.equal(typeof controls.findLookedUp, 'function');
});

test('without a lookup the search box has none', async (t) => {
  const controls = await shell(t, {});
  assert.equal(controls.lookupEntities, null);
});
