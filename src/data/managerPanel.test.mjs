// src/data/managerPanel.test.mjs — the manager's layer rows, rendered into a
// real DOM: toggles keep keyboard focus through transitions, row chips write
// the params they declare, and legends, info lines and lists follow the layer.
import '../testSupport/registerDom.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DataLayerManager } from './manager.js';
import { assertSameNode } from '../testSupport/domAssert.mjs';

/** Build a mock layer whose init/update resolve on the next microtask. */
function makeSlowLayer(id, { updateInterval = 1000 } = {}) {
  const calls = { enable: 0, disable: 0, update: 0, init: 0 };
  return {
    calls,
    module: {
      id,
      name: id,
      icon: '',
      source: 'test',
      updateInterval,
      async init() {
        calls.init++;
        await Promise.resolve();
      },
      enable() {
        calls.enable++;
      },
      disable() {
        calls.disable++;
      },
      async update() {
        calls.update++;
        await Promise.resolve();
      },
      getStats() {
        return { count: 0, lastUpdate: null };
      },
    },
  };
}

/** A layer that declares a two-state chip plus a legend, like satellites. */
function makeRowControlLayer() {
  let mode = 'core';
  return {
    get mode() {
      return mode;
    },
    module: {
      id: 'satellites',
      name: 'Satellites',
      icon: '',
      source: 'CelesTrak',
      updateInterval: -1,
      async init() {},
      enable() {},
      disable() {},
      async update() {},
      getStats() {
        return { count: 3, lastUpdate: Date.now() };
      },
      setParams(params) {
        if (params.catalog) mode = params.catalog;
      },
      getParams() {
        return { catalog: mode };
      },
      getRowControls() {
        const dense = mode === 'dense';
        return {
          chips: [
            {
              id: 'catalog',
              label: 'DENSE',
              active: dense,
              title: 'toggle the dense catalog',
              params: { catalog: dense ? 'core' : 'dense' },
            },
          ],
          legend: [
            {
              klass: 'nav',
              label: 'NAV',
              color: '#4fd8ff',
              blurb: 'GNSS',
              count: 2,
            },
            {
              klass: 'geo',
              label: 'GEO',
              color: '#c89bff',
              blurb: 'belt',
              count: 5,
            },
          ],
        };
      },
    },
  };
}

function panelHost(t) {
  document.body.replaceChildren();
  const container = document.body.appendChild(document.createElement('div'));
  container.id = 'data-toggles';
  t.after(() => document.body.replaceChildren());
  return container;
}

const row = (container, id) =>
  container.querySelector(`[data-layer-id="${id}"]`);
const chipsIn = (node) => [...node.querySelectorAll('.data-toggle-chip')];
const macrotask = () => new Promise((resolve) => setTimeout(resolve, 0));

async function waitFor(predicate, label) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await macrotask();
  }
  assert.fail(`timed out waiting for ${label}`);
}

test('renders ordinary layer rows without recreating a panel-hidden coordinator', async (t) => {
  const container = panelHost(t);
  const mgr = new DataLayerManager({});
  const ordinary = makeSlowLayer('flights', { updateInterval: -1 });
  const coordinator = makeSlowLayer('military-awareness', {
    updateInterval: -1,
  });
  coordinator.module.showInTogglePanel = false;
  mgr.register(ordinary.module);
  mgr.register(coordinator.module);
  try {
    mgr.buildTogglePanel(container);
    assert.ok(row(container, 'flights'));
    assert.ok(!row(container, 'military-awareness'));
    assert.equal(await mgr.setEnabled('military-awareness', true), true);
    mgr._refreshTogglePanel();
    assert.ok(!row(container, 'military-awareness'));
    assert.equal(
      mgr.getAll().find(({ id }) => id === 'military-awareness').enabled,
      true,
    );
  } finally {
    await mgr.destroyAll();
  }
});

test('keyboard focus survives Data Layer enabling and disabling transitions', async (t) => {
  const container = panelHost(t);
  const mgr = new DataLayerManager({});
  let releaseEnable;
  let releaseDisable;
  const calls = { enable: 0, disable: 0 };
  mgr.register({
    id: 'focus-layer',
    name: 'Focus layer',
    icon: '',
    source: 'Local focus fixture',
    updateInterval: -1,
    init() {},
    enable() {
      calls.enable += 1;
      return new Promise((resolve) => {
        releaseEnable = resolve;
      });
    },
    disable() {
      calls.disable += 1;
      return new Promise((resolve) => {
        releaseDisable = resolve;
      });
    },
    update() {},
    destroy() {},
    getStats() {
      return { count: 1, lastUpdate: Date.now() };
    },
  });

  try {
    mgr.buildTogglePanel(container);
    const button = row(container, 'focus-layer').querySelector(
      '.data-toggle-btn',
    );
    button.focus();

    button.click();
    await waitFor(
      () => typeof releaseEnable === 'function',
      'enable transition',
    );
    assertSameNode(document.activeElement, button);
    assert.equal(button.disabled, false, 'ENABLING never uses native disabled');
    assert.equal(button.getAttribute('aria-disabled'), 'true');
    assert.equal(button.getAttribute('aria-busy'), 'true');
    assert.equal(button.textContent, 'ENABLING');
    button.click();
    await macrotask();
    assert.equal(calls.enable, 1, 'repeat activation is inert while enabling');
    assert.equal(mgr.layers.get('focus-layer').visibilityIntentEpoch, 1);

    releaseEnable();
    await waitFor(
      () =>
        mgr.isEnabled('focus-layer') &&
        button.getAttribute('aria-busy') === 'false',
      'enabled',
    );
    assertSameNode(document.activeElement, button);
    assertSameNode(
      row(container, 'focus-layer').querySelector('.data-toggle-btn'),
      button,
      'the SAME button node is reused across the transition',
    );
    assert.equal(button.disabled, false);
    assert.equal(button.getAttribute('aria-disabled'), 'false');

    button.click();
    await waitFor(
      () => typeof releaseDisable === 'function',
      'disable transition',
    );
    assertSameNode(document.activeElement, button);
    assert.equal(
      button.disabled,
      false,
      'DISABLING never uses native disabled',
    );
    assert.equal(button.getAttribute('aria-disabled'), 'true');
    assert.equal(button.getAttribute('aria-busy'), 'true');
    assert.equal(button.textContent, 'DISABLING');
    button.click();
    await macrotask();
    assert.equal(
      calls.disable,
      1,
      'repeat activation is inert while disabling',
    );
    assert.equal(mgr.layers.get('focus-layer').visibilityIntentEpoch, 2);

    releaseDisable();
    await waitFor(
      () =>
        !mgr.isEnabled('focus-layer') &&
        button.getAttribute('aria-busy') === 'false',
      'disabled',
    );
    assertSameNode(document.activeElement, button);
    assert.equal(button.disabled, false);
    assert.equal(button.getAttribute('aria-disabled'), 'false');
  } finally {
    releaseEnable?.();
    releaseDisable?.();
    await mgr.destroyAll();
  }
});

test('a failed Data Layer transition clears busy state without losing keyboard focus', async (t) => {
  const container = panelHost(t);
  const originalWarn = console.warn;
  console.warn = () => {};
  const mgr = new DataLayerManager({});
  let rejectEnable;
  let enableCalls = 0;
  mgr.register({
    id: 'focus-failure-layer',
    name: 'Focus failure layer',
    icon: '',
    source: 'Local focus fixture',
    updateInterval: -1,
    init() {},
    enable() {
      enableCalls += 1;
      if (enableCalls > 1) return true;
      return new Promise((resolve, reject) => {
        rejectEnable = reject;
      });
    },
    disable() {
      return true;
    },
    update() {},
    destroy() {},
    getStats() {
      return { count: 0, lastUpdate: null };
    },
  });

  try {
    mgr.buildTogglePanel(container);
    const button = row(container, 'focus-failure-layer').querySelector(
      '.data-toggle-btn',
    );
    button.focus();

    button.click();
    await waitFor(
      () => typeof rejectEnable === 'function',
      'enable transition',
    );
    assertSameNode(document.activeElement, button);
    assert.equal(button.getAttribute('aria-disabled'), 'true');
    assert.equal(button.getAttribute('aria-busy'), 'true');

    rejectEnable(new Error('QA enable rejected'));
    await waitFor(
      () => button.getAttribute('aria-busy') === 'false',
      'failure settlement',
    );
    assertSameNode(
      document.activeElement,
      button,
      'failure settlement preserves focus',
    );
    assert.equal(button.disabled, false);
    assert.equal(button.getAttribute('aria-disabled'), 'false');
    assert.equal(button.textContent, 'OFF');
    assert.deepEqual(mgr.getLayerLifecycleState('focus-failure-layer'), {
      enabled: false,
      lifecycleState: 'disabled',
      uncertain: false,
    });

    button.click();
    await waitFor(() => mgr.isEnabled('focus-failure-layer'), 'retry');
    assert.equal(enableCalls, 2, 'the settled control accepts a later retry');
    assertSameNode(document.activeElement, button);
  } finally {
    rejectEnable?.(new Error('test cleanup'));
    console.warn = originalWarn;
    await mgr.destroyAll();
  }
});

test('a layer that declares row controls renders its chips and color legend', async (t) => {
  const container = panelHost(t);
  const mgr = new DataLayerManager({});
  const layer = makeRowControlLayer();
  mgr.register(layer.module);
  try {
    mgr.buildTogglePanel(container);
    const controls = row(container, 'satellites').querySelector(
      '.data-toggle-controls',
    );
    assert.ok(controls, 'the row gained a controls block');
    // Disabled layers stay quiet — no chip, no legend.
    assert.equal(controls.hidden, true);

    assert.equal(await mgr.setEnabled('satellites', true), true);
    mgr._refreshTogglePanel();
    assert.equal(controls.hidden, false);

    const chips = chipsIn(controls);
    assert.equal(chips.length, 1);
    assert.equal(chips[0].textContent, 'DENSE');
    assert.equal(chips[0].dataset.chipId, 'catalog');
    assert.equal(chips[0].getAttribute('aria-pressed'), 'false');
    assert.equal(chips[0].title, 'toggle the dense catalog');

    const swatches = [
      ...controls.querySelectorAll('.data-toggle-legend-swatch'),
    ];
    assert.deepEqual(
      swatches.map((s) => s.style.background),
      ['#4fd8ff', '#c89bff'],
      'each legend swatch is painted the exact class color',
    );
    const items = [...controls.querySelectorAll('.data-toggle-legend-item')];
    assert.deepEqual(
      items.map((i) => i.title),
      ['GNSS', 'belt'],
    );
    assert.deepEqual(
      items.map((i) => i.textContent),
      ['NAV 2', 'GEO 5'],
    );
  } finally {
    await mgr.destroyAll();
  }
});

test('clicking a row chip applies the params it declared and re-renders', async (t) => {
  const container = panelHost(t);
  const mgr = new DataLayerManager({});
  const layer = makeRowControlLayer();
  mgr.register(layer.module);
  try {
    mgr.buildTogglePanel(container);
    assert.equal(await mgr.setEnabled('satellites', true), true);
    const controls = row(container, 'satellites').querySelector(
      '.data-toggle-controls',
    );
    const chip = chipsIn(controls)[0];

    chip.click();
    assert.equal(layer.mode, 'dense', 'the chip wrote the params it declared');
    // setLayerParams refreshes the panel, so the chip already reflects the flip.
    assert.equal(chip.getAttribute('aria-pressed'), 'true');
    assert.equal(chip.classList.contains('active'), true);

    chip.click();
    assert.equal(
      layer.mode,
      'core',
      'the chip toggles back rather than latching',
    );
    assert.equal(chip.getAttribute('aria-pressed'), 'false');
  } finally {
    await mgr.destroyAll();
  }
});

test('a click outside a chip is inert, and a throwing layer cannot blank the panel', async (t) => {
  const container = panelHost(t);
  const warn = console.warn;
  console.warn = () => {};
  const mgr = new DataLayerManager({});
  const layer = makeRowControlLayer();
  mgr.register(layer.module);
  try {
    mgr.buildTogglePanel(container);
    assert.equal(await mgr.setEnabled('satellites', true), true);
    const controls = row(container, 'satellites').querySelector(
      '.data-toggle-controls',
    );

    controls.querySelector('.data-toggle-legend-item').click();
    assert.equal(layer.mode, 'core', 'the legend is not a control');
    controls.click();
    assert.equal(layer.mode, 'core');

    layer.module.getRowControls = () => {
      throw new Error('boom');
    };
    mgr._refreshTogglePanel();
    assert.equal(
      controls.hidden,
      true,
      'a throwing layer collapses to an empty block',
    );
    assert.ok(row(container, 'satellites'), 'the row itself survives');
  } finally {
    console.warn = warn;
    await mgr.destroyAll();
  }
});

test('keyboard focus on a chip survives the refresh its own click triggers', async (t) => {
  // The panel repaints on EVERY refresh, including the one the chip's own
  // click triggers. Rebuilding the button would blur it every time, so a
  // keyboard user loses their place on activation.
  const container = panelHost(t);
  const mgr = new DataLayerManager({});
  const layer = makeRowControlLayer();
  mgr.register(layer.module);
  try {
    mgr.buildTogglePanel(container);
    assert.equal(await mgr.setEnabled('satellites', true), true);
    const controls = row(container, 'satellites').querySelector(
      '.data-toggle-controls',
    );
    const chip = chipsIn(controls)[0];

    chip.focus();
    assertSameNode(document.activeElement, chip, 'the chip starts focused');

    chip.click();
    assertSameNode(
      document.activeElement,
      chip,
      'activating the chip does not blur it',
    );
    assertSameNode(
      chipsIn(controls)[0],
      chip,
      'the SAME button node is reused across the click-driven refresh',
    );

    mgr._refreshTogglePanel();
    mgr._refreshTogglePanel();
    assertSameNode(
      document.activeElement,
      chip,
      'repeated refreshes never steal focus',
    );
    assert.equal(
      controls.querySelectorAll('.data-toggle-legend-item').length,
      2,
    );

    // ...and a chip that genuinely goes away is removed from the row.
    layer.module.getRowControls = () => ({ chips: [], legend: [] });
    mgr._refreshTogglePanel();
    assert.equal(chip.isConnected, false);
  } finally {
    await mgr.destroyAll();
  }
});

test('an async layer pushes its own row refresh, and a busy chip refuses clicks', async (t) => {
  const container = panelHost(t);
  const mgr = new DataLayerManager({});
  let settled = false;
  let writes = 0;
  const module = {
    id: 'satellites',
    name: 'Satellites',
    icon: '',
    source: 'CelesTrak',
    updateInterval: -1,
    async init() {},
    enable() {},
    disable() {},
    async update() {},
    getStats() {
      return { count: 1, lastUpdate: Date.now() };
    },
    setParams() {
      writes += 1;
    },
    getRowControls() {
      return {
        chips: [
          {
            id: 'catalog',
            label: settled ? 'DENSE' : 'DENSE ···',
            active: settled,
            busy: !settled,
            disabled: !settled,
            state: settled ? 'active' : 'loading',
            title: 'x',
            params: { catalog: 'core' },
          },
        ],
        legend: [],
      };
    },
    setRowControlsListener(fn) {
      module._listener = fn;
    },
  };
  mgr.register(module);
  try {
    mgr.buildTogglePanel(container);
    assert.equal(await mgr.setEnabled('satellites', true), true);
    assert.equal(
      typeof module._listener,
      'function',
      'the manager installed its listener',
    );

    const controls = row(container, 'satellites').querySelector(
      '.data-toggle-controls',
    );
    const chip = chipsIn(controls)[0];
    assert.equal(chip.textContent, 'DENSE ···');
    assert.equal(chip.disabled, true);
    assert.equal(chip.getAttribute('aria-busy'), 'true');
    assert.equal(
      chip.getAttribute('aria-pressed'),
      'false',
      'busy is never reported as active',
    );
    assert.equal(chip.classList.contains('chip-loading'), true);

    chip.click();
    assert.equal(writes, 0, 'a disabled chip is inert');

    // The layer settles and pushes its own refresh — no panel poll involved.
    settled = true;
    module._listener();
    mgr._layerPanel._flushRowControlsRefresh();
    assert.equal(chip.textContent, 'DENSE');
    assert.equal(chip.disabled, false);
    assert.equal(chip.getAttribute('aria-pressed'), 'true');
    assert.equal(chip.getAttribute('aria-busy'), 'false');

    chip.click();
    assert.equal(writes, 1, 'the settled chip writes again');
  } finally {
    await mgr.destroyAll();
  }
});

test('a layer that surrenders its row controls hides the block entirely', async (t) => {
  // Space Missions borrows the satellite layer with showPoints:false; the row
  // must not advertise a legend for an empty sky or offer a chip whose write
  // the dependency owner will silently revert.
  const container = panelHost(t);
  const mgr = new DataLayerManager({});
  let surrendered = false;
  const layer = makeRowControlLayer();
  const inner = layer.module.getRowControls;
  layer.module.getRowControls = () =>
    surrendered ? { chips: [], legend: [] } : inner();
  mgr.register(layer.module);
  try {
    mgr.buildTogglePanel(container);
    assert.equal(await mgr.setEnabled('satellites', true), true);
    const controls = row(container, 'satellites').querySelector(
      '.data-toggle-controls',
    );
    assert.equal(controls.hidden, false);
    assert.equal(chipsIn(controls).length, 1);

    surrendered = true;
    mgr._refreshTogglePanel();
    assert.equal(controls.hidden, true);
    assert.equal(
      chipsIn(controls).length,
      0,
      'the chip is removed, not merely hidden behind a style',
    );
    assert.equal(
      controls.querySelectorAll('.data-toggle-legend-item').length,
      0,
    );

    surrendered = false;
    mgr._refreshTogglePanel();
    assert.equal(
      controls.hidden,
      false,
      'the row returns when the owner releases it',
    );
    assert.equal(chipsIn(controls).length, 1);
  } finally {
    await mgr.destroyAll();
  }
});

test('panel remount releases old listeners and destruction revokes retained controls', async (t) => {
  panelHost(t);
  const manager = new DataLayerManager({});
  const layer = makeSlowLayer('lifecycle-panel', { updateInterval: -1 });
  let rowListener;
  layer.module.getRowControls = () => ({ chips: [] });
  layer.module.setRowControlsListener = (listener) => {
    rowListener = listener;
  };
  manager.register(layer.module);
  try {
    const first = document.body.appendChild(document.createElement('div'));
    manager.buildTogglePanel(first);
    const oldButton = first.querySelector('.data-toggle-btn');
    const second = document.body.appendChild(document.createElement('div'));
    manager.buildTogglePanel(second);
    assert.equal(first.children.length, 0, 'the old container is emptied');
    oldButton.click();
    await macrotask();
    assert.equal(
      layer.calls.enable,
      0,
      'a revoked generation cannot issue actions',
    );
    const currentButton = second.querySelector('.data-toggle-btn');
    assert.ok(currentButton);
    assert.equal(typeof rowListener, 'function');
    await manager.destroyAll();
    assert.equal(second.children.length, 0, 'destruction removes the rows');
    currentButton.click();
    await macrotask();
    assert.equal(
      layer.calls.enable,
      0,
      'a retained control cannot act after destruction',
    );
    assert.equal(rowListener, null);
  } finally {
    await manager.destroyAll();
  }
});

test('a retained chip from a remounted or destroyed panel writes nothing', async (t) => {
  panelHost(t);
  const mgr = new DataLayerManager({});
  const layer = makeRowControlLayer();
  mgr.register(layer.module);
  try {
    const first = document.body.appendChild(document.createElement('div'));
    mgr.buildTogglePanel(first);
    assert.equal(await mgr.setEnabled('satellites', true), true);
    const oldChip = chipsIn(first)[0];
    const second = document.body.appendChild(document.createElement('div'));
    mgr.buildTogglePanel(second);
    oldChip.click();
    assert.equal(
      layer.mode,
      'core',
      'a released generation cannot write params',
    );
    const chip = chipsIn(second)[0];
    mgr._layerPanel.destroy();
    chip.click();
    assert.equal(layer.mode, 'core', 'a destroyed panel cannot write params');
  } finally {
    await mgr.destroyAll();
  }
});

test('a toggle that settles after a remount repaints the new row idle', async (t) => {
  panelHost(t);
  const mgr = new DataLayerManager({});
  let releaseEnable;
  mgr.register({
    id: 'remount-layer',
    name: 'Remount layer',
    icon: '',
    source: 'Local fixture',
    updateInterval: -1,
    init() {},
    enable() {
      return new Promise((resolve) => {
        releaseEnable = resolve;
      });
    },
    disable() {},
    update() {},
    destroy() {},
    getStats() {
      return { count: 1, lastUpdate: Date.now() };
    },
  });
  try {
    const first = document.body.appendChild(document.createElement('div'));
    mgr.buildTogglePanel(first);
    first.querySelector('.data-toggle-btn').click();
    await waitFor(
      () => typeof releaseEnable === 'function',
      'enable transition',
    );
    const second = document.body.appendChild(document.createElement('div'));
    mgr.buildTogglePanel(second);
    releaseEnable();
    await waitFor(() => mgr.isEnabled('remount-layer'), 'enabled');
    await macrotask();
    const button = second.querySelector('.data-toggle-btn');
    assert.equal(button.getAttribute('aria-busy'), 'false');
    assert.equal(button.getAttribute('aria-disabled'), 'false');
    assert.equal(button.textContent, 'ON');
  } finally {
    releaseEnable?.();
    await mgr.destroyAll();
  }
});

test('row action chips use live disabled state and descriptive counts without writing parameters', async (t) => {
  const container = panelHost(t);
  const mgr = new DataLayerManager({});
  const layer = makeRowControlLayer();
  let calls = 0,
    blocked = false;
  layer.module.getStats = () => ({ count: 3, countLabel: '3 nearby' });
  layer.module.getRowControls = () => ({
    chips: [
      {
        id: 'find',
        label: 'SHOW NEAREST',
        disabled: blocked,
        onClick: () => calls++,
      },
    ],
  });
  layer.module.setParams = () => {
    throw new Error('navigation must not write persistent params');
  };
  mgr.register(layer.module);
  try {
    mgr.buildTogglePanel(container);
    await mgr.setEnabled('satellites', true);
    const layerRow = row(container, 'satellites');
    assert.equal(layerRow.querySelector('.data-count').textContent, '3 nearby');
    const chip = chipsIn(layerRow)[0];
    chip.click();
    assert.equal(calls, 1);
    blocked = true;
    chip.click();
    assert.equal(calls, 1, 'live disabled descriptor wins before row repaint');
    blocked = false;
    await mgr.setEnabled('satellites', false);
    assert.equal(chip.isConnected, false, 'the off row drops its chips');
    mgr._layerPanel._selectChip('satellites', 'find');
    assert.equal(calls, 1, 'disabled layer cannot navigate');
  } finally {
    await mgr.destroyAll();
  }
});

for (const scheduler of ['animation frame', 'timeout']) {
  test(`row notifications coalesce with ${scheduler} and stop after destroy`, async (t) => {
    const container = panelHost(t);
    const frames = new Map();
    let nextFrame = 0;
    const originalRaf = globalThis.requestAnimationFrame;
    const originalCancel = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame =
      scheduler === 'animation frame'
        ? (callback) => {
            frames.set(++nextFrame, callback);
            return nextFrame;
          }
        : undefined;
    globalThis.cancelAnimationFrame = (id) => frames.delete(id);
    const manager = new DataLayerManager({});
    const layer = makeSlowLayer('wind', { updateInterval: -1 });
    let notify;
    layer.module.getRowControls = () => ({ chips: [] });
    layer.module.setRowControlsListener = (listener) => {
      if (listener) notify = listener;
    };
    manager.register(layer.module);
    try {
      manager.buildTogglePanel(container);
      const panel = manager._layerPanel;
      let refreshes = 0;
      const refresh = panel._refreshTogglePanel.bind(panel);
      panel._refreshTogglePanel = () => {
        refreshes++;
        refresh();
      };
      for (let i = 0; i < 10; i++) notify();
      assert.equal(refreshes, 0, 'notifications defer refresh');
      if (scheduler === 'animation frame') assert.equal(frames.size, 1);
      panel._flushRowControlsRefresh();
      assert.equal(refreshes, 1);
      panel._flushRowControlsRefresh();
      await macrotask();
      assert.equal(frames.size, 0, 'flush cancels the pending frame');
      assert.equal(refreshes, 1, 'flush does not leave duplicate work');
      notify();
      notify();
      if (scheduler === 'animation frame') {
        const [id, callback] = frames.entries().next().value;
        frames.delete(id);
        callback();
      } else await macrotask();
      assert.equal(refreshes, 2, 'scheduled callback refreshes once');
      notify();
      panel.destroy();
      assert.equal(frames.size, 0, 'destroy cancels pending work');
      notify();
      panel._flushRowControlsRefresh();
      await macrotask();
      assert.equal(
        refreshes,
        2,
        'retained notifications after destroy are inert',
      );
    } finally {
      await manager.destroyAll();
      globalThis.requestAnimationFrame = originalRaf;
      globalThis.cancelAnimationFrame = originalCancel;
    }
  });
}

test('row info and legends reconcile in place while chips retain focus and order', async (t) => {
  const container = panelHost(t);
  const manager = new DataLayerManager({});
  const layer = makeSlowLayer('wind', { updateInterval: -1 });
  let controls = {
    chips: [{ id: 'one', label: 'One' }],
    legend: [{ label: 'Low', color: '#0000ff', count: 1, blurb: 'Low values' }],
    info: 'Forecast',
    infoTitle: 'Source time',
  };
  layer.module.getRowControls = () => controls;
  manager.register(layer.module);
  try {
    manager.buildTogglePanel(container);
    await manager.setEnabled('wind', true);
    const block = container.querySelector('.data-toggle-controls');
    const chip = block.children[0];
    const info = block.children[2];
    assert.equal(info.className, 'data-toggle-controls-info');
    assert.equal(info.textContent, 'Forecast');
    assert.equal(info.title, 'Source time');
    chip.focus();
    for (const change of [
      { label: 'High' },
      { color: '#ff0000' },
      { count: 2 },
      { blurb: 'High values' },
    ]) {
      controls = structuredClone(controls);
      Object.assign(controls.legend[0], change);
      manager._refreshTogglePanel();
      assertSameNode(block.children[2], info);
      assertSameNode(document.activeElement, chip);
    }
    const legend = block.children[1];
    assert.equal(legend.title, 'High values');
    assert.equal(legend.textContent, 'High 2');
    assert.equal(legend.firstElementChild.style.background, '#ff0000');
    controls.info = '<img onerror=alert(1)>';
    controls.infoTitle = '';
    controls.chips.push({ id: 'two', label: 'Two' });
    manager._refreshTogglePanel();
    assert.deepEqual(
      [...block.children].map((node) =>
        [...node.classList].filter((name) => !name.startsWith('ui-')).join(' '),
      ),
      [
        'data-toggle-chip chip-idle',
        'data-toggle-chip chip-idle',
        'data-toggle-legend-item',
        'data-toggle-controls-info',
      ],
    );
    assertSameNode(block.children[0], chip);
    assertSameNode(block.children[3], info);
    assert.equal(info.textContent, controls.info);
    assert.equal(info.title, '');
    assert.equal(info.children.length, 0, 'info remains plain text');
    controls = { chips: [], legend: [] };
    manager._refreshTogglePanel();
    assert.equal(block.hidden, true);
    assert.equal(info.hidden, true);
    assert.equal(block.children.length, 1);
    assertSameNode(block.children[0], info);
    controls = {
      info: 'Restored',
      legend: [{ label: 'New', color: '#ffffff' }],
    };
    manager._refreshTogglePanel();
    assertSameNode(block.lastElementChild, info);
    assert.equal(info.hidden, false);
    assert.equal(info.textContent, 'Restored');
  } finally {
    await manager.destroyAll();
  }
});
