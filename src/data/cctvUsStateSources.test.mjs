import assert from 'node:assert/strict';
import test from 'node:test';
import {
  loadIowaDotSourcesFromOpenData,
  loadNy511SourcesFromOpenData,
  testNy511Connection,
} from '../../server/providers/cctv/sources.js';

test('511NY uses its server credential, normalizes enabled camera views, and never returns the key', async () => {
  const oldFetch = globalThis.fetch;
  const oldKey = process.env.CCTV_511NY_API_KEY;
  process.env.CCTV_511NY_API_KEY = 'test-secret-never-return';
  let requestedUrl;
  globalThis.fetch = async (input, options) => {
    requestedUrl = new URL(input);
    assert.equal(options.redirect, 'error');
    return new Response(
      JSON.stringify([
        {
          Id: 42,
          Roadway: 'I-87',
          Direction: 'Northbound',
          Location: 'Albany',
          Latitude: 42.65,
          Longitude: -73.75,
          Views: [
            {
              Status: 'Enabled',
              Url: 'https://511ny.org/map/Cctv/42?view=1',
              Description: 'North camera',
            },
          ],
        },
      ]),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  try {
    const sources = await loadNy511SourcesFromOpenData();
    assert.equal(requestedUrl.origin, 'https://511ny.org');
    assert.equal(requestedUrl.searchParams.get('key'), 'test-secret-never-return');
    assert.equal(sources.length, 1);
    assert.equal(sources[0].id, 'ny511-42');
    assert.equal(sources[0].provider, '511 New York');
    assert.equal(sources[0].url, 'https://511ny.org/map/Cctv/42');
    assert.equal(JSON.stringify(sources).includes('test-secret-never-return'), false);
    assert.match((await testNy511Connection()).message, /1 camera records/);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.CCTV_511NY_API_KEY;
    else process.env.CCTV_511NY_API_KEY = oldKey;
  }
});

test('511NY missing credentials isolate the provider without an upstream request', async () => {
  const oldFetch = globalThis.fetch;
  const oldKey = process.env.CCTV_511NY_API_KEY;
  delete process.env.CCTV_511NY_API_KEY;
  globalThis.fetch = async () => {
    throw new Error('should not call upstream');
  };
  try {
    assert.deepEqual(await loadNy511SourcesFromOpenData(), []);
    await assert.rejects(testNy511Connection(), { code: 'missing_credentials' });
  } finally {
    globalThis.fetch = oldFetch;
    if (oldKey !== undefined) process.env.CCTV_511NY_API_KEY = oldKey;
  }
});

test('Iowa DOT filters roadway cameras, pins media hosts, and caches its daily catalog', async () => {
  const oldFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = async (input, options) => {
    fetchCount += 1;
    const url = new URL(input);
    assert.equal(options.redirect, 'error');
    assert.equal(url.searchParams.get('where'), "Type='Iowa DOT'");
    assert.equal(url.searchParams.get('outSR'), '4326');
    return new Response(
      JSON.stringify({
        features: [
          {
            attributes: {
              device_id: 'IA-101',
              Desc_: 'I-80 at Exit 100',
              Route: 'I-80',
              Type: 'Iowa DOT',
              latitude: 41.5,
              longitude: -93.5,
              ImageURL: 'https://atmsqf.iowadot.gov/camera/101.jpg',
              VideoURL: 'https://video2.iowadot.gov/camera/101.m3u8',
            },
          },
          {
            attributes: {
              device_id: 'IA-102',
              Type: 'Rest Area/Parking',
              latitude: 41.5,
              longitude: -93.5,
              ImageURL: 'https://attacker.invalid/camera.jpg',
            },
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  try {
    const first = await loadIowaDotSourcesFromOpenData({ now: 2_000_000_000_000 });
    const second = await loadIowaDotSourcesFromOpenData({ now: 2_000_000_001_000 });
    assert.equal(fetchCount, 1);
    assert.equal(first.length, 1);
    assert.equal(second.length, 1);
    assert.equal(first[0].id, 'iowadot-IA-101');
    assert.equal(first[0].provider, 'Iowa DOT');
    assert.equal(first[0].feedType, 'hls');
    assert.equal(first[0].snapshotUrl, 'https://atmsqf.iowadot.gov/camera/101.jpg');
    assert.equal(first[0].license, 'Creative Commons Attribution 4.0 International (CC BY 4.0)');
  } finally {
    globalThis.fetch = oldFetch;
  }
});
