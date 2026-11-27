import test from 'node:test';
import assert from 'node:assert/strict';
import { createControls } from './controls.js';
import { createState } from './state.js';

// The Data Layers row offers the one-shot nearby sites search while the
// layer is on.
function fixture() {
  const state = createState({ services: {} });
  let release;
  const loads = [];
  const parts = {
    ingestion: {
      loadInstallations: (options) => {
        loads.push(options?.searchPlaces);
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    },
  };
  const { methods } = createControls({
    state,
    services: {},
    parts,
    source: {},
  });
  const repaints = [];
  state.rowControlsListener = () => repaints.push(state.nearbySearchBusy);
  return { state, methods, loads, repaints, settle: () => release(true) };
}

test('the nearby sites search shows on the row only while the layer is on', () => {
  const { state, methods } = fixture();
  assert.equal(methods.getRowControls(), null);
  state.enabled = true;
  const chip = methods
    .getRowControls()
    .chips.find((entry) => entry.id === 'search-nearby');
  assert.ok(chip);
  assert.equal(chip.label, 'Search nearby sites');
  assert.equal(chip.action, true);
  assert.equal(chip.disabled, false);
});

test('one nearby search runs at a time, and the row repaints as it starts and settles', async () => {
  const { state, methods, loads, repaints, settle } = fixture();
  state.enabled = true;
  const chip = () => methods.getRowControls().chips[0];
  chip().onClick();
  assert.deepEqual(loads, [true], 'it asks for the one-shot search');
  assert.equal(chip().disabled, true);
  chip().onClick();
  assert.equal(loads.length, 1, 'a second press while busy is turned away');
  settle();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(chip().disabled, false);
  assert.deepEqual(repaints, [true, false]);
});

test('an observed position disables the search and invalidates a previously rendered action', () => {
  const { state, methods, loads } = fixture();
  state.enabled = true;
  const prior = methods.getRowControls().chips[0];
  state.contextAnchor = { latitude: 1, longitude: 2 };
  prior.onClick();
  methods.searchNearby();
  assert.equal(methods.getRowControls().chips[0].disabled, true);
  assert.deepEqual(loads, []);
});
