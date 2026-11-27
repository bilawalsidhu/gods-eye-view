// src/data/layerPanelContract.test.mjs — the layer panel interface, held for
// every layer the application registers. Each layer is enabled over the stub
// renderer with offline sources, the panel is mounted as the application
// mounts it (rows, Weather, News and the Recent Imagery readout), and the
// scene time is stepped. A layer describes its row as data
// (`getRowControls()`, read without side effects) and calls
// `panel.invalidate()`; the panel paints only what is displayed, at most once
// per frame, nothing while hidden, exactly once when shown again, and nothing
// when nothing changed.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplicationCatalog } from '../app/constructCatalog.js';
import { createStandaloneLayerSources } from '../standalone/layerSources.js';
import { createSurfaceServices } from '../app/surfaceServices.js';
import { LayerPresentation } from '../app/layerPresentation.js';
import { LayerLifecycle } from './lifecycle.js';
import { createStubRenderer } from '../render/stub/index.js';
import { createSceneHost } from '../render/rendererOf.js';
import { worldClock } from '../time/worldClock.js';
import { createRecentImageryPanel } from '../ui/recentImagery.js';
import { installFakeResizeObserver } from '../testSupport/fakeResizeObserver.mjs';

/**
 * Layers this test cannot enable under Node, driven directly instead: their
 * module's handle and rows against the real panel. Keep it short.
 * bhote-koshi-2026 is a scene layer with no Data Layers row; its enable needs
 * the scene's camera rectangle.
 */
const DRIVEN_DIRECTLY = ['bhote-koshi-2026'];
const TIME_STEPS = 6;

// A frame, and the turn after it in which mutation records arrive.
const frame = () =>
  new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
const settle = async (frames = 4) => {
  for (let i = 0; i < frames; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await frame();
  }
};

/** Offline answers: every feed is up and empty. */
function offlineFetch(url) {
  const text = String(url);
  if (/\/api\/(shipwrecks|drone-airspace|fire-perimeters)/.test(text))
    return Response.json({ rows: [], records: [], fetchedAt: Date.now() });
  if (/usgs/.test(text))
    return Response.json({ type: 'FeatureCollection', features: [] });
  return Response.json([]);
}

/** A 2D context that accepts every call (happy-dom has no canvas). */
function anything() {
  return new Proxy(function () {}, {
    get: (target, key) =>
      key in target
        ? target[key]
        : typeof key === 'symbol'
          ? undefined
          : key === 'width' || key === 'height'
            ? 8
            : key === 'data'
              ? new Uint8ClampedArray(4)
              : anything(),
    set: (target, key, value) => ((target[key] = value), true),
    apply: () => anything(),
  });
}

function surfaces() {
  document.body.replaceChildren();
  const make = (id, panelId) => {
    const panel = document.body.appendChild(document.createElement('section'));
    panel.id = panelId;
    panel.dataset.panelId = panelId;
    const body = panel.appendChild(document.createElement('div'));
    body.id = id;
    return body;
  };
  return {
    rows: make('data-toggles', 'data-panel'),
    utilities: make('utilities-toggles', 'utilities-panel'),
    weather: make('weather-panel-body', 'weather-panel'),
    news: make('news-panel-body', 'news-panel'),
    recentImagery: make('recent-imagery-panel-body', 'recent-imagery-panel'),
  };
}

test(
  'every registered layer keeps the layer panel interface',
  { timeout: 120_000 },
  async (t) => {
    t.mock.method(globalThis, 'fetch', async (url) => offlineFetch(url));
    t.mock.method(HTMLCanvasElement.prototype, 'getContext', () => anything());
    const originalWarn = console.warn;
    console.warn = () => {};
    const sizes = installFakeResizeObserver();
    const lifetime = new AbortController();
    const sources = createStandaloneLayerSources();
    sources['air-quality'] = { getSnapshot: async () => [] };
    const catalog = createApplicationCatalog({
      sources,
      signal: lifetime.signal,
      surface: createSurfaceServices({
        terrainSource: { getHeights: async () => [] },
        signal: lifetime.signal,
        eventTarget: null,
      }),
    });
    const el = surfaces();
    const renderer = createStubRenderer({ container: el.rows });
    const { host, release } = createSceneHost(renderer, { container: el.rows });
    // Assembled as app/data.js assembles it.
    const lifecycle = new LayerLifecycle(host, {});
    const presentation = new LayerPresentation(lifecycle, {
      weatherClock: catalog.weatherClock,
      requestRender() {},
      invalidateDetection() {},
    });
    t.after(async () => {
      presentation.destroy();
      await lifecycle.destroyAll();
      release();
      lifetime.abort();
      worldClock.goLive();
      sizes.restore();
      console.warn = originalWarn;
      // Fetch deadlines and the layers' own timers live on the window.
      await globalThis.happyDOM?.abort();
    });
    for (const layer of catalog.layers) lifecycle.register(layer);
    for (const layer of catalog.layers) layer.attachDataManager?.(lifecycle);
    lifecycle.finalizeRegistrations(catalog.metadata);
    presentation.mount(el.rows);
    presentation.attachRecentImagery((container) =>
      createRecentImageryPanel({
        container,
        viewer: host,
        layer: catalog.get('recent-imagery'),
        fetchImpl: async () => {
          throw new Error('offline');
        },
      }),
    );
    const panel = presentation.panel;
    const ids = catalog.layers.map(({ id }) => id);

    // ── Enable every layer ──────────────────────────────────────────────────
    const notEnabled = [];
    for (const id of ids) {
      const enabled = await lifecycle.setEnabled(id, true).catch(() => false);
      if (!enabled) notEnabled.push(id);
    }
    assert.deepEqual(
      notEnabled,
      DRIVEN_DIRECTLY,
      'only the listed layers are driven directly',
    );
    for (const id of ids) {
      const entry = lifecycle.layers.get(id);
      assert.equal(
        entry.module.setRowControlsListener,
        undefined,
        `${id} has no row listener`,
      );
      assert.equal(typeof entry.panel?.invalidate, 'function', id);
      assert.ok(Object.isFrozen(entry.panel), `${id}'s handle is frozen`);
    }
    // The directly driven layers get their handle as the others do.
    for (const id of DRIVEN_DIRECTLY) {
      const { module, panel: handle } = lifecycle.layers.get(id);
      await module.init?.(host, { signal: lifetime.signal, panel: handle });
    }
    await settle(8);

    // ── Counting paints ─────────────────────────────────────────────────────
    // A list render is a call that renders the list; a surface paint is a
    // frame in which its DOM changed.
    const lists = [el.rows, el.utilities];
    const renders = new Map(lists.map((list) => [list, 0]));
    const renderRows = panel._renderRows.bind(panel);
    panel._renderRows = (container, ...rest) => {
      renders.set(container, (renders.get(container) ?? 0) + 1);
      return renderRows(container, ...rest);
    };
    const watched = { ...el };
    const mutated = new Set();
    const observers = Object.fromEntries(
      Object.entries(watched).map(([name, element]) => {
        const observer = new MutationObserver((records) => {
          if (records.length) mutated.add(name);
        });
        observer.observe(element, {
          childList: true,
          subtree: true,
          attributes: true,
          characterData: true,
        });
        return [name, observer];
      }),
    );
    t.after(() => {
      for (const observer of Object.values(observers)) observer.disconnect();
    });
    // Mutation records arrive in a microtask after the paint; read them after
    // the frame and a turn.
    const take = () => {
      for (const [name, observer] of Object.entries(observers))
        if (observer.takeRecords().length) mutated.add(name);
      const painted = [...mutated].sort();
      mutated.clear();
      const counts = Object.fromEntries(
        [...renders].map(([list, count]) => [list.id, count]),
      );
      for (const list of renders.keys()) renders.set(list, 0);
      return { painted, renders: counts };
    };
    const show = (width, height) => {
      for (const element of Object.values(el))
        sizes.report(element, width, height);
    };
    const NONE = {
      painted: [],
      renders: { 'data-toggles': 0, 'utilities-toggles': 0 },
    };
    // Until the layers' own loads and timers stop changing what they report.
    const quiet = async () => {
      for (let i = 0; i < 200; i++) {
        await settle(1);
        const { painted, renders: counts } = take();
        if (!painted.length && Object.values(counts).every((n) => n === 0))
          return;
      }
      assert.fail('the layers never stopped changing');
    };
    const invalidateAll = (times = 1) => {
      for (let i = 0; i < times; i++)
        for (const id of ids) lifecycle.layers.get(id).panel.invalidate();
    };
    await quiet();

    // ── getRowControls() is a read ──────────────────────────────────────────
    const activity = [];
    const offActivity = lifecycle.subscribeActivity((change) =>
      activity.push(`${change.type}:${change.layerId ?? ''}`),
    );
    for (const id of ids) {
      const { module } = lifecycle.layers.get(id);
      if (typeof module.getRowControls !== 'function') continue;
      const statsBefore = JSON.stringify(module.getStats?.() ?? null);
      const paramsBefore = JSON.stringify(module.getParams?.() ?? null);
      const first = JSON.stringify(module.getRowControls());
      for (let i = 0; i < 3; i++)
        assert.equal(
          JSON.stringify(module.getRowControls()),
          first,
          `${id}: reading the row again reads the same row`,
        );
      assert.equal(
        JSON.stringify(module.getStats?.() ?? null),
        statsBefore,
        id,
      );
      assert.equal(
        JSON.stringify(module.getParams?.() ?? null),
        paramsBefore,
        id,
      );
    }
    offActivity();
    assert.deepEqual(activity, [], 'reading rows invalidates nothing');
    assert.equal(panel._hasPending(), false, 'reading rows asks for no paint');

    // ── invalidate() in a loop asks for one frame ───────────────────────────
    const raf = globalThis.requestAnimationFrame;
    let asked = 0;
    globalThis.requestAnimationFrame = (callback) => {
      asked += 1;
      return raf(callback);
    };
    try {
      invalidateAll(50);
    } finally {
      globalThis.requestAnimationFrame = raf;
    }
    assert.equal(asked, 1, 'every invalidation before the frame shares it');
    await frame();
    assert.deepEqual(
      take(),
      NONE,
      'invalidating unchanged layers paints nothing',
    );

    // ── Hidden: nothing paints, whatever changes ────────────────────────────
    show(0, 0);
    // A row that certainly changes while hidden.
    assert.equal(await lifecycle.setEnabled('shipwrecks', false), true);
    const base = Date.parse('2026-09-21T12:00:00.000Z');
    for (let step = 0; step < TIME_STEPS; step++) {
      worldClock.seek(base - step * 10 * 60_000);
      invalidateAll(3);
      await settle(1);
      assert.deepEqual(take(), NONE, `hidden step ${step} paints nothing`);
    }
    // The page hidden as well: what is shown when it returns still waits.
    const hidden = Object.getOwnPropertyDescriptor(document, 'hidden');
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => true,
    });
    try {
      worldClock.seek(base + 60 * 60_000);
      invalidateAll(3);
      await settle(1);
      presentation.flushVisible();
      assert.deepEqual(take(), NONE, 'a hidden page paints nothing');
    } finally {
      if (hidden) Object.defineProperty(document, 'hidden', hidden);
      else delete document.hidden;
    }
    presentation.flushVisible();
    assert.deepEqual(
      take(),
      NONE,
      'a shown page with hidden panels paints nothing',
    );

    // ── Shown: one catch-up paint ───────────────────────────────────────────
    show(300, 600);
    await frame();
    const caughtUp = take();
    assert.equal(
      caughtUp.renders['data-toggles'],
      1,
      'Data Layers repaints once, current, when shown',
    );
    assert.equal(
      el.rows
        .querySelector('[data-layer-id="shipwrecks"] .data-toggle-btn')
        .classList.contains('active'),
      false,
      'the catch-up shows what changed while hidden',
    );
    assert.ok(caughtUp.renders['utilities-toggles'] <= 1);
    assert.ok(
      caughtUp.painted.includes('weather'),
      'the Weather readout catches up with the time it missed',
    );
    await quiet();
    invalidateAll(3);
    await settle(2);
    assert.deepEqual(take(), NONE, 'nothing is owed after the catch-up');

    // ── Shown and stepping: at most one paint per frame ─────────────────────
    for (let step = 0; step < TIME_STEPS; step++) {
      worldClock.seek(base - step * 10 * 60_000);
      invalidateAll(5);
      await frame();
      const { renders: counts } = take();
      for (const [list, count] of Object.entries(counts))
        assert.ok(count <= 1, `step ${step}: ${list} rendered ${count} times`);
    }

    // ── Nothing changed: nothing paints ─────────────────────────────────────
    await quiet();
    invalidateAll(3);
    await settle(2);
    assert.deepEqual(
      take(),
      NONE,
      'unchanged rows and readouts are not painted again',
    );

    // ── Shown: what changes shows on the next frame ─────────────────────────
    // Through the manager, the presentation and the scheduler, as the
    // application changes a layer.
    const active = (id) =>
      el.rows
        .querySelector(`[data-layer-id="${id}"] .data-toggle-btn`)
        .classList.contains('active');
    assert.equal(active('earthquakes'), true);
    assert.equal(await lifecycle.setEnabled('earthquakes', false), true);
    await frame();
    assert.equal(active('earthquakes'), false, 'the row shows the layer off');
    assert.match(
      el.rows.querySelector('[data-layer-id="earthquakes"] .data-toggle-btn')
        .textContent,
      /OFF/,
    );
    const imageryPanel = document.getElementById('recent-imagery-panel');
    assert.equal(imageryPanel.hidden, false, 'the imagery readout is shown');
    assert.equal(await lifecycle.setEnabled('recent-imagery', false), true);
    await frame();
    assert.equal(
      imageryPanel.hidden,
      true,
      'the imagery readout hides with its layer',
    );
    assert.equal(active('recent-imagery'), false);
    assert.equal(await lifecycle.setEnabled('recent-imagery', true), true);
    await frame();
    assert.equal(imageryPanel.hidden, false, 'and returns with it');
  },
);
