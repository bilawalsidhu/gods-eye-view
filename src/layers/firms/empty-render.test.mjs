import test from 'node:test';
import assert from 'node:assert/strict';
import { createRendering } from './rendering.js';

test('an empty snapshot clears sprites, cells, cards, picks and context registrations', () => {
  const calls = [];
  const state = {
    _dataSource: { entities: { removeAll: () => calls.push('cells') } },
    _viewer: {},
    _fires: [],
    _billboards: { removeAll: () => calls.push('sprites') },
    _pickIndexById: new Map([['old', {}]]),
    _fireByCardId: new Map([['old', {}]]),
    _cullPositions: [{}],
    _labelCandidates: [{}],
    _cellCount: 1,
  };
  const rendering = createRendering({
    layerState: state,
    services: { anchors: {}, sprites: {} },
    config: {},
    components: {
      cards: { rebuildAmbientLabels: () => calls.push('cards') },
      selection: {
        refreshContextRegistrations: (fires) => {
          assert.deepEqual(fires, []);
          calls.push('contexts');
        },
      },
    },
  });
  assert.equal(rendering.renderCurrentLod(true), true);
  assert.deepEqual(calls, ['cells', 'sprites', 'cards', 'contexts']);
  assert.equal(state._cellCount, 0);
  assert.equal(state._pickIndexById.size, 0);
  assert.equal(state._fireByCardId.size, 0);
  assert.deepEqual(state._cullPositions, []);
  assert.deepEqual(state._labelCandidates, []);
});
