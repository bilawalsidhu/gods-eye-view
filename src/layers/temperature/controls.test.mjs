import assert from 'node:assert/strict';
import test from 'node:test';
import { NO_IMAGERY_HOST } from '../../maps/imageryHost.js';
import { createControls } from './controls.js';
import { createState } from './state.js';

test('photoreal 3D tiles report hidden temperature imagery and recover on a globe', () => {
  const state = createState();
  state.enabled = true;
  state.status = 'ready';
  state.viewer = { scene: { globe: { show: false } } };
  state.filmstrip = { dates: ['2026-08-01'], layers: [{}], position: 0 };
  state.playback = { year: 2026 };
  state.date = '2026-08-01';
  state.latest = '2026-08-01';
  const { getStats } = createControls({ state, parts: {} }).methods;

  const hidden = getStats();
  assert.equal(hidden.status, 'idle');
  assert.equal(hidden.statusMessage, NO_IMAGERY_HOST);
  assert.equal(hidden.error, null, 'map-source guidance is not a data error');
  assert.equal(hidden.count, 0, 'a loaded but invisible year is not active');
  assert.equal(hidden.loading, false);
  assert.equal(state.filmstrip.layers.length, 1, 'the loaded year is retained');

  state.viewer.scene.globe.show = true;
  const visible = getStats();
  assert.equal(visible.status, 'ready');
  assert.equal(visible.count, 1);
  assert.notEqual(visible.statusMessage, NO_IMAGERY_HOST);
  assert.equal(visible.frameDate, '2026-08-01');
  assert.equal(visible.year, 2026);
});
