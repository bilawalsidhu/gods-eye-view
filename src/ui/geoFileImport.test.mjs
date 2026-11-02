// Behavioral tests for DISPLAY ▸ Import: the controller is driven against
// fake DOM and viewer doubles with an injected loader, and its observable
// effects are asserted — data sources added and removed, the rows and hint it
// publishes, drop handling, the file limit, and what destroy() gives back.
// The Display panel renders the published list (`displayPanel.test.mjs`);
// real parsing and rendering run in `scripts/qa-geo-import.mjs`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { initGeoFileImport, summarize } from './geoFileImport.js';
import { GeoImportError, MAX_IMPORTED_FILES } from '../data/geoFileImport.js';

class FakeClassList {
  constructor() {
    this.names = new Set();
  }
  add(...n) {
    n.forEach((x) => this.names.add(x));
  }
  remove(...n) {
    n.forEach((x) => this.names.delete(x));
  }
  contains(n) {
    return this.names.has(n);
  }
  toggle(n, force) {
    const on = force === undefined ? !this.names.has(n) : Boolean(force);
    if (on) this.names.add(n);
    else this.names.delete(n);
    return on;
  }
}

class FakeElement {
  constructor(tagName = 'div', id = '') {
    this.tagName = tagName.toUpperCase();
    this.id = id;
    this.classList = new FakeClassList();
    this.listeners = [];
  }
  addEventListener(type, listener, options) {
    this.listeners.push({ type, listener, options });
  }
  removeEventListener(type, listener) {
    const at = this.listeners.findIndex(
      (l) => l.type === type && l.listener === listener,
    );
    if (at >= 0) this.listeners.splice(at, 1);
  }
  emit(type, event = {}) {
    for (const { listener } of this.listeners.filter((l) => l.type === type))
      listener({
        target: this,
        preventDefault() {
          this.prevented = true;
        },
        ...event,
      });
  }
}

function setup({ load, navigation, flyToSource, subscribeMapSource } = {}) {
  const els = {
    'geo-import-button': new FakeElement('button', 'geo-import-button'),
  };
  const document = {
    body: new FakeElement('body'),
    getElementById: (id) => els[id] ?? null,
  };
  Object.setPrototypeOf(document, new FakeElement('document'));
  const added = [];
  const removed = [];
  const flights = [];
  let renders = 0;
  let shown = null;
  // The view's pick and row buttons, as the display store holds them.
  let actions = null;
  const viewer = {
    container: new FakeElement('div', 'cesiumContainer'),
    scene: { requestRender: () => (renders += 1) },
    dataSources: {
      add: async (ds) => {
        added.push(ds);
        return ds;
      },
      remove: (ds, destroy) => {
        removed.push({ ds, destroy });
        return true;
      },
    },
    flyTo: (target) => flights.push(target),
  };
  const revoked = [];
  const loads = [];
  const defaultLoad = async (file, opts) => {
    loads.push({ file, opts });
    if (file.fail) throw new GeoImportError(file.fail);
    if (file.crash) throw new Error('boom');
    return {
      dataSource: { show: true },
      name: file.name,
      format: 'geojson',
      entityCount: 3,
      removed: file.removed || 0,
      revoke: () => revoked.push(file.name),
    };
  };
  const tool = initGeoFileImport({
    viewer,
    load: load || defaultLoad,
    document,
    ...(navigation ? { navigation } : {}),
    ...(subscribeMapSource ? { subscribeMapSource } : {}),
    flyToSource: flyToSource || ((_viewer, ds) => flights.push(ds)),
    publish: (view) => {
      shown = view;
    },
    connect: (next) => {
      actions = next;
      return () => (actions = null);
    },
  });
  return {
    tool,
    els,
    document,
    viewer,
    added,
    removed,
    flights,
    revoked,
    loads,
    renders: () => renders,
    shown: () => shown,
    actions: () => actions,
    /** A control's change, as the view sends it. */
    act: (name, ...args) => actions?.[name]?.(...args),
  };
}
const file = (name, extra = {}) => ({ name, size: 10, ...extra });
const rows = (t) => t.shown().rows;
const action = (row, name) => row.actions.find((a) => a.action === name);
// A row button's click, as the view sends it.
const ROW_ACTIONS = {
  toggle: 'toggleGeoImport',
  fly: 'flyToGeoImport',
  remove: 'removeGeoImport',
};
const press = (t, row, name) => t.act(ROW_ACTIONS[name], row.id);

test('returns null without its markup or viewer', () => {
  const document = { getElementById: () => null };
  assert.equal(initGeoFileImport({ viewer: {}, document }), null);
  assert.equal(
    initGeoFileImport({
      viewer: null,
      document: { getElementById: () => new FakeElement() },
    }),
    null,
  );
});

test('a pick imports each file', async () => {
  const t = setup();
  t.act('importGeoFiles', [file('a.geojson'), file('b.kml')]);
  for (let turn = 0; turn < 20 && t.added.length < 2; turn += 1)
    await new Promise((r) => setImmediate(r));
  assert.equal(t.added.length, 2);
  assert.notEqual(
    t.loads[0].opts.color,
    t.loads[1].opts.color,
    'each file gets its own color',
  );
  assert.equal(rows(t).length, 2);
  assert.equal(t.flights.length, 1, 'the first file of a batch is flown to');
  assert.equal(t.shown().hint, 'Added 2 files.');
  assert.deepEqual(
    t.tool.list().map((f) => f.name),
    ['a.geojson', 'b.kml'],
  );
});

test('file names are published as given, for the view to show as text', async () => {
  const t = setup();
  await t.tool.importFiles([file('<img src=x onerror=alert(1)>.kml')]);
  assert.equal(rows(t)[0].name, '<img src=x onerror=alert(1)>.kml');
});

test('row buttons hide, show, fly to and remove a file', async () => {
  const t = setup();
  await t.tool.importFiles([file('a.gpx')]);
  const [{ id }] = t.tool.list();
  const ds = t.added[0];
  const glyphClick = (name) => press(t, rows(t)[0], name);
  assert.equal(ds.show, true);
  glyphClick('toggle');
  assert.equal(ds.show, false);
  assert.equal(t.tool.list()[0].visible, false);
  assert.equal(action(rows(t)[0], 'toggle').pressed, 'false');
  assert.equal(action(rows(t)[0], 'toggle').icon, 'visibility_off');
  assert.equal(action(rows(t)[0], 'toggle').label, 'Show a.gpx');
  glyphClick('fly');
  assert.equal(ds.show, true, 'flying to a hidden file shows it');
  assert.equal(t.flights.at(-1), ds);
  glyphClick('remove');
  assert.deepEqual(t.removed, [{ ds, destroy: true }]);
  assert.deepEqual(t.revoked, ['a.gpx']);
  assert.equal(t.tool.list().length, 0);
  assert.deepEqual(rows(t), []);
  assert.equal(t.tool.remove(id), false);
});

test('a refused file says why and does not stop the rest of the batch', async () => {
  const t = setup();
  const out = await t.tool.importFiles([
    file('bad.kml', { fail: 'That KML file is not valid XML.' }),
    file('odd.gpx', { crash: true }),
    file('good.geojson'),
  ]);
  assert.deepEqual(
    out.map((o) => o.ok),
    [false, false, true],
  );
  assert.equal(out[0].error, 'That KML file is not valid XML.');
  assert.match(out[1].error, /could not be read\./);
  assert.match(
    t.shown().hint,
    /^Added 1 file\. 2 files could not be added \(bad\.kml: That KML file is not valid XML\.\)/,
  );
  assert.equal(t.tool.list().length, 1);
});

test('the number of files on the globe is bounded', async () => {
  const t = setup();
  const many = Array.from({ length: MAX_IMPORTED_FILES + 2 }, (_, i) =>
    file(`f${i}.geojson`),
  );
  const out = await t.tool.importFiles(many);
  assert.equal(out.filter((o) => o.ok).length, MAX_IMPORTED_FILES);
  assert.match(out.at(-1).error, /At most 12 files/);
  assert.equal(
    t.loads.length,
    MAX_IMPORTED_FILES,
    'files over the limit are not even read',
  );
});

test('dropping files on the globe imports them; other drags are left alone', async () => {
  const t = setup();
  const c = t.viewer.container;
  const files = { types: ['Files'], files: [file('drop.kmz')] };
  let ev = { dataTransfer: { types: ['text/plain'] } };
  t.document.emit('dragover', ev);
  c.emit('dragenter', { dataTransfer: files });
  assert.ok(t.document.body.classList.contains('gev-geo-import-drag'));
  c.emit('dragleave', { dataTransfer: files });
  assert.ok(!t.document.body.classList.contains('gev-geo-import-drag'));
  c.emit('dragenter', { dataTransfer: files });
  t.document.emit('drop', { dataTransfer: files });
  assert.ok(!t.document.body.classList.contains('gev-geo-import-drag'));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(
    t.tool.list().map((f) => f.name),
    ['drop.kmz'],
  );
});

test('stripped KML content is mentioned once, for the batch that had it', () => {
  assert.equal(
    summarize([{ name: 'a.kml', ok: true, removed: 3 }]),
    'Added 1 file. Some KML content was left out.',
  );
  assert.equal(
    summarize([{ name: 'b.geojson', ok: true, removed: 0 }]),
    'Added 1 file.',
  );
});

test('destroy removes every file and listener and the window handle', async () => {
  globalThis.window = {};
  try {
    const t = setup();
    assert.equal(globalThis.window.__gevGeoImport, t.tool);
    await t.tool.importFiles([file('a.geojson'), file('b.geojson')]);
    t.tool.destroy();
    assert.equal(t.removed.length, 2);
    assert.deepEqual(t.revoked.sort(), ['a.geojson', 'b.geojson']);
    assert.equal(t.viewer.container.listeners.length, 0);
    assert.equal(t.document.listeners.length, 0);
    assert.equal(t.actions(), null, 'the view is disconnected');
    assert.deepEqual(t.shown(), { rows: [], hint: '' });
    assert.equal(globalThis.window.__gevGeoImport, undefined);
    assert.equal(t.tool.diagnostics().destroyed, true);
  } finally {
    delete globalThis.window;
  }
});

test('a file that finishes loading after destroy is released, not added', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const revoked = [];
  const t = setup({
    load: async () => {
      await gate;
      return {
        dataSource: {},
        name: 'late',
        format: 'kml',
        entityCount: 1,
        removed: 0,
        revoke: () => revoked.push('late'),
      };
    },
  });
  const pending = t.tool.importFiles([file('late.kml')]);
  // Imports are queued: let the batch start loading before destroy lands.
  await new Promise((r) => setImmediate(r));
  t.tool.destroy();
  release();
  await pending;
  assert.equal(t.added.length, 0);
  assert.deepEqual(revoked, ['late']);
});

test('the application composition wires the import and owns its teardown', () => {
  const tools = fs.readFileSync(
    new URL('../app/tools.js', import.meta.url),
    'utf8',
  );
  const drawAt = tools.indexOf('const drawTool = initDrawTool({');
  const importAt = tools.indexOf('const geoFileImport = initGeoFileImport({');
  assert.ok(importAt > drawAt && drawAt >= 0);
  // Fly-to goes through the application shell's navigation policy.
  assert.match(
    tools.slice(importAt, importAt + 200),
    /navigation: styleManager/,
  );
  assert.ok(tools.indexOf('defer(() => geoFileImport?.destroy());') > importAt);
  // The list renders from the store and its controls answer through it.
  assert.match(
    tools.slice(importAt, importAt + 400),
    /publish: \(view\) => displayStore\.publishGeoImport\(view\),\s*connect: connectDisplay,/,
  );
  const markup = fs.readFileSync(
    new URL('./views/panels/GeoImport.vue', import.meta.url),
    'utf8',
  );
  for (const id of [
    'geo-import-button',
    'geo-import-input',
    'geo-import-list',
    'geo-import-hint',
  ])
    assert.ok(
      markup.includes(`id="${id}"`),
      `${id} missing from the Import template`,
    );
});

test('two imports at once never pass the file cap: batches run one after another', async () => {
  const t = setup();
  const first = t.tool.importFiles(
    Array.from({ length: 8 }, (_, i) => file(`a${i}.geojson`)),
  );
  const second = t.tool.importFiles(
    Array.from({ length: 8 }, (_, i) => file(`b${i}.geojson`)),
  );
  const [a, b] = await Promise.all([first, second]);
  assert.equal(t.tool.list().length, MAX_IMPORTED_FILES);
  assert.equal(a.filter((o) => o.ok).length, 8);
  assert.equal(b.filter((o) => o.ok).length, MAX_IMPORTED_FILES - 8);
  assert.equal(b.filter((o) => !o.ok).length, 16 - MAX_IMPORTED_FILES);
  // The second batch's loads started only after the first batch finished.
  assert.deepEqual(
    t.loads.map((l) => l.file.name.slice(0, 1)).join(''),
    'a'.repeat(8) + 'b'.repeat(MAX_IMPORTED_FILES - 8),
  );
});

function navigationDouble({ immediate = true, reassert = true } = {}) {
  const calls = [];
  let generation = 0;
  return {
    calls,
    runImmediateNavigation(noun, navigate) {
      calls.push(['immediate', noun]);
      return immediate ? navigate(++generation) : false;
    },
    beginDeferredLocationNavigation() {
      calls.push(['begin']);
      return ++generation;
    },
    reassertDeferredLocationNavigation(g) {
      calls.push(['reassert', g]);
      return reassert;
    },
  };
}

test('a direct camera gesture cancels the fly-to of a file still being read', async () => {
  for (const gesture of ['pointerdown', 'wheel']) {
    let release;
    const t = setup({
      load: async () => {
        await new Promise((r) => (release = r));
        return {
          name: 'slow.geojson',
          format: 'geojson',
          entityCount: 1,
          dataSource: {},
        };
      },
    });
    const result = t.tool.importFiles([file('slow.geojson')]);
    await new Promise((r) => setImmediate(r));
    t.viewer.container.emit(gesture);
    release();
    await result;
    assert.equal(t.added.length, 1);
    assert.equal(t.flights.length, 0);
    t.tool.destroy();
    assert.equal(t.document.listeners.length, 0);
  }
});

test('dropping on panel controls is accepted and file drags prevent browser navigation', async () => {
  const t = setup();
  let prevented = 0;
  const event = {
    target: t.els['geo-import-button'],
    dataTransfer: { types: ['Files'], files: [file('panel.kml')] },
    preventDefault: () => prevented++,
  };
  t.document.emit('dragover', event);
  t.document.emit('drop', event);
  await new Promise((r) => setImmediate(r));
  assert.equal(prevented, 2);
  assert.equal(t.tool.list()[0].name, 'panel.kml');
  t.tool.destroy();
  assert.equal(t.document.listeners.length, 0);
});

test('ground refresh coalesces map changes and releases its subscription on teardown', async () => {
  let changed,
    unsubscribed = 0,
    refreshed = 0;
  const t = setup({
    subscribeMapSource: (listener) => {
      changed = listener;
      return () => unsubscribed++;
    },
    load: async () => ({
      name: 'point.geojson',
      format: 'geojson',
      entityCount: 1,
      dataSource: {},
      refreshGround: async () => refreshed++,
    }),
  });
  await t.tool.importFiles([file('point.geojson')]);
  changed();
  changed();
  changed();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(refreshed, 1);
  t.tool.destroy();
  changed();
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(refreshed, 1);
  assert.equal(unsubscribed, 1);
});

test('Fly to is an immediate navigation that Cockpit can refuse', async () => {
  const flown = [];
  const nav = navigationDouble({ immediate: false });
  const t = setup({ navigation: nav, flyToSource: (v, ds) => flown.push(ds) });
  // Batch auto-fly is deferred: stamped at the start, re-asserted before flying.
  await t.tool.importFiles([file('a.geojson')]);
  assert.deepEqual(nav.calls, [['begin'], ['reassert', 1]]);
  assert.equal(flown.length, 1);
  // The button goes through the immediate route; refused, nothing flies.
  const id = t.tool.list()[0].id;
  assert.equal(t.tool.flyTo(id), false);
  assert.deepEqual(nav.calls.at(-1), ['immediate', 'file']);
  assert.equal(flown.length, 1);
  const nav2 = navigationDouble();
  const t2 = setup({
    navigation: nav2,
    flyToSource: (v, ds) => flown.push(ds),
  });
  await t2.tool.importFiles([file('b.geojson')]);
  assert.equal(t2.tool.flyTo(t2.tool.list()[0].id), true);
  assert.equal(flown.length, 3);
});

test('a slow import does not fly once something newer took the camera', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const flown = [];
  const nav = navigationDouble({ reassert: false });
  const t = setup({
    navigation: nav,
    flyToSource: (v, ds) => flown.push(ds),
    load: async (f) => {
      await gate;
      return {
        dataSource: {},
        name: f.name,
        format: 'geojson',
        entityCount: 1,
        removed: 0,
        revoke() {},
      };
    },
  });
  const pending = t.tool.importFiles([file('slow.geojson')]);
  release();
  const [out] = await pending;
  assert.equal(out.ok, true);
  assert.deepEqual(nav.calls, [['begin'], ['reassert', 1]]);
  assert.equal(flown.length, 0);
});

test('a queued import cannot fly over navigation that happened while it waited', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let generation = 0;
  const flown = [];
  const nav = {
    beginDeferredLocationNavigation: () => ++generation,
    reassertDeferredLocationNavigation: (stamp) => stamp === generation,
  };
  const t = setup({
    navigation: nav,
    flyToSource: (v, ds) => flown.push(ds),
    load: async (f) => {
      if (f.name === 'first.geojson') await gate;
      return {
        dataSource: {},
        name: f.name,
        format: 'geojson',
        entityCount: 1,
        revoke() {},
      };
    },
  });
  const first = t.tool.importFiles([file('first.geojson')]);
  await new Promise((resolve) => setImmediate(resolve));
  const queued = t.tool.importFiles([file('queued.geojson')]);
  generation++; // A newer user camera action while the second batch is waiting.
  release();
  const results = await Promise.all([first, queued]);
  assert.ok(results.every(([outcome]) => outcome.ok));
  assert.equal(t.tool.list().length, 2);
  assert.equal(flown.length, 0);
});

test('a refused deferred stamp (Cockpit) imports without flying', async () => {
  const flown = [];
  const nav = navigationDouble();
  nav.beginDeferredLocationNavigation = () => false;
  nav.reassertDeferredLocationNavigation = () => {
    throw new Error('must not re-assert a refused stamp');
  };
  const t = setup({ navigation: nav, flyToSource: (v, ds) => flown.push(ds) });
  const [out] = await t.tool.importFiles([file('a.geojson')]);
  assert.equal(out.ok, true);
  assert.equal(flown.length, 0);
});

test('KML and KMZ rows say they keep their own styles instead of showing a color', async () => {
  const t = setup({
    load: async (f) => ({
      dataSource: {},
      name: f.name,
      format: f.name.endsWith('.kml') ? 'kml' : 'gpx',
      entityCount: 2,
      removed: 0,
      revoke() {},
    }),
  });
  await t.tool.importFiles([file('a.kml'), file('b.gpx')]);
  const [kml, gpx] = rows(t);
  assert.equal(kml.ownStyles, true);
  assert.match(kml.title, /drawn with its own styles/);
  assert.equal(gpx.ownStyles, false);
  assert.ok(gpx.color);
});

test('the map-object count in a row title keeps digit grouping', async () => {
  const t = setup({
    load: async (f) => ({
      dataSource: {},
      name: f.name,
      format: 'geojson',
      entityCount: 12345,
      removed: 0,
      revoke() {},
    }),
  });
  await t.tool.importFiles([file('big.geojson')]);
  const [row] = rows(t);
  assert.match(row.title, /12,345 map objects/);
  t.tool.destroy();
});

test('a refusal shows its counts in the language’s numerals, not the browser’s', async () => {
  const t = setup({
    load: async () => {
      throw new GeoImportError(
        'That file has 60,000 map objects; the limit is 50,000.',
        'That file has {count} map objects; the limit is {limit}.',
        { count: 60000, limit: 50000 },
      );
    },
  });
  const [out] = await t.tool.importFiles([file('huge.kml')]);
  assert.equal(
    out.error,
    'That file has 60,000 map objects; the limit is 50,000.',
  );
  t.tool.destroy();
});
