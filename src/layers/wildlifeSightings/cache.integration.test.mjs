import assert from 'node:assert/strict';
import test from 'node:test';
import { inaturalistProxy } from '../../../server/providers/inaturalist/observations.js';
import { syntheticGrid } from '../../../server/providers/inaturalist/grid.fixture.mjs';
import {
  createWildlifeSightingsSource,
  WILDLIFE_GRID_TTL_MS,
} from './source.js';

// Exercise both real cache owners through their projected response contract.
// Only the HTTP transport and upstream data are synthetic; no socket is needed.
test('client and proxy share stale revalidation and publish its fresh result in the same view', async () => {
  let now = Date.parse('2026-11-04T18:05:00Z');
  let upstreamCalls = 0;
  let proxyCalls = 0;
  let finishRefresh;
  let handler;
  inaturalistProxy({
    now: () => now,
    cacheDir: null,
    queueOptions: { intervalMs: 0, windowMs: 0 },
    warn() {},
    fetchImpl() {
      upstreamCalls++;
      return upstreamCalls === 1
        ? Response.json(syntheticGrid())
        : new Promise((resolve) => {
            finishRefresh = resolve;
          });
    },
  }).configureServer({
    middlewares: {
      use(_mount, middleware) {
        handler = middleware;
      },
    },
  });
  const source = createWildlifeSightingsSource({
    now: () => now,
    async fetchImpl(url) {
      proxyCalls++;
      let status;
      let headers;
      let response;
      await handler(
        {
          method: 'GET',
          url: url.slice('/api/inaturalist'.length),
          headers: {},
          socket: { remoteAddress: 'synthetic' },
        },
        {
          writeHead(code, values) {
            status = code;
            headers = values;
          },
          end(body) {
            response = new Response(body, { status, headers });
          },
        },
      );
      return response;
    },
  });
  const options = { tiles: [{ z: 2, x: 1, y: 1 }], taxa: 'Aves' };
  const first = await source.getGridSnapshot(options);
  assert.equal(first.cells.length, 2);
  await source.getGridSnapshot(options);
  assert.equal(upstreamCalls, 1);
  assert.equal(proxyCalls, 1, 'client hits do not even call the proxy');
  now += WILDLIFE_GRID_TTL_MS;
  const publications = [];
  let settled = false;
  const refreshing = source
    .getGridSnapshot({
      ...options,
      onTile: (value) => publications.push(value),
    })
    .then((value) => {
      settled = true;
      return value;
    });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false, 'revalidation is still waiting for upstream');
    assert.equal(
      publications[0]?.stale,
      true,
      'old cells already reached the renderer',
    );
    assert.deepEqual(publications[0].cells, first.cells);
    assert.equal(
      upstreamCalls,
      2,
      'normal stale GET and refresh=wait share one upstream attempt',
    );
    finishRefresh(Response.json(syntheticGrid()));
    const fresh = await refreshing;
    assert.equal(fresh.stale, false);
    assert.equal(fresh.fetchedAt, now);
    assert.equal(publications.at(-1).fetchedAt, now);
    assert.notEqual(publications.at(-1).stale, true);
    const before = proxyCalls;
    await source.getGridSnapshot(options);
    assert.equal(proxyCalls, before);
    assert.equal(upstreamCalls, 2);
  } finally {
    finishRefresh?.(Response.json(syntheticGrid()));
    await refreshing;
  }
});
