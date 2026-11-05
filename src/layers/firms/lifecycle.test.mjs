import test from 'node:test';
import assert from 'node:assert/strict';
import { createFirmsState } from './state.js';
import { createLifecycle } from './lifecycle.js';
test('destroy releases the owned generated PNG cache even when the layer facade remains referenced', () => {
  const state = createFirmsState({ services: {}, config: {} });
  state.glowSpriteCache.set(
    'red:28',
    'data:image/png;base64,' + 'x'.repeat(65536),
  );
  const noop = () => {};
  const lifecycle = createLifecycle({
    layerState: state,
    services: {
      picking: { unregisterPickOwner: noop },
      context: { clearSelectedEntityContextForLayer: noop },
    },
    components: {
      viewport: { removeLodWatcher: noop, removeMoveEndWatcher: noop },
      selection: { removeClickHandler: noop, clearContextRegistrations: noop },
      rendering: { removeDetectionCollections: noop },
    },
    config: {
      id: 'firms-cache',
      overlayHost: { clearSource: noop, setVisible: noop },
    },
  });
  lifecycle.methods.destroy();
  assert.equal(state.glowSpriteCache.size, 0);
  lifecycle.methods.destroy();
  assert.equal(state.glowSpriteCache.size, 0);
});
