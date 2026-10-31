import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { layerFeedState } from '../../data/feedState.js';
import { createMessageSignsLayer } from './index.js';
import { FACE_BUDGET } from './faces.js';

const FLOOR_M = 250;
const STALE_DIM = 'rgba(0, 0, 0, 0.5)';
const settle = async () => {
  for (let i = 0; i < 12; i++) await new Promise((done) => setImmediate(done));
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A ground-floor service whose cells stay cold until a test warms them. */
function coldFloors() {
  const warm = new Set();
  const cell = (lat, lon) => `${lat},${lon}`;
  const bounded = [];
  const background = [];
  return {
    bounded,
    background,
    warm(cells) {
      for (const { lat, lon } of cells) warm.add(cell(lat, lon));
    },
    service: {
      cachedGroundFloor: (lat, lon) =>
        warm.has(cell(lat, lon)) ? FLOOR_M : null,
      resolveGroundFloorCellsBounded(cells) {
        const gate = deferred();
        bounded.push({ cells, gate });
        return gate.promise;
      },
      resolveGroundFloorCells(cells, { signal }) {
        const gate = deferred();
        background.push({ cells, signal, gate });
        return gate.promise;
      },
    },
  };
}

function gifBytes(width = 412, height = 100) {
  const bytes = new Uint8Array(32);
  bytes.set([...'GIF89a'].map((c) => c.charCodeAt(0)));
  bytes.set([width & 255, width >> 8, height & 255, height >> 8], 6);
  return bytes;
}

function sign(id, message, { lat = 44.95, lon = -93.2, multi } = {}) {
  return {
    id,
    provider: 'mndot',
    lat,
    lon,
    location: `${id} location`,
    message,
    multi: multi ?? `MESSAGE ${message}[nl]SECOND LINE`,
  };
}

function harness({
  snapshot,
  frames = {},
  missing = new Set(),
  sizes = {},
  reducedMotion = false,
  groundFloor = {
    cachedGroundFloor: () => FLOOR_M,
    resolveGroundFloorCellsBounded: async () => {},
    resolveGroundFloorCells: async () => {},
  },
} = {}) {
  const clock = { now: 1_000_000 };
  const pending = new Map();
  let nextTimer = 1;
  const timers = {
    setTimeout(fn, ms) {
      const id = nextTimer++;
      pending.set(id, { fn, at: clock.now + ms });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
  };
  const advance = async (ms) => {
    clock.now += ms;
    for (const [id, timer] of [...pending]) {
      if (timer.at > clock.now) continue;
      pending.delete(id);
      await timer.fn();
    }
    await settle();
  };

  const entries = new Map();
  const visible = new Map();
  let publishes = 0;
  const overlayHost = {
    setEntries(sourceId, list) {
      publishes += 1;
      entries.set(sourceId, list);
    },
    setVisible(sourceId, value) {
      visible.set(sourceId, value);
    },
    clearSource(sourceId) {
      entries.set(sourceId, []);
    },
    hitTest: () => null,
  };

  const primitives = [];
  const moveEnd = new Set();
  const listeners = new Map();
  const statusNodes = [];
  let renders = 0;
  let picked;
  let click;
  const viewer = {
    isDestroyed: () => false,
    scene: {
      primitives: {
        add(value) {
          primitives.push(value);
          return value;
        },
        remove(value) {
          primitives.splice(primitives.indexOf(value), 1);
        },
      },
      pick: () => picked,
      preRender: { addEventListener: () => () => {} },
    },
    camera: {
      positionCartographic: Cesium.Cartographic.fromDegrees(-93.2, 44.95, 1500),
      positionWC: Cesium.Cartesian3.fromDegrees(-93.2, 44.95, 1500),
      moveEnd: {
        addEventListener(fn) {
          moveEnd.add(fn);
          return () => moveEnd.delete(fn);
        },
      },
    },
  };
  const documentRef = {
    visibilityState: 'visible',
    addEventListener(type, fn) {
      listeners.set(type, fn);
    },
    removeEventListener(type, fn) {
      if (listeners.get(type) === fn) listeners.delete(type);
    },
    createElement() {
      const node = {
        attributes: {},
        textContent: '',
        setAttribute(key, value) {
          this.attributes[key] = value;
        },
        remove() {
          statusNodes.splice(statusNodes.indexOf(node), 1);
        },
      };
      return node;
    },
    body: { appendChild: (node) => statusNodes.push(node) },
  };

  let current = snapshot ?? { signs: [], ageMs: 5000, stale: false };
  const requests = { list: 0, faces: [] };
  // Parked loads: message -> deferred, and `message#frameIndex` -> deferred.
  const faceGates = new Map();
  const decodeGates = new Map();
  const source = {
    async getSnapshot() {
      requests.list += 1;
      if (current instanceof Error) throw current;
      return typeof current === 'function' ? current() : current;
    },
    async getFaceImage(message) {
      requests.faces.push(message);
      const gate = faceGates.get(message);
      faceGates.delete(message);
      if (gate) await gate.promise;
      if (missing.has(message)) throw new Error('MnDOT HTTP 404');
      return gifBytes(...(sizes[message] ?? []));
    },
  };

  const decoders = [];
  class FakeDecoder {
    static async isTypeSupported() {
      return true;
    }
    constructor({ data }) {
      this.frameCount = frames[data.message] ?? 1;
      this.message = data.message;
      this.closed = false;
      this.waiting = new Set();
      this.tracks = {
        ready: Promise.resolve(),
        selectedTrack: { frameCount: this.frameCount },
      };
      decoders.push(this);
    }
    async decode({ frameIndex }) {
      const key = `${this.message}#${frameIndex}`;
      const gate = decodeGates.get(key);
      decodeGates.delete(key);
      if (gate) {
        this.waiting.add(gate);
        try {
          await gate.promise;
        } finally {
          this.waiting.delete(gate);
        }
      }
      if (this.closed) throw new DOMException('Closed', 'InvalidStateError');
      return {
        image: { message: this.message, frameIndex, duration: 1_000_000 },
      };
    }
    close() {
      this.closed = true;
      // As ImageDecoder: closing rejects the decodes still running.
      for (const gate of this.waiting)
        gate.reject(new DOMException('Aborted', 'AbortError'));
    }
  }
  // getFaceImage returns fresh bytes; tag them so the decoder knows which.
  const tagged = source.getFaceImage;
  source.getFaceImage = async (message, options) => {
    const bytes = await tagged(message, options);
    bytes.message = message;
    return bytes;
  };

  const drawn = [];
  const createCanvas = (width, height) => {
    const canvas = {
      width,
      height,
      getContext: () => ({
        imageSmoothingEnabled: true,
        fillStyle: '',
        clearRect() {},
        fillRect() {
          // A fill after a drawn frame is the stale dim over it.
          const last = drawn.findLast((entry) => entry.canvas === canvas);
          if (last) last.fill = this.fillStyle;
        },
        drawImage(image) {
          drawn.push({ canvas, image, fill: null });
        },
        strokeRect() {},
      }),
      toDataURL: () => 'data:image/png;base64,',
    };
    return canvas;
  };

  let pointerFree = true;
  const layer = createMessageSignsLayer({
    source,
    overlayHost,
    picking: {
      resolvePickId: (value) => value?.id ?? null,
      registerPickOwner() {},
      unregisterPickOwner() {},
    },
    pointer: { isPointerFree: () => pointerFree },
    screenSpaceEventHandlerFactory: () => ({
      setInputAction(fn) {
        click = fn;
      },
      destroy() {
        click = null;
      },
    }),
    surface: { groundFloor },
    requestRender: () => {
      renders += 1;
    },
    createCanvas,
    imageEnv: { ImageDecoder: FakeDecoder },
    now: () => clock.now,
    timers,
    documentRef,
    prefersReducedMotion: () => reducedMotion,
  });
  layer.init(viewer);
  layer.enable(viewer);
  return {
    layer,
    viewer,
    clock,
    advance,
    pendingTimers: pending,
    entries,
    faces: () => entries.get('message-signs') ?? [],
    cards: () => entries.get('message-signs-card') ?? [],
    markers: () => primitives[0] ?? null,
    primitives,
    requests,
    drawn,
    decoders,
    listeners,
    statusNodes,
    moveEnd,
    renders: () => renders,
    publishes: () => publishes,
    setSnapshot(value) {
      current = value;
    },
    /** Hold the next getFaceImage for `message` until the test settles it. */
    parkFace(message) {
      const gate = deferred();
      faceGates.set(message, gate);
      return gate;
    },
    /** Hold the next decode of `message`'s frame until the test settles it. */
    parkDecode(message, frameIndex) {
      const gate = deferred();
      decodeGates.set(`${message}#${frameIndex}`, gate);
      return gate;
    },
    set pointerFree(value) {
      pointerFree = value;
    },
    setVisibility(state) {
      documentRef.visibilityState = state;
      listeners.get('visibilitychange')?.();
    },
    click: (position, pick = undefined) => {
      picked = pick;
      click({ position });
    },
    get hostHit() {
      return overlayHost.hitTest;
    },
    set hostHit(fn) {
      overlayHost.hitTest = fn;
    },
  };
}

test('lit signs publish markers and GIF faces with stable labels (AE1)', async () => {
  const h = harness({
    snapshot: {
      signs: [sign('V1', 'msg_00000001'), sign('V2', 'msg_00000002')],
      ageMs: 5000,
      stale: false,
    },
  });
  assert.equal(await h.layer.update(h.viewer), true);
  await settle();

  assert.equal(h.markers().length, 2);
  const height = Cesium.Cartographic.fromCartesian(
    h.markers().get(0).position,
  ).height;
  assert.ok(Math.abs(height - (FLOOR_M + 6)) < 0.01);

  const faces = h.faces();
  assert.equal(faces.length, 2);
  for (const face of faces) {
    assert.equal(face.variant, 'thumbnail');
    assert.equal(face.requireImage, true);
    assert.equal(face.thumbnailWidth, 206);
    assert.equal(face.thumbnailHeight, 50);
    assert.equal(face.thumbnailTitleHeight, 0);
    assert.equal(face.image.stamp, 1);
    assert.equal(face.accessibilityLabel, `Message sign, ${face.id} location`);
  }
  const stats = h.layer.getStats();
  assert.equal(stats.count, 2);
  assert.equal(stats.countLabel, '2 signs lit');
  assert.equal(stats.status, 'ok');
  assert.equal(stats.error, null);
  h.layer.destroy();
});

test('every lit sign gets a marker; only the nearest get faces', async () => {
  const signs = Array.from({ length: 60 }, (_, i) =>
    sign(
      `V${String(i).padStart(2, '0')}`,
      `msg_${String(i).padStart(8, '0')}`,
      {
        lat: 44.95,
        lon: -93.2 + i * 0.01,
      },
    ),
  );
  const h = harness({ snapshot: { signs, ageMs: 0, stale: false } });
  await h.layer.update(h.viewer);
  await settle();
  assert.equal(h.markers().length, 60);
  assert.equal(h.faces().length, FACE_BUDGET);
  assert.ok(h.faces().some((face) => face.id === 'V00'));

  // Fly east: moveEnd re-selects faces without refetching the list.
  h.viewer.camera.positionCartographic = Cesium.Cartographic.fromDegrees(
    -92.61,
    44.95,
    1500,
  );
  for (const fn of h.moveEnd) fn();
  await settle();
  assert.equal(h.requests.list, 1);
  assert.ok(h.faces().some((face) => face.id === 'V59'));
  assert.ok(!h.faces().some((face) => face.id === 'V00'));

  // Statewide: markers stay, faces go.
  h.viewer.camera.positionCartographic = Cesium.Cartographic.fromDegrees(
    -93.2,
    44.95,
    400_000,
  );
  for (const fn of h.moveEnd) fn();
  await settle();
  assert.equal(h.faces().length, 0);
  assert.equal(h.markers().length, 60);
  h.layer.destroy();
});

test('signs on cold ground floors appear once a floor resolve warms them', async () => {
  const snapshot = {
    signs: [sign('V1', 'msg_00000001')],
    ageMs: 0,
    stale: false,
  };
  // The bounded resolve warms the cell before the list is applied.
  let floors = coldFloors();
  let h = harness({ snapshot, groundFloor: floors.service });
  let pending = h.layer.update(h.viewer);
  await settle();
  assert.equal(h.markers(), null);
  assert.equal(h.faces().length, 0);
  floors.warm(floors.bounded[0].cells);
  floors.bounded[0].gate.resolve();
  assert.equal(await pending, true);
  await settle();
  assert.equal(h.markers().length, 1);
  assert.equal(h.faces().length, 1);
  assert.equal(floors.background.length, 0);
  h.layer.destroy();

  // Still cold after it: the list applies without the sign's marker or
  // face, and the background resolve brings them in.
  floors = coldFloors();
  h = harness({ snapshot, groundFloor: floors.service });
  pending = h.layer.update(h.viewer);
  await settle();
  floors.bounded[0].gate.resolve();
  assert.equal(await pending, true);
  await settle();
  assert.equal(h.layer.getStats().count, 1);
  assert.equal(h.markers().length, 0);
  assert.equal(h.faces().length, 0);
  assert.deepEqual(floors.background[0].cells, [{ lat: 44.95, lon: -93.2 }]);
  floors.warm(floors.background[0].cells);
  floors.background[0].gate.resolve();
  await settle();
  assert.equal(h.markers().length, 1);
  assert.equal(h.faces().length, 1);
  h.layer.destroy();
});

test('a rejected floor resolve leaves the layer enabled for the next poll', async () => {
  const snapshot = {
    signs: [sign('V1', 'msg_00000001')],
    ageMs: 0,
    stale: false,
  };
  const floors = coldFloors();
  const h = harness({ snapshot, groundFloor: floors.service });
  const pending = h.layer.update(h.viewer);
  await settle();
  floors.bounded[0].gate.reject(new Error('terrain unavailable'));
  assert.equal(await pending, true);
  floors.background[0].gate.reject(new Error('terrain unavailable'));
  await settle();
  assert.equal(h.layer.getStats().status, 'ok');
  assert.equal(h.markers().length, 0);
  assert.equal(h.faces().length, 0);

  floors.warm(snapshot.signs);
  assert.equal(await h.layer.update(h.viewer), true);
  await settle();
  assert.equal(h.markers().length, 1);
  assert.equal(h.faces().length, 1);
  h.layer.destroy();
});

test('disabling mid floor resolve publishes nothing afterwards', async () => {
  const snapshot = {
    signs: [sign('V1', 'msg_00000001')],
    ageMs: 0,
    stale: false,
  };
  for (const stage of ['bounded', 'background']) {
    const floors = coldFloors();
    const h = harness({ snapshot, groundFloor: floors.service });
    const pending = h.layer.update(h.viewer);
    await settle();
    if (stage === 'background') {
      floors.bounded[0].gate.resolve();
      assert.equal(await pending, true);
    }
    h.layer.disable();
    const published = h.publishes();
    const rendered = h.renders();
    floors.warm(snapshot.signs);
    floors[stage][0].gate.resolve();
    if (stage === 'bounded') assert.equal(await pending, false);
    else assert.equal(floors.background[0].signal.aborted, true);
    await settle();
    assert.equal(h.publishes(), published, stage);
    assert.equal(h.renders(), rendered, stage);
    assert.equal(h.primitives.length, 0, stage);
    assert.equal(h.faces().length, 0, stage);
    h.layer.destroy();
  }
});

test('a changed message redraws only its face; a blank sign leaves (AE3)', async () => {
  const h = harness({
    snapshot: {
      signs: [sign('V1', 'msg_00000001'), sign('V2', 'msg_00000002')],
      ageMs: 0,
      stale: false,
    },
  });
  await h.layer.update(h.viewer);
  await settle();
  const before = new Map(h.faces().map((face) => [face.id, face.image]));

  h.setSnapshot({
    signs: [sign('V1', 'msg_000000AA'), sign('V2', 'msg_00000002')],
    ageMs: 0,
    stale: false,
  });
  await h.layer.update(h.viewer);
  await settle();
  const after = new Map(h.faces().map((face) => [face.id, face.image]));
  assert.equal(after.get('V1'), before.get('V1')); // same slot, redrawn
  assert.equal(after.get('V1').stamp, 2);
  assert.equal(after.get('V2').stamp, 1);

  h.setSnapshot({
    signs: [sign('V2', 'msg_00000002')],
    ageMs: 0,
    stale: false,
  });
  await h.layer.update(h.viewer);
  await settle();
  assert.deepEqual(
    h.faces().map((face) => face.id),
    ['V2'],
  );
  assert.equal(h.markers().length, 1);
  h.layer.destroy();
});

test('a newer message supersedes a face load still in flight', async () => {
  const at = (message) => ({
    signs: [sign('V1', message)],
    ageMs: 0,
    stale: false,
  });
  for (const outcome of ['resolve', 'reject']) {
    const h = harness({ snapshot: at('msg_4D617474') });
    await h.layer.update(h.viewer);
    await settle();
    const late = h.parkFace('msg_2042656E');
    h.setSnapshot(at('msg_2042656E'));
    await h.layer.update(h.viewer);
    h.setSnapshot(at('msg_65736368'));
    await h.layer.update(h.viewer);
    await settle();
    // C is fetched and drawn without waiting for B or another trigger.
    assert.deepEqual(h.requests.faces, [
      'msg_4D617474',
      'msg_2042656E',
      'msg_65736368',
    ]);
    assert.equal(h.drawn.at(-1).image.message, 'msg_65736368');

    if (outcome === 'resolve') late.resolve();
    else late.reject(new Error('MnDOT HTTP 404'));
    await settle();
    assert.equal(h.drawn.at(-1).image.message, 'msg_65736368', outcome);
    assert.equal(h.faces().length, 1, outcome);
    assert.equal(h.faces()[0].image.stamp, 2, outcome); // A, then C only
    h.layer.destroy();
  }

  // A superseded first load that fails while the newer one is still in
  // flight drops neither the face nor that newer load.
  const h = harness({ snapshot: at('msg_2042656E') });
  const first = h.parkFace('msg_2042656E');
  await h.layer.update(h.viewer);
  const next = h.parkFace('msg_65736368');
  h.setSnapshot(at('msg_65736368'));
  await h.layer.update(h.viewer);
  first.reject(new Error('MnDOT HTTP 404'));
  await settle();
  next.resolve();
  await settle();
  assert.equal(h.faces().length, 1);
  assert.equal(h.drawn.at(-1).image.message, 'msg_65736368');
  assert.equal(h.requests.faces.length, 2);
  h.layer.destroy();
});

test('a new message whose GIF fails takes the old face down until a retry works', async () => {
  const at = (message, multi) => ({
    signs: [sign('V1', message, { multi })],
    ageMs: 0,
    stale: false,
  });
  const missing = new Set(['msg_2042656E']);
  const h = harness({
    snapshot: at('msg_4D617474', 'LEFT LANE CLOSED'),
    missing,
  });
  await h.layer.update(h.viewer);
  await settle();
  h.faces()[0].activate();
  const [decoder] = h.decoders;

  const failing = h.parkFace('msg_2042656E');
  h.setSnapshot(at('msg_2042656E', 'ALL LANES OPEN'));
  await h.layer.update(h.viewer);
  await settle();
  const rendered = h.renders();
  failing.resolve(); // MnDOT answers 404 for B
  await settle();
  // No face is left showing A under a card that reads B.
  assert.equal(h.faces().length, 0);
  assert.equal(decoder.closed, true);
  assert.equal(h.renders(), rendered + 1);
  assert.equal(h.layer.getStats().faces, 0);
  assert.equal(h.markers().length, 1);
  assert.equal(h.cards()[0].details[0], 'ALL LANES OPEN');

  // The next poll tries B again, and this time MnDOT serves it.
  missing.delete('msg_2042656E');
  await h.layer.update(h.viewer);
  await settle();
  assert.deepEqual(
    h.faces().map((face) => face.id),
    ['V1'],
  );
  assert.equal(h.drawn.at(-1).image.message, 'msg_2042656E');
  assert.deepEqual(h.requests.faces, [
    'msg_4D617474',
    'msg_2042656E',
    'msg_2042656E',
  ]);
  h.layer.destroy();
});

test('a GIF of another size gets a new slot; the same size keeps it', async () => {
  const at = (message) => ({
    signs: [sign('V1', message)],
    ageMs: 0,
    stale: false,
  });
  const h = harness({
    snapshot: at('msg_4D617474'),
    sizes: { msg_65736368: [288, 100] },
  });
  await h.layer.update(h.viewer);
  await settle();
  const first = h.faces()[0].image;

  h.setSnapshot(at('msg_2042656E'));
  await h.layer.update(h.viewer);
  await settle();
  assert.equal(h.faces()[0].image, first); // 412x100 again: same slot
  assert.equal(first.stamp, 2);

  h.setSnapshot(at('msg_65736368'));
  await h.layer.update(h.viewer);
  await settle();
  const [face] = h.faces();
  assert.notEqual(face.image, first);
  assert.equal(face.image.stamp, 1);
  assert.equal(face.image.frame.width, 288);
  assert.equal(face.image.frame.height, 100);
  assert.equal(face.thumbnailWidth, 144);
  assert.equal(face.thumbnailHeight, 50);
  h.layer.destroy();
});

test('clicking a face opens its card below; again, Escape or a drop closes it (AE4)', async () => {
  const h = harness({
    snapshot: {
      signs: [
        sign('V1', 'msg_00000001', { multi: 'CRASH AHEAD[nl]USE CAUTION' }),
      ],
      ageMs: 45_000,
      stale: false,
    },
  });
  await h.layer.update(h.viewer);
  await settle();

  h.faces()[0].activate();
  const [card] = h.cards();
  assert.equal(card.placement, 'below');
  assert.equal(card.title, 'SIGN · V1 location');
  assert.deepEqual(card.details, [
    'CRASH AHEAD',
    'USE CAUTION',
    'MnDOT data 45 seconds ago',
  ]);
  assert.match(h.statusNodes[0].textContent, /CRASH AHEAD, USE CAUTION/);
  assert.equal(h.faces()[0].protected, true);
  assert.equal(h.faces()[0].active, true);

  // Closing republishes the face without its selected state.
  h.faces()[0].activate();
  assert.equal(h.cards().length, 0);
  assert.equal(h.faces()[0].protected, false);
  assert.equal(h.faces()[0].active, false);

  h.faces()[0].activate();
  h.listeners.get('keydown')({ key: 'Escape' });
  assert.equal(h.cards().length, 0);
  assert.equal(h.faces()[0].protected, false);
  assert.equal(h.faces()[0].active, false);

  // A click on the face (hit test) opens it; a new message refreshes it.
  h.hostHit = (x, y, { sourceId }) =>
    sourceId === 'message-signs' ? { entryId: 'V1' } : null;
  h.click({ x: 10, y: 10 });
  assert.equal(h.cards().length, 1);
  h.setSnapshot({
    signs: [sign('V1', 'msg_00000002', { multi: 'ALL LANES OPEN' })],
    ageMs: 0,
    stale: false,
  });
  await h.layer.update(h.viewer);
  assert.equal(h.cards()[0].details[0], 'ALL LANES OPEN');
  assert.match(h.statusNodes[0].textContent, /ALL LANES OPEN/);

  h.setSnapshot({ signs: [], ageMs: 0, stale: false });
  await h.layer.update(h.viewer);
  assert.equal(h.cards().length, 0);
  h.layer.destroy();
});

test("a marker click selects; another layer's object keeps the click", async () => {
  const h = harness({
    snapshot: { signs: [sign('V1', 'msg_00000001')], ageMs: 0, stale: false },
  });
  await h.layer.update(h.viewer);
  await settle();
  h.click({ x: 1, y: 1 }, { id: 'message-sign:V1' });
  assert.equal(h.cards().length, 1);
  h.click({ x: 1, y: 1 }, { id: 'cctv:C001' });
  assert.equal(h.cards().length, 1);
  h.click({ x: 1, y: 1 }); // empty globe
  assert.equal(h.cards().length, 0);
  h.layer.destroy();
});

test('clicks are ignored while another tool owns the pointer', async () => {
  const h = harness({
    snapshot: { signs: [sign('V1', 'msg_00000001')], ageMs: 0, stale: false },
  });
  await h.layer.update(h.viewer);
  await settle();
  h.hostHit = (x, y, { sourceId }) =>
    sourceId === 'message-signs' ? { entryId: 'V1' } : null;
  h.pointerFree = false;
  h.click({ x: 1, y: 1 }, { id: 'message-sign:V1' }); // marker
  h.click({ x: 10, y: 10 }); // face
  assert.equal(h.cards().length, 0);

  h.pointerFree = true;
  h.click({ x: 10, y: 10 });
  assert.equal(h.cards().length, 1);
  h.pointerFree = false;
  h.hostHit = () => null;
  h.click({ x: 1, y: 1 }); // empty globe, but busy: the card stays
  assert.equal(h.cards().length, 1);
  h.layer.destroy();
});

test('an open card is announced when its message changes, not every poll', async () => {
  const h = harness({
    snapshot: {
      signs: [sign('V1', 'msg_00000001', { multi: 'CRASH AHEAD' })],
      ageMs: 45_000,
      stale: false,
    },
  });
  await h.layer.update(h.viewer);
  await settle();
  h.faces()[0].activate();
  const announced = h.statusNodes[0].textContent;
  assert.match(announced, /CRASH AHEAD/);

  // Same message, older data: the card's age line moves, the status stays.
  h.setSnapshot({
    signs: [sign('V1', 'msg_00000001', { multi: 'CRASH AHEAD' })],
    ageMs: 75_000,
    stale: false,
  });
  await h.layer.update(h.viewer);
  assert.equal(h.cards()[0].details.at(-1), 'MnDOT data 75 seconds ago');
  assert.equal(h.statusNodes[0].textContent, announced);

  h.setSnapshot({
    signs: [sign('V1', 'msg_00000002', { multi: 'ALL LANES OPEN' })],
    ageMs: 0,
    stale: false,
  });
  await h.layer.update(h.viewer);
  assert.match(h.statusNodes[0].textContent, /ALL LANES OPEN/);

  // Going stale is news too.
  h.setSnapshot({
    signs: [sign('V1', 'msg_00000002', { multi: 'ALL LANES OPEN' })],
    ageMs: 180_000,
    stale: true,
  });
  await h.layer.update(h.viewer);
  assert.match(h.statusNodes[0].textContent, /STALE/);
  h.layer.destroy();
});

test('an empty list is a quiet success, not an error (AE2)', async () => {
  const h = harness();
  assert.equal(await h.layer.update(h.viewer), true);
  const stats = h.layer.getStats();
  assert.equal(stats.count, 0);
  assert.equal(stats.countLabel, '0 signs lit');
  assert.equal(stats.error, null);
  assert.equal(layerFeedState(stats), 'nominal');
  h.layer.destroy();
});

test('a sign whose GIF is gone keeps its marker and card, without a face', async () => {
  const h = harness({
    snapshot: { signs: [sign('V1', 'msg_00000001')], ageMs: 0, stale: false },
    missing: new Set(['msg_00000001']),
  });
  await h.layer.update(h.viewer);
  await settle();
  assert.equal(h.faces().length, 0);
  assert.equal(h.markers().length, 1);
  h.click({ x: 1, y: 1 }, { id: 'message-sign:V1' });
  assert.equal(h.cards().length, 1);
  h.layer.destroy();
});

test('late, superseded and post-destroy results change nothing', async () => {
  for (const action of ['disable', 'destroy']) {
    let resolve;
    const h = harness();
    h.setSnapshot(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const pending = h.layer.update(h.viewer);
    h.layer[action](h.viewer);
    resolve({ signs: [sign('V1', 'msg_00000001')], ageMs: 0, stale: false });
    assert.equal(await pending, false);
    assert.equal(h.layer.getStats().count, 0);
    assert.equal(h.faces().length, 0);
    assert.equal(h.primitives.length, 0);
  }

  const h = harness();
  const resolvers = [];
  h.setSnapshot(() => new Promise((done) => resolvers.push(done)));
  const first = h.layer.update(h.viewer);
  const second = h.layer.update(h.viewer);
  resolvers[1]({ signs: [sign('V2', 'msg_00000002')], ageMs: 0, stale: false });
  resolvers[0]({ signs: [sign('V1', 'msg_00000001')], ageMs: 0, stale: false });
  assert.equal(await first, false);
  assert.equal(await second, true);
  assert.deepEqual(
    h.layer.getAnalystRecords().map(({ id }) => id),
    ['V2'],
  );
  h.layer.destroy();
});

test('face loads in flight at disable or destroy are dropped and closed', async () => {
  for (const action of ['disable', 'destroy']) {
    const h = harness({
      snapshot: {
        signs: [
          sign('V1', 'msg_00000001'),
          sign('V2', 'msg_00000002'),
          sign('V3', 'msg_00000003'),
        ],
        ageMs: 0,
        stale: false,
      },
    });
    const fetching = h.parkFace('msg_00000002');
    const decoding = h.parkDecode('msg_00000003', 0);
    await h.layer.update(h.viewer);
    await settle();
    assert.deepEqual(
      h.faces().map((face) => face.id),
      ['V1'],
    );
    assert.equal(h.decoders.length, 2, action); // V1 drawn, V3 decoding

    h.layer[action]();
    const published = h.publishes();
    const rendered = h.renders();
    fetching.resolve();
    decoding.resolve();
    await settle();
    assert.equal(h.decoders.length, 2, action); // V2's late bytes open none
    assert.ok(
      h.decoders.every((decoder) => decoder.closed),
      action,
    );
    assert.equal(h.publishes(), published, action);
    assert.equal(h.renders(), rendered, action);
    assert.equal(h.faces().length, 0, action);
  }
});

test('released and replaced faces close every decoder they opened', async () => {
  // Released by moveEnd: the drawn face and the one still decoding.
  let h = harness({
    snapshot: {
      signs: [sign('V1', 'msg_00000001'), sign('V2', 'msg_00000002')],
      ageMs: 0,
      stale: false,
    },
  });
  let decoding = h.parkDecode('msg_00000002', 0);
  await h.layer.update(h.viewer);
  await settle();
  h.viewer.camera.positionCartographic = Cesium.Cartographic.fromDegrees(
    -93.2,
    44.95,
    400_000,
  );
  for (const fn of h.moveEnd) fn();
  decoding.resolve();
  await settle();
  assert.equal(h.faces().length, 0);
  assert.equal(h.decoders.length, 2);
  assert.ok(h.decoders.every((decoder) => decoder.closed));
  h.layer.destroy();

  // Replaced: A's decoder closes when C is drawn, and B's, superseded
  // mid-decode, closes when its decode returns.
  const at = (message) => ({
    signs: [sign('V1', message)],
    ageMs: 0,
    stale: false,
  });
  h = harness({ snapshot: at('msg_4D617474') });
  await h.layer.update(h.viewer);
  await settle();
  decoding = h.parkDecode('msg_2042656E', 0);
  h.setSnapshot(at('msg_2042656E'));
  await h.layer.update(h.viewer);
  await settle();
  h.setSnapshot(at('msg_65736368'));
  await h.layer.update(h.viewer);
  await settle();
  decoding.resolve();
  await settle();
  assert.deepEqual(
    h.decoders.map((decoder) => [decoder.message, decoder.closed]),
    [
      ['msg_4D617474', true],
      ['msg_2042656E', true],
      ['msg_65736368', false],
    ],
  );
  assert.equal(h.drawn.at(-1).image.message, 'msg_65736368');
  h.layer.destroy();
  assert.ok(h.decoders.every((decoder) => decoder.closed));
});

test('animated faces flip on their own delay, one render per flip (R3)', async () => {
  const h = harness({
    snapshot: {
      signs: [sign('V1', 'msg_000000F2'), sign('V2', 'msg_00000001')],
      ageMs: 0,
      stale: false,
    },
    frames: { msg_000000F2: 2 },
  });
  await h.layer.update(h.viewer);
  await settle();
  const slot = h.faces().find((face) => face.id === 'V1').image;
  assert.equal(slot.stamp, 1);
  assert.equal(h.pendingTimers.size, 1);

  const rendersBefore = h.renders();
  await h.advance(1000);
  assert.equal(slot.stamp, 2);
  assert.equal(h.drawn.at(-1).image.frameIndex, 1);
  assert.equal(h.renders(), rendersBefore + 1);
  await h.advance(1000);
  assert.equal(h.drawn.at(-1).image.frameIndex, 0);

  // A hidden tab stops the clock; showing it again restarts it.
  h.setVisibility('hidden');
  assert.equal(h.pendingTimers.size, 0);
  h.setVisibility('visible');
  assert.equal(h.pendingTimers.size, 1);

  // With no animated face left, the clock stops.
  h.setSnapshot({
    signs: [sign('V2', 'msg_00000001')],
    ageMs: 0,
    stale: false,
  });
  await h.layer.update(h.viewer);
  await settle();
  assert.equal(h.pendingTimers.size, 0);
  h.layer.destroy();
});

test('a message change mid-flip keeps the new animated face flipping', async () => {
  const h = harness({
    snapshot: { signs: [sign('V1', 'msg_000000F2')], ageMs: 0, stale: false },
    frames: { msg_000000F2: 2, msg_000000F3: 2 },
  });
  await h.layer.update(h.viewer);
  await settle();
  // The flip is still decoding when the next message closes its decoder,
  // which rejects that decode.
  h.parkDecode('msg_000000F2', 1);
  const flip = h.advance(1000);
  h.setSnapshot({
    signs: [sign('V1', 'msg_000000F3')],
    ageMs: 0,
    stale: false,
  });
  await h.layer.update(h.viewer);
  await settle();
  await flip;
  assert.equal(h.drawn.at(-1).image.message, 'msg_000000F3');
  assert.equal(h.pendingTimers.size, 1);

  await h.advance(1000);
  assert.equal(h.drawn.at(-1).image.message, 'msg_000000F3');
  assert.equal(h.drawn.at(-1).image.frameIndex, 1);
  h.layer.destroy();
});

test('reduced motion holds an animated face on its first frame', async () => {
  const h = harness({
    snapshot: { signs: [sign('V1', 'msg_000000F2')], ageMs: 0, stale: false },
    frames: { msg_000000F2: 2 },
    reducedMotion: true,
  });
  await h.layer.update(h.viewer);
  await settle();
  assert.equal(h.faces()[0].image.stamp, 1);
  assert.equal(h.pendingTimers.size, 0);
  h.layer.destroy();
});

test('a failed first load stays enabled and reads unavailable (AE6)', async () => {
  const h = harness();
  h.setSnapshot(new Error('MnDOT HTTP 502'));
  assert.equal(await h.layer.update(h.viewer), true);
  const stats = h.layer.getStats();
  assert.equal(stats.status, 'unavailable');
  assert.equal(stats.countLabel, null);
  assert.equal(stats.error, 'MnDOT HTTP 502');
  assert.equal(layerFeedState(stats), 'unavailable');
  assert.equal(h.faces().length, 0);
  h.layer.destroy();
});

test('stale data dims faces; an error clears them; success recovers', async () => {
  const h = harness({
    snapshot: { signs: [sign('V1', 'msg_00000001')], ageMs: 0, stale: false },
  });
  await h.layer.update(h.viewer);
  await settle();
  h.faces()[0].activate();
  assert.equal(h.drawn.at(-1).fill, null);

  h.setSnapshot({
    signs: [sign('V1', 'msg_00000001')],
    ageMs: 180_000,
    stale: true,
  });
  await h.layer.update(h.viewer);
  await settle();
  assert.equal(h.faces()[0].image.stamp, 2); // redrawn dimmed
  assert.equal(h.drawn.at(-1).fill, STALE_DIM);
  assert.equal(h.cards()[0].details.at(-1), 'STALE · MnDOT data 3 minutes ago');
  assert.equal(layerFeedState(h.layer.getStats()), 'stale');

  h.setSnapshot(new Error('MnDOT HTTP 502'));
  await h.layer.update(h.viewer);
  assert.equal(h.faces().length, 0);
  assert.equal(h.markers(), null);
  assert.equal(h.cards().length, 0);
  assert.equal(layerFeedState(h.layer.getStats()), 'unavailable');

  h.setSnapshot({
    signs: [sign('V1', 'msg_00000001')],
    ageMs: 0,
    stale: false,
  });
  await h.layer.update(h.viewer);
  await settle();
  const stats = h.layer.getStats();
  assert.equal(stats.error, null);
  assert.equal(stats.status, 'ok');
  assert.equal(h.faces().length, 1);
  h.layer.destroy();
});

test('stale faces are dimmed when first drawn and on each flip until fresh', async () => {
  const h = harness({
    snapshot: {
      signs: [sign('V1', 'msg_000000F2')],
      ageMs: 180_000,
      stale: true,
    },
    frames: { msg_000000F2: 2 },
  });
  await h.layer.update(h.viewer);
  await settle();
  assert.equal(h.drawn.at(-1).image.frameIndex, 0);
  assert.equal(h.drawn.at(-1).fill, STALE_DIM); // first load
  await h.advance(1000);
  assert.equal(h.drawn.at(-1).image.frameIndex, 1);
  assert.equal(h.drawn.at(-1).fill, STALE_DIM); // flip

  h.setSnapshot({
    signs: [sign('V1', 'msg_000000F2')],
    ageMs: 0,
    stale: false,
  });
  await h.layer.update(h.viewer);
  await settle();
  assert.equal(h.drawn.at(-1).image.frameIndex, 1); // same frame, undimmed
  assert.equal(h.drawn.at(-1).fill, null);
  await h.advance(1000);
  assert.equal(h.drawn.at(-1).image.frameIndex, 0);
  assert.equal(h.drawn.at(-1).fill, null);
  h.layer.destroy();
});

test('disable releases markers, faces, the card, timers and the status node', async () => {
  const h = harness({
    snapshot: { signs: [sign('V1', 'msg_000000F2')], ageMs: 0, stale: false },
    frames: { msg_000000F2: 2 },
  });
  await h.layer.update(h.viewer);
  await settle();
  h.faces()[0].activate();
  assert.equal(h.statusNodes.length, 1);
  h.layer.disable();
  assert.equal(h.primitives.length, 0);
  assert.equal(h.faces().length, 0);
  assert.equal(h.cards().length, 0);
  assert.equal(h.pendingTimers.size, 0);
  assert.equal(h.statusNodes.length, 0);
  assert.equal(h.moveEnd.size, 0);
  assert.equal(h.listeners.size, 0);
  h.layer.destroy();
});
