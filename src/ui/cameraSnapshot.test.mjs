import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CameraSnapshot,
  imagePoint,
  regionBounds,
  snapshotFilename,
} from './cameraSnapshot.js';
test('annotation coordinates survive display resizing and clamp out-of-image movement', () => {
  assert.deepEqual(
    imagePoint(
      { clientX: 60, clientY: 45 },
      { left: 10, top: 20, width: 100, height: 50 },
    ),
    { x: 0.5, y: 0.5 },
  );
  assert.deepEqual(
    imagePoint(
      { clientX: 110, clientY: 70 },
      { left: 10, top: 20, width: 200, height: 100 },
    ),
    { x: 0.5, y: 0.5 },
  );
  assert.deepEqual(
    imagePoint(
      { clientX: -1, clientY: 999 },
      { left: 10, top: 20, width: 100, height: 50 },
    ),
    { x: 0, y: 1 },
  );
  assert.deepEqual(
    regionBounds([
      { x: 0.8, y: 0.9 },
      { x: 0.2, y: 0.3 },
    ]),
    { x: 0.2, y: 0.3, w: 0.6000000000000001, h: 0.6000000000000001 },
  );
});
test('snapshot filenames bound and sanitize camera identifiers', () => {
  const name = snapshotFilename(
    '../bad/camera:secret',
    new Date('2026-10-11T00:00:00Z'),
  );
  assert.equal(
    name,
    'camera----bad-camera-secret-2026-10-11T00-00-00-000Z.png',
  );
  assert.ok(!snapshotFilename('a'.repeat(500)).includes('a'.repeat(71)));
});
test('unready or blank video cannot become a saved original', async () => {
  const errors = [];
  const snapshot = new CameraSnapshot({
    documentRef: {},
    button: null,
    video: { hidden: false, width: 1, height: 1 },
    getVideo: () => ({ readyState: 1, videoWidth: 1, videoHeight: 1 }),
    readState: () => ({
      enabled: true,
      activeCamera: { id: 'c', connection: { status: 'connecting' } },
    }),
    showToast: (s) => errors.push(s),
  });
  await snapshot.capture();
  assert.equal(snapshot.original, undefined);
  assert.match(errors[0], /not available/);
  snapshot.destroy();
});

function touchFixture() {
  const handlers = new Map();
  let clicks = 0;
  const button = {
    disabled: false,
    isConnected: true,
    click: () => clicks++,
    closest: () => button,
  };
  const root = {
    contains: (b) => b === button,
    addEventListener: (name, fn) => handlers.set(name, fn),
  };
  const snapshot = new CameraSnapshot({ documentRef: {}, button: null });
  snapshot.bindTouchActivation(root);
  const event = (x = 0) => ({
    pointerType: 'touch',
    pointerId: 1,
    target: button,
    clientX: x,
    clientY: 0,
  });
  return { snapshot, handlers, event, button, clicks: () => clicks };
}
test('touch fallback recovers missing click once and close preserves late-click suppression', async () => {
  const f = touchFixture();
  f.handlers.get('pointerdown')(f.event());
  f.handlers.get('pointerup')(f.event());
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(f.clicks(), 1);
  f.snapshot.close();
  let stopped = false;
  f.handlers.get('click')({
    target: f.button,
    isTrusted: true,
    detail: 1,
    preventDefault() {},
    stopImmediatePropagation() {
      stopped = true;
    },
  });
  assert.equal(stopped, true);
  stopped = false;
  f.handlers.get('click')({
    target: f.button,
    isTrusted: true,
    detail: 0,
    preventDefault() {},
    stopImmediatePropagation() {
      stopped = true;
    },
  });
  assert.equal(stopped, false, 'keyboard activation stays available');
  f.snapshot.destroy();
});
test('out-and-back touch drag and cancellation never activate a button', async () => {
  const f = touchFixture();
  f.handlers.get('pointerdown')(f.event());
  f.handlers.get('pointermove')(f.event(20));
  f.handlers.get('pointerup')(f.event());
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(f.clicks(), 0);
  f.handlers.get('pointerdown')(f.event());
  f.handlers.get('pointerup')(f.event());
  f.handlers.get('pointercancel')(f.event());
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(f.clicks(), 0);
  f.snapshot.destroy();
});
