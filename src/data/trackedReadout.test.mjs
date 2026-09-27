import { readLayerSource } from '../testSupport/readLayerSource.mjs';
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
  // A card with nothing to activate must keep letting clicks reach the globe.
  assert.equal(entry.interactive, false);
});

test('a tracked card is clickable only when its layer opts in', () => {
  const build = (model) =>
    createTrackedOverlayEntry({
      gevTrackedId: 'world-news:place',
      gevDisplayPosition: () => ({ x: 1, y: 2, z: 3 }),
      gevLabelModel: { title: 'Headline', details: [], ...model },
    });
  // Only an interactive entry registers a hit rect in the overlay, which is
  // what lets the World News card open its headline at the publisher.
  assert.equal(build({ interactive: true }).interactive, true);
  // Every other layer, and any truthy-but-not-true value, stays pass-through.
  assert.equal(build({}).interactive, false);
  assert.equal(build({ interactive: 'yes' }).interactive, false);
  assert.equal(build({ interactive: 1 }).interactive, false);
});

test('selected camera readout carries tactical animation and fixed badge clearance', () => {
  const entry = createTrackedOverlayEntry({
    id: 'alpr:42', gevDisplayPosition: () => ({ x: 1, y: 2, z: 3 }),
    gevLabelModel: {
      title: 'ALPR-0042', details: ['OSM MAPPED'], accent: '#ff6474',
      cardStyle: 'tactical', selected: true, leaderStyle: 'elbow',
      leaderAnimationMs: 440, leaderAnimationStartedAt: 100, leaderDrawRatio: 0.68,
      anchorRadiusPx: 30, anchorRadiusScale: null,
    },
  });
  assert.equal(entry.cardStyle, 'tactical');
  assert.equal(entry.selected, true);
  assert.equal(entry.leaderStyle, 'elbow');
  assert.equal(entry.leaderAnimationMs, 440);
  assert.equal(entry.leaderAnimationStartedAt, 100);
  assert.equal(entry.leaderDrawRatio, 0.68);
  assert.equal(entry.anchorRadiusPx, 30);
  assert.equal(entry.anchorRadiusScale, null);
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

    // ALPR cameras are static context too: a click publishes the same card.
    const camera = {
      gevTrackedId: 'alpr:42',
      gevDisplayPosition: () => ({ x: 4, y: 5, z: 6 }),
      gevLabelModel: { title: 'FLOCK SAFETY ALPR', details: ['CITY PD'], accent: '#ff66c4' },
    };
    fakeWindow.dispatchEvent(new CustomEvent('gev:entity-selected', {
      detail: { layerId: 'alpr-cameras', entity: camera },
    }));
    assert.equal(getActiveTrackedReadoutId(), 'alpr:42');
    assert.equal(recorder.calls.filter(({ op }) => op === 'set').at(-1).entries[0].title, 'FLOCK SAFETY ALPR');

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
  const files = await Promise.all([
    'flights.js',
    'militaryFlights.js',
    'satellites.js',
    'militaryInstallations.js',
  ].map(async (name) => [name, readLayerSource(new URL(`./${name}`, import.meta.url))]));
  const sources = Object.fromEntries(files);
  for (const [name, source] of files) {
    assert.ok(source.includes('.gevLabelModel ='), `${name} writes the explicit model directly`);
    assert.ok(source.includes('.gevDisplayPosition ='), `${name} exposes a display-position cache`);
  }
  assert.match(sources['flights.js'], /gevDisplayPosition\s*=\s*parts\.motion\._trackedDisplayCached/);
  assert.match(sources['militaryFlights.js'], /gevDisplayPosition\s*=\s*parts\.motion\._trackedDisplayCached/);
  assert.ok(sources['satellites.js'].includes('gevDisplayPosition = _trackedDisplayCached'));
  assert.equal(sources['flights.js'].includes('_trackedEntity.label.text'), false);
  assert.equal(sources['militaryFlights.js'].includes('_trackedEntity.label.text'), false);
  assert.equal(sources['satellites.js'].includes('_trackedEntity.label.text'), false);
});

test('civilian and military trail heads use the lower-centre model anchor and weak-texture tint', async () => {
  const files = await Promise.all(['flights.js', 'militaryFlights.js'].map(async (name) => (
    [name, readLayerSource(new URL(`./${name}`, import.meta.url))]
  )));
  for (const [name, source] of files) {
    assert.ok(
      (/const\s*head\s*=\s*(?:parts\.motion\.)?_trackedTrailCached\(\s*,?\s*\)\s*\|\|\s*(?:parts\.motion\.)?_trackedDisplayPosition\(\s*(?:flightState\.)?_trackedIcao,?\s*\);/).test(source),
      `${name} trail head uses the dedicated lower-centre model anchor`,
    );
    assert.ok(source.includes('const MODEL_COLOR_BLEND_AMOUNT = 0.94;'),
      `${name} keeps diffuse texture contribution weak through code-side MIX`);
  }
});
