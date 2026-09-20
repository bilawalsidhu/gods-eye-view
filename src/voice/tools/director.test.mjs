import assert from 'node:assert/strict';
import test from 'node:test';
import { createHandlers, schemas } from './director.js';
import { LOCAL_TOOL_PACKS } from './index.js';
import { createLocalMemory } from '../localMemory.js';
import { parseSceneDocument } from '../../director/document.js';

const CAMERA = { lat: 32.8, lon: -97.0, alt: 20_000, heading: 0, pitch: -45, roll: 0 };

function storage() {
  const map = new Map();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v) };
}

function flightRecords(count = 6) {
  return Array.from({ length: count }, (_, i) => ({
    id: `AAL${i}`,
    icao24: `a${i}`,
    callsign: `AAL${i}`,
    operator: null,
    lat: 32.9 + i * 0.01,
    lon: -97.05,
    altitudeM: 5000 + i * 1000,
    speedMps: 200,
    heading: 180,
    onGround: false,
  }));
}

/** Fake SceneDirector: the project field, the import seam, playback and the state channel. */
function fakeDirector() {
  const listeners = new Set();
  const director = {
    _project: {
      version: 6,
      createdAt: '2026-09-16T00:00:00.000Z',
      updatedAt: '2026-09-16T00:00:00.000Z',
      installedBuiltInSceneIds: [],
      scenes: [
        {
          id: 'user-scene',
          title: 'Mine',
          releaseLayerIds: [],
          appliedShotPacks: [],
          shots: [],
        },
      ],
    },
    running: false,
    imports: [],
    starts: [],
    stops: [],
    async importProjectFile(file, options) {
      parseSceneDocument(await file.text());
      this.imports.push({ name: file.name, options });
      this._project = options.prepared.project;
      return true;
    },
    startScene(sceneId, options) {
      this.starts.push({ sceneId, options });
      this.running = true;
      return new Promise(() => {});
    },
    stopScene(reason) {
      this.stops.push(reason);
      this.running = false;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(event, detail) {
      for (const listener of [...listeners])
        listener({ change: { type: 'run-event', event, detail } });
    },
    listenerCount: () => listeners.size,
  };
  return director;
}

function fakeGlobe({ records = { flights: flightRecords() }, director = fakeDirector() } = {}) {
  const enabled = new Set(Object.keys(records));
  const toasts = [];
  const flights = [];
  return {
    toasts,
    flights,
    sceneDirector: director,
    dataManager: {
      isEnabled: (id) => enabled.has(id),
      layers: {
        get: (id) =>
          enabled.has(id)
            ? { module: { getAnalystRecords: () => records[id], getAllPositions: () => [{ id: 'a0', airline: 'American' }] } }
            : undefined,
      },
    },
    styleManager: {
      getCameraState: () => CAMERA,
      getVisualState: () => ({ style: 'normal' }),
      applyCameraState: (state, duration) => flights.push({ state, duration }),
      _showToast: (text) => toasts.push(text),
    },
  };
}

function handlersFor(globe, extra = {}) {
  const spoken = [];
  const runs = [];
  const memory = createLocalMemory({ storage: storage(), now: () => 5 });
  const handlers = createHandlers(
    {
      memory,
      getGlobe: () => globe,
      runner: async (name, args) => {
        runs.push({ name, args });
        return { ok: true };
      },
      speak: (text) => spoken.push(text),
      ...extra.context,
    },
    { sleep: async () => {}, now: () => 1_000_000, download: extra.download, geocoder: extra.geocoder || (async () => null) },
  );
  return { handlers, spoken, runs, memory };
}

test('the pack is registered and every schema has a handler', () => {
  assert.ok(LOCAL_TOOL_PACKS.some((pack) => pack.schemas === schemas));
  const { handlers } = handlersFor(fakeGlobe());
  for (const schema of schemas) assert.equal(typeof handlers[schema.name], 'function', schema.name);
  assert.deepEqual(schemas.map((s) => s.name), ['make_tour', 'stop_tour', 'save_tour']);
});

test('make_tour loads a validated scene through importProjectFile and plays it single', async () => {
  const director = fakeDirector();
  const globe = fakeGlobe({ director });
  const { handlers, spoken, memory } = handlersFor(globe);
  const result = await handlers.make_tour({ theme: 'busiest airspace', seconds: 60 });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.mode, 'director');
  assert.equal(result.saved, true);
  assert.equal(result.place, 'Dallas–Fort Worth');
  assert.equal(result.durationSec, 60);
  assert.equal(result.shots.length, 6);
  assert.ok(result.shots.every((s) => typeof s.title === 'string'));
  assert.equal(director.imports.length, 1);
  const project = director.imports[0].options.prepared.project;
  assert.deepEqual(project.scenes.map((s) => s.id), ['user-scene', 'auto-tour']);
  assert.equal(director.imports[0].options.selection.sceneId, 'auto-tour');
  assert.deepEqual(director.starts, [{ sceneId: 'auto-tour', options: { single: true } }]);
  assert.equal(spoken.length, 0);
  director.emit('shot_start', { sceneId: 'auto-tour', shotId: 'auto-tour-shot-1' });
  assert.equal(spoken.length, 1);
  assert.match(spoken[0], /^Now over Dallas–Fort Worth: 6 aircraft within 60 km; the highest is American Airlines AAL5 at 10000 m\.$/);
  director.emit('shot_start', { sceneId: 'other', shotId: 'auto-tour-shot-2' });
  assert.equal(spoken.length, 1);
  director.emit('shot_start', { sceneId: 'auto-tour', shotId: 'auto-tour-shot-3' });
  assert.equal(spoken.length, 2);
  assert.equal(director.listenerCount(), 1);
  director.emit('scene_run_complete', {});
  assert.equal(director.listenerCount(), 0);
  assert.ok(
    memory
      .recentTargets('aircraft')
      .map((t) => t.id)
      .includes('a5'),
  );
});

test('narrate=false toasts titles instead of speaking, and stop_tour stops the Director', async () => {
  const director = fakeDirector();
  const globe = fakeGlobe({ director });
  const { handlers, spoken } = handlersFor(globe);
  const result = await handlers.make_tour({ theme: 'airspace', seconds: 20, narrate: false });
  assert.equal(result.ok, true);
  assert.equal(result.narrate, false);
  director.emit('shot_start', { sceneId: 'auto-tour', shotId: 'auto-tour-shot-1' });
  assert.equal(spoken.length, 0);
  assert.equal(globe.toasts.length, 1);
  const stopped = await handlers.stop_tour();
  assert.deepEqual(stopped, { ok: true, wasRunning: true });
  assert.deepEqual(director.stops, ['Tour stopped by voice']);
  assert.equal(director.listenerCount(), 0);
  assert.deepEqual(await handlers.stop_tour(), { ok: true, wasRunning: false });
});

test('a theme with no data enables its layer, then orbits the current view', async () => {
  const globe = fakeGlobe({ records: {} });
  const { handlers, runs } = handlersFor(globe);
  const result = await handlers.make_tour({ theme: 'ships', seconds: 30 });
  assert.equal(result.ok, true);
  assert.equal(result.theme, 'view');
  assert.equal(result.fallback, 'no-data');
  assert.match(result.note, /No vessels loaded/);
  assert.deepEqual(runs[0], { name: 'set_layer_visibility', args: { layerId: 'ais-live-vessels', enabled: true } });
});

test('make_tour reports the Director refusing to start', async () => {
  const director = fakeDirector();
  director.startScene = async () => ({ started: false, reason: 'camera-unavailable' });
  const { handlers } = handlersFor(fakeGlobe({ director }));
  const result = await handlers.make_tour({ theme: 'airspace' });
  assert.equal(result.ok, false);
  assert.match(result.error, /camera-unavailable/);
  assert.equal(director.listenerCount(), 0);
});

test('without a Director the tour flies the shell camera shot by shot', async () => {
  const globe = fakeGlobe({ director: null });
  const { handlers, spoken } = handlersFor(globe);
  const result = await handlers.make_tour({ theme: 'airspace', seconds: 40 });
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'camera-sequence');
  assert.equal(result.saved, false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(globe.flights.length, 4);
  assert.equal(spoken.length, 4);
  assert.ok(globe.flights.every((f) => f.duration > 0));
  assert.ok(globe.flights.every((f) => Number.isFinite(f.state.lat) && Number.isFinite(f.state.alt)));
  const noCamera = fakeGlobe({ director: null });
  noCamera.styleManager.applyCameraState = undefined;
  const refused = await handlersFor(noCamera).handlers.make_tour({ theme: 'airspace' });
  assert.equal(refused.ok, false);
});

test('a reverse geocoder names a focus that is far from every hub', async () => {
  const records = {
    flights: flightRecords(5).map((r) => ({ ...r, lat: -12 + r.lat - 32.9, lon: 45 })),
  };
  const { handlers } = handlersFor(fakeGlobe({ records }), { geocoder: async () => 'Mayotte' });
  const result = await handlers.make_tour({ theme: 'airspace', seconds: 30 });
  assert.equal(result.place, 'Mayotte');
});

test('save_tour renames the scene, persists it and downloads a scene bundle', async () => {
  const director = fakeDirector();
  const downloads = [];
  const { handlers } = handlersFor(fakeGlobe({ director }), {
    download: (text, name) => {
      downloads.push({ text, name });
      return true;
    },
  });
  assert.equal((await handlers.save_tour({ name: 'x' })).ok, false);
  await handlers.make_tour({ theme: 'airspace', seconds: 30 });
  const saved = await handlers.save_tour({ name: 'Texas Evening Rush' });
  assert.equal(saved.ok, true);
  assert.equal(saved.persisted, true);
  assert.equal(saved.downloaded, true);
  assert.equal(saved.sceneId, 'tour-texas-evening-rush');
  assert.equal(saved.file, 'texas-evening-rush.gevbundle.json');
  assert.equal(director.imports.length, 2);
  assert.deepEqual(director._project.scenes.map((s) => s.id), ['user-scene', 'tour-texas-evening-rush']);
  assert.equal(director._project.scenes[1].title, 'Texas Evening Rush');
  assert.ok(director._project.scenes[1].shots.every((s) => s.id.startsWith('tour-texas-evening-rush-shot-')));
  const bundle = JSON.parse(downloads[0].text);
  assert.equal(bundle.format, 'gev-scene-bundle');
  assert.deepEqual(bundle.assets, []);
  assert.equal(bundle.project.scenes[0].id, 'tour-texas-evening-rush');
  assert.doesNotThrow(() => parseSceneDocument(JSON.stringify(bundle.project)));
});
