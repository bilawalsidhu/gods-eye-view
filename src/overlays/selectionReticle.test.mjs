import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findHandoffTarget,
  groundTilt,
  installSelectionReticle,
  isLockTargetEnabled,
  resolvePickTarget,
  SELECTION_RETICLE_ROOT_ID,
} from './selectionReticle.js';

class Cartesian3 {
  constructor(x = 0, y = 0, z = 0) {
    Object.assign(this, { x, y, z });
  }
  static clone(p, out = new Cartesian3()) {
    return Object.assign(out, { x: p.x, y: p.y, z: p.z });
  }
  static distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  }
}
class Cartesian2 {}
class Entity {}
class Cesium3DTileset {}
class Cesium3DTileFeature {}
class Model {}
const ScreenSpaceEventType = { LEFT_CLICK: 'click' };

function fakeCesium() {
  const handlers = [];
  class ScreenSpaceEventHandler {
    constructor() {
      this.actions = new Map();
      this.destroyed = false;
      handlers.push(this);
    }
    setInputAction(fn, type) {
      this.actions.set(type, fn);
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyed = true;
    }
  }
  return {
    handlers,
    Cartesian2,
    Cartesian3,
    Entity,
    Cesium3DTileset,
    Cesium3DTileFeature,
    Model,
    ScreenSpaceEventHandler,
    ScreenSpaceEventType,
    Matrix4: { getTranslation: (m, out) => Object.assign(out, m.translation) },
  };
}

function fakeElement(tag) {
  const classes = new Set();
  const style = {
    setProperty(name, value) {
      this[name] = value;
    },
  };
  return {
    tag,
    id: '',
    children: [],
    attributes: {},
    style,
    offsetWidth: 0,
    removed: false,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    appendChild(child) {
      this.children.push(child);
    },
    remove() {
      this.removed = true;
    },
    set className(value) {
      classes.clear();
      for (const c of value.split(' ')) classes.add(c);
    },
  };
}

function fakeHost() {
  const body = fakeElement('body');
  const doc = { body, createElement: fakeElement };
  const listeners = new Map();
  const dispatched = [];
  const win = {
    CustomEvent: class {
      constructor(type) {
        this.type = type;
      }
    },
    dispatchEvent: (event) => dispatched.push(event.type),
    dispatched,
    addEventListener: (n, fn) => listeners.set(n, fn),
    removeEventListener: (n) => listeners.delete(n),
    dispatch: (n, detail) => listeners.get(n)?.({ detail }),
    listeners,
  };
  return { doc, win, body };
}

function fakeViewer(pickResult) {
  const postRender = new Set();
  const scene = {
    canvas: { clientWidth: 800, clientHeight: 600 },
    camera: { pitch: -Math.PI / 6, positionWC: new Cartesian3(1, 1, 1) },
    pick: () => pickResult.value,
    cartesianToCanvasCoordinates: (position) => ({
      x: position.x,
      y: position.y,
    }),
    requestRender() {
      this.renders = (this.renders || 0) + 1;
    },
    postRender: {
      addEventListener(fn) {
        postRender.add(fn);
        return () => postRender.delete(fn);
      },
    },
  };
  return {
    scene,
    container: null,
    clock: { currentTime: 't0' },
    frame: () => [...postRender].forEach((fn) => fn()),
    postRender,
  };
}

test('resolvePickTarget ignores empty space, 3D tiles and positionless picks', () => {
  const cesium = fakeCesium();
  assert.equal(resolvePickTarget(undefined, { cesium }), null);
  assert.equal(resolvePickTarget(new Cesium3DTileFeature(), { cesium }), null);
  assert.equal(
    resolvePickTarget({ primitive: new Cesium3DTileset() }, { cesium }),
    null,
  );
  assert.equal(
    resolvePickTarget({ id: 'metro:line:a', primitive: {} }, { cesium }),
    null,
  );
});

test('resolvePickTarget follows live entities, points and models', () => {
  const cesium = fakeCesium();
  const entity = new Entity();
  let at = new Cartesian3(1, 2, 3);
  entity.position = { getValue: (time) => (time === 't1' ? at : null) };
  entity.isShowing = true;
  const fromEntity = resolvePickTarget(
    { id: entity, primitive: { position: new Cartesian3() } },
    { cesium, getTime: () => 't1' },
  );
  assert.equal(fromEntity.key, entity);
  assert.equal(fromEntity.getPosition(), at);
  at = new Cartesian3(4, 5, 6);
  assert.equal(fromEntity.getPosition(), at, 'tracks a moving entity');
  entity.isShowing = false;
  assert.equal(fromEntity.isAlive(), false);

  const collection = { show: true, isDestroyed: () => false };
  const point = {
    position: new Cartesian3(7, 8, 9),
    show: true,
    _pointPrimitiveCollection: collection,
  };
  const fromPoint = resolvePickTarget(
    { id: 'metro:Q1', primitive: point },
    { cesium },
  );
  assert.equal(fromPoint.getPosition(), point.position);
  assert.equal(fromPoint.isAlive(), true);
  collection.show = false;
  assert.equal(fromPoint.isAlive(), false, 'hidden layer drops the reticle');
  collection.show = true;
  point._pointPrimitiveCollection = undefined;
  assert.equal(fromPoint.isAlive(), false, 'removed point drops the reticle');

  const model = new Model();
  model.modelMatrix = { translation: { x: 1, y: 1, z: 1 } };
  const fromModel = resolvePickTarget({ primitive: model }, { cesium });
  assert.deepEqual({ ...fromModel.getPosition() }, { x: 1, y: 1, z: 1 });
});

test('groundTilt flattens toward the horizon and stays readable', () => {
  assert.equal(groundTilt(-Math.PI / 2), 1);
  assert.ok(Math.abs(groundTilt(-Math.PI / 6) - 0.5) < 1e-9);
  assert.equal(groundTilt(-0.01), 0.32);
  assert.equal(groundTilt(Number.NaN), 1);
});

test('installSelectionReticle locks on to clicks, follows, clears and uninstalls', () => {
  const cesium = fakeCesium();
  const { doc, win, body } = fakeHost();
  const pick = { value: undefined };
  const viewer = fakeViewer(pick);
  const uninstall = installSelectionReticle(viewer, {
    cesium,
    isPointerFree: () => true,
    isEnabled: () => true,
    doc,
    win,
  });
  const root = body.children[0];
  assert.equal(root.id, SELECTION_RETICLE_ROOT_ID);
  const reticle = root.children[0];
  const click = cesium.handlers[0].actions.get('click');

  const collection = { show: true, isDestroyed: () => false };
  const point = {
    position: new Cartesian3(100, 200, 0),
    show: true,
    _pointPrimitiveCollection: collection,
  };
  pick.value = { id: 'metro:Q1', primitive: point };
  click({ position: { x: 100, y: 200 } });
  assert.ok(reticle.classList.contains('is-active'));
  assert.ok(reticle.classList.contains('is-entering'));
  assert.match(reticle.style.transform, /translate3d\(100\.0px, 200\.0px/);
  assert.equal(reticle.style['--reticle-tilt'], '0.500');
  assert.deepEqual(win.dispatched, ['gev:hud-target-locked']);
  click({ position: { x: 100, y: 200 } });
  assert.equal(
    win.dispatched.length,
    1,
    're-clicking the same subject is silent',
  );

  point.position = new Cartesian3(150, 250, 0);
  viewer.frame();
  assert.match(reticle.style.transform, /translate3d\(150\.0px, 250\.0px/);

  point.position = new Cartesian3(5000, 250, 0);
  viewer.frame();
  assert.ok(!reticle.classList.contains('is-active'), 'hidden off screen');

  point.position = new Cartesian3(150, 250, 0);
  viewer.frame();
  assert.ok(reticle.classList.contains('is-active'));

  pick.value = undefined;
  click({ position: { x: 1, y: 1 } });
  assert.ok(!reticle.classList.contains('is-active'), 'empty click clears');

  uninstall();
  assert.ok(root.removed);
  assert.ok(cesium.handlers[0].destroyed);
  assert.equal(viewer.postRender.size, 0);
  assert.equal(win.listeners.size, 0);
});

test('a deliberate clear from the owning layer drops the reticle', async () => {
  const cesium = fakeCesium();
  const { doc, win, body } = fakeHost();
  const pick = { value: undefined };
  const viewer = fakeViewer(pick);
  installSelectionReticle(viewer, {
    cesium,
    isPointerFree: () => true,
    isEnabled: () => true,
    doc,
    win,
  });
  const reticle = body.children[0].children[0];
  const click = cesium.handlers[0].actions.get('click');
  pick.value = {
    primitive: { position: new Cartesian3(10, 10, 0), show: true },
  };
  click({ position: { x: 10, y: 10 } });
  win.dispatch('gev:entity-selected', { layerId: 'vessels' });
  // A clear inside the click window belongs to the same click.
  win.dispatch('gev:entity-selection-cleared', {
    layerId: 'vessels',
    reason: 'deliberate',
  });
  assert.ok(reticle.classList.contains('is-active'));
  await new Promise((resolve) => setTimeout(resolve, 650));
  win.dispatch('gev:entity-selection-cleared', {
    layerId: 'other',
    reason: 'deliberate',
  });
  assert.ok(reticle.classList.contains('is-active'), 'other layers ignored');
  win.dispatch('gev:entity-selection-cleared', {
    layerId: 'vessels',
    reason: 'deliberate',
  });
  assert.ok(!reticle.classList.contains('is-active'));
});

test('clicks the input owner has claimed are ignored', () => {
  const cesium = fakeCesium();
  const { doc, win, body } = fakeHost();
  const pick = {
    value: { primitive: { position: new Cartesian3(1, 1, 0), show: true } },
  };
  installSelectionReticle(fakeViewer(pick), {
    cesium,
    isPointerFree: () => false,
    isEnabled: () => true,
    doc,
    win,
  });
  cesium.handlers[0].actions.get('click')({ position: { x: 1, y: 1 } });
  assert.ok(!body.children[0].children[0].classList.contains('is-active'));
});

test('the reticle only runs while the HUD Target is Lock', () => {
  assert.equal(
    isLockTargetEnabled({
      documentElement: { dataset: { hudTarget: 'lock' } },
    }),
    true,
  );
  assert.equal(
    isLockTargetEnabled({
      documentElement: { dataset: { hudTarget: 'default' } },
    }),
    false,
  );
  const cesium = fakeCesium();
  const { doc, win, body } = fakeHost();
  let mode = 'default';
  const pick = {
    value: {
      primitive: { position: new Cartesian3(20, 20, 0), show: true },
    },
  };
  installSelectionReticle(fakeViewer(pick), {
    cesium,
    isPointerFree: () => true,
    isEnabled: () => mode === 'lock',
    doc,
    win,
  });
  const reticle = body.children[0].children[0];
  const click = cesium.handlers[0].actions.get('click');
  click({ position: { x: 20, y: 20 } });
  assert.ok(!reticle.classList.contains('is-active'), 'Default shows nothing');
  mode = 'lock';
  click({ position: { x: 20, y: 20 } });
  assert.ok(reticle.classList.contains('is-active'));
  mode = 'default';
  win.dispatch('gev:hud-target-changed', { mode });
  assert.ok(!reticle.classList.contains('is-active'), 'switching off clears');
});

test('a marker swapped for a tracked entity keeps one lock (flights click)', () => {
  const cesium = fakeCesium();
  const { doc, win, body } = fakeHost();
  const pick = { value: undefined };
  const viewer = fakeViewer(pick);
  installSelectionReticle(viewer, {
    cesium,
    isPointerFree: () => true,
    isEnabled: () => true,
    doc,
    win,
  });
  const reticle = body.children[0].children[0];
  const collection = { show: true, isDestroyed: () => false };
  const billboard = {
    position: new Cartesian3(300, 300, 0),
    show: true,
    _billboardCollection: collection,
  };
  pick.value = { id: 'abc123', primitive: billboard };
  cesium.handlers[0].actions.get('click')({ position: { x: 300, y: 300 } });
  // The layer hides its billboard and tracks a new entity in the same click.
  billboard.show = false;
  const tracked = new Entity();
  tracked.isShowing = true;
  let at = new Cartesian3(301, 300, 0);
  tracked.position = { getValue: () => at };
  viewer.trackedEntity = tracked;
  viewer.frame();
  assert.ok(reticle.classList.contains('is-active'), 'one click locks');
  assert.equal(win.dispatched.length, 1, 'no second lock-on');
  at = new Cartesian3(320, 310, 0);
  viewer.frame();
  assert.match(reticle.style.transform, /translate3d\(320\.0px, 310\.0px/);
});

test('findHandoffTarget ignores entities away from the vanished marker', () => {
  const cesium = fakeCesium();
  const far = new Entity();
  far.isShowing = true;
  far.position = { getValue: () => new Cartesian3(5000, 0, 0) };
  const viewer = { trackedEntity: far };
  const last = new Cartesian3(0, 0, 0);
  assert.equal(findHandoffTarget(viewer, last, { cesium }), null);
  far.position = { getValue: () => new Cartesian3(100, 0, 0) };
  assert.equal(findHandoffTarget(viewer, last, { cesium })?.key, far);
  assert.equal(
    findHandoffTarget(viewer, last, { cesium, excludeKey: far }),
    null,
  );
  assert.equal(findHandoffTarget(viewer, null, { cesium }), null);
});
