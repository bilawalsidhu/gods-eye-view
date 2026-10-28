import test from 'node:test';
import assert from 'node:assert/strict';
import { blockPaidQaMaps } from './qa-map-policy.mjs';

test('routine QA blocks direct Google tiles, hosted Google assets and token fallback', async () => {
  const calls = [];
  const page = {
    createCDPSession: async () => ({
      send: async (...args) => calls.push(args),
    }),
  };
  await blockPaidQaMaps(page);
  assert.equal(calls[0][0], 'Network.enable');
  assert.equal(calls[1][0], 'Network.setBlockedURLs');
  assert.ok(calls[1][1].urls.includes('*://tile.googleapis.com/*'));
  assert.ok(
    calls[1][1].urls.includes('*://api.cesium.com/v1/assets/2275207/*'),
  );
  assert.ok(calls[1][1].urls.includes('*/api/google/tiles*'));
});

test('a necessary 3D-specific check must explicitly opt out of the request block', async () => {
  await blockPaidQaMaps(
    { createCDPSession: () => assert.fail('unexpected block') },
    { allowPaidMaps: true },
  );
});
