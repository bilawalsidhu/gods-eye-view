// Unit tests for the engine-independent ORYN prototype modules: validated
// local persistence, record models, feed-state derivation, camera registry
// rules, mode presets and report export.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createCollection, resolveStorage, cleanText } from './store.js';
import {
  validateScene,
  validateInvestigation,
  validateEntityRef,
  validateNote,
  validateSession,
} from './models.js';
import {
  describeFeed,
  orynFeedState,
  feedStateLabel,
  formatAge,
} from './provenance.js';
import {
  validateCamera,
  createCameraRegistry,
  createDemoCameraProvider,
  createUnconfiguredOrganizationProvider,
  DEMO_CAMERAS,
} from './cameras.js';
import {
  createInferenceRegistry,
  createUnconfiguredInferenceProvider,
  MODEL_DEFINITIONS,
} from './ml.js';
import { MODES, applyMode, modeById } from './modes.js';
import {
  buildInvestigationReport,
  toCsv,
  csvEscape,
  reportEntitiesCsv,
  safeFileName,
} from './reports.js';
import { createWorkspace } from './workspace.js';
import { createSessionStore } from './session.js';
import { eventToEntityRef, selectionToEntityRef } from './engine.js';

function memory() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => void map.set(key, String(value)),
    removeItem: (key) => void map.delete(key),
    dump: () => Object.fromEntries(map),
  };
}

test('resolveStorage falls back to memory when storage throws', () => {
  const broken = {
    setItem() {
      throw new Error('quota');
    },
  };
  const storage = resolveStorage(broken);
  storage.setItem('a', '1');
  assert.equal(storage.getItem('a'), '1');
});

test('collections validate on write and on read, dropping corrupt records', () => {
  const storage = memory();
  const validate = (value) =>
    value && typeof value.id === 'string' && typeof value.name === 'string'
      ? { id: value.id, name: value.name }
      : null;
  const first = createCollection('things', validate, { storage });
  first.put({ id: 'a', name: 'Alpha', extra: 'dropped' });
  assert.throws(() => first.put({ id: 'b' }), /validation/);
  assert.deepEqual(first.list(), [{ id: 'a', name: 'Alpha' }]);
  // Corrupt the stored document by hand.
  const key = first.key;
  storage.setItem(
    key,
    JSON.stringify({
      version: 1,
      items: [{ id: 'a', name: 'Alpha' }, { bogus: true }, 'junk'],
    }),
  );
  const second = createCollection('things', validate, { storage });
  assert.deepEqual(second.list(), [{ id: 'a', name: 'Alpha' }]);
  assert.equal(second.droppedCount, 2);
  assert.equal(second.remove('a'), true);
  assert.equal(second.remove('a'), false);
});

test('cleanText bounds length and rejects non-strings', () => {
  assert.equal(cleanText(42), null);
  assert.equal(cleanText('  hi  '), 'hi');
  assert.equal(cleanText('x'.repeat(10), 4), 'xxxx');
});

test('scene validation requires a usable camera and normalizes the rest', () => {
  assert.equal(validateScene({ name: 'No camera' }), null);
  assert.equal(
    validateScene({ name: 'Bad', camera: { position: { lon: 200, lat: 0, height: 1 } } }),
    null,
  );
  const scene = validateScene({
    name: '  Downtown  ',
    camera: { position: { lon: -97.7, lat: 30.3, height: 1500 }, heading: 'x' },
    enabledLayers: ['flights', 7, '', 'earthquakes'],
    mode: 'live-ops',
    panels: { inspector: 'yes', layers: true },
    selection: { kind: 'earthquake', id: 'q1', position: { lon: 1, lat: 2 } },
  });
  assert.equal(scene.name, 'Downtown');
  assert.match(scene.id, /^scene_/);
  assert.deepEqual(scene.enabledLayers, ['flights', 'earthquakes']);
  assert.equal(scene.camera.heading, 0);
  assert.deepEqual(scene.panels, { inspector: false, layers: true, timeline: false });
  assert.equal(scene.selection.kind, 'earthquake');
  assert.ok(Date.parse(scene.createdAt));
});

test('entity references keep provenance and only clean fields', () => {
  assert.equal(validateEntityRef({ id: 'x' }), null);
  const ref = validateEntityRef({
    kind: 'aircraft',
    id: 'abc123',
    provenance: 'bogus',
    sourceUrl: 'javascript:alert(1)',
    observedAt: 'not a date',
    fields: { callsign: 'UAL1', nested: { no: true }, speed: 410, flag: false },
  });
  assert.equal(ref.provenance, 'provider');
  assert.equal(ref.sourceUrl, undefined);
  assert.equal(ref.observedAt, undefined);
  assert.deepEqual(ref.fields, { callsign: 'UAL1', speed: 410, flag: false });
});

test('investigations, notes and sessions are normalized', () => {
  const investigation = validateInvestigation({
    title: 'Flood watch',
    status: 'invalid',
    entities: [{ kind: 'camera', id: 'c1' }, { nope: true }],
    timeline: [{ at: 'bad', text: 'x' }, { at: '2026-01-01T00:00:00Z', text: 'Opened' }],
  });
  assert.equal(investigation.status, 'open');
  assert.equal(investigation.entities.length, 1);
  assert.equal(investigation.timeline.length, 1);
  assert.equal(investigation.timeline[0].provenance, 'analyst');
  assert.equal(validateNote({ body: '' }), null);
  assert.equal(validateNote({ body: 'A note' }).provenance, 'analyst');
  const session = validateSession({ user: 'Ana', organization: 'Org', demo: false });
  assert.equal(session.demo, true);
  assert.equal(validateSession({ user: 'Ana' }), null);
});

test('feed states derive from engine stats and never invent currency', () => {
  const now = Date.parse('2026-10-17T12:00:00Z');
  const off = describeFeed({ id: 'a', name: 'A', enabled: false, stats: {} }, { now });
  assert.equal(off.state, 'off');
  const loading = describeFeed({ id: 'a', name: 'A', enabled: true, stats: { loading: true } }, { now });
  assert.equal(loading.state, 'loading');
  const current = describeFeed(
    { id: 'a', name: 'A', source: 'USGS', enabled: true, stats: { count: 3, lastUpdate: now - 1000 } },
    { now },
  );
  assert.equal(current.state, 'current');
  assert.equal(current.source, 'USGS');
  const stale = describeFeed(
    { id: 'a', name: 'A', enabled: true, stats: { count: 3, lastUpdate: now - 1000, stale: true } },
    { now },
  );
  assert.equal(stale.state, 'stale');
  const unavailable = describeFeed(
    { id: 'a', name: 'A', enabled: true, stats: { sourceUnavailable: true, status: 'unavailable', error: 'KEY not set' } },
    { now },
  );
  assert.equal(unavailable.state, 'unavailable');
  assert.equal(unavailable.error, 'KEY not set');
  assert.equal(orynFeedState('degraded'), 'partial');
  assert.equal(orynFeedState('nominal'), 'current');
  assert.equal(feedStateLabel('stale'), 'STALE');
  assert.equal(formatAge(now - 90_000, now), '2 min ago');
  assert.equal(formatAge('nope', now), null);
});

test('camera records never claim a stream without a verified media URL', () => {
  const unverified = validateCamera({
    id: 'c1',
    name: 'Cam',
    lat: 1,
    lon: 2,
    status: 'online',
    stream: { kind: 'hls', url: 'https://example.org/live.m3u8', verified: false },
  });
  assert.equal(unverified.stream, null);
  assert.equal(unverified.status, 'unknown', 'online without a stream is downgraded');
  const verified = validateCamera({
    id: 'c2',
    name: 'Cam',
    lat: 1,
    lon: 2,
    status: 'online',
    stream: { kind: 'mp4', url: 'https://example.org/clip.mp4', verified: true },
  });
  assert.equal(verified.stream.kind, 'mp4');
  assert.equal(verified.status, 'online');
  assert.equal(validateCamera({ id: 'c3', name: 'Bad', lat: 95, lon: 0 }), null);
  for (const record of DEMO_CAMERAS) {
    const clean = validateCamera(record);
    assert.equal(clean.demo, true);
    assert.equal(clean.stream, null);
  }
});

test('camera registry aggregates providers and reports unconfigured ones', async () => {
  const registry = createCameraRegistry([
    createDemoCameraProvider(),
    createUnconfiguredOrganizationProvider(),
  ]);
  const snapshot = await registry.refresh();
  assert.equal(snapshot.cameras.length, DEMO_CAMERAS.length);
  const states = Object.fromEntries(snapshot.providerStates.map((s) => [s.id, s]));
  assert.equal(states.demo.status, 'ready');
  assert.equal(states.organization.status, 'not-configured');
  assert.ok(states.organization.setupHint);
});

test('inference registry exposes models as not configured and refuses to run', async () => {
  const registry = createInferenceRegistry([createUnconfiguredInferenceProvider()]);
  assert.equal(registry.models, MODEL_DEFINITIONS);
  const info = registry.describe('vehicle-count');
  assert.equal(info.status, 'not-configured');
  assert.equal(info.provider, null);
  await assert.rejects(
    registry.providers[0].run({ modelId: 'vehicle-count', input: {} }),
    /not configured/,
  );
});

test('modes only touch managed layers and report what could not be enabled', async () => {
  const rows = new Map([
    ['flights', { id: 'flights', enabled: false, stats: {} }],
    ['ais-live-vessels', { id: 'ais-live-vessels', enabled: false, stats: { sourceUnavailable: true, error: 'KEY' } }],
    ['earthquakes', { id: 'earthquakes', enabled: true, stats: {} }],
    ['radio', { id: 'radio', enabled: true, stats: {} }],
  ]);
  const calls = [];
  const engine = {
    dataManager: { getAll: () => [...rows.values()] },
    async setLayerEnabled(id, enabled) {
      calls.push([id, enabled]);
      rows.get(id).enabled = enabled;
    },
  };
  const { mode, skipped } = await applyMode(engine, 'transportation');
  assert.equal(mode.id, 'transportation');
  assert.deepEqual(calls.sort(), [['earthquakes', false], ['flights', true]]);
  assert.ok(skipped.some((entry) => entry.id === 'ais-live-vessels'));
  assert.ok(skipped.some((entry) => entry.id === 'transit' && entry.reason === 'not registered'));
  assert.equal(rows.get('radio').enabled, true, 'unmanaged layers stay as they were');
  assert.equal(modeById('nope').id, 'globe');
  assert.ok(MODES.every((entry) => typeof entry.label === 'string'));
});

test('event and selection records become entity references with provenance', () => {
  const quake = eventToEntityRef(
    'earthquakes',
    { id: 'us6000abcd', magnitude: 4.8, depthKm: 10, lat: -16, lon: -177, timeMs: 1_760_000_000_000, place: 'Near Alo' },
    { source: 'USGS', retrievedAt: 1_760_000_100_000 },
  );
  assert.equal(quake.kind, 'earthquake');
  assert.equal(quake.label, 'M4.8 Near Alo');
  assert.match(quake.sourceUrl, /eventpage\/us6000abcd$/);
  assert.equal(quake.observedAt, new Date(1_760_000_000_000).toISOString());
  assert.equal(quake.retrievedAt, new Date(1_760_000_100_000).toISOString());
  assert.deepEqual(quake.fields, { magnitude: 4.8, depthKm: 10 });
  const fallbackId = eventToEntityRef('earthquakes', { id: 'QUAKE-0001', lat: 0, lon: 0 }, {});
  assert.equal(fallbackId.sourceUrl, undefined);
  const vessel = selectionToEntityRef(
    { id: 'ais-123', layerId: 'ais-live-vessels', label: 'EVER GIVEN', latitude: 30, longitude: 32, properties: { mmsi: '123', nested: { a: 1 } }, updatedAt: 1_760_000_000_000 },
    new Map([['ais-live-vessels', { source: 'AISStream', lastUpdate: 1 }]]),
  );
  assert.equal(vessel.kind, 'vessel');
  assert.equal(vessel.source, 'AISStream');
  assert.deepEqual(vessel.fields, { mmsi: '123' });
  assert.equal(selectionToEntityRef(null), null);
});

test('workspace records investigations, evidence, scenes and audit locally', async () => {
  const storage = memory();
  const session = createSessionStore({ storage });
  session.signIn({ user: 'Ana', organizationId: 'demo-city', role: 'operator' });
  const workspace = createWorkspace({ storage, session });
  const investigation = workspace.createInvestigation({ title: 'Bridge closure' });
  assert.equal(investigation.owner, 'Ana');
  assert.equal(investigation.organizationId, 'demo-city');
  const ref = validateEntityRef({ kind: 'camera', id: 'cam-1', label: 'Bridge cam' });
  workspace.addEntityToInvestigation(investigation.id, ref);
  workspace.addEntityToInvestigation(investigation.id, ref);
  const stored = workspace.investigations.get(investigation.id);
  assert.equal(stored.entities.length, 1, 'duplicate evidence is ignored');
  assert.equal(stored.timeline.length, 2);
  const engine = {
    getCameraState: () => ({ lat: 1, lon: 2, alt: 300, heading: 10, pitch: -40, roll: 0 }),
    dataManager: {
      getEnabledLayerIds: () => ['cctv'],
      getAll: () => [
        { id: 'cctv', enabled: false, showInTogglePanel: true },
        { id: 'flights', enabled: true, showInTogglePanel: true },
      ],
    },
    applied: [],
    applyCameraState(state) {
      this.applied.push(state);
    },
    async setLayerEnabled(id, enabled) {
      this.applied.push([id, enabled]);
    },
  };
  const scene = workspace.saveScene(engine, { name: 'Bridge', mode: 'municipal', investigationId: investigation.id });
  assert.deepEqual(scene.enabledLayers, ['cctv']);
  const result = await workspace.applyScene(engine, scene);
  assert.deepEqual(result.missingLayers, []);
  assert.deepEqual(engine.applied.slice(1).sort(), [['cctv', true], ['flights', false]]);
  const copy = workspace.duplicateScene(scene.id);
  assert.notEqual(copy.id, scene.id);
  assert.equal(workspace.scenes.list().length, 2);
  const note = workspace.addNote({ body: 'Checked at 09:00', target: ref, investigationId: investigation.id });
  assert.equal(workspace.notesFor(ref).length, 1);
  assert.equal(note.provenance, 'analyst');
  const actions = workspace.audit.list().map((entry) => entry.action);
  assert.ok(actions.includes('investigation.create'));
  assert.ok(actions.includes('scene.create'));
  assert.ok(actions.includes('note.create'));
  assert.ok(Object.keys(storage.dump()).every((key) => key.startsWith('oryn:')));
  assert.ok(!JSON.stringify(storage.dump()).includes('password'));
});

test('reports export real records as JSON and CSV with limitations', () => {
  const investigation = validateInvestigation({
    id: 'inv_1',
    title: 'Fire, "east" ridge',
    entities: [
      { kind: 'fire-detection', id: 'f1', label: 'FRP 12', position: { lon: 1, lat: 2 }, source: 'NASA FIRMS', observedAt: '2026-10-17T01:00:00Z', retrievedAt: '2026-10-17T01:05:00Z', fields: { frp: 12 } },
    ],
    sceneIds: ['scene_1'],
  });
  const report = buildInvestigationReport(investigation, {
    notes: [{ id: 'n1', investigationId: 'inv_1', body: 'note', author: 'Ana', provenance: 'analyst', createdAt: '2026-10-17T02:00:00Z', position: null, target: null }],
    scenes: [{ id: 'scene_1', name: 'S', camera: {}, enabledLayers: [], mode: 'globe', createdAt: 'x' }, { id: 'other', name: 'O' }],
    feeds: [{ id: 'local-firms', name: 'FIRMS', source: 'NASA FIRMS', state: 'current', lastUpdate: 1_760_000_000_000 }],
    session: { organizationId: 'demo-city', organization: 'City (DEMO)' },
    generatedAt: '2026-10-17T03:00:00Z',
  });
  assert.equal(report.prototype, true);
  assert.equal(report.entities[0].provenance, 'provider');
  assert.equal(report.notes.length, 1);
  assert.equal(report.scenes.length, 1);
  assert.equal(report.dataSources[0].lastRetrievedAt, new Date(1_760_000_000_000).toISOString());
  assert.ok(report.limitations.length >= 3);
  const csv = reportEntitiesCsv(report);
  assert.match(csv, /^kind,id,label/);
  assert.match(csv, /fire-detection,f1,FRP 12/);
  assert.equal(csvEscape('a "b", c'), '"a ""b"", c"');
  assert.equal(toCsv([{ a: 1, b: 'x' }]), 'a,b\r\n1,x\r\n');
  assert.equal(safeFileName('Fire, "east" ridge', 'json'), 'fire-east-ridge.json');
});
