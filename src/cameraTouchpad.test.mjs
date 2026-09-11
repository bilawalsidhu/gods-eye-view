import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import {
  installTouchpadCamera,
  isHorizontalWheel,
  isTouchpadPinchWheel,
  isTouchpadZoomWheel,
  prefersFinePointer,
  TOUCHPAD_WHEEL_ZOOM_SCALE,
  wheelDeltaPixels,
  wheelZoomDeltaPixels,
  withModifierWheelZoomTypes,
  withoutUnmodifiedPinchTilt,
  zoomAmountFromWheelPixels,
} from './cameraTouchpad.js';

test('wheel deltas honor pixel, line, and page units', () => {
  assert.deepEqual(wheelDeltaPixels({ deltaX: 3, deltaY: -8, deltaMode: 0 }), { x: 3, y: -8 });
  assert.deepEqual(wheelDeltaPixels({ deltaX: 0, deltaY: 2, deltaMode: 1 }), { x: 0, y: 32 });
  assert.deepEqual(wheelDeltaPixels({ deltaX: 1, deltaY: -1, deltaMode: 2 }), { x: 120, y: -120 });
});

test('zoom uses the dominant axis so horizontal two-finger scroll is not dropped', () => {
  assert.equal(wheelZoomDeltaPixels({ deltaX: 0, deltaY: 40, deltaMode: 0 }), 40);
  assert.equal(wheelZoomDeltaPixels({ deltaX: -24, deltaY: 2, deltaMode: 0 }), -24);
  assert.equal(isHorizontalWheel({ deltaX: -24, deltaY: 2, deltaMode: 0 }), true);
  assert.equal(isHorizontalWheel({ deltaX: 1, deltaY: -20, deltaMode: 0 }), false);
});

test('Windows Precision Touchpad pinch is Ctrl+wheel (meta counts too)', () => {
  assert.equal(isTouchpadPinchWheel({ ctrlKey: true, metaKey: false }), true);
  assert.equal(isTouchpadPinchWheel({ ctrlKey: false, metaKey: true }), true);
  assert.equal(isTouchpadPinchWheel({ ctrlKey: false, metaKey: false }), false);
});

test('modifier-wheel zoom types are appended once and leave mouse wheel / pinch intact', () => {
  const types = withModifierWheelZoomTypes([
    Cesium.CameraEventType.RIGHT_DRAG,
    Cesium.CameraEventType.WHEEL,
    Cesium.CameraEventType.PINCH,
  ]);
  assert.deepEqual(types.slice(0, 3), [
    Cesium.CameraEventType.RIGHT_DRAG,
    Cesium.CameraEventType.WHEEL,
    Cesium.CameraEventType.PINCH,
  ]);
  assert.deepEqual(types[3], {
    eventType: Cesium.CameraEventType.WHEEL,
    modifier: Cesium.KeyboardEventModifier.CTRL,
  });
  assert.deepEqual(types[4], {
    eventType: Cesium.CameraEventType.WHEEL,
    modifier: Cesium.KeyboardEventModifier.SHIFT,
  });
  assert.equal(withModifierWheelZoomTypes(types).length, types.length);
});

test('laptop tilt bindings drop unmodified pinch and keep Ctrl-drag tilt', () => {
  const filtered = withoutUnmodifiedPinchTilt([
    Cesium.CameraEventType.MIDDLE_DRAG,
    Cesium.CameraEventType.PINCH,
    {
      eventType: Cesium.CameraEventType.LEFT_DRAG,
      modifier: Cesium.KeyboardEventModifier.CTRL,
    },
    {
      eventType: Cesium.CameraEventType.PINCH,
      modifier: Cesium.KeyboardEventModifier.SHIFT,
    },
  ]);
  assert.deepEqual(filtered, [
    Cesium.CameraEventType.MIDDLE_DRAG,
    {
      eventType: Cesium.CameraEventType.LEFT_DRAG,
      modifier: Cesium.KeyboardEventModifier.CTRL,
    },
    {
      eventType: Cesium.CameraEventType.PINCH,
      modifier: Cesium.KeyboardEventModifier.SHIFT,
    },
  ]);
});

test('fine-pointer detection treats a phone as coarse and a laptop as fine', () => {
  assert.equal(
    prefersFinePointer((query) => ({ matches: query.includes('pointer: fine') })),
    true,
  );
  assert.equal(prefersFinePointer(() => ({ matches: false })), false);
  assert.equal(prefersFinePointer(undefined), true);
});

test('touchpad zoom scale is ~2.5× Cesium wheel and maps pixels to altitude', () => {
  assert.equal(TOUCHPAD_WHEEL_ZOOM_SCALE, 0.002);
  // Cesium ≈ 5 * 7.5°/px / canvasHeight ≈ 0.000727 on a 900px view.
  const cesiumScaleAt900px = (5 * 7.5 * Math.PI / 180) / 900;
  assert.ok(TOUCHPAD_WHEEL_ZOOM_SCALE / cesiumScaleAt900px >= 2);
  assert.ok(TOUCHPAD_WHEEL_ZOOM_SCALE / cesiumScaleAt900px <= 2.8);
  assert.equal(zoomAmountFromWheelPixels(0, 2000), 0);
  assert.equal(zoomAmountFromWheelPixels(10, 2000), 40);
  assert.equal(zoomAmountFromWheelPixels(-10, NaN), -20);
});

test('pinch and continuous two-finger scroll share the touchpad zoom path', () => {
  assert.equal(isTouchpadZoomWheel({ ctrlKey: true, deltaX: 0, deltaY: -20, deltaMode: 0 }), true);
  assert.equal(isTouchpadZoomWheel({ ctrlKey: false, deltaX: 0, deltaY: 16, deltaMode: 0 }), true);
  assert.equal(isTouchpadZoomWheel({ ctrlKey: false, deltaX: -24, deltaY: 2, deltaMode: 0 }), true);
  assert.equal(isTouchpadZoomWheel({ ctrlKey: false, deltaX: 0, deltaY: 120, deltaMode: 0 }), false);
  assert.equal(isTouchpadZoomWheel({ ctrlKey: false, deltaX: 0, deltaY: 2, deltaMode: 1 }), false);
});

test('installTouchpadCamera binds Ctrl+wheel zoom, filters laptop pinch-tilt, and disposes', () => {
  const listeners = [];
  const zoomIns = [];
  const canvas = {
    addEventListener(type, handler, options) {
      listeners.push({ type, handler, options });
    },
    removeEventListener(type, handler) {
      const index = listeners.findIndex((entry) => entry.type === type && entry.handler === handler);
      if (index >= 0) listeners.splice(index, 1);
    },
  };
  const controller = {
    enableInputs: true,
    enableZoom: true,
    zoomEventTypes: [
      Cesium.CameraEventType.RIGHT_DRAG,
      Cesium.CameraEventType.WHEEL,
      Cesium.CameraEventType.PINCH,
    ],
    tiltEventTypes: [
      Cesium.CameraEventType.MIDDLE_DRAG,
      Cesium.CameraEventType.PINCH,
    ],
  };
  const viewer = {
    scene: { canvas, screenSpaceCameraController: controller },
    camera: {
      positionCartographic: { height: 2000 },
      zoomIn(amount) { zoomIns.push(amount); },
    },
  };

  const dispose = installTouchpadCamera(viewer);
  assert.equal(installTouchpadCamera(viewer), dispose);
  assert.ok(controller.zoomEventTypes.some((entry) => (
    entry?.eventType === Cesium.CameraEventType.WHEEL
    && entry?.modifier === Cesium.KeyboardEventModifier.CTRL
  )));
  assert.ok(!controller.tiltEventTypes.includes(Cesium.CameraEventType.PINCH));
  assert.ok(controller.zoomEventTypes.includes(Cesium.CameraEventType.PINCH));
  assert.ok(controller.zoomEventTypes.includes(Cesium.CameraEventType.WHEEL));

  const wheel = listeners.find((entry) => entry.type === 'wheel');
  assert.equal(wheel.options.capture, true);
  assert.equal(wheel.options.passive, false);

  const prevented = [];
  const stopped = [];
  wheel.handler({
    ctrlKey: true,
    metaKey: false,
    deltaX: 0,
    deltaY: -20,
    deltaMode: 0,
    preventDefault() { prevented.push('pinch'); },
    stopImmediatePropagation() { stopped.push('pinch'); },
  });
  assert.deepEqual(prevented, ['pinch']);
  assert.deepEqual(stopped, ['pinch']);
  assert.deepEqual(zoomIns, [80]);

  wheel.handler({
    ctrlKey: false,
    metaKey: false,
    deltaX: 0,
    deltaY: 16,
    deltaMode: 0,
    preventDefault() { prevented.push('vertical'); },
    stopImmediatePropagation() { stopped.push('vertical'); },
  });
  assert.deepEqual(prevented, ['pinch', 'vertical']);
  assert.deepEqual(stopped, ['pinch', 'vertical']);
  assert.deepEqual(zoomIns, [80, -64]);

  wheel.handler({
    ctrlKey: false,
    metaKey: false,
    deltaX: 40,
    deltaY: 0,
    deltaMode: 0,
    preventDefault() { prevented.push('horizontal'); },
    stopImmediatePropagation() { stopped.push('horizontal'); },
  });
  assert.deepEqual(prevented, ['pinch', 'vertical', 'horizontal']);
  assert.deepEqual(zoomIns, [80, -64, -160]);

  wheel.handler({
    ctrlKey: false,
    metaKey: false,
    deltaX: 0,
    deltaY: 120,
    deltaMode: 0,
    preventDefault() { prevented.push('mouse'); },
    stopImmediatePropagation() { stopped.push('mouse'); },
  });
  assert.ok(!prevented.includes('mouse'));
  assert.deepEqual(zoomIns, [80, -64, -160]);

  controller.enableInputs = false;
  wheel.handler({
    ctrlKey: true,
    deltaX: 0,
    deltaY: -20,
    deltaMode: 0,
    preventDefault() { prevented.push('disabled'); },
  });
  assert.ok(!prevented.includes('disabled'));

  dispose();
  assert.equal(listeners.length, 0);
});
