import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  _setTrackedOverlayHostForTest,
  cachedTrackedDisplayPosition,
  cachedTrackedVisualPosition,
  createTrackedOverlayEntry,
  destroyTrackedReadout,
  getActiveTrackedReadoutId,
  initTrackedReadout,
  refreshTrackedReadout,
  trackedLabelModelFromText,
} from './trackedReadout.js';
import { WORLD_OVERLAY_STYLE } from '../overlays/worldOverlayTokens.js';
const WORLD_ACCENT = WORLD_OVERLAY_STYLE.accent;

function makeCesiumEvent() {
  const listeners = new Set();
  return {
    addEventListener(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    raise() { for (const callback of [...listeners]) callback(); },
    get size() { return listeners.size; },
  };
}

function makeHostRecorder() {
  const calls = [];
  return {
    calls,
    host: {
      setEntries(sourceId, entries, options) { calls.push({ op: 'set', sourceId, entries, options }); },
      setVisible(sourceId, visible) { calls.push({ op: 'visible', sourceId, visible }); },
      clearSource(sourceId) { calls.push({ op: 'clear', sourceId }); },
    },
  };
}

test('tracked label text becomes an explicit title/details/accent model', () => {
  assert.deepEqual(
    trackedLabelModelFromText('UAL123 · FL350 · 451 kts', '#39d0ff'),
    { title: 'UAL123', details: ['FL350 · 451 kts'], accent: '#39d0ff' },
  );
  assert.deepEqual(
    trackedLabelModelFromText('RCH123\nC-17 · 01-0186\nUSAF · FL310', '#ffd166'),
    {
      title: 'RCH123',
      details: ['C-17 · 01-0186', 'USAF · FL310'],
      accent: '#ffd166',
    },
  );
});

test('tracked position source reads only gevDisplayPosition and never entity.position', () => {
  const cached = { x: 1, y: 2, z: 3 };
  let propertyReads = 0;
  const entity = {
    gevDisplayPosition: () => cached,
    position: {
      getValue() { propertyReads += 1; throw new Error('fresh position read is forbidden'); },
    },
  };
  assert.equal(cachedTrackedDisplayPosition(entity), cached);
  assert.equal(propertyReads, 0);
  assert.equal(cachedTrackedDisplayPosition({ position: entity.position }), null);
  assert.equal(propertyReads, 0);
  // The read runs in the host's postRender phase: an accessor that throws must
  // read as "no cache", not take the frame down with it.
  assert.equal(
    cachedTrackedDisplayPosition({
      gevDisplayPosition() { throw new Error('dead reckoning blew up'); },
    }),
    null,
  );
});

test('the tracked card anchors to the visual position without repurposing the display accessor', () => {
  // A grounded aircraft's 3D model rides a ground snap while its billboard stays
  // at the reported (buried) altitude — ~100 m apart. The card must follow the
  // model you can see, while `gevDisplayPosition` keeps returning the cached
  // dead-reckoned value the follow camera settled on (anti-jitter contract).
  const display = { x: 1, y: 2, z: 3 };
  const visual = { x: 1, y: 2, z: 103 };
  let displayReads = 0;
  const entity = {
    gevTrackedId: 'flights:aaa077',
    gevDisplayPosition: () => { displayReads += 1; return display; },
    gevVisualPosition: () => visual,
    gevLabelModel: { title: 'SWA143', details: ['ON GROUND'], accent: '#6be8ff' },
  };
  assert.equal(cachedTrackedVisualPosition(entity), visual);
  assert.equal(displayReads, 0, 'the visual accessor short-circuits the display read');
  assert.equal(cachedTrackedDisplayPosition(entity), display,
    'the display accessor is untouched and still reports the dead-reckoned position');
  assert.equal(createTrackedOverlayEntry(entity).position(), visual,
    'the published tracked entry anchors to the visual position');

  // Layers with no 3D visual, and any layer before its model is ready, are
  // unchanged: the accessor falls back to the display position.
  const spriteOnly = { gevDisplayPosition: () => display };
  assert.equal(cachedTrackedVisualPosition(spriteOnly), display);
  assert.equal(cachedTrackedVisualPosition({ ...spriteOnly, gevVisualPosition: () => null }), display,
    'a null visual position falls back rather than blanking the card');
  assert.equal(
    cachedTrackedVisualPosition({
      gevDisplayPosition: () => display,
      gevVisualPosition: () => { throw new Error('model gone'); },
    }),
    display,
    'a throwing visual accessor falls back instead of dropping the card',
  );
  assert.equal(cachedTrackedVisualPosition(null), null);
});

test('tracked entry factory pins the production protected-lane policy', () => {
  const display = { x: 4, y: 5, z: 6 };
  const entry = createTrackedOverlayEntry({
    gevTrackedId: 'satellites:25544',
    gevDisplayPosition: () => display,
    gevLabelModel: { title: 'ISS', details: ['420 km · NORAD 25544'], accent: '#ffd84d' },
  });
  assert.equal(entry.id, 'satellites:25544');
  assert.equal(entry.position(), display);
  assert.equal(entry.protected, true);
  assert.equal(entry.paintLane, 'tracked');
  assert.equal(entry.collisionGroup, 'ambient-card');
  assert.equal(entry.edgeFade, 'keyhole');
});

test('tracked entity publishes a protected host entry backed by the frame cache', () => {
  const originalWindow = globalThis.window;
  const fakeWindow = new EventTarget();
  const changed = makeCesiumEvent();
  const display = { x: 10, y: 20, z: 30 };
  const entity = {
    id: 'generated',
    gevTrackedId: 'flights:abc123',
    gevDisplayPosition: () => display,
    gevLabelModel: { title: 'UAL123', details: ['FL350 · 451 kts'], accent: '#39d0ff' },
  };
  const viewer = { trackedEntity: entity, trackedEntityChanged: changed };
  const recorder = makeHostRecorder();
  globalThis.window = fakeWindow;
  _setTrackedOverlayHostForTest(recorder.host);
  try {
    initTrackedReadout(viewer);
    const publication = recorder.calls.find(({ op }) => op === 'set');
    assert.ok(publication);
    assert.equal(publication.sourceId, 'tracked');
    assert.equal(publication.entries.length, 1);
    const entry = publication.entries[0];
    assert.equal(entry.id, 'flights:abc123');
    assert.equal(entry.variant, 'tracked');
    assert.equal(entry.tracked, true);
    assert.equal(entry.protected, true);
    assert.equal(entry.paintLane, 'tracked');
    assert.equal(entry.collisionGroup, 'ambient-card');
    assert.equal(entry.position(), display);
    assert.equal(publication.options.collisionCapacity, 0);
    assert.equal(publication.options.hideInCockpit, true);
    assert.equal(getActiveTrackedReadoutId(), 'flights:abc123');

    entity.gevLabelModel = { ...entity.gevLabelModel, details: ['FL360 · 455 kts'] };
    refreshTrackedReadout(entity);
    assert.deepEqual(recorder.calls.filter(({ op }) => op === 'set').at(-1).entries[0].details, [
      'FL360 · 455 kts',
    ]);

    viewer.trackedEntity = null;
    changed.raise();
    assert.equal(getActiveTrackedReadoutId(), null);
    assert.equal(recorder.calls.at(-1).op, 'clear');
  } finally {
    destroyTrackedReadout();
    _setTrackedOverlayHostForTest();
    globalThis.window = originalWindow;
  }
});

test('selection lifecycle ignores vessels, accepts installations, and clears without stale cards', () => {
  const originalWindow = globalThis.window;
  const fakeWindow = new EventTarget();
  const changed = makeCesiumEvent();
  const viewer = { trackedEntity: null, trackedEntityChanged: changed };
  const recorder = makeHostRecorder();
  const installation = {
    gevTrackedId: 'installations:fort-test',
    gevDisplayPosition: () => ({ x: 1, y: 2, z: 3 }),
    gevLabelModel: { title: 'FORT TEST', details: ['AIRFIELD'], accent: '#5aa9ff' },
  };
  globalThis.window = fakeWindow;
  _setTrackedOverlayHostForTest(recorder.host);
  try {
    initTrackedReadout(viewer);
    const setsBefore = recorder.calls.filter(({ op }) => op === 'set').length;
    fakeWindow.dispatchEvent(new CustomEvent('gev:entity-selected', {
      detail: { layerId: 'ais-live-vessels', entity: installation },
    }));
    assert.equal(recorder.calls.filter(({ op }) => op === 'set').length, setsBefore);

    fakeWindow.dispatchEvent(new CustomEvent('gev:entity-selected', {
      detail: { layerId: 'military-installations', entity: installation },
    }));
    assert.equal(getActiveTrackedReadoutId(), 'installations:fort-test');
    assert.equal(recorder.calls.filter(({ op }) => op === 'set').at(-1).entries[0].title, 'FORT TEST');

    fakeWindow.dispatchEvent(new CustomEvent('gev:entity-selected', {
      detail: { layerId: 'ais-live-vessels', entity: installation },
    }));
    assert.equal(getActiveTrackedReadoutId(), null, 'sibling selection clears an installation card');

    fakeWindow.dispatchEvent(new CustomEvent('gev:entity-selected', {
      detail: { layerId: 'military-installations', entity: installation },
    }));

    fakeWindow.dispatchEvent(new CustomEvent('gev:entity-selection-cleared', {
      detail: { layerId: 'military-installations' },
    }));
    assert.equal(getActiveTrackedReadoutId(), null);
    assert.ok(recorder.calls.some(({ op }) => op === 'clear'));

    const clearsBeforeDestroy = recorder.calls.filter(({ op }) => op === 'clear').length;
    destroyTrackedReadout();
    assert.ok(recorder.calls.filter(({ op }) => op === 'clear').length > clearsBeforeDestroy);
    assert.equal(changed.size, 0, 'trackedEntityChanged listener was removed');
    assert.ok(recorder.calls.some(({ op, visible }) => op === 'visible' && visible === false));
  } finally {
    destroyTrackedReadout();
    _setTrackedOverlayHostForTest();
    globalThis.window = originalWindow;
  }
});

test('trackedReadout cannot resurrect a dedicated canvas or render listener', async () => {
  const source = await readFile(new URL('./trackedReadout.js', import.meta.url), 'utf8');
  for (const forbidden of [
    'document.createElement',
    "createElement('canvas')",
    'postRender.addEventListener',
    'worldToWindowCoordinates',
    "id = 'tracked-readout'",
    'keyholeLabelAlpha',
  ]) {
    assert.equal(source.includes(forbidden), false, `dedicated renderer token returned: ${forbidden}`);
  }
});

test('tracking layers write gevLabelModel and expose only their cached display positions', async () => {
  // flights' pipeline state (flightsTracking.js) is read alongside the layer.
  const flightsSource = [
    await readFile(new URL('./flights.js', import.meta.url), 'utf8'),
    await readFile(new URL('./flightsTracking.js', import.meta.url), 'utf8'),
  ].join('\n');
  // military reads the factory alongside its layer, like flights.
  const militarySource = [
    await readFile(new URL('./militaryFlights.js', import.meta.url), 'utf8'),
    await readFile(new URL('./flightsTracking.js', import.meta.url), 'utf8'),
  ].join('\n');
  const files = await Promise.all([
    'satellites.js',
    'militaryInstallations.js',
  ].map(async (name) => [name, await readFile(new URL(`./${name}`, import.meta.url), 'utf8')]));
  const sources = {
    'flights.js': flightsSource,
    'militaryFlights.js': militarySource,
    ...Object.fromEntries(files),
  };
  for (const [name, source] of Object.entries(sources)) {
    assert.ok(source.includes('.gevLabelModel ='), `${name} writes the explicit model directly`);
    assert.ok(source.includes('.gevDisplayPosition ='), `${name} exposes a display-position cache`);
  }
  // both flight layers read the cache through their pipeline instance; the others own it inline.
  assert.ok(flightsSource.includes('gevDisplayPosition = p._trackedDisplayCached'));
  assert.ok(sources['militaryFlights.js'].includes('gevDisplayPosition = p._trackedDisplayCached'));
  assert.ok(sources['satellites.js'].includes('gevDisplayPosition = _trackedDisplayCached'));
  assert.equal(flightsSource.includes('_trackedEntity.label.text'), false);
  assert.equal(sources['militaryFlights.js'].includes('_trackedEntity.label.text'), false);
  assert.equal(sources['satellites.js'].includes('_trackedEntity.label.text'), false);
});

test('civilian and military trail heads use the lower-centre model anchor and weak-texture tint', async () => {
  const files = [
    // flights' trail seam stays in the layer but reads pipeline state via `p.`
    ['flights.js', 'const head = p._trackedTrailCached() || _trackedDisplayPosition(p._trackedIcao);'],
    ['militaryFlights.js', 'const head = p._trackedTrailCached() || _trackedDisplayPosition(p._trackedIcao);'],
  ];
  for (const [name, headPin] of files) {
    const source = await readFile(new URL(`./${name}`, import.meta.url), 'utf8');
    assert.ok(
      source.includes(headPin),
      `${name} trail head uses the dedicated lower-centre model anchor`,
    );
    assert.ok(source.includes('const MODEL_COLOR_BLEND_AMOUNT = 0.94;'),
      `${name} keeps diffuse texture contribution weak through code-side MIX`);
  }
});

// --- Branch floor (cycle 4): the coercion and lifecycle quiet exits ----------

test('label model coerces empty, single-part, and whitespace-only text', () => {
  assert.deepEqual(trackedLabelModelFromText(''),
    { title: '', details: [], accent: WORLD_ACCENT }, 'empty text → an empty model');
  assert.deepEqual(trackedLabelModelFromText(null), { title: '', details: [], accent: WORLD_ACCENT });
  assert.deepEqual(trackedLabelModelFromText('   '), { title: '', details: [], accent: WORLD_ACCENT },
    'whitespace-only text is an empty model, not a whitespace title');
  assert.deepEqual(trackedLabelModelFromText('NUCLEAR SUB', '#fff'),
    { title: 'NUCLEAR SUB', details: [], accent: '#fff' }, 'no separators → title only, no details');
  // Trim runs BEFORE the separator split: a trailing-empty separator never
  // matches, so the whole string stays the title.
  assert.deepEqual(trackedLabelModelFromText('X · '), { title: 'X ·', details: [], accent: WORLD_ACCENT });
  assert.deepEqual(trackedLabelModelFromText('A\n\nB'), { title: 'A', details: ['B'], accent: WORLD_ACCENT },
    'newline parsing drops blank lines');
  // A leading separator loses its space to the trim, so it never matches:
  // the whole string stays the title. (The title `|| ''` guard is defensive —
  // both split paths produce a non-empty head after trim — and is not
  // reachable by real input.)
  assert.deepEqual(trackedLabelModelFromText(' · X'), { title: '· X', details: [], accent: WORLD_ACCENT });
});

test('position caches and entry ids degrade to null, never to fresh reads', () => {
  // A cache accessor that RETURNS null is "no cache", distinct from throwing.
  assert.equal(cachedTrackedDisplayPosition({ gevDisplayPosition: () => null }), null);
  assert.equal(cachedTrackedDisplayPosition(null), null);
  // Ids: explicit gevTrackedId wins, then entity:<id>, then unpublishable.
  assert.equal(createTrackedOverlayEntry({
    gevTrackedId: 'explicit:1', gevDisplayPosition: () => ({}),
    gevLabelModel: { title: 'T' },
  }).id, 'explicit:1');
  assert.equal(createTrackedOverlayEntry({
    id: 'cesium-7', gevDisplayPosition: () => ({}), gevLabelModel: { title: 'T' },
  }).id, 'entity:cesium-7', 'no explicit id → the entity:<id> fallback');
  assert.equal(createTrackedOverlayEntry({
    gevDisplayPosition: () => ({}), gevLabelModel: { title: 'T' },
  }), null, 'no id at all → unpublishable');
  assert.equal(createTrackedOverlayEntry({
    gevTrackedId: 'x:1', gevDisplayPosition: () => ({}), gevLabelModel: { title: '   ' },
  }), null, 'a whitespace title publishes nothing');
  assert.equal(createTrackedOverlayEntry({
    gevTrackedId: 'x:1', gevDisplayPosition: () => ({}), gevLabelModel: { details: [] },
  }), null, 'a missing title publishes nothing');
  assert.equal(createTrackedOverlayEntry(null), null);
  // Malformed model bags coerce: details non-array → [], accent falsy → the theme accent.
  const entry = createTrackedOverlayEntry({
    gevTrackedId: 'x:2', gevDisplayPosition: () => ({}),
    gevLabelModel: { title: 'T', details: 'corrupt', accent: '' },
  });
  assert.deepEqual(entry.details, []);
  assert.equal(entry.accent, WORLD_ACCENT);
});

test('lifecycle guards: re-init and null viewer are no-ops; context survives tracking loss', () => {
  const originalWindow = globalThis.window;
  const fakeWindow = new EventTarget();
  const changed = makeCesiumEvent();
  const recorder = makeHostRecorder();
  globalThis.window = fakeWindow;
  _setTrackedOverlayHostForTest(recorder.host);
  try {
    initTrackedReadout(null);
    assert.equal(recorder.calls.length, 0, 'a null viewer initializes nothing');
    // A viewer without the trackedEntityChanged event still initializes —
    // the subscription is optional. Re-init with a DIFFERENT viewer tears the
    // first one down on the way in.
    const bareViewer = { trackedEntity: null };
    initTrackedReadout(bareViewer);
    const viewer = { trackedEntity: null, trackedEntityChanged: changed };
    initTrackedReadout(viewer);
    initTrackedReadout(viewer);
    const callsAfterInit = recorder.calls.length;
    initTrackedReadout(viewer);
    assert.equal(recorder.calls.length, callsAfterInit, 're-init with the same viewer is a no-op');
    // Selecting an installation, then LOSING the tracked entity must not wipe
    // the installation card (the loss branch only clears when a track exists).
    const installation = {
      gevTrackedId: 'installations:x',
      gevDisplayPosition: () => ({ x: 1, y: 2, z: 3 }),
      gevLabelModel: { title: 'FORT', details: [] },
    };
    fakeWindow.dispatchEvent(new CustomEvent('gev:entity-selected', {
      detail: { layerId: 'military-installations', entity: installation },
    }));
    assert.equal(getActiveTrackedReadoutId(), 'installations:x');
    viewer.trackedEntity = null;
    changed.raise();
    assert.equal(getActiveTrackedReadoutId(), 'installations:x',
      'a tracking loss with no active track leaves a context card alone');
    // The cleared handler ignores clear events from OTHER layers.
    fakeWindow.dispatchEvent(new CustomEvent('gev:entity-selection-cleared', {
      detail: { layerId: 'ais-live-vessels' },
    }));
    assert.equal(getActiveTrackedReadoutId(), 'installations:x', 'foreign clears do not close the card');
    // An awareness-subject selection drops the context card; with no tracked
    // entity behind it, the source clears outright.
    fakeWindow.dispatchEvent(new CustomEvent('gev:awareness-subject-selected', { detail: {} }));
    assert.equal(getActiveTrackedReadoutId(), null, 'subject selection closes a context card');
    // A tracking win clears a context card: raise the change with an entity armed.
    viewer.trackedEntity = installation;
    changed.raise();
    fakeWindow.dispatchEvent(new CustomEvent('gev:entity-selected', {
      detail: { layerId: 'military-installations', entity: installation },
    }));
    assert.equal(getActiveTrackedReadoutId(), 'installations:x');
    viewer.trackedEntity = { id: 'plane' };
    changed.raise();
    assert.equal(getActiveTrackedReadoutId(), null, 'a new track preempts the context card');
  } finally {
    destroyTrackedReadout();
    _setTrackedOverlayHostForTest();
    globalThis.window = originalWindow;
  }
});
