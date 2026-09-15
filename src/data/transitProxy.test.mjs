import test from 'node:test';
import assert from 'node:assert/strict';
import { PbfWriter } from 'pbf';
import {
  TRANSIT_PROXY_STALE_MAX_MS,
  TRANSIT_PROXY_TTL_MS,
  buildTransitSnapshot,
  isAcceptableTransitUpstreamUrl,
  resolveTransitRoute,
  transitCacheState,
  transitResponseHeaders,
  transitUpstreamHeaders,
} from './transitProxy.js';
import { getTransitFeed } from './transitFeeds.js';

test('route resolution admits only the catalog and registered feed ids', () => {
  assert.deepEqual(resolveTransitRoute('/feeds'), { route: 'feeds' });
  assert.deepEqual(resolveTransitRoute('/feeds/?x=1'), { route: 'feeds' });
  assert.equal(resolveTransitRoute('/vehicles/mbta')?.feed?.id, 'mbta');
  assert.equal(resolveTransitRoute('/vehicles/mbta/')?.feed?.id, 'mbta');
  assert.equal(resolveTransitRoute('/vehicles/mbta?trip=1')?.feed?.id, 'mbta');
  assert.equal(resolveTransitRoute('/vehicles/nope'), null);
  assert.equal(resolveTransitRoute('/vehicles/'), null);
  assert.equal(resolveTransitRoute('/vehicles/mbta/extra'), null);
  assert.equal(resolveTransitRoute('/vehicles/..%2F..%2Fetc'), null);
  assert.equal(resolveTransitRoute('/vehicles/%E0%A4%A'), null); // malformed escape never throws
  assert.equal(resolveTransitRoute('/'), null);
  assert.equal(resolveTransitRoute(''), null);
  assert.equal(resolveTransitRoute(undefined), null);
});

test('upstream headers identify the proxy and carry feed-specific identification', () => {
  const plain = transitUpstreamHeaders(getTransitFeed('mbta'));
  assert.match(plain['User-Agent'], /gods-eye-view-transit-proxy/);
  assert.match(plain.Accept, /x-protobuf/);
  const entur = transitUpstreamHeaders(getTransitFeed('entur-norway'));
  assert.equal(entur['ET-Client-Name'], 'gods-eye-view-transit');
  assert.ok(transitUpstreamHeaders(null)['User-Agent']);
});

test('only https upstreams are acceptable, including after a redirect', () => {
  assert.equal(
    isAcceptableTransitUpstreamUrl('https://cdn.mbta.com/x.pb'),
    true,
  );
  assert.equal(
    isAcceptableTransitUpstreamUrl(
      'http://gtfs.ovapi.nl/nl/vehiclePositions.pb',
    ),
    false,
  );
  assert.equal(isAcceptableTransitUpstreamUrl('ftp://x'), false);
  assert.equal(isAcceptableTransitUpstreamUrl('not a url'), false);
});

test('snapshot shape carries provenance the layer displays', () => {
  const writer = new PbfWriter();
  const header = new PbfWriter();
  header.writeStringField(1, '2.0');
  header.writeVarintField(3, 1_700_000_000);
  writer.writeBytesField(1, header.finish());
  const snapshot = buildTransitSnapshot(
    getTransitFeed('hsl-helsinki'),
    writer.finish(),
    12345,
  );
  assert.equal(snapshot.feedId, 'hsl-helsinki');
  assert.equal(snapshot.name, 'HSL');
  assert.equal(snapshot.fetchedAt, 12345);
  assert.equal(snapshot.feedTimestamp, 1_700_000_000);
  assert.equal(snapshot.version, '2.0');
  assert.equal(snapshot.count, 0);
  assert.deepEqual(snapshot.vehicles, []);
});

test('cache policy: fresh within TTL, stale until the serve-stale window, expired after', () => {
  const now = 1_000_000;
  assert.equal(transitCacheState(null, now), 'none');
  assert.equal(transitCacheState({ at: Number.NaN }, now), 'none');
  assert.equal(transitCacheState({ at: now }, now), 'fresh');
  assert.equal(
    transitCacheState({ at: now - TRANSIT_PROXY_TTL_MS + 1 }, now),
    'fresh',
  );
  assert.equal(
    transitCacheState({ at: now - TRANSIT_PROXY_TTL_MS }, now),
    'stale',
  );
  assert.equal(
    transitCacheState({ at: now - TRANSIT_PROXY_STALE_MAX_MS + 1 }, now),
    'stale',
  );
  assert.equal(
    transitCacheState({ at: now - TRANSIT_PROXY_STALE_MAX_MS }, now),
    'expired',
  );
  assert.equal(transitCacheState({ at: now + 5000 }, now), 'fresh'); // clock skew never expires a fresh fetch
});

test('response headers mark cache state and never let a stale-error response be cached downstream', () => {
  assert.equal(
    transitResponseHeaders('HIT', 'cdn.mbta.com')['X-Transit-Upstream'],
    'cdn.mbta.com',
  );
  assert.equal(
    transitResponseHeaders('HIT')['Cache-Control'],
    'public, max-age=15',
  );
  assert.equal(
    transitResponseHeaders('STALE-ERROR')['Cache-Control'],
    'no-store',
  );
  assert.equal(transitResponseHeaders('MISS')['X-GEV-Cache'], 'MISS');
});
