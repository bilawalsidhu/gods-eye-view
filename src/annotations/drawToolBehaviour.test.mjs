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
  // The control whose presence means the page has Draw, and a focused button
  // whose Enter is its own.
  make('draw-toggle', 'BUTTON');
  make('draw-clear', 'BUTTON');

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
  const calls = { annotate: [], clear: 0, restyle: [], setHidden: [], frame: [], remove: [] };
  const marks = [];
  const listeners = new Set();
  const changed = () => listeners.forEach((listener) => listener());
  const find = (id) => marks.find((mark) => mark.id === id);
  return {
    calls,
    marks,
    listeners,
    changed,
    async annotate(specs, options) {
      calls.annotate.push({ specs, options });
      return { drawn: specs.length };
    },
    clear() {
      calls.clear += 1;
    },
    list: () => marks,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    restyle(id, change) {
      calls.restyle.push([id, change]);
      Object.assign(find(id), change);
      changed();
      return true;
    },
    setHidden(id, hidden) {
      calls.setHidden.push([id, hidden]);
      find(id).hidden = hidden;
      changed();
      return true;
    },
    frame(id) {
      calls.frame.push(id);
      return true;
    },
    remove(id) {
      calls.remove.push(id);
      marks.splice(marks.indexOf(find(id)), 1);
      changed();
      return true;
    },
  };
}

/** Stand up a tool against fresh doubles, with globals restored afterwards. */
function harness({ navigation = null, markActions = [] } = {}) {
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
    navigation,
    markActions,
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

test('Enter on the globe canvas finishes, as after the render failure notice hands focus back', async () => {
  const h = harness();
  try {
    h.act('toggleDraw');
    h.tool.setShape('area');
    h.tool.addVertex(-97.75, 30.26);
    h.tool.addVertex(-97.74, 30.26);
    h.tool.addVertex(-97.74, 30.27);

    // src/ui/views/panels/RenderFailure.vue focuses the canvas when the globe
    // draws again and the control that had focus is gone.
    h.documentDouble.emit('keydown', { key: 'Enter', target: h.viewer.scene.canvas });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(h.annotations.calls.annotate.length, 1, 'Enter on the canvas finishes');
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
    assert.equal(h.annotations.listeners.size, 1, 'the rows follow the board');

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
    assert.equal(h.annotations.listeners.size, 0, 'and it no longer follows the board');

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

test('the controls choose the shape and colour the next shape is drawn with; it is named in its row', async () => {
  const h = harness();
  try {
    h.act('toggleDraw');
    h.act('setDrawShape', 'line');
    h.act('setDrawColor', 'amber');
    assert.deepEqual(
      { ...h.shown.view, hint: undefined },
      { active: true, shape: 'line', color: 'amber', hint: undefined, marks: [] },
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
    assert.ok(!spec.label, 'a shape is named afterwards, in its row');
  } finally {
    h.restore();
  }
});

test('each drawn shape is a row whose actions reach the board, and fly-to is a navigation', async () => {
  const navigations = [];
  const h = harness({
    navigation: {
      runImmediateNavigation: (noun, navigate) => {
        navigations.push(noun);
        return navigate();
      },
    },
  });
  try {
    const board = h.annotations;
    board.marks.push(
      { id: 'a1', type: 'route', manual: true, name: null, label: '950 m', color: 'amber', hidden: false },
      { id: 'a2', type: 'pin', manual: false, label: 'Voice pin', color: 'primary', hidden: false },
    );
    board.changed();
    assert.deepEqual(
      h.shown.view.marks.map(({ id, placeholder, hidden }) => ({ id, placeholder, hidden })),
      [{ id: 'a1', placeholder: 'Line · 950 m', hidden: false }],
      'only hand-drawn marks are listed, an unnamed line by its length',
    );
    h.act('renameDrawMark', 'a1', 'Ridge walk');
    h.act('recolorDrawMark', 'a1', 'green');
    h.act('toggleDrawMark', 'a1');
    h.act('flyToDrawMark', 'a1');
    h.act('removeDrawMark', 'a1');
    assert.deepEqual(board.calls.restyle, [
      ['a1', { name: 'Ridge walk' }],
      ['a1', { color: 'green' }],
    ]);
    assert.deepEqual(board.calls.setHidden, [['a1', true]]);
    assert.deepEqual(board.calls.frame, ['a1']);
    assert.deepEqual(navigations, ['drawing'], 'fly-to goes through the navigation policy');
    assert.deepEqual(board.calls.remove, ['a1']);
    assert.deepEqual(h.shown.view.marks, [], 'the row goes with its mark');
  } finally {
    h.restore();
  }
});

test('an application\'s row actions show on the shapes they are for and run with the shape', async () => {
  const ran = [];
  const h = harness({
    markActions: [
      {
        id: 'tag',
        icon: 'sell',
        label: (name) => `Tag ${name}`,
        shapes: ['area', 'line'],
        run: (shape) => ran.push(['tag', shape]),
      },
      {
        id: 'measure',
        icon: 'straighten',
        label: (name) => `Measure ${name}`,
        shapes: ['area'],
        accepts: (geometry) => geometry.type === 'Polygon',
        run: (shape) => ran.push(['measure', shape]),
      },
    ],
  });
  try {
    const board = h.annotations;
    board.marks.push(
      { id: 'r1', type: 'area', manual: true, name: 'Strait', color: 'primary', hidden: false, ring: [[29, 41], [29.1, 41], [29.1, 41.1]] },
      { id: 'l1', type: 'route', manual: true, name: null, label: '9 km', color: 'amber', hidden: false, path: [{ lon: 29, lat: 41.05, height: 0 }, { lon: 29.1, lat: 41.05, height: 0 }] },
      { id: 'p1', type: 'pin', manual: true, name: 'Camp', color: 'red', hidden: false },
    );
    board.changed();
    assert.deepEqual(
      h.shown.view.marks.map(({ id, actions }) => [id, actions]),
      [
        ['r1', [
          { id: 'tag', icon: 'sell', label: 'Tag Strait' },
          { id: 'measure', icon: 'straighten', label: 'Measure Strait' },
        ]],
        ['l1', [{ id: 'tag', icon: 'sell', label: 'Tag Line · 9 km' }]],
        ['p1', []],
      ],
    );
    assert.equal(h.act('runDrawMarkAction', 'l1', 'tag'), true);
    assert.equal(h.act('runDrawMarkAction', 'l1', 'measure'), false, 'a line is not offered an area action');
    assert.equal(h.act('runDrawMarkAction', 'p1', 'tag'), false);
    assert.equal(h.act('runDrawMarkAction', 'gone', 'tag'), false);
    assert.equal(h.act('runDrawMarkAction', 'r1', 'measure'), true);
    assert.deepEqual(ran, [
      ['tag', { id: 'l1', shape: 'line', name: '', title: 'Line · 9 km', geometry: { type: 'LineString', coordinates: [[29, 41.05], [29.1, 41.05]] } }],
      ['measure', { id: 'r1', shape: 'area', name: 'Strait', title: 'Strait', geometry: { type: 'Polygon', coordinates: [[[29, 41], [29.1, 41], [29.1, 41.1], [29, 41]]] } }],
    ]);
  } finally {
    h.restore();
  }
});

test('an action that throws is reported and leaves the row alone', async () => {
  const h = harness({
    markActions: [
      { id: 'boom', icon: 'bolt', label: () => { throw new Error('label'); }, shapes: ['area'], run: () => { throw new Error('run'); } },
    ],
  });
  const warn = console.warn;
  const warned = [];
  console.warn = (...args) => warned.push(args[0]);
  try {
    h.annotations.marks.push({ id: 'r1', type: 'area', manual: true, name: null, color: 'primary', hidden: false, ring: [[0, 0], [1, 0], [1, 1]] });
    h.annotations.changed();
    assert.deepEqual(h.shown.view.marks[0].actions, [{ id: 'boom', icon: 'bolt', label: 'boom' }]);
    assert.equal(h.act('runDrawMarkAction', 'r1', 'boom'), false);
    assert.deepEqual(warned, ['[draw] boom failed']);
  } finally {
    console.warn = warn;
    h.restore();
  }
});

test('what a row action answers is its row\'s note; the row is busy until then, and a removed shape drops it', async () => {
  const pending = [];
  const h = harness({
    markActions: [
      {
        id: 'measure',
        icon: 'straighten',
        label: (name) => `Measure ${name}`,
        shapes: ['area'],
        run: () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
      },
      { id: 'now', icon: 'bolt', label: () => 'Now', shapes: ['area'], run: () => '  12 km²  ' },
      { id: 'long', icon: 'notes', label: () => 'Long', shapes: ['area'], run: () => `${'word '.repeat(60)}end` },
    ],
  });
  const warn = console.warn;
  console.warn = () => {};
  try {
    const board = h.annotations;
    const area = (id) => ({ id, type: 'area', manual: true, name: null, color: 'primary', hidden: false, ring: [[0, 0], [1, 0], [1, 1]] });
    board.marks.push(area('r1'), area('r2'));
    board.changed();
    const row = (id) => h.shown.view.marks.find((entry) => entry.id === id);
    assert.equal(h.act('runDrawMarkAction', 'r1', 'now'), true);
    assert.deepEqual([row('r1').busy, row('r1').note], [false, '12 km²']);
    h.act('runDrawMarkAction', 'r1', 'long');
    assert.ok(row('r1').note.length <= 200 && row('r1').note.endsWith('word…'), 'a long note is cut at a word');
    assert.equal(h.act('runDrawMarkAction', 'r1', 'measure'), true);
    assert.deepEqual([row('r1').busy, row('r1').note], [true, '']);
    assert.equal(h.act('runDrawMarkAction', 'r1', 'now'), false, 'a busy row takes no second press');
    pending[0].resolve('412 km², 38 km of edge');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual([row('r1').busy, row('r1').note], [false, '412 km², 38 km of edge']);
    h.act('runDrawMarkAction', 'r1', 'measure');
    pending[1].reject(new Error('refused'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual([row('r1').busy, row('r1').note], [false, ''], 'a failure clears the note');
    h.act('runDrawMarkAction', 'r2', 'measure');
    board.marks.splice(1, 1);
    board.changed();
    pending[2].resolve('late');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(row('r2'), undefined);
    board.marks.push(area('r2'));
    board.changed();
    assert.deepEqual([row('r2').busy, row('r2').note], [false, ''], 'a late answer never reaches a shape that went');
  } finally {
    console.warn = warn;
    h.restore();
  }
});

test('Backspace on the page removes the last vertex', () => {
  const h = harness();
  try {
    h.act('toggleDraw');
    h.tool.addVertex(-97.75, 30.26);
    h.tool.addVertex(-97.74, 30.26);
    h.documentDouble.emit('keydown', { key: 'Backspace', target: h.documentDouble.body });
    assert.equal(h.tool.session.vertices.length, 1);
  } finally {
    h.restore();
  }
});

test('keys on the shape list are the list\'s, not the drawing\'s', async () => {
  const h = harness();
  try {
    const listButton = new FakeElement('BUTTON');
    listButton.closest = (selector) => (selector === '#draw-mark-list' ? {} : null);
    const elsewhere = new FakeElement('INPUT', 'location-search');
    h.act('toggleDraw');
    h.tool.addVertex(-97.75, 30.26);
    h.tool.addVertex(-97.74, 30.26);
    h.documentDouble.emit('keydown', { key: 'Escape', target: listButton });
    assert.equal(h.tool.session.vertices.length, 2, 'Escape in the list keeps the shape');
    assert.equal(h.tool.active, true, 'and keeps Draw on');
    h.documentDouble.emit('keydown', { key: 'Enter', target: elsewhere });
    await Promise.resolve();
    assert.equal(h.annotations.calls.annotate.length, 0, 'another field keeps its Enter');
    h.documentDouble.emit('keydown', { key: 'Escape', target: h.documentDouble.body });
    assert.equal(h.tool.session.vertices.length, 0, 'Escape on the page drops the open shape');
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
