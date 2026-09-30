import assert from 'node:assert/strict';
import test from 'node:test';
import {
  loadAlaska511SourcesFromOpenData,
  loadArizona511SourcesFromOpenData,
  loadDelDOTSourcesFromOpenData,
  loadIowaDotSourcesFromOpenData,
  testAlaska511Connection,
  testArizona511Connection,
  loadNy511SourcesFromOpenData,
  testNy511Connection,
} from '../../server/providers/cctv/sources.js';

test('DelDOT keeps enabled camera locations when the live status reports unavailable', async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({
      videoCameras: [
        {
          id: 'DE-1',
          title: 'I-95 near Wilmington',
          county: 'New Castle',
          lat: 39.74,
          lon: -75.55,
          enabled: true,
          status: 'unavailable',
          urls: { m3u8s: 'https://video.deldot.gov/live/DE-1/playlist.m3u8' },
        },
        {
          id: 'DE-2',
          title: 'Disabled camera',
          lat: 39.7,
          lon: -75.5,
          enabled: false,
          status: 'active',
          urls: { m3u8s: 'https://video.deldot.gov/live/DE-2/playlist.m3u8' },
        },
        {
          id: 'DE-3',
          title: 'Legacy active camera',
          lat: 39.6,
          lon: -75.4,
          status: 'active',
          urls: { m3u8s: 'https://video.deldot.gov/live/DE-3/playlist.m3u8' },
        },
      ],
    });
  try {
    const sources = await loadDelDOTSourcesFromOpenData();
    assert.deepEqual(sources.map((source) => source.id), [
      'deldot-de-1',
      'deldot-de-3',
    ]);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test('511NY normalizes an enabled official camera view without returning the API key', async () => {
  const oldFetch = globalThis.fetch;
  const oldKey = process.env.CCTV_511NY_API_KEY;
  process.env.CCTV_511NY_API_KEY = 'fixture-secret-not-for-response';
  let requestUrl;
  globalThis.fetch = async (input, options) => {
    requestUrl = new URL(input);
    assert.equal(options.redirect, 'error');
    return new Response(JSON.stringify([{
      Id: 42, Roadway: 'I-87', Direction: 'Northbound', Location: 'Albany',
      Latitude: 42.65, Longitude: -73.75,
      Views: [{ Status: 'Enabled', Url: 'https://511ny.org/map/Cctv/42?view=1' }],
    }]), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const sources = await loadNy511SourcesFromOpenData();
    assert.equal(requestUrl.origin, 'https://511ny.org');
    assert.equal(requestUrl.searchParams.get('key'), 'fixture-secret-not-for-response');
    assert.equal(sources.length, 1);
    assert.equal(sources[0].id, 'ny511-42');
    assert.equal(sources[0].provider, '511 New York');
    assert.equal(sources[0].url, 'https://511ny.org/map/Cctv/42');
    assert.equal(JSON.stringify(sources).includes('fixture-secret-not-for-response'), false);
    assert.match((await testNy511Connection()).message, /1 camera records/);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.CCTV_511NY_API_KEY;
    else process.env.CCTV_511NY_API_KEY = oldKey;
  }
});

test('Alaska and Arizona share the 511 camera adapter with isolated keys and host allowlists', async () => {
  const oldFetch = globalThis.fetch;
  const oldAlaska = process.env.CCTV_511_ALASKA_API_KEY;
  const oldArizona = process.env.CCTV_511_ARIZONA_API_KEY;
  process.env.CCTV_511_ALASKA_API_KEY = 'alaska-fixture-secret';
  process.env.CCTV_511_ARIZONA_API_KEY = 'arizona-fixture-secret';
  const requests = [];
  globalThis.fetch = async (input, options) => {
    const url = new URL(input);
    requests.push(url);
    assert.equal(options.redirect, 'error');
    if (url.hostname === '511.alaska.gov') {
      assert.equal(url.searchParams.get('key'), 'alaska-fixture-secret');
      return Response.json([{
        Id: 7, Source: 'ADOT&PF', Roadway: 'Seward Highway',
        Direction: 'North', Latitude: 60.929619, Longitude: -149.346632,
        Location: 'Bird Point',
        Views: [
          { Id: 1, Url: 'https://511.alaska.gov/map/Cctv/1', Status: 'Disabled' },
          { Id: 2, Url: 'https://511.alaska.gov/map/Cctv/2', Status: 'Enabled', Description: 'Both direction' },
        ],
      }]);
    }
    assert.equal(url.hostname, 'az511.com');
    assert.equal(url.searchParams.get('key'), 'arizona-fixture-secret');
    return Response.json([{
      Id: 2056, Source: 'AZDOT', Roadway: 'SR-95', Direction: 'Unknown',
      Latitude: 35.172449, Longitude: -114.566108,
      Location: 'Laughlin Road',
      Views: [{ Id: 960, Url: 'https://az511.com/map/Cctv/960', Status: 'Enabled' }],
    }]);
  };
  try {
    const alaska = await loadAlaska511SourcesFromOpenData();
    const arizona = await loadArizona511SourcesFromOpenData();
    assert.equal(alaska.length, 1);
    assert.equal(alaska[0].id, 'ak511-7');
    assert.equal(alaska[0].url, 'https://511.alaska.gov/map/Cctv/2');
    assert.equal(alaska[0].provider, 'Alaska 511');
    assert.equal(arizona.length, 1);
    assert.equal(arizona[0].id, 'az511-2056');
    assert.equal(arizona[0].url, 'https://az511.com/map/Cctv/960');
    assert.equal(arizona[0].provider, 'Arizona 511');
    assert.equal(requests.length, 2);
    assert.match((await testAlaska511Connection()).message, /Alaska 511 connection succeeded/);
    assert.match((await testArizona511Connection()).message, /AZ 511 connection succeeded/);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldAlaska === undefined) delete process.env.CCTV_511_ALASKA_API_KEY;
    else process.env.CCTV_511_ALASKA_API_KEY = oldAlaska;
    if (oldArizona === undefined) delete process.env.CCTV_511_ARIZONA_API_KEY;
    else process.env.CCTV_511_ARIZONA_API_KEY = oldArizona;
  }
});

test('511NY missing credentials do not call upstream and disable only that provider', async () => {
  const oldFetch = globalThis.fetch;
  const oldKey = process.env.CCTV_511NY_API_KEY;
  delete process.env.CCTV_511NY_API_KEY;
  globalThis.fetch = async () => { throw new Error('unexpected upstream call'); };
  try {
    assert.deepEqual(await loadNy511SourcesFromOpenData(), []);
    await assert.rejects(testNy511Connection(), { code: 'missing_credentials' });
  } finally {
    globalThis.fetch = oldFetch;
    if (oldKey !== undefined) process.env.CCTV_511NY_API_KEY = oldKey;
  }
});

test('Iowa DOT accepts only road cameras and pinned DOT media, with daily cache', async () => {
  const oldFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (input, options) => {
    calls += 1;
    const url = new URL(input);
    assert.equal(options.redirect, 'error');
    assert.equal(url.searchParams.get('where'), "Type='Iowa DOT'");
    assert.equal(url.searchParams.get('outSR'), '4326');
    return new Response(JSON.stringify({ features: [
      { attributes: {
        device_id: 'IA-101', Desc_: 'I-80 at Exit 100', Route: 'I-80', Type: 'Iowa DOT',
        latitude: 41.5, longitude: -93.5,
        ImageURL: 'https://atmsqf.iowadot.gov/camera/101.jpg',
        VideoURL: 'https://video2.iowadot.gov/camera/101.m3u8',
      } },
      { attributes: {
        device_id: 'IA-102', Type: 'Rest Area/Parking', latitude: 41.5, longitude: -93.5,
        ImageURL: 'https://attacker.invalid/camera.jpg',
      } },
    ] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const first = await loadIowaDotSourcesFromOpenData({ now: 2_000_000_000_000 });
    const second = await loadIowaDotSourcesFromOpenData({ now: 2_000_000_001_000 });
    assert.equal(calls, 1);
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
