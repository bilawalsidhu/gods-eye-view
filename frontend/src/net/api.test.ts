/**
 * Tests for the REST client, against a stubbed `fetch`.
 *
 * The paths and the query string are the contract with the backend, so they are asserted
 * literally: a typo in `/api/capabilities` is a runtime 404 that no type check catches.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError, fetchAircraft, fetchCapabilities, fetchHealth } from './api';

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
    expect(calls[0]?.init).toEqual({ headers: { Accept: 'application/json' } });
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
