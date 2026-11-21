import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createSceneHost } from '../render/rendererOf.js';
import { createStubRenderer } from '../render/stub/index.js';
import { mountSkyViewForShell, skyViewFor } from './skyView.js';

// ── a very small DOM (the fake skyView.test.mjs mounts against) ────────────
class FakeElement extends EventTarget {
  constructor(tagName) {
    super();
    this.tagName = tagName.toUpperCase();
    this.className = '';
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.textContent = '';
    this.value = '';
    this.hidden = false;
    this.focused = false;
    this.width = 0;
    this.height = 0;
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'value') this.value = String(value);
  }
  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }
  append(...nodes) {
    for (const node of nodes) {
      node.parentNode = this;
      this.children.push(node);
    }
  }
  remove() {
    const siblings = this.parentNode?.children;
    if (siblings) siblings.splice(siblings.indexOf(this), 1);
    this.parentNode = null;
  }
  focus() {
    this.focused = true;
  }
  setPointerCapture() {}
  getContext() {
    const noop = () => {};
    return new Proxy(
      {},
      {
        get(target, key) {
          if (key === 'createLinearGradient')
            return () => ({ addColorStop: noop });
          if (key in target) return target[key];
          return noop;
        },
        set(target, key, value) {
          target[key] = value;
          return true;
        },
      },
    );
  }
  *descendants() {
    for (const child of this.children) {
      yield child;
      yield* child.descendants();
    }
  }
  find(name) {
    for (const node of this.descendants())
      if (node.getAttribute('data-sky') === name) return node;
    return null;
  }
}

function fakeDocument() {
  const doc = new EventTarget();
  doc.createElement = (tag) => new FakeElement(tag);
  doc.body = new FakeElement('body');
  const classes = new Set();
  doc.body.classList = {
    add: (c) => classes.add(c),
    remove: (c) => classes.delete(c),
    contains: (c) => classes.has(c),
  };
  return doc;
}

/**
 * As the application starts (src/app/scene.js): a renderer bound to the scene
 * object `createSceneHost` makes, which holds nothing of the engine. The stub
 * renderer stands in for the one the application chose.
 */
function shellScene() {
  const renderer = createStubRenderer();
  renderer.query.pickPosition = () => null;
  const { host, release } = createSceneHost(renderer, {
    container: new FakeElement('div'),
  });
  return { renderer, host, release };
}

/** The shell hands over the scene object; mount reads the global document. */
function mountOnShell(viewer) {
  const previousDocument = globalThis.document;
  const doc = fakeDocument();
  globalThis.document = doc;
  try {
    const handle = mountSkyViewForShell({
      viewer,
      _lifetime: { removers: new Set() },
      _navigation: null,
      _showToast: () => {},
    });
    return { handle, doc };
  } finally {
    globalThis.document = previousDocument;
  }
}

test('shell mount: on the scene object createSceneHost makes, with a renderer bound, the Sky button appears', () => {
  const { host, release } = shellScene();
  assert.deepEqual(
    Object.keys(host).sort(),
    ['container', 'isDestroyed'],
    'the scene object holds nothing of the engine',
  );

  const { handle, doc } = mountOnShell(host);

  assert.ok(handle);
  const button = doc.body.find('open');
  assert.ok(button, 'the Sky button is in the page');
  assert.equal(button.textContent, 'Sky');
  assert.equal(skyViewFor(host), handle, 'keyed by the scene object itself');
  assert.ok(host.container.find('canvas'), 'overlay canvas in the container');
  handle.destroy();
  assert.equal(skyViewFor(host), null);
  assert.equal(doc.body.find('open'), null);
  release();
});

test('shell mount: Sky enters and leaves through the renderer ports alone', async () => {
  const { renderer, host, release } = shellScene();
  const { handle } = mountOnShell(host);
  const before = renderer.camera.pose();
  assert.equal(
    await handle.enterAt({
      latDeg: 29.7604,
      lonDeg: -95.3698,
      source: 'manual',
      heightM: 15,
      heightKnown: true,
    }),
    true,
  );
  const eye = renderer.camera.pose();
  assert.ok(Math.abs(eye.height - 16.7) < 1e-6, String(eye.height));
  assert.equal(renderer.camera.controls.enabled, false);
  handle.exit();
  assert.equal(renderer.camera.controls.enabled, true);
  const after = renderer.camera.pose();
  assert.ok(Math.abs(after.height - before.height) < 1e-3);
  handle.destroy();
  release();
});

test('shell mount: a scene with no renderer bound mounts nothing', () => {
  const { handle, doc } = mountOnShell({
    container: new FakeElement('div'),
    isDestroyed: () => false,
  });
  assert.equal(handle, null);
  assert.equal(doc.body.find('open'), null);
});

test('shell mount: Sky does not reach Cesium: no import of the engine or its adapter, no Cesium name', () => {
  for (const file of [
    'skyView.js',
    'skyCamera.js',
    'observer.js',
    'horizonProfile.js',
  ]) {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')
      // comments may name the engine; code may not
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(
      source,
      /from\s+['"]cesium['"]/,
      `${file} imports cesium`,
    );
    assert.doesNotMatch(
      source,
      /render\/cesium\//,
      `${file} imports the Cesium adapter`,
    );
    assert.doesNotMatch(
      source,
      /\b[Cc]esium(?:Api)?\b/,
      `${file} names Cesium`,
    );
  }
});
