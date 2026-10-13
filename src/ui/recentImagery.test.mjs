import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRecentImageryPanel } from './recentImagery.js';
import { createRecentImageryLayer } from '../layers/recentImagery/index.js';
import {
  BOX,
  fakeCatalog,
  fakeController,
  fakeRenderer,
  fakeThumbnails,
  manualTimers,
  response,
  settle,
} from '../layers/recentImagery/testDoubles.mjs';

const S18 = 'S30:2026-09-18';
const L16 = 'L30:2026-09-16';
const V21 = 'VIIRS:2026-09-21';

// ---- a small DOM double ------------------------------------------------------
class FakeClassList {
  constructor(node) {
    this.node = node;
  }
  get names() {
    return new Set(
      String(this.node.className || '')
        .split(/\s+/)
        .filter(Boolean),
    );
  }
  contains(name) {
    return this.names.has(name);
  }
  toggle(name, force) {
    const names = this.names;
    const on = force === undefined ? !names.has(name) : Boolean(force);
    if (on) names.add(name);
    else names.delete(name);
    this.node.className = [...names].join(' ');
    return on;
  }
  add(...list) {
    for (const name of list) this.toggle(name, true);
  }
  remove(...list) {
    for (const name of list) this.toggle(name, false);
  }
}

function matches(node, selector) {
  if (selector.startsWith('.'))
    return node.classList.contains(selector.slice(1));
  if (selector.startsWith('#')) return node.id === selector.slice(1);
  const attr = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(selector);
  if (!attr) return false;
  const key = attr[1].startsWith('data-')
    ? attr[1].slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
    : null;
  const value = key ? node.dataset[key] : node.getAttribute(attr[1]);
  return attr[2] === undefined ? value != null : value === attr[2];
}

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = String(tagName).toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.parentNode = null;
    this.className = '';
    this.dataset = {};
    this.style = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.hidden = false;
    this.disabled = false;
    this.id = '';
    this.title = '';
    this._text = '';
    this.scrollTop = 0;
    this.scrollLeft = 0;
    this.focused = 0;
    this.blurred = 0;
  }
  get classList() {
    return new FakeClassList(this);
  }
  get textContent() {
    return this.children.length
      ? this.children.map((child) => child.textContent).join('')
      : this._text;
  }
  set textContent(value) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this._text = String(value);
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
  removeAttribute(name) {
    this.attributes.delete(name);
  }
  appendChild(child) {
    return this.insertBefore(child, null);
  }
  insertBefore(child, reference) {
    child.parentNode?.removeChild(child);
    const index = reference ? this.children.indexOf(reference) : -1;
    if (index < 0) this.children.push(child);
    else this.children.splice(index, 0, child);
    child.parentNode = this;
    return child;
  }
  append(...children) {
    for (const child of children) this.appendChild(child);
  }
  removeChild(child) {
    this.children.splice(this.children.indexOf(child), 1);
    child.parentNode = null;
  }
  remove() {
    this.parentNode?.removeChild(this);
  }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(handler);
  }
  removeEventListener(type, handler) {
    this.listeners.get(type)?.delete(handler);
  }
  /** Bubble an event from this node to the root. */
  dispatch(type, init = {}) {
    const event = {
      type,
      target: this,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      ...init,
    };
    for (let node = this; node; node = node.parentNode)
      for (const handler of [...(node.listeners.get(type) || [])])
        handler(event);
    return event;
  }
  click() {
    if (!this.disabled) this.dispatch('click');
  }
  matches(selector) {
    return matches(this, selector);
  }
  closest(selector) {
    for (let node = this; node; node = node.parentNode)
      if (matches(node, selector)) return node;
    return null;
  }
  querySelector(selector) {
    return this.find((node) => matches(node, selector));
  }
  find(predicate) {
    for (const child of this.children) {
      if (predicate(child)) return child;
      const inner = child.find(predicate);
      if (inner) return inner;
    }
    return null;
  }
  findAll(predicate, out = []) {
    for (const child of this.children) {
      if (predicate(child)) out.push(child);
      child.findAll(predicate, out);
    }
    return out;
  }
  focus(options) {
    this.focused += 1;
    this.focusOptions = options;
  }
  blur() {
    this.blurred += 1;
  }
  listenerCount() {
    return [...this.listeners.values()].reduce((n, set) => n + set.size, 0);
  }
}

/** The static rail panel skeleton from templates/context.html. */
function fakeDocument() {
  const document = {
    documentElement: { clientWidth: 1200 },
    createElement: (tag) => new FakeElement(tag, document),
    getElementById: (id) => document.body.find((node) => node.id === id),
  };
  document.body = new FakeElement('body', document);
  const panel = document.createElement('div');
  panel.id = 'recent-imagery-panel';
  panel.className = 'panel-collapsible collapsed';
  panel.hidden = true;
  const count = document.createElement('span');
  count.id = 'recent-imagery-panel-count';
  const collapse = document.createElement('button');
  collapse.dataset.collapseTarget = 'recent-imagery-panel';
  collapse.clicked = 0;
  collapse.click = () => {
    collapse.clicked += 1;
    panel.classList.toggle('collapsed');
  };
  const body = document.createElement('div');
  body.id = 'recent-imagery-panel-body';
  panel.append(count, collapse, body);
  document.body.appendChild(panel);
  return { document, panel, count, collapse, body };
}

// ---- the real layer, with fakes for everything it injects ------------------
function fixture({ fetchImpl, controller = fakeController() } = {}) {
  const dom = fakeDocument();
  const renderer = fakeRenderer();
  const thumbnails = fakeThumbnails();
  const catalog = fakeCatalog();
  const timers = manualTimers();
  const layer = createRecentImageryLayer({
    catalog,
    renderer,
    thumbnails,
    host: () => ({ collection: {}, kind: 'globe' }),
    now: () => new Date('2026-09-21T15:00:00Z'),
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
  });
  layer.setSources({ viirs: true });
  const viewer = {
    camera: {},
    scene: { canvas: { clientWidth: 1000 }, requestRender() {} },
  };
  layer.init(viewer);
  layer.attachMapStackController(controller);
  let active = false;
  const tool = {
    calls: [],
    start() {
      active = true;
      this.calls.push('start');
      layer.setToolActive(true);
    },
    cancel(reason) {
      active = false;
      this.calls.push(`cancel:${reason}`);
      layer.setToolActive(false);
    },
    isActive: () => active,
  };
  const splits = [];
  const fetches = [];
  const urls = { created: [], revoked: [] };
  const readout = createRecentImageryPanel({
    container: dom.body,
    layer,
    viewer,
    tool,
    createSplit: (options) => {
      const split = {
        options,
        value: options.initialValue,
        values: [],
        destroyed: false,
        setValue(next) {
          this.value = next;
          this.values.push(next);
        },
        destroy() {
          this.destroyed = true;
        },
      };
      splits.push(split);
      return split;
    },
    fetchImpl:
      fetchImpl ||
      (async (url) => {
        fetches.push(url);
        return response();
      }),
    createObjectUrl: () => {
      urls.created.push('blob:export');
      return 'blob:export';
    },
    revokeObjectUrl: (url) => urls.revoked.push(url),
  });
  const root = readout.root;
  const byId = (id) => root.find((node) => node.id === id);
  const byAction = (id) => root.find((node) => node.dataset.actionId === id);
  const cards = () =>
    root.findAll((node) => node.classList.contains('ri-card'));
  const card = (key) => cards().find((node) => node.dataset.key === key);
  const chip = (key, slot) =>
    card(key).find((node) => node.dataset.slot === slot);
  const part = (node, name) =>
    node.find((child) => child.classList.contains(name));
  const strip = byId('ri-strip');
  const key = (name, extra = {}) =>
    strip.dispatch('keydown', { key: name, ...extra });
  /** Enable, select BOX and land the catalog. */
  const ready = async () => {
    layer.enable();
    layer.setBox(BOX);
    catalog.resolveLast();
    await settle();
  };
  const settleLease = async () => {
    controller.lease?.settle();
    await settle();
  };
  return {
    ...dom,
    layer,
    viewer,
    renderer,
    thumbnails,
    catalog,
    controller,
    timers,
    tool,
    splits,
    fetches,
    urls,
    readout,
    root,
    byId,
    byAction,
    cards,
    card,
    chip,
    part,
    strip,
    key,
    ready,
    settleLease,
    snap: () => layer.getSnapshot(),
  };
}

const rowText = (f, slotId) =>
  [
    part(f, `ri-slot-${slotId}`, 'ri-slot-tag').textContent,
    part(f, `ri-slot-${slotId}`, 'ri-slot-value').textContent,
  ].join(' | ');
function part(f, id, name) {
  return f.byId(id).find((node) => node.classList.contains(name));
}

// ---- tests ---------------------------------------------------------------------
test('the readout mounts in the rail body, hides while the layer is off and opens the panel once on first appearance', async () => {
  const f = fixture();
  assert.equal(f.root.parentNode, f.body);
  assert.equal(f.panel.hidden, true);
  assert.equal(f.count.textContent, '');
  await f.ready();
  const panel = f.document.getElementById('recent-imagery-panel');
  assert.equal(panel.hidden, false);
  assert.equal(f.collapse.clicked, 1, 'first appearance expands');
  assert.equal(panel.classList.contains('collapsed'), false);
  assert.equal(f.count.textContent, '4 DAYS');
  f.collapse.click();
  f.layer.disable();
  f.layer.enable();
  assert.equal(f.collapse.clicked, 2, 'never again: the user collapsed it');
  f.layer.disable();
  assert.equal(panel.hidden, true);
  assert.equal(f.count.textContent, '');
  // A stored or shared collapse choice wins over the first appearance.
  const g = fixture();
  g.document.getElementById(
    'recent-imagery-panel',
  ).dataset.collapsedPreference = 'stored';
  g.layer.enable();
  assert.equal(g.collapse.clicked, 0);
});

test('the body is a fixed stack of seven blocks in a fixed order, each with a fixed height in the stylesheet', () => {
  const f = fixture();
  assert.deepEqual(
    f.root.children.map((node) => node.id || node.className),
    [
      'ri-actions',
      'ri-notice',
      'ri-strip',
      'ri-hint',
      'ri-selection',
      'ri-controls',
      'ri-details',
    ],
  );
  const css = readFileSync(
    new URL('./styles/recent-imagery.css', import.meta.url),
    'utf8',
  );
  const rule = (selector) => {
    const start = css.indexOf(`${selector} {`);
    assert.ok(start >= 0, selector);
    return css.slice(start, css.indexOf('}', start));
  };
  assert.match(rule('.recent-imagery-readout .ri-actions-row'), /height: 22px/);
  assert.match(rule('.recent-imagery-readout .ri-line'), /height: 14px/);
  assert.match(rule('.recent-imagery-readout .ri-strip'), /height: 120px/);
  assert.match(rule('.recent-imagery-readout .ri-card'), /height: 112px/);
  assert.match(
    rule('.recent-imagery-readout .ri-selection'),
    /grid-template-rows: 20px 20px 20px/,
  );
  assert.match(rule('.recent-imagery-readout .ri-slot'), /height: 20px/);
  assert.match(rule('.recent-imagery-readout .ri-controls'), /height: 22px/);
  assert.match(
    rule('.recent-imagery-readout .is-reserved'),
    /visibility: hidden/,
  );
});

/*
 * A DOM-structure guard, not a layout-shift check: the fake DOM has no
 * layout, so this pins what the layout rests on (every control keeps its
 * place in the tree, nothing is hidden, and every block that must not change
 * height keeps the class the stylesheet fixes it by). The live gate
 * `scripts/qa-recent-imagery.mjs` measures the real rectangles.
 */
test('no control changes place in the tree, no block is hidden and every fixed-height block keeps its height class across every state (DOM-structure guard)', async () => {
  const f = fixture();
  const cssRule = (file, selector) => {
    const css = readFileSync(new URL(file, import.meta.url), 'utf8');
    const start = css.indexOf(`${selector} {`);
    assert.ok(start >= 0, `${file} has ${selector}`);
    return css.slice(start, css.indexOf('}', start));
  };
  const readout = (selector) =>
    cssRule(
      './styles/recent-imagery.css',
      `.recent-imagery-readout ${selector}`,
    );
  /**
   * Every block that must keep its height: the node carrying the class, that
   * class, and the rule it gets its height from. The mode row is the first
   * 20 px track of the selection grid. The details header has no height of
   * its own: it is the last block, so it moves nothing below it, and its
   * title is held to one line.
   */
  const fixedHeightBlocks = () => {
    const mode = f.byId('ri-mode');
    const header = f
      .byId('ri-details')
      .find((node) => node.classList.contains('rail-card-header'));
    return {
      'ri-actions': [
        f.byId('ri-actions'),
        'ri-actions-row',
        readout('.ri-actions-row'),
        /height: 22px/,
      ],
      'ri-notice': [
        f.byId('ri-notice'),
        'ri-line',
        readout('.ri-line'),
        /height: 14px/,
      ],
      'ri-zoom-in': [
        f.byId('ri-zoom-in')?.parentNode === f.byId('ri-notice')
          ? f.byId('ri-zoom-in')
          : null,
        'ri-zoom-in',
        readout('.ri-zoom-in'),
        /height: 14px/,
      ],
      'ri-strip': [
        f.byId('ri-strip'),
        'ri-strip',
        readout('.ri-strip'),
        /height: 120px/,
      ],
      'ri-hint': [
        f.byId('ri-hint'),
        'ri-line',
        readout('.ri-line'),
        /height: 14px/,
      ],
      'ri-mode': [
        mode.parentNode.children[0] === mode ? mode.parentNode : null,
        'ri-selection',
        readout('.ri-selection'),
        /grid-template-rows: 20px 20px 20px/,
      ],
      'ri-slot-a': [
        f.byId('ri-slot-a'),
        'ri-slot',
        readout('.ri-slot'),
        /height: 20px/,
      ],
      'ri-slot-b': [
        f.byId('ri-slot-b'),
        'ri-slot',
        readout('.ri-slot'),
        /height: 20px/,
      ],
      'ri-controls': [
        f.byId('ri-controls'),
        'ri-controls',
        readout('.ri-controls'),
        /height: 22px/,
      ],
      'ri-swap': [
        f.byId('ri-swap')?.parentNode === f.byId('ri-controls')
          ? f.byId('ri-swap')
          : null,
        'data-toggle-chip',
        readout('.data-toggle-chip'),
        /height: 22px/,
      ],
      'details header': [
        f.root.children.at(-1) === f.byId('ri-details')
          ? header?.find((node) => node.classList.contains('rail-card-title'))
          : null,
        'rail-card-nowrap',
        cssRule('./styles/weather.css', '.rail-card-nowrap'),
        /white-space: nowrap/,
      ],
    };
  };
  const assertFixedHeights = (label) => {
    for (const [name, [node, className, rule, fixed]] of Object.entries(
      fixedHeightBlocks(),
    )) {
      assert.ok(node, `${name} is in place (${label})`);
      assert.ok(
        node.classList.contains(className),
        `${name} carries .${className} (${label})`,
      );
      assert.match(rule, fixed, `.${className} fixes ${name}`);
    }
  };
  const controls = () => ({
    'select-box': f.byAction('select-box'),
    'use-view': f.byAction('use-view'),
    clear: f.byAction('clear'),
    notice: f.byId('ri-notice'),
    'zoom-in': f.byId('ri-zoom-in'),
    strip: f.strip,
    hint: f.byId('ri-hint'),
    'mode-image': f.root.find(
      (node) =>
        node.classList.contains('ri-mode-btn') && node.dataset.mode === 'image',
    ),
    'mode-basemap': f.root.find(
      (node) =>
        node.classList.contains('ri-mode-btn') &&
        node.dataset.mode === 'basemap',
    ),
    'mode-ab': f.root.find(
      (node) =>
        node.classList.contains('ri-mode-btn') && node.dataset.mode === 'ab',
    ),
    'row-a': f.byId('ri-slot-a'),
    'row-b': f.byId('ri-slot-b'),
    'unpin-a': f.byId('ri-unpin-a'),
    'unpin-b': f.byId('ri-unpin-b'),
    opacity: f.byId('ri-opacity'),
    swap: f.byId('ri-swap'),
    'export-a': f.byAction('export-a'),
    'export-b': f.byAction('export-b'),
    details: f
      .byId('ri-details')
      .find((node) => node.classList.contains('rail-card-header')),
  });
  /** Tag and index from the root down, plus every hidden flag on the way. */
  const layout = () => {
    const out = {};
    for (const [name, node] of Object.entries(controls())) {
      assert.ok(node, name);
      const path = [];
      for (let at = node; at && at !== f.root; at = at.parentNode) {
        assert.equal(at.hidden, false, `${name} is never hidden`);
        path.unshift(`${at.tagName}${at.parentNode.children.indexOf(at)}`);
      }
      out[name] = path.join('/');
    }
    return out;
  };
  const baseline = layout();
  assertFixedHeights('built');
  const states = [];
  const record = (label) => {
    assert.deepEqual(layout(), baseline, label);
    assertFixedHeights(label);
    states.push(label);
  };
  f.layer.enable();
  record('enabled, no box');
  f.layer.setBox(BOX);
  record('searching');
  f.catalog.resolveLast();
  await settle();
  await f.settleLease();
  record('preview');
  f.chip(S18, 'a').click();
  record('pinned');
  f.byId('ri-opacity').value = '40';
  f.byId('ri-opacity').dispatch('input');
  record('opacity');
  f.root
    .find(
      (node) =>
        node.classList.contains('ri-mode-btn') &&
        node.dataset.mode === 'basemap',
    )
    .click();
  record('vs basemap');
  f.root
    .find(
      (node) =>
        node.classList.contains('ri-mode-btn') && node.dataset.mode === 'ab',
    )
    .click();
  f.chip(L16, 'b').click();
  record('A / B');
  f.byId('ri-swap').click();
  record('swapped');
  f.byId('ri-unpin-b').click();
  record('B unpinned');
  f.byId('ri-unpin-a').click();
  record('A unpinned');
  f.layer.setBox({ west: 0, south: 0, east: 20, north: 20 });
  record('refused');
  f.byAction('clear').click();
  record('cleared');
  assert.equal(states.length, 12);
});

test('cards carry thumbnail, date, sensor, cloud, START HERE and PREVIEW; the chips follow the mode without moving', async () => {
  const f = fixture();
  await f.ready();
  f.thumbnails.setStatus(S18, 'present');
  f.layer.setVisibleRange(0, 3);
  f.layer.focus(1);
  const s18 = f.card(S18);
  assert.equal(f.part(s18, 'ri-card-date').textContent, 'Sep 18');
  assert.equal(f.part(s18, 'ri-card-sensor').textContent, 'Sentinel-2 · 30 m');
  assert.equal(f.part(s18, 'ri-card-cloud').textContent, '12% cloud');
  assert.equal(f.part(s18, 'ri-card-start').hidden, false);
  assert.match(f.part(s18, 'ri-card-start').title, /Newest low-cloud day/);
  assert.equal(f.part(s18, 'ri-card-flag').textContent, 'PREVIEW');
  assert.equal(
    f.part(f.card(V21), 'ri-card-cloud').textContent,
    'cloud unknown',
  );
  assert.equal(f.part(f.card(V21), 'ri-thumb-text').textContent, 'Checking');
  assert.equal(
    f.part(f.card(V21), 'ri-card-sensor').textContent,
    'Daily overview · 250 m',
  );
  assert.equal(
    f.part(f.card(L16), 'ri-card-sensor').textContent,
    'Landsat 8/9 · 30 m',
  );
  // IMAGE: one SHOW chip; the B chip keeps its box but is invisible.
  const [a, b] = [f.chip(S18, 'a'), f.chip(S18, 'b')];
  assert.deepEqual(
    [
      a.textContent,
      a.getAttribute('aria-pressed'),
      b.classList.contains('is-reserved'),
      b.disabled,
    ],
    ['SHOW', 'false', true, true],
  );
  assert.equal(a.getAttribute('aria-label'), 'Show Sep 18');
  a.click();
  assert.equal(a.getAttribute('aria-pressed'), 'true');
  assert.equal(a.classList.contains('active'), true);
  assert.equal(
    f.part(s18, 'ri-card-flag').hidden,
    true,
    'pinned, not previewed',
  );
  assert.match(s18.getAttribute('aria-label'), /· shown$/);
  // A / B: the same chip slots, relabelled.
  f.root
    .find(
      (node) =>
        node.classList.contains('ri-mode-btn') && node.dataset.mode === 'ab',
    )
    .click();
  assert.deepEqual(
    [
      a.textContent,
      b.textContent,
      b.classList.contains('is-reserved'),
      b.disabled,
    ],
    ['A', 'B', false, false],
  );
  assert.equal(a.parentNode.children.indexOf(a), 0);
  assert.equal(b.getAttribute('aria-label'), 'Pin Sep 18 as B');
  // A day is one slot only: B moves it.
  b.click();
  assert.deepEqual(
    [a.getAttribute('aria-pressed'), b.getAttribute('aria-pressed')],
    ['false', 'true'],
  );
  // An empty day cannot be pinned.
  f.thumbnails.probe(V21, 'empty');
  f.layer.setShowUnavailable(true);
  assert.equal(f.chip(V21, 'a').disabled, true);
  assert.equal(f.part(f.card(V21), 'ri-card-cloud').textContent, 'no imagery');
});

test('the selection bar reads the mode, both rows and a preview, with × reserved when empty', async () => {
  const f = fixture();
  await f.ready();
  const modes = f.root.findAll((node) =>
    node.classList.contains('ri-mode-btn'),
  );
  assert.deepEqual(
    modes.map((node) => [
      node.textContent,
      node.getAttribute('role'),
      node.getAttribute('aria-checked'),
    ]),
    [
      ['IMAGE', 'radio', 'true'],
      ['VS BASEMAP', 'radio', 'false'],
      ['A / B', 'radio', 'false'],
    ],
  );
  assert.equal(rowText(f, 'a'), 'IMAGE | Sep 18 · Sentinel-2 · 30 m · preview');
  assert.equal(f.byId('ri-slot-a').dataset.state, 'preview');
  assert.equal(rowText(f, 'b'), 'VS | Basemap');
  assert.equal(f.byId('ri-slot-b').classList.contains('lit'), false, 'dimmed');
  const unpinA = f.byId('ri-unpin-a');
  assert.deepEqual(
    [
      unpinA.disabled,
      unpinA.classList.contains('is-reserved'),
      unpinA.textContent,
    ],
    [true, true, '×'],
  );
  f.key('s');
  assert.equal(rowText(f, 'a'), 'IMAGE | Sep 18 · Sentinel-2 · 30 m');
  assert.equal(f.byId('ri-slot-a').dataset.state, 'pinned');
  assert.equal(unpinA.disabled, false);
  assert.equal(unpinA.getAttribute('aria-label'), 'Unpin the image');
  modes[1].click();
  assert.equal(f.snap().mode, 'basemap');
  assert.equal(modes[1].getAttribute('aria-checked'), 'true');
  assert.equal(f.byId('ri-slot-b').classList.contains('lit'), true, 'lit');
  modes[2].click();
  assert.equal(rowText(f, 'a'), 'A | Sep 18 · Sentinel-2 · 30 m');
  assert.equal(rowText(f, 'b'), 'B | Not set');
  assert.equal(f.byId('ri-slot-b').dataset.state, 'empty');
  assert.equal(f.byId('ri-unpin-b').classList.contains('is-reserved'), true);
  f.chip(L16, 'b').click();
  assert.equal(rowText(f, 'b'), 'B | Sep 16 · Landsat 8/9 · 30 m');
  f.byId('ri-unpin-b').click();
  assert.equal(f.snap().pins.b.key, null);
  unpinA.click();
  assert.equal(f.snap().pins.a.key, null);
  assert.equal(f.renderer.ownedCount(), 0, 'unpinning drops the layer');
  // Mode keys move the radio selection.
  f.byId('ri-mode').dispatch('keydown', { key: 'ArrowRight' });
  assert.equal(f.snap().mode, 'image');
});

test('strip keys: arrows preview after the debounce, S / A / B pin, Enter previews, repeats are ignored', async () => {
  const f = fixture();
  await f.ready();
  f.key('ArrowRight');
  assert.equal(f.snap().focus.key, L16);
  f.timers.flush();
  assert.equal(f.snap().preview.key, L16);
  f.key('Home');
  assert.equal(f.snap().focus.key, V21);
  f.key('End');
  assert.equal(f.snap().focus.index, 3);
  f.key('ArrowLeft');
  f.timers.flush();
  f.key('a', { repeat: true });
  assert.equal(f.snap().pins.a.key, null, 'key repeat never pins');
  f.key('b');
  assert.equal(f.snap().pins.b.key, null, 'no B outside A / B');
  f.key('A');
  assert.equal(f.snap().pins.a.key, L16);
  f.key('a');
  assert.equal(f.snap().pins.a.key, null, 'A again unpins');
  f.layer.setMode('ab');
  f.key('a');
  f.key('ArrowLeft');
  f.key('b');
  assert.deepEqual([f.snap().pins.a.key, f.snap().pins.b.key], [L16, S18]);
  f.key('a', { metaKey: true });
  assert.equal(f.snap().pins.a.key, L16, 'modified keys are not ours');
  f.layer.setAssignment('a', null);
  f.layer.setAssignment('b', null);
  f.key('Enter');
  assert.equal(f.snap().preview.key, S18, 'Enter previews the focused day');
});

test('clicks: a card previews and focuses the strip, a chip pins, SELECT BOX toggles the tool, USE VIEW and CLEAR drive the layer', async () => {
  const f = fixture();
  await f.ready();
  f.card(L16).click();
  assert.equal(f.snap().preview.key, L16);
  assert.equal(f.strip.focused, 1);
  assert.deepEqual(f.strip.focusOptions, { preventScroll: true });
  f.chip(S18, 'a').click();
  assert.equal(f.snap().pins.a.key, S18);
  const selectBox = f.byAction('select-box');
  selectBox.click();
  assert.deepEqual(f.tool.calls, ['start']);
  assert.equal(selectBox.getAttribute('aria-pressed'), 'true');
  selectBox.click();
  assert.deepEqual(f.tool.calls, ['start', 'cancel:toggle']);
  assert.equal(selectBox.getAttribute('aria-pressed'), 'false');
  f.byAction('use-view').click();
  assert.equal(
    f.snap().boxError,
    'Point the camera at the ground to use the view',
  );
  assert.equal(f.byAction('clear').disabled, false);
  f.byAction('clear').click();
  assert.equal(f.snap().box, null);
  assert.equal(f.byAction('clear').disabled, true);
});

test('Escape clears the preview first, then cancels the box tool, then blurs the strip', async () => {
  const f = fixture();
  await f.ready();
  f.tool.start();
  f.key('Escape');
  assert.equal(f.snap().preview.key, null);
  assert.equal(f.tool.isActive(), true);
  f.key('Escape');
  assert.equal(f.tool.isActive(), false);
  f.key('Escape');
  assert.equal(f.strip.blurred, 1);
  // From elsewhere in the panel Escape only acts when there is something to undo.
  f.card(L16).click();
  const escape = f.byId('ri-opacity').dispatch('keydown', { key: 'Escape' });
  assert.equal(escape.defaultPrevented, true);
  assert.equal(f.snap().preview.key, null);
  const idle = f.byId('ri-opacity').dispatch('keydown', { key: 'Escape' });
  assert.equal(idle.defaultPrevented, false);
});

test('the notice line shows the refusal, then errors, then CLEAR, then the Esri note; the hint names the next step and that SWAP trades the sides', async () => {
  const controller = fakeController();
  let active = 'photoreal';
  controller.getActiveId = () => active;
  const f = fixture({ controller });
  const notice = f.byId('ri-notice');
  const noticeText = f.byId('ri-notice-text');
  const hint = f.byId('ri-hint');
  f.layer.enable();
  assert.equal(noticeText.textContent, '');
  assert.equal(hint.textContent, 'Select a box or use the view');
  f.layer.setBox(BOX);
  assert.equal(hint.textContent, 'Searching the last 30 days');
  f.catalog.resolveLast();
  await settle();
  assert.equal(hint.textContent, '← → preview · S shows the focused day');
  active = 'esri-imagery';
  controller.lease.settle({ status: 'ready', activeId: active });
  await settle();
  assert.equal(
    noticeText.textContent,
    'Imagery on Esri · Google 3D returns when cleared',
  );
  assert.equal(notice.classList.contains('info'), true);
  f.layer.setBox({ west: 0, south: 0, east: 20, north: 20 });
  assert.equal(noticeText.textContent, 'Box is 2,226 km wide · limit 1,000 km');
  assert.equal(notice.classList.contains('warn'), true);
  assert.equal(hint.textContent, 'Zoom in or draw a smaller box');
  f.layer.setBox(BOX);
  f.chip(S18, 'a').click();
  assert.equal(hint.textContent, 'S on another day replaces it · × unpins');
  f.layer.setMode('basemap');
  assert.equal(hint.textContent, 'Drag the divider · SWAP trades sides');
  f.layer.setMode('ab');
  assert.equal(hint.textContent, '← → preview the other side · A or B pins it');
  f.chip(L16, 'b').click();
  assert.equal(hint.textContent, 'Drag the divider · SWAP trades sides');
  f.layer.setAssignment('b', null);
  f.layer.setAssignment('a', null);
  assert.equal(hint.textContent, '← → preview · A or B pins the focused day');
  f.byAction('clear').click();
  assert.equal(noticeText.textContent, 'Box and images cleared');
  assert.equal(notice.classList.contains('info'), true);
});

test('an oversized box offers ZOOM IN in a fixed slot at the end of the notice line; it asks the layer to fit', async () => {
  const f = fixture();
  const flights = [];
  f.viewer.scene.canvas.clientHeight = 500;
  f.viewer.scene.ellipsoid = {
    cartographicToCartesian: (c) => ({ ...c }),
  };
  Object.assign(f.viewer.camera, {
    frustum: { fovy: 2 * Math.atan(Math.tan(Math.PI / 6) / 2) },
    flyTo: (options) => flights.push(options),
  });
  const notice = f.byId('ri-notice');
  const zoom = f.byId('ri-zoom-in');
  assert.equal(zoom.tagName, 'BUTTON');
  assert.equal(zoom.textContent, 'ZOOM IN');
  assert.equal(notice.children.at(-1), zoom, 'the right end of the line');
  const reserved = () => [
    zoom.classList.contains('is-reserved'),
    zoom.disabled,
    zoom.getAttribute('aria-hidden'),
    notice.classList.contains('has-action'),
  ];
  await f.ready();
  assert.deepEqual(reserved(), [true, true, 'true', false]);
  zoom.click();
  assert.equal(flights.length, 0);
  f.layer.setBox({ west: 0, south: 0, east: 20, north: 20 });
  assert.deepEqual(reserved(), [false, false, 'false', true]);
  assert.equal(
    f.byId('ri-notice-text').textContent,
    'Box is 2,226 km wide · limit 1,000 km',
  );
  assert.equal(f.byId('ri-hint').textContent, 'Zoom in or draw a smaller box');
  assert.equal(zoom.title, 'Fly in until the view fits the 1,000 km limit');
  zoom.click();
  assert.equal(flights.length, 1);
  assert.ok(
    Math.abs(
      flights[0].destination.height - 400_000 / (2 * Math.tan(Math.PI / 6)),
    ) < 1e-6,
  );
  // Another refusal has nothing to fit; a box that succeeds hides it again.
  f.layer.reportBoxRefusal('Select one side of the dateline');
  assert.deepEqual(reserved(), [true, true, 'true', false]);
  f.layer.setBox({ west: 0, south: 0, east: 20, north: 20 });
  f.layer.setBox(BOX);
  assert.deepEqual(reserved(), [true, true, 'true', false]);
});

test('the divider exists only while a swipe is live, labelled A / B or IMAGE / BASEMAP; SWAP trades its sides and Space does nothing', async () => {
  const f = fixture();
  const swap = f.byId('ri-swap');
  const swapState = () => [
    swap.disabled,
    swap.classList.contains('is-reserved'),
    swap.getAttribute('aria-hidden'),
    swap.getAttribute('aria-pressed'),
  ];
  const labels = () => {
    const { beforeLabel, afterLabel } = f.splits.at(-1).options;
    return [beforeLabel, afterLabel];
  };
  const directions = () => {
    const owned = f.renderer.getOwned();
    return [owned.a?.splitDirection, owned.b?.splitDirection];
  };
  assert.equal(swap.tagName, 'BUTTON');
  assert.equal(swap.textContent, 'SWAP');
  assert.equal(swap.parentNode, f.byId('ri-controls'));
  await f.ready();
  await f.settleLease();
  assert.equal(f.splits.length, 0, 'one image, no divider');
  assert.deepEqual(swapState(), [true, true, 'true', 'false']);
  swap.click();
  assert.equal(f.snap().swapped, false, 'no swipe, nothing to swap');
  f.layer.setMode('basemap');
  assert.equal(f.splits.length, 1);
  assert.deepEqual(labels(), ['IMAGE', 'BASEMAP']);
  assert.equal(f.splits[0].options.id, 'recent-imagery-split-line');
  assert.deepEqual(swapState(), [false, false, 'false', 'false']);
  assert.deepEqual(directions(), ['left', undefined]);
  // VS BASEMAP: SWAP puts the image right of the basemap, and back.
  swap.click();
  assert.equal(f.snap().swapped, true);
  assert.deepEqual(labels(), ['BASEMAP', 'IMAGE']);
  assert.deepEqual(directions(), ['right', undefined]);
  assert.deepEqual(swapState(), [false, false, 'false', 'true']);
  swap.click();
  assert.deepEqual(labels(), ['IMAGE', 'BASEMAP']);
  assert.deepEqual(directions(), ['left', undefined]);
  f.layer.setMode('ab');
  f.layer.setAssignment('a', S18);
  f.layer.setAssignment('b', L16);
  assert.equal(f.splits[0].destroyed, true);
  const split = f.splits.at(-1);
  assert.deepEqual(
    [split.options.beforeLabel, split.options.afterLabel],
    ['A', 'B'],
  );
  assert.equal(split.options.afterTitle, 'Landsat 8/9 · 30 m · 2026-09-16');
  split.options.onChange(0.3);
  assert.equal(f.snap().split, 0.3);
  assert.deepEqual(directions(), ['left', 'right']);
  // Space is push-to-talk: the panel never takes it.
  for (const target of [f.strip, f.byId('ri-opacity'), f.root]) {
    const space = target.dispatch('keydown', { key: ' ' });
    assert.equal(space.defaultPrevented, false);
  }
  assert.equal(f.splits.at(-1), split, 'the divider is untouched');
  assert.equal(f.snap().swapped, false);
  // SWAP: A moves right and B left, the labels follow; the divider stays.
  swap.click();
  assert.equal(split.destroyed, true);
  assert.deepEqual(labels(), ['B', 'A']);
  assert.equal(
    f.splits.at(-1).options.beforeTitle,
    'Landsat 8/9 · 30 m · 2026-09-16',
  );
  assert.equal(f.splits.at(-1).options.initialValue, 0.3);
  assert.deepEqual(directions(), ['right', 'left']);
  assert.equal(swap.getAttribute('aria-pressed'), 'true');
  assert.equal(f.layer.getParams().swapped, undefined, 'not in the link');
  // Again restores.
  swap.click();
  assert.deepEqual(labels(), ['A', 'B']);
  assert.deepEqual(directions(), ['left', 'right']);
  assert.equal(swap.getAttribute('aria-pressed'), 'false');
  // Unpinning B ends the swipe and SWAP goes back to its reserved slot.
  f.byId('ri-unpin-b').click();
  assert.equal(f.splits.at(-1).destroyed, true);
  assert.deepEqual(swapState(), [true, true, 'true', 'false']);
});

test('opacity drives both images; EXPORT downloads the pin or the preview and EXPORT B only exists in A / B', async () => {
  const f = fixture();
  await f.ready();
  const exportA = f.byAction('export-a');
  const exportB = f.byAction('export-b');
  assert.deepEqual(
    [
      exportA.textContent,
      exportA.disabled,
      exportB.classList.contains('is-reserved'),
      exportB.disabled,
    ],
    ['EXPORT', false, true, true],
  );
  f.byId('ri-opacity').value = '40';
  f.byId('ri-opacity').dispatch('input');
  assert.equal(f.snap().alpha, 0.4);
  assert.equal(
    f.part(f.byId('ri-controls'), 'ri-opacity-value').textContent,
    '40%',
  );
  assert.equal(await f.readout.exportImage('a'), true);
  assert.match(f.fetches[0], /LAYERS=HLS_S30_Nadir_BRDF_Adjusted_Reflectance/);
  assert.match(f.fetches[0], /WIDTH=1024/);
  assert.deepEqual(f.urls, {
    created: ['blob:export'],
    revoked: ['blob:export'],
  });
  assert.equal(await f.readout.exportImage('b'), false, 'no B outside A / B');
  // A wide box exports wide: the longer side at the limit, degrees kept.
  f.layer.setBox({ ...BOX, east: -97.6 });
  f.catalog.resolveLast();
  await settle();
  assert.equal(await f.readout.exportImage('a'), true);
  assert.match(f.fetches.at(-1), /WIDTH=1024&HEIGHT=512/);
  f.layer.setMode('ab');
  assert.deepEqual(
    [
      exportA.textContent,
      exportB.textContent,
      exportB.classList.contains('is-reserved'),
    ],
    ['EXPORT A', 'EXPORT B', false],
  );
  const failing = fixture({
    fetchImpl: async () => response({ ok: false, status: 503 }),
  });
  await failing.ready();
  assert.equal(await failing.readout.exportImage('a'), false);
  assert.equal(
    failing.byId('ri-notice-text').textContent,
    'Export failed · HTTP 503',
  );
});

test('DETAILS is a collapsed rail card holding every note, and the empty-days toggle', async () => {
  const f = fixture();
  await f.ready();
  const header = f
    .byId('ri-details')
    .find((node) => node.classList.contains('rail-card-header'));
  const article = header.parentNode;
  assert.equal(article.dataset.open, 'false');
  assert.equal(header.getAttribute('aria-expanded'), 'false');
  header.click();
  assert.equal(article.dataset.open, 'true');
  const text = f.byId('ri-details').textContent;
  assert.match(text, /Box \d+\.\d × \d+\.\d km/);
  assert.match(text, /Sep 18, 2026 17:12Z/);
  assert.match(text, /Acquired 17:12Z–17:14Z · Coverage full/);
  assert.match(text, /S30-2026-09-18 · 17:12Z · 12% cloud/);
  assert.match(text, /START HERE · newest clear day/);
  assert.match(
    text,
    /Daily overview for today may still be empty until the pass/,
  );
  assert.match(text, /Daily overview shows little detail in a box this small/);
  assert.match(text, /NASA GIBS/);
  const toggle = f.byAction('toggle-empty');
  assert.equal(toggle.disabled, true, 'nothing hidden yet');
  f.thumbnails.probe(L16, 'empty');
  assert.equal(toggle.textContent, 'SHOW EMPTY DAYS · 1');
  toggle.click();
  assert.equal(f.snap().showUnavailable, true);
  assert.equal(toggle.textContent, 'HIDE EMPTY DAYS');
  header.click();
  assert.equal(article.dataset.open, 'false');
});

test('the body scroll position survives renders even when DOM mutations reset it', async () => {
  const f = fixture();
  await f.ready();
  f.body.scrollTop = 120;
  const insert = f.strip.insertBefore.bind(f.strip);
  f.strip.insertBefore = (...args) => {
    f.body.scrollTop = 0;
    return insert(...args);
  };
  f.thumbnails.probe(L16, 'empty');
  f.layer.setShowUnavailable(true);
  assert.equal(f.body.scrollTop, 120);
});

test('destroy returns every listener, the divider and the panel state', async () => {
  const f = fixture();
  await f.ready();
  await f.settleLease();
  f.layer.setMode('basemap');
  const split = f.splits.at(-1);
  f.readout.destroy();
  assert.equal(split.destroyed, true);
  assert.equal(f.root.listenerCount(), 0);
  assert.equal(f.strip.listenerCount(), 0);
  assert.equal(f.root.parentNode, null);
  assert.equal(f.document.getElementById('recent-imagery-panel').hidden, true);
  f.layer.setMode('ab');
  assert.equal(f.splits.length, 1, 'no renders after destroy');
  f.readout.destroy();
});
