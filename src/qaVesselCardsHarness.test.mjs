import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

import {
  DEFAULT_DATA_MODE,
  buildVesselCardManifest,
  isHardwareRenderer,
  isHeadfulMode,
  parseDataMode,
  vesselCardCaptureUrl,
  installSyntheticVesselFeed,
  vesselCardManifestFilename,
  vesselCardProvenanceLines,
  vesselCardScreenshotFilename,
} from '../scripts/qa-vessel-cards.mjs';

test('vessel-card QA keeps live AISStream as the default and synthetic opt-in', () => {
  assert.equal(DEFAULT_DATA_MODE, 'live');
  assert.equal(parseDataMode([]), 'live');
  assert.equal(parseDataMode(['--data', 'synthetic']), 'synthetic');
  assert.equal(isHeadfulMode([]), false);
  assert.equal(isHeadfulMode(['--headful']), true);
  assert.throws(
    () => parseDataMode(['--data', 'fixture']),
    /Unknown --data mode 'fixture'/,
  );
});

test('vessel-card QA filenames cannot collide across live and synthetic evidence', () => {
  const shared = { tag: 'new', portKey: 'rotterdam' };
  const live = vesselCardScreenshotFilename({ ...shared, dataMode: 'live' });
  const synthetic = vesselCardScreenshotFilename({ ...shared, dataMode: 'synthetic' });

  assert.equal(live, 'vessel-cards-live-aisstream-new-rotterdam.png');
  assert.equal(synthetic, 'vessel-cards-synthetic-fixture-new-rotterdam.png');
  assert.notEqual(live, synthetic);
  assert.equal(
    vesselCardManifestFilename(synthetic),
    'vessel-cards-synthetic-fixture-new-rotterdam.json',
  );
});

test('vessel-card QA output makes synthetic provenance and upstream context explicit', () => {
  const live = vesselCardProvenanceLines('live').join('\n');
  const synthetic = vesselCardProvenanceLines('synthetic').join('\n');

  assert.match(live, /LIVE AISStream feed/);
  assert.match(live, /no synthetic vessel rows/i);
  assert.match(synthetic, /SYNTHETIC FIXTURE/);
  assert.match(synthetic, /not evidence of live AISStream availability/i);
  assert.match(synthetic, /AISStream Issue #23: https:\/\/github\.com\/aisstream\/aisstream\/issues\/23/);
  assert.match(synthetic, /AISStream Issue #15: https:\/\/github\.com\/aisstream\/aisstream\/issues\/15/);
});

test('vessel-card QA manifest binds screenshot provenance, launch mode, and renderer', () => {
  const manifest = buildVesselCardManifest({
    dataMode: 'synthetic',
    tag: 'new',
    portKey: 'houston',
    screenshot: 'vessel-cards-synthetic-fixture-new-houston.png',
    headful: true,
    renderer: { vendor: 'Apple', renderer: 'Apple M-series' },
    captureEvidence: {
      tilesAndVesselsSettled: true,
      injectedRows: 8,
      syntheticFixtureRowsRetained: true,
      overlayEntries: 8,
      overlayPainted: 8,
      hardwareAccelerated: true,
      passed: true,
    },
    appUrl: 'http://localhost:4173',
    capturedAt: '2026-08-14T00:00:00.000Z',
  });

  assert.equal(manifest.dataMode, 'synthetic');
  assert.equal(manifest.provenance, 'synthetic-fixture');
  assert.equal(manifest.liveAisStreamAvailabilityAsserted, false);
  assert.equal(manifest.launchMode, 'headful');
  assert.equal(manifest.renderer.renderer, 'Apple M-series');
  assert.equal(manifest.captureEvidence.syntheticFixtureRowsRetained, true);
  assert.equal(manifest.captureEvidence.passed, true);
  assert.deepEqual(manifest.upstreamContext, [
    'https://github.com/aisstream/aisstream/issues/23',
    'https://github.com/aisstream/aisstream/issues/15',
  ]);
});

test('vessel-card QA distinguishes hardware evidence from software rendering', () => {
  assert.equal(isHardwareRenderer({ vendor: 'Apple', renderer: 'ANGLE Metal Renderer: Apple M3' }), true);
  assert.equal(isHardwareRenderer({ vendor: 'Google Inc.', renderer: 'ANGLE (SwiftShader)' }), false);
  assert.equal(isHardwareRenderer({ vendor: 'unavailable', renderer: 'unavailable' }), false);
});

test('synthetic card URL removes competing qaFeed while live mode preserves it', () => {
  const input =
    'http://127.0.0.1:4193/?engine=navara&qaFeed=vessels:fixture#v=2';
  const synthetic = new URL(vesselCardCaptureUrl(input, 'synthetic'));
  assert.equal(synthetic.searchParams.has('qaFeed'), false);
  assert.equal(synthetic.searchParams.get('engine'), 'navara');
  assert.equal(synthetic.hash, '#v=2');
  assert.equal(
    new URL(vesselCardCaptureUrl(input, 'live')).searchParams.get('qaFeed'),
    'vessels:fixture',
  );
});

function fixtureWindow() {
  const rows = [{ mmsi: '990100000', lat: 51.95, lon: 4.1, name: 'QA' }];
  const clock = { nowMs: 1000 };
  const calls = [];
  const window = {
    fetch: (...args) => {
      calls.push(args);
      return Promise.resolve('passthrough');
    },
  };
  runInNewContext(`(${installSyntheticVesselFeed.toString()})(rows)`, {
    rows,
    window,
    location: {
      href: 'http://127.0.0.1:4193/',
      origin: 'http://127.0.0.1:4193',
    },
    URL,
    Response,
    Date: { now: () => clock.nowMs },
  });
  return { rows, clock, calls, window };
}

test('a late vessel refresh retains the exact card fixture with fresh receipt stamps', async () => {
  const { window, rows, clock, calls } = fixtureWindow();
  const first = await (await window.fetch('/api/vessels?lat=51.95')).json();
  clock.nowMs = 5000;
  const late = await (
    await window.fetch(
      new Request('http://127.0.0.1:4193/api/vessels?lat=29.7'),
    )
  ).json();
  assert.deepEqual(
    first.rows.map((row) => row.mmsi),
    ['990100000'],
  );
  assert.deepEqual(
    late.rows.map((row) => row.mmsi),
    ['990100000'],
  );
  assert.equal(late.newestPositionAt, 5000);
  assert.equal(late.rows[0].last_position_epoch, 5);
  const urlInput = await (
    await window.fetch(new URL('http://127.0.0.1:4193/api/vessels'))
  ).json();
  assert.deepEqual(
    urlInput.rows.map((row) => row.mmsi),
    ['990100000'],
  );
  assert.equal(rows[0].last_position_epoch, undefined);
  assert.equal(calls.length, 0);
});

test('the card fixture leaves other paths and external origins to the original fetch', async () => {
  const { window, calls } = fixtureWindow();
  assert.equal(await window.fetch('/api/vessels/track'), 'passthrough');
  assert.equal(
    await window.fetch('https://example.invalid/api/vessels'),
    'passthrough',
  );
  assert.equal(calls.length, 2);
});
