import test from 'node:test';
import assert from 'node:assert/strict';
import { createAbyssSource } from './source.js';

test('createAbyssSource returns bathymetry config', () => {
  const source = createAbyssSource();
  const config = source.getBathymetryConfig();
  assert.equal(config.url, 'https://wms.gebco.net/mapserv?');
  assert.equal(config.layer, 'GEBCO_LATEST_2');
});

test('createAbyssSource falls back to bundled vents when API fails', async () => {
  const failingFetch = async () => {
    throw new Error('Network offline');
  };
  const source = createAbyssSource({ fetchImpl: failingFetch });
  const vents = await source.getVentsSnapshot();
  assert.ok(Array.isArray(vents));
  assert.ok(vents.length > 500);
  assert.equal(vents[0].kind, 'vent');
});

test('createAbyssSource uses API response when available', async () => {
  const mockApiData = [
    { id: 'vent-mock-1', lon: 140.2, lat: 30.1, name: 'Mock Vent', activity: 'active' },
  ];
  const mockFetch = async (url) => {
    if (url.includes('/api/abyss/vents')) {
      return {
        ok: true,
        json: async () => mockApiData,
      };
    }
    return { ok: false, status: 404 };
  };

  const source = createAbyssSource({ fetchImpl: mockFetch });
  const vents = await source.getVentsSnapshot();
  assert.equal(vents.length, 1);
  assert.equal(vents[0].id, 'vent-mock-1');
});

test('createAbyssSource fetches and normalizes expedition dives', async () => {
  const mockDivesData = {
    features: [
      {
        attributes: {
          OBJECTID: 99,
          cruise_dive_id: 'EX_TEST_D1',
          vessel: 'NOAA Ship Okeanos Explorer',
          platform: 'Deep Discoverer',
          Year: 2023,
          latitude: 25.5,
          longitude: -88.2,
          MaxDepth: 2800,
        },
        geometry: { x: -88.2, y: 25.5 },
      },
    ],
  };

  const mockFetch = async () => ({
    ok: true,
    json: async () => mockDivesData,
  });

  const source = createAbyssSource({ fetchImpl: mockFetch });
  const dives = await source.getExpeditionsSnapshot();
  assert.equal(dives.length, 1);
  assert.equal(dives[0].id, 'dive-EX_TEST_D1');
  assert.equal(dives[0].depthM, 2800);
});

test('createAbyssSource fetches specific dive track on demand', async () => {
  const mockTrackData = {
    features: [
      {
        attributes: {
          CruiseDiveID: 'EX1605_D1',
          Shape__Length: 850,
        },
        geometry: {
          paths: [
            [
              [166.5, 19.3],
              [166.51, 19.31],
            ],
          ],
        },
      },
    ],
  };

  const mockFetch = async (url) => {
    assert.ok(url.includes('EX1605_D1'));
    return {
      ok: true,
      json: async () => mockTrackData,
    };
  };

  const source = createAbyssSource({ fetchImpl: mockFetch });
  const track = await source.getDiveTrack({ cruiseDiveId: 'EX1605_D1' });
  assert.ok(track);
  assert.equal(track.cruiseDiveId, 'EX1605_D1');
  assert.equal(track.lengthM, 850);
});
