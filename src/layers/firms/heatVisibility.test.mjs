import test from 'node:test';
import assert from 'node:assert/strict';
import { createLifecycle } from './lifecycle.js';

test('reenabling an empty filtered layer never reveals the retained pre-filter heat raster', async () => {
  let shown = false;
  const noop = () => {};
  const layerState = {
    _enabled: false,
    _viewer: {},
    _dataSource: {},
    _fires: [],
    _loading: true,
    _pickIndexById: new Map(),
    _heatImagery: {
      setShow(v) {
        shown = v;
      },
    },
  };
  const lifecycle = createLifecycle({
    layerState,
    services: {
      picking: { registerPickOwner: noop, unregisterPickOwner: noop },
      sprites: { restoreSpriteOrderOnEnable: noop },
      context: { clearSelectedEntityContextForLayer: noop },
    },
    config: { id: 'local-firms', overlayHost: { setVisible: noop } },
    components: {
      rendering: { applyHandoffFade: noop },
      viewport: { installLodWatcher: noop, installMoveEndWatcher: noop },
      selection: { installClickHandler: noop },
    },
  });
  await lifecycle.methods.enable(layerState._viewer);
  assert.equal(
    shown,
    false,
    'empty current set must keep the old raster hidden while refresh is pending',
  );
  layerState._fires = [{ frp: null, confidence: null }];
  await lifecycle.methods.enable(layerState._viewer);
  assert.equal(shown, true, 'nonempty sets still resume their raster');
});
