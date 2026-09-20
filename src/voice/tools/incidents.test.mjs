import assert from 'node:assert/strict';
import test from 'node:test';
import { schemas, createHandlers } from './incidents.js';
import { captureIncident, INCIDENTS_ENDPOINT } from '../incidents.js';
import { LOCAL_TOOL_NAMES } from '../localToolSchemas.js';
import { createPositionHistory } from '../../history/positionHistory.js';

const T0 = Date.UTC(2026, 8, 16, 12, 0, 0);
const CAMERA = {
  lat: 30,
  lon: -97,
  alt: 40_000,
  heading: 0,
  pitch: -45,
  roll: 0,
};

function history() {
  const h = createPositionHistory({ now: () => T0 + 5 * 60_000 });
  for (let i = 0; i < 20; i++)
    h.recordSnapshot(
      'flights',
      [
        {
          icao24: 'abc123',
          callsign: 'NEAR1',
          lat: 30 + i * 0.001,
          lon: -97,
          altitudeM: 9000,
          heading: 0,
          speedMps: 200,
        },
        {
          icao24: 'def456',
          callsign: 'NEAR2',
          lat: 30.1,
          lon: -97 + i * 0.001,
          altitudeM: 8000,
          heading: 90,
          speedMps: 210,
        },
        {
          icao24: 'ffffff',
          callsign: 'FAR',
          lat: 50,
          lon: -97,
          altitudeM: 8000,
          heading: 90,
          speedMps: 210,
        },
      ],
      T0 + i * 15_000,
    );
  return h;
}

function context(overrides = {}) {
  const calls = [];
  return {
    calls,
    context: {
      camera: () => CAMERA,
      captureImage: async () => 'data:image/jpeg;base64,/9j/4AAQ',
      fetchJson: async (url, body) => {
        calls.push({ url, body });
        if (body === undefined)
          return {
            ok: true,
            incidents: [
              { file: 'a.html', bytes: 10 },
              { file: 'b.html', bytes: 20 },
            ],
          };
        return {
          ok: true,
          file: '20260916-120500-test.html',
          bytes: body.html.length,
        };
      },
      history: history(),
      diagnostics: () => ({
        recentTranscript: [
          { at: T0 + 4 * 60_000, role: 'user', text: 'what is that' },
        ],
        watches: [
          {
            id: 'w1',
            layer: 'military',
            description: 'military near me',
            scope: 'camera',
          },
        ],
      }),
      now: () => T0 + 5 * 60_000,
      download: false,
      speak: () => {},
      ...overrides,
    },
  };
}

test('schemas are registered as local tools', () => {
  assert.deepEqual(
    schemas.map((schema) => schema.name),
    ['export_incident', 'list_incidents'],
  );
  for (const schema of schemas) {
    assert.ok(LOCAL_TOOL_NAMES.includes(schema.name), schema.name);
    assert.equal(schema.parameters.additionalProperties, false);
  }
});

test('export_incident posts a bundle built from camera, history, transcript and watches', async () => {
  const { calls, context: ctx } = context();
  const handlers = createHandlers(ctx);
  const result = await handlers.export_incident({
    title: 'Test Export',
    minutes: 5,
    radiusKm: 50,
  });
  assert.equal(result.ok, true);
  assert.equal(result.file, '20260916-120500-test.html');
  assert.equal(result.tracks, 2);
  assert.equal(result.screenshot, true);
  assert.equal(result.downloaded, false);
  assert.ok(result.bytes > 1000);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, INCIDENTS_ENDPOINT);
  const { body } = calls[0];
  assert.equal(body.title, 'Test Export');
  assert.equal(body.slug, 'test-export');
  assert.equal(body.at, T0 + 5 * 60_000);
  assert.ok(body.html.startsWith('<!doctype html>'));
  assert.ok(body.html.includes('NEAR1'));
  assert.ok(body.html.includes('NEAR2'));
  assert.ok(!body.html.includes('FAR<'));
  assert.ok(body.html.includes('what is that'));
  assert.ok(body.html.includes('military near me'));
  assert.ok(body.html.includes('data:image/jpeg;base64,/9j/4AAQ'));
  assert.ok(body.html.includes('Camera alt 40000 m'));
});

test('export_incident defaults the title, clamps arguments, and survives a failed screenshot', async () => {
  const { calls, context: ctx } = context({
    captureImage: async () => {
      throw new Error('no canvas');
    },
  });
  const handlers = createHandlers(ctx);
  const result = await handlers.export_incident({ minutes: 99, radiusKm: 0 });
  assert.equal(result.ok, true);
  assert.equal(result.screenshot, false);
  assert.match(result.title, /^Incident 2026-09-16 12:05Z$/);
  assert.equal(result.tracks, 1);
  assert.ok(calls[0].body.html.includes('Window ±15 min'));
  assert.ok(calls[0].body.html.includes('Radius 1 km'));
});

test('export_incident reports a save failure but still returns the bundle size', async () => {
  const { context: ctx } = context({
    fetchJson: async () => {
      throw new Error('HTTP 500 from /api/voice/incidents');
    },
  });
  const result = await createHandlers(ctx).export_incident({});
  assert.equal(result.ok, false);
  assert.equal(result.file, null);
  assert.match(result.error, /HTTP 500/);
  assert.ok(result.bytes > 0);
});

test('export_incident needs a camera position', async () => {
  const { calls, context: ctx } = context({ camera: () => null });
  const result = await createHandlers(ctx).export_incident({});
  assert.deepEqual(result, { ok: false, error: 'Camera position unavailable' });
  assert.equal(calls.length, 0);
});

test('list_incidents returns the server list', async () => {
  const { calls, context: ctx } = context();
  const result = await createHandlers(ctx).list_incidents();
  assert.equal(result.ok, true);
  assert.equal(result.count, 2);
  assert.deepEqual(calls, [{ url: INCIDENTS_ENDPOINT, body: undefined }]);
  const bare = await createHandlers({}).list_incidents();
  assert.equal(bare.ok, false);
});

test('captureIncident titles the bundle after the alert and embeds it', async () => {
  const { calls, context: ctx } = context();
  const result = await captureIncident(
    {
      description: 'military within 50 km',
      layer: 'military',
      label: 'RCH123',
    },
    ctx,
  );
  assert.equal(result.ok, true);
  assert.equal(result.title, 'military within 50 km — RCH123');
  assert.equal(calls[0].body.slug, 'military-within-50-km-rch123');
  assert.ok(calls[0].body.html.includes('military within 50 km (military)'));
});
