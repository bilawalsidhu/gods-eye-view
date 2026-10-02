// Behavioural tests for the import/export tool: the module is driven against
// DOM doubles and the REAL annotation engine (with a no-op renderer), and its
// observable effects are asserted — what is on the board, what the file list
// shows, what was saved. Nothing here reads the module's source text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAnnotationEngine } from './annotationEngine.js';
import { MAX_IMPORTED_FILES, initPathImportTool } from './pathImportTool.js';
import { _resetRenderGovernorForTest } from '../renderGovernor.js';

/* ── DOM doubles ───────────────────────────────────────────────────────── */

class FakeClassList {
  constructor() {
    this.names = new Set();
  }
  contains(name) {
    return this.names.has(name);
  }
  remove(name) {
    this.names.delete(name);
  }
  toggle(name, force) {
    const on = force === undefined ? !this.names.has(name) : Boolean(force);
    if (on) this.names.add(name);
    else this.names.delete(name);
    return on;
  }
}

class FakeElement {
  constructor(tagName = 'div', id = '') {
    this.tagName = tagName.toUpperCase();
    this.id = id;
    this.classList = new FakeClassList();
    this.dataset = {};
    this.attributes = new Map();
    this.textContent = '';
    this.value = '';
    this.children = [];
    this.parent = null;
    this.listeners = [];
    this.clicks = 0;
  }
  set className(value) {
    for (const name of String(value).split(/\s+/).filter(Boolean))
      this.classList.toggle(name, true);
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
  append(...nodes) {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
  }
  appendChild(node) {
    this.append(node);
    return node;
  }
  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }
  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  /** Only the two selectors the tool asks for. */
  closest(selector) {
    for (let node = this; node; node = node.parent) {
      if (selector === 'button[data-action]') {
        if (node.tagName === 'BUTTON' && node.dataset.action) return node;
      } else if (selector === '.draw-import-item') {
        if (node.classList.contains('draw-import-item')) return node;
      }
    }
    return null;
  }
  /** Deliver an event to this element and its ancestors, like a bubbling click. */
  emit(type, event = {}) {
    const payload = { type, target: this, ...event };
    for (let node = this; node; node = node.parent)
      for (const entry of [...node.listeners])
        if (entry.type === type) entry.listener(payload);
    return payload;
  }
  click() {
    this.clicks += 1;
    this.emit('click');
  }
}

const IDS = [
  ['draw-import', 'button'],
  ['draw-export', 'button'],
  ['draw-import-input', 'input'],
  ['draw-color-select', 'select'],
  ['draw-clear', 'button'],
  ['draw-import-row', 'div'],
  ['draw-import-status', 'span'],
  ['draw-import-list', 'ul'],
];

function installDom(t, { omit = [] } = {}) {
  const elements = new Map();
  for (const [id, tag] of IDS)
    if (!omit.includes(id)) elements.set(id, new FakeElement(tag, id));
  elements.get('draw-color-select').value = 'amber';
  const saved = {
    document: globalThis.document,
    window: globalThis.window,
    raf: globalThis.requestAnimationFrame,
    caf: globalThis.cancelAnimationFrame,
  };
  globalThis.document = {
    body: new FakeElement('body'),
    getElementById: (id) => elements.get(id) ?? null,
    createElement: (tag) => new FakeElement(tag),
  };
  globalThis.window = {};
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  _resetRenderGovernorForTest();
  // Hooks run in registration order, and the tool must be destroyed while the
  // doubles are still installed — so teardown is queued here and run first.
  const teardown = [];
  t.after(() => {
    for (const step of teardown.reverse()) step();
    _resetRenderGovernorForTest();
    for (const [key, name] of [
      ['document', 'document'],
      ['window', 'window'],
      ['raf', 'requestAnimationFrame'],
      ['caf', 'cancelAnimationFrame'],
    ]) {
      if (saved[key] === undefined) delete globalThis[name];
      else globalThis[name] = saved[key];
    }
  });
  const el = (id) => elements.get(id);
  el.onTeardown = (step) => teardown.push(step);
  return el;
}

function setup(t, options) {
  const el = installDom(t, options);
  const engine = createAnnotationEngine({
    viewer: {},
    renderer: {
      add() {},
      update() {},
      remove() {},
      sync() {},
      destroy() {},
    },
  });
  const saves = [];
  const tool = initPathImportTool({
    annotations: engine,
    saveFile: (name, text) => saves.push({ name, text }),
  });
  el.onTeardown(() => {
    tool?.destroy();
    engine.destroy();
  });
  return { el, engine, tool, saves };
}

/* ── fixtures ──────────────────────────────────────────────────────────── */

const gpxTrack = (name, lon) =>
  `<gpx><trk><name>${name}</name><trkseg>
    <trkpt lat="46.5" lon="${lon}"/><trkpt lat="46.6" lon="${lon + 0.1}"/>
  </trkseg></trk></gpx>`;
const RIDGE = gpxTrack('Ridge', 8);
const VALLEY = gpxTrack('Valley', 9);
const fileOf = (name, text) => ({
  name,
  size: text.length,
  text: async () => text,
});
const labels = (engine) =>
  engine.list().map((anno) => String(anno.label).split(' — ')[0]);
const rows = (el) =>
  el('draw-import-list').children.map((item) => ({
    name: item.children[0].textContent,
    toggle: item.children[1].textContent,
    hidden: item.classList.contains('is-hidden'),
  }));

/* ── tests ─────────────────────────────────────────────────────────────── */

test('the tool is absent when its controls or the engine are', (t) => {
  installDom(t, { omit: ['draw-import'] });
  assert.equal(initPathImportTool({ annotations: {} }), null);
  assert.equal(initPathImportTool({ annotations: null }), null);
});

test('Import opens the file picker; choosing a file puts it on the board', async (t) => {
  const { el, engine, tool } = setup(t);
  el('draw-import').click();
  assert.equal(el('draw-import-input').clicks, 1);

  const input = el('draw-import-input');
  input.files = [fileOf('ridge.gpx', RIDGE)];
  input.value = 'C:\\fakepath\\ridge.gpx';
  input.emit('change');
  assert.equal(input.value, '', 'reset so the same file can be chosen again');
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(labels(engine), ['Ridge']);
  assert.equal(engine.list()[0].color, 'amber', 'takes the Draw colour');
  assert.deepEqual(rows(el), [
    { name: 'ridge.gpx', toggle: 'Hide', hidden: false },
  ]);
  assert.equal(el('draw-import-status').textContent, '1 line from ridge.gpx');
  assert.ok(el('draw-import-row').classList.contains('visible'));
  assert.deepEqual(tool.files, [
    {
      id: 1,
      fileName: 'ridge.gpx',
      summary: '1 line from ridge.gpx',
      hidden: false,
      marks: 1,
    },
  ]);
});

test('hide takes only that file off the board and show puts it back', async (t) => {
  const { el, engine, tool } = setup(t);
  await engine.annotate([
    { type: 'pin', manual: true, latitude: 1, longitude: 1, label: 'Drawn' },
  ]);
  await tool.importText('ridge.gpx', RIDGE);
  await tool.importText('valley.gpx', VALLEY);
  assert.deepEqual(labels(engine), ['Drawn', 'Ridge', 'Valley']);

  // Through the list, the way a person does it.
  el('draw-import-list').children[0].children[1].click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(labels(engine), ['Drawn', 'Valley']);
  assert.deepEqual(rows(el)[0], {
    name: 'ridge.gpx',
    toggle: 'Show',
    hidden: true,
  });
  assert.equal(
    el('draw-import-list').children[0].children[1].getAttribute('aria-pressed'),
    'true',
  );

  el('draw-import-list').children[0].children[1].click();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(labels(engine).sort(), ['Drawn', 'Ridge', 'Valley']);
  assert.equal(rows(el)[0].toggle, 'Hide');
});

test('remove takes the file and its marks, and nothing else', async (t) => {
  const { el, engine, tool } = setup(t);
  await engine.annotate([
    { type: 'pin', manual: true, latitude: 1, longitude: 1, label: 'Drawn' },
  ]);
  await tool.importText('ridge.gpx', RIDGE);
  await tool.importText('valley.gpx', VALLEY);

  el('draw-import-list').children[0].children[2].click();
  assert.deepEqual(labels(engine), ['Drawn', 'Valley']);
  assert.deepEqual(
    rows(el).map((row) => row.name),
    ['valley.gpx'],
  );

  assert.equal(tool.removeFile(2), true);
  assert.deepEqual(labels(engine), ['Drawn']);
  assert.equal(tool.removeFile(2), false);
  // The status still says what happened, so the row stays to show it.
  assert.equal(el('draw-import-status').textContent, 'valley.gpx removed.');
});

test('a feature already on the board is not claimed by the file', async (t) => {
  const { engine, tool } = setup(t);
  await tool.importText('ridge.gpx', RIDGE);
  const messages = await tool.importText('ridge-copy.gpx', RIDGE);
  assert.deepEqual(messages, ['ridge-copy.gpx is already on the board.']);
  assert.equal(tool.files.length, 1);
  assert.equal(engine.count(), 1);
});

test('a file that cannot be read says why and leaves the board alone', async (t) => {
  const { el, engine, tool } = setup(t);
  const messages = await tool.importFiles([
    fileOf('trip.kmz', 'PK'),
    fileOf('notes.txt', 'hello'),
    fileOf('broken.gpx', '<gpx><trk>'),
    {
      name: 'unreadable.gpx',
      size: 10,
      text: async () => {
        throw new Error('disk error');
      },
    },
    { name: 'huge.gpx', size: Number.MAX_SAFE_INTEGER, text: async () => '' },
    fileOf('ridge.gpx', RIDGE),
  ]);
  assert.match(messages[0], /^trip\.kmz: KMZ is a zipped KML/);
  assert.match(
    messages[1],
    /^notes\.txt: That file is not GPX, KML or GeoJSON/,
  );
  assert.match(messages[2], /^broken\.gpx: The file is not valid XML/);
  assert.equal(messages[3], 'Could not read unreadable.gpx.');
  assert.equal(messages[4], 'huge.gpx: huge.gpx is too large to import.');
  assert.equal(messages[5], '1 line from ridge.gpx');
  assert.equal(engine.count(), 1, 'the good file still imported');
  assert.equal(el('draw-import-status').textContent, messages.join(' '));
});

test('the number of remembered files is bounded', async (t) => {
  const { tool } = setup(t);
  for (let i = 0; i < MAX_IMPORTED_FILES; i += 1)
    await tool.importText(`t${i}.gpx`, gpxTrack(`T${i}`, i));
  assert.equal(tool.files.length, MAX_IMPORTED_FILES);
  const [message] = await tool.importText('extra.gpx', gpxTrack('Extra', 50));
  assert.match(message, /files are already imported\. Remove one first\./);
  assert.equal(tool.files.length, MAX_IMPORTED_FILES);
});

test("Draw's Clear empties the file list, hidden files included", async (t) => {
  const { el, engine, tool } = setup(t);
  await tool.importText('ridge.gpx', RIDGE);
  await tool.importText('valley.gpx', VALLEY);
  await tool.setHidden(1, true);

  // What the draw tool's own Clear listener does, then the shared click.
  el('draw-clear').addEventListener('click', () => engine.clear());
  el('draw-clear').click();

  assert.equal(engine.count(), 0);
  assert.deepEqual(tool.files, []);
  assert.deepEqual(rows(el), []);
  assert.ok(!el('draw-import-row').classList.contains('visible'));
});

test('marks cleared from elsewhere are reconciled before the list is used', async (t) => {
  const { el, engine, tool } = setup(t);
  await tool.importText('ridge.gpx', RIDGE);
  await tool.importText('valley.gpx', VALLEY);
  await tool.setHidden(2, true);

  engine.clear(); // e.g. the voice agent's clear_annotations
  el('draw-import-list').emit('pointerenter');

  assert.deepEqual(
    tool.files.map((file) => [file.fileName, file.hidden]),
    [['valley.gpx', true]],
    'a shown file whose marks are gone is dropped; a hidden one is kept',
  );
  await tool.setHidden(2, false);
  assert.deepEqual(labels(engine), ['Valley']);
});

test('Export saves the board as GeoJSON that imports back', async (t) => {
  const { el, engine, tool, saves } = setup(t);
  el('draw-export').click();
  assert.equal(saves.length, 0);
  assert.equal(
    el('draw-import-status').textContent,
    'Nothing on the board to export.',
  );

  await tool.importText('ridge.gpx', RIDGE);
  el('draw-export').click();
  assert.equal(saves.length, 1);
  assert.match(saves[0].name, /^gods-eye-board-.*\.geojson$/);
  const geojson = JSON.parse(saves[0].text);
  assert.equal(geojson.features[0].properties.name, 'Ridge');
  assert.match(
    el('draw-import-status').textContent,
    /^Exported 1 mark to gods-eye-board-/,
  );

  engine.clear();
  tool.reconcile();
  await tool.importText('board.geojson', saves[0].text);
  assert.deepEqual(labels(engine), ['Ridge']);
});

test('a failed save is reported, not thrown', async (t) => {
  const el = installDom(t);
  const engine = createAnnotationEngine({
    viewer: {},
    renderer: { add() {}, update() {}, remove() {}, sync() {}, destroy() {} },
  });
  const tool = initPathImportTool({
    annotations: engine,
    saveFile: () => {
      throw new Error('blocked');
    },
  });
  el.onTeardown(() => {
    tool.destroy();
    engine.destroy();
  });
  await tool.importText('ridge.gpx', RIDGE);
  assert.equal(tool.exportBoard(), null);
  assert.equal(
    el('draw-import-status').textContent,
    'Could not save the export.',
  );
});

test('destroy gives back every listener and leaves the marks to the engine', async (t) => {
  const { el, engine, tool } = setup(t);
  await tool.importText('ridge.gpx', RIDGE);
  assert.equal(globalThis.window.__gevPathImport, tool);
  assert.ok(tool.diagnostics().domListeners > 0);

  tool.destroy();
  tool.destroy();

  assert.deepEqual(tool.diagnostics(), {
    destroyed: true,
    files: 0,
    domListeners: 0,
  });
  for (const [id] of IDS)
    assert.equal(el(id).listeners.length, 0, `${id} still has listeners`);
  assert.equal(globalThis.window.__gevPathImport, undefined);
  assert.deepEqual(rows(el), []);
  assert.ok(!el('draw-import-row').classList.contains('visible'));
  assert.equal(engine.count(), 1, 'the board is the engine’s to dispose');
  assert.deepEqual(await tool.importText('valley.gpx', VALLEY), []);
  assert.equal(tool.exportBoard(), null);
});

test('an import still in flight at teardown does not write into the list', async (t) => {
  const { el, tool } = setup(t);
  let release;
  const pending = tool.importFiles([
    {
      name: 'slow.gpx',
      size: RIDGE.length,
      text: () =>
        new Promise((resolve) => {
          release = () => resolve(RIDGE);
        }),
    },
  ]);
  tool.destroy();
  release();
  assert.deepEqual(await pending, []);
  assert.deepEqual(rows(el), []);
  assert.equal(el('draw-import-status').textContent, '');
});
