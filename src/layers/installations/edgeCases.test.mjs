import test from 'node:test';
import assert from 'node:assert/strict';
import { installationFeedback } from '../../data/installationFeedback.js';
import { createInstallationSource } from './source.js';

const box = { south: 30.1, west: -97.9, north: 30.3, east: -97.6 };

/** What the panel says after one request: a count, or the failure reason. */
async function feedbackFor(source) {
  try {
    const payload = await source.getMappedSites(box);
    return {
      outcome: 'ready',
      text: installationFeedback({
        status: payload.status,
        count: payload.records.length,
      }),
    };
  } catch (error) {
    return {
      outcome: 'unavailable',
      text: installationFeedback({
        status: 'unavailable',
        failureReason: error.failureReason,
      }),
    };
  }
}

test('edge:military-installations: an empty Overpass answer is not an unavailable source', async () => {
  const empty = createInstallationSource({
    fetchImpl: async () => Response.json({ elements: [], status: 'ready' }),
  });
  assert.deepEqual(await feedbackFor(empty), {
    outcome: 'ready',
    text: 'No mapped sites in view',
  });

  const failing = createInstallationSource({
    fetchImpl: async () =>
      Response.json({ reason: 'timeout' }, { status: 504 }),
  });
  assert.deepEqual(await feedbackFor(failing), {
    outcome: 'unavailable',
    text: 'Overpass timed out',
  });

  const offline = createInstallationSource({
    fetchImpl: async () => {
      throw new TypeError('Failed to fetch');
    },
  });
  assert.equal((await feedbackFor(offline)).outcome, 'unavailable');
});

test('edge:military-installations: empty tiles and unavailable tiles stay distinct on the tile fallback', async () => {
  const notConfigured = async () =>
    Response.json({ code: 'OVERPASS_NOT_CONFIGURED' }, { status: 503 });
  const emptyTiles = createInstallationSource({
    fetchImpl: notConfigured,
    loadNames: async () => [],
    mapTiles: {
      fetchBounds: async () => ({ tiles: [{ military: [] }], partial: false }),
      clear() {},
    },
  });
  assert.deepEqual(await feedbackFor(emptyTiles), {
    outcome: 'ready',
    text: 'No mapped sites in view',
  });

  const downTiles = createInstallationSource({
    fetchImpl: notConfigured,
    loadNames: async () => [],
    mapTiles: {
      fetchBounds: async () => {
        throw new Error('HTTP 502');
      },
      clear() {},
    },
  });
  assert.deepEqual(await feedbackFor(downTiles), {
    outcome: 'unavailable',
    text: 'Map tiles temporarily unavailable',
  });
});
