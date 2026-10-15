import test from 'node:test';
import assert from 'node:assert/strict';
import { createSurfaceKeyboard } from './surfaceKeyboard.js';
test('surface cycling never targets deliberately excluded controls', () => {
  let handler;
  const documentRef = {
    activeElement: {},
    addEventListener: (_, fn) => (handler = fn),
    removeEventListener() {},
  };
  const node = ({
    attributes = {},
    fieldsetDisabled = false,
    inert = false,
  } = {}) => ({
    hasAttribute: (name) => Object.hasOwn(attributes, name),
    getClientRects: () => [{}],
    getAttribute: (name) => attributes[name] ?? null,
    matches: (selector) => selector === ':disabled' && fieldsetDisabled,
    closest: (selector) =>
      selector === '[inert]' && inert ? { inert: true } : null,
    focus() {
      documentRef.activeElement = this;
    },
  });
  const ignored = [
    node({ attributes: { tabindex: '-1' } }),
    node({ fieldsetDisabled: true }),
    node({ inert: true }),
  ];
  const first = node({}),
    last = node({});
  const controls = [...ignored, first, last];
  const root = {
    ownerDocument: documentRef,
    querySelectorAll: () => controls,
    contains: (n) => controls.includes(n),
  };
  const surface = createSurfaceKeyboard({
    root,
    isActive: () => true,
    onEscape() {},
  });
  surface.activate();
  const press = (shiftKey) =>
    handler({
      key: 'Tab',
      shiftKey,
      preventDefault() {},
      stopPropagation() {},
    });
  press(false);
  assert.equal(documentRef.activeElement, first);
  press(true);
  assert.equal(documentRef.activeElement, last);
  surface.destroy();
});
