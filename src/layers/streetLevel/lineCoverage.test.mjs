import assert from 'node:assert/strict';
import test from 'node:test';
import { createLineCoverage } from './lineCoverage.js';
import {
  coverageViewer,
  tileCentre,
} from '../../testSupport/streetLevelFakes.mjs';
import { until } from '../../testSupport/kartaViewFakes.mjs';

const TUNING = Object.freeze({
  maxTiles: 9,
  overviewMaxTiles: 0,
  maxSequences: 900,
  lineWidthPx: 2,
  overviewPointPx: 2,
  moveDebounceMs: 10,
  viewRangeMinM: 2_500,
  viewRangePerHeight: 10,
  viewNearM: 1_000,
});

/**
 * Line coverage over one tile holding one line, on a viewer looking down from
 * `height`. `fetchTile` answers with that line unless `fail` says otherwise.
 */
function setup(
  t,
  { zoomFor, messages = { rateLimited: 'busy' }, passes, fail } = {},
) {
  const centre = tileCentre(-121.4944, 38.5816);
  const viewer = coverageViewer(
    { lon: centre.lon, lat: centre.lat, height: 900 },
    t,
  );
  const state = {
    viewer,
    services: {},
    keyRequired: false,
    keyRejected: false,
    context: {
      getFilter: () => ({ pano: 'all', sinceMs: null }),
      isActive: () => true,
      notify() {},
      getSurface: () => 'draped',
      groundCaster: null,
      meshSampler: null,
    },
    coverage: {
      zoom: null,
      kind: null,
      tiles: new Map(),
      stale: new Map(),
      staleTimer: null,
      pending: new Map(),
      lastError: null,
      holdUntil: 0,
      holdTimer: null,
      debounceTimer: null,
      removeCameraListener: null,
      terrainReady: Promise.resolve(),
      hint: '',
    },
    sequence: { selectedId: null },
  };
  const asked = [];
  const coverage = createLineCoverage({
    state,
    fetchTile: async (tile) => {
      asked.push(tile);
      if (fail) throw fail;
      return {
        sequences: [
          {
            id: 'line-1',
            parts: [
              [
                [centre.lon - 0.001, centre.lat],
                [centre.lon + 0.001, centre.lat],
              ],
            ],
            capturedAt: 0,
            isPano: false,
          },
        ],
        overview: [],
      };
    },
    zoomFor:
      zoomFor ??
      ((height) =>
        Number.isFinite(height) && height <= 6_000
          ? { zoom: 14, kind: 'sequence' }
          : null),
    colors: { coverage: '#635bff', selected: '#00e5ff' },
    pickPrefix: 'test:line:',
    renderKey: 'test-coverage',
    tuning: TUNING,
    messages,
    ...(passes ? { passes } : {}),
  });
  t.after(() => {
    coverage.clear();
    coverage.resetErrors();
  });
  return { viewer, state, coverage, asked };
}

test('above the zoom range the provider’s own “zoom in” hint shows; without one, the generic hint', (t) => {
  const tooHigh = 'zoom in to see test coverage';
  const high = setup(t, { messages: { rateLimited: 'busy', tooHigh } });
  high.viewer.view.height = 7_000;
  high.coverage.refresh();
  assert.equal(high.state.coverage.hint, tooHigh);
  assert.equal(high.state.coverage.zoom, null);
  assert.equal(high.asked.length, 0, 'nothing is asked from up there');
  const generic = setup(t);
  generic.viewer.view.height = 7_000;
  generic.coverage.refresh();
  assert.notEqual(generic.state.coverage.hint, tooHigh);
  assert.match(generic.state.coverage.hint, /Point the camera/);
});

test('a provider’s passes() decides which lines are drawn and counted', async (t) => {
  const all = setup(t, { passes: () => true });
  all.coverage.refresh();
  assert.ok(await until(() => all.state.coverage.tiles.size === 1));
  assert.equal(all.coverage.sequenceCount(), 1, 'control: the line is drawn');
  const none = setup(t, { passes: () => false });
  none.coverage.refresh();
  assert.ok(await until(() => none.state.coverage.tiles.size === 1));
  assert.equal(none.coverage.sequenceCount(), 0, 'filtered out');
});

test('a refused key without its own message keeps the error it came with', async (t) => {
  const refused = Object.assign(new Error('the source refused the key'), {
    keyRejected: true,
  });
  const { state, coverage } = setup(t, { fail: refused });
  coverage.refresh();
  assert.ok(await until(() => state.keyRejected === true));
  assert.equal(state.coverage.lastError, 'the source refused the key');
});
