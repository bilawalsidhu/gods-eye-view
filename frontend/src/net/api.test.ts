/**
 * Tests for the REST client, against a stubbed `fetch`.
 *
 * The paths and the query string are the contract with the backend, so they are asserted
 * literally: a typo in `/api/capabilities` is a runtime 404 that no type check catches.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ApiError,
  boxMovedEnough,
  fetchAircraft,
  fetchCapabilities,
  fetchCities,
  fetchHealth,
  fetchLayers,
  fetchVessels,
  LAYER_SUMMARY_POLL_MS,
  searchAll,
} from './api';

/** Records every call and answers with one canned response. */
function stubFetch(response: { ok: boolean; status: number; body?: unknown }) {
  const calls: { path: string; init: RequestInit | undefined }[] = [];
  vi.stubGlobal('fetch', (path: string, init: RequestInit | undefined) => {
    calls.push({ path, init });
    return Promise.resolve({
      ok: response.ok,
      status: response.status,
      json: () => Promise.resolve(response.body),
    });
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchCapabilities', () => {
  it('asks for the capabilities path and returns the parsed body', async () => {
    const body = { layers: ['aircraft'], attribution: [] };
    const calls = stubFetch({ ok: true, status: 200, body });

    await expect(fetchCapabilities()).resolves.toEqual(body);
    expect(calls[0]?.path).toBe('/api/capabilities');
    // `signal: null` rather than absent: every call now carries an abort slot, because the
    // search box abandons queries constantly and `exactOptionalPropertyTypes` will not let an
    // explicitly undefined property stand in for an absent one.
    expect(calls[0]?.init).toEqual({ headers: { Accept: 'application/json' }, signal: null });
  });
});

describe('fetchHealth', () => {
  it('asks for the health path', async () => {
    const calls = stubFetch({ ok: true, status: 200, body: { feeds: [] } });

    await expect(fetchHealth()).resolves.toEqual({ feeds: [] });
    expect(calls[0]?.path).toBe('/api/health');
  });
});

describe('fetchAircraft', () => {
  it('asks for the bare path when there is nothing to filter by', async () => {
    const calls = stubFetch({ ok: true, status: 200, body: { aircraft: [] } });

    await fetchAircraft();

    expect(calls[0]?.path).toBe('/api/aircraft');
  });

  it('puts a bounding box on the query string in the order the backend expects', async () => {
    const calls = stubFetch({ ok: true, status: 200, body: { aircraft: [] } });

    await fetchAircraft({ box: { west: -1.5, south: 51, east: 0.5, north: 52 } });

    expect(calls[0]?.path).toBe('/api/aircraft?west=-1.5&south=51&east=0.5&north=52');
  });

  it('adds the military filter only when it is asked for', async () => {
    const calls = stubFetch({ ok: true, status: 200, body: { aircraft: [] } });

    await fetchAircraft({ militaryOnly: true });
    await fetchAircraft({ militaryOnly: false });

    expect(calls[0]?.path).toBe('/api/aircraft?military_only=true');
    expect(calls[1]?.path).toBe('/api/aircraft');
  });
});

describe('fetchVessels', () => {
  it('asks for the vessel path, which is one merged layer and takes no filter', async () => {
    const calls = stubFetch({ ok: true, status: 200, body: { count: 0, vessels: [] } });

    await expect(fetchVessels()).resolves.toEqual({ count: 0, vessels: [] });
    expect(calls[0]?.path).toBe('/api/vessels');
  });
});

describe('fetchCities', () => {
  it('asks for the whole gazetteer in one read, because cities do not move', async () => {
    const body = { count: 1, total: 1, cities: [] };
    const calls = stubFetch({ ok: true, status: 200, body });

    await expect(fetchCities()).resolves.toEqual(body);
    // The route's own ceiling, which sits above the current 34,072 rows on purpose: a limit
    // tracking today's count would truncate the layer the week GeoNames adds a city.
    expect(calls[0]?.path).toBe('/api/cities?limit=40000');
  });

  it('takes a smaller limit, for a caller that only wants the top of the list', async () => {
    const calls = stubFetch({ ok: true, status: 200, body: { count: 0, total: 0, cities: [] } });

    await fetchCities(50);

    expect(calls[0]?.path).toBe('/api/cities?limit=50');
  });
});

describe('fetchLayers', () => {
  it('asks for the layer summary, which is the only place per-provider coverage lives', async () => {
    // ADR 010 wants two things off these rows: which provider dropped out, and the count
    // only that provider saw. Neither is on /api/capabilities.
    const body = {
      feeds: [],
      layers: { vessels: 109 },
      providers: [
        { layer: 'vessels', provider: 'aishub', records: 0, exclusive: 0, error: 'HTTP 500' },
      ],
    };
    const calls = stubFetch({ ok: true, status: 200, body });

    await expect(fetchLayers()).resolves.toEqual(body);
    expect(calls[0]?.path).toBe('/api/layers');
  });

  it('polls no faster than the slowest layer cycles, so a dead provider shows in one cycle', () => {
    // VESSEL_UNION_MIN_INTERVAL_SECONDS in src/tracker/app.py is 60 seconds and is the
    // slowest layer here. Polling faster would ask the same question twice per cycle.
    expect(LAYER_SUMMARY_POLL_MS).toBe(60_000);
  });
});

describe('ApiError', () => {
  it('is thrown for any non-2xx, carrying the status and the path', async () => {
    stubFetch({ ok: false, status: 503 });

    await expect(fetchHealth()).rejects.toBeInstanceOf(ApiError);
  });

  it('names the path and the status in its message, so a log line is enough to debug', () => {
    const error = new ApiError(429, '/api/aircraft');

    expect(error.status).toBe(429);
    expect(error.path).toBe('/api/aircraft');
    expect(error.name).toBe('ApiError');
    expect(error.message).toBe('/api/aircraft returned HTTP 429');
  });
});

describe('searchAll', () => {
  it('sends the query and the per-group limit, and passes the abort signal through', async () => {
    const calls = stubFetch({ ok: true, status: 200, body: { query: 'london', groups: [] } });
    const controller = new AbortController();

    await expect(searchAll('london', 5, controller.signal)).resolves.toEqual({
      query: 'london',
      groups: [],
    });
    expect(calls[0]?.path).toBe('/api/search?q=london&limit=5');
    expect(calls[0]?.init?.signal).toBe(controller.signal);
  });

  it('escapes a query that would otherwise change the query string', async () => {
    const calls = stubFetch({ ok: true, status: 200, body: { query: 'a&b', groups: [] } });

    await searchAll('10 Downing St & Co', 5);

    // A typeahead sends whatever is in the box, ampersands and all, so the encoding is the
    // difference between one parameter and two.
    expect(calls[0]?.path).toBe('/api/search?q=10+Downing+St+%26+Co&limit=5');
  });
});

/**
 * When the social layer may ask again, which is a rate-limit decision rather than a rendering one.
 *
 * This lived in `main.ts` until the browser refused to prove it: a simulated drag did not move the
 * Cesium camera at all, the hash came back byte-identical, and the guard looked broken when the
 * probe was. `main.ts` is excluded from coverage because it builds a real viewer, so a decision
 * there is a decision nothing can reach. Moved here, it is six assertions.
 */
describe('boxMovedEnough', () => {
  const box = { west: 4, south: 52, east: 5, north: 53 };

  it('asks the first time, because there is nothing to compare against', () => {
    expect(boxMovedEnough(null, box)).toBe(true);
  });

  it('refuses an identical view', () => {
    expect(boxMovedEnough(box, box)).toBe(false);
  });

  it('refuses a nudge, because the provider would return the same posts', () => {
    // A tenth of a box. Commons answers with the files nearest the box centre, so this is the same
    // question asked again and the only thing it spends is somebody else's rate limit.
    const nudged = { ...box, west: 4.1, east: 5.1 };

    expect(boxMovedEnough(box, nudged)).toBe(false);
  });

  it('asks after a pan of more than a quarter of a box', () => {
    const panned = { ...box, west: 4.3, east: 5.3 };

    expect(boxMovedEnough(box, panned)).toBe(true);
  });

  it('asks after a zoom, even with the camera over the same place', () => {
    // The half that is easy to forget. Standing still and zooming out turns a view the provider
    // covered into one it sampled, so the notice has to change and the posts with it.
    const zoomedOut = { west: 2, south: 50, east: 7, north: 55 };

    expect(boxMovedEnough(box, zoomedOut)).toBe(true);
  });

  it('asks on a latitude pan as readily as a longitude one', () => {
    // Both axes, because a north-south drag is exactly as much a different question.
    const northward = { ...box, south: 52.3, north: 53.3 };

    expect(boxMovedEnough(box, northward)).toBe(true);
  });

  it('is a fraction of the box rather than a fixed distance', () => {
    // The same absolute pan is a new question at street zoom and noise at country zoom, so the
    // threshold has to scale with the view.
    const tight = { west: 4.9, south: 52.3, east: 4.92, north: 52.32 };
    const tightPanned = { west: 4.91, south: 52.3, east: 4.93, north: 52.32 };

    expect(boxMovedEnough(tight, tightPanned)).toBe(true);
    expect(boxMovedEnough(box, { ...box, west: 4.01, east: 5.01 })).toBe(false);
  });
});
