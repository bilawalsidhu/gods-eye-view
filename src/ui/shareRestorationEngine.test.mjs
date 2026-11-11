import test from 'node:test';
import assert from 'node:assert/strict';
import { layersNotOnThisEngine, ShareRestoration } from './shareRestoration.js';
import { createSessionHandoff } from '../app/sessionHandoff.js';
import { LayerLifecycle } from '../data/lifecycle.js';
import {
  LAYER_STATE_REGISTRY,
  REGISTERED_LAYER_IDS,
} from '../data/layerState.js';

test('the notice names the link layers this engine leaves out', () => {
  assert.deepEqual(
    layersNotOnThisEngine([
      { layerId: 'flights', phase: 'missing', targetEnabled: true },
      { layerId: 'ais-live-vessels', phase: 'missing', targetEnabled: true },
      { layerId: 'traffic', phase: 'missing', targetEnabled: false },
      { layerId: 'satellites', phase: 'settled', targetEnabled: true },
    ]),
    ['Live Flights', 'Live AIS Vessels'],
  );
  assert.deepEqual(layersNotOnThisEngine([]), []);
});

const viewportLayers = ['bikeshare', 'transit', 'traffic'];
for (const scenario of [
  {
    name: 'engine choice retains operational layers',
    enabled: true,
    outgoing: [],
    incoming: [],
    visit: false,
    expected: true,
  },
  {
    name: 'Back restores the visited disabled layers',
    enabled: true,
    outgoing: viewportLayers,
    incoming: [],
    visit: true,
    expected: false,
  },
  {
    name: 'Forward restores the visited enabled layers',
    enabled: false,
    outgoing: [],
    incoming: viewportLayers,
    visit: true,
    expected: true,
  },
]) {
  test(`share restoration: ${scenario.name}`, async (t) => {
    const manager = new LayerLifecycle(null);
    for (const id of REGISTERED_LAYER_IDS)
      manager.register({
        id,
        init() {},
        enable() {},
        update() {},
        disable() {},
        attachRenderer() {},
        setParams() {
          return true;
        },
      });
    manager.finalizeRegistrations(LAYER_STATE_REGISTRY);
    t.after(() => manager.destroyAll());
    for (const id of viewportLayers)
      await manager.setEnabled(id, scenario.enabled, { origin: 'user' });
    const models = viewportLayers.map((id) => manager.layers.get(id).module);
    const handoff = createSessionHandoff(
      { manager, director: null },
      { addressLayerIds: scenario.outgoing, visit: scenario.visit },
    );
    const restoration = new ShareRestoration({
      handoff,
      syncModels3d() {},
      showStatus() {},
    });
    t.after(() => restoration.destroy());
    restoration.attachLinks({
      parseInitialHash: () => ({
        layerState: { enabledLayerIds: scenario.incoming },
      }),
    });
    restoration.connect(manager);
    const results = await restoration._layerStateRestorePromise;
    assert.equal(
      restoration.handoff,
      null,
      'the coordinator consumes the handoff once',
    );
    for (const [index, id] of viewportLayers.entries()) {
      assert.equal(manager.isEffectivelyEnabled(id), scenario.expected, id);
      assert.equal(manager.layers.get(id).module, models[index]);
      const result = results.find((result) => result.layerId === id);
      assert.equal(result.succeeded, true, id);
      if (!scenario.visit) assert.equal(result.phase, 'retained', id);
    }
  });
}
