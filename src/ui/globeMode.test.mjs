import test from 'node:test';
import assert from 'node:assert/strict';
import { createGlobeModeController } from './globeMode.js';

function makeButton() {
  const label = { textContent: '3D' };
  const attrs = {};
  const classes = new Set(['pp-toggle-btn', 'active']);
  return {
    querySelector: (selector) =>
      selector === '.pp-label' ? label : null,
    classList: {
      toggle: (name, force) => {
        if (force) classes.add(name);
        else classes.delete(name);
      },
      contains: (name) => classes.has(name),
    },
    setAttribute: (name, value) => {
      attrs[name] = value;
    },
    getAttribute: (name) => attrs[name],
    _label: label,
  };
}

function makeViewer() {
  const calls = [];
  return {
    calls,
    scene: {
      morphTo2D: (duration) => calls.push(['2D', duration]),
      morphTo3D: (duration) => calls.push(['3D', duration]),
    },
  };
}

test('globe mode toggle morphs between 3D and flat 2D', () => {
  const viewer = makeViewer();
  const button = makeButton();
  const toasts = [];
  const controller = createGlobeModeController({
    viewer,
    button,
    showToast: (message) => toasts.push(message),
  });
  assert.ok(controller);
  assert.equal(controller.isFlat(), false);

  assert.equal(controller.toggle(), true);
  assert.deepEqual(viewer.calls, [['2D', 1.5]]);
  assert.equal(controller.isFlat(), true);
  assert.equal(button._label.textContent, '2D');
  assert.equal(button.getAttribute('aria-pressed'), 'false');
  assert.equal(button.classList.contains('active'), false);

  assert.equal(controller.toggle(), true);
  assert.deepEqual(viewer.calls, [
    ['2D', 1.5],
    ['3D', 1.5],
  ]);
  assert.equal(controller.isFlat(), false);
  assert.equal(button._label.textContent, '3D');
  assert.equal(button.getAttribute('aria-pressed'), 'true');
  assert.equal(toasts.length, 2);
});

test('globe mode toggle is a no-op without a viewer scene or button', () => {
  assert.equal(createGlobeModeController({ viewer: null, button: makeButton() }), null);
  assert.equal(
    createGlobeModeController({ viewer: makeViewer(), button: null }),
    null,
  );
});

test('a morph failure keeps the previous mode and reports it', () => {
  const viewer = makeViewer();
  viewer.scene.morphTo2D = () => {
    throw new Error('no webgl2');
  };
  const toasts = [];
  const controller = createGlobeModeController({
    viewer,
    button: makeButton(),
    showToast: (message) => toasts.push(message),
  });
  assert.equal(controller.toggle(), false);
  assert.equal(controller.isFlat(), false);
  assert.deepEqual(toasts, ['Globe mode unavailable']);
});

test('destroyed controller refuses to toggle', () => {
  const viewer = makeViewer();
  const controller = createGlobeModeController({
    viewer,
    button: makeButton(),
  });
  controller.destroy();
  assert.equal(controller.toggle(), false);
  assert.deepEqual(viewer.calls, []);
});
