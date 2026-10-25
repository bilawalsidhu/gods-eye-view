import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchWikipediaNearby,
  fetchWikipediaSummary,
  searchWikipedia,
  fetchWikipediaBrief,
  createWikipediaService,
} from './wikipedia.js';

test('fetchWikipediaNearby validates coordinates', async () => {
  await assert.rejects(
    () => fetchWikipediaNearby({ latitude: 100, longitude: 0 }),
    /Valid latitude between -90 and 90 is required/,
  );
  await assert.rejects(
    () => fetchWikipediaNearby({ latitude: 0, longitude: -200 }),
    /Valid longitude between -180 and 180 is required/,
  );
  await assert.rejects(
    () => fetchWikipediaNearby({ latitude: NaN, longitude: 0 }),
    /Valid latitude between -90 and 90 is required/,
  );
});

test('fetchWikipediaNearby formats geosearch query and maps records', async () => {
  let requestedUrl = null;
  const mockFetch = async (url) => {
    requestedUrl = url;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        query: {
          geosearch: [
            {
              pageid: 12345,
              title: 'Texas State Capitol',
              lat: 30.2747,
              lon: -97.7404,
              dist: 450.2,
              primary: '',
            },
          ],
        },
      }),
    };
  };

  const results = await fetchWikipediaNearby({
    latitude: 30.2672,
    longitude: -97.7431,
    radius: 5000,
    limit: 10,
    fetchImpl: mockFetch,
  });

  assert.ok(requestedUrl);
  assert.ok(requestedUrl.includes('action=query'));
  assert.ok(requestedUrl.includes('list=geosearch'));
  assert.ok(requestedUrl.includes('gscoord=30.26720%7C-97.74310'));
  assert.ok(requestedUrl.includes('gsradius=5000'));
  assert.ok(requestedUrl.includes('gslimit=10'));

  assert.equal(results.length, 1);
  assert.equal(results[0].pageId, 12345);
  assert.equal(results[0].title, 'Texas State Capitol');
  assert.equal(results[0].latitude, 30.2747);
  assert.equal(results[0].longitude, -97.7404);
  assert.equal(results[0].distanceMeters, 450.2);
  assert.equal(results[0].primary, true);
});

test('fetchWikipediaSummary parses article summary and handles 404', async () => {
  const mockFetch = async (url) => {
    if (url.includes('Unknown_Topic')) {
      return { ok: false, status: 404 };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        pageid: 6789,
        title: 'Eiffel Tower',
        displaytitle: '<i>Eiffel Tower</i>',
        description: 'Wrought-iron lattice tower in Paris, France',
        extract:
          'The Eiffel Tower is a wrought-iron lattice tower on the Champ de Mars in Paris...',
        thumbnail: { source: 'https://upload.wikimedia.org/eiffel.jpg' },
        content_urls: {
          desktop: { page: 'https://en.wikipedia.org/wiki/Eiffel_Tower' },
        },
        coordinates: { lat: 48.8584, lon: 2.2945 },
      }),
    };
  };

  const summary = await fetchWikipediaSummary('Eiffel Tower', {
    fetchImpl: mockFetch,
  });
  assert.ok(summary);
  assert.equal(summary.pageId, 6789);
  assert.equal(summary.title, 'Eiffel Tower');
  assert.equal(
    summary.description,
    'Wrought-iron lattice tower in Paris, France',
  );
  assert.equal(summary.thumbnail, 'https://upload.wikimedia.org/eiffel.jpg');
  assert.equal(summary.pageUrl, 'https://en.wikipedia.org/wiki/Eiffel_Tower');
  assert.deepEqual(summary.coordinates, {
    latitude: 48.8584,
    longitude: 2.2945,
  });

  const missing = await fetchWikipediaSummary('Unknown_Topic', {
    fetchImpl: mockFetch,
  });
  assert.equal(missing, null);
});

test('searchWikipedia returns stripped snippets and titles', async () => {
  const mockFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      query: {
        search: [
          {
            pageid: 101,
            title: 'NORAD',
            snippet:
              'North American <span class="searchmatch">Aerospace</span> Defense Command',
            wordcount: 4200,
          },
        ],
      },
    }),
  });

  const hits = await searchWikipedia('NORAD', {
    limit: 3,
    fetchImpl: mockFetch,
  });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].pageId, 101);
  assert.equal(hits[0].title, 'NORAD');
  assert.equal(hits[0].snippet, 'North American Aerospace Defense Command');
});

test('fetchWikipediaBrief synthesizes coordinate and query intelligence', async () => {
  const mockFetch = async (url) => {
    if (url.includes('list=geosearch')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          query: {
            geosearch: [
              {
                pageid: 1,
                title: 'Austin Landmark',
                lat: 30.2,
                lon: -97.7,
                dist: 100,
              },
            ],
          },
        }),
      };
    }
    if (url.includes('page/summary')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          pageid: 1,
          title: 'Austin Landmark',
          extract: 'A historic spot in Austin, Texas.',
        }),
      };
    }
    return { ok: false, status: 500 };
  };

  const brief = await fetchWikipediaBrief({
    latitude: 30.26,
    longitude: -97.74,
    fetchImpl: mockFetch,
  });

  assert.equal(brief.latitude, 30.26);
  assert.equal(brief.longitude, -97.74);
  assert.equal(brief.nearby.length, 1);
  assert.ok(brief.article);
  assert.equal(brief.article.title, 'Austin Landmark');
});

test('createWikipediaService binds options and exposes helpers', async () => {
  const calls = [];
  const mockFetch = async (url) => {
    calls.push(url);
    return {
      ok: true,
      status: 200,
      json: async () => ({ query: { geosearch: [] } }),
    };
  };

  const service = createWikipediaService({ fetchImpl: mockFetch });
  assert.equal(typeof service.fetchNearby, 'function');
  assert.equal(typeof service.fetchSummary, 'function');
  assert.equal(typeof service.search, 'function');
  assert.equal(typeof service.fetchBrief, 'function');

  await service.fetchNearby({ latitude: 10, longitude: 20 });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('gscoord=10.00000%7C20.00000'));
});

test('fetchWikipediaNearby caches responses for identical coordinates and parameters', async () => {
  let fetchCount = 0;
  const mockFetch = async () => {
    fetchCount++;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        query: {
          geosearch: [
            {
              pageid: 999,
              title: 'Cached Landmark',
              lat: 51.5074,
              lon: -0.1278,
              dist: 100,
            },
          ],
        },
      }),
    };
  };

  const first = await fetchWikipediaNearby({
    latitude: 51.5074,
    longitude: -0.1278,
    radius: 5000,
    limit: 5,
    fetchImpl: mockFetch,
  });
  const second = await fetchWikipediaNearby({
    latitude: 51.5074,
    longitude: -0.1278,
    radius: 5000,
    limit: 5,
    fetchImpl: mockFetch,
  });

  assert.equal(fetchCount, 1);
  assert.deepEqual(first, second);
});

test('wikipedia requests throttle through maximum concurrency limit', async () => {
  let inFlight = 0;
  let maxConcurrentSeen = 0;
  const mockFetch = async () => {
    inFlight++;
    maxConcurrentSeen = Math.max(maxConcurrentSeen, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 20));
    inFlight--;
    return {
      ok: true,
      status: 200,
      json: async () => ({ query: { search: [] } }),
    };
  };

  const tasks = Array.from({ length: 10 }, (_, i) =>
    searchWikipedia(`query_${i}`, { fetchImpl: mockFetch }),
  );
  await Promise.all(tasks);

  assert.ok(
    maxConcurrentSeen <= 4,
    `Expected max 4 concurrent requests, saw ${maxConcurrentSeen}`,
  );
});

test('fetchWikipediaNearby sends correct Api-User-Agent header without contact email', async () => {
  let requestHeaders = null;
  const mockFetch = async (url, options) => {
    requestHeaders = options.headers;
    return {
      ok: true,
      status: 200,
      json: async () => ({ query: { geosearch: [] } }),
    };
  };

  await fetchWikipediaNearby({
    latitude: 48.8584,
    longitude: 2.2945,
    fetchImpl: mockFetch,
  });

  assert.equal(
    requestHeaders['Api-User-Agent'],
    'GodsEyeView/1.0 (https://github.com/bilawalsidhu/gods-eye-view)',
  );
});

test('concurrent identical fetchWikipediaNearby requests are deduplicated into a single fetch', async () => {
  let fetchCount = 0;
  const mockFetch = async () => {
    fetchCount++;
    await new Promise((resolve) => setTimeout(resolve, 25));
    return {
      ok: true,
      status: 200,
      json: async () => ({
        query: {
          geosearch: [
            {
              pageid: 999,
              title: 'Parallel Point',
              lat: 12.3456,
              lon: 78.9101,
              dist: 100,
            },
          ],
        },
      }),
    };
  };

  const [res1, res2, res3, res4, res5] = await Promise.all([
    fetchWikipediaNearby({
      latitude: 12.3456,
      longitude: 78.9101,
      fetchImpl: mockFetch,
    }),
    fetchWikipediaNearby({
      latitude: 12.3456,
      longitude: 78.9101,
      fetchImpl: mockFetch,
    }),
    fetchWikipediaNearby({
      latitude: 12.3456,
      longitude: 78.9101,
      fetchImpl: mockFetch,
    }),
    fetchWikipediaNearby({
      latitude: 12.3456,
      longitude: 78.9101,
      fetchImpl: mockFetch,
    }),
    fetchWikipediaNearby({
      latitude: 12.3456,
      longitude: 78.9101,
      fetchImpl: mockFetch,
    }),
  ]);

  assert.equal(
    fetchCount,
    1,
    'Expected exactly 1 network fetch for 5 concurrent identical requests',
  );
  assert.equal(res1.length, 1);
  assert.equal(res1[0].title, 'Parallel Point');
  assert.deepEqual(res1, res2);
  assert.deepEqual(res1, res3);
  assert.deepEqual(res1, res4);
  assert.deepEqual(res1, res5);
});

test('wikipedia service merges lifetime signal with request-specific options signal', async () => {
  let receivedSignal = null;
  const mockFetch = async (url, options) => {
    receivedSignal = options.signal;
    return {
      ok: true,
      status: 200,
      json: async () => ({ query: { geosearch: [] } }),
    };
  };

  const lifetimeController = new AbortController();
  const service = createWikipediaService({
    fetchImpl: mockFetch,
    signal: lifetimeController.signal,
  });

  const requestController = new AbortController();
  await service.fetchNearby({
    latitude: 35.6762,
    longitude: 139.6503,
    signal: requestController.signal,
  });

  assert.ok(receivedSignal, 'Signal should be passed to fetch');
});
