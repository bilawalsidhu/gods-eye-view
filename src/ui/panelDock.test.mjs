import assert from 'node:assert/strict';
import test from 'node:test';
import { PanelPositionControls } from './panelPositionControls.js';

/** Just enough DOM for PanelPositionControls' portable-panel paths. */
function fixture() {
  const saved = Object.fromEntries(
    ['document', 'window', 'localStorage', 'performance'].map((key) => [
      key,
      globalThis[key],
    ]),
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
      removeAttribute() {},
      appendChild() {},
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
