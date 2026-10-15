import assert from 'node:assert/strict';
import test from 'node:test';
import { PanelPositionControls } from './panelPositionControls.js';

/** Just enough DOM for PanelPositionControls' portable-panel paths. */
function fixture() {
  const saved = Object.fromEntries(
    ['document', 'window', 'localStorage', 'performance', 'ResizeObserver'].map(
      (key) => [key, globalThis[key]],
    ),
  );
  const store = new Map();
  const element = () => {
    const classes = new Set();
    const style = {
      removeProperty(name) {
        // Like CSSStyleDeclaration: 'z-index' also clears style.zIndex.
        delete this[name];
        delete this[name.replace(/-([a-z])/g, (_, c) => c.toUpperCase())];
      },
      getPropertyValue: () => '',
    };
    return Object.assign(new EventTarget(), {
      id: '',
      style,
      dataset: {},
      classList: {
        add: (...names) => names.forEach((name) => classes.add(name)),
        remove: (...names) => names.forEach((name) => classes.delete(name)),
        contains: (name) => classes.has(name),
        toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)),
      },
      querySelector: () => null,
      querySelectorAll: () => [],
      closest: () => null,
      setAttribute() {},
      removeAttribute() {},
      appendChild() {},
      remove() {},
      getBoundingClientRect: () => ({
        left: 100,
        top: 80,
        width: 360,
        height: 420,
        right: 460,
        bottom: 500,
      }),
    });
  };
  globalThis.document = Object.assign(new EventTarget(), {
    getElementById: () => null,
    querySelectorAll: () => [],
    createElement: () => element(),
  });
  globalThis.window = Object.assign(new EventTarget(), {
    innerWidth: 1440,
    innerHeight: 900,
  });
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
  const calls = { layout: 0, resized: [] };
  const owner = new PanelPositionControls({
    syncPanelCollapseButton() {},
    layoutRightPanels: () => calls.layout++,
    syncCctvPanelViewport() {},
    showToast() {},
    onPanelResized: (id) => calls.resized.push(id),
  });
  return {
    owner,
    element,
    store,
    calls,
    restore() {
      owner.destroy();
      Object.assign(globalThis, saved);
    },
  };
}

function floatingPanel(f, id, { dockOnCollapse = false } = {}) {
  const panel = f.element();
  const handle = f.element();
  panel.id = id;
  panel.classList.add('panel-floating', 'panel-draggable');
  Object.assign(panel.style, {
    left: '100px',
    top: '80px',
    width: '360px',
    height: '420px',
  });
  f.store.set(`godsEyeView.v8.panelPos.${id}`, '{"floating":true}');
  f.owner._portablePanels.set(id, {
    panel,
    min: { width: 320, height: 280 },
    dockOnCollapse,
  });
  f.owner._makePanelDraggable(id, panel, handle);
  return { panel, handle };
}

/** A left-button header press; `timeStamp` is a read-only getter on Event. */
function press(handle, { timeStamp, clientX = 200, clientY = 90 }) {
  const event = new Event('pointerdown', { cancelable: true });
  for (const [key, value] of Object.entries({
    button: 0,
    clientX,
    clientY,
    timeStamp,
  }))
    Object.defineProperty(event, key, { value });
  handle.dispatchEvent(event);
}

test('dockPanel returns a floating window to its rail and forgets its place', () => {
  const f = fixture();
  try {
    const { panel } = floatingPanel(f, 'street-level-panel');
    assert.equal(f.owner.dockPanel('street-level-panel'), true);
    assert.equal(panel.classList.contains('panel-floating'), false);
    assert.equal(panel.style.width, undefined);
    assert.equal(panel.style.height, undefined);
    assert.equal(
      f.store.has('godsEyeView.v8.panelPos.street-level-panel'),
      false,
    );
    assert.deepEqual(f.calls.resized, ['street-level-panel']);
    assert.equal(
      f.owner.dockPanel('street-level-panel'),
      false,
      'already docked',
    );
    assert.equal(f.owner.dockPanel('unknown'), false);
  } finally {
    f.restore();
  }
});

test('only a dockOnCollapse panel docks when collapsed, and only on collapse', () => {
  const f = fixture();
  try {
    const street = floatingPanel(f, 'street-level-panel', {
      dockOnCollapse: true,
    });
    const cctv = floatingPanel(f, 'cctv-panel');
    f.owner.onPanelCollapsed('street-level-panel', false);
    assert.equal(
      street.panel.classList.contains('panel-floating'),
      true,
      'expanding keeps it',
    );
    f.owner.onPanelCollapsed('cctv-panel', true);
    assert.equal(
      cctv.panel.classList.contains('panel-floating'),
      true,
      'CCTV did not opt in',
    );
    f.owner.onPanelCollapsed('street-level-panel', true);
    assert.equal(street.panel.classList.contains('panel-floating'), false);
  } finally {
    f.restore();
  }
});

test('two quick header presses snap a floating panel back; slow or distant ones do not', () => {
  const f = fixture();
  try {
    const { panel, handle } = floatingPanel(f, 'cctv-panel');
    press(handle, { timeStamp: 1000 });
    window.dispatchEvent(new Event('pointerup'));
    press(handle, { timeStamp: 1600 });
    window.dispatchEvent(new Event('pointerup'));
    assert.equal(
      panel.classList.contains('panel-floating'),
      true,
      '600 ms apart is two clicks',
    );
    press(handle, { timeStamp: 1700, clientX: 260 });
    window.dispatchEvent(new Event('pointerup'));
    assert.equal(
      panel.classList.contains('panel-floating'),
      true,
      '60 px apart is two clicks',
    );
    press(handle, { timeStamp: 1900, clientX: 262 });
    assert.equal(
      panel.classList.contains('panel-floating'),
      false,
      'a double press docks',
    );
  } finally {
    f.restore();
  }
});

test('a restored floating window stacks above the docked DISPLAY panel (z 110)', () => {
  const f = fixture();
  try {
    const panel = f.element();
    panel.id = 'street-level-panel';
    f.owner._portablePanels.set('street-level-panel', {
      panel,
      min: { width: 320, height: 280 },
      dockOnCollapse: true,
    });
    f.store.set(
      'godsEyeView.v8.panelPos.street-level-panel',
      JSON.stringify({
        left: 900,
        top: 200,
        width: 420,
        height: 600,
        floating: true,
      }),
    );
    f.owner._restorePanelPosition('street-level-panel', panel);
    assert.equal(panel.classList.contains('panel-floating'), true);
    assert.ok(Number(panel.style.zIndex) > 110, `z ${panel.style.zIndex}`);
    f.owner.dockPanel('street-level-panel');
    assert.equal(panel.style.zIndex, undefined, 'docking drops the promotion');
  } finally {
    f.restore();
  }
});

test('renumbering the z ladder never drops a window below the docked panels', () => {
  const f = fixture();
  try {
    const windows = [f.element(), f.element(), f.element()];
    windows.forEach((node, index) => {
      node.classList.add('panel-draggable');
      node.style.zIndex = String(130 + index);
    });
    globalThis.document.querySelectorAll = (selector) =>
      selector === '.panel-draggable' ? windows : [];
    f.owner._panelZCounter = 139;
    const top = f.element();
    top.classList.add('panel-draggable');
    f.owner._promotePanelZ(top);
    for (const node of [...windows, top])
      assert.ok(Number(node.style.zIndex) > 110, `z ${node.style.zIndex}`);
    assert.ok(Number(top.style.zIndex) > Number(windows[2].style.zIndex));
  } finally {
    f.restore();
  }
});

/** A portable panel still in its rail, with its header and resize handles. */
function dockedPanel(f, id) {
  const panel = f.element();
  const handle = f.element();
  panel.id = id;
  const portable = { panel, min: { width: 320, height: 280 } };
  f.owner._portablePanels.set(id, portable);
  f.owner._makePanelDraggable(id, panel, handle);
  f.owner._makePanelResizable(id, panel, portable.min);
  const edges = Object.fromEntries(
    f.owner._resizeHandles.map((node) => [node.dataset.dir, node]),
  );
  return { panel, handle, edges };
}

/** A pointer event; `pointerType` defaults to what a mouse reports. */
function pointer(target, type, { x = 200, y = 90, pointerType = 'mouse' }) {
  const event = new Event(type, { cancelable: true });
  for (const [key, value] of Object.entries({
    button: 0,
    clientX: x,
    clientY: y,
    pointerType,
  }))
    Object.defineProperty(event, key, { value });
  target.dispatchEvent(event);
  return event;
}

const POSITION_KEY = 'godsEyeView.v8.panelPos.street-level-panel';

test('a click on a docked panel’s resize edge leaves it docked and stores nothing', () => {
  const f = fixture();
  try {
    const { panel, edges } = dockedPanel(f, 'street-level-panel');
    pointer(edges.w, 'pointerdown', { x: 101, y: 200 });
    pointer(window, 'pointermove', { x: 103, y: 201 }); // a jittery click
    pointer(window, 'pointerup', { x: 103, y: 201 });
    assert.equal(panel.classList.contains('panel-floating'), false);
    assert.equal(panel.style.width, undefined, 'no size was pinned');
    assert.equal(f.store.has(POSITION_KEY), false);
    assert.deepEqual(f.calls.resized, []);

    // A real resize still lifts it out and remembers the window.
    pointer(edges.w, 'pointerdown', { x: 101, y: 200 });
    pointer(window, 'pointermove', { x: 61, y: 200 });
    pointer(window, 'pointerup', { x: 61, y: 200 });
    assert.equal(panel.classList.contains('panel-floating'), true);
    assert.equal(JSON.parse(f.store.get(POSITION_KEY)).floating, true);
  } finally {
    f.restore();
  }
});

test('a touch on the header or an edge does not lift the panel, and the rail can still scroll', () => {
  const f = fixture();
  try {
    const { panel, handle, edges } = dockedPanel(f, 'street-level-panel');
    const press = pointer(handle, 'pointerdown', { pointerType: 'touch' });
    assert.equal(press.defaultPrevented, false, 'the swipe can scroll');
    pointer(window, 'pointermove', { y: 190, pointerType: 'touch' });
    pointer(window, 'pointerup', { y: 190, pointerType: 'touch' });
    pointer(edges.s, 'pointerdown', { y: 500, pointerType: 'touch' });
    pointer(window, 'pointermove', { y: 600, pointerType: 'touch' });
    pointer(window, 'pointerup', { y: 600, pointerType: 'touch' });
    assert.equal(panel.classList.contains('panel-floating'), false);
    assert.equal(f.store.has(POSITION_KEY), false);
  } finally {
    f.restore();
  }
});

test('a pointercancel mid-drag saves nothing and puts the panel back', () => {
  const f = fixture();
  try {
    const { panel, handle, edges } = dockedPanel(f, 'street-level-panel');
    pointer(handle, 'pointerdown', {});
    pointer(window, 'pointermove', { x: 260, y: 140 });
    assert.equal(panel.classList.contains('panel-floating'), true, 'lifted');
    pointer(window, 'pointercancel', { x: 260, y: 140 });
    assert.equal(panel.classList.contains('panel-floating'), false, 'docked');
    assert.equal(f.store.has(POSITION_KEY), false);

    pointer(edges.e, 'pointerdown', { x: 459 });
    pointer(window, 'pointermove', { x: 520 });
    pointer(window, 'pointercancel', { x: 520 });
    assert.equal(panel.classList.contains('panel-floating'), false);
    assert.equal(f.store.has(POSITION_KEY), false);
  } finally {
    f.restore();
  }
});

test('a pointercancel while dragging a floating window returns it to where it was', () => {
  const f = fixture();
  try {
    const { panel, handle } = floatingPanel(f, 'cctv-panel');
    const stored = f.store.get('godsEyeView.v8.panelPos.cctv-panel');
    pointer(handle, 'pointerdown', {});
    pointer(window, 'pointermove', { x: 400, y: 300 });
    assert.notEqual(panel.style.left, '100px', 'it moved');
    pointer(window, 'pointercancel', { x: 400, y: 300 });
    assert.equal(panel.style.left, '100px');
    assert.equal(panel.style.top, '80px');
    assert.equal(panel.classList.contains('panel-floating'), true);
    assert.equal(f.store.get('godsEyeView.v8.panelPos.cctv-panel'), stored);
  } finally {
    f.restore();
  }
});

test('a header press that travels under the drag threshold is a click, not a lift', () => {
  const f = fixture();
  try {
    const { panel, handle } = dockedPanel(f, 'street-level-panel');
    pointer(handle, 'pointerdown', { x: 200, y: 90 });
    pointer(window, 'pointermove', { x: 202, y: 90 });
    pointer(window, 'pointerup', { x: 202, y: 90 });
    assert.equal(panel.classList.contains('panel-floating'), false);
    assert.equal(panel.classList.contains('panel-dragging'), false);
    assert.equal(f.store.has(POSITION_KEY), false);
    assert.equal(f.calls.layout, 0, 'the rail was not re-laid out');
    assert.deepEqual(f.calls.resized, []);
  } finally {
    f.restore();
  }
});

/**
 * Both portable panels wired through _initPanelDrag. Headers are the top
 * 36 px; `obstacles` stand in for the command dock and voice pill.
 * ResizeObserver callbacks run on `observe()`.
 */
function portableShell(f, { stored = {}, box = {}, obstacles = {} } = {}) {
  const observers = [];
  globalThis.ResizeObserver = class {
    constructor(callback) {
      this.callback = callback;
      this.targets = [];
      observers.push(this);
    }
    observe(target) {
      this.targets.push(target);
    }
    disconnect() {}
  };
  const nodes = new Map();
  const panels = {};
  for (const id of ['cctv-panel', 'street-level-panel']) {
    const panel = f.element();
    const handle = f.element();
    const natural = { width: 360, height: 420, ...box[id] };
    panel.id = id;
    panel.querySelector = (selector) =>
      selector === '.panel-header' ? handle : null;
    panel.getBoundingClientRect = () => {
      const left = parseFloat(panel.style.left) || 0;
      const top = parseFloat(panel.style.top) || 0;
      const width = parseFloat(panel.style.width) || natural.width;
      const height = parseFloat(panel.style.height) || natural.height;
      return {
        left,
        top,
        width,
        height,
        right: left + width,
        bottom: top + height,
      };
    };
    handle.getBoundingClientRect = () => {
      const rect = panel.getBoundingClientRect();
      return { ...rect, height: 36, bottom: rect.top + 36 };
    };
    if (stored[id])
      f.store.set(
        `godsEyeView.v8.panelPos.${id}`,
        JSON.stringify({ floating: true, ...stored[id] }),
      );
    nodes.set(id, panel);
    panels[id] = { panel, handle, natural };
  }
  const obstacle = (id, rect) =>
    nodes.set(id, {
      getBoundingClientRect: () => ({
        ...rect,
        width: rect.right - rect.left,
        height: rect.bottom - rect.top,
      }),
    });
  for (const [id, rect] of Object.entries(obstacles)) obstacle(id, rect);
  globalThis.document.getElementById = (id) => nodes.get(id) ?? null;
  f.owner._initPanelDrag();
  return {
    ...panels,
    obstacle,
    observed: (node) => observers.some(({ targets }) => targets.includes(node)),
    contentResized: () => observers.forEach(({ callback }) => callback([])),
  };
}

test('a floating window whose content grows is pulled back on-screen', () => {
  const f = fixture();
  try {
    const shell = portableShell(f, {
      stored: { 'cctv-panel': { left: 900, top: 380 } },
    });
    const { panel, natural } = shell['cctv-panel'];
    assert.equal(panel.style.top, '380px');
    assert.equal(shell.observed(panel), true, 'its size is watched');
    assert.equal(shell.observed(shell['street-level-panel'].panel), true);
    // Expanding the collapsed strip, or an image opening in Street Level.
    natural.height = 800;
    shell.contentResized();
    assert.equal(panel.style.top, `${900 - 800 - 6}px`);
    assert.equal(panel.style.left, '900px');
  } finally {
    f.restore();
  }
});

test('a live window resize shrinks a floating window larger than the viewport', () => {
  const f = fixture();
  try {
    const shell = portableShell(f, {
      stored: {
        'cctv-panel': { left: 100, top: 80, width: 1300, height: 700 },
      },
    });
    const { panel } = shell['cctv-panel'];
    assert.equal(panel.style.width, '1300px');
    Object.assign(window, { innerWidth: 1000, innerHeight: 500 });
    window.dispatchEvent(new Event('resize'));
    assert.equal(panel.style.width, '988px');
    assert.equal(panel.style.height, '488px');
    assert.equal(panel.style.left, '6px');
    assert.equal(panel.style.top, '6px');
    // A window that already fits keeps the size the user gave it.
    Object.assign(window, { innerWidth: 1440, innerHeight: 900 });
    window.dispatchEvent(new Event('resize'));
    assert.equal(panel.style.width, '988px');
  } finally {
    f.restore();
  }
});

const DOCK = { left: 300, top: 820, right: 1140, bottom: 882 };

test('a floating header never lands under the command dock or voice pill', () => {
  const f = fixture();
  try {
    const shell = portableShell(f, {
      stored: { 'cctv-panel': { left: 100, top: 80 } },
      // A collapsed CCTV window is just its header strip.
      box: { 'cctv-panel': { height: 36 } },
      obstacles: { 'command-dock': DOCK },
    });
    const { panel, handle, natural } = shell['cctv-panel'];
    const above = DOCK.top - 36 - 6;

    // Drag: the strip dropped at the bottom centre stops above the dock.
    pointer(handle, 'pointerdown', { x: 200, y: 90 });
    pointer(window, 'pointermove', { x: 720, y: 880 });
    assert.equal(panel.style.top, `${above}px`);
    pointer(window, 'pointerup', { x: 720, y: 880 });
    const key = 'godsEyeView.v8.panelPos.cctv-panel';
    assert.equal(JSON.parse(f.store.get(key)).top, above);

    // Restore: a place saved under the dock (older build) comes back clear.
    f.store.set(key, JSON.stringify({ left: 620, top: 858, floating: true }));
    f.owner._restorePanelPosition('cctv-panel', panel);
    assert.equal(panel.style.top, `${above}px`);

    // Re-clamp: the voice pill measured when the window resizes.
    Object.assign(panel.style, { left: '1000px', top: '700px' });
    shell.obstacle('gev-voice-control', {
      left: 1190,
      top: 690,
      right: 1404,
      bottom: 740,
    });
    window.dispatchEvent(new Event('resize'));
    assert.equal(panel.style.top, `${690 - 36 - 6}px`);

    // Only the header has to stay clear: a body over the dock is fine.
    natural.height = 200;
    Object.assign(panel.style, { left: '620px', top: '650px' });
    window.dispatchEvent(new Event('resize'));
    assert.equal(panel.style.top, '650px');
  } finally {
    f.restore();
  }
});

test('a collapsed floating window keeps its chosen height through a drag and a reload', () => {
  const f = fixture();
  try {
    const { panel, handle } = floatingPanel(f, 'cctv-panel');
    panel.style.height = '500px';
    panel.classList.add('collapsed');
    // Collapsed, the window measures only its header strip.
    panel.getBoundingClientRect = () => {
      const left = parseFloat(panel.style.left);
      const top = parseFloat(panel.style.top);
      return {
        left,
        top,
        width: 360,
        height: 50,
        right: left + 360,
        bottom: top + 50,
      };
    };
    pointer(handle, 'pointerdown', { x: 200, y: 90 });
    pointer(window, 'pointermove', { x: 260, y: 140 });
    pointer(window, 'pointerup', { x: 260, y: 140 });
    const record = JSON.parse(
      f.store.get('godsEyeView.v8.panelPos.cctv-panel'),
    );
    assert.equal(record.height, 500, 'the chosen height, not the strip');
    assert.equal(record.width, 360);

    // Reload: a fresh panel restores the size it expands to.
    const reloaded = f.element();
    reloaded.id = 'cctv-panel';
    f.owner._restorePanelPosition('cctv-panel', reloaded);
    assert.equal(reloaded.style.height, '500px');
  } finally {
    f.restore();
  }
});
