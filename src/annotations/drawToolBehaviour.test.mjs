// Behavioural tests for the draw tool: the module is driven against fake DOM
// and viewer doubles and its OBSERVABLE effects are asserted — which lease it
// holds, which viewer input actions it borrowed and gave back, what it leaves
// behind when destroyed. Nothing here reads the module's source text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { initDrawTool } from './drawTool.js';
import {
  isPointerFree,
  pointerOwner,
  claimPointer,
  releasePointer,
  resetPointerOwnership,
} from '../data/inputOwnership.js';

/* ── DOM doubles ───────────────────────────────────────────────────────── */

class FakeClassList {
  constructor() {
    this.names = new Set();
  }
  add(...names) {
    for (const n of names) this.names.add(n);
  }
  remove(...names) {
    for (const n of names) this.names.delete(n);
  }
  contains(name) {
    return this.names.has(name);
  }
  toggle(name, force) {
    const on = force === undefined ? !this.names.has(name) : Boolean(force);
    if (on) this.names.add(name);
    else this.names.delete(name);
    return on;
  }
}

class FakeElement {
  constructor(tagName = 'DIV', id = '') {
    this.tagName = tagName.toUpperCase();
    this.id = id;
    this.classList = new FakeClassList();
    this.dataset = {};
    this.attributes = new Map();
    this.textContent = '';
    this.value = '';
    this.listeners = [];
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
  addEventListener(type, listener, options) {
    this.listeners.push({ type, listener, options });
  }
  removeEventListener(type, listener) {
    const at = this.listeners.findIndex(
      (entry) => entry.type === type && entry.listener === listener,
    );
    if (at >= 0) this.listeners.splice(at, 1);
  }
  click() {
    return this.emit('click');
  }
  closest(selector) {
    // Only what the tool asks: "am I inside an activatable control?"
    const activatable = ['button', 'a', 'select', '[role="button"]', '[role="radio"]'];
    if (!activatable.some((part) => selector.includes(part))) return null;
    return this.tagName === 'BUTTON' || this.tagName === 'A' || this.tagName === 'SELECT'
      ? this
      : null;
  }
  /** Deliver an event to this element's own listeners. */
  emit(type, event = {}) {
    const payload = {
      type,
      target: this,
      preventDefault() {},
      stopImmediatePropagation() {},
      ...event,
    };
    for (const entry of [...this.listeners])
      if (entry.type === type) entry.listener(payload);
    return payload;
  }
}

function fakeDom() {
  const byId = new Map();
  const make = (id, tagName = 'DIV') => {
    const element = new FakeElement(tagName, id);
    byId.set(id, element);
    return element;
  };
  // The control whose presence means the page has Draw, a focused button
  // whose Enter is its own, and the tool's label field.
  make('draw-toggle', 'BUTTON');
  make('draw-clear', 'BUTTON');
  make('draw-label-input', 'INPUT');

  const body = new FakeElement('BODY');
  const documentDouble = {
    body,
    getElementById: (id) => byId.get(id) ?? null,
    listeners: [],
    addEventListener(type, listener, options) {
      this.listeners.push({ type, listener, options });
    },
    removeEventListener(type, listener) {
      const at = this.listeners.findIndex(
        (entry) => entry.type === type && entry.listener === listener,
      );
      if (at >= 0) this.listeners.splice(at, 1);
    },
    emit(type, event = {}) {
      const payload = {
        type,
        target: body,
        preventDefault() {},
        stopImmediatePropagation() {},
        ...event,
      };
      for (const entry of [...this.listeners])
        if (entry.type === type) entry.listener(payload);
      return payload;
    },
  };
  return { byId, documentDouble };
}

/* ── viewer double ─────────────────────────────────────────────────────── */

function fakeViewer() {
  const canvas = new FakeElement('CANVAS');
  canvas.clientWidth = 800;
  canvas.clientHeight = 600;
  const actions = new Map();
  const stockHandler = {
    getInputAction: (type) => actions.get(type),
    setInputAction: (action, type) => actions.set(type, action),
    removeInputAction: (type) => actions.delete(type),
  };
  const attached = [];
  const pendingAdds = [];
  const dataSources = {
    get length() {
      return attached.length;
    },
    get: (index) => attached[index],
    add(source) {
      // Cesium resolves this on a later tick — the whole point of finding 7.
      const promise = Promise.resolve().then(() => {
        attached.push(source);
        return source;
      });
      pendingAdds.push(promise);
      return promise;
    },
    remove(source) {
      const at = attached.indexOf(source);
      if (at >= 0) attached.splice(at, 1);
      return at >= 0;
    },
  };
  return {
    scene: { canvas, requestRender() {} },
    screenSpaceEventHandler: stockHandler,
    dataSources,
    _attached: attached,
    _actions: actions,
  };
}

function fakeAnnotations() {
  const calls = { annotate: [], clear: 0 };
  return {
    calls,
    async annotate(specs, options) {
      calls.annotate.push({ specs, options });
      return { drawn: specs.length };
    },
    clear() {
      calls.clear += 1;
    },
  };
}

/** Stand up a tool against fresh doubles, with globals restored afterwards. */
function harness() {
  resetPointerOwnership();
  const { byId, documentDouble } = fakeDom();
  const viewer = fakeViewer();
  const annotations = fakeAnnotations();
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  globalThis.document = documentDouble;
  globalThis.window = globalThis.window || {};
  const shown = { view: null };
  // The controls' actions, as the display store holds them.
  const controls = { actions: null };
  const tool = initDrawTool({
    viewer,
    annotations,
    publish: (view) => (shown.view = view),
    connect: (actions) => {
      controls.actions = actions;
      return () => (controls.actions = null);
    },
  });
  return {
    tool,
    shown,
    viewer,
    annotations,
    byId,
    documentDouble,
    element: (id) => byId.get(id),
    controls,
    /** A control's change, as the view sends it. */
    act: (name, ...args) => controls.actions?.[name]?.(...args),
    restore() {
      resetPointerOwnership();
      if (previousDocument === undefined) delete globalThis.document;
      else globalThis.document = previousDocument;
      if (previousWindow === undefined) delete globalThis.window;
      else globalThis.window = previousWindow;
    },
  };
}

const LEFT_CLICK = Cesium.ScreenSpaceEventType.LEFT_CLICK;
const LEFT_DOUBLE_CLICK = Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK;

/* ── the tests ─────────────────────────────────────────────────────────── */

test('turning Draw on takes a lease and turning it off gives it back', async () => {
  const h = harness();
  try {
    assert.equal(isPointerFree(), true);
    h.act('toggleDraw');
    assert.equal(pointerOwner(), 'draw', 'the session owns the pointer');
    assert.equal(h.tool.active, true);

    h.act('toggleDraw');
    assert.equal(isPointerFree(), true, 'leaving draw mode frees the pointer');
    assert.equal(h.tool.active, false);
  } finally {
    h.restore();
  }
});

test('Draw refuses to start when something else holds the pointer', async () => {
  const h = harness();
  try {
    const other = claimPointer('directions');
    h.act('toggleDraw');
    assert.equal(h.tool.active, false, 'it must not half-start');
    assert.equal(pointerOwner(), 'directions', 'and must not steal the claim');
    // Named by its tool, not by the internal owner id.
    assert.equal(
      h.shown.view.hint,
      'Directions is using the pointer — close it first.',
    );
    assert.equal(h.tool.diagnostics().sceneHandler, false, 'no handler was bound');

    releasePointer(other);
    h.act('toggleDraw');
    assert.equal(h.tool.active, true, 'and it starts once the pointer is free');
  } finally {
    h.restore();
  }
});

test('a destroyed instance cannot free the pointer its replacement holds', async () => {
  const first = harness();
  try {
    first.act('toggleDraw');
    assert.equal(pointerOwner(), 'draw');
    // The replacement takes over before the old one finishes tearing down.
    first.tool.setActive(false);
    const second = harness();
    try {
      second.act('toggleDraw');
      assert.equal(pointerOwner(), 'draw');
      await first.tool.destroy();
      assert.equal(
        pointerOwner(),
        'draw',
        'the live session still owns the pointer after the old one is destroyed',
      );
      assert.equal(second.tool.active, true);
    } finally {
      second.restore();
    }
  } finally {
    first.restore();
  }
});

test('both stock viewer click actions are borrowed for the session and given back', async () => {
  const h = harness();
  try {
    const stockClick = () => 'viewer picks and selects';
    const stockDouble = () => 'viewer tracks';
    h.viewer.screenSpaceEventHandler.setInputAction(stockClick, LEFT_CLICK);
    h.viewer.screenSpaceEventHandler.setInputAction(stockDouble, LEFT_DOUBLE_CLICK);

    h.act('toggleDraw');
    assert.equal(
      h.viewer.screenSpaceEventHandler.getInputAction(LEFT_CLICK),
      undefined,
      "the viewer's own selecting click must not run while drawing",
    );
    assert.equal(
      h.viewer.screenSpaceEventHandler.getInputAction(LEFT_DOUBLE_CLICK),
      undefined,
    );

    h.act('toggleDraw');
    assert.equal(
      h.viewer.screenSpaceEventHandler.getInputAction(LEFT_CLICK),
      stockClick,
      'the exact function is restored, not a replacement',
    );
    assert.equal(
      h.viewer.screenSpaceEventHandler.getInputAction(LEFT_DOUBLE_CLICK),
      stockDouble,
    );
  } finally {
    h.restore();
  }
});

test('Enter finishes from the canvas and the label field, never from a focused button', async () => {
  const h = harness();
  try {
    h.act('toggleDraw');
    h.tool.setShape('area');
    h.tool.addVertex(-97.75, 30.26);
    h.tool.addVertex(-97.74, 30.26);
    h.tool.addVertex(-97.74, 30.27);

    // Enter while the Clear button has keyboard focus means "press Clear".
    h.documentDouble.emit('keydown', { key: 'Enter', target: h.element('draw-clear') });
    await Promise.resolve();
    assert.equal(
      h.annotations.calls.annotate.length,
      0,
      'a focused button keeps its own Enter',
    );
    assert.equal(h.tool.session.vertices.length, 3, 'and the shape is untouched');

    // Enter from the page body (the canvas has focus in practice) finishes it.
    h.documentDouble.emit('keydown', { key: 'Enter', target: h.documentDouble.body });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(h.annotations.calls.annotate.length, 1, 'Enter on the map finishes');
    assert.equal(h.annotations.calls.annotate[0].specs[0].type, 'area');
  } finally {
    h.restore();
  }
});

test('the live preview hangs at the height the click landed on', async () => {
  const h = harness();
  try {
    h.act('toggleDraw');
    h.tool.setShape('line');
    h.tool.addVertex(-97.75, 30.26, 187.5);
    h.tool.addVertex(-97.74, 30.26, 212.25);

    await h.tool.whenSettled();
    const source = h.viewer._attached[0] ?? null;
    assert.ok(source, 'the preview data source is attached');
    const points = source.entities.values.filter((entity) => entity.point);
    assert.equal(points.length, 2, 'one preview dot per vertex');
    const heights = points.map((entity) => {
      const position = entity.position.getValue(Cesium.JulianDate.now());
      return Cesium.Cartographic.fromCartesian(position).height;
    });
    assert.ok(Math.abs(heights[0] - 187.5) < 0.5, `got ${heights[0]}`);
    assert.ok(Math.abs(heights[1] - 212.25) < 0.5, `got ${heights[1]}`);

    // …and the finished shape is still flattened, deliberately: the renderer
    // drapes, so a height carried further would be discarded out of sight.
    h.documentDouble.emit('keydown', { key: 'Enter', target: h.documentDouble.body });
    await Promise.resolve();
    await Promise.resolve();
    const spec = h.annotations.calls.annotate[0].specs[0];
    assert.deepEqual(spec.path, [
      [-97.75, 30.26],
      [-97.74, 30.26],
    ]);
  } finally {
    h.restore();
  }
});

test('destroy in the same tick as init still removes the preview data source', async () => {
  const h = harness();
  try {
    // Nothing has been attached yet — dataSources.add() resolves later.
    assert.equal(h.viewer._attached.length, 0, 'the add is still pending');
    await h.tool.destroy();
    await Promise.resolve();
    assert.equal(
      h.viewer._attached.length,
      0,
      'the preview must not be left attached behind the teardown',
    );
  } finally {
    h.restore();
  }
});

test('destroy releases the pointer, the handler, the listeners and the stock actions', async () => {
  const h = harness();
  try {
    const stockClick = () => 'viewer picks and selects';
    h.viewer.screenSpaceEventHandler.setInputAction(stockClick, LEFT_CLICK);
    h.act('toggleDraw');
    h.tool.addVertex(-97.75, 30.26);
    assert.equal(pointerOwner(), 'draw');
    assert.ok(h.tool.diagnostics().domListeners > 0);

    await h.tool.destroy();
    await Promise.resolve();

    assert.equal(isPointerFree(), true, 'the pointer is free');
    const after = h.tool.diagnostics();
    assert.equal(after.destroyed, true);
    assert.equal(after.sceneHandler, false, 'the Cesium handler is gone');
    assert.equal(after.domListeners, 0, 'every DOM listener came off');
    assert.equal(h.documentDouble.listeners.length, 0, 'including the keydown');
    assert.equal(h.controls.actions, null, 'and the controls are disconnected');
    assert.equal(
      h.viewer.screenSpaceEventHandler.getInputAction(LEFT_CLICK),
      stockClick,
      'the viewer got its selecting click back',
    );
    assert.equal(h.viewer._attached.length, 0, 'the preview data source is detached');

    // Idempotent: a second destroy is harmless.
    await h.tool.destroy();
  } finally {
    h.restore();
  }
});

test('Clear wipes the board and the shape in progress', async () => {
  const h = harness();
  try {
    h.act('toggleDraw');
    h.tool.addVertex(-97.75, 30.26);
    h.tool.addVertex(-97.74, 30.26);
    assert.equal(h.tool.session.vertices.length, 2);

    h.act('clearDraw');
    assert.equal(h.annotations.calls.clear, 1, 'placed marks are removed');
    assert.equal(h.tool.session.vertices.length, 0, 'and so is the shape in progress');
  } finally {
    h.restore();
  }
});

test('the controls choose the shape, colour and label the next shape is drawn with', async () => {
  const h = harness();
  try {
    h.act('toggleDraw');
    h.act('setDrawShape', 'line');
    h.act('setDrawColor', 'amber');
    h.act('setDrawLabel', 'Route A');
    assert.deepEqual(
      { ...h.shown.view, hint: undefined },
      { active: true, shape: 'line', color: 'amber', label: 'Route A', hint: undefined },
      'the view shows what the controls chose',
    );
    h.act('setDrawColor', 'purple');
    assert.equal(h.shown.view.color, 'primary', 'an unknown colour falls back');
    h.act('setDrawColor', 'cyan');
    h.tool.addVertex(-97.75, 30.26);
    // Choosing a shape again starts the open one over.
    h.act('setDrawShape', 'line');
    assert.equal(h.tool.session.vertices.length, 0);
    h.tool.addVertex(-97.75, 30.26);
    h.tool.addVertex(-97.74, 30.26);
    h.documentDouble.emit('keydown', { key: 'Enter', target: h.documentDouble.body });
    await Promise.resolve();
    await Promise.resolve();
    const spec = h.annotations.calls.annotate[0].specs[0];
    assert.equal(spec.type, 'route', 'a drawn line is a manual route');
    assert.equal(spec.color, 'cyan');
    assert.equal(spec.label, 'Route A');
    assert.equal(h.shown.view.label, '', 'a finished shape empties the label');
  } finally {
    h.restore();
  }
});

test('keys typed in the label field: Enter finishes, Backspace edits, Escape cancels', async () => {
  const h = harness();
  try {
    const label = h.element('draw-label-input');
    const elsewhere = new FakeElement('INPUT', 'location-search');
    h.act('toggleDraw');
    h.tool.addVertex(-97.75, 30.26);
    h.tool.addVertex(-97.74, 30.26);
    h.documentDouble.emit('keydown', { key: 'Backspace', target: label });
    assert.equal(h.tool.session.vertices.length, 2, 'Backspace edits the label');
    h.documentDouble.emit('keydown', { key: 'Enter', target: elsewhere });
    await Promise.resolve();
    assert.equal(h.annotations.calls.annotate.length, 0, 'another field keeps its Enter');
    h.documentDouble.emit('keydown', { key: 'Escape', target: label });
    assert.equal(h.tool.session.vertices.length, 0, 'Escape drops the open shape');
    assert.equal(h.tool.active, true, 'and leaves Draw on');
    h.act('setDrawShape', 'line');
    h.tool.addVertex(-97.75, 30.26);
    h.tool.addVertex(-97.74, 30.26);
    h.documentDouble.emit('keydown', { key: 'Enter', target: label });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(h.annotations.calls.annotate.length, 1, 'Enter in the label finishes');
  } finally {
    h.restore();
  }
});

test('a page without the Draw controls gets no draw tool', () => {
  resetPointerOwnership();
  const previousDocument = globalThis.document;
  globalThis.document = { getElementById: () => null };
  try {
    let connected = false;
    const tool = initDrawTool({
      viewer: fakeViewer(),
      annotations: fakeAnnotations(),
      connect: () => {
        connected = true;
        return () => {};
      },
    });
    assert.equal(tool, null);
    assert.equal(connected, false);
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});
