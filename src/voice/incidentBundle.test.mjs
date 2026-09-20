import assert from 'node:assert/strict';
import test from 'node:test';
import { createPositionHistory } from '../history/positionHistory.js';
import {
  buildIncidentBundle,
  bundleBytes,
  collectIncidentTracks,
  incidentSlug,
  thinFixes,
  MAX_BUNDLE_FIXES,
} from './incidentBundle.js';

const T0 = Date.UTC(2026, 8, 16, 12, 0, 0);
const CENTER = { lat: 30, lon: -97 };

/** Twenty flights circling within 40 km of the center for ten minutes. */
function sampleHistory({ tracks = 20, fixes = 60, spacingMs = 10_000 } = {}) {
  const history = createPositionHistory({ now: () => T0 + 10 * 60_000 });
  for (let i = 0; i < fixes; i++) {
    const t = T0 + i * spacingMs;
    const records = [];
    for (let k = 0; k < tracks; k++) {
      const angle = (i / fixes) * Math.PI * 2 + k;
      records.push({
        icao24: `a${k.toString(16).padStart(5, '0')}`,
        callsign: `TRK${k}`,
        lat: CENTER.lat + Math.sin(angle) * 0.2,
        lon: CENTER.lon + Math.cos(angle) * 0.2,
        altitudeM: 9000 + k * 10,
        heading: (angle * 180) / Math.PI,
        speedMps: 230,
      });
    }
    // One far-away flight that must not be included.
    records.push({
      icao24: 'ffffff',
      callsign: 'FARAWAY',
      lat: 45,
      lon: -120,
      altitudeM: 10000,
      heading: 90,
      speedMps: 250,
    });
    history.recordSnapshot('flights', records, t);
  }
  return history;
}

function embeddedData(html) {
  const match = html.match(
    /<script id="incident-data" type="application\/json">([\s\S]*?)<\/script>/,
  );
  assert.ok(match, 'bundle embeds incident data');
  return JSON.parse(match[1]);
}

test('collects tracks near the center inside the window and drops the rest', () => {
  const history = sampleHistory();
  const tracks = collectIncidentTracks(history, {
    at: T0 + 5 * 60_000,
    windowMs: 5 * 60_000,
    center: CENTER,
    radiusKm: 50,
  });
  assert.equal(tracks.length, 20);
  assert.ok(tracks.every((track) => track.label !== 'FARAWAY'));
  assert.ok(tracks.every((track) => track.fixes.length > 0));
  for (const track of tracks)
    for (const fix of track.fixes)
      assert.ok(fix.t >= T0 && fix.t <= T0 + 10 * 60_000);
});

test('window filtering drops fixes outside [at - window, at + window]', () => {
  const history = sampleHistory();
  const tracks = collectIncidentTracks(history, {
    at: T0 + 9 * 60_000,
    windowMs: 60_000,
    center: CENTER,
    radiusKm: 50,
  });
  assert.equal(tracks.length, 20);
  for (const track of tracks)
    for (const fix of track.fixes)
      assert.ok(fix.t >= T0 + 8 * 60_000 && fix.t <= T0 + 10 * 60_000);
});

test('accepts a plain track array and applies the radius', () => {
  const tracks = collectIncidentTracks(
    [
      {
        layerId: 'flights',
        id: 'near',
        label: 'NEAR',
        fixes: [{ t: T0, lat: 30.1, lon: -97 }],
      },
      {
        layerId: 'flights',
        id: 'far',
        label: 'FAR',
        fixes: [{ t: T0, lat: 35, lon: -97 }],
      },
      {
        layerId: 'flights',
        id: 'late',
        label: 'LATE',
        fixes: [{ t: T0 + 3_600_000, lat: 30, lon: -97 }],
      },
    ],
    { at: T0, windowMs: 60_000, center: CENTER, radiusKm: 50 },
  );
  assert.deepEqual(
    tracks.map((track) => track.label),
    ['NEAR'],
  );
});

test('bundle contains the title, every track, and no external references', () => {
  const history = sampleHistory();
  const html = buildIncidentBundle({
    title: 'Runway <incursion> & "test"',
    at: T0 + 5 * 60_000,
    windowMs: 5 * 60_000,
    center: CENTER,
    radiusKm: 50,
    history,
    transcript: [
      { at: T0 + 4 * 60_000, role: 'user', text: 'what is that <plane>' },
      { at: T0 + 4 * 60_000 + 5000, role: 'assistant', text: 'TRK3, a 737' },
    ],
    alerts: [{ description: 'military within 50 km', layer: 'military' }],
    notes: 'Observed from tower cam.',
  });
  assert.match(html, /^<!doctype html>/);
  assert.ok(html.includes('Runway &lt;incursion&gt; &amp; &quot;test&quot;'));
  assert.ok(!html.includes('Runway <incursion>'));
  for (let k = 0; k < 20; k++) assert.ok(html.includes(`TRK${k}`), `TRK${k}`);
  assert.ok(!html.includes('FARAWAY'));
  assert.ok(html.includes('what is that &lt;plane&gt;'));
  assert.ok(html.includes('military within 50 km'));
  assert.ok(html.includes('Observed from tower cam.'));
  assert.doesNotMatch(html, /https?:\/\//);
  assert.doesNotMatch(html, /src="\/\//);
  assert.doesNotMatch(html, /<link\b/);
  assert.ok(html.includes('id="scrub"'));
  assert.ok(html.includes('id="play"'));
  assert.ok(html.includes('<canvas id="map"'));
  const data = embeddedData(html);
  assert.equal(data.tracks.length, 20);
  assert.equal(data.title, 'Runway <incursion> & "test"');
  assert.deepEqual(data.center, CENTER);
  assert.ok(data.tracks.every((track) => track.fixes.length > 0));
});

test('a twenty-track bundle stays under 400 KB before the screenshot', () => {
  const history = sampleHistory({ tracks: 20, fixes: 60 });
  const html = buildIncidentBundle({
    title: 'Size check',
    at: T0 + 5 * 60_000,
    windowMs: 5 * 60_000,
    center: CENTER,
    radiusKm: 50,
    history,
  });
  const bytes = bundleBytes(html);
  assert.ok(bytes < 400 * 1024, `bundle is ${bytes} bytes`);
});

test('dense histories are thinned to the fix budget', () => {
  const tracks = [];
  for (let k = 0; k < 100; k++) {
    const fixes = [];
    for (let i = 0; i < 200; i++)
      fixes.push({
        t: T0 + i * 1000,
        lat: 30 + k * 0.001,
        lon: -97 + i * 0.0001,
      });
    tracks.push({ layerId: 'flights', id: `t${k}`, label: `T${k}`, fixes });
  }
  const collected = collectIncidentTracks(tracks, {
    at: T0 + 100_000,
    windowMs: 200_000,
    center: CENTER,
    radiusKm: 50,
  });
  const total = collected.reduce((sum, track) => sum + track.fixes.length, 0);
  assert.ok(total <= MAX_BUNDLE_FIXES, `${total} fixes`);
  assert.equal(collected.length, 100);
  const html = buildIncidentBundle({
    title: 'Dense',
    at: T0 + 100_000,
    windowMs: 200_000,
    center: CENTER,
    radiusKm: 50,
    history: tracks,
  });
  assert.ok(bundleBytes(html) < 400 * 1024);
});

test('embeds the screenshot data URL and ignores non-image values', () => {
  const shot = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
  const withShot = buildIncidentBundle({
    title: 'Shot',
    center: CENTER,
    screenshotDataUrl: shot,
  });
  assert.ok(withShot.includes(`src="${shot}"`));
  const without = buildIncidentBundle({
    title: 'Shot',
    center: CENTER,
    screenshotDataUrl: 'javascript:alert(1)',
  });
  assert.ok(!without.includes('javascript:alert'));
  assert.ok(without.includes('No screenshot captured.'));
});

test('empty history still renders a complete document', () => {
  const html = buildIncidentBundle({
    title: 'Nothing here',
    center: CENTER,
    history: [],
  });
  assert.ok(html.includes('Nothing here'));
  assert.ok(html.includes('No tracks inside the radius'));
  assert.equal(embeddedData(html).tracks.length, 0);
});

test('helpers: thinFixes keeps ends, incidentSlug is file safe', () => {
  const fixes = Array.from({ length: 10 }, (_, i) => ({ t: i }));
  const thinned = thinFixes(fixes, 4);
  assert.equal(thinned.length, 4);
  assert.equal(thinned[0].t, 0);
  assert.equal(thinned[3].t, 9);
  assert.deepEqual(thinFixes(fixes, 20), fixes);
  assert.equal(
    incidentSlug('Runway Incursion @ KAUS!'),
    'runway-incursion-kaus',
  );
  assert.equal(incidentSlug(''), 'incident');
  assert.equal(incidentSlug('x'.repeat(80)).length, 40);
});
