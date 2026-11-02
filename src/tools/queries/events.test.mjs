import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { composeCatalog, coreTools } from '../index.js';
import { createEventPackSource } from '../../sources/eventPacks.js';

const EVENT_URL = new URL(
  '../../../public/events/bhote-koshi-2026/event.json',
  import.meta.url,
);
const bundled = JSON.parse(await readFile(EVENT_URL, 'utf8'));

test('the event pack source reads each event once and checks the id', async () => {
  const requested = [];
  const source = createEventPackSource({
    fetchImpl: async (url) => {
      requested.push(url);
      return Response.json(bundled);
    },
  });
  const event = await source.getEvent('bhote-koshi-2026');
  assert.deepEqual(event, bundled);
  assert.equal(await source.getEvent('bhote-koshi-2026'), event);
  assert.deepEqual(requested, ['/events/bhote-koshi-2026/event.json']);
  await assert.rejects(source.getEvent('../secret'), /Invalid event id/);
  const missing = createEventPackSource({
    fetchImpl: async () => new Response(null, { status: 404 }),
  });
  await assert.rejects(missing.getEvent('other'), /unavailable \(404\)/);
});

test('the flood tool lists the bundled evidence in story order', async () => {
  const catalog = composeCatalog({
    tools: coreTools,
    services: { events: { getEvent: async () => bundled } },
  });
  const all = await catalog.call('get_bhote_koshi_flood', {});
  assert.match(
    all.summary,
    /^Bhote Koshi Outburst Flood, observed 2026-08-26: 16 evidence records along a \d+(\.\d)? km mapped flood path\.$/,
  );
  assert.deepEqual(
    all.data.evidence.map((row) => row.sequence),
    Array.from({ length: 16 }, (_, index) => index + 1),
  );
  assert.deepEqual(all.data.evidence[3], {
    sequence: 4,
    id: 'gyirong-border-gate',
    title: 'Gyirong border gate',
    summary: 'Public footage geolocated at the Nepal-China border crossing.',
    phase: 'border arrival',
    lat: 28.28083,
    lon: 85.37802,
    location_confidence: 'geolocated',
    time_confidence: 'unverified',
    captured_at: null,
    in_imagery: true,
    source_url: 'https://www.youtube.com/watch?v=qlE51Eu0thk',
    platform: 'YouTube',
    via: 'GeoGeorgeShadrach public geolocation map; independently consistent with the linked GeoConfirmed witness',
  });
  assert.deepEqual(all.data.flood_path.start, { lat: 28.33255, lon: 85.48476 });
  assert.ok(all.data.flood_path.length_km > 50);
  assert.equal(all.data.imagery.after.observed_at, '2026-08-27');
  assert.match(all.data.caveat, /not an official hazard model/);
  assert.match(all.data.attribution, /CC BY-NC 4\.0/);
  const downstream = await catalog.call('get_bhote_koshi_flood', {
    phase: 'Downstream passage',
  });
  assert.ok(
    downstream.data.evidence.every((row) => row.phase === 'downstream passage'),
  );
  assert.match(downstream.summary, /in the Downstream passage phase/);
});
