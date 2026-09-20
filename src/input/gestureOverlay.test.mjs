import test from 'node:test';
import assert from 'node:assert/strict';
import { GestureOverlay } from './gestureOverlay.js';

test('GestureOverlay initializes cleanly in non-DOM environment without error', () => {
  const overlay = new GestureOverlay({ container: null });
  assert.equal(overlay.root, null);
  assert.equal(overlay.videoElement, null);
  assert.doesNotThrow(() => overlay.show());
  assert.doesNotThrow(() => overlay.hide());
  assert.doesNotThrow(() => overlay.clear());
  assert.doesNotThrow(() => overlay.setCameraError('test'));
  assert.doesNotThrow(() => overlay.renderLandmarks([]));
  assert.doesNotThrow(() => overlay.highlightGesture('PEACE_SIGN'));
  assert.doesNotThrow(() => overlay.destroy());
});

test('GestureOverlay creates complete DOM structure when mock container is provided', () => {
  const mockContainer = {
    appendChild(child) {
      this.child = child;
    },
  };

  const elements = [];
  const fakeDoc = {
    createElement(tag) {
      const el = {
        tagName: tag.toUpperCase(),
        className: '',
        innerHTML: '',
        classList: {
          add(c) { el.className += ` ${c}`; },
          remove(c) { el.className = el.className.replace(c, '').trim(); },
          toggle(c, force) {
            if (force) el.classList.add(c);
            else el.classList.remove(c);
          },
          contains(c) { return el.className.includes(c); },
        },
        querySelectorAll(sel) {
          if (sel === '.gev-sim-btn') {
            return [
              { getAttribute: () => 'PEACE_SIGN', classList: { add() {}, remove() {} }, addEventListener() {} },
              { getAttribute: () => 'FIST', classList: { add() {}, remove() {} }, addEventListener() {} },
            ];
          }
          return [];
        },
        querySelector(sel) {
          if (sel === '.gev-gesture-video') return { muted: true, autoplay: true, style: {} };
          if (sel === '.gev-gesture-canvas') return { width: 300, height: 190, getContext: () => ({ clearRect() {}, fillRect() {}, beginPath() {}, stroke() {}, fill() {}, arc() {}, moveTo() {}, lineTo() {}, fillText() {} }) };
          if (sel === '.gev-gesture-badge') return { hidden: true, textContent: '', style: {} };
          if (sel === '.gev-gesture-mode-chip') return { textContent: '', classList: { add() {}, remove() {}, contains: () => false } };
          if (sel === '.gev-gesture-pip-close') return { addEventListener() {} };
          return null;
        },
        remove() {},
      };
      elements.push(el);
      return el;
    },
  };

  const origDoc = globalThis.document;
  globalThis.document = fakeDoc;

  try {
    let simulatedGesture = null;
    const overlay = new GestureOverlay({
      container: mockContainer,
      onSimulate: (g) => { simulatedGesture = g; },
    });

    assert.ok(overlay.root);
    assert.ok(overlay.videoElement);
    assert.ok(overlay.canvas);
    assert.ok(overlay.badgeEl);

    // Test show and hide
    overlay.show();
    assert.equal(overlay._visible, true);
    overlay.hide();
    assert.equal(overlay._visible, false);

    // Test camera error
    overlay.show();
    overlay.setCameraError('Camera busy');
    assert.equal(overlay.badgeEl.hidden, false);

    // Test landmark rendering
    const dummyLandmarks = Array(21).fill(0).map(() => ({ x: 0.5, y: 0.5 }));
    overlay.renderLandmarks(dummyLandmarks, 'PEACE_SIGN');
    assert.equal(overlay.badgeEl.textContent.includes('PEACE SIGN'), true);

    overlay.destroy();
    assert.equal(overlay.root, null);
  } finally {
    globalThis.document = origDoc;
  }
});
