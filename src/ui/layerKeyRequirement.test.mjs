// NAMING THE MISSING KEY — a control a provider key holds back must say which
// key, or the operator is left with a dead row and no next step. The three
// halves are pinned here: the layer declares which key it needs and reports
// that it is missing, the manager publishes that on the row, and the panel
// turns the pair into guidance that names the environment variable.
//
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layerKeyRequirementTooltip } from './layerPanel.js';
import { DataLayerManager } from '../data/manager.js';
import { KEY_SETUP_KEYS } from '../keySetupCore.mjs';
import { createFirmsState } from '../layers/firms/state.js';
import { createModel } from '../layers/firms/model.js';
import { createQueries } from '../layers/firms/queries.js';

/** The fire layer's query half, with the scene services it never calls stubbed. */
function firmsQueries() {
  const services = {
    render: { governorRequestRender() {} },
    anchors: { fireAnchorHeight: () => 0, FIRE_ANCHOR_LIFT_M: 0 },
    overlays: {},
    sprites: {},
    context: {},
    picking: {},
    focus: {},
  };
  const config = { id: 'local-firms', name: 'FIRMS Active Fires' };
  const layerState = createFirmsState({ services, config });
  const components = {};
  const context = {
    layerState,
    services,
    components,
    config,
    feed: { getSnapshot: async () => ({}) },
  };
  components.model = createModel(context);
  return { layerState, methods: createQueries(context).methods };
}

test('the fire layer names the key it needs and reports when it is missing', () => {
  const { layerState, methods } = firmsQueries();
  assert.equal(methods.requiresKeyId, 'firms');
  assert.ok(
    KEY_SETUP_KEYS.some((entry) => entry.id === 'firms'),
    'the declared id must exist in the key registry',
  );

  assert.equal(
    methods.getStats().keyRequired,
    false,
    'no key is missing until the feed says so',
  );

  layerState._keyRequired = true;
  const stats = methods.getStats();
  assert.equal(stats.keyRequired, true);
  assert.equal(
    stats.error,
    'KEY REQUIRED',
    'the human string the row already shows is unchanged',
  );
});

test('the guidance names the environment variable and where to set it', () => {
  const text = layerKeyRequirementTooltip({
    requiresKeyId: 'firms',
    stats: { keyRequired: true },
  });
  assert.match(text, /FIRMS_MAP_KEY/);
  assert.match(text, /Provider Settings/);
});

test('guidance appears only for a key that is actually missing and actually named', () => {
  for (const layer of [
    undefined,
    {},
    { requiresKeyId: 'firms' },
    { requiresKeyId: 'firms', stats: {} },
    { requiresKeyId: 'firms', stats: { keyRequired: false } },
    // Truthy but not the boolean the contract asks for: a stray string must
    // not be read as "the key is missing".
    { requiresKeyId: 'firms', stats: { keyRequired: 'yes' } },
    // Missing key, but the layer never said which one.
    { stats: { keyRequired: true } },
    { requiresKeyId: '', stats: { keyRequired: true } },
    { requiresKeyId: '   ', stats: { keyRequired: true } },
    // An id the registry does not know must not be guessed at: guidance
    // naming the wrong variable sends the operator to the wrong provider.
    { requiresKeyId: 'not-a-provider', stats: { keyRequired: true } },
  ]) {
    assert.equal(
      layerKeyRequirementTooltip(layer),
      '',
      `${JSON.stringify(layer)} must produce no guidance`,
    );
  }
});

test('the manager publishes the declared key id on the row', async () => {
  const manager = new DataLayerManager();
  const base = {
    name: 'Test layer',
    icon: '•',
    source: 'Test',
    init() {},
    enable() {},
    disable() {},
    update() {},
    destroy() {},
  };
  manager.register({
    ...base,
    id: 'gated',
    requiresKeyId: 'firms',
    getStats: () => ({ count: 0, keyRequired: true }),
  });
  manager.register({
    ...base,
    id: 'ungated',
    getStats: () => ({ count: 3, lastUpdate: Date.now() }),
  });

  // The manager consults a layer's getStats() only once it is initialized, so
  // the rows are read the way the panel reads them: after the layers are on.
  await manager.setEnabled('gated', true);
  await manager.setEnabled('ungated', true);

  const rows = manager.getAll();
  const gated = rows.find((row) => row.id === 'gated');
  const ungated = rows.find((row) => row.id === 'ungated');
  assert.equal(gated.requiresKeyId, 'firms');
  assert.equal(gated.stats.keyRequired, true);
  assert.match(layerKeyRequirementTooltip(gated), /FIRMS_MAP_KEY/);

  assert.equal(
    ungated.requiresKeyId,
    null,
    'a layer that needs no key declares none',
  );
  assert.equal(layerKeyRequirementTooltip(ungated), '');
});
