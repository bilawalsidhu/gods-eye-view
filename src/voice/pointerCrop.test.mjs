import assert from 'node:assert/strict';
import test from 'node:test';
import { RealtimeViewport, pointerCropRect } from './realtimeViewport.js';

test('crop: a square around the pointer, clamped inside the canvas, in buffer pixels', () => {
  assert.deepEqual(
    pointerCropRect({
      x: 750,
      y: 475,
      cssWidth: 1500,
      cssHeight: 950,
      pixelWidth: 3000,
      pixelHeight: 1900,
    }),
    {
      sx: 988,
      sy: 438,
      sw: 1024,
      sh: 1024,
      output: 512,
      pointX: 256,
      pointY: 256,
    },
  );
  const corner = pointerCropRect({
    x: 20,
    y: 20,
    cssWidth: 1500,
    cssHeight: 950,
    pixelWidth: 1500,
    pixelHeight: 950,
  });
  assert.equal(corner.sx, 0);
  assert.equal(corner.sy, 0);
  assert.equal(
    corner.pointX,
    20,
    'the ring still marks the real spot near an edge',
  );
  assert.equal(
    pointerCropRect({
      x: 1,
      y: 1,
      cssWidth: 0,
      cssHeight: 0,
      pixelWidth: 0,
      pixelHeight: 0,
    }),
    null,
  );
});

function viewportFixture({ capturePointer, capture } = {}) {
  const sent = [];
  const captures = [];
  const state = { clock: 10_000, pointer: null, camera: 'pose-A' };
  const channel = { readyState: 'open' };
  const viewport = new RealtimeViewport({
    readChannel: () => channel,
    readPointer: () => state.pointer,
    readCameraKey: () => state.camera,
    capture: capture || (async () => 'data:image/jpeg;base64,FULL'),
    capturePointer:
      capturePointer ||
      (async (px) => {
        captures.push(px);
        return {
          dataUrl: 'data:image/jpeg;base64,CROP',
          rect: { x: 0.25, y: 0.2, w: 0.3, h: 0.5 },
        };
      }),
    now: () => state.clock,
    operations: {
      sendRealtimeEvent: (event, label) => {
        sent.push({ event, label });
        return true;
      },
    },
  });
  return { viewport, sent, captures, state };
}

const ground = {
  fresh: true,
  target: 'ground',
  at: 'keydown',
  screenPx: { x: 400, y: 300 },
  capturedAt: 9_000,
  cameraKey: 'pose-A',
};

test('crop: sent once per snapshot, only at local/city scale, into the one retained slot', async () => {
  const { viewport, sent, captures, state } = viewportFixture();
  assert.equal(
    await viewport.sendPointerCrop(ground, { viewScale: 'regional' }),
    false,
    'the scale guard lives in the shared send path',
  );
  assert.equal(
    await viewport.sendPointerCrop(ground),
    false,
    'no scale, no crop',
  );
  assert.equal(
    await viewport.sendPointerCrop(ground, { viewScale: 'city' }),
    true,
  );
  assert.equal(
    await viewport.sendPointerCrop(ground, { viewScale: 'city' }),
    false,
    'once per snapshot',
  );
  assert.deepEqual(captures, [{ x: 400, y: 300 }]);
  assert.equal(sent[0].label, 'client.pointer_crop');
  assert.match(sent[0].event.item.content[0].text, /ring marks the exact spot/);
  assert.equal(
    sent[0].event.item.content[1].image_url,
    'data:image/jpeg;base64,CROP',
  );
  assert.deepEqual(viewport.retainedFrame, {
    kind: 'crop',
    rect: { x: 0.25, y: 0.2, w: 0.3, h: 0.5 },
    cameraKey: 'pose-A',
  });
  assert.equal(
    await viewport.sendPointerCrop(
      { ...ground, target: 'entity' },
      { viewScale: 'city' },
    ),
    false,
    'entities are named, not cropped',
  );
  state.clock = 60_000;
  assert.equal(
    await viewport.sendPointerCrop({ ...ground }, { viewScale: 'city' }),
    false,
    'too old',
  );

  // Pull: a ground pointer lookup sends the crop, deleting the old image.
  state.clock = 10_000;
  state.pointer = { ...ground, at: 'speech_start' };
  const lookup = {
    action: 'get_entity_context',
    scope: 'pointer',
    selected: null,
    pointer: { latitude: 1, longitude: 2 },
    scene: { basemap: { viewScale: 'city' } },
  };
  assert.equal(await viewport.sendVisualContextIfUseful(lookup), true);
  assert.equal(
    sent.at(-2).event.type,
    'conversation.item.delete',
    'one retained image at most',
  );
  assert.equal(sent.at(-1).label, 'client.pointer_crop');
  assert.equal(
    await viewport.sendVisualContextIfUseful({
      ...lookup,
      selected: { id: 'x' },
    }),
    false,
  );
  assert.equal(
    await viewport.sendVisualContextIfUseful({
      ...lookup,
      scene: { basemap: { viewScale: 'regional' } },
    }),
    false,
  );
  viewport.reset();
  assert.equal(viewport.lastPointerCrop, null);
  assert.equal(viewport.retainedFrame, null);
});

test('crop: a camera move before or during capture drops it; pixels only name their own pose', async () => {
  let release;
  const { viewport, sent, state } = viewportFixture({
    capturePointer: () =>
      new Promise((resolve) => {
        release = () =>
          resolve({
            dataUrl: 'data:image/jpeg;base64,CROP',
            rect: { x: 0, y: 0, w: 1, h: 1 },
          });
      }),
  });
  state.camera = 'pose-B';
  assert.equal(
    await viewport.sendPointerCrop(ground, { viewScale: 'local' }),
    false,
    'moved before capture',
  );
  state.camera = 'pose-A';
  const pending = viewport.sendPointerCrop(
    { ...ground },
    { viewScale: 'local' },
  );
  state.camera = 'pose-B';
  release();
  assert.equal(await pending, false, 'moved while capturing');
  assert.equal(sent.length, 0);
});

test('crop: an older capture that finishes last never replaces the newer image', async () => {
  const releases = [];
  const { viewport, sent } = viewportFixture({
    capturePointer: () =>
      new Promise((resolve) =>
        releases.push((url) => resolve({ dataUrl: url, rect: null })),
      ),
  });
  const first = viewport.sendPointerCrop({ ...ground }, { viewScale: 'local' });
  const second = viewport.sendPointerCrop(
    { ...ground },
    { viewScale: 'local' },
  );
  releases[1]('data:image/jpeg;base64,NEW');
  assert.equal(await second, true);
  releases[0]('data:image/jpeg;base64,OLD');
  assert.equal(await first, false, 'superseded request');
  assert.deepEqual(
    sent.map((s) => s.event.item?.content?.[1]?.image_url).filter(Boolean),
    ['data:image/jpeg;base64,NEW'],
  );

  // A new user turn drops a capture still in flight from the previous one.
  const third = viewport.sendPointerCrop({ ...ground }, { viewScale: 'local' });
  viewport.beginTurn();
  releases[2]('data:image/jpeg;base64,LATE');
  assert.equal(await third, false);
});
