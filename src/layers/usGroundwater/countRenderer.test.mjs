import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createCountRenderer, WELL_DETAIL_HEIGHT } from './countRenderer.js';
const view = {
  schemaVersion: 1,
  kind: 'gev-well-count-view',
  total: 900,
  degrees: 2,
  coverageComplete: false,
  cells: [{ bounds: [0, 0, 2, 2], center: [1, 1], count: 900 }],
};
test('count evidence never allocates a representative well or enables clusters', () => {
  const ds = new Cesium.CustomDataSource();
  const viewer = {
    scene: { postRender: new Cesium.Event() },
    camera: {
      positionCartographic: { height: 10000 },
      moveEnd: new Cesium.Event(),
      flyTo() {
        throw Error('unexpected flight');
      },
    },
  };
  const renderer = createCountRenderer(viewer);
  renderer.draw(view, ds);
  assert.equal(ds.entities.values.length, 0);
  assert.equal(ds.clustering.enabled, false);
  assert.equal(renderer.zoom({ id: 'fake' }), false);
  renderer.clear();
  renderer.clear();
});
test('exact record positions survive and obey the outer visibility gate', () => {
  const ds = new Cesium.CustomDataSource();
  const entity = ds.entities.add({
    id: 'record',
    position: Cesium.Cartesian3.fromDegrees(1, 1),
  });
  const frame = new Cesium.Event();
  const viewer = {
    scene: { postRender: frame },
    camera: {
      positionCartographic: { height: 10000 },
      moveEnd: new Cesium.Event(),
    },
  };
  const renderer = createCountRenderer(viewer);
  renderer.draw({ ...view, cells: [] }, ds, true);
  assert.equal(ds.entities.values[0], entity);
  assert.equal(ds.show, true);
  viewer.camera.positionCartographic.height = WELL_DETAIL_HEIGHT + 1;
  frame.raiseEvent();
  assert.equal(ds.show, false);
  viewer.camera.positionCartographic.height = 10000;
  frame.raiseEvent();
  assert.equal(ds.show, true);
  renderer.clear();
  assert.equal(frame.numberOfListeners, 0);
});

test('keyed record controls preserve focused identity and magnification through refresh', () => {
  const prior = globalThis.document;
  class Node {
    constructor() {
      this.children = [];
      this.dataset = {};
      this.style = {};
      this.attributes = {};
      this.events = {};
    }
    setAttribute(key, value) {
      this.attributes[key] = value;
    }
    append(n) {
      n.parent = this;
      this.children.push(n);
    }
    remove() {
      if (this.parent)
        this.parent.children = this.parent.children.filter((x) => x !== this);
    }
    contains(n) {
      return this === n || this.children.includes(n);
    }
    addEventListener(k, f) {
      this.events[k] = f;
    }
    focus() {
      document.activeElement = this;
      this.events.focus?.();
    }
  }
  const host = new Node(),
    fallback = new Node();
  globalThis.document = {
    activeElement: null,
    body: new Node(),
    createElement: () => new Node(),
    querySelector: (s) => (s === '#world-overlay-actions' ? host : fallback),
  };
  try {
    const ds = new Cesium.CustomDataSource();
    const add = () =>
      ds.entities.add({
        id: 'same',
        name: 'source record',
        position: Cesium.Cartesian3.fromDegrees(1, 1),
        billboard: { image: 'fixture' },
      });
    add();
    const frame = new Cesium.Event();
    const viewer = {
      scene: {
        postRender: frame,
        canvas: {
          clientWidth: 1000,
          clientHeight: 800,
          focus() {
            document.activeElement = this;
          },
        },
        cartesianToCanvasCoordinates: () => ({ x: 500, y: 400 }),
      },
      camera: {
        positionCartographic: { height: 10000 },
        moveEnd: new Cesium.Event(),
      },
    };
    let selected;
    const renderer = createCountRenderer(viewer, {
      onSelectRecord: (e) => (selected = e),
    });
    renderer.draw({ ...view, cells: [] }, ds, true);
    const button = host.children[0].children[0];
    assert.equal(button.attributes['aria-describedby'], host.children[1].id);
    assert.match(host.children[1].textContent, /Arrow keys/);
    button.focus();
    assert.match(document.body.children[0].textContent, /source record/);
    ds.entities.removeAll();
    const replacement = add();
    renderer.draw({ ...view, cells: [] }, ds, true);
    assert.equal(document.activeElement, button);
    assert.equal(host.children[0].children[0], button);
    assert.equal(replacement.billboard.scale.getValue(), 1.8);
    button.events.click();
    assert.equal(selected, replacement);
    ds.entities.removeAll();
    renderer.draw({ ...view, cells: [] }, ds, true);
    assert.equal(document.activeElement, viewer.scene.canvas);
    assert.equal(document.body.children.length, 0);
    renderer.clear();
  } finally {
    if (prior === undefined) delete globalThis.document;
    else globalThis.document = prior;
  }
});
