// Behavioral tests for DISPLAY ▸ Import: the controller is driven against
// fake DOM and viewer doubles with an injected loader, and its observable
// effects are asserted — data sources added and removed, list rows, the hint,
// drop handling, the file limit, and what destroy() gives back. Real parsing
// and rendering run in `scripts/qa-geo-import.mjs`.
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

// The one focused element across every fake document (tests run one at a time).
const focus = { active: null };

class FakeElement {
  constructor(tagName = 'div', id = '') {
    this.tagName = tagName.toUpperCase();
    this.id = id;
    this.classList = new FakeClassList();
    this.dataset = {};
    this.style = {};
    this.attributes = new Map();
    this.children = [];
    this.parent = null;
    this.listeners = [];
    this.textContent = '';
    this.value = '';
    this.clicks = 0;
  }
  set className(v) {
    this.classList = new FakeClassList();
    String(v)
      .split(/\s+/)
      .filter(Boolean)
      .forEach((n) => this.classList.add(n));
  }
  setAttribute(n, v) {
    this.attributes.set(n, String(v));
  }
  getAttribute(n) {
    return this.attributes.get(n) ?? null;
  }
  append(...kids) {
    for (const k of kids) {
      k.parent = this;
      this.children.push(k);
    }
  }
  replaceChildren(...kids) {
    this.children = [];
    this.append(...kids);
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
  click() {
    this.clicks += 1;
    this.emit('click');
  }
  focus() {
    focus.active = this;
  }
  contains(el) {
    for (let at = el; at; at = at.parent) if (at === this) return true;
    return false;
  }
  *walk() {
    for (const kid of this.children) {
      yield kid;
      yield* kid.walk();
    }
  }
  querySelectorAll(selector) {
    if (selector !== '[data-import-id]') throw new Error(`fake: ${selector}`);
    return [...this.walk()].filter((el) => el.dataset.importId);
  }
  querySelector(selector) {
    const exact = /^button\[data-action="([a-z]+)"\]$/.exec(selector);
    for (const el of this.walk()) {
      if (el.tagName !== 'BUTTON') continue;
      if (selector === 'button' || (exact && el.dataset.action === exact[1]))
        return el;
    }
    return null;
  }
  closest(selector) {
    for (let el = this; el; el = el.parent) {
      if (
        selector === 'button[data-action]' &&
        el.tagName === 'BUTTON' &&
        el.dataset.action
      )
        return el;
      if (selector === '[data-import-id]' && el.dataset.importId) return el;
    }
    return null;
  }
}

function setup({ load, navigation, flyToSource } = {}) {
  focus.active = null;
  const els = {
    'geo-import-button': new FakeElement('button', 'geo-import-button'),
    'geo-import-input': new FakeElement('input', 'geo-import-input'),
    'geo-import-list': new FakeElement('ul', 'geo-import-list'),
    'geo-import-hint': new FakeElement('span', 'geo-import-hint'),
  };
  const document = {
    body: new FakeElement('body'),
    getElementById: (id) => els[id] ?? null,
    createElement: (tag) => new FakeElement(tag),
    get activeElement() {
      return focus.active;
    },
  };
  const added = [];
  const removed = [];
  const flights = [];
  let renders = 0;
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
    ...(flyToSource ? { flyToSource } : {}),
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
  };
}
const file = (name, extra = {}) => ({ name, size: 10, ...extra });
const rows = (els) => els['geo-import-list'].children;
const action = (row, name) =>
  row.children.find((c) => c.dataset.action === name);

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

test('the Import button opens the picker and a pick imports each file', async () => {
  const t = setup();
  t.els['geo-import-button'].click();
  assert.equal(t.els['geo-import-input'].clicks, 1);
  assert.equal(
    t.els['geo-import-input'].accept,
    '.geojson,.json,.kml,.kmz,.gpx',
  );
  const out = await t.tool.importFiles([file('a.geojson'), file('b.kml')]);
  assert.deepEqual(
    out.map((o) => o.ok),
    [true, true],
  );
  assert.equal(t.added.length, 2);
  assert.notEqual(
    t.loads[0].opts.color,
    t.loads[1].opts.color,
    'each file gets its own color',
  );
  assert.equal(rows(t.els).length, 2);
  assert.ok(t.els['geo-import-list'].classList.contains('visible'));
  assert.equal(t.flights.length, 1, 'the first file of a batch is flown to');
  assert.equal(t.els['geo-import-hint'].textContent, 'Added 2 files.');
  assert.deepEqual(
    t.tool.list().map((f) => f.name),
    ['a.geojson', 'b.kml'],
  );
});

test('file names are text, never markup', async () => {
  const t = setup();
  await t.tool.importFiles([file('<img src=x onerror=alert(1)>.kml')]);
  const name = rows(t.els)[0].children.find((c) =>
    c.classList.contains('geo-import-name'),
  );
  assert.equal(name.textContent, '<img src=x onerror=alert(1)>.kml');
  assert.equal(name.innerHTML, undefined);
});

test('row buttons hide, show, fly to and remove a file', async () => {
  const t = setup();
  await t.tool.importFiles([file('a.gpx')]);
  const [{ id }] = t.tool.list();
  const ds = t.added[0];
  // the click lands on the glyph inside the button, as in a browser
  const glyphClick = (name) =>
    t.els['geo-import-list'].emit('click', {
      target: action(rows(t.els)[0], name).children[0],
    });
  assert.equal(ds.show, true);
  glyphClick('toggle');
  assert.equal(ds.show, false);
  assert.equal(t.tool.list()[0].visible, false);
  assert.equal(
    action(rows(t.els)[0], 'toggle').getAttribute('aria-pressed'),
    'false',
  );
  glyphClick('fly');
  assert.equal(ds.show, true, 'flying to a hidden file shows it');
  assert.equal(t.flights.at(-1), ds);
  glyphClick('remove');
  assert.deepEqual(t.removed, [{ ds, destroy: true }]);
  assert.deepEqual(t.revoked, ['a.gpx']);
  assert.equal(t.tool.list().length, 0);
  assert.ok(!t.els['geo-import-list'].classList.contains('visible'));
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
  assert.match(out[1].error, /could not be read: boom/);
  assert.match(
    t.els['geo-import-hint'].textContent,
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
  c.emit('dragover', ev);
  c.emit('dragenter', { dataTransfer: files });
  assert.ok(t.document.body.classList.contains('gev-geo-import-drag'));
  c.emit('dragleave', { dataTransfer: files });
  assert.ok(!t.document.body.classList.contains('gev-geo-import-drag'));
  c.emit('dragenter', { dataTransfer: files });
  c.emit('drop', { dataTransfer: files });
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
    'Added 1 file. Network links and remote images in KML were left out.',
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
    for (const el of [
      t.viewer.container,
      t.els['geo-import-button'],
      t.els['geo-import-input'],
      t.els['geo-import-list'],
    ])
      assert.equal(el.listeners.length, 0);
    assert.equal(rows(t.els).length, 0);
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
  const drawAt = tools.indexOf(
    'const drawTool = initDrawTool({ viewer, annotations });',
  );
  const importAt = tools.indexOf('const geoFileImport = initGeoFileImport({');
  assert.ok(importAt > drawAt && drawAt >= 0);
  // Fly-to goes through the application shell's navigation policy.
  assert.match(
    tools.slice(importAt, importAt + 200),
    /navigation: styleManager/,
  );
  assert.ok(tools.indexOf('defer(() => geoFileImport?.destroy());') > importAt);
  const markup = fs.readFileSync(
    new URL('./templates/display-controls.html', import.meta.url),
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
      `${id} missing from the DISPLAY template`,
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

test('keyboard focus stays on the control after hide, show and remove', async () => {
  const t = setup();
  await t.tool.importFiles([file('a.geojson'), file('b.geojson')]);
  // Clicks reach the list's delegated listener, as they bubble in a page.
  const press = (btn) =>
    t.els['geo-import-list'].emit('click', { target: btn });
  const [first] = rows(t.els);
  action(first, 'toggle').focus();
  press(action(first, 'toggle'));
  // The list was rebuilt; focus is on the NEW toggle of the same row.
  const again = rows(t.els)[0];
  assert.notEqual(again, first);
  assert.equal(t.document.activeElement, action(again, 'toggle'));
  assert.equal(action(again, 'toggle').getAttribute('aria-pressed'), 'false');
  press(action(again, 'toggle'));
  assert.equal(t.document.activeElement, action(rows(t.els)[0], 'toggle'));
  // Remove the first row: focus moves to the same control on the next row.
  action(rows(t.els)[0], 'remove').focus();
  press(action(rows(t.els)[0], 'remove'));
  assert.equal(rows(t.els).length, 1);
  assert.equal(t.document.activeElement, action(rows(t.els)[0], 'remove'));
  // Remove the last row: focus goes back to the Import button.
  press(action(rows(t.els)[0], 'remove'));
  assert.equal(t.document.activeElement, t.els['geo-import-button']);
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
  const [kml, gpx] = rows(t.els);
  assert.ok(kml.children[0].classList.contains('own-styles'));
  assert.equal(kml.children[0].style.background, undefined);
  assert.match(kml.children[1].title, /drawn with its own styles/);
  assert.ok(!gpx.children[0].classList.contains('own-styles'));
  assert.ok(gpx.children[0].style.background);
});
