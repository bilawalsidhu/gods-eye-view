import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { trackCreditLineHeight } from './creditLineHeight.js';

/** A ResizeObserver the test drives, with each line's height set by hand. */
function fakeResizing() {
  const observers = [];
  const window = document.defaultView;
  const original = window.ResizeObserver;
  window.ResizeObserver = class {
    constructor(callback) {
      this.callback = callback;
      this.targets = new Set();
      observers.push(this);
    }
    observe(target) {
      this.targets.add(target);
    }
    disconnect() {
      this.targets.clear();
    }
  };
  return {
    resize(element, height) {
      element.getBoundingClientRect = () => ({ height });
      for (const observer of observers)
        if (observer.targets.has(element)) observer.callback([]);
    },
    restore() {
      window.ResizeObserver = original;
    },
  };
}

test("the credit line's height follows it as it wraps, for either renderer's line", () => {
  const resizing = fakeResizing();
  try {
    for (const markup of [
      '<div id="gev-credits"></div>',
      '<div id="cesium-credits"><div class="cesium-widget-credits"></div></div>',
    ]) {
      document.body.innerHTML = markup;
      const line = document.querySelector(
        '#gev-credits, #cesium-credits .cesium-widget-credits',
      );
      line.getBoundingClientRect = () => ({ height: 28 });
      const stop = trackCreditLineHeight(document);
      const root = document.documentElement.style;
      assert.equal(root.getPropertyValue('--credit-line-height'), '28px');
      resizing.resize(line, 66.4);
      assert.equal(root.getPropertyValue('--credit-line-height'), '67px');
      // Hidden, it holds no room.
      resizing.resize(line, 0);
      assert.equal(root.getPropertyValue('--credit-line-height'), '');
      resizing.resize(line, 28);
      stop();
      assert.equal(root.getPropertyValue('--credit-line-height'), '');
    }
  } finally {
    resizing.restore();
    document.body.replaceChildren();
  }
});

test('without a credit line nothing is followed', () => {
  const resizing = fakeResizing();
  try {
    document.body.replaceChildren();
    const stop = trackCreditLineHeight(document);
    assert.equal(
      document.documentElement.style.getPropertyValue('--credit-line-height'),
      '',
    );
    stop();
  } finally {
    resizing.restore();
  }
});
