import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createRadiosondesLayer } from './index.js';
import { createRadiosondeSource } from './source.js';
import { createRadiosondeRendering } from './rendering.js';
import { layerFeedState } from '../../data/feedState.js';
import { LayerLifecycle } from '../../data/lifecycle.js';
import { createCredits } from '../streetLevel/credits.js';
import * as policy from './policy.js';
import { createColdRadiosondeServer } from '../../testSupport/radiosondeColdServer.mjs';
import { isOverlayPointVisible } from '../../overlays/worldOverlay.js';
import { horizonOccluder } from '../../data/iconOrientation.js';
const start = 1_800_000_000_000;
const nextLaunch = 'Next launch window 11:00–12:00 UTC · in 3h';
const noneAloft = 'None aloft — launches are around 00:00 and 12:00 UTC';
const raw = (serial = 'TEST123', timeMs = start, altM = 10000) => ({
  serial,
  timeMs,
  receivedMs: timeMs,
  lat: 50,
  lon: 10,
  altM,
});
const snap = (frames = [raw()], upstream = 'live') => ({
  frames,
  upstream,
  lastFrameMs: frames.at(-1)?.receivedMs ?? start,
  stale: upstream !== 'live',
  fetchedAt: frames.at(-1)?.receivedMs ?? start,
});
const savedGlobals = new Map();
let spriteCanvasAllocations = 0;
test.before(() => {
  const prior = savedGlobals;
  for (const key of [
    'HTMLCanvasElement',
    'HTMLImageElement',
    'ImageBitmap',
    'OffscreenCanvas',
    'document',
    'window',
  ])
    prior.set(key, globalThis[key]);
  for (const key of [
    'HTMLCanvasElement',
    'HTMLImageElement',
    'ImageBitmap',
    'OffscreenCanvas',
  ])
    globalThis[key] = class {};
  globalThis.document = {
    documentElement: { dataset: {} },
    createElement() {
      spriteCanvasAllocations++;
      let fill = '';
      let alpha = 1;
      const operations = [];
      return {
        getContext() {
          return new Proxy(
            {},
            {
              get:
                (_target, key) =>
                (...args) =>
                  operations.push({ op: key, args }),
              set(target, key, value) {
                if (key === 'fillStyle') fill = value;
                if (key === 'globalAlpha') alpha = value;
                target[key] = value;
                return true;
              },
            },
          );
        },
        toDataURL: () =>
          `data:image/svg+xml,${encodeURIComponent(JSON.stringify({ fill, alpha, operations }))}`,
      };
    },
  };
  globalThis.window = new EventTarget();
});
test.after(() => {
  for (const [key, value] of savedGlobals) {
    if (value === undefined) delete globalThis[key];
    else globalThis[key] = value;
  }
});
function harness(
  t,
  sourceOptions = {},
  {
    getVisionStyle,
    setTimeoutImpl,
    clearTimeoutImpl,
    autoStart = true,
    trailReady = true,
    autoFlushBatches = true,
    project = () => ({ x: 500, y: 400 }),
    openExternal,
  } = {},
) {
  const primitives = new Cesium.PrimitiveCollection();
  const entries = new Map(),
    visible = new Map(),
    owners = new Map(),
    calls = [],
    focus = [],
    trails = [],
    credits = [],
    spriteCollections = new Map();
  let spriteRestores = 0;
  let onEvent,
    onState,
    click,
    pick = null,
    now = start,
    horizon = true,
    cardHit = null,
    pointerFree = true,
    closes = 0;
  const batchToken = Symbol('batch');
  let batchCallback = null;
  const expireBatch = () => {
    const callback = batchCallback;
    batchCallback = null;
    callback?.();
  };
  const moveEnd = new Cesium.Event(),
    postRender = new Cesium.Event();
  const viewer = {
    scene: {
      primitives,
      canvas: { clientWidth: 1000, clientHeight: 800 },
      postRender,
      pick: () => pick,
      sampleHeightSupported: true,
      sampleHeight: () =>
        assert.fail('scene.sampleHeight renders per call; use groundFloor'),
    },
    camera: { moveEnd, positionCartographic: { height: 1_000_000 } },
    creditDisplay: {
      addStaticCredit: (c) => credits.push(c),
      removeStaticCredit(c) {
        credits.splice(credits.indexOf(c), 1);
      },
    },
  };
  const source = {
    getSnapshot: async () => snap(),
    getTrack: async () => ({ track: [] }),
    getHistory: async () => ({ track: [] }),
    subscribe(event, state) {
      onEvent = event;
      onState = state;
      state('open');
      return () => closes++;
    },
    ...sourceOptions,
  };
  const layer = createRadiosondesLayer({
    source,
    getVisionStyle,
    setTimeoutImpl(fn, delay) {
      if (delay === policy.RADIOSONDE_DATA_BATCH_MS) {
        batchCallback = fn;
        return batchToken;
      }
      return (setTimeoutImpl ?? setTimeout)(fn, delay);
    },
    clearTimeoutImpl(id) {
      if (id === batchToken) batchCallback = null;
      else (clearTimeoutImpl ?? clearTimeout)(id);
    },
    now: () => now,
    openExternal,
    overlayHost: {
      setEntries: (id, list, options) => {
        entries.set(id, list);
        assert.ok(options.moving);
      },
      setVisible: (id, value) => visible.set(id, value),
      clearSource: (id) => entries.delete(id),
      hitTest: (_x, _y, { sourceId }) =>
        cardHit?.sourceId === sourceId ? cardHit : null,
    },
    screenSpaceEventHandlerFactory: () => ({
      setInputAction(fn) {
        click = fn;
      },
      destroy() {
        click = null;
      },
    }),
    services: {
      groundFloor: {
        cachedGroundFloor: () => 123,
        resolveGroundFloorCellsBounded: async () => {},
      },
      sprites: {
        registerSpriteCollection: (id, collection) =>
          spriteCollections.set(id, collection),
        unregisterSpriteCollection: (id) => spriteCollections.delete(id),
        restoreSpriteOrder: () => spriteRestores++,
      },
      render: {
        governorRequestRender: (reason) => calls.push(reason),
        holdContinuousRender: () => assert.fail('continuous hold'),
      },
      project,
      pointer: { isPointerFree: () => pointerFree },
      horizonOccluder: () => ({
        isPointVisible: (p) =>
          typeof horizon === 'function' ? horizon(p) : horizon,
      }),
      focus: { requestWorldFocus: (target) => focus.push(target) },
      credits: createCredits(),
      geoid: { ensureGeoidReady: async () => {}, geoidHeight: () => 30 },
      picking: {
        registerPickOwner: (id, p) => owners.set(id, p),
        unregisterPickOwner: (id) => owners.delete(id),
        resolvePickId: (p) => p?.id ?? p?.primitive?.id,
        isOwnedByOtherLayer: (_id, p) => p?.startsWith('other:'),
      },
      createTrailRenderer(_scene, options) {
        const trail = {
          options,
          history: null,
          visible: true,
          destroyed: false,
          body: null,
          displayCalls: 0,
          shown: false,
          replaceHistory(value) {
            this.history = value;
            this.body = value.segments.length ? { ready: trailReady } : null;
          },
          setDisplaySample() {
            this.displayCalls++;
            this.shown = this.body?.ready === true;
          },
          diagnostics() {
            return { body: this.body };
          },
          setStyle(value) {
            this.style = value;
          },
          setVisible(value) {
            this.visible = value;
          },
          destroy() {
            this.destroyed = true;
          },
        };
        trails.push(trail);
        return trail;
      },
    },
  });
  if (autoStart) {
    layer.init(viewer);
    layer.enable(viewer);
  }
  t.after(() => {
    layer.destroy();
    primitives.destroy();
  });
  return {
    layer,
    viewer,
    entries,
    visible,
    owners,
    calls,
    trails,
    credits,
    focus,
    spriteCollections,
    spriteRestores: () => spriteRestores,
    event(event) {
      onEvent(event);
      if (autoFlushBatches) expireBatch();
    },
    expireBatch,
    hasBatch: () => !!batchCallback,
    state: (value) => onState(value),
    click: (id) => {
      pick = id ? { id } : null;
      click({ position: { x: 10, y: 10 } });
    },
    setNow: (value) => (now = value),
    setHorizon: (value) => (horizon = value),
    setCardHit: (value) => (cardHit = value),
    setPointerFree: (value) => (pointerFree = value),
    closes: () => closes,
  };
}
const settle = () => new Promise(setImmediate);

test('selected card pointer and keyboard activation open the tracker without disturbing selection', async (t) => {
  const opened = [];
  const h = harness(t, {}, { openExternal: (url) => opened.push(url) });
  await h.layer.update(h.viewer);
  h.click('radiosonde:TEST123');
  await settle();
  const card = h.entries.get('radiosondes-selected')[0];
  assert.equal(card.details.at(-1), 'SondeHub tracker ↗ · CC BY-SA 2.0');
  assert.equal(card.interactive, true);
  assert.equal(
    card.accessibilityLabel,
    'Open the source for BALLOON · TEST123',
  );
  assert.equal(card.activate(), true);
  h.setCardHit({ sourceId: 'radiosondes-selected', entryId: card.id });
  h.setPointerFree(false);
  h.click(null);
  assert.equal(opened.length, 1, 'a tool owning the pointer suppresses clicks');
  h.setPointerFree(true);
  h.click(null);
  assert.deepEqual(opened, [
    'https://sondehub.org/TEST123',
    'https://sondehub.org/TEST123',
  ]);
  assert.equal(h.entries.get('radiosondes-selected')[0], card);
  assert.equal(h.trails.length, 1);
  assert.equal(h.trails[0].destroyed, false);
  h.setCardHit(null);
  h.click(null);
  assert.equal(h.entries.get('radiosondes-selected').length, 0);
});

test('selected cards stay inert when the host does not supply openExternal', async (t) => {
  const h = harness(t);
  await h.layer.update(h.viewer);
  h.click('radiosonde:TEST123');
  await settle();
  const card = h.entries.get('radiosondes-selected')[0];
  assert.equal(card.interactive, false);
  assert.equal(card.activate, undefined);
  h.setCardHit({ sourceId: 'radiosondes-selected', entryId: card.id });
  h.click(null);
  assert.equal(h.entries.get('radiosondes-selected')[0], card);
  assert.equal(h.trails[0].destroyed, false);
});

test('selected card shares sprite horizon visibility and host viewport culling while keeping selection', async (t) => {
  const h = harness(t);
  await h.layer.update(h.viewer);
  h.click('radiosonde:TEST123');
  await settle();
  const card = h.entries.get('radiosondes-selected')[0];
  const sprite = h.viewer.scene.primitives.get(0).get(0);
  const anchor = card.position();
  assert.equal(anchor, sprite.position);
  h.viewer.camera.positionWC = Cesium.Cartesian3.fromDegrees(
    10,
    50,
    14_000_000,
  );
  h.setHorizon((point) =>
    horizonOccluder(h.viewer.camera).isPointVisible(point),
  );
  const visible = (screen) =>
    isOverlayPointVisible(card, card.position(), screen, {
      width: 1000,
      height: 800,
    });
  assert.equal(visible({ x: 500, y: 400 }), true);
  h.viewer.camera.positionWC = Cesium.Cartesian3.fromDegrees(
    -170,
    -50,
    14_000_000,
  );
  h.viewer.camera.moveEnd.raiseEvent();
  assert.equal(sprite.show, false);
  assert.equal(
    card.position(),
    null,
    'a culled sprite must not publish an anchor to the host',
  );
  assert.equal(visible({ x: 500, y: 400 }), false);
  assert.equal(h.entries.get('radiosondes-selected')[0], card);
  assert.equal(h.trails[0].destroyed, false);
  h.viewer.camera.positionWC = Cesium.Cartesian3.fromDegrees(
    10,
    50,
    14_000_000,
  );
  h.viewer.camera.moveEnd.raiseEvent();
  assert.equal(card.position(), anchor);
  for (const screen of [
    { x: -1, y: 400 },
    { x: 1001, y: 400 },
    { x: 500, y: -1 },
    { x: 500, y: 801 },
    null,
  ])
    assert.equal(visible(screen), false);
  assert.equal(visible({ x: 500, y: 400 }), true);
  assert.equal(
    h.trails.length,
    1,
    'returning to view keeps the existing selection',
  );
  const calls = h.calls.length;
  h.viewer.scene.postRender.raiseEvent();
  assert.equal(h.calls.length, calls);
  assert.equal(
    h.viewer.scene.postRender.numberOfListeners,
    0,
    'visibility needs no layer frame callback',
  );
});

const spriteArt = (sprite) =>
  JSON.parse(decodeURIComponent(sprite.image.split(',')[1]));
const spriteAlpha = (sprite) => spriteArt(sprite).alpha * sprite.color.alpha;

function renderingHarness(t, services = {}) {
  const primitives = new Cesium.PrimitiveCollection();
  const viewer = {
    scene: {
      primitives,
      sampleHeightSupported: true,
      sampleHeight: () => assert.fail('use groundFloor'),
    },
  };
  const rendering = createRadiosondeRendering({ viewer, services });
  t.after(() => {
    rendering.destroy();
    primitives.destroy();
  });
  rendering.setEnabled(true);
  return { rendering, primitives };
}

test('every flight state swaps its cached symbol on the same billboard, selected or ambient; unchanged input writes nothing', (t) => {
  const { rendering, primitives } = renderingHarness(t);
  const value = { frame: raw(), phase: 'ascending', track: [] };
  const records = new Map([['TEST123', value]]);
  const collection = primitives.get(0);
  const phases = [
    'ascending',
    'descending',
    'unknown',
    'landed',
    'landed-inferred',
    'signal-lost',
  ];
  const images = new Map();
  let sprite;
  let writes = 0;
  let allocations = 0;
  const add = collection.add.bind(collection);
  t.mock.method(collection, 'add', (...args) => {
    allocations++;
    return add(...args);
  });
  const canvases = spriteCanvasAllocations;
  for (const selected of [null, 'TEST123', null]) {
    for (const phase of phases) {
      value.phase = phase;
      rendering.sync(records, selected);
      if (!sprite) {
        sprite = collection.get(0);
        for (const key of [
          'image',
          'color',
          'position',
          'width',
          'height',
          'scale',
          'show',
          'rotation',
        ]) {
          const descriptor = Object.getOwnPropertyDescriptor(
            Object.getPrototypeOf(sprite),
            key,
          );
          Object.defineProperty(sprite, key, {
            configurable: true,
            get: () => descriptor.get.call(sprite),
            set(next) {
              writes++;
              descriptor.set.call(sprite, next);
            },
          });
        }
      }
      assert.equal(collection.length, 1);
      assert.equal(collection.get(0), sprite);
      assert.equal(sprite.rotation, 0, 'symbols stay north-up');
      assert.equal(sprite.width, 20 * (selected ? 1.5 : 1));
      assert.equal(sprite.height, sprite.width);
      const art = spriteArt(sprite);
      const ops = art.operations;
      const expectedColor = phase.startsWith('landed')
        ? '#b499a2'
        : phase === 'signal-lost'
          ? '#a2a9b0'
          : selected
            ? '#FFFFFF'
            : policy.RADIOSONDE_COLOR;
      assert.equal(art.fill, expectedColor, phase);
      const alpha =
        phase.startsWith('landed') || phase === 'signal-lost'
          ? 0.55
          : phase === 'unknown'
            ? 0.75
            : 0.95;
      assert.equal(art.alpha * sprite.color.alpha, alpha, phase);
      if (phase === 'descending') {
        assert.equal(
          ops.filter(({ op }) => op === 'bezierCurveTo').length,
          1,
          'wide parachute canopy',
        );
        assert.ok(
          ops.filter(({ op }) => op === 'lineTo').length >= 4,
          'suspension lines and payload',
        );
      } else if (phase.startsWith('landed')) {
        assert.ok(
          ops.some(({ op }) => op === 'arc'),
          'ground dot',
        );
        assert.ok(
          ops.some(({ op }) => op === 'lineTo'),
          'short ground base',
        );
        assert.equal(
          ops.some(({ op }) => op === 'bezierCurveTo'),
          false,
          'no balloon on the ground',
        );
      } else {
        assert.equal(
          ops.filter(({ op }) => op === 'bezierCurveTo').length,
          4,
          'balloon envelope',
        );
      }
      if (phase === 'signal-lost') {
        assert.ok(
          ops.some(
            ({ op, args }) => op === 'setLineDash' && args[0].length === 2,
          ),
          'lost outline is dashed',
        );
        assert.equal(
          ops.some(({ op }) => op === 'fill' || op === 'fillRect'),
          false,
          'lost envelope is hollow',
        );
      }
      const key = `${phase}:${!!selected}`;
      if (images.has(key))
        assert.equal(sprite.image, images.get(key), 'reuse cached state art');
      images.set(key, sprite.image);
      const before = writes;
      assert.equal(
        rendering.sync(
          new Map([['TEST123', { ...value, frame: { ...value.frame } }]]),
          selected,
        ).changed,
        false,
      );
      assert.equal(
        writes,
        before,
        'no setters for unchanged input in any state',
      );
    }
  }
  assert.equal(allocations, 1);
  assert.equal(
    spriteCanvasAllocations - canvases,
    phases.length + 2,
    'landed phases share one image; the three aloft states have white selection art',
  );
  assert.equal(images.get('landed:false'), images.get('landed-inferred:false'));
  assert.notEqual(
    images.get('ascending:false'),
    images.get('descending:false'),
  );
  assert.notEqual(images.get('ascending:false'), images.get('unknown:false'));
  assert.notEqual(images.get('ascending:true'), images.get('descending:true'));
});

test('row legend counts flight directions and both landed states, omitting zero unknowns', (t) => {
  const h = harness(t);
  for (const delta of [-130000, -65000, 0])
    h.event({ type: 'frames', ...snap([raw('LANDED', start + delta, 500)]) });
  const frames = [];
  for (const [prefix, count, age, altM, vVelMps] of [
    ['UP', 2, 0, 12000, 5],
    ['DOWN', 3, 0, 12000, -5],
    ['UNKNOWN', 4, 0, 12000, undefined],
    ['INFERRED', 2, 660000, 500, -1],
    ['LOST', 5, 660000, 12000, 5],
  ]) {
    for (let i = 0; i < count; i++)
      frames.push({
        ...raw(`${prefix}${i}`, start - age, altM),
        receivedMs: start,
        vVelMps,
      });
  }
  h.event({ type: 'frames', ...snap(frames) });
  const legend = h.layer.getRowControls().legend;
  assert.deepEqual(
    legend.map(({ label, count }) => [label, count]),
    [
      ['Ascending', 2],
      ['Descending', 3],
      ['Aloft (direction unknown)', 4],
      ['Landed', 3],
      ['Signal lost', 5],
    ],
  );
  assert.deepEqual(
    legend.map(({ color }) => color),
    ['ascending', 'descending', 'unknown', 'landed', 'signal-lost'].map(
      (phase) => policy.RADIOSONDE_SYMBOLS[phase].color,
    ),
  );
  const controls = h.layer.getRowControls();
  assert.equal(Object.hasOwn(controls, 'readout'), false);
  assert.equal(Object.hasOwn(controls, 'summary'), false);
  assert.equal(controls.info, nextLaunch);
  const canvases = spriteCanvasAllocations;
  assert.deepEqual(h.layer.getRowControls(), controls);
  assert.equal(spriteCanvasAllocations, canvases);
  h.event({
    type: 'snapshot',
    ...snap(frames.filter(({ serial }) => !serial.startsWith('UNKNOWN'))),
  });
  assert.deepEqual(
    h.layer.getRowControls().legend.map(({ label, count }) => [label, count]),
    [
      ['Ascending', 2],
      ['Descending', 3],
      ['Landed', 2],
      ['Signal lost', 5],
    ],
    'omit the unknown row entirely when zero',
  );
});

test('flight-size balloon silhouettes share cached art and retain registered collections across refreshes', async (t) => {
  const frames = Array.from({ length: 500 }, (_, i) => raw(`SPRITE${i}`));
  const canvasesBefore = spriteCanvasAllocations;
  const h = harness(t, { getSnapshot: async () => snap(frames) });
  await h.layer.update(h.viewer);
  await settle();
  const sprites = h.viewer.scene.primitives.get(0);
  const first = sprites.get(0);
  const originalSprites = Array.from({ length: 500 }, (_, i) => sprites.get(i));
  const image = first.image;
  const art = JSON.parse(decodeURIComponent(image.split(',')[1]));
  assert.equal(art.fill, policy.RADIOSONDE_COLOR);
  assert.equal(
    art.operations.filter((op) => op.op === 'bezierCurveTo').length,
    4,
  );
  assert.ok(art.operations.some((op) => op.op === 'strokeRect'));
  assert.equal(first.width, 20);
  assert.equal(first.height, 20);
  assert.deepEqual(
    first.scaleByDistance,
    new Cesium.NearFarScalar(1000, 3, 8e6, 0.5),
  );
  assert.equal(first.disableDepthTestDistance, Infinity);
  assert.equal(h.spriteCollections.get('radiosondes'), sprites);
  assert.equal(
    h.spriteCollections.get('radiosondes-burst'),
    h.viewer.scene.primitives.get(2),
  );
  assert.equal(h.spriteRestores(), 1);
  for (let round = 1; round <= 10; round++) {
    h.setNow(start + round * 1000);
    h.event({
      type: 'frames',
      ...snap(
        frames.slice(0, 50).map((frame) => ({
          ...frame,
          timeMs: start + round * 1000,
          altM: frame.altM + round,
        })),
      ),
    });
    assert.equal(h.viewer.scene.primitives.get(0), sprites);
    assert.equal(sprites.get(0), first);
    assert.ok(originalSprites.every((sprite, i) => sprites.get(i) === sprite));
    assert.equal(sprites.length, 500);
    assert.ok(
      Array.from({ length: 500 }, (_, i) => sprites.get(i)).every(
        (s) => s.image === image,
      ),
    );
  }
  assert.equal(
    spriteCanvasAllocations - canvasesBefore,
    1,
    'one cached texture for this variant across all points and refreshes',
  );
  assert.equal(h.viewer.scene.postRender.numberOfListeners, 0);
  h.layer.destroy();
  assert.equal(h.spriteCollections.size, 0);
});

test('equal geometry and metadata snapshots perform zero actual billboard writes and publish no render', async (t) => {
  const h = harness(t);
  await h.layer.update(h.viewer);
  await settle();
  const sprite = h.viewer.scene.primitives.get(0).get(0);
  let writes = 0;
  for (const key of [
    'position',
    'image',
    'color',
    'width',
    'height',
    'scale',
    'show',
  ]) {
    const descriptor = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(sprite),
      key,
    );
    Object.defineProperty(sprite, key, {
      configurable: true,
      get: () => descriptor.get.call(sprite),
      set(value) {
        writes++;
        descriptor.set.call(sprite, value);
      },
    });
  }
  const entries = h.entries.get('radiosondes');
  const renders = h.calls.length;
  for (let i = 1; i <= 10; i++) {
    h.setNow(start + i * 1000);
    h.event({
      type: 'snapshot',
      ...snap([{ ...raw(), timeMs: start + i * 1000 }]),
    });
  }
  assert.equal(writes, 0);
  assert.equal(h.entries.get('radiosondes'), entries);
  assert.equal(h.calls.length, renders);
});

test('only on-screen front-side contacts enter the ranked 150-candidate cohort; frame events do no work', async (t) => {
  let projections = 0;
  const h = harness(
    t,
    {},
    {
      project: (_scene, p) => {
        projections++;
        const lon = Cesium.Math.toDegrees(
          Cesium.Cartographic.fromCartesian(p).longitude,
        );
        return { x: lon > 100 ? 2000 : 500, y: 400 };
      },
    },
  );
  h.setHorizon(
    (p) =>
      Cesium.Math.toDegrees(Cesium.Cartographic.fromCartesian(p).longitude) <
      135,
  );
  h.event({
    type: 'snapshot',
    ...snap([
      ...Array.from({ length: 160 }, (_, i) => ({
        ...raw(`OFF${i}`, start, 30000),
        lon: 130,
      })),
      ...Array.from({ length: 160 }, (_, i) => ({
        ...raw(`BACK${i}`, start, 40000),
        lon: 140,
      })),
      ...Array.from({ length: 170 }, (_, i) => ({
        ...raw(`ON${String(i).padStart(3, '0')}`, start, 100),
        lon: 10,
      })),
    ]),
  });
  await settle();
  const entries = h.entries.get('radiosondes');
  assert.equal(entries.length, 150);
  assert.ok(entries.every((e) => e.id.startsWith('sonde:ON')));
  const before = projections,
    renders = h.calls.length;
  for (let i = 0; i < 100; i++) h.viewer.scene.postRender.raiseEvent();
  assert.equal(projections, before);
  assert.equal(h.calls.length, renders);
  h.setHorizon(false);
  h.viewer.camera.moveEnd.raiseEvent();
  assert.deepEqual(h.entries.get('radiosondes'), []);
});

test('pushes coalesce by serial into one 500 ms batch, snapshots replace membership, and teardown cancels pending work', async (t) => {
  const h = harness(t, {}, { autoFlushBatches: false });
  h.event({ type: 'snapshot', ...snap() });
  await settle();
  const sprites = h.viewer.scene.primitives.get(0),
    first = sprites.get(0);
  const baseline = h.calls.length;
  for (const delta of [100, 200, 300, 400]) {
    h.setNow(start + delta);
    h.event({
      type: 'frames',
      ...snap([
        raw('TEST123', start + delta, 10000 + delta),
        raw('SECOND', start + delta),
      ]),
    });
  }
  assert.equal(h.hasBatch(), true);
  assert.equal(sprites.length, 1);
  assert.equal(h.calls.length, baseline);
  h.setNow(start + 600);
  h.expireBatch();
  assert.equal(sprites.length, 2);
  assert.equal(sprites.get(0), first);
  assert.equal(
    Math.round(Cesium.Cartographic.fromCartesian(first.position).height),
    10430,
  );
  assert.equal(h.calls.length, baseline + 1);
  assert.equal(h.hasBatch(), false);
  h.setNow(start + 700);
  h.event({ type: 'frames', ...snap([raw('OBSOLETE', start + 700)]) });
  h.event({ type: 'snapshot', ...snap([raw('REPLACE', start + 710)]) });
  h.event({ type: 'frames', ...snap([raw('APPEND', start + 720)]) });
  h.event({ type: 'snapshot', ...snap([raw('STALE', start + 715)]) });
  h.setNow(start + 1200);
  h.expireBatch();
  assert.deepEqual(
    Array.from({ length: sprites.length }, (_, i) => sprites.get(i).id).sort(),
    ['radiosonde:APPEND', 'radiosonde:REPLACE'],
  );
  h.event({ type: 'frames', ...snap([raw('LATE', start + 1300)]) });
  assert.equal(h.hasBatch(), true);
  h.layer.disable();
  assert.equal(h.hasBatch(), false);
  h.expireBatch();
  assert.equal(sprites.length, 0);
  assert.equal(h.layer.getStats().count, 0);
});

test('unready selected trails stop requesting frames after the named readiness bound', async (t) => {
  const h = harness(
    t,
    {
      getHistory: async () => ({
        track: [raw('TEST123', start - 60000, 9000), raw()],
      }),
    },
    { trailReady: false },
  );
  await h.layer.update(h.viewer);
  h.click('radiosonde:TEST123');
  await settle();
  assert.equal(h.viewer.scene.postRender.numberOfListeners, 1);
  for (let i = 0; i < policy.RADIOSONDE_TRAIL_READY_MAX_CHECKS; i++)
    h.viewer.scene.postRender.raiseEvent();
  assert.equal(h.viewer.scene.postRender.numberOfListeners, 0);
  const requests = h.calls.length;
  h.viewer.scene.postRender.raiseEvent();
  assert.equal(h.calls.length, requests);
  assert.equal(h.trails[0].shown, false);
  await h.layer.update(h.viewer);
  assert.equal(
    h.viewer.scene.postRender.numberOfListeners,
    0,
    'unchanged geometry cannot re-arm an exhausted revision',
  );
  assert.equal(h.calls.length, requests);
  h.setNow(start + 1000);
  h.event({ type: 'frames', ...snap([raw('TEST123', start + 1000, 11000)]) });
  assert.equal(
    h.viewer.scene.postRender.numberOfListeners,
    1,
    'new geometry has its own bounded readiness check',
  );
});

test('live status received during a queued data batch clears stale acquisition metadata', async (t) => {
  const h = harness(t, {}, { autoFlushBatches: false });
  h.event({ type: 'snapshot', ...snap() });
  await settle();
  h.setNow(start + 100);
  h.event({
    type: 'frames',
    ...snap([raw('SECOND', start + 100)], 'connecting'),
  });
  assert.equal(h.hasBatch(), true);
  h.event({ type: 'status', upstream: 'live', lastFrameMs: start + 100 });
  assert.equal(h.layer.getStats().stale, false);
  h.setNow(start + 600);
  h.expireBatch();
  assert.equal(h.layer.getStats().count, 2);
  assert.equal(h.layer.getStats().stale, false);
  assert.equal(
    h.layer.getRowControls().info,
    'Next launch window 11:00–12:00 UTC · in 2h',
  );
});

function retryClock(t) {
  const timers = new Map(),
    listeners = new Set();
  let next = 0;
  const previous = globalThis.document;
  globalThis.document = {
    ...previous,
    hidden: false,
    addEventListener(type, fn) {
      assert.equal(type, 'visibilitychange');
      listeners.add(fn);
    },
    removeEventListener(type, fn) {
      assert.equal(type, 'visibilitychange');
      listeners.delete(fn);
    },
  };
  t.after(() => {
    globalThis.document = previous;
  });
  return {
    timers,
    listeners,
    setTimeoutImpl(fn, delay) {
      const id = ++next;
      timers.set(id, { fn, delay });
      return id;
    },
    clearTimeoutImpl: (id) => timers.delete(id),
    expire() {
      assert.equal(timers.size, 1);
      const [id, timer] = [...timers][0];
      timers.delete(id);
      timer.fn();
    },
    visibility(hidden) {
      globalThis.document.hidden = hidden;
      for (const listener of [...listeners]) listener();
    },
  };
}
const building = { status: 'building', retryAfterSec: 2 };
const coldSnapshot = {
  frames: [],
  upstream: 'closed',
  lastFrameMs: null,
  stale: true,
  fetchedAt: null,
};
test('normal cold start stays loading through empty SSE and 202, then the manager retry loads data', async (t) => {
  const clock = retryClock(t),
    warnings = [],
    states = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args));
  let ready = false;
  const source = createRadiosondeSource({
    now: () => start,
    fetchImpl: async () =>
      new Response(JSON.stringify(ready ? snap() : { status: 'building' }), {
        status: ready ? 200 : 202,
        headers: ready ? {} : { 'Retry-After': '2' },
      }),
  });
  const h = harness(t, { getSnapshot: source.getSnapshot }, clock);
  const refreshes = [];
  h.layer.setRowControlsListener(() => states.push(h.layer.getStats()));
  h.event({ type: 'snapshot', ...coldSnapshot });
  assert.equal(h.layer.getStats().error, null);
  assert.equal(h.layer.getStats().loading, true);
  h.event({ type: 'status', upstream: 'connecting', lastFrameMs: null });
  assert.equal(h.layer.getStats().error, null);
  assert.equal(h.layer.getStats().loading, true);
  h.layer.attachDataManager({
    refreshLayer(id, options) {
      refreshes.push({ id, ...options });
      return h.layer.update(h.viewer, options);
    },
  });
  for (let i = 0; i < 2; i++) {
    assert.equal(await h.layer.update(h.viewer), true);
    assert.equal(clock.timers.size, 1);
    assert.equal(clock.listeners.size, 1);
    assert.ok([...clock.timers.values()][0].delay <= 1000);
  }
  assert.equal(h.layer.getStats().lastUpdate, null);
  assert.equal(layerFeedState(h.layer.getStats()), 'loading');
  assert.equal(h.layer.getStats().loadingLabel, 'loading...');
  assert.ok(states.length > 0);
  assert.ok(states.every((state) => state.loading && state.error === null));
  ready = true;
  clock.expire();
  await settle();
  assert.equal(refreshes.length, 1);
  assert.equal(refreshes[0].id, 'radiosondes');
  assert.equal(refreshes[0].signal.aborted, false);
  assert.equal(clock.timers.size, 0);
  assert.equal(clock.listeners.size, 0);
  assert.equal(layerFeedState(h.layer.getStats()), 'nominal');
  assert.equal(h.layer.getStats().error, null);
  assert.deepEqual(warnings, []);
});
test('the real manager accepts first-load building and re-arms only on the next 202 without refresh errors', async (t) => {
  const clock = retryClock(t),
    changes = [],
    warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args));
  let manager,
    reads = 0;
  t.after(async () => {
    await manager?.destroyAll();
  });
  const h = harness(
    t,
    {
      subscribe: undefined,
      getSnapshot: async () => (++reads <= 2 ? building : snap()),
    },
    { ...clock, autoStart: false },
  );
  manager = new LayerLifecycle(h.viewer);
  manager.register(h.layer);
  h.layer.attachDataManager(manager);
  manager.subscribe((change) => changes.push(change));
  assert.equal(await manager.setEnabled('radiosondes', true), true);
  assert.equal(manager.isEnabled('radiosondes'), true);
  assert.equal(layerFeedState(manager.getAll()[0].stats), 'loading');
  assert.equal(clock.timers.size, 1);
  clock.expire();
  await settle();
  assert.equal(reads, 2);
  assert.equal(clock.timers.size, 1);
  assert.equal(manager.getAll()[0].stats.managerRefreshError, null);
  assert.equal(layerFeedState(manager.getAll()[0].stats), 'loading');
  clock.expire();
  await settle();
  assert.equal(reads, 3);
  assert.equal(clock.timers.size, 0);
  assert.equal(clock.listeners.size, 0);
  assert.equal(manager.isEnabled('radiosondes'), true);
  assert.equal(manager.getAll()[0].stats.managerRefreshError, null);
  assert.equal(layerFeedState(manager.getAll()[0].stats), 'nominal');
  assert.ok(
    changes.every(
      (change) => !['refresh-failed', 'enable-failed'].includes(change.type),
    ),
  );
  assert.deepEqual(warnings, []);
});
test('a retry expires once while hidden and catches up exactly once on visibility', async (t) => {
  const clock = retryClock(t),
    refreshes = [];
  const h = harness(t, { getSnapshot: async () => building }, clock);
  h.layer.attachDataManager({
    refreshLayer: (...args) => refreshes.push(args),
  });
  assert.equal(await h.layer.update(h.viewer), true);
  clock.visibility(true);
  clock.expire();
  assert.equal(refreshes.length, 0);
  assert.equal(clock.timers.size, 0);
  assert.equal(clock.listeners.size, 1);
  clock.visibility(true);
  assert.equal(refreshes.length, 0);
  clock.visibility(false);
  clock.visibility(false);
  assert.equal(refreshes.length, 1);
  assert.equal(clock.listeners.size, 0);
  assert.equal(clock.timers.size, 0, 'a new answer alone may re-arm the retry');
  h.layer.disable();
  assert.equal(refreshes[0][1].signal.aborted, true);
});
for (const outcome of ['200', 'failure', 'building without Retry-After']) {
  test(`${outcome} clears the outstanding retry and visibility listener`, async (t) => {
    const clock = retryClock(t);
    let next = building;
    const h = harness(
      t,
      {
        subscribe: undefined,
        getSnapshot: async () => {
          if (next instanceof Error) throw next;
          return next;
        },
      },
      clock,
    );
    h.layer.attachDataManager({
      refreshLayer: () => assert.fail('cancelled retry'),
    });
    await h.layer.update(h.viewer);
    assert.equal(clock.timers.size, 1);
    next =
      outcome === '200'
        ? snap()
        : outcome === 'failure'
          ? Error('SondeHub HTTP 502')
          : { status: 'building', retryAfterSec: null };
    assert.equal(await h.layer.update(h.viewer), true);
    assert.equal(clock.timers.size, 0);
    assert.equal(clock.listeners.size, 0);
    assert.equal(
      layerFeedState(h.layer.getStats()),
      outcome === 'failure'
        ? 'unavailable'
        : outcome === '200'
          ? 'nominal'
          : 'loading',
    );
  });
}
for (const due of [false, true]) {
  for (const action of ['disable', 'destroy']) {
    test(`${action} clears a ${due ? 'hidden due' : 'pending'} retry and rejects late building replies`, async (t) => {
      const clock = retryClock(t),
        refreshes = [];
      let finish;
      const h = harness(t, { getSnapshot: async () => building }, clock);
      h.layer.attachDataManager({
        refreshLayer: (...args) => refreshes.push(args),
      });
      await h.layer.update(h.viewer);
      if (due) {
        clock.visibility(true);
        clock.expire();
      }
      h.layer[action]();
      assert.equal(clock.timers.size, 0);
      assert.equal(clock.listeners.size, 0);
      clock.visibility(false);
      assert.equal(refreshes.length, 0);
      if (action === 'destroy') return;
      h.layer.enable();
      const late = harness(
        t,
        { getSnapshot: () => new Promise((resolve) => (finish = resolve)) },
        clock,
      );
      late.layer.attachDataManager({
        refreshLayer: () => assert.fail('late retry'),
      });
      const pending = late.layer.update(late.viewer);
      late.layer.disable();
      late.layer.enable();
      finish(building);
      assert.equal(await pending, false);
      assert.equal(clock.timers.size, 0);
    });
  }
}
for (const type of ['snapshot', 'frames', 'status']) {
  test(`SSE ${type} readiness cancels a pending or hidden-due retry and supersedes a late 202`, async (t) => {
    for (const due of [false, true]) {
      const clock = retryClock(t);
      let finish,
        pendingRead = false;
      const h = harness(
        t,
        {
          getSnapshot: () =>
            pendingRead
              ? new Promise((resolve) => (finish = resolve))
              : Promise.resolve(building),
        },
        clock,
      );
      h.layer.attachDataManager({
        refreshLayer: () => assert.fail('SSE won the retry'),
      });
      await h.layer.update(h.viewer);
      h.event({ type: 'status', upstream: 'connecting', lastFrameMs: null });
      assert.equal(clock.timers.size, 1);
      if (due) {
        clock.visibility(true);
        clock.expire();
      }
      pendingRead = true;
      const pending = h.layer.update(h.viewer);
      h.event({ type, ...snap(type === 'status' ? [] : [raw()]) });
      assert.equal(clock.timers.size, 0);
      assert.equal(clock.listeners.size, 0);
      finish(building);
      assert.equal(await pending, true);
      assert.equal(clock.timers.size, 0);
      assert.equal(h.layer.getStats().loading, false);
      assert.equal(h.layer.getStats().error, null);
      clock.visibility(false);
      h.layer.destroy();
    }
  });
}
test('empty connecting SSE during the HTTP request still allows the 202 retry to arm', async (t) => {
  const clock = retryClock(t);
  let finish;
  const h = harness(
    t,
    { getSnapshot: () => new Promise((resolve) => (finish = resolve)) },
    clock,
  );
  h.layer.attachDataManager({
    refreshLayer: () => assert.fail('retry not due'),
  });
  const pending = h.layer.update(h.viewer);
  h.event({ type: 'snapshot', ...coldSnapshot });
  h.event({ type: 'status', upstream: 'connecting', lastFrameMs: null });
  finish(building);
  assert.equal(await pending, true);
  assert.equal(clock.timers.size, 1);
  assert.equal(h.layer.getStats().loading, true);
  assert.equal(h.layer.getStats().error, null);
});
test('SSE-first partial data draws immediately after an empty startup event and cancels the 202 retry', async (t) => {
  const clock = retryClock(t);
  const h = harness(
    t,
    { getSnapshot: async () => building },
    { ...clock, autoFlushBatches: false },
  );
  h.layer.attachDataManager({
    refreshLayer: () => assert.fail('SSE cancelled acquisition retry'),
  });
  h.event({ type: 'snapshot', ...coldSnapshot, partial: true });
  await h.layer.update(h.viewer);
  assert.equal(clock.timers.size, 1);
  h.setNow(start + 100);
  h.event({ type: 'frames', ...snap(), partial: true });
  assert.equal(h.layer.getStats().count, 1);
  assert.equal(h.layer.getStats().partial, true);
  assert.equal(h.layer.getStats().loading, false);
  assert.equal(
    h.hasBatch(),
    false,
    'first balloons bypass steady-state coalescing',
  );
  assert.equal(clock.timers.size, 0);
  assert.equal(clock.listeners.size, 0);
  assert.equal(h.spriteCollections.get('radiosondes').get(0).show, true);
});
test('partial snapshots merge membership; a complete snapshot can replace it and clear partial', (t) => {
  const h = harness(t);
  h.event({ type: 'snapshot', ...snap(), partial: true });
  h.event({
    type: 'snapshot',
    ...snap([raw('OTHER123', start + 1)]),
    partial: true,
  });
  assert.equal(h.layer.getStats().count, 2);
  assert.equal(h.layer.getStats().partial, true);
  h.event({ type: 'frames', ...snap([]), partial: false });
  assert.equal(h.layer.getStats().count, 2);
  assert.equal(h.layer.getStats().partial, false);
  h.event({
    type: 'snapshot',
    ...snap([raw('OTHER123', start + 2)]),
    partial: false,
  });
  assert.equal(h.layer.getStats().count, 1);
});
test('coalesced partial snapshots and completion metadata add contacts without removing existing ones', (t) => {
  const h = harness(t, {}, { autoFlushBatches: false });
  h.event({ type: 'snapshot', ...snap() });
  h.setNow(start + 100);
  h.event({
    type: 'frames',
    ...snap([raw('OTHER123', start + 100)]),
    partial: true,
  });
  h.event({
    type: 'snapshot',
    ...snap([raw('THIRD123', start + 101)]),
    partial: true,
  });
  h.event({
    type: 'frames',
    ...snap([]),
    fetchedAt: start + 101,
    partial: false,
  });
  h.expireBatch();
  assert.equal(h.layer.getStats().count, 3);
  assert.equal(h.layer.getStats().partial, false);
});
test('a live empty partial sample does not claim there are no balloons', (t) => {
  const h = harness(t);
  h.event({ type: 'snapshot', ...snap([]), partial: true });
  assert.equal(h.layer.getStats().partial, true);
  assert.equal(h.layer.getStats().status, undefined);
  assert.equal(layerFeedState(h.layer.getStats()), 'partial');
});
for (const [transport, mqtt, sse] of [
  ['MQTT-first SSE', true, true],
  ['backfill-first SSE', false, true],
  ['snapshot-only', false, false],
]) {
  test(`cold server time to first drawn balloon is bounded with a slow upstream (${transport})`, async (t) => {
    const cold = createColdRadiosondeServer(t, { mqtt, sse });
    const source = createRadiosondeSource(cold);
    const h = harness(t, source, {
      ...cold,
      autoStart: false,
      autoFlushBatches: false,
    });
    cold.onTick(h.setNow);
    let firstBalloonMs = null;
    h.layer.setRowControlsListener(() => {
      if (
        firstBalloonMs === null &&
        h.layer.getStats().count > 0 &&
        h.spriteCollections.get('radiosondes')?.get(0)?.show
      )
        firstBalloonMs = cold.elapsed();
    });
    h.layer.attachDataManager({
      refreshLayer: (_id, options) => h.layer.update(h.viewer, options),
    });
    h.layer.init(h.viewer);
    h.layer.enable();
    await h.layer.update(h.viewer);
    assert.equal(cold.requests[0].status, 202);
    await cold.advance(1000);
    const early = { ...h.layer.getStats() };
    const readsBeforeBackfill = cold.requests.length;
    await cold.advance(8000);
    t.diagnostic(
      JSON.stringify({
        transport,
        firstBalloonMs,
        backfillCompletedMs: cold.backfillCompletedAt(),
        readsBeforeBackfill,
        snapshots: cold.requests,
      }),
    );
    assert.notEqual(firstBalloonMs, null);
    assert.ok(
      firstBalloonMs <= (sse ? 250 : 1000),
      `first balloon took ${firstBalloonMs} ms`,
    );
    assert.ok(firstBalloonMs < cold.backfillCompletedAt());
    assert.equal(early.partial, true);
    assert.equal(early.loading, false);
    assert.equal(early.error, null);
    if (sse) {
      assert.equal(readsBeforeBackfill, 1, 'SSE data cancels the HTTP retry');
      assert.equal(h.layer.getStats().partial, false);
      assert.equal(h.layer.getStats().count, 1);
    }
  });
}
test('row info follows the injected UTC launch clock across both windows and midnight', (t) => {
  const h = harness(t);
  h.event({ type: 'snapshot', ...snap() });
  for (const [iso, expected] of [
    ['2026-11-04T00:00:00Z', 'Next launch window 11:00–12:00 UTC · in 11h'],
    ['2026-11-04T10:45:00Z', 'Next launch window 11:00–12:00 UTC · in 15m'],
    ['2026-11-04T10:59:30Z', 'Next launch window 11:00–12:00 UTC · in <1m'],
    ['2026-11-04T11:00:00Z', 'Launch window now · until 12:00 UTC'],
    ['2026-11-04T11:59:59Z', 'Launch window now · until 12:00 UTC'],
    ['2026-11-04T12:00:00Z', 'Next launch window 23:00–00:00 UTC · in 11h'],
    ['2026-11-04T22:30:00Z', 'Next launch window 23:00–00:00 UTC · in 30m'],
    ['2026-11-04T23:00:00Z', 'Launch window now · until 00:00 UTC'],
    ['2026-11-04T23:59:59Z', 'Launch window now · until 00:00 UTC'],
    ['2026-11-05T00:00:00Z', 'Next launch window 11:00–12:00 UTC · in 11h'],
  ]) {
    h.setNow(Date.parse(iso));
    assert.equal(h.layer.getRowControls().info, expected, iso);
  }
});

test('landed marks retain their icon and serial label after one hour, with horizon culling even selected', async (t) => {
  const h = harness(t);
  for (const delta of [-130000, -65000, 0])
    h.event({ type: 'frames', ...snap([raw('TEST123', start + delta, 500)]) });
  const sprites = h.viewer.scene.primitives.get(0);
  assert.equal(sprites.length, 1);
  assert.equal(spriteAlpha(sprites.get(0)), 0.55);
  assert.equal(
    h.entries.get('radiosondes').length,
    1,
    'fresh landed sondes have an ambient label',
  );
  assert.equal(h.entries.get('radiosondes')[0].title, 'TEST123 landed');
  h.setNow(start + 3600000);
  await h.layer.update(h.viewer);
  assert.equal(
    sprites.length,
    1,
    'the exact one-hour boundary remains visible',
  );
  h.setNow(start + 3600001);
  await h.layer.update(h.viewer);
  assert.equal(sprites.length, 1);
  assert.deepEqual(
    h.layer.getRowControls().legend.map((entry) => entry.count),
    [0, 0, 1, 0],
  );
  assert.equal(h.entries.get('radiosondes').length, 1);
  h.click('radiosonde:TEST123');
  await settle();
  assert.equal(
    sprites.length,
    1,
    'selection reuses the retained landed record',
  );
  assert.equal(sprites.get(0).show, true);
  assert.equal(spriteAlpha(sprites.get(0)), 0.55);
  assert.match(h.entries.get('radiosondes-selected')[0].details[0], /^Landed/);
  h.setHorizon(false);
  h.viewer.camera.moveEnd.raiseEvent();
  assert.equal(
    sprites.get(0).show,
    false,
    'selection still respects the horizon',
  );
  h.click(null);
  assert.equal(sprites.length, 1);
  assert.equal(
    h.layer.getRowControls().legend.find(({ label }) => label === 'Landed')
      .count,
    1,
  );
});

test('the render budget covers all retained serials, including old terminal contacts', (t) => {
  const h = harness(t);
  for (const delta of [-130000, -65000, 0])
    h.event({ type: 'frames', ...snap([raw('TEST123', start + delta, 500)]) });
  h.setNow(start + 3600001);
  const airborne = Array.from(
    { length: policy.MAX_SONDES_RENDERED - 1 },
    (_, i) => raw(`CAP${i}`, start + 3600001),
  );
  h.event({ type: 'frames', ...snap(airborne) });
  const sprites = h.viewer.scene.primitives.get(0);
  assert.equal(sprites.length, policy.MAX_SONDES_RENDERED);
  assert.equal(
    h.layer.getStats().countLabel,
    undefined,
    'the entire retained population fits',
  );
  h.click('radiosonde:TEST123');
  assert.equal(sprites.length, policy.MAX_SONDES_RENDERED);
  assert.ok(
    Array.from({ length: sprites.length }, (_, i) => sprites.get(i)).some(
      (s) => s.id === 'radiosonde:TEST123',
    ),
  );
  assert.equal(h.layer.getStats().countLabel, undefined);
});

test('ambient labels include serials, low and unknown contacts, with evidence-only arrows', async (t) => {
  const h = harness(
    t,
    {},
    {
      project: (_scene, p) => ({
        x:
          ((Cesium.Cartographic.fromCartesian(p).longitude * 180) / Math.PI -
            9) *
          200,
        y: 400,
      }),
    },
  );
  h.event({
    type: 'snapshot',
    ...snap([
      { ...raw('ASCEND', start, 18240), lon: 10, vVelMps: 5 },
      { ...raw('DESCEND', start, 6100), lon: 11, vVelMps: -16 },
      { ...raw('LOWSONDE', start, 1000), lon: 12, vVelMps: 5 },
      { ...raw('STILLSONDE', start, 19000), lon: 13, vVelMps: 0.05 },
    ]),
  });
  assert.deepEqual(
    h.entries.get('radiosondes').map((entry) => entry.title),
    [
      'STILLSONDE 19.0\u00a0km',
      'ASCEND ↑ 18.2\u00a0km',
      'LOWSONDE ↑ 1.0\u00a0km',
      'DESCEND ↓ 6.1\u00a0km',
    ],
  );
  const history = [
    raw('ASCEND', start - 60000, 20000),
    raw('ASCEND', start, 18240),
  ];
  // Establish descent through history while the current vertical velocity is positive.
  // The source seam remains synthetic and is also used by reselection below.
  const other = harness(t, {
    getHistory: async () => ({ track: history }),
    getSnapshot: async () =>
      snap([{ ...raw('ASCEND', start, 18240), vVelMps: 5 }]),
  });
  await other.layer.update(other.viewer);
  other.click('radiosonde:ASCEND');
  await settle();
  other.click(null);
  assert.equal(
    other.entries.get('radiosondes')[0].title,
    'ASCEND ↓ 18.2\u00a0km',
  );
});

test('ambient priorities put aloft before descending and terminal labels, using altitude, recency and serial within each group', (t) => {
  const h = harness(t);
  for (const delta of [-130000, -65000, 0]) {
    h.event({
      type: 'frames',
      ...snap([{ ...raw('LANDED', start + delta, 100), vVelMps: 0 }]),
    });
  }
  h.event({
    type: 'frames',
    ...snap([
      { ...raw('ASCLOW', start, 100), vVelMps: 5 },
      { ...raw('UNKNOWN', start, 200), vVelMps: 0 },
      { ...raw('ASCHIGH', start - 1000, 20000), vVelMps: 5 },
      { ...raw('ASCTIEB', start, 20000), vVelMps: 5 },
      { ...raw('ASCTIEA', start, 20000), vVelMps: 5 },
      { ...raw('DESCEND', start, 40000), vVelMps: -5 },
      { ...raw('LOST', start - 11 * 60000, 45000), vVelMps: 5 },
      { ...raw('INFERRED', start - 11 * 60000, 100), vVelMps: 0 },
    ]),
  });
  const aloft = [
    'ASCTIEA',
    'ASCTIEB',
    'ASCHIGH',
    'UNKNOWN',
    'ASCLOW',
    'DESCEND',
  ];
  const terminal = ['LOST', 'LANDED', 'INFERRED'];
  const ids = () =>
    h.entries.get('radiosondes').map((e) => e.id.replace('sonde:', ''));
  assert.deepEqual(ids(), [...aloft, ...terminal]);
  const entries = h.entries.get('radiosondes');
  assert.ok(
    entries.every(
      (entry, i) => i === 0 || entries[i - 1].priority > entry.priority,
    ),
  );
  for (const entry of entries) {
    assert.equal(entry.collisionGroup, 'ambient-label');
    assert.equal(entry.gapPx, 12);
    assert.equal(
      entry.stateless,
      true,
      'the host must reject colliding incumbents',
    );
  }
});

test('above 1,500 km terminal labels disappear immediately while all muted terminal icons stay drawn', (t) => {
  const h = harness(t);
  for (const delta of [-130000, -65000, 0]) {
    h.event({
      type: 'frames',
      ...snap([{ ...raw('LANDED', start + delta, 100), vVelMps: 0 }]),
    });
  }
  h.event({
    type: 'frames',
    ...snap([
      { ...raw('ASCEND', start, 10000), vVelMps: 5 },
      { ...raw('DESCEND', start, 30000), vVelMps: -5 },
      { ...raw('LOST', start - 11 * 60000, 45000), vVelMps: 5 },
      { ...raw('INFERRED', start - 11 * 60000, 100), vVelMps: 0 },
    ]),
  });
  const aloft = ['ASCEND', 'DESCEND'];
  const terminal = ['LOST', 'LANDED', 'INFERRED'];
  const ids = () =>
    h.entries.get('radiosondes').map((e) => e.id.replace('sonde:', ''));
  const sprites = h.viewer.scene.primitives.get(0);
  const originals = Array.from({ length: sprites.length }, (_, i) =>
    sprites.get(i),
  );
  for (const height of [
    7_000_000, 1_500_001, 1_500_000, 1_499_999, 7_000_000,
  ]) {
    h.viewer.camera.positionCartographic.height = height;
    h.viewer.camera.moveEnd.raiseEvent();
    assert.deepEqual(
      ids(),
      height > 1_500_000 ? aloft : [...aloft, ...terminal],
    );
    assert.equal(sprites.length, originals.length);
    for (let i = 0; i < sprites.length; i++) {
      const sprite = sprites.get(i);
      assert.equal(sprite, originals[i]);
      assert.equal(
        sprite.show,
        true,
        `${sprite.id} remains drawn at ${height} m`,
      );
      if (terminal.includes(sprite.id.replace('radiosonde:', '')))
        assert.ok(
          Math.abs(spriteAlpha(sprite) - 0.55) < 1e-6,
          'historical icons stay muted',
        );
    }
  }
});

test('ambient candidates fill 150 slots, with host declutter owning spacing and tick/burst reservations', async (t) => {
  const cap = policy.RADIOSONDE_LABEL_CANDIDATE_CAP;
  const candidates = Array.from({ length: cap + 20 }, (_, i) => ({
    ...raw(
      `LABEL${String(i).padStart(3, '0')}`,
      start,
      30000 - Math.floor(i / 2) * 100,
    ),
    lon: 10 + (i % 17) / 20,
    lat: 40 + Math.floor(i / 17) / 20,
    vVelMps: 5,
  })).reverse(); // Input order is deliberately opposite the serial tie-break.
  const selected = {
    ...raw('SELECTED', start, 35000),
    lon: 14,
    lat: 43,
    vVelMps: -5,
  };
  const history = [
    { ...selected, timeMs: start - 60000, altM: 40000 },
    selected,
  ];
  const h = harness(
    t,
    { getHistory: async () => ({ track: history }) },
    {
      project: (_scene, p) => {
        const c = Cesium.Cartographic.fromCartesian(p);
        return {
          x: 100 + (Cesium.Math.toDegrees(c.longitude) - 10) * 200,
          y: 100 + (Cesium.Math.toDegrees(c.latitude) - 40) * 200,
        };
      },
    },
  );
  h.event({ type: 'snapshot', ...snap([...candidates, selected]) });
  const labelIds = (n) =>
    Array.from(
      { length: n },
      (_, i) => `sonde:LABEL${String(i).padStart(3, '0')}`,
    );
  assert.deepEqual(
    h.entries.get('radiosondes').map((e) => e.id),
    labelIds(cap),
  );
  h.click('radiosonde:SELECTED');
  await settle();
  const entries = h.entries.get('radiosondes');
  assert.equal(entries.length, cap);
  assert.deepEqual(
    entries.map((e) => e.id),
    [
      'sonde-burst:SELECTED',
      'sonde-altitude:SELECTED:10000',
      'sonde-altitude:SELECTED:20000',
      'sonde-altitude:SELECTED:30000',
      ...labelIds(cap - 4),
    ],
  );
  assert.ok(entries[0].priority > entries[1].priority);
  assert.ok(entries[3].priority > entries[4].priority);
  assert.ok(
    entries
      .slice(4)
      .every(
        (entry, i, list) => i === 0 || list[i - 1].priority > entry.priority,
      ),
  );
  h.click(null);
  assert.deepEqual(
    h.entries.get('radiosondes').map((e) => e.id),
    labelIds(cap),
  );
});

for (const mode of ['unchanged snapshot', 'failed snapshot', 'fresh stream']) {
  test(`periodic refresh classifies silent fixes and retains both terminal sprites/labels with only clock changes (${mode})`, async (t) => {
    const frames = [
      { ...raw('LOWSONDE', start, 104), vVelMps: 0.05 },
      { ...raw('HIGHSONDE', start, 18000), vVelMps: -5 },
    ];
    let reads = 0;
    const h = harness(t, {
      getSnapshot: async () => {
        reads++;
        if (mode === 'failed snapshot') throw new Error('synthetic offline');
        return snap(frames);
      },
    });
    h.event({ type: 'snapshot', ...snap(frames) });
    await settle();
    const sprites = h.viewer.scene.primitives.get(0);
    const lines = h.viewer.scene.primitives.get(1);
    const counts = () => h.layer.getRowControls().legend.map((e) => e.count);
    const refreshAt = async (clock) => {
      h.setNow(clock);
      if (mode === 'fresh stream')
        h.event({ type: 'status', upstream: 'live', lastFrameMs: clock });
      await h.layer.update(h.viewer);
    };
    assert.deepEqual(counts(), [0, 1, 1, 0, 0]);
    await refreshAt(start + 600000);
    assert.deepEqual(counts(), [0, 1, 1, 0, 0]);
    await refreshAt(start + 600001);
    assert.deepEqual(counts(), [0, 0, 1, 1]);
    assert.equal(h.layer.getStats().count, 0);
    assert.deepEqual(
      h.layer.getRowControls().legend.map((e) => e.label),
      ['Ascending', 'Descending', 'Landed', 'Signal lost'],
    );
    assert.equal(
      h.layer.getRowControls().info,
      mode === 'failed snapshot'
        ? 'Reconnecting to SondeHub…'
        : 'Next launch window 11:00–12:00 UTC · in 2h',
    );
    const marks = () =>
      Array.from({ length: sprites.length }, (_, i) => sprites.get(i));
    const low = marks().find((s) => s.id === 'radiosonde:LOWSONDE');
    const lost = marks().find((s) => s.id === 'radiosonde:HIGHSONDE');
    assert.equal(
      Math.round(Cesium.Cartographic.fromCartesian(low.position).height),
      123,
    );
    assert.equal(
      Math.round(Cesium.Cartographic.fromCartesian(lost.position).height),
      18030,
    );
    assert.equal(spriteAlpha(low), 0.55);
    assert.equal(spriteAlpha(lost), 0.55);
    const art = JSON.parse(decodeURIComponent(lost.image.split(',')[1]));
    assert.equal(
      art.operations.filter((op) => op.op === 'bezierCurveTo').length,
      4,
    );
    assert.equal(
      art.operations.some((op) => op.op === 'fill'),
      false,
      'signal loss retains a hollow balloon silhouette',
    );
    assert.deepEqual(
      h.entries.get('radiosondes').map((e) => e.title),
      ['HIGHSONDE lost', 'LOWSONDE landed'],
    );
    assert.ok(
      Array.from({ length: lines.length }, (_, i) => lines.get(i)).every(
        (line) => !line.show,
      ),
    );
    for (const [serial, wording] of [
      ['LOWSONDE', 'Landed (inferred)'],
      ['HIGHSONDE', 'Signal lost'],
    ]) {
      h.click(`radiosonde:${serial}`);
      await settle();
      const card = h.entries.get('radiosondes-selected')[0];
      assert.equal(card.details[0], `${wording} · last fix 10m ago`);
      assert.match(card.details.join('\n'), /last fix 10m ago/);
      assert.equal(h.entries.get('radiosondes').length, 1);
      assert.deepEqual(
        counts(),
        [0, 0, 1, 1],
        'selection changes visibility, not classification',
      );
      h.click(null);
    }
    await refreshAt(start + 3600000);
    assert.equal(sprites.length, 2);
    await refreshAt(start + 3600001);
    assert.equal(sprites.length, 2);
    assert.deepEqual(counts(), [0, 0, 1, 1]);
    for (const serial of ['LOWSONDE', 'HIGHSONDE']) {
      h.click(`radiosonde:${serial}`);
      await settle();
      assert.equal(sprites.length, 2);
      assert.equal(sprites.get(0).show, true);
      assert.equal(spriteAlpha(sprites.get(0)), 0.55);
      h.setHorizon(false);
      h.viewer.camera.moveEnd.raiseEvent();
      assert.equal(sprites.get(0).show, false);
      h.setHorizon(true);
      h.click(null);
      assert.equal(sprites.length, 2);
    }
    assert.equal(reads, mode === 'fresh stream' ? 0 : 4);
    h.setNow(start + 3601000);
    h.event({
      type: 'frames',
      ...snap(
        frames.map((frame) => ({
          ...frame,
          timeMs: start + 3601000,
          vVelMps: 5,
        })),
      ),
    });
    assert.deepEqual(
      counts(),
      [2, 0, 0, 0],
      'fresh telemetry revives both records',
    );
    assert.equal(sprites.length, 2);
    assert.ok(marks().every((mark) => spriteAlpha(mark) === 0.95));
    assert.equal(
      h.entries.get('radiosondes')[0].title,
      'HIGHSONDE ↑ 18.0\u00a0km',
    );
  });
}

test('cold snapshots classify old fixes even with fresh receipts and draw/label every retained phase', async (t) => {
  const frames = [
    { ...raw('LOWRECENT', start - 11 * 60000, 104), vVelMps: 0.05 },
    { ...raw('HIGHRECENT', start - 11 * 60000, 18240), vVelMps: 5 },
    { ...raw('LOWOLD', start - 61 * 60000, 104), vVelMps: -5 },
    { ...raw('HIGHOLD', start - 61 * 60000, 18240), vVelMps: 0 },
    raw('LOWUNKNOWN', start - 11 * 60000, 104),
  ].map((fix) => ({ ...fix, receivedMs: start }));
  const h = harness(t, { getSnapshot: async () => snap(frames) });
  await h.layer.update(h.viewer);
  assert.deepEqual(
    h.layer.getRowControls().legend.map((e) => e.count),
    [0, 0, 2, 3],
  );
  assert.equal(h.layer.getStats().count, 0);
  assert.equal(h.viewer.scene.primitives.get(0).length, 5);
  assert.equal(h.entries.get('radiosondes').length, 5);
  h.click('radiosonde:LOWOLD');
  await settle();
  assert.match(
    h.entries.get('radiosondes-selected')[0].details[0],
    /^Landed \(inferred\)/,
  );
  assert.match(
    h.entries.get('radiosondes-selected')[0].details.join('\n'),
    /last fix 1h ago/,
  );
});

test('a selected descending sonde loses its arrow, scale and burst labels on clock-only signal loss', async (t) => {
  const fix = { ...raw('TEST123', start, 18240), vVelMps: -5 };
  const history = [{ ...fix, timeMs: start - 60000, altM: 35000 }, fix];
  const h = harness(t, {
    getSnapshot: async () => {
      throw new Error('synthetic offline');
    },
    getHistory: async () => ({ track: history }),
  });
  h.event({ type: 'snapshot', ...snap([fix]) });
  h.click('radiosonde:TEST123');
  await settle();
  const sprite = h.viewer.scene.primitives.get(0).get(0);
  const line = h.viewer.scene.primitives.get(1).get(0);
  const burst = h.viewer.scene.primitives.get(2).get(0);
  assert.equal(h.entries.get('radiosondes').length, 4);
  assert.equal(line.show, true);
  assert.equal(burst.show, true);
  assert.match(
    h.entries.get('radiosondes-selected')[0].details[0],
    /^Descending/,
  );
  h.setNow(start + 600001);
  await h.layer.update(h.viewer);
  assert.match(
    h.entries.get('radiosondes-selected')[0].details[0],
    /^Signal lost · last fix 10m ago$/,
  );
  assert.match(
    h.entries.get('radiosondes-selected')[0].details.join('\n'),
    /last fix 10m ago/,
  );
  assert.deepEqual(
    h.layer.getRowControls().legend.map((e) => e.count),
    [0, 0, 0, 1],
  );
  assert.equal(h.entries.get('radiosondes').length, 0);
  assert.equal(line.show, false);
  assert.equal(burst.show, false);
  assert.equal(spriteAlpha(sprite), 0.55);
  assert.equal(
    Math.round(Cesium.Cartographic.fromCartesian(sprite.position).height),
    18270,
  );
  h.setNow(start + 3600001);
  await h.layer.update(h.viewer);
  assert.equal(sprite.show, true);
  assert.match(
    h.entries.get('radiosondes-selected')[0].details.join('\n'),
    /last fix 1h ago/,
  );
  h.click(null);
  assert.equal(h.viewer.scene.primitives.get(0).length, 1);
});

test('selected altitude scale marks only lower 10 km steps and follows the drop line, horizon and lifecycle', async (t) => {
  const h = harness(t);
  h.event({ type: 'snapshot', ...snap([raw('TEST123', start, 20000)]) });
  const ticks = () =>
    h.entries
      .get('radiosondes')
      ?.filter((entry) => entry.id.startsWith('sonde-altitude:')) ?? [];
  assert.equal(ticks().length, 0);
  h.click('radiosonde:TEST123');
  await settle();
  assert.deepEqual(
    ticks().map((entry) => entry.title),
    ['─ 10\u00a0km'],
  );
  h.setNow(start + 10000);
  h.event({ type: 'frames', ...snap([raw('TEST123', start + 10000, 35000)]) });
  assert.deepEqual(
    ticks().map((entry) => entry.title),
    ['─ 10\u00a0km', '─ 20\u00a0km', '─ 30\u00a0km'],
  );
  h.setNow(start + 20000);
  h.event({ type: 'frames', ...snap([raw('TEST123', start + 20000, 6100)]) });
  const heights = ticks().map(
    (entry) => Cesium.Cartographic.fromCartesian(entry.position).height,
  );
  assert.deepEqual(heights.map(Math.round), [10030, 20030, 30030]);
  const scalePositions = h.viewer.scene.primitives.get(1).get(0).positions;
  const tickPosition = ticks()[0].position;
  h.event({ type: 'frames', ...snap([raw('TEST123', start + 20000, 6100)]) });
  assert.equal(
    h.viewer.scene.primitives.get(1).get(0).positions,
    scalePositions,
    'unchanged fixes retain the scale geometry',
  );
  assert.equal(ticks()[0].position, tickPosition);
  assert.equal(
    Math.round(
      Cesium.Cartographic.fromCartesian(
        h.viewer.scene.primitives.get(1).get(0).positions.at(-1),
      ).height,
    ),
    35030,
    'the selected scale extends to the observed burst altitude',
  );
  assert.deepEqual(h.trails[0].options, { fade: false, drape: false });
  assert.equal(h.trails[0].style, '#ff8fb1');
  assert.ok(
    ticks().every(
      (entry) =>
        entry.variant === 'label' && entry.horizonCull && !entry.interactive,
    ),
  );
  assert.ok(h.entries.get('radiosondes').length <= 12);
  const calls = h.calls.length;
  h.viewer.scene.postRender.raiseEvent();
  assert.equal(h.calls.length, calls, 'ticks add no animation loop');
  h.setHorizon((p) => Cesium.Cartographic.fromCartesian(p).height < 15000);
  h.viewer.camera.moveEnd.raiseEvent();
  assert.deepEqual(
    ticks().map((entry) => entry.title),
    ['─ 10\u00a0km'],
  );
  h.setHorizon(false);
  h.viewer.camera.moveEnd.raiseEvent();
  assert.equal(ticks().length, 0);
  h.setHorizon(true);
  h.viewer.camera.positionCartographic.height = 3400000;
  h.viewer.camera.moveEnd.raiseEvent();
  assert.equal(ticks().length, 0);
  h.viewer.camera.positionCartographic.height = 2600000;
  h.viewer.camera.moveEnd.raiseEvent();
  assert.equal(ticks().length, 3);
  h.click(null);
  assert.equal(ticks().length, 0);
  h.layer.disable();
  assert.equal(h.entries.has('radiosondes'), false);
});

test('altitude sprites, culling, drop-line band, selected trail, burst and mono styling use discrete renders', async (t) => {
  const h = harness(t);
  await h.layer.update(h.viewer);
  await settle();
  const spriteCollection = h.viewer.scene.primitives.get(0),
    lines = h.viewer.scene.primitives.get(1),
    points = h.viewer.scene.primitives.get(2);
  const sprite = spriteCollection.get(0);
  assert.equal(sprite.disableDepthTestDistance, Infinity);
  assert.ok(
    Math.abs(
      Cesium.Cartographic.fromCartesian(sprite.position).height - 10030,
    ) < 0.01,
  );
  assert.equal(lines.get(0).show, true);
  assert.equal(h.credits.length, 1);
  assert.equal(h.owners.size, 1);
  h.click('radiosonde:TEST123');
  await settle();
  assert.equal(h.focus[0].kind, 'radiosonde');
  assert.deepEqual(h.trails[0].options, { fade: false, drape: false });
  assert.equal(h.entries.get('radiosondes-selected').length, 1);
  h.setNow(start + 10000);
  h.event({ type: 'frames', ...snap([raw('TEST123', start + 10000, 9700)]) });
  assert.equal(points.get(0).show, true);
  assert.ok(
    h.entries.get('radiosondes').some((e) => e.title.startsWith('BURST')),
  );
  h.setHorizon(false);
  h.viewer.camera.moveEnd.raiseEvent();
  assert.equal(sprite.show, false);
  assert.equal(lines.get(0).show, false);
  assert.equal(points.get(0).show, false);
  assert.equal(h.trails[0].visible, false);
  h.setHorizon(true);
  h.viewer.camera.positionCartographic.height = 3_400_000;
  h.viewer.camera.moveEnd.raiseEvent();
  assert.equal(lines.get(0).show, false);
  window.dispatchEvent(
    new CustomEvent('gev:vision-change', { detail: { style: 'thermal' } }),
  );
  assert.match(sprite.image, /FFFFFF/i);
  assert.equal(h.trails[0].style, '#FFFFFF');
  const count = h.calls.length;
  h.viewer.scene.postRender.raiseEvent();
  assert.equal(h.calls.length, count);
  h.click('other:aircraft');
  assert.equal(h.entries.get('radiosondes-selected').length, 1);
  h.click(null);
  assert.equal(h.entries.get('radiosondes-selected')?.length ?? 0, 0);
  assert.equal(h.trails[0].destroyed, true);
  assert.ok(h.calls.includes('radiosondes-flush'));
  h.layer.disable();
  assert.equal(h.closes(), 1);
  assert.equal(h.credits.length, 0);
  assert.equal(h.owners.size, 0);
  for (const id of ['radiosondes', 'radiosondes-selected']) {
    assert.equal(h.entries.has(id), false);
    assert.equal(h.visible.get(id), false);
  }
  assert.equal(h.viewer.camera.moveEnd.numberOfListeners, 0);
  h.event({ type: 'frames', ...snap() });
  assert.equal(h.layer.getStats().count, 0);
});
test('late snapshot, track and history are aborted/ignored after disable or deselection', async (t) => {
  let resolveSnapshot, signal;
  const h = harness(t, {
    getSnapshot: ({ signal: s }) => {
      signal = s;
      return new Promise((r) => (resolveSnapshot = r));
    },
  });
  const pending = h.layer.update(h.viewer);
  h.layer.disable();
  h.layer.enable();
  resolveSnapshot(snap());
  assert.equal(await pending, false);
  assert.equal(signal.aborted, true);
  assert.equal(h.layer.getStats().count, 0);
  const deferred = [];
  const h2 = harness(t, {
    getTrack: ({ signal }) =>
      new Promise((resolve) => deferred.push({ resolve, signal })),
  });
  h2.event({ type: 'snapshot', ...snap([raw(), raw('OTHER123')]) });
  h2.click('radiosonde:TEST123');
  h2.click('radiosonde:OTHER123');
  assert.equal(deferred[0].signal.aborted, true);
  deferred[0].resolve({ track: [{ ...raw(), altM: 40000 }] });
  await settle();
  assert.equal(
    h2.entries.get('radiosondes-selected')[0].title,
    'BALLOON · OTHER123',
  );
  assert.equal(h2.trails[0].destroyed, true);
});
test('unavailable startup stays enabled; stale/recovery/empty states and polling-only reads are honest', async (t) => {
  let fail = true,
    calls = 0;
  const h = harness(t, {
    subscribe: undefined,
    getSnapshot: async () => {
      calls++;
      if (fail) throw Error('SondeHub HTTP 502');
      return snap();
    },
  });
  assert.equal(await h.layer.update(h.viewer), true);
  assert.equal(layerFeedState(h.layer.getStats()), 'unavailable');
  assert.equal(h.layer.getRowControls().info, 'Reconnecting to SondeHub…');
  fail = false;
  await h.layer.update(h.viewer);
  assert.equal(calls, 2);
  assert.equal(layerFeedState(h.layer.getStats()), 'nominal');
  assert.equal(h.layer.getRowControls().info, nextLaunch);
  h.setNow(start + 300001);
  assert.equal(h.layer.getStats().stale, true);
  const pushed = harness(t);
  pushed.event({ type: 'snapshot', ...snap() });
  pushed.state('closed');
  assert.equal(pushed.layer.getStats().stale, true);
  assert.equal(pushed.layer.getStats().lastUpdate, start);
  pushed.state('open');
  pushed.event({ type: 'snapshot', ...snap([]) });
  assert.equal(pushed.layer.getStats().status, 'empty');
  assert.equal(pushed.layer.getStats().error, null);
  assert.equal(pushed.layer.getRowControls().info, noneAloft);
});

test('row info gives connection status priority over empty and loaded launch guidance', (t) => {
  for (const frames of [[], [raw()]]) {
    const h = harness(t);
    assert.equal(h.layer.getRowControls().info, 'Reconnecting to SondeHub…');
    h.event({ type: 'snapshot', ...snap(frames) });
    const ready = frames.length ? nextLaunch : noneAloft;
    assert.equal(h.layer.getRowControls().info, ready);
    h.event({ type: 'status', upstream: 'unavailable' });
    assert.equal(
      h.layer.getRowControls().info,
      'Live feed unavailable on this server',
    );
    h.state('connecting');
    assert.equal(
      h.layer.getRowControls().info,
      'Live feed unavailable on this server',
    );
    h.event({ type: 'status', upstream: 'live' });
    assert.equal(h.layer.getRowControls().info, 'Reconnecting to SondeHub…');
    h.state('open');
    assert.equal(h.layer.getRowControls().info, ready);
    h.event({ type: 'status', upstream: 'degraded' });
    assert.equal(h.layer.getRowControls().info, 'Reconnecting to SondeHub…');
    h.event({ type: 'status', upstream: 'live' });
    const controls = h.layer.getRowControls();
    assert.equal(controls.info, ready);
    assert.deepEqual(h.layer.getRowControls(), controls);
  }
});

test('history for a deselected sonde cannot publish, and selection eviction clears the path', async (t) => {
  let complete, historySignal;
  const h = harness(t, {
    getHistory: ({ signal }) => {
      historySignal = signal;
      return new Promise((resolve) => (complete = resolve));
    },
  });
  await h.layer.update(h.viewer);
  h.click('radiosonde:TEST123');
  await settle();
  const trail = h.trails[0];
  h.click(null);
  assert.equal(historySignal.aborted, true);
  complete({ track: [{ ...raw(), altM: 40000 }] });
  await settle();
  assert.equal(trail.destroyed, true);
  assert.equal(h.entries.get('radiosondes-selected')?.length ?? 0, 0);
  h.click('radiosonde:TEST123');
  await settle();
  h.event({ type: 'snapshot', ...snap([]) });
  assert.equal(h.trails[1].destroyed, true);
  assert.equal(h.entries.get('radiosondes-selected')?.length ?? 0, 0);
});

test('unchanged snapshots retain primitives and row controls while fresh streams skip polling', async (t) => {
  let reads = 0;
  const h = harness(t, {
    getSnapshot: async () => {
      reads++;
      return snap();
    },
  });
  await h.layer.update(h.viewer);
  const sprite = h.viewer.scene.primitives.get(0).get(0);
  const controls = h.layer.getRowControls();
  h.event({ type: 'snapshot', ...snap() });
  assert.equal(h.viewer.scene.primitives.get(0).get(0), sprite);
  await h.layer.update(h.viewer);
  assert.equal(reads, 1);
  assert.equal(controls.info, nextLaunch);
  assert.deepEqual(h.layer.getRowControls(), controls);
  assert.equal(h.layer.getStats().loadingLabel, 'LIVE · updated <1m ago');
  h.layer.disable();
  assert.equal(h.layer.getStats().stale, false);
});

test('the flight-style render budget admits more than 600 contacts; disable cannot resurrect a burst marker', async (t) => {
  const frames = Array.from({ length: 601 }, (_, i) => raw(`CAP${i}`));
  const h = harness(t, { getSnapshot: async () => snap(frames) });
  await h.layer.update(h.viewer);
  assert.equal(h.viewer.scene.primitives.get(0).length, 601);
  assert.equal(h.layer.getStats().count, 601);
  assert.equal(h.layer.getStats().countLabel, undefined);
  h.click('radiosonde:CAP0');
  h.setNow(start + 10000);
  h.event({ type: 'frames', ...snap([raw('CAP0', start + 10000, 9700)]) });
  const burst = h.viewer.scene.primitives.get(2).get(0);
  assert.equal(burst.show, true);
  h.layer.disable();
  h.layer.enable();
  assert.equal(burst.show, false);
});

test('stationary histories skip degenerate edges instead of staging an empty primitive forever', async (t) => {
  const track = [-120000, -60000, 0].map((delta) =>
    raw('TEST123', start + delta),
  );
  const h = harness(t, { getTrack: async () => ({ track }) });
  await h.layer.update(h.viewer);
  h.click('radiosonde:TEST123');
  await settle();
  assert.deepEqual(h.trails[0].history.segments, []);
  assert.equal(h.viewer.scene.postRender.numberOfListeners, 0);
});

for (const outcome of ['success', 'failure']) {
  test(`a late HTTP ${outcome} cannot replace equal-timestamp SSE contacts, selection or metadata`, async (t) => {
    let resolve, reject;
    const h = harness(t, {
      getSnapshot: () =>
        new Promise((yes, no) => {
          resolve = yes;
          reject = no;
        }),
    });
    h.event({ type: 'snapshot', ...snap() });
    h.state('connecting');
    const pending = h.layer.update(h.viewer);
    // B is a new serial with the same maximum receipt time as snapshot A.
    h.event({ type: 'frames', ...snap([raw('OTHER123')]) });
    h.state('open');
    h.click('radiosonde:OTHER123');
    await settle();
    const stats = h.layer.getStats();
    const controls = h.layer.getRowControls();
    const trail = h.trails[0];
    if (outcome === 'success') resolve(snap([raw()], 'degraded'));
    else reject(Error('late HTTP failure'));
    assert.equal(await pending, true);
    assert.equal(h.layer.getStats().count, 2);
    assert.deepEqual(h.layer.getStats(), stats);
    assert.deepEqual(h.layer.getRowControls(), controls);
    assert.equal(
      h.entries.get('radiosondes-selected')[0].title,
      'BALLOON · OTHER123',
    );
    assert.equal(trail.destroyed, false);
    assert.equal(h.viewer.scene.primitives.get(0).length, 2);
  });
}

test('an obsolete snapshot cannot change feed metadata before it is rejected', (t) => {
  const h = harness(t);
  h.event({ type: 'snapshot', ...snap() });
  const stats = h.layer.getStats();
  const controls = h.layer.getRowControls();
  h.event({
    type: 'snapshot',
    ...snap([], 'unavailable'),
    fetchedAt: start - 1,
  });
  assert.deepEqual(h.layer.getStats(), stats);
  assert.deepEqual(h.layer.getRowControls(), controls);
});

test('a rejected obsolete push cannot supersede a newer HTTP snapshot still in flight', async (t) => {
  let finish;
  const h = harness(t, {
    getSnapshot: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  h.event({ type: 'snapshot', ...snap() });
  h.state('connecting');
  const pending = h.layer.update(h.viewer);
  h.event({
    type: 'snapshot',
    ...snap([], 'unavailable'),
    fetchedAt: start - 1,
  });
  h.setNow(start + 1000);
  finish(snap([raw('NEWER', start + 1000)]));
  assert.equal(await pending, true);
  assert.equal(h.layer.getStats().error, null);
  assert.equal(h.viewer.scene.primitives.get(0).length, 1);
  assert.equal(h.viewer.scene.primitives.get(0).get(0).id, 'radiosonde:NEWER');
});

for (const transport of ['missing', 'throws']) {
  test(`the actual source reports healthy polling when EventSource ${transport}`, async (t) => {
    let answer = snap(),
      fail = false;
    const source = createRadiosondeSource({
      EventSourceImpl:
        transport === 'missing'
          ? null
          : class {
              constructor() {
                throw Error('no EventSource');
              }
            },
      now: () => start,
      fetchImpl: async () =>
        new Response(JSON.stringify(answer), { status: fail ? 502 : 200 }),
    });
    const h = harness(t, source);
    await h.layer.update(h.viewer);
    assert.equal(layerFeedState(h.layer.getStats()), 'nominal');
    assert.equal(h.layer.getStats().stale, false);
    assert.equal(h.layer.getRowControls().info, nextLaunch);
    answer = snap([raw()], 'degraded');
    await h.layer.update(h.viewer);
    assert.equal(h.layer.getStats().stale, true);
    fail = true;
    await h.layer.update(h.viewer);
    assert.equal(layerFeedState(h.layer.getStats()), 'degraded');
    assert.equal(h.layer.getStats().stale, false);
    assert.equal(h.layer.getStats().count, 1);
    fail = false;
    answer = snap();
    await h.layer.update(h.viewer);
    assert.equal(layerFeedState(h.layer.getStats()), 'nominal');
    assert.equal(h.layer.getRowControls().info, nextLaunch);
    h.setNow(start + 300001);
    assert.equal(h.layer.getStats().stale, true);
  });
}

test('history acquired after enabling on a landed sonde updates cards, counts, sprites and drop lines together', async (t) => {
  const track = [-130000, -65000, 0].map((delta) =>
    raw('TEST123', start + delta, 1000),
  );
  let resolveHistory;
  const h = harness(t, {
    getSnapshot: async () => snap([raw('TEST123', start, 1000)]),
    getHistory: () =>
      new Promise((resolve) => {
        resolveHistory = resolve;
      }),
  });
  await h.layer.update(h.viewer);
  await settle();
  const sprite = h.viewer.scene.primitives.get(0).get(0);
  const line = h.viewer.scene.primitives.get(1).get(0);
  assert.equal(h.layer.getStats().count, 1);
  assert.equal(line.show, true);
  h.click('radiosonde:TEST123');
  await settle();
  h.setNow(start + 1000);
  h.event({ type: 'frames', ...snap([raw('TEST123', start + 1000, 1000)]) });
  resolveHistory({ track });
  await settle();
  const assertLanded = () => {
    assert.equal(h.layer.getStats().count, 0);
    assert.deepEqual(
      h.layer.getRowControls().legend.map((l) => l.count),
      [0, 0, 1, 0],
    );
    assert.ok(
      Math.abs(
        Cesium.Cartographic.fromCartesian(sprite.position).height - 123,
      ) < 0.01,
    );
    assert.equal(spriteAlpha(sprite), 0.55);
    assert.equal(line.show, false);
  };
  assert.match(h.entries.get('radiosondes-selected')[0].details[0], /Landed/);
  assertLanded();
  h.click(null);
  assertLanded();
  h.click('radiosonde:TEST123');
  await settle();
  assertLanded();
  h.setNow(start + 2000);
  h.event({ type: 'frames', ...snap([raw('TEST123', start + 2000, 1000)]) });
  assertLanded();
});

test('selecting a sonde already observed landed retains its shared surface treatment', async (t) => {
  const h = harness(t);
  for (const delta of [-130000, -65000, 0])
    h.event({ type: 'frames', ...snap([raw('TEST123', start + delta, 1000)]) });
  assert.equal(h.layer.getStats().count, 0);
  h.click('radiosonde:TEST123');
  await settle();
  assert.match(h.entries.get('radiosondes-selected')[0].details[0], /Landed/);
  assert.equal(
    h.layer.getRowControls().legend.find(({ label }) => label === 'Landed')
      .count,
    1,
  );
  assert.equal(h.viewer.scene.primitives.get(1).get(0).show, false);
});

test('enable reads the current vision style and re-enable resynchronizes changes made while disabled', async (t) => {
  let style = 'thermal';
  const h = harness(t, {}, { getVisionStyle: () => style });
  await h.layer.update(h.viewer);
  let sprite = h.viewer.scene.primitives.get(0).get(0);
  assert.match(sprite.image, /FFFFFF/i);
  assert.equal(sprite.scale, 1.3);
  h.layer.disable();
  style = 'retro';
  window.dispatchEvent(
    new CustomEvent('gev:vision-change', { detail: { style } }),
  );
  h.layer.enable();
  await h.layer.update(h.viewer);
  sprite = h.viewer.scene.primitives.get(0).get(0);
  assert.match(sprite.image, /ff8fb1/i);
  assert.equal(sprite.scale, 1.3);
  h.layer.disable();
  style = 'normal';
  h.layer.enable();
  await h.layer.update(h.viewer);
  assert.equal(h.viewer.scene.primitives.get(0).get(0).scale, 1);
});

test('the default vision getter reads the published effective cockpit style before first enable', async (t) => {
  const { VisualSettings } = await import('../../ui/visualSettings.js');
  const dataset = document.documentElement.dataset;
  t.after(() => {
    delete dataset.gevVisionStyle;
    delete dataset.gevStyle;
  });
  dataset.gevStyle = 'retro';
  VisualSettings.prototype._syncIrBoost.call({
    activeStyle: 'retro',
    cockpitView: { active: true },
    _cockpitVisionMode: 'thermal',
  });
  const h = harness(t);
  await h.layer.update(h.viewer);
  const sprite = h.viewer.scene.primitives.get(0).get(0);
  assert.match(sprite.image, /FFFFFF/i);
  assert.equal(sprite.scale, 1.3);
});

test('nonempty trail staging requests renders until ready, then stops and cancels on deselection, disable and destroy', async (t) => {
  const track = [raw('TEST123', start - 60000, 9000), raw()];
  const h = harness(
    t,
    { getHistory: async () => ({ track }) },
    { trailReady: false },
  );
  await h.layer.update(h.viewer);
  h.click('radiosonde:TEST123');
  await settle();
  const trail = h.trails[0];
  assert.ok(trail.history.segments.length > 0);
  assert.equal(trail.diagnostics().body.ready, false);
  assert.equal(trail.shown, false);
  assert.equal(h.viewer.scene.postRender.numberOfListeners, 1);
  assert.ok(h.calls.includes('radiosondes-flush'));
  for (let i = 0; i < 3; i++) {
    const calls = h.calls.length,
      displays = trail.displayCalls;
    h.viewer.scene.postRender.raiseEvent();
    assert.equal(h.calls.length, calls + 1);
    assert.equal(h.calls.at(-1), 'radiosondes-trail-staging');
    assert.equal(trail.displayCalls, displays + 1);
    assert.equal(h.viewer.scene.postRender.numberOfListeners, 1);
  }
  const supersededBody = trail.diagnostics().body;
  h.setNow(start + 1000);
  h.event({ type: 'frames', ...snap([raw('TEST123', start + 1000, 10100)]) });
  assert.notEqual(trail.diagnostics().body, supersededBody);
  supersededBody.ready = true;
  h.viewer.scene.postRender.raiseEvent();
  assert.equal(trail.shown, false);
  assert.equal(h.viewer.scene.postRender.numberOfListeners, 1);
  const beforeReady = h.calls.length;
  trail.diagnostics().body.ready = true;
  h.viewer.scene.postRender.raiseEvent();
  assert.equal(trail.shown, true);
  assert.equal(h.viewer.scene.postRender.numberOfListeners, 0);
  assert.equal(h.calls.length, beforeReady + 1);
  assert.equal(h.calls.at(-1), 'radiosondes-trail-ready');
  const calls = h.calls.length,
    displays = trail.displayCalls;
  h.viewer.scene.postRender.raiseEvent();
  assert.equal(h.calls.length, calls);
  assert.equal(trail.displayCalls, displays);
  for (const action of ['deselect', 'disable', 'destroy']) {
    h.click('radiosonde:TEST123');
    await settle();
    const staging = h.trails.at(-1);
    assert.equal(staging.diagnostics().body.ready, false);
    assert.equal(h.viewer.scene.postRender.numberOfListeners, 1);
    if (action === 'deselect') h.click(null);
    else h.layer[action]();
    assert.equal(staging.destroyed, true);
    assert.equal(h.viewer.scene.postRender.numberOfListeners, 0);
    const requests = h.calls.length,
      samples = staging.displayCalls;
    staging.diagnostics().body.ready = true;
    h.viewer.scene.postRender.raiseEvent();
    assert.equal(h.calls.length, requests);
    assert.equal(staging.displayCalls, samples);
    if (action === 'disable') {
      h.layer.enable();
      await h.layer.update(h.viewer);
    }
  }
});

test('landed sondes read the cached ground floor; a cold cell resolves once and lifts in place without scene sampling', async (t) => {
  let warm = false;
  let resolves = 0;
  const renders = [];
  const { rendering, primitives } = renderingHarness(t, {
    render: { governorRequestRender: (reason) => renders.push(reason) },
    groundFloor: {
      cachedGroundFloor: () => (warm ? 321 : null),
      resolveGroundFloorCellsBounded: async () => {
        resolves++;
        warm = true;
      },
    },
  });
  const records = new Map([
    ['TEST123', { frame: raw(), phase: 'landed', track: [] }],
  ]);
  rendering.sync(records, null);
  const sprite = primitives.get(0).get(0);
  const height = () =>
    Cesium.Cartographic.fromCartesian(sprite.position).height;
  assert.ok(Math.abs(height()) < 0.01, 'cold cell starts at the geoid');
  await settle();
  assert.equal(resolves, 1);
  assert.ok(Math.abs(height() - 321) < 0.01, 'resolved cell lifts in place');
  assert.equal(primitives.get(0).get(0), sprite);
  assert.ok(renders.includes('radiosondes-ground'));
  rendering.sync(records, null, true);
  await settle();
  assert.equal(resolves, 1, 'warm cells never resolve again');
});
