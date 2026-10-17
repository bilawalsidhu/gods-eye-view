import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSaRoadEventsSource } from './source.js';
import {
  normalizeSaRoadEventLines,
  normalizeSaRoadEventPoints,
} from './records.js';

const fixture = (name) =>
  JSON.parse(
    readFileSync(
      new URL(`../../data/fixtures/${name}`, import.meta.url),
      'utf8',
    ),
  );
const body = {
  points: normalizeSaRoadEventPoints(fixture('trafficsa-points-sample.json'))
    .records,
  lines: normalizeSaRoadEventLines(fixture('trafficsa-lines.json')).records,
  fetchedAt: 1_760_300_000_000,
  stale: false,
  mirror: false,
};

test('a valid proxy response yields the validated snapshot', async () => {
  let requested;
  const source = createSaRoadEventsSource({
    fetchImpl: async (url, options) => {
      requested = [String(url), options];
      return Response.json({ ...body, stale: true, mirror: true });
    },
  });
  const controller = new AbortController();
  const snapshot = await source.getSnapshot({ signal: controller.signal });
  assert.equal(requested[0], '/api/sa-road-events');
  assert.equal(requested[1].signal, controller.signal);
  assert.equal(snapshot.points.length, body.points.length);
  assert.equal(snapshot.lines.length, 8);
  assert.equal(snapshot.fetchedAt, body.fetchedAt);
  assert.equal(snapshot.stale, true);
  assert.equal(snapshot.mirror, true);
});

test('HTTP errors, malformed payloads and oversize bodies are rejected', async () => {
  const bad = [
    new Response('down', { status: 502 }),
    Response.json({ error: 'sa_road_events_unavailable' }),
    Response.json({ ...body, points: 'nope' }),
    Response.json({ ...body, fetchedAt: null }),
    Response.json({
      ...body,
      points: [{ ...body.points[0], lon: 12 }, ...body.points.slice(1)],
    }),
    new Response('not json'),
    new Response('x'.repeat(9 * 1024 * 1024)),
  ];
  for (const response of bad) {
    const source = createSaRoadEventsSource({
      fetchImpl: async () => response,
    });
    await assert.rejects(() => source.getSnapshot());
  }
});

test('an aborted request never resolves with data', async () => {
  const controller = new AbortController();
  controller.abort();
  const source = createSaRoadEventsSource({
    fetchImpl: async () => Response.json(body),
  });
  await assert.rejects(() => source.getSnapshot({ signal: controller.signal }));
});
