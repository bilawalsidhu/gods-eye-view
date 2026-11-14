import assert from 'node:assert/strict';
import test from 'node:test';
import { createControls } from './controls.js';
import { createState } from './state.js';
import { NO_IMAGERY_HOST } from '../weather/imageryHost.js';

/** A land layer showing a loaded year on a map whose globe is `globeShown`. */
function shownYear(globeShown) {
  const state = createState();
  state.viewer = { scene: { globe: { show: globeShown } } };
  state.enabled = true;
  state.status = 'ok';
  state.date = '2025-06-01';
  state.latest = '2025-12-01';
  const strip = { dates: ['2025-06-01'], position: 0, layers: [{}] };
  state.filmstrip = strip;
  const { methods } = createControls({ state, services: {}, parts: {} });
  return { state, strip, methods };
}

test('a globe map reports the shown year as active', () => {
  const stats = shownYear(true).methods.getStats();
  assert.equal(stats.count, 1);
  assert.equal(stats.error, null);
  assert.notEqual(stats.statusMessage, NO_IMAGERY_HOST);
});

test('a map that hides the globe says so instead of reporting ready', () => {
  // Photorealistic 3D tiles hide the globe, and the frames live in the globe's
  // imagery layers, so they are loaded but nobody can see them.
  const { state, strip, methods } = shownYear(false);
  const stats = methods.getStats();
  assert.equal(stats.count, 0);
  assert.equal(stats.error, NO_IMAGERY_HOST);
  assert.equal(stats.statusMessage, NO_IMAGERY_HOST);
  // The year stays loaded, so a globe map shows it again without a refetch.
  assert.equal(state.filmstrip, strip);
  state.viewer.scene.globe.show = true;
  assert.equal(methods.getStats().count, 1);
});

test('a switched-off layer on a hidden globe still reads as off', () => {
  const { state, methods } = shownYear(false);
  state.enabled = false;
  state.status = 'idle';
  state.filmstrip = null;
  const stats = methods.getStats();
  assert.equal(stats.error, null);
  assert.notEqual(stats.statusMessage, NO_IMAGERY_HOST);
});
