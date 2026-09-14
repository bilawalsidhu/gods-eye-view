import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrecipitationSource } from './source.js';
import { PRECIPITATION_TIERS } from './policy.js';
import {
  forecastLeadHours,
  frameMessage,
  inlayMessage,
  leadLabel,
  liveFrame,
  readFrame,
} from './model.js';

const [GLOBAL_TIER] = PRECIPITATION_TIERS;

const capabilities = (attributes) => `<?xml version="1.0"?>
<WMS_Capabilities><Capability><Layer><Layer queryable="1">
  <Name>GDPS_15km_PrecipRate</Name>
  ${attributes}
</Layer></Layer></Capability></WMS_Capabilities>`;

const TIME_DIMENSIONS = `
  <Dimension name="time" units="ISO8601" default="2026-09-14T15:00:00Z" nearestValue="0">2026-09-14T01:00:00Z</Dimension>
  <Dimension name="reference_time" units="ISO8601" default="2026-09-14T00:00:00Z" nearestValue="0">2026-09-14T00:00:00Z</Dimension>`;

const ok = (body, type = 'text/xml') =>
  new Response(body, { status: 200, headers: { 'Content-Type': type } });

test('construction is inert and the pinned origin is the only host contacted', async () => {
  createPrecipitationSource({
    fetchImpl: () => assert.fail('construction fetched data'),
  });

  const calls = [];
  const source = createPrecipitationSource({
    fetchImpl: (url) => {
      calls.push(String(url));
      return Promise.resolve(ok(capabilities(TIME_DIMENSIONS)));
    },
  });
  for (const service of [
    'http://geo.weather.gc.ca/geomet',
    'https://attacker.example/geomet',
    'file:///etc/passwd',
  ]) {
    await assert.rejects(
      source.getFrame({ ...GLOBAL_TIER, service }),
      /pinned HTTPS precipitation service/,
    );
  }
  assert.equal(calls.length, 0, 'a rejected service must not be fetched');

  await source.getFrame(GLOBAL_TIER);
  assert.equal(calls.length, 1);
  const url = new URL(calls[0]);
  assert.equal(url.origin, 'https://geo.weather.gc.ca');
  // The unfiltered capabilities document is ~39 MB; the layer filter is load-bearing.
  assert.equal(url.searchParams.get('LAYERS'), 'GDPS_15km_PrecipRate');
  assert.equal(url.searchParams.get('REQUEST'), 'GetCapabilities');
});

test('a 200 carrying a service exception is a failure, not an empty frame', async () => {
  const exception = `<?xml version='1.0'?>
    <ogc:ServiceExceptionReport version="1.3.0" xmlns:ogc="http://www.opengis.net/ogc">
    <ogc:ServiceException code="InvalidLayersParameter">Layer not available</ogc:ServiceException>
    </ogc:ServiceExceptionReport>`;
  const source = createPrecipitationSource({
    fetchImpl: async () => ok(exception),
  });
  // Cesium answers a non-image body with an empty layer and no error, so the
  // status code alone can never be the health check.
  await assert.rejects(
    source.getFrame(GLOBAL_TIER),
    /returned a service exception/,
  );
});

test('malformed and incomplete capabilities reject instead of reading as empty', async () => {
  const cases = [
    // A document with no such layer is a different failure from a layer with
    // no time, and saying which one it is decides where to look.
    ['', /GDPS_15km_PrecipRate is not in the capabilities/],
    [
      '<WMS_Capabilities></WMS_Capabilities>',
      /GDPS_15km_PrecipRate is not in the capabilities/,
    ],
    [capabilities(''), /frame time is unavailable/],
    [
      capabilities('<Dimension name="time" default="not-a-date"></Dimension>'),
      /frame time is malformed/,
    ],
  ];
  for (const [body, pattern] of cases) {
    const source = createPrecipitationSource({
      fetchImpl: async () => ok(body),
    });
    await assert.rejects(source.getFrame(GLOBAL_TIER), pattern);
  }
  const failing = createPrecipitationSource({
    fetchImpl: async () => new Response('nope', { status: 503 }),
  });
  await assert.rejects(failing.getFrame(GLOBAL_TIER), /ECCC GDPS HTTP 503/);
});

test('cancellation is honored after the body resolves', async () => {
  const controller = new AbortController();
  const source = createPrecipitationSource({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async text() {
        controller.abort();
        return capabilities(TIME_DIMENSIONS);
      },
    }),
  });
  await assert.rejects(
    source.getFrame(GLOBAL_TIER, { signal: controller.signal }),
    (error) => error?.name === 'AbortError',
  );
});

test('a model frame reports its run, its valid step and the resulting lead', async () => {
  const source = createPrecipitationSource({
    fetchImpl: async () => ok(capabilities(TIME_DIMENSIONS)),
  });
  const frame = await source.getFrame(GLOBAL_TIER);
  assert.deepEqual(frame, {
    key: '2026-09-14T15:00:00Z',
    validTime: '2026-09-14T15:00:00Z',
    referenceTime: '2026-09-14T00:00:00Z',
  });
  assert.equal(forecastLeadHours(frame), 15);
  assert.equal(leadLabel(frame), '+15H');
  assert.equal(
    frameMessage(GLOBAL_TIER, frame),
    'MODEL · 00Z RUN · VALID 15:00Z',
  );
});

test('an observation frame carries no run, so it claims no forecast lead', () => {
  const frame = readFrame(
    capabilities(
      '<Dimension name="time" units="ISO8601" default="2026-09-14T13:52:01Z" nearestValue="1">x</Dimension>',
    ),
    'GDPS_15km_PrecipRate',
  );
  assert.equal(frame.referenceTime, null);
  assert.equal(forecastLeadHours(frame), null);
  assert.equal(leadLabel(frame), 'LIVE');
  assert.equal(
    frameMessage({ label: 'NOAA MRMS', forecast: false }, frame),
    'OBSERVED · VALID 13:52Z',
  );
});

test('an undated service is reported as live, never stamped with the epoch', () => {
  // `new Date(null)` is 1970-01-01, so a missing valid time once rendered as
  // "US RADAR 00:00Z" — a timestamp the service never published.
  const frame = liveFrame(1_760_000_000_000);
  assert.equal(frame.validTime, null);
  assert.equal(leadLabel(frame), 'LIVE');
  assert.equal(
    inlayMessage({ inlayLabel: 'US RADAR' }, frame),
    'US RADAR LIVE',
  );
  assert.ok(frame.key.startsWith('live:'), 'a poll stamp still drives refresh');
});

test('the frame comes from the named layer, not the first one in the document', () => {
  // GeoMet honours `&LAYERS=` and answers with one layer, so a document-wide
  // scan worked. A service that ignores the filter would have handed the layer
  // some neighbouring product's step with no error at all — the failure mode
  // this scoping exists to remove.
  const document = `<?xml version="1.0"?>
<WMS_Capabilities><Capability><Layer>
  <Layer queryable="1">
    <Name>GDPS_15km_AirTemp</Name>
    <!-- A style may be named after another layer; that is not a layer name,
         and it sits ahead of the real one so a loose match would take it. -->
    <Style><Name>GDPS_15km_PrecipRate</Name></Style>
    <Dimension name="time" default="1999-01-01T00:00:00Z">x</Dimension>
  </Layer>
  <Layer queryable="1">
    <Name>GDPS_15km_PrecipRate</Name>
    <Dimension name="time" default="2026-09-14T15:00:00Z">x</Dimension>
    <Dimension name="reference_time" default="2026-09-14T00:00:00Z">x</Dimension>
  </Layer>
</Layer></Capability></WMS_Capabilities>`;
  const frame = readFrame(document, 'GDPS_15km_PrecipRate');
  assert.equal(frame.validTime, '2026-09-14T15:00:00Z');
  assert.equal(frame.referenceTime, '2026-09-14T00:00:00Z');
  assert.equal(
    readFrame(document, 'GDPS_15km_AirTemp').validTime,
    '1999-01-01T00:00:00Z',
  );
});

test('a nested layer inherits its parents time, and overrides it when it says so', () => {
  // WMS layers nest and a child inherits its ancestors' dimensions, so the
  // step a layer draws at is not always declared on the layer itself.
  const document = (own) => `<?xml version="1.0"?>
<WMS_Capabilities><Capability>
  <Layer>
    <Name>root</Name>
    <Dimension name="time" default="2026-09-14T12:00:00Z">x</Dimension>
    <Layer queryable="1">
      <Name>msg_fes:h60b</Name>
      ${own}
    </Layer>
  </Layer>
</Capability></WMS_Capabilities>`;
  assert.equal(
    readFrame(document(''), 'msg_fes:h60b').validTime,
    '2026-09-14T12:00:00Z',
    'an inherited step must be found',
  );
  assert.equal(
    readFrame(
      document(
        '<Dimension name="time" default="2026-09-14T15:15:00Z">x</Dimension>',
      ),
      'msg_fes:h60b',
    ).validTime,
    '2026-09-14T15:15:00Z',
    'the nearest declaration wins over the inherited one',
  );
  // The parent still reads as itself.
  assert.equal(
    readFrame(document(''), 'root').validTime,
    '2026-09-14T12:00:00Z',
  );
});

test('reading a frame without naming the layer is refused, not guessed at', () => {
  assert.throws(
    () => readFrame(capabilities(TIME_DIMENSIONS)),
    /requires the layer to read it from/,
  );
});
