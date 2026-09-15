import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { claimPointer, releasePointer } from './inputOwnership.js';
import * as Cesium from 'cesium';
import { SOURCE_PATH_BEAT_IDS } from './bhoteKoshiShotPaths.js';
import {
  BHOTE_KOSHI_LAYER_ID,
  activeEvidenceIndex,
  adjacentEvidenceIndex,
  buildCinematicKeyframes,
  buildEvidenceTimeline,
  clampUnit,
  createBhoteKoshiEventLayer,
  evidenceCardLayout,
  createEvidenceFrame,
  elapsedLabel,
  evidenceBeatProgress,
  evidenceBeatPresentation,
  evidenceCorroborationLabel,
  evidenceSequenceWindow,
  evidenceSummaryLines,
  floodProgressForStoryProgress,
  interpolateHeadingDegrees,
  sampleCinematicPose,
  updateEvidenceFrame,
  updateCorridorPositionCache,
  usesProviderEmbeddedEvidence,
  visibleSegmentCount,
} from './bhoteKoshiEvent.js';
import { SCENE_RECIPES } from '../scenes/recipes.js';
import { LayerLifecycle } from './lifecycle.js';

const eventUrl = new URL('../../public/events/bhote-koshi-2026/event.json', import.meta.url);
const eventModuleUrl = new URL('./bhoteKoshiEvent.js', import.meta.url);

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = tagName;
    this.children = [];
    this.removed = false;
    this._value = '';
    this._textContent = '';
    this._disabled = false;
    this._writeCount = 0;
    this._queryCount = 0;
    this._attributes = new Map();
    this._selectors = new Map();
    this._listeners = new Map();
  }

  set value(value) {
    if (this._value === value) return;
    this._value = value;
    this._writeCount += 1;
  }

  get value() { return this._value; }

  set textContent(value) {
    if (this._textContent === value) return;
    this._textContent = value;
    this._writeCount += 1;
  }

  get textContent() { return this._textContent; }

  set disabled(value) {
    if (this._disabled === value) return;
    this._disabled = value;
    this._writeCount += 1;
  }

  get disabled() { return this._disabled; }

  setAttribute(name, value) {
    if (this._attributes.get(name) === value) return;
    this._attributes.set(name, value);
    this._writeCount += 1;
  }

  getAttribute(name) { return this._attributes.get(name) ?? null; }
  addEventListener(type, handler) {
    this._listeners.set(type, handler);
  }

  removeEventListener(type, handler) {
    if (this._listeners.get(type) === handler) this._listeners.delete(type);
  }

  dispatch(type, event = { target: this }) {
    return this._listeners.get(type)?.(event);
  }

  append(...children) {
    this.children.push(...children);
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  querySelector(selector) {
    this._queryCount += 1;
    if (!this._selectors.has(selector)) this._selectors.set(selector, new FakeElement());
    return this._selectors.get(selector);
  }

  remove() {
    this.removed = true;
  }

  set innerHTML(value) {
    this._innerHTML = value;
  }

  get innerHTML() {
    return this._innerHTML || '';
  }
}

function installEventDom() {
  const body = new FakeElement('body');
  const removedProperties = [];
  globalThis.document = {
    body,
    createElement: (tagName) => new FakeElement(tagName),
    documentElement: {
      clientWidth: 1000,
      style: {
        setProperty() {},
        removeProperty(name) { removedProperties.push(name); },
      },
    },
  };
  return { body, removedProperties };
}

function eventViewer(splitPosition = 0.37) {
  const imagery = [];
  const removedImagery = [];
  const dataSources = [];
  const removedDataSources = [];
  const canvas = new FakeElement('canvas');
  const cameraLooks = [];
  const cameraTransforms = [];
  return {
    scene: { splitPosition, canvas },
    camera: {
      cancelFlight() {},
      lookAt(target, offset) {
        cameraLooks.push({
          target: { x: target.x, y: target.y, z: target.z },
          offset: { heading: offset.heading, pitch: offset.pitch, range: offset.range },
        });
      },
      lookAtTransform(transform) { cameraTransforms.push(transform); },
    },
    imageryLayers: {
      addImageryProvider(provider) {
        const layer = { provider };
        imagery.push(layer);
        return layer;
      },
      remove(layer) { removedImagery.push(layer); },
    },
    dataSources: {
      add(source) { dataSources.push(source); },
      remove(source) { removedDataSources.push(source); },
    },
    _test: {
      imagery,
      removedImagery,
      dataSources,
      removedDataSources,
      canvas,
      cameraLooks,
      cameraTransforms,
    },
  };
}

test('public lifecycle restores Nepal scene ownership without forwarding origin to enable', async () => {
  const previous = { document: globalThis.document, window: globalThis.window };
  const event = JSON.parse(await readFile(eventUrl, 'utf8'));
  try {
    for (const initialMap of ['photoreal', 'esri-imagery']) {
      for (const origin of ['scene', 'local-restore', 'share-restore']) {
        installEventDom();
        const timers = [];
        globalThis.window = {
          setTimeout(handler, delay) { timers.push({ handler, delay }); return timers.length; },
          clearTimeout() {},
        };
        const viewer = eventViewer();
        viewer.camera.flyToBoundingSphere = () => viewer._test.cameraLooks.push('corridor');
        let activeMap = initialMap;
        const mapCalls = [];
        const layer = createBhoteKoshiEventLayer({
          eventLoader: async () => event,
          imageryProviderFactory: async (url) => ({ url }),
          terrainSampler: async (_viewer, observations) => observations.map(() => ({ height: 800 })),
          mediaLoader: async () => { const error = new Error('No bundled clip'); error.name = 'AbortError'; throw error; },
          overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
          renderHost: { request() {}, hold() {}, release() {} },
        });
        layer.attachMapStackController({
          getActiveId: () => activeMap,
          getSwitchGeneration: () => 1,
          async setStack(id) { mapCalls.push(id); activeMap = id; },
        });
        const manager = new LayerLifecycle(viewer);
        manager.register(layer);
        manager.finalizeRegistrations([{ id: layer.id, disposition: 'enabled-only' }]);
        try {
          const result = await manager.restoreLayerState(layer.id, {
            enabled: true,
            params: { presentation: 'scene-beat', sceneSurface: 'panel-only', progress: 0.34 },
          }, { origin });
          assert.equal(result.succeeded, true);
          assert.equal(layer.getPlaybackState().enabled, true);
          assert.deepEqual(mapCalls, [], `${initialMap}/${origin}: preserve the shot map`);
          assert.equal(activeMap, initialMap);
          const floodSource = viewer._test.dataSources.at(-1);
          for (const id of ['bhote-koshi-flood-halo', 'bhote-koshi-flood-core']) {
            const line = floodSource.entities.getById(id).polyline;
            assert.equal(line.clampToGround.getValue(), true, 'dynamic trail follows the rendered surface');
            assert.equal(line.classificationType.getValue(), initialMap === 'photoreal'
              ? Cesium.ClassificationType.BOTH : Cesium.ClassificationType.TERRAIN);
            assert.equal(line.depthFailMaterial, undefined, 'do not rely on unsupported dynamic depth-fail rendering');
          }
          assert.equal(floodSource.entities.getById('bhote-koshi-surge-front').point.heightReference.getValue(),
            Cesium.HeightReference.CLAMP_TO_GROUND);
          assert.deepEqual(viewer._test.cameraLooks, [], 'enable must not focus the corridor');
          assert.deepEqual(timers, [], 'enable must not schedule independent playback');
          assert.equal(layer.getPlaybackState().playing, false);
          assert.equal(await manager.setEnabled(layer.id, false, { origin: 'user' }), true);
          assert.deepEqual(mapCalls, [], 'disable must not restore a map it never owned');
        } finally {
          await manager.destroyLayer(layer.id);
        }
      }
    }
  } finally {
    Object.assign(globalThis, previous);
  }
});

test('trimmed scene media holds through provider startup, playback and fade, then releases the camera', async () => {
  const previous = { document: globalThis.document, window: globalThis.window };
  installEventDom();
  const timers = new Map();
  let nextId = 0;
  globalThis.window = {
    setTimeout(fn, delay) { const id = ++nextId; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  let phase = 'starting';
  let hidden = 0;
  const event = JSON.parse(await readFile(eventUrl, 'utf8'));
  const layer = createBhoteKoshiEventLayer({
    eventLoader: async () => event,
    imageryProviderFactory: async (url) => ({ url }),
    terrainSampler: async (_viewer, observations) => observations.map(() => ({ height: 800 })),
    mediaLoader: async () => { const error = new Error('No bundled clip'); error.name = 'AbortError'; throw error; },
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
    renderHost: { request() {}, hold() {}, release() {} },
    embeddedMediaFactory: () => ({ warm: () => true, show: () => true, play() {}, pause() {},
      getPlaybackState: () => ({ phase }), hide() { hidden++; }, destroy() {} }),
  });
  const fire = (delay) => {
    const entry = [...timers].find(([, value]) => value.delay === delay);
    assert.ok(entry, `expected ${delay}ms owned timer`);
    timers.delete(entry[0]); entry[1].fn();
  };
  try {
    const viewer = eventViewer();
    await layer.init(viewer);
    layer.setParams({ presentation: 'scene-beat', sceneSurface: 'evidence-beat', beatId: 'mailung-bazzar',
      sceneContext: { holdSec: 7.65 },
      sceneControls: { evidenceMediaAutoplay: true, cameraSettled: true, mediaExitDurationSec: 0.65 } }, { origin: 'scene' });
    await layer.enable(viewer, { origin: 'scene' });
    assert.equal(layer.getSceneShotMediaHold('mailung-bazzar').pending, true);
    assert.equal(layer.getSceneShotMediaHold('different-beat'), null);
    fire(100);
    assert.equal(layer.getSceneShotMediaHold('mailung-bazzar').pending, true, 'startup is not treated as playback');
    phase = 'playing'; fire(100);
    assert.equal(layer.getSceneShotMediaHold('mailung-bazzar').pending, true);
    const hiddenBeforeEnd = hidden;
    phase = 'completed'; fire(100);
    assert.ok(hidden > hiddenBeforeEnd);
    assert.equal(layer.getSceneShotMediaHold('mailung-bazzar').pending, true, 'the fade still owns the hold');
    fire(650);
    assert.equal(layer.getSceneShotMediaHold('mailung-bazzar').pending, false);
    await layer.disable();
    assert.equal(layer.getSceneShotMediaHold('mailung-bazzar'), null);
  } finally {
    await layer.destroy();
    globalThis.document = previous.document; globalThis.window = previous.window;
  }
});

test('Bhote Koshi timeline helpers clamp untrusted UI values', () => {
  assert.equal(clampUnit(-1), 0);
  assert.equal(clampUnit(0.42), 0.42);
  assert.equal(clampUnit(3), 1);
  assert.equal(elapsedLabel(0.5, 4170), '34:45');
  assert.equal(elapsedLabel(1, 4170), '69:30');
});

test('Bhote Koshi flood reveal is monotonic and bounded', () => {
  assert.equal(visibleSegmentCount(0, 144), 0);
  assert.equal(visibleSegmentCount(Number.NaN, 144), 0);
  assert.equal(visibleSegmentCount(0.001, 144), 1);
  assert.equal(visibleSegmentCount(0.5, 144), 72);
  assert.equal(visibleSegmentCount(2, 144), 144);
});

test('Bhote Koshi flood corridor grows continuously to the animated surge head', () => {
  const terrainPositions = Array.from(
    { length: 11 },
    (_, index) => new Cesium.Cartesian3(index, 0, 0),
  );
  const cache = { visibleCount: -1, positions: [] };

  assert.equal(updateCorridorPositionCache(0.201, terrainPositions, cache), true);
  const firstPositions = cache.positions;
  assert.equal(cache.visibleCount, 3);
  assert.equal(firstPositions.length, 4);
  assert.ok(Math.abs(cache.headPosition.x - 2.01) < 1e-9);
  assert.equal(firstPositions.at(-1).x, cache.headPosition.x);

  assert.equal(updateCorridorPositionCache(0.299, terrainPositions, cache), true);
  assert.notEqual(cache.positions, firstPositions, 'the trail advances within the segment');
  assert.ok(Math.abs(cache.headPosition.x - 2.99) < 1e-9);
  assert.equal(cache.positions.at(-1).x, cache.headPosition.x);

  const repeatedPositions = cache.positions;
  assert.equal(updateCorridorPositionCache(0.299, terrainPositions, cache), false);
  assert.equal(cache.positions, repeatedPositions, 'an unchanged frame reuses its positions');

  assert.equal(updateCorridorPositionCache(0.301, terrainPositions, cache), true);
  assert.equal(cache.visibleCount, 4);
  assert.equal(cache.positions.length, 5);
  assert.ok(Math.abs(cache.headPosition.x - 3.01) < 1e-9);
  assert.equal(cache.positions.at(-1).x, cache.headPosition.x);
});

test('Bhote Koshi story clock holds the flood for the cause beats then completes the corridor', () => {
  assert.equal(floodProgressForStoryProgress(0), 0);
  assert.equal(floodProgressForStoryProgress(0.11), 0);
  assert.equal(floodProgressForStoryProgress(0.22), 0);
  assert.ok(floodProgressForStoryProgress(0.5) > 0.4);
  assert.equal(floodProgressForStoryProgress(0.84), 1);
  assert.equal(floodProgressForStoryProgress(1), 1);
});

test('Bhote Koshi camera holds its evidence beat, then travels by the next activation', () => {
  assert.equal(interpolateHeadingDegrees(350, 10, 0.5), 0);
  const reusableTarget = { x: 99, y: 99, z: 99 };
  const result = { target: reusableTarget };
  const keyframes = [
    {
      id: 'cause',
      progress: 0,
      target: { x: 0, y: 0, z: 0 },
      headingDeg: 350,
      pitchDeg: -50,
      rangeM: 1000,
    },
    {
      id: 'border',
      progress: 1,
      target: { x: 10, y: 20, z: 30 },
      headingDeg: 10,
      pitchDeg: -30,
      rangeM: 3000,
    },
  ];
  const held = sampleCinematicPose(0.5, keyframes, result);
  assert.deepEqual(held.target, { x: 0, y: 0, z: 0 });
  assert.equal(held.headingDeg, 350);
  assert.equal(held.pitchDeg, -50);
  assert.equal(held.rangeM, 1000);

  const sampled = sampleCinematicPose(0.81, keyframes, result);
  assert.equal(sampled, result);
  assert.equal(sampled.target, reusableTarget);
  assert.ok(Math.abs(sampled.target.x - 5) < 1e-9);
  assert.ok(Math.abs(sampled.target.y - 10) < 1e-9);
  assert.ok(Math.abs(sampled.target.z - 15) < 1e-9);
  assert.equal(sampled.headingDeg, 0);
  assert.equal(sampled.pitchDeg, -40);
  assert.equal(sampled.rangeM, 2000);
});

test('Bhote Koshi card summaries wrap on words instead of clipping mid-sentence', () => {
  assert.deepEqual(
    evidenceSummaryLines('Five geolocated public viewpoints document the flood passage.', 34, 2),
    ['Five geolocated public viewpoints', 'document the flood passage.'],
  );
  assert.deepEqual(evidenceSummaryLines('one two three four five', 9, 1), ['one two…']);
});

test('Bhote Koshi evidence timeline is ordered by phase and corridor chainage with one active beat', async () => {
  const event = JSON.parse(await readFile(eventUrl, 'utf8'));
  const timeline = buildEvidenceTimeline(event.evidenceSpine, event.reconstruction.corridor);
  assert.deepEqual(
    timeline.map((beat) => beat.observation.id),
    [
      'immediate-collapse-viewpoint',
      'debris-dammed-lake',
      'second-landslide',
      'gyirong-border-gate',
      'timure-cluster',
      'syabru-besi',
      'dhunche',
      'mailung-upper-trishuli',
      'mailung-bazzar',
      'dandagaun',
      'dandagaun-viewpoint',
      'betrawati-bazaar',
      'bhainse',
      'bidur-trishuli-bridge',
      'devighat-taadi-khola-bridge',
      'charaudi',
    ],
  );
  assert.equal(timeline[0].activationProgress, 0);
  assert.equal(timeline[1].activationProgress, 0.065);
  assert.equal(timeline[2].activationProgress, 0.13);
  assert.ok(timeline[3].activationProgress > timeline[2].activationProgress);
  assert.ok(timeline[4].activationProgress > timeline[3].activationProgress);
  assert.equal(timeline[5].activationProgress, 0.325);
  for (let index = 0; index < timeline.length; index += 1) {
    assert.equal(activeEvidenceIndex(timeline[index].activationProgress, timeline), index);
    const midpoint = (
      timeline[index].activationProgress + Math.min(1, timeline[index].deactivationProgress)
    ) / 2;
    assert.equal(activeEvidenceIndex(midpoint, timeline), index);
    const dwellSeconds = (
      Math.min(1, timeline[index].deactivationProgress) - timeline[index].activationProgress
    ) * 90;
    assert.ok(dwellSeconds >= 2, `${timeline[index].observation.id} dwell is too short`);
  }

  const anchors = timeline.map((_, index) => ({ x: index, y: index + 1, z: index + 2 }));
  const cameraFrames = buildCinematicKeyframes(timeline, anchors);
  assert.deepEqual(cameraFrames.slice(0, 16).map((frame) => frame.id), timeline.map((beat) => beat.observation.id));
  assert.deepEqual(cameraFrames.slice(0, 16).map((frame) => frame.progress), timeline.map((beat) => beat.activationProgress));
  assert.equal(cameraFrames.at(-1).id, 'charaudi');
  assert.equal(cameraFrames.at(-1).progress, 1);
});

test('Bhote Koshi scene beats resolve stable ids inside their reveal windows', async () => {
  const event = JSON.parse(await readFile(eventUrl, 'utf8'));
  const timeline = buildEvidenceTimeline(event.evidenceSpine, event.reconstruction.corridor);
  for (const beat of timeline) {
    const progress = evidenceBeatProgress(beat.observation.id, timeline, 0.36);
    assert.ok(progress > beat.activationProgress || beat.deactivationProgress <= beat.activationProgress);
    assert.ok(progress < Math.min(1.000001, beat.deactivationProgress));
    assert.equal(activeEvidenceIndex(progress, timeline), timeline.indexOf(beat));
  }
  assert.equal(evidenceBeatProgress('missing-beat', timeline), null);
});

test('Bhote Koshi scene shots continue the standalone evidence clock from Border Gate onward', async () => {
  const event = JSON.parse(await readFile(eventUrl, 'utf8'));
  const timeline = buildEvidenceTimeline(event.evidenceSpine, event.reconstruction.corridor);
  const border = evidenceSequenceWindow('gyirong-border-gate', timeline);
  assert.deepEqual(border, {
    startProgress: timeline[3].activationProgress,
    targetProgress: timeline[3].deactivationProgress,
  });

  for (const beatId of [
    'timure-cluster',
    'syabru-besi',
    'bidur-trishuli-bridge',
  ]) {
    const beat = timeline.find(({ observation }) => observation.id === beatId);
    const window = evidenceSequenceWindow(beatId, timeline);
    assert.equal(window.startProgress, beat.activationProgress);
    assert.equal(window.targetProgress, Math.min(1, beat.deactivationProgress));
    assert.ok(window.targetProgress > window.startProgress);
  }
  assert.equal(evidenceSequenceWindow('missing-beat', timeline), null);
});

test('Bhote Koshi evidence presentation reveals dot, leader, and card then tears down in reverse', () => {
  const beat = { activationProgress: 0.2, deactivationProgress: 0.4 };
  assert.deepEqual(evidenceBeatPresentation(0.2, beat), {
    alpha: 0,
    scale: 0.96,
    leaderProgress: 0,
    contentAlpha: 0,
    localProgress: 0,
  });
  const revealed = evidenceBeatPresentation(0.2075, beat);
  assert.equal(revealed.alpha, 1);
  assert.equal(revealed.leaderProgress, 1);
  assert.ok(revealed.contentAlpha > 0 && revealed.contentAlpha < 1);
  assert.ok(revealed.scale > 0.96 && revealed.scale < 1);
  const held = evidenceBeatPresentation(0.3, beat);
  assert.equal(held.alpha, 1);
  assert.equal(held.contentAlpha, 1);
  assert.equal(held.scale, 1);
  const receding = evidenceBeatPresentation(0.35, beat);
  assert.equal(receding.alpha, 1, 'the terrain dot remains after card recession starts');
  assert.ok(receding.contentAlpha < receding.leaderProgress);
  assert.ok(receding.scale < held.scale);
  const late = evidenceBeatPresentation(0.375, beat);
  assert.equal(late.contentAlpha, 0, 'card content clears first');
  assert.ok(late.leaderProgress > 0 && late.leaderProgress < late.alpha);
  assert.equal(evidenceBeatPresentation(0.4, beat).alpha, 0);
});

test('Bhote Koshi evidence cards freeze useful landscape, portrait, and link-only footprints', () => {
  assert.equal(evidenceCardLayout({
    media: { posterUrl: 'poster.jpg', width: 1920, height: 1080 },
  }).kind, 'landscape');
  assert.deepEqual(
    {
      kind: evidenceCardLayout({
        media: { videoPath: 'portrait.mp4', width: 240, height: 422 },
      }).kind,
      width: evidenceCardLayout({
        media: { videoPath: 'portrait.mp4', width: 240, height: 422 },
      }).thumbnailWidth,
      height: evidenceCardLayout({
        media: { videoPath: 'portrait.mp4', width: 240, height: 422 },
      }).thumbnailHeight,
    },
    { kind: 'portrait', width: 168, height: 260 },
  );
  assert.equal(evidenceCardLayout({ media: { posterUrl: null } }).kind, 'link');
});

test('Bhote Koshi gives YouTube and Facebook players priority over local review clips', () => {
  assert.equal(usesProviderEmbeddedEvidence({
    media: {
      sourceUrl: 'https://www.youtube.com/watch?v=DbqRexFxv3k',
      videoPath: 'evidence-01.mp4',
    },
  }), true);
  assert.equal(usesProviderEmbeddedEvidence({
    media: {
      sourceUrl: 'https://www.facebook.com/reel/1571491657757829',
      videoPath: 'evidence-15.mp4',
    },
  }), true);
  assert.equal(usesProviderEmbeddedEvidence({
    media: {
      sourceUrl: 'https://example.com/evidence',
      videoPath: 'evidence-01.mp4',
    },
  }), false);
});

test('Bhote Koshi beat navigation is deterministic in both directions and clamps at its ends', async () => {
  const event = JSON.parse(await readFile(eventUrl, 'utf8'));
  const timeline = buildEvidenceTimeline(event.evidenceSpine, event.reconstruction.corridor);
  assert.equal(adjacentEvidenceIndex(0, timeline, -1), 0);
  assert.equal(adjacentEvidenceIndex(0, timeline, 1), 1);
  assert.equal(adjacentEvidenceIndex(timeline[3].activationProgress, timeline, -1), 2);
  assert.equal(adjacentEvidenceIndex(timeline[3].activationProgress, timeline, 1), 4);
  assert.equal(adjacentEvidenceIndex(1, timeline, 1), 15);
  assert.equal(adjacentEvidenceIndex(0.5, [], 1), -1);
});

test('Bhote Koshi evidence fallback stays media-first and source-linked without card copy overload', async () => {
  const event = JSON.parse(await readFile(eventUrl, 'utf8'));
  const timure = event.evidenceSpine.find((observation) => observation.id === 'timure-cluster');
  const originalDocument = globalThis.document;
  const contexts = [];
  globalThis.document = {
    createElement() {
      const text = [];
      const context = {
        text,
        beginPath() {},
        clearRect() {},
        moveTo() {},
        lineTo() {},
        stroke() {},
        fillRect() {},
        fillText(value) { text.push(String(value)); },
        drawImage() { throw new Error('fixture poster decode failure'); },
      };
      contexts.push(context);
      return { width: 0, height: 0, getContext: () => context };
    },
  };

  try {
    const missingPosterFrame = createEvidenceFrame(timure);
    const failedPosterFrame = createEvidenceFrame(timure, { width: 640, height: 400 });
    assert.ok(missingPosterFrame);
    assert.ok(failedPosterFrame);
    for (const context of contexts) {
      assert.ok(context.text.includes('NO PREVIEW'));
      assert.ok(context.text.includes('TIMURE'));
      assert.ok(context.text.includes('YOUTUBE SOURCE / OPEN'));
      assert.doesNotMatch(context.text.join(' '), /CAPTURE TIME|GEOLOCATED|public viewpoints/);
    }
    assert.match(timure.media.sourceUrl, /^https:\/\//);
  } finally {
    globalThis.document = originalDocument;
  }
});

test('Bhote Koshi evidence compositor contains portrait video from its decoded dimensions', async () => {
  const event = JSON.parse(await readFile(eventUrl, 'utf8'));
  const observation = event.evidenceSpine[0];
  const drawCalls = [];
  const context = {
    beginPath() {},
    clearRect() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    fillRect() {},
    fillText() {},
    drawImage(...args) { drawCalls.push(args); },
  };
  const layout = evidenceCardLayout(observation);
  const canvas = {
    width: layout.canvasWidth,
    height: layout.canvasHeight,
    _bhoteEvidenceLayout: layout,
    getContext: () => context,
  };
  const video = { videoWidth: 240, videoHeight: 422, width: 0, height: 0 };

  assert.equal(updateEvidenceFrame(canvas, observation, video, { videoActive: true }), true);
  assert.equal(drawCalls.length, 1);
  const [, destX, destY, destWidth, destHeight] = drawCalls[0];
  assert.ok(destX > 0, 'portrait video keeps narrow side gutters instead of being cropped');
  assert.equal(destY, 0);
  assert.ok(destWidth < layout.canvasWidth);
  assert.equal(destHeight, layout.mediaHeight);
  assert.equal(context.textAlign, 'left', 'repeat paints cannot inherit the outside badge alignment');
  assert.equal(updateEvidenceFrame(canvas, observation, video, { videoActive: true }), true);
  assert.equal(context.textAlign, 'left');
});

test('Bhote Koshi failed direct enable restores the prior map and shared split', async () => {
  const event = JSON.parse(await readFile(eventUrl, 'utf8'));
  const mapCalls = [];
  const overlayCalls = [];
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  let activeMap = 'photoreal';
  let generation = 7;
  const viewer = {
    scene: { splitPosition: 0.37 },
    imageryLayers: { remove() {} },
    dataSources: { remove() {} },
  };
  const layer = createBhoteKoshiEventLayer({
    eventLoader: async () => event,
    imageryProviderFactory: async () => { throw new Error('fixture image failure'); },
    overlayHost: {
      setEntries() {},
      setVisible(id, visible) { overlayCalls.push(['visible', id, visible]); },
      clearSource(id) { overlayCalls.push(['clear', id]); },
    },
    renderHost: { request() {}, hold() {}, release() {} },
  });
  layer.attachMapStackController({
    getActiveId: () => activeMap,
    getSwitchGeneration: () => generation,
    async setStack(id) {
      activeMap = id;
      generation += 1;
      mapCalls.push(id);
    },
  });
  globalThis.document = { documentElement: { style: { removeProperty() {} } } };
  globalThis.window = { clearTimeout() {} };

  try {
    await assert.rejects(
      layer.enable(viewer, { origin: 'scene' }),
      /fixture image failure/,
    );
    assert.deepEqual(mapCalls, ['esri-imagery', 'photoreal']);
    assert.equal(viewer.scene.splitPosition, 0.37);
    assert.deepEqual(layer.getPlaybackState(), {
      enabled: false,
      playing: false,
      progress: 0,
      split: 0.5,
    });
    assert.ok(overlayCalls.some(([kind]) => kind === 'clear'));
  } finally {
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
  }
});

test('Bhote Koshi cancellation during the map switch restores the prior stack', async () => {
  const event = JSON.parse(await readFile(eventUrl, 'utf8'));
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const controller = new AbortController();
  const viewer = eventViewer();
  let activeMap = 'photoreal';
  let generation = 12;
  let finishSwitch;
  const switchGate = new Promise((resolve) => { finishSwitch = resolve; });
  const mapCalls = [];
  const layer = createBhoteKoshiEventLayer({
    eventLoader: async () => event,
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
    renderHost: { request() {}, hold() {}, release() {} },
  });
  layer.attachMapStackController({
    getActiveId: () => activeMap,
    getSwitchGeneration: () => generation,
    async setStack(id) {
      activeMap = id;
      generation += 1;
      mapCalls.push(id);
      if (id === 'esri-imagery') await switchGate;
    },
  });
  installEventDom();
  globalThis.window = { clearTimeout() {} };

  try {
    const enabling = layer.enable(viewer, { origin: 'scene', signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    finishSwitch();
    await assert.rejects(enabling, (error) => error?.name === 'AbortError');
    assert.deepEqual(mapCalls, ['esri-imagery', 'photoreal']);
    assert.equal(viewer.scene.splitPosition, 0.37);
    assert.equal(layer.getPlaybackState().enabled, false);
  } finally {
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
  }
});

test('Bhote Koshi disable preserves an operator-selected map and tears down every surface', async () => {
  const event = JSON.parse(await readFile(eventUrl, 'utf8'));
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const { body, removedProperties } = installEventDom();
  const clearedTimeouts = [];
  globalThis.window = {
    setTimeout: () => 71,
    clearTimeout: (id) => clearedTimeouts.push(id),
  };
  const viewer = eventViewer();
  let activeMap = 'photoreal';
  let generation = 20;
  const mapCalls = [];
  const overlayCalls = [];
  const renderCalls = [];
  const layer = createBhoteKoshiEventLayer({
    eventLoader: async () => event,
    imageryProviderFactory: async (url) => ({ url }),
    overlayHost: {
      setEntries() {},
      setVisible(id, visible) { overlayCalls.push(['visible', id, visible]); },
      clearSource(id) { overlayCalls.push(['clear', id]); },
    },
    renderHost: {
      request(reason) { renderCalls.push(reason); },
      hold() {},
      release() {},
    },
  });
  layer.attachMapStackController({
    getActiveId: () => activeMap,
    getSwitchGeneration: () => generation,
    async setStack(id) {
      activeMap = id;
      generation += 1;
      mapCalls.push(id);
    },
  });

  try {
    assert.equal(await layer.enable(viewer, { origin: 'scene' }), true);
    assert.equal(viewer._test.imagery.length, 2);
    assert.equal(viewer._test.dataSources.length, 1);
    assert.equal(body.children.length, 2);

    activeMap = 'operator-choice';
    generation += 1;
    await layer.disable();

    assert.deepEqual(mapCalls, ['esri-imagery']);
    assert.equal(viewer._test.removedImagery.length, 2);
    assert.equal(viewer._test.removedDataSources.length, 1);
    assert.ok(body.children.every((element) => element.removed));
    assert.equal(viewer.scene.splitPosition, 0.37);
    assert.deepEqual(clearedTimeouts, [71]);
    assert.ok(overlayCalls.some(([kind]) => kind === 'clear'));
    assert.ok(removedProperties.includes('--bhote-koshi-split'));
    assert.ok(renderCalls.includes('bhote-koshi-disable'));
  } finally {
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
  }
});

test('Bhote Koshi disable stops active playback and releases its global render hold', async () => {
  const event = JSON.parse(await readFile(eventUrl, 'utf8'));
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const originalPerformance = globalThis.performance;
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  const { body } = installEventDom();
  const holds = [];
  const releases = [];
  const cancelledFrames = [];
  globalThis.window = { setTimeout: () => 71, clearTimeout() {} };
  globalThis.performance = { now: () => 1000 };
  globalThis.requestAnimationFrame = () => 33;
  globalThis.cancelAnimationFrame = (id) => cancelledFrames.push(id);
  const viewer = eventViewer();
  const layer = createBhoteKoshiEventLayer({
    eventLoader: async () => event,
    imageryProviderFactory: async (url) => ({ url }),
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
    renderHost: {
      request() {},
      hold(id) { holds.push(id); },
      release(id) { releases.push(id); },
    },
  });
  layer.attachMapStackController({
    getActiveId: () => 'esri-imagery',
    getSwitchGeneration: () => 1,
    async setStack() {},
  });

  try {
    await layer.enable(viewer, { origin: 'scene' });
    const panel = body.children.find((element) => element.tagName === 'aside');
    assert.equal(panel.querySelector('[data-action="play-scene"]').hidden, true);
    assert.equal(await panel.querySelector('[data-action="play-scene"]').dispatch('click'), false);
    panel.querySelector('[data-action="play"]').dispatch('click');
    assert.equal(layer.getPlaybackState().playing, true);

    await layer.disable();

    assert.deepEqual(holds, ['bhote-koshi-playback']);
    assert.deepEqual(releases, ['bhote-koshi-playback']);
    assert.deepEqual(cancelledFrames, [33]);
    assert.deepEqual(layer.getPlaybackState(), {
      enabled: false,
      playing: false,
      progress: 0,
      split: 0.5,
    });
  } finally {
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
    globalThis.performance = originalPerformance;
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
  }
});

test('Bhote Koshi passive restores do not start off-screen playback', async () => {
  const event = JSON.parse(await readFile(eventUrl, 'utf8'));
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  installEventDom();
  const timers = [];
  globalThis.window = {
    setTimeout(handler, delay) {
      timers.push({ handler, delay });
      return timers.length;
    },
    clearTimeout() {},
  };
  const viewer = eventViewer();
  const layer = createBhoteKoshiEventLayer({
    eventLoader: async () => event,
    imageryProviderFactory: async (url) => ({ url }),
    embeddedMediaFactory: () => ({ show() {}, hide() {}, pause() {}, destroy() {} }),
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
    renderHost: { request() {}, hold() {}, release() {} },
  });
  layer.attachMapStackController({
    getActiveId: () => 'esri-imagery',
    getSwitchGeneration: () => 1,
    async setStack() {},
  });

  const manager = new LayerLifecycle(viewer);
  manager.register(layer);
  try {
    assert.equal(await manager.setEnabled(layer.id, true, { origin: 'local-restore' }), true);
    assert.deepEqual(timers, []);
    assert.deepEqual(viewer._test.cameraLooks, []);
    assert.equal(layer.getPlaybackState().playing, false);
  } finally {
    await manager.destroyLayer(layer.id);
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
  }
});

test('Bhote Koshi standalone Scene keeps its Esri cinematic contract', async () => {
  const event = JSON.parse(await readFile(eventUrl, 'utf8'));
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const originalPerformance = globalThis.performance;
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  installEventDom();
  const timers = [];
  globalThis.window = {
    setTimeout(handler, delay) {
      timers.push({ handler, delay });
      return timers.length;
    },
    clearTimeout() {},
  };
  globalThis.performance = { now: () => 1000 };
  globalThis.requestAnimationFrame = () => 44;
  globalThis.cancelAnimationFrame = () => {};
  const viewer = eventViewer();
  let activeMap = 'photoreal';
  const mapCalls = [];
  const layer = createBhoteKoshiEventLayer({
    eventLoader: async () => event,
    imageryProviderFactory: async (url) => ({ url }),
    terrainSampler: async (_viewer, observations) => (
      observations.map((observation) => ({ height: observation.fallbackElevationM }))
    ),
    mediaLoader: async () => {
      const error = new Error('fixture media intentionally unavailable');
      error.name = 'AbortError';
      throw error;
    },
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
    renderHost: { request() {}, hold() {}, release() {} },
  });
  layer.attachMapStackController({
    getActiveId: () => activeMap,
    getSwitchGeneration: () => mapCalls.length,
    async setStack(id) {
      activeMap = id;
      mapCalls.push(id);
    },
  });

  try {
    await layer.enable(viewer, { origin: 'scene' });
    assert.deepEqual(mapCalls, ['esri-imagery']);
    assert.equal(viewer._test.imagery.length, 2);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delay, 2400);
    timers[0].handler();
    assert.equal(layer.getPlaybackState().playing, true);
    assert.equal(layer.getCinematicState().active, true);
    assert.equal(viewer._test.cameraLooks.length, 1);
    await layer.disable();
    assert.deepEqual(mapCalls, ['esri-imagery', 'photoreal']);
  } finally {
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
    globalThis.performance = originalPerformance;
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
  }
});

test('Bhote Koshi scene beats preserve photoreal and never take camera ownership', async () => {
  const event = JSON.parse(await readFile(eventUrl, 'utf8'));
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const originalPerformance = globalThis.performance;
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  const { body } = installEventDom();
  const timers = [];
  const openedUrls = [];
  const cancelledFrames = [];
  globalThis.window = {
    setTimeout(handler, delay) {
      timers.push({ handler, delay });
      return timers.length;
    },
    clearTimeout() {},
    open(url) {
      openedUrls.push(url);
      return { opener: 'fixture' };
    },
  };
  globalThis.performance = { now: () => 1000 };
  globalThis.requestAnimationFrame = () => 91;
  globalThis.cancelAnimationFrame = (id) => cancelledFrames.push(id);
  const viewer = eventViewer();
  let activeMap = 'photoreal';
  const mapCalls = [];
  const overlayPublications = [];
  const overlayVisibility = [];
  const layer = createBhoteKoshiEventLayer({
    eventLoader: async () => event,
    imageryProviderFactory: async (url) => ({ url }),
    terrainSampler: async (_viewer, observations) => (
      observations.map((observation) => ({ height: observation.fallbackElevationM }))
    ),
    mediaLoader: async () => {
      const error = new Error('fixture media intentionally unavailable');
      error.name = 'AbortError';
      throw error;
    },
    overlayHost: {
      setEntries(id, entries, options) {
        overlayPublications.push({ id, entries, options });
      },
      setVisible(id, visible) {
        overlayVisibility.push({ id, visible });
      },
      clearSource() {},
    },
    renderHost: { request() {}, hold() {}, release() {} },
  });
  layer.attachMapStackController({
    getActiveId: () => activeMap,
    getSwitchGeneration: () => 1,
    async setStack(id) {
      activeMap = id;
      mapCalls.push(id);
    },
  });
  const sceneCalls = [];
  let finishScene;
  let publishSceneClock;
  layer.attachSceneController({
    subscribeSceneClock(listener) {
      publishSceneClock = listener;
      return () => { publishSceneClock = null; };
    },
    continueScene(sceneId, shotId) {
      sceneCalls.push({ action: 'scene', sceneId, shotId });
      return new Promise((resolve) => { finishScene = resolve; });
    },
    replayShot(sceneId, shotId) {
      sceneCalls.push({ action: 'play', sceneId, shotId });
      return true;
    },
    loadAdjacentShot(sceneId, shotId, direction) {
      sceneCalls.push({ action: 'adjacent', sceneId, shotId, direction });
      return true;
    },
    seekScene(sceneId, progress) {
      sceneCalls.push({ action: 'seek', sceneId, progress });
      return true;
    },
  });

  try {
    assert.equal(layer.setParams({
      presentation: 'scene-beat',
      sceneSurface: 'panel-only',
      progress: 0.34,
      split: 0.62,
      cinematic: true,
      autoPlay: true,
      sceneContext: {
        sceneId: 'nepal-scene',
        sceneTitle: 'Nepal Flood Incident',
        shotId: 'global-context',
        shotTitle: 'Global Incident Context',
        shotIndex: 0,
        shotCount: 14,
        durationSec: 4,
        holdSec: 0.9,
        sceneElapsedSec: 0,
        sceneDurationSec: 120,
        sceneProgress: 0,
      },
    }, { origin: 'scene' }), true);
    await layer.enable(viewer, { origin: 'scene' });
    assert.deepEqual(mapCalls, []);
    assert.equal(activeMap, 'photoreal');
    assert.deepEqual(timers, []);
    assert.equal(viewer._test.imagery.length, 2, 'the event surface keeps its cached imagery pair');
    assert.ok(viewer._test.imagery.every((imageryLayer) => imageryLayer.show === false));
    const panel = body.children.find((element) => element.tagName === 'aside');
    assert.ok(panel);
    const splitLine = body.children.find((element) => element.id === 'bhote-koshi-split-line');
    assert.ok(splitLine);
    assert.equal(splitLine.hidden, true);
    assert.equal(panel.querySelector('[data-role="imagery-comparison"]').hidden, true);
    assert.match(panel.querySelector('[data-role="caveat"]').textContent, /SCHEMATIC CORRIDOR/i);
    assert.doesNotMatch(panel.querySelector('[data-role="caveat"]').textContent, /historical/i);
    assert.equal(panel.querySelector('[data-role="imagery-cloud-note"]').hidden, true);
    const sceneClock = panel.querySelector('[data-role="progress"]');
    assert.equal(sceneClock.hidden, false);
    assert.equal(sceneClock.disabled, false);
    assert.equal(sceneClock.getAttribute('aria-label'), 'Seek Nepal scene clock');
    assert.equal(panel.querySelector('[data-role="timeline-label"]').textContent, 'NEPAL SCENE CLOCK');
    assert.equal(panel.querySelector('[data-role="time"]').textContent, '~0:00 / 2:00');
    publishSceneClock({
      sceneId: 'nepal-scene',
      shotId: 'global-context',
      shotIndex: 0,
      shotCount: 14,
      sceneElapsedSec: 30,
      sceneDurationSec: 120,
      sceneProgress: 0.25,
      running: true,
    });
    assert.equal(sceneClock.value, '250');
    assert.equal(panel.querySelector('[data-role="time"]').textContent, '~0:30 / 2:00');
    assert.equal(panel.querySelector('[data-role="beat-index"]').textContent, '01 / 14');
    assert.equal(panel.querySelector('[data-role="beat-title"]').textContent, 'Global Incident Context');
    assert.equal(panel.querySelector('[data-action="play"]').textContent, '▶ PLAY SHOT');
    const playScene = panel.querySelector('[data-action="play-scene"]');
    assert.equal(playScene.hidden, false);
    assert.equal(playScene.disabled, false);
    assert.equal(playScene.textContent, '▶ PLAY SCENE');
    assert.equal(playScene.getAttribute('aria-label'), 'Continue Nepal Flood Incident from next shot');
    assert.equal(panel.querySelector('[data-action="cinematic"]').hidden, true);
    assert.equal(panel.querySelector('[data-action="cinematic"]').disabled, true);
    assert.equal(panel.querySelector('[data-action="corridor"]').hidden, false);
    assert.equal(panel.querySelector('[data-action="corridor"]').disabled, false);
    assert.doesNotMatch(panel.innerHTML, /data-action="witness"|◎ WITNESS/);
    assert.match(panel.innerHTML, /data-action="open-source"/);
    const fullStory = panel.querySelector('[data-action="story-replay"]');
    assert.equal(fullStory.textContent, '↺ FULL STORY');
    assert.equal(fullStory.hidden, true, 'PLAY SCENE owns authored scene playback');
    assert.equal(fullStory.disabled, true);
    assert.equal(panel.querySelector('[data-action="open-source"]').hidden, true);
    assert.deepEqual(layer.getParams(), {
      presentation: 'scene-beat',
      sceneSurface: 'panel-only',
      progress: 0.34,
      split: 0.62,
    });
    assert.equal(viewer.scene.splitPosition, 0.62);
    layer.setParams({
      presentation: 'scene-beat',
      sceneSurface: 'evidence-beat',
      beatId: 'timure-cluster',
      sceneControls: { imageryComparison: true },
    }, { origin: 'scene' });
    assert.equal(splitLine.hidden, false);
    assert.equal(panel.querySelector('[data-role="imagery-comparison"]').hidden, false);
    assert.ok(viewer._test.imagery.every((imageryLayer) => imageryLayer.show === true));
    const splitHandle = splitLine.children.find(
      (element) => element.className === 'bhote-koshi-split-handle',
    );
    assert.ok(splitHandle);
    assert.equal(splitHandle.textContent, '↔');
    assert.equal(splitHandle.getAttribute('aria-valuenow'), '62');
    splitHandle.dispatch('pointerdown', {
      button: 0,
      clientX: 250,
      pointerId: 4,
      preventDefault() {},
    });
    splitHandle.dispatch('pointermove', {
      clientX: 750,
      pointerId: 4,
      preventDefault() {},
    });
    splitHandle.dispatch('pointerup', { pointerId: 4 });
    assert.equal(viewer.scene.splitPosition, 0.75);
    assert.equal(splitHandle.getAttribute('aria-valuenow'), '75');
    splitHandle.dispatch('keydown', {
      key: 'ArrowLeft',
      shiftKey: true,
      preventDefault() {},
    });
    assert.equal(viewer.scene.splitPosition, 0.7);
    layer.setParams({
      presentation: 'scene-beat',
      sceneSurface: 'panel-only',
      progress: 0.34,
      split: 0.62,
      sceneControls: {},
    }, { origin: 'scene' });
    assert.equal(splitLine.hidden, true);
    assert.ok(viewer._test.imagery.every((imageryLayer) => imageryLayer.show === false));
    assert.equal(viewer.scene.splitPosition, 0.62);
    assert.equal(overlayVisibility.at(-1).visible, false);
    for (const id of [
      'bhote-koshi-flood-halo',
      'bhote-koshi-flood-core',
      'bhote-koshi-surge-front',
    ]) {
      assert.equal(viewer._test.dataSources[0].entities.getById(id).show, false);
    }
    panel.querySelector('[data-action="play"]').dispatch('click');
    await Promise.resolve();
    panel.querySelector('[data-action="next-beat"]').dispatch('click');
    await Promise.resolve();
    assert.deepEqual(sceneCalls, [
      { action: 'play', sceneId: 'nepal-scene', shotId: 'global-context' },
      { action: 'adjacent', sceneId: 'nepal-scene', shotId: 'global-context', direction: 1 },
    ]);
    const run = playScene.dispatch('click');
    assert.equal(playScene.disabled, true);
    assert.equal(playScene.textContent, '… PLAYING SCENE');
    assert.equal(panel.querySelector('[data-action="play"]').disabled, true);
    assert.equal(panel.querySelector('[data-action="play"]').textContent, '▶ PLAY SHOT');
    await playScene.dispatch('click');
    assert.deepEqual(sceneCalls.at(-1), {
      action: 'scene', sceneId: 'nepal-scene', shotId: 'global-context',
    });
    assert.equal(sceneCalls.length, 3, 'duplicate clicks cannot start another scene run');
    finishScene({ started: true });
    await run;
    assert.equal(playScene.disabled, false);
    assert.equal(playScene.textContent, '▶ PLAY SCENE');
    sceneClock.value = '500';
    sceneClock.dispatch('input');
    assert.equal(panel.querySelector('[data-role="time"]').textContent, '~1:00 / 2:00');
    sceneClock.dispatch('change');
    await Promise.resolve();
    assert.deepEqual(sceneCalls.at(-1), { action: 'seek', sceneId: 'nepal-scene', progress: 0.5 });
    assert.equal(sceneCalls.length, 4);
    layer.attachSceneController({ continueScene: async () => ({ started: false, reason: 'already-running' }) });
    assert.deepEqual(await playScene.dispatch('click'), { started: false, reason: 'already-running' });
    assert.equal(playScene.disabled, false, 'a refused start releases the button');
    layer.attachSceneController({ continueScene: async () => { throw new Error('test scene failure'); } });
    const originalWarn = console.warn;
    const warnings = [];
    try {
      console.warn = (...args) => warnings.push(args);
      assert.equal(await playScene.dispatch('click'), false);
      assert.equal(playScene.disabled, false, 'a rejected start releases the button');
      assert.equal(warnings.length, 1);
    } finally {
      console.warn = originalWarn;
    }
    layer.attachSceneController(null);
    assert.equal(playScene.disabled, true);
    await playScene.dispatch('click');
    assert.equal(sceneCalls.length, 4);
    assert.equal(layer.getPlaybackState().playing, false);
    for (const reportButton of panel.querySelector('.bhote-event-report-list').children) {
      reportButton.dispatch('click');
    }
    panel.querySelector('[data-action="geolocation-map"]').dispatch('click');
    assert.deepEqual(openedUrls, [
      ...event.fieldReports.map(({ url }) => url),
      event.geolocationMap.sourceUrl,
    ]);
    assert.equal(layer.getPlaybackState().playing, false);
    assert.equal(layer.getCinematicState().active, false);
    assert.equal(viewer._test.cameraLooks.length, 0);
    assert.deepEqual(mapCalls, []);
    assert.equal(body.children.filter((element) => element.tagName === 'aside').length, 1);
    assert.equal(viewer.scene.splitPosition, 0.62);
    for (const beatId of [
      'debris-dammed-lake',
      'gyirong-border-gate',
      'timure-cluster',
      'syabru-besi',
      'bidur-trishuli-bridge',
    ]) {
      layer.setParams({
        presentation: 'scene-beat',
        sceneSurface: 'evidence-beat',
        beatId,
        beatReveal: 0.36,
      }, { origin: 'scene' });
      assert.equal(layer.getParams().beatId, beatId);
      assert.equal(layer.getParams().sceneSurface, 'evidence-beat');
      assert.equal(panel.querySelector('[data-action="open-source"]').hidden, false);
      assert.equal(overlayVisibility.at(-1).visible, true);
      const entries = overlayPublications.at(-1).entries;
      const visibleCards = entries.filter((entry) => (
        entry.id.startsWith('evidence-card-') && entry.position() != null
      ));
      assert.deepEqual(visibleCards.map(({ id }) => id), [`evidence-card-${beatId}`]);
      assert.ok(entries
        .filter((entry) => entry.id.startsWith('evidence-breadcrumb-'))
        .every((entry) => entry.position() == null));
      assert.equal(viewer._test.dataSources.filter((source) => (
        !viewer._test.removedDataSources.includes(source)
      )).length, 1, 'surface transitions leave exactly one active event surface');
      assert.equal(viewer._test.cameraLooks.length, 0, 'consecutive beats never write the camera');
    }
    panel.querySelector('[data-action="open-source"]').dispatch('click');
    assert.equal(openedUrls.at(-1), event.evidenceSpine.find(({ id }) => id === 'bidur-trishuli-bridge').media.sourceUrl);
    layer.setParams({
      presentation: 'scene-beat',
      progress: 0.2,
    }, { origin: 'scene' });
    assert.equal(layer.getParams().sceneSurface, 'panel-only', 'missing ownership fails closed');
    assert.equal(panel.querySelector('[data-action="open-source"]').hidden, true);
    assert.equal(overlayVisibility.at(-1).visible, false);
    await layer.disable();
    assert.deepEqual(
      cancelledFrames,
      [91],
      'disable revokes the pending real-time scene-clock scrub frame',
    );
    assert.deepEqual(mapCalls, []);
    assert.equal(viewer._test.removedDataSources.length, viewer._test.dataSources.length);
  } finally {
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
    globalThis.performance = originalPerformance;
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
  }
});

test('Nepal hybrid comparison preserves native split and terrain-clamped flood trail', async () => {
  const event = JSON.parse(await readFile(eventUrl, 'utf8'));
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  installEventDom();
  globalThis.window = { setTimeout: () => 71, clearTimeout() {} };
  const viewer = eventViewer();
  const mapCalls = [];
  const comparisonCalls = [];
  const layer = createBhoteKoshiEventLayer({
    eventLoader: async () => event,
    imageryProviderFactory: async (url) => ({ url }),
    terrainSampler: async (_viewer, observations) => (
      observations.map((observation) => ({ height: observation.fallbackElevationM }))
    ),
    mediaLoader: async () => {
      const error = new Error('fixture media intentionally unavailable');
      error.name = 'AbortError';
      throw error;
    },
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
    renderHost: { request() {}, hold() {}, release() {} },
  });
  layer.attachMapStackController({
    getActiveId: () => 'photoreal',
    getSwitchGeneration: () => 1,
    async setStack(id) { mapCalls.push(id); },
    async setTerrainComparison(rectangle) { comparisonCalls.push(rectangle); return true; },
    clearTerrainComparison() { comparisonCalls.push(null); },
  });

  try {
    layer.setParams({
      presentation: 'scene-beat',
      sceneSurface: 'evidence-beat',
      beatId: 'gyirong-border-gate',
      sceneControls: { imageryComparison: true },
    }, { origin: 'scene' });
    await layer.enable(viewer, { origin: 'scene' });

    assert.deepEqual(mapCalls, [], 'comparison does not switch the authored Google base');
    assert.deepEqual(comparisonCalls, [event.imagery.rectangle]);
    assert.equal(viewer._test.imagery.length, 2);
    assert.ok(viewer._test.imagery.every((imageryLayer) => imageryLayer.show === true));
    assert.equal(viewer.scene.splitPosition, 0.5);
    assert.equal(viewer._test.imagery[0].splitDirection, Cesium.SplitDirection.LEFT);
    assert.equal(viewer._test.imagery[1].splitDirection, Cesium.SplitDirection.RIGHT);
    layer.setParams({ split: 0.25 });
    assert.equal(viewer.scene.splitPosition, 0.25);
    const flood = viewer._test.dataSources[0].entities.getById('bhote-koshi-flood-core');
    const surge = viewer._test.dataSources[0].entities.getById('bhote-koshi-surge-front');
    assert.equal(flood.polyline.clampToGround.getValue(), true);
    assert.equal(
      surge.point.heightReference.getValue(),
      Cesium.HeightReference.CLAMP_TO_GROUND,
    );

    layer.setParams({
      presentation: 'scene-beat',
      sceneSurface: 'evidence-beat',
      beatId: 'timure',
      sceneControls: { imageryComparison: false },
    }, { origin: 'scene' });
    assert.ok(viewer._test.imagery.every((imageryLayer) => imageryLayer.show === false));
    assert.equal(comparisonCalls.at(-1), null);

    const tileFlood = viewer._test.dataSources.at(-1).entities.getById('bhote-koshi-flood-core');
    assert.equal(tileFlood.polyline.clampToGround.getValue(), true);
    assert.equal(tileFlood.polyline.classificationType.getValue(), Cesium.ClassificationType.BOTH);

    await layer.disable();
    assert.equal(viewer._test.removedImagery.length, 2);
  } finally {
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
  }
});

test('Bhote Koshi event pack keeps observations separate from reconstruction', async () => {
  const event = JSON.parse(await readFile(eventUrl, 'utf8'));
  assert.equal(BHOTE_KOSHI_LAYER_ID, event.id);
  assert.equal(event.imagery.before.observedAt, '2021-10-16');
  assert.equal(event.imagery.after.observedAt, '2026-08-27');
  assert.equal(
    event.reconstruction.label,
    'SCHEMATIC DOWNSTREAM PROGRESSION, NOT MODELED ARRIVAL TIME',
  );
  assert.match(event.imagery.before.label, /^2021 HISTORICAL REFERENCE/);
  assert.match(event.imagery.after.label, /^2026 POST-EVENT/);
  assert.equal(
    event.geolocationMap.sourceUrl,
    'https://x.com/geogeorgeology/status/2093632283442053371',
  );
  assert.ok(event.reconstruction.corridor.length >= 100);
  assert.equal(event.witnessAnchors.length, 1);
  assert.ok(Number.isFinite(event.witnessAnchors[0].elevationM));
  assert.match(event.witnessAnchors[0].title, /SOURCE GEO/);
  assert.equal(event.viewpoints.witness.imagery, 'before');
  assert.equal(
    event.fieldReports.filter((report) => report.status.includes('WORLD-PINNED')).length,
    1,
  );
  assert.ok(event.fieldReports.some((report) => report.status.includes('UNVERIFIED')));
  assert.equal(event.evidenceSpine.length, 16);
  assert.equal(new Set(event.evidenceSpine.map(({ id }) => id)).size, 16);
  assert.deepEqual(event.evidenceSpine.map(({ sequence }) => sequence),
    Array.from({ length: 16 }, (_, index) => index + 1));
  assert.equal(floodProgressForStoryProgress(0.195, event.reconstruction.storyFloodWindow), 0);
  assert.equal(floodProgressForStoryProgress(0.39, event.reconstruction.storyFloodWindow), 1);
  assert.equal(floodProgressForStoryProgress(0.9, event.reconstruction.storyFloodWindow), 1);
  for (const { media } of event.evidenceSpine) {
    for (const asset of [media.videoPath, media.posterPath].filter(Boolean)) {
      assert.match(asset, /^evidence-\d+\.(mp4|jpg)$/);
      assert.ok((await readFile(new URL(asset, eventUrl))).length > 0, asset);
    }
  }
  assert.ok(event.evidenceSpine.every((observation) => observation.timing.capturedAt === null));
  assert.ok(event.evidenceSpine.every((observation) => (
    observation.timing.note === 'capture time unverified'
  )));
  assert.ok(event.evidenceSpine.every((observation) => /^https:\/\//.test(observation.media.sourceUrl)));
  assert.ok(event.evidenceSpine.filter((observation) => observation.media.posterUrl).every((observation) => (
    observation.media.posterUrl.startsWith('https://i.ytimg.com/')
  )));
  assert.equal(
    event.evidenceSpine.find(({ id }) => id === 'gyirong-border-gate').media.clipInSec,
    26,
  );
  assert.ok(event.evidenceSpine.every(({ media }) => !media.videoPath && !media.posterPath),
    'Public event records must not reference privately cached social clips');
  assert.equal(event.evidenceSpine.filter((observation) => (
    observation.imageryCoverage === 'outside'
  )).length, 13);
  const timure = event.evidenceSpine.find((observation) => observation.id === 'timure-cluster');
  assert.equal(timure.corroboration.kind, 'multi-source geolocation cluster');
  assert.equal(timure.corroboration.sourceCount, 5);
  assert.equal(timure.corroboration.displayedSourceCount, 1);
  assert.equal(evidenceCorroborationLabel(timure), '5 GEOLOCATED SOURCE-MAP PLACEMENTS');
  assert.match(event.reconstruction.caveat, /2021 historical reference versus 2026 post-event/i);
  assert.match(event.reconstruction.caveat, /not modeled arrival time/i);
  assert.match(event.reconstruction.caveat, /2025 Rasuwagadhi flood/i);
  assert.equal(SCENE_RECIPES.some((recipe) => recipe.id === 'bhote-koshi-flood'), false);
  assert.ok(SCENE_RECIPES.some((recipe) => recipe.id === 'bhote-koshi-nepal-scene'));
});

test('Bhote Koshi publishes the evidence spine once and scrubs through cards and breadcrumbs', async () => {
  const event = JSON.parse(await readFile(eventUrl, 'utf8'));
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const { body } = installEventDom();
  globalThis.window = { setTimeout: () => 71, clearTimeout() {} };
  const viewer = eventViewer();
  const publications = [];
  const layer = createBhoteKoshiEventLayer({
    eventLoader: async () => event,
    imageryProviderFactory: async (url) => ({ url }),
    terrainSampler: async (_viewer, observations) => (
      observations.map((observation) => ({ height: observation.fallbackElevationM }))
    ),
    mediaLoader: async () => {
      const error = new Error('fixture media intentionally unavailable');
      error.name = 'AbortError';
      throw error;
    },
    evidenceFrameFactory: (observation) => ({ fixture: observation.id }),
    overlayHost: {
      setEntries(id, entries, options) { publications.push({ id, entries, options }); },
      setVisible() {},
      clearSource() {},
    },
    renderHost: { request() {}, hold() {}, release() {} },
  });
  layer.attachMapStackController({
    getActiveId: () => 'esri-imagery',
    getSwitchGeneration: () => 1,
    async setStack() {},
  });

  try {
    await layer.enable(viewer, { origin: 'local-restore' });
    assert.equal(publications.length, 1);
    assert.equal(publications[0].entries.length, 32);
    const cards = publications[0].entries.filter((entry) => entry.variant === 'thumbnail');
    const breadcrumbs = publications[0].entries.filter((entry) => entry.variant === 'label');
    assert.equal(cards.filter((entry) => entry.position()).length, 1);
    assert.match(cards.find((entry) => entry.position()).id, /immediate-collapse/);
    assert.equal(breadcrumbs.filter((entry) => entry.position()).length, 0);
    assert.ok(cards.every((entry) => entry.requireImage && entry.image.stamp === 1));

    const panel = body.children.find((element) => element.tagName === 'aside');
    const progress = panel.querySelector('[data-role="progress"]');
    progress.value = '285';
    progress.dispatch('input');

    assert.equal(publications.length, 1);
    assert.equal(cards.filter((entry) => entry.position()).length, 1);
    assert.match(cards.find((entry) => entry.position()).id, /timure-cluster/);
    assert.equal(breadcrumbs.filter((entry) => entry.position()).length, 4);
    await layer.disable();
  } finally {
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
  }
});

test('Bhote Koshi keeps one local fallback video active and unloads it on beat change and disable', async () => {
  const event = JSON.parse(await readFile(eventUrl, 'utf8'));
  // Synthetic clips exercise the player; public event data never bundles these.
  event.evidenceSpine.find(({ id }) => id === 'immediate-collapse-viewpoint').media.videoPath = 'evidence-01.mp4';
  event.evidenceSpine.find(({ id }) => id === 'timure-cluster').media.videoPath = 'evidence-04.mp4';
  event.evidenceSpine.find(({ id }) => id === 'immediate-collapse-viewpoint').media.sourceUrl =
    'https://example.com/immediate-collapse';
  event.evidenceSpine.find(({ id }) => id === 'timure-cluster').media.sourceUrl =
    'https://example.com/timure';
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const { body } = installEventDom();
  globalThis.window = { setTimeout: () => 71, clearTimeout() {} };
  const viewer = eventViewer();
  const videos = [];
  const videoFactory = () => {
    const listeners = new Map();
    const video = {
      muted: false,
      playsInline: false,
      preload: '',
      loop: false,
      paused: true,
      currentTime: 0,
      duration: 10,
      playbackRate: 1,
      pauseCalls: 0,
      playCalls: 0,
      loadCalls: 0,
      removedSources: 0,
      addEventListener(type, handler) { listeners.set(type, handler); },
      load() { this.loadCalls += 1; },
      pause() { this.pauseCalls += 1; this.paused = true; },
      play() { this.playCalls += 1; this.paused = false; return Promise.resolve(); },
      removeAttribute(name) {
        if (name === 'src') {
          this.src = '';
          this.removedSources += 1;
        }
      },
      dispatch(type) { listeners.get(type)?.(); },
    };
    videos.push(video);
    return video;
  };
  const layer = createBhoteKoshiEventLayer({
    eventLoader: async () => event,
    imageryProviderFactory: async (url) => ({ url }),
    terrainSampler: async (_viewer, observations) => (
      observations.map((observation) => ({ height: observation.fallbackElevationM }))
    ),
    mediaLoader: async () => {
      const error = new Error('fixture media intentionally unavailable');
      error.name = 'AbortError';
      throw error;
    },
    evidenceFrameFactory: (observation) => ({ fixture: observation.id }),
    evidenceFrameUpdater: () => true,
    videoFactory,
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
    renderHost: { request() {}, hold() {}, release() {} },
  });
  layer.attachMapStackController({
    getActiveId: () => 'esri-imagery',
    getSwitchGeneration: () => 1,
    async setStack() {},
  });

  try {
    await layer.enable(viewer, { origin: 'local-restore' });
    assert.equal(videos.length, 1);
    assert.match(videos[0].src, /evidence-01\.mp4$/);
    videos[0].dispatch('loadeddata');
    assert.equal(layer.getCinematicState().mediaReady, true);

    const panel = body.children.find((element) => element.tagName === 'aside');
    const progress = panel.querySelector('[data-role="progress"]');
    progress.value = '285';
    progress.dispatch('input');

    assert.equal(videos.length, 2, 'the new beat replaces rather than stacks a decoder');
    assert.equal(videos[0].removedSources, 1);
    assert.ok(videos[0].pauseCalls >= 1);
    assert.match(videos[1].src, /evidence-04\.mp4$/);

    await layer.disable();
    assert.equal(videos[1].removedSources, 1);
    assert.ok(videos[1].pauseCalls >= 1);
    assert.equal(layer.getCinematicState().mediaEvidenceId, null);
  } finally {
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
  }
});

test('Upper Valley Collapse autoplays its muted local fallback without starting the event clock', async () => {
  const event = JSON.parse(await readFile(eventUrl, 'utf8'));
  event.evidenceSpine.find(({ id }) => id === 'immediate-collapse-viewpoint').media.videoPath = 'evidence-01.mp4';
  event.evidenceSpine.find(({ id }) => id === 'immediate-collapse-viewpoint').media.sourceUrl =
    'https://example.com/immediate-collapse';
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const { body } = installEventDom();
  globalThis.window = { setTimeout: () => 71, clearTimeout() {} };
  const viewer = eventViewer();
  const videos = [];
  let frameUpdates = 0;
  const videoFactory = () => {
    const listeners = new Map();
    const frameCallbacks = new Map();
    const video = {
      muted: false,
      playsInline: false,
      preload: '',
      loop: false,
      paused: true,
      currentTime: 0,
      duration: 8.6,
      playbackRate: 1,
      playCalls: 0,
      pauseCalls: 0,
      cancelledFrameHandles: [],
      addEventListener(type, handler) { listeners.set(type, handler); },
      load() {},
      pause() { this.pauseCalls += 1; this.paused = true; },
      play() { this.playCalls += 1; this.paused = false; return Promise.resolve(); },
      removeAttribute(name) { if (name === 'src') this.src = ''; },
      requestVideoFrameCallback(callback) {
        const handle = frameCallbacks.size + 1;
        frameCallbacks.set(handle, callback);
        return handle;
      },
      cancelVideoFrameCallback(handle) {
        this.cancelledFrameHandles.push(handle);
        frameCallbacks.delete(handle);
      },
      dispatch(type) { listeners.get(type)?.(); },
      drawFrame(handle = [...frameCallbacks.keys()][0]) {
        const callback = frameCallbacks.get(handle);
        frameCallbacks.delete(handle);
        callback?.();
      },
    };
    videos.push(video);
    return video;
  };
  const layer = createBhoteKoshiEventLayer({
    eventLoader: async () => event,
    imageryProviderFactory: async (url) => ({ url }),
    terrainSampler: async (_viewer, observations) => (
      observations.map((observation) => ({ height: observation.fallbackElevationM }))
    ),
    mediaLoader: async () => {
      const error = new Error('fixture media intentionally unavailable');
      error.name = 'AbortError';
      throw error;
    },
    evidenceFrameFactory: (observation) => ({ fixture: observation.id }),
    evidenceFrameUpdater: () => { frameUpdates += 1; return true; },
    videoFactory,
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
    renderHost: { request() {}, hold() {}, release() {} },
  });
  layer.attachMapStackController({
    getActiveId: () => 'photoreal',
    getSwitchGeneration: () => 1,
    async setStack() {},
  });

  try {
    layer.setParams({
      presentation: 'scene-beat',
      sceneSurface: 'evidence-beat',
      sceneControls: { evidenceMediaAutoplay: true },
      beatId: 'immediate-collapse-viewpoint',
      beatReveal: 0.36,
    }, { origin: 'scene' });
    await layer.enable(viewer, { origin: 'scene' });
    assert.equal(videos.length, 1);
    const video = videos[0];
    assert.equal(video.muted, true);
    assert.equal(video.loop, true);
    assert.equal(video.playCalls, 0, 'play waits until decoded media is ready');
    video.dispatch('loadeddata');
    assert.equal(video.playCalls, 1);
    assert.equal(video.playbackRate, 1);
    assert.equal(layer.getPlaybackState().playing, false);
    const updatesBeforeFrame = frameUpdates;
    video.currentTime = 1.2;
    video.drawFrame();
    assert.ok(frameUpdates > updatesBeforeFrame, 'decoded frames repaint the anchored callout');

    layer.setParams({ presentation: 'scene-beat', progress: 0.2 }, { origin: 'scene' });
    assert.ok(video.pauseCalls >= 1);
    assert.ok(video.cancelledFrameHandles.length >= 1);
    assert.equal(layer.getCinematicState().mediaEvidenceId, null);
    assert.equal(body.children.find((element) => element.tagName === 'aside')?.removed, false);
    await layer.disable();
  } finally {
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
  }
});

test('Debris-Dammed Lake card opens its source and is armed for approved local video autoplay', async () => {
  const event = JSON.parse(await readFile(eventUrl, 'utf8'));
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  installEventDom();
  const opened = [];
  globalThis.window = {
    setTimeout: () => 71,
    clearTimeout() {},
    open(...args) {
      opened.push(args);
      return { opener: 'fixture' };
    },
  };
  const viewer = eventViewer();
  let activeCard = null;
  const layer = createBhoteKoshiEventLayer({
    eventLoader: async () => event,
    imageryProviderFactory: async (url) => ({ url }),
    terrainSampler: async (_viewer, observations) => (
      observations.map((observation) => ({ height: observation.fallbackElevationM }))
    ),
    mediaLoader: async () => {
      const error = new Error('fixture media intentionally unavailable');
      error.name = 'AbortError';
      throw error;
    },
    overlayHost: {
      setEntries(_id, entries) {
        activeCard = entries.find((entry) => entry.id === 'evidence-card-debris-dammed-lake');
      },
      setVisible() {},
      clearSource() {},
      hitTest(_x, _y, options) {
        if (!activeCard || options?.filter?.(activeCard) === false) return null;
        return { entry: activeCard };
      },
    },
    renderHost: { request() {}, hold() {}, release() {} },
  });
  layer.attachMapStackController({
    getActiveId: () => 'photoreal',
    getSwitchGeneration: () => 1,
    async setStack() {},
  });

  try {
    layer.setParams({
      presentation: 'scene-beat',
      sceneSurface: 'evidence-beat',
      sceneControls: { evidenceMediaAutoplay: true },
      beatId: 'debris-dammed-lake',
      beatReveal: 0.36,
    }, { origin: 'scene' });
    await layer.enable(viewer, { origin: 'scene' });
    const lease = claimPointer('draw');
    try {
      viewer._test.canvas.dispatch('click', { offsetX: 640, offsetY: 420 });
      assert.equal(opened.length, 0, 'drawing owns the pointer over evidence cards');
    } finally {
      releasePointer(lease);
    }
    viewer._test.canvas.dispatch('click', { offsetX: 640, offsetY: 420 });
    assert.deepEqual(opened, [[
      event.evidenceSpine[1].media.sourceUrl,
      '_blank',
      'noopener,noreferrer',
    ]]);
    assert.equal(opened.length, 1);
    await layer.disable();
    viewer._test.canvas.dispatch('click', { offsetX: 640, offsetY: 420 });
    assert.equal(opened.length, 1, 'disabled layer releases card click ownership');
  } finally {
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
  }
});

test('Nepal evidence shots resume the standalone callout and flood sequence from Border Gate', async () => {
  const event = JSON.parse(await readFile(eventUrl, 'utf8'));
  const timeline = buildEvidenceTimeline(event.evidenceSpine, event.reconstruction.corridor);
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const originalPerformance = globalThis.performance;
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  installEventDom();
  let now = 1000;
  let nextFrameId = 0;
  const frames = new Map();
  const cancelledFrames = [];
  globalThis.window = { setTimeout: () => 71, clearTimeout() {} };
  globalThis.performance = { now: () => now };
  globalThis.requestAnimationFrame = (callback) => {
    const id = ++nextFrameId;
    frames.set(id, callback);
    return id;
  };
  globalThis.cancelAnimationFrame = (id) => {
    cancelledFrames.push(id);
    frames.delete(id);
  };
  const viewer = eventViewer();
  let entries = [];
  const embeddedCalls = [];
  const holds = [];
  const releases = [];
  const layer = createBhoteKoshiEventLayer({
    eventLoader: async () => event,
    imageryProviderFactory: async (url) => ({ url }),
    terrainSampler: async (_viewer, observations) => (
      observations.map((observation) => ({ height: observation.fallbackElevationM }))
    ),
    mediaLoader: async () => {
      const error = new Error('fixture media intentionally unavailable');
      error.name = 'AbortError';
      throw error;
    },
    overlayHost: {
      setEntries(_id, published) { entries = published; },
      setVisible() {},
      clearSource() {},
    },
    renderHost: {
      request() {},
      hold(id) { holds.push(id); },
      release(id) { releases.push(id); },
    },
    embeddedMediaFactory: () => ({
      warm(options) {
        embeddedCalls.push(['warm', options?.observation?.id || null]);
        return Boolean(options?.observation);
      },
      show(options) {
        embeddedCalls.push(['show', options?.observation?.id || null]);
        return false;
      },
      hide() { embeddedCalls.push(['hide']); },
      destroy() {},
    }),
  });
  layer.attachMapStackController({
    getActiveId: () => 'photoreal',
    getSwitchGeneration: () => 1,
    async setStack() {},
  });
  const params = {
    presentation: 'scene-beat',
    sceneSurface: 'evidence-beat',
    beatId: 'gyirong-border-gate',
    beatReveal: 0.36,
    sceneControls: {
      evidenceSequence: true,
      evidenceSequenceDurationSec: 0.9,
      deferEvidenceUntilCameraSettled: true,
      evidenceRevealDurationSec: 0.9,
      cameraSettled: false,
    },
  };

  try {
    await layer.init(viewer);
    layer.setParams(params, { origin: 'scene' });
    await layer.enable(viewer, { origin: 'scene' });
    const card = entries.find(({ id }) => id === 'evidence-card-gyirong-border-gate');
    const flood = viewer._test.dataSources[0].entities.getById('bhote-koshi-flood-core');
    const surge = viewer._test.dataSources[0].entities.getById('bhote-koshi-surge-front');
    assert.equal(card.position(), null, 'the evidence card is absent during the camera flight');
    assert.equal(flood.show, false);
    assert.equal(surge.show, false);
    assert.ok(
      embeddedCalls.some(([action, id]) => action === 'warm' && id === 'gyirong-border-gate'),
      'the upcoming Border Gate provider player warms while the camera is travelling',
    );
    assert.equal(
      embeddedCalls.some(([action]) => action === 'show'),
      false,
      'warming does not expose or autoplay the embedded card before camera settle',
    );

    layer.setParams({
      ...params,
      sceneControls: { ...params.sceneControls, cameraSettled: true },
    }, { origin: 'scene' });
    assert.ok(
      embeddedCalls.some(([action, id]) => action === 'show' && id === 'gyirong-border-gate'),
      'camera settle promotes the warmed source into the visible callout',
    );
    assert.ok(card.position(), 'camera settle publishes the anchored card');
    assert.equal(card.sourceAlpha(), 0, 'the card starts from a hidden reveal state');
    assert.ok(holds.includes('bhote-koshi-scene-beat-reveal'));

    now = 1050;
    const earlyReveal = frames.get(Math.max(...frames.keys()));
    frames.delete(Math.max(...frames.keys()));
    earlyReveal(now);
    assert.ok(card.sourceAlpha() > 0 && card.sourceAlpha() < 1);
    assert.equal(flood.show, true, 'the amber corridor grows with the callout reveal');
    assert.equal(surge.show, true, 'the amber surge circle advances with the corridor');

    now = 1900;
    const finalFrameId = Math.max(...frames.keys());
    const finalFrame = frames.get(finalFrameId);
    frames.delete(finalFrameId);
    finalFrame(now);
    assert.equal(
      layer.getPlaybackState().progress,
      timeline.find(({ observation }) => observation.id === 'timure-cluster').activationProgress,
      'the Border Gate surge reaches the next evidence point',
    );
    assert.equal(card.sourceAlpha(), 0, 'the Border Gate card recedes at the next beat');
    assert.ok(releases.includes('bhote-koshi-scene-beat-reveal'));

    const timureBeat = timeline.find(({ observation }) => observation.id === 'timure-cluster');
    layer.setParams({
      presentation: 'scene-beat',
      sceneSurface: 'evidence-beat',
      beatId: 'timure-cluster',
      beatReveal: 0.36,
      sceneControls: {
        imageryComparison: true,
        evidenceSequence: true,
        evidenceSequenceDurationSec: 4,
      },
    }, { origin: 'scene' });
    const timureCard = entries.find(({ id }) => id === 'evidence-card-timure-cluster');
    assert.equal(layer.getPlaybackState().progress, timureBeat.activationProgress);
    assert.equal(timureCard.sourceAlpha(), 0, 'the next callout begins below its activation');

    now = 3900;
    const timureReveal = frames.get(Math.max(...frames.keys()));
    frames.delete(Math.max(...frames.keys()));
    timureReveal(now);
    assert.ok(timureCard.sourceAlpha() > 0, 'the Timure callout enters during its authored shot');

    now = 5900;
    const timureFinalId = Math.max(...frames.keys());
    const timureFinal = frames.get(timureFinalId);
    frames.delete(timureFinalId);
    timureFinal(now);
    assert.equal(layer.getPlaybackState().progress, timureBeat.deactivationProgress);
    assert.equal(timureCard.sourceAlpha(), 0);
    await layer.disable();
  } finally {
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
    globalThis.performance = originalPerformance;
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
  }
});

test('Bhote Koshi beat controls keep cards, flood, camera, and panel on the one clock', async () => {
  const event = JSON.parse(await readFile(eventUrl, 'utf8'));
  const timeline = buildEvidenceTimeline(event.evidenceSpine, event.reconstruction.corridor);
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const originalPerformance = globalThis.performance;
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  const { body } = installEventDom();
  const openedUrls = [];
  const cancelledFrames = [];
  globalThis.window = {
    setTimeout: () => 71,
    clearTimeout() {},
    open(url) {
      openedUrls.push(url);
      return { opener: 'fixture' };
    },
  };
  globalThis.performance = { now: () => 1000 };
  globalThis.requestAnimationFrame = () => 91;
  globalThis.cancelAnimationFrame = (id) => cancelledFrames.push(id);
  const viewer = eventViewer();
  const publications = [];
  const layer = createBhoteKoshiEventLayer({
    eventLoader: async () => event,
    imageryProviderFactory: async (url) => ({ url }),
    terrainSampler: async (_viewer, observations) => (
      observations.map((observation) => ({ height: observation.fallbackElevationM }))
    ),
    mediaLoader: async () => {
      const error = new Error('fixture media intentionally unavailable');
      error.name = 'AbortError';
      throw error;
    },
    evidenceFrameFactory: (observation) => ({ fixture: observation.id }),
    overlayHost: {
      setEntries(id, entries, options) { publications.push({ id, entries, options }); },
      setVisible() {},
      clearSource() {},
    },
    renderHost: { request() {}, hold() {}, release() {} },
  });
  layer.attachMapStackController({
    getActiveId: () => 'esri-imagery',
    getSwitchGeneration: () => 1,
    async setStack() {},
  });

  try {
    await layer.enable(viewer, { origin: 'local-restore' });
    const panel = body.children.find((element) => element.tagName === 'aside');
    assert.match(panel.innerHTML, /2021 HISTORICAL REFERENCE \/ 2026 POST-EVENT/);
    assert.match(panel.innerHTML, /RECONSTRUCTION CLOCK/);
    assert.match(panel.innerHTML, /OPEN PUBLIC MAP/);
    const entries = publications[0].entries;
    const cards = entries.filter((entry) => entry.variant === 'thumbnail');
    const breadcrumbs = entries.filter((entry) => entry.variant === 'label');
    const next = panel.querySelector('[data-action="next-beat"]');
    const previous = panel.querySelector('[data-action="previous-beat"]');

    next.dispatch('click');
    assert.equal(layer.getPlaybackState().progress, timeline[1].activationProgress);
    assert.equal(layer.getPlaybackState().playing, false);
    assert.equal(layer.getCinematicState().active, true);
    assert.match(cards.find((entry) => entry.position()).id, /debris-dammed-lake/);
    assert.equal(breadcrumbs.filter((entry) => entry.position()).length, 1);
    assert.equal(panel.querySelector('[data-role="beat-index"]').textContent, '02 / 16');
    assert.equal(panel.querySelector('[data-role="beat-title"]').textContent, 'Dammed lake');

    next.dispatch('click');
    next.dispatch('click');
    next.dispatch('click');
    assert.equal(layer.getPlaybackState().progress, timeline[4].activationProgress);
    assert.equal(layer.getCinematicState().evidenceId, 'timure-cluster');
    assert.match(cards.find((entry) => entry.position()).id, /timure-cluster/);
    assert.equal(breadcrumbs.filter((entry) => entry.position()).length, 4);
    assert.equal(
      panel.querySelector('[data-role="beat-meta"]').textContent,
      'PROPAGATION / TIME UNVERIFIED / 5 SOURCES',
    );
    const flood = viewer._test.dataSources[0].entities.getById('bhote-koshi-flood-core');
    assert.ok(flood.polyline.positions.getValue().length > 1);
    assert.equal(
      body.children.some((element) => element.id === 'bhote-koshi-story-strap'),
      false,
    );
    panel.querySelector('[data-action="open-source"]').dispatch('click');
    assert.deepEqual(openedUrls, [timeline[4].observation.media.sourceUrl]);
    panel.querySelector('[data-action="geolocation-map"]').dispatch('click');
    assert.deepEqual(openedUrls, [
      timeline[4].observation.media.sourceUrl,
      event.geolocationMap.sourceUrl,
    ]);

    previous.dispatch('click');
    assert.equal(layer.getPlaybackState().progress, timeline[3].activationProgress);
    assert.equal(layer.getCinematicState().evidenceId, 'gyirong-border-gate');
    assert.equal(panel.querySelector('[data-role="beat-index"]').textContent, '04 / 16');
    assert.equal(publications.length, 1, 'beat navigation never republishes overlay entries');

    viewer._test.canvas.dispatch('pointerdown');
    assert.equal(layer.getCinematicState().active, false);
    const cameraLookCount = viewer._test.cameraLooks.length;
    const progress = panel.querySelector('[data-role="progress"]');
    progress.value = '500';
    progress.dispatch('input');
    assert.equal(layer.getCinematicState().active, false, 'manual release survives slider changes');
    assert.equal(viewer._test.cameraLooks.length, cameraLookCount);

    previous.dispatch('click');
    assert.equal(layer.getCinematicState().active, true, 'explicit beat navigation reclaims camera');
    assert.equal(layer.getCinematicState().evidenceId, 'dhunche');
    panel.querySelector('[data-action="story-replay"]').dispatch('click');
    assert.equal(layer.getPlaybackState().progress, 0);
    assert.equal(layer.getPlaybackState().playing, true);
    assert.equal(layer.getCinematicState().active, true);
    assert.equal(layer.getCinematicState().evidenceId, 'immediate-collapse-viewpoint');
    assert.equal(panel.querySelector('[data-role="beat-index"]').textContent, '01 / 16');
    assert.equal(publications.length, 1);

    await layer.disable();
    assert.deepEqual(cancelledFrames, [91]);
    assert.equal(viewer._test.canvas._listeners.size, 0);
  } finally {
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
    globalThis.performance = originalPerformance;
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
  }
});

test('Bhote Koshi repeated event frames perform no panel lookup, DOM write, or camera churn', async () => {
  const event = JSON.parse(await readFile(eventUrl, 'utf8'));
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const originalPerformance = globalThis.performance;
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  const { body } = installEventDom();
  globalThis.window = { setTimeout: () => 71, clearTimeout() {} };
  globalThis.performance = { now: () => 1000 };
  globalThis.requestAnimationFrame = () => 93;
  globalThis.cancelAnimationFrame = () => {};
  const viewer = eventViewer();
  const layer = createBhoteKoshiEventLayer({
    eventLoader: async () => event,
    imageryProviderFactory: async (url) => ({ url }),
    terrainSampler: async (_viewer, observations) => (
      observations.map((observation) => ({ height: observation.fallbackElevationM }))
    ),
    mediaLoader: async () => {
      const error = new Error('fixture media intentionally unavailable');
      error.name = 'AbortError';
      throw error;
    },
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
    renderHost: { request() {}, hold() {}, release() {} },
  });
  layer.attachMapStackController({
    getActiveId: () => 'esri-imagery',
    getSwitchGeneration: () => 1,
    async setStack() {},
  });

  try {
    await layer.enable(viewer, { origin: 'local-restore' });
    const panel = body.children.find((element) => element.tagName === 'aside');
    const cinematic = panel.querySelector('[data-action="cinematic"]');
    const progress = panel.querySelector('[data-role="progress"]');
    cinematic.dispatch('click');
    progress.value = '500';
    progress.dispatch('input');

    const queryCount = panel._queryCount;
    const writeCount = [...panel._selectors.values()].reduce((sum, element) => (
      sum + element._writeCount
    ), 0);
    const cameraLookCount = viewer._test.cameraLooks.length;
    for (let index = 0; index < 20; index += 1) progress.dispatch('input');

    assert.equal(panel._queryCount, queryCount, 'hot path uses cached panel references');
    assert.equal(
      [...panel._selectors.values()].reduce((sum, element) => sum + element._writeCount, 0),
      writeCount,
      'unchanged frames do not rewrite panel state',
    );
    assert.equal(
      viewer._test.cameraLooks.length,
      cameraLookCount,
      'unchanged progress does not reapply the cinematic camera object',
    );
    await layer.disable();
  } finally {
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
    globalThis.performance = originalPerformance;
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
  }
});

test('Bhote Koshi frame path keeps evidence lookup scalar and wrapper-free', async () => {
  const source = await readFile(eventModuleUrl, 'utf8');
  assert.doesNotMatch(source, /#ffd166/i, 'event UI no longer publishes the prototype yellow');
  assert.doesNotMatch(
    source,
    /function\s+activeEvidenceEntry\s*\(/,
    'the event frame path must not restore an object-returning evidence wrapper',
  );
  assert.doesNotMatch(
    source,
    /return\s*\{\s*(?:index\s*,\s*observation|observation\s*,\s*index)\s*\}/,
    'evidence lookup must not allocate an index/observation pair',
  );
  assert.match(
    source,
    /const beatIndex = currentEvidenceIndex\(\);\s*const sceneBeatIndex = sceneDirected\s*\? _evidenceTimeline\.findIndex\(\s*\(\{ observation: item \}\) => item\.id === _sceneBeatId,?\s*\)\s*:\s*beatIndex;\s*const observation =\s*_evidenceTimeline\[sceneBeatIndex\]\?\.observation \|\| null;/,
    'syncPanel must resolve authored scene beats to one scalar index before reading the observation',
  );
});

test('Bhote Koshi cinematic camera stays synchronized through pause and deterministic scrubbing', async () => {
  const event = JSON.parse(await readFile(eventUrl, 'utf8'));
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const originalPerformance = globalThis.performance;
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  const { body } = installEventDom();
  globalThis.window = { setTimeout: () => 71, clearTimeout() {} };
  globalThis.performance = { now: () => 1000 };
  globalThis.requestAnimationFrame = () => 33;
  globalThis.cancelAnimationFrame = () => {};
  const viewer = eventViewer();
  const layer = createBhoteKoshiEventLayer({
    eventLoader: async () => event,
    imageryProviderFactory: async (url) => ({ url }),
    terrainSampler: async (_viewer, observations) => (
      observations.map((observation) => ({ height: observation.fallbackElevationM }))
    ),
    mediaLoader: async () => {
      const error = new Error('fixture media intentionally unavailable');
      error.name = 'AbortError';
      throw error;
    },
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
    renderHost: { request() {}, hold() {}, release() {} },
  });
  layer.attachMapStackController({
    getActiveId: () => 'esri-imagery',
    getSwitchGeneration: () => 1,
    async setStack() {},
  });

  try {
    await layer.enable(viewer, { origin: 'local-restore' });
    const panel = body.children.find((element) => element.tagName === 'aside');
    panel.querySelector('[data-action="cinematic"]').dispatch('click');
    assert.equal(layer.getCinematicState().active, true);
    assert.equal(layer.getPlaybackState().playing, true);
    assert.equal(viewer._test.cameraLooks.length, 1);
    assert.equal(
      body.children.some((element) => element.id === 'bhote-koshi-story-strap'),
      false,
    );

    panel.querySelector('[data-action="play"]').dispatch('click');
    assert.equal(layer.getPlaybackState().playing, false);
    const progress = panel.querySelector('[data-role="progress"]');
    progress.value = '500';
    progress.dispatch('input');
    const firstPose = viewer._test.cameraLooks.at(-1);
    progress.dispatch('input');
    assert.deepEqual(viewer._test.cameraLooks.at(-1), firstPose);
    assert.deepEqual(layer.getCinematicState(), {
      active: true,
      progress: 0.5,
      evidenceId: 'mailung-upper-trishuli',
      mediaReady: false,
      mediaEvidenceId: null,
    });

    viewer._test.canvas.dispatch('pointerdown');
    assert.equal(layer.getCinematicState().active, false);
    assert.equal(viewer._test.cameraTransforms.length, 1);
    await layer.disable();
    assert.equal(viewer._test.canvas._listeners.size, 0);
  } finally {
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
    globalThis.performance = originalPerformance;
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
  }
});

test('Bhote Koshi replay restores cinematic ownership unless the operator released it', async () => {
  const event = JSON.parse(await readFile(eventUrl, 'utf8'));
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const originalPerformance = globalThis.performance;
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  const { body } = installEventDom();
  const animationCallbacks = [];
  const cancelledFrames = [];
  const releases = [];
  globalThis.window = { setTimeout: () => 71, clearTimeout() {} };
  globalThis.performance = { now: () => 1000 };
  globalThis.requestAnimationFrame = (callback) => {
    animationCallbacks.push(callback);
    return animationCallbacks.length;
  };
  globalThis.cancelAnimationFrame = (id) => cancelledFrames.push(id);
  const viewer = eventViewer();
  const layer = createBhoteKoshiEventLayer({
    eventLoader: async () => event,
    imageryProviderFactory: async (url) => ({ url }),
    terrainSampler: async (_viewer, observations) => (
      observations.map((observation) => ({ height: observation.fallbackElevationM }))
    ),
    mediaLoader: async () => {
      const error = new Error('fixture media intentionally unavailable');
      error.name = 'AbortError';
      throw error;
    },
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
    renderHost: {
      request() {},
      hold() {},
      release(id) { releases.push(id); },
    },
  });
  layer.attachMapStackController({
    getActiveId: () => 'esri-imagery',
    getSwitchGeneration: () => 1,
    async setStack() {},
  });

  try {
    await layer.enable(viewer, { origin: 'local-restore' });
    const panel = body.children.find((element) => element.tagName === 'aside');
    panel.querySelector('[data-action="cinematic"]').dispatch('click');
    animationCallbacks[0](91001);
    assert.equal(layer.getPlaybackState().progress, 1);
    assert.equal(layer.getPlaybackState().playing, false);
    assert.equal(layer.getCinematicState().active, false);
    assert.equal(viewer._test.cameraTransforms.length, 1);
    assert.deepEqual(releases, ['bhote-koshi-playback']);
    const play = panel.querySelector('[data-action="play"]');
    assert.equal(play.textContent, '↺ REPLAY CINEMATIC');

    play.dispatch('click');
    assert.equal(layer.getCinematicState().active, true);
    assert.equal(layer.getPlaybackState().progress, 0);
    assert.equal(layer.getPlaybackState().playing, true);
    assert.equal(
      body.children.some((element) => element.id === 'bhote-koshi-story-strap'),
      false,
    );

    panel.querySelector('[data-action="cinematic"]').dispatch('click');
    assert.equal(layer.getCinematicState().active, false);
    assert.equal(viewer._test.cameraTransforms.length, 2);
    animationCallbacks[1](91001);
    assert.equal(play.textContent, '↺ REPLAY');
    const cameraLookCount = viewer._test.cameraLooks.length;
    play.dispatch('click');
    assert.equal(layer.getPlaybackState().playing, true);
    assert.equal(layer.getCinematicState().active, false);
    assert.equal(viewer._test.cameraLooks.length, cameraLookCount);

    await layer.disable();
    assert.equal(layer.getCinematicState().active, false);
    assert.equal(viewer._test.cameraTransforms.length, 2);
    assert.deepEqual(cancelledFrames, [1, 2, 3]);
    assert.equal(viewer._test.canvas._listeners.size, 0);
  } finally {
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
    globalThis.performance = originalPerformance;
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
  }
});

test('Bhote Koshi closes a poster that resolves after disable', async () => {
  const event = JSON.parse(await readFile(eventUrl, 'utf8'));
  event.evidenceSpine = event.evidenceSpine.slice(0, 1);
  event.evidenceSpine[0].media.posterPath = 'evidence-09.jpg';
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  installEventDom();
  globalThis.window = { setTimeout: () => 71, clearTimeout() {} };
  const viewer = eventViewer();
  let resolvePoster;
  const poster = { closed: false, close() { this.closed = true; } };
  const layer = createBhoteKoshiEventLayer({
    eventLoader: async () => event,
    imageryProviderFactory: async (url) => ({ url }),
    terrainSampler: async () => [{ height: 2800 }],
    mediaLoader: async (url) => {
      assert.equal(url, '/events/bhote-koshi-2026/evidence-09.jpg');
      return new Promise((resolve) => { resolvePoster = resolve; });
    },
    evidenceFrameFactory: (observation) => ({ fixture: observation.id }),
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
    renderHost: { request() {}, hold() {}, release() {} },
  });
  layer.attachMapStackController({
    getActiveId: () => 'esri-imagery',
    getSwitchGeneration: () => 1,
    async setStack() {},
  });

  try {
    await layer.enable(viewer, { origin: 'local-restore' });
    await layer.disable();
    resolvePoster(poster);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(poster.closed, true);
  } finally {
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
  }
});

test('every sourced shot grows its tail with its head, keeps its own card, and clears on exit', async () => {
  const event = JSON.parse(await readFile(eventUrl, 'utf8'));
  const originals = Object.fromEntries(['document', 'window', 'performance', 'requestAnimationFrame', 'cancelAnimationFrame']
    .map((key) => [key, globalThis[key]]));
  installEventDom();
  let now = 1000;
  let nextFrame = 0;
  const frames = new Map();
  globalThis.window = { setTimeout: () => 71, clearTimeout() {} };
  globalThis.performance = { now: () => now };
  globalThis.requestAnimationFrame = (callback) => { frames.set(++nextFrame, callback); return nextFrame; };
  globalThis.cancelAnimationFrame = (id) => frames.delete(id);
  const viewer = eventViewer();
  let heightSamples = 0;
  viewer.scene.sampleHeight = () => { heightSamples++; return 1500; };
  let entries = [];
  const layer = createBhoteKoshiEventLayer({
    eventLoader: async () => event,
    imageryProviderFactory: async (url) => ({ url }),
    terrainSampler: async () => null,
    mediaLoader: async () => { throw Object.assign(new Error('fixture'), { name: 'AbortError' }); },
    overlayHost: { setEntries(_id, value) { entries = value; }, setVisible() {}, clearSource() {} },
    renderHost: { request() {}, hold() {}, release() {} },
  });
  layer.attachMapStackController({ getActiveId: () => 'photoreal', getSwitchGeneration: () => 1 });
  const params = (beatId, cameraSettled, evidencePath = 'source', evidencePathElevation = null) => ({
    presentation: 'scene-beat', sceneSurface: 'evidence-beat', beatId,
    sceneControls: { cameraSettled, evidencePath, evidencePathElevation, evidencePathDurationSec: 4,
      deferEvidenceUntilCameraSettled: true, evidenceHoldCard: true },
  });
  const advance = (elapsed) => {
    const callback = frames.get(nextFrame);
    frames.delete(nextFrame);
    callback(now + elapsed);
  };
  try {
    layer.setParams(params(SOURCE_PATH_BEAT_IDS[0], false));
    await layer.enable(viewer, { origin: 'scene' });
    const source = viewer._test.dataSources.at(-1);
    const flood = source.entities.getById('bhote-koshi-flood-core');
    const surge = source.entities.getById('bhote-koshi-surge-front');
    for (const id of SOURCE_PATH_BEAT_IDS) {
      layer.setParams(params(id, false));
      assert.equal(flood.show, false, `${id}: hide the previous route during flight`);
      assert.equal(surge.show, false);
      layer.setParams(params(id, true));
      const sampleCount = heightSamples;
      let previousLength = 0;
      for (const elapsed of [400, 1800, 4000]) {
        advance(elapsed);
        const points = flood.polyline.positions.getValue();
        assert.ok(points.length >= previousLength);
        assert.equal(flood.show, true);
        assert.equal(surge.show, true);
        assert.ok(Cesium.Cartesian3.equals(points.at(-1), surge.position.getValue()), `${id}: tail must reach head in every frame`);
        previousLength = points.length;
      }
      assert.equal(heightSamples, sampleCount, 'do not resample geometry during motion');
      const visibleCards = entries.filter((entry) => entry.id.startsWith('evidence-card-') && entry.position());
      assert.deepEqual(visibleCards.map(({ id: cardId }) => cardId), [`evidence-card-${id}`]);
      assert.ok(visibleCards[0].sourceAlpha() > 0, 'keep the source readable after the path settles');
      now += 5000;
    }
    // A settled-to-settled entry must not paint the last shot's completed
    // progress on the new route for a frame, then jump back to its start.
    layer.setParams(params('dhunche', true));
    assert.equal(flood.show, false, 'new shot clears its tail before the first animation frame');
    assert.equal(surge.show, false);
    advance(1800);
    const headBeforeSync = Cesium.Cartesian3.clone(surge.position.getValue());
    const frameBeforeSync = nextFrame;
    layer.setParams(params('dhunche', true));
    assert.equal(nextFrame, frameBeforeSync, 'repeated settled notification does not restart the reveal');
    assert.ok(Cesium.Cartesian3.equals(headBeforeSync, surge.position.getValue()));
    advance(2200);
    assert.ok(!Cesium.Cartesian3.equals(headBeforeSync, surge.position.getValue()));
    // The comparison exit can expose coarse photogrammetry samples a kilometre
    // above the river. Dhunche's schematic profile must not dive through them.
    viewer.scene.sampleHeight = () => { heightSamples++; return 2703; };
    viewer.scene.globe = { getHeight: () => 0 };
    layer.setParams(params('dhunche', false, 'source', 'source'));
    const samplesBeforeProfile = heightSamples;
    layer.setParams(params('dhunche', true, 'source', 'source'));
    for (const elapsed of [40, 400, 1800, 4000]) {
      advance(elapsed);
      const points = flood.polyline.positions.getValue();
      for (const position of points) {
        const height = Cesium.Cartographic.fromCartesian(position).height;
        assert.ok(height >= 1307 && height <= 1332, `source profile stays near river elevation, got ${height}`);
      }
      assert.ok(Cesium.Cartesian3.equals(points.at(-1), surge.position.getValue()));
    }
    assert.equal(heightSamples, samplesBeforeProfile, 'source elevation does not sample the changing mesh');
    layer.setParams(params('charaudi', false, 'none'));
    layer.setParams(params('charaudi', true, 'none'));
    advance(1000);
    assert.equal(flood.show, false);
    assert.equal(surge.show, false);
    await layer.disable();
    assert.equal(frames.size, 0);
  } finally {
    for (const [key, value] of Object.entries(originals)) globalThis[key] = value;
  }
});

test('media-led upper-valley shots retain only their upstream prefix during camera travel', async () => {
  const event = JSON.parse(await readFile(eventUrl, 'utf8'));
  const originals = Object.fromEntries(['document', 'window', 'performance', 'requestAnimationFrame', 'cancelAnimationFrame']
    .map((key) => [key, globalThis[key]]));
  installEventDom();
  let now = 1000;
  let nextFrame = 0;
  const frames = new Map();
  globalThis.window = { setTimeout: () => 71, clearTimeout() {} };
  globalThis.performance = { now: () => now };
  globalThis.requestAnimationFrame = callback => { frames.set(++nextFrame, callback); return nextFrame; };
  globalThis.cancelAnimationFrame = id => frames.delete(id);
  const viewer = eventViewer();
  const layer = createBhoteKoshiEventLayer({
    eventLoader: async () => event,
    imageryProviderFactory: async url => ({ url }),
    terrainSampler: async () => null,
    mediaLoader: async () => { throw Object.assign(new Error('fixture'), { name: 'AbortError' }); },
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
    renderHost: { request() {}, hold() {}, release() {} },
  });
  layer.attachMapStackController({ getActiveId: () => 'esri-imagery', getSwitchGeneration: () => 1 });
  const params = (beatId, cameraSettled, extras = {}) => ({
    presentation: 'scene-beat', sceneSurface: 'evidence-beat', beatId,
    sceneControls: {
      evidencePath: 'source', evidencePathHistory: true, evidencePathPersistent: true,
      evidencePathDuringMedia: true, evidencePathDurationSec: 4.8,
      deferEvidenceUntilCameraSettled: true, evidenceHoldCard: true,
      cameraSettled, ...extras,
    },
  });
  const finishReveal = () => {
    now += 7000;
    const callback = frames.get(nextFrame);
    frames.delete(nextFrame);
    callback(now);
  };
  try {
    layer.setParams(params('debris-dammed-lake', false));
    await layer.enable(viewer, { origin: 'scene' });
    const source = viewer._test.dataSources.at(-1);
    const flood = source.entities.getById('bhote-koshi-flood-core');
    const surge = source.entities.getById('bhote-koshi-surge-front');
    layer.setParams(params('debris-dammed-lake', true));
    finishReveal();
    const lakeTail = flood.polyline.positions.getValue().map(point => Cesium.Cartesian3.clone(point));
    assert.ok(lakeTail.length > 1);
    const origin = Cesium.Cartographic.fromCartesian(lakeTail[0]);
    assert.ok(Math.abs(Cesium.Math.toDegrees(origin.longitude) - 85.48476) < 1e-6);
    assert.ok(Math.abs(Cesium.Math.toDegrees(origin.latitude) - 28.33255) < 1e-6,
      'the rendered trail starts at the lake reach, not the earlier trigger reach');
    layer.setParams(params('second-landslide', false));
    assert.equal(flood.show, true, 'lake trail survives departure before the next camera settles');
    assert.deepEqual(flood.polyline.positions.getValue(), lakeTail, 'retain the prefix without revealing the next segment');
    assert.ok(Cesium.Cartesian3.equals(surge.position.getValue(), lakeTail.at(-1)));
    layer.setParams(params('second-landslide', true));
    assert.deepEqual(flood.polyline.positions.getValue(), lakeTail, 'arrival does not clear the prefix');
    finishReveal();
    assert.ok(flood.polyline.positions.getValue().length > lakeTail.length);
    layer.setParams(params('debris-dammed-lake', false));
    assert.equal(flood.show, false, 'backward replay trims future segments instead of retaining stale history');
    layer.setParams(params('second-landslide', false));
    assert.deepEqual(flood.polyline.positions.getValue(), lakeTail, 'direct load reconstructs the same prefix');
    layer.setParams(params('second-landslide', false, { evidencePathPersistent: false }));
    assert.equal(flood.show, false, 'nonpersistent shots retain their arrival gate');
    for (const beatId of ['devighat-taadi-khola-bridge', 'charaudi', 'final-view']) {
      const historyControls = {
        evidencePath: 'history', evidencePathHistoryBeatId: SOURCE_PATH_BEAT_IDS.at(-1),
        evidencePathDuringMedia: false, evidenceMediaAutoplay: beatId !== 'final-view',
      };
      layer.setParams(params(beatId, false, historyControls));
      const completedTail = [...flood.polyline.positions.getValue()];
      assert.ok(completedTail.length > 100, `${beatId}: direct load reconstructs full sourced history`);
      layer.setParams(params(beatId, true, historyControls));
      assert.deepEqual(flood.polyline.positions.getValue(), completedTail,
        `${beatId}: arrival must not reset the completed history`);
      finishReveal();
      assert.deepEqual(flood.polyline.positions.getValue(), completedTail,
        `${beatId}: media/card reveal must not erase or regrow completed history`);
    }
    await layer.disable();
    assert.equal(frames.size, 0);
  } finally {
    for (const [key, value] of Object.entries(originals)) globalThis[key] = value;
  }
});

test('camera-led Nepal flood motion preserves its prefix and stays ahead of shot travel', async () => {
  const event = JSON.parse(await readFile(eventUrl, 'utf8'));
  const originals = Object.fromEntries(['document', 'window', 'performance', 'requestAnimationFrame', 'cancelAnimationFrame']
    .map((key) => [key, globalThis[key]]));
  installEventDom();
  let now = 1000;
  let nextFrame = 0;
  let nextTimer = 0;
  const frames = new Map();
  const timers = new Map();
  const holds = [];
  const releases = [];
  globalThis.window = {
    setTimeout(callback, delay) {
      const id = ++nextTimer;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
  };
  globalThis.performance = { now: () => now };
  globalThis.requestAnimationFrame = (callback) => { frames.set(++nextFrame, callback); return nextFrame; };
  globalThis.cancelAnimationFrame = (id) => frames.delete(id);
  const viewer = eventViewer();
  const layer = createBhoteKoshiEventLayer({
    eventLoader: async () => event,
    imageryProviderFactory: async (url) => ({ url }),
    terrainSampler: async () => null,
    mediaLoader: async () => { throw Object.assign(new Error('fixture'), { name: 'AbortError' }); },
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
    renderHost: {
      request() {},
      hold(id) { holds.push(id); },
      release(id) { releases.push(id); },
    },
  });
  layer.attachMapStackController({ getActiveId: () => 'photoreal', getSwitchGeneration: () => 1 });
  const travel = (id, durationSec = 4.2, overrides = {}) => ({
    id, durationSec, active: true, completed: false, cancelled: false, ...overrides,
  });
  const params = (beatId, evidencePath, cameraTravel, extras = {}) => ({
    presentation: 'scene-beat',
    sceneSurface: 'evidence-beat',
    beatId,
    sceneControls: {
      evidencePath,
      evidencePathDuringCamera: true,
      evidencePathPersistent: true,
      deferEvidenceUntilCameraSettled: true,
      cameraSettled: false,
      cameraTravel,
      ...extras,
    },
  });
  const advance = (elapsed) => {
    now += elapsed;
    const id = Math.max(...frames.keys());
    const callback = frames.get(id);
    frames.delete(id);
    assert.equal(typeof callback, 'function');
    callback(now);
  };

  try {
    layer.setParams(params('timure-cluster', 'comparison', travel(1), {
      evidenceSequence: true,
    }));
    await layer.enable(viewer, { origin: 'scene' });
    let source = viewer._test.dataSources.at(-1);
    let flood = source.entities.getById('bhote-koshi-flood-core');
    let surge = source.entities.getById('bhote-koshi-surge-front');
    const timureStart = flood.polyline.positions.getValue().length;
    assert.ok(timureStart > 1, 'the completed Border Gate prefix is already visible during travel');
    assert.equal(surge.show, true);
    advance(420);
    const earlyTimureLength = flood.polyline.positions.getValue().length;
    assert.ok(earlyTimureLength > timureStart,
      'the trail leads during the opening tenth of camera travel instead of waiting for arrival');
    advance(2880);
    const timureEnd = flood.polyline.positions.getValue().length;
    assert.ok(timureEnd > timureStart);
    assert.equal(flood.show, true, 'the completed tail remains visible at the next point');
    assert.ok(Cesium.Cartesian3.equals(flood.polyline.positions.getValue().at(-1), surge.position.getValue()));

    layer.setParams(params('syabru-besi', 'comparison', travel(2), {
      evidenceSequence: true,
    }));
    assert.ok(flood.polyline.positions.getValue().length >= timureEnd,
      'the Timure segment remains painted when Syabru travel starts');
    advance(3300);
    assert.equal(surge.show, true, 'the amber head remains visible at comparison completion');
    assert.ok(Cesium.Cartesian3.equals(flood.polyline.positions.getValue().at(-1), surge.position.getValue()));

    layer.setParams(params('dhunche', 'source', travel(3), {
      evidencePathHistory: true,
      evidencePathElevation: 'source',
      evidenceHoldCard: true,
    }));
    source = viewer._test.dataSources.at(-1);
    flood = source.entities.getById('bhote-koshi-flood-core');
    surge = source.entities.getById('bhote-koshi-surge-front');
    const dhuncheStart = flood.polyline.positions.getValue().length;
    assert.ok(dhuncheStart >= event.reconstruction.corridor.length,
      'the comparison corridor survives the transition onto Google photogrammetry');
    advance(3300);
    const dhuncheEnd = flood.polyline.positions.getValue().length;
    assert.ok(dhuncheEnd > dhuncheStart);
    assert.equal(surge.show, true);

    layer.setParams(params('mailung-upper-trishuli', 'source', travel(4), {
      evidencePathHistory: true,
      evidencePathElevation: 'source',
      evidenceHoldCard: true,
    }));
    assert.ok(flood.polyline.positions.getValue().length >= dhuncheEnd,
      'the completed Dhunche segment never disappears');
    advance(900);
    const frozenHead = Cesium.Cartesian3.clone(surge.position.getValue());
    const frozenLength = flood.polyline.positions.getValue().length;
    layer.setParams(params('mailung-upper-trishuli', 'source', travel(4, 4.2, {
      active: false, cancelled: true,
    }), {
      evidencePathHistory: true,
      evidencePathElevation: 'source',
      evidenceHoldCard: true,
    }));
    assert.equal(frames.size, 0, 'cancelling camera travel revokes the path animation frame');
    assert.equal(flood.polyline.positions.getValue().length, frozenLength);
    assert.ok(Cesium.Cartesian3.equals(surge.position.getValue(), frozenHead));
    assert.ok(holds.includes('bhote-koshi-scene-path-travel'));
    assert.ok(releases.includes('bhote-koshi-scene-path-travel'));

    let previousCompleteLength = dhuncheEnd;
    let travelId = 5;
    for (const beatId of SOURCE_PATH_BEAT_IDS.slice(3)) {
      layer.setParams(params(beatId, 'source', travel(travelId++), {
        evidencePathHistory: true,
        evidencePathElevation: 'source',
        evidenceHoldCard: true,
      }));
      const startLength = flood.polyline.positions.getValue().length;
      assert.ok(startLength >= previousCompleteLength,
        `${beatId} retains every completed upstream segment while travel begins`);
      advance(3300);
      const completeLength = flood.polyline.positions.getValue().length;
      assert.ok(completeLength > startLength, `${beatId} grows its own segment during travel`);
      assert.equal(flood.show, true);
      assert.equal(surge.show, true);
      assert.ok(Cesium.Cartesian3.equals(
        flood.polyline.positions.getValue().at(-1), surge.position.getValue(),
      ));
      previousCompleteLength = completeLength;
    }
    const bidurCompleteLength = previousCompleteLength;

    // Direct entry must reconstruct its supported prefix without relying on
    // earlier playback, while backward navigation must trim later segments.
    layer.setParams({
      presentation: 'scene-beat', sceneSurface: 'evidence-beat', beatId: 'devighat-taadi-khola-bridge',
      sceneControls: { evidencePath: 'none', deferEvidenceUntilCameraSettled: true, cameraSettled: false },
    });
    assert.equal(flood.show, false, 'Devighat does not leak the supported route');
    assert.equal(surge.show, false);
    layer.setParams(params('bidur-trishuli-bridge', 'source', travel(travelId++), {
      evidencePathHistory: true,
      evidencePathElevation: 'source',
      evidenceHoldCard: true,
    }));
    assert.ok(flood.polyline.positions.getValue().length > dhuncheEnd,
      'a direct Bidur load reconstructs its complete upstream prefix');
    advance(3300);
    assert.equal(flood.polyline.positions.getValue().length, bidurCompleteLength);

    layer.setParams(params('dhunche', 'source', travel(travelId++), {
      evidencePathHistory: true,
      evidencePathElevation: 'source',
      evidenceHoldCard: true,
    }));
    assert.ok(flood.polyline.positions.getValue().length < bidurCompleteLength,
      'backward navigation trims unsupported downstream history immediately');
    advance(3300);
    assert.equal(flood.polyline.positions.getValue().length, dhuncheEnd);

    // The deadline is independent of RAF, so a throttled render loop still
    // completes the active segment before the camera's longer flight ends.
    layer.setParams(params('mailung-upper-trishuli', 'source', travel(travelId++), {
      evidencePathHistory: true,
      evidencePathElevation: 'source',
      evidenceHoldCard: true,
    }));
    const deadlineEntry = [...timers.entries()].find(([, entry]) => entry.delay >= 2400);
    assert.ok(deadlineEntry, 'camera-led travel registers a pre-arrival completion deadline');
    now += deadlineEntry[1].delay;
    deadlineEntry[1].callback();
    assert.equal(frames.size, 0, 'the deadline cancels a stalled animation frame');
    assert.ok(flood.polyline.positions.getValue().length > dhuncheEnd);

    layer.setParams({
      presentation: 'scene-beat', sceneSurface: 'evidence-beat', beatId: 'charaudi',
      sceneControls: { evidencePath: 'none', deferEvidenceUntilCameraSettled: true, cameraSettled: false },
    });
    assert.equal(flood.show, false, 'unsupported downstream shots do not invent or leak a route');
    assert.equal(surge.show, false);
    await layer.disable();
  } finally {
    for (const [key, value] of Object.entries(originals)) globalThis[key] = value;
  }
});

test('Bhote Koshi corridor remains ordered downstream and inside the imagery rectangle', async () => {
  const event = JSON.parse(await readFile(eventUrl, 'utf8'));
  const { west, south, east, north } = event.imagery.rectangle;
  let priorChainage = Number.NEGATIVE_INFINITY;
  for (const point of event.reconstruction.corridor) {
    assert.ok(point.chainageM > priorChainage);
    assert.ok(point.lon >= west && point.lon <= east);
    assert.ok(point.lat >= south && point.lat <= north);
    priorChainage = point.chainageM;
  }
});
