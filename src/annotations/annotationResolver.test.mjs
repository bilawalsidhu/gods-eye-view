import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isGroundsLikeAsk,
  refineScope,
  resolveAnnotationTarget,
} from './annotationResolver.js';

const viewer = {
  camera: {
    positionCartographic: {
      latitude: 60.17 * Math.PI / 180,
      longitude: 24.94 * Math.PI / 180,
      height: 1000,
    },
    computeViewRectangle: () => null,
  },
  scene: { canvas: { clientWidth: 0, clientHeight: 0 }, globe: null },
};

test('entity facts refine only unresolved footprint scope', () => {
  assert.equal(refineScope('auto', 'building'), 'building');
  assert.equal(refineScope('city', 'building'), 'city');
  assert.equal(refineScope('auto', 'point_feature'), 'auto');
});

test('grounds-like intent recognizes compound facts', () => {
  assert.equal(isGroundsLikeAsk('the university grounds', null), true);
  assert.equal(isGroundsLikeAsk('headquarters', 'compound'), true);
  assert.equal(isGroundsLikeAsk('marker', 'point_feature'), false);
});

test('explicit annotation coordinates bypass network search', async () => {
  const result = await resolveAnnotationTarget({
    viewer,
    latitude: 60.17,
    longitude: 24.94,
    target: 'Helsinki',
  });
  assert.equal(result.lat, 60.17);
  assert.equal(result.lon, 24.94);
  assert.equal(result.source, 'coordinate');
});

test('named annotation targets use the same-origin Azure Maps search', async () => {
  const previous = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    return new Response(JSON.stringify({
      results: [{
        id: 'helsinki',
        type: 'Geography',
        name: 'Helsinki',
        position: { latitude: 60.17, longitude: 24.94 },
        address: { entityType: 'Municipality', freeformAddress: 'Helsinki, Finland' },
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const result = await resolveAnnotationTarget({ viewer, target: 'Helsinki' });
    assert.ok(result);
    assert.equal(new URL(calls[0], 'https://satview.test').pathname, '/api/azure/maps/search');
  } finally {
    globalThis.fetch = previous;
  }
});
