/**
 * Boundary: the UI renders inline Lucide SVG icons, never emoji or text
 * glyphs. Fails when an emoji code point or an icon-glyph appears in UI
 * source (JS / HTML templates / CSS / index.html / public HTML), when a layer
 * declares an icon name the registry does not know, or when the rendered
 * DATA LAYERS panel carries a glyph in any text node or a row without an
 * inline <svg>. Mapping and evidence: docs/brand/ICON_SOURCE.md.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandApplicationHtml } from '../build/application-html.js';
import {
  ICON_CLASS,
  ICON_FALLBACK,
  ICON_STROKE_WIDTH,
  LUCIDE_VERSION,
  hasIcon,
  iconMarkup,
  iconNames,
} from './ui/icons/layerIcon.js';

const SRC_ROOT = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = path.resolve(SRC_ROOT, '..');

/**
 * Forbidden in UI source. Emoji blocks as requested by the icon audit, plus the
 * glyph blocks this UI used to draw icons with: Geometric Shapes (triangles,
 * circles, squares, play/collapse marks), Miscellaneous Technical (the
 * position indicator), Roman numerals (the pause mark), the triple tilde.
 * Block Elements (U+2580–259F) stay allowed: the chat caret is a text cursor,
 * not an icon.
 */
const FORBIDDEN = [
  [
    'U+1F000–U+1FAFF emoji (incl. regional indicators U+1F1E6–U+1F1FF)',
    0x1f000,
    0x1faff,
  ],
  ['U+2600–U+27BF misc symbols & dingbats', 0x2600, 0x27bf],
  ['U+2B00–U+2BFF misc symbols and arrows', 0x2b00, 0x2bff],
  ['U+FE0F variation selector-16', 0xfe0f, 0xfe0f],
  ['U+200D zero width joiner', 0x200d, 0x200d],
  ['U+25A0–U+25FF geometric shapes', 0x25a0, 0x25ff],
  ['U+2300–U+23FF miscellaneous technical', 0x2300, 0x23ff],
  ['U+2160–U+216F roman numerals used as glyphs', 0x2160, 0x216f],
  ['U+224B triple tilde', 0x224b, 0x224b],
  // Arrows that this UI drew icons with (ORBIT mark, SWAP chip, FULL STORY /
  // REPLAY marks, external-link marks). The block is not forbidden wholesale:
  // → ↔ ⇒ ↘ remain prose in comments and title strings (ICON_SOURCE.md §5).
  ['U+21BA–U+21BB open-circle arrows used as glyphs (↺ ↻)', 0x21ba, 0x21bb],
  ['U+21C4–U+21C6 paired arrows used as glyphs (⇄ ⇅ ⇆)', 0x21c4, 0x21c6],
  ['U+2197 north-east arrow used as an external-link glyph', 0x2197, 0x2197],
];
const UI_ROOTS = ['src'];
const UI_FILES = ['index.html', 'style.css'];
const UI_EXTENSIONS = /\.(?:js|mjs|cjs|html|css)$/;
const ENTITY = /&#(x[0-9a-f]+|[0-9]+);/gi;
const JS_ESCAPE =
  /\\u\{([0-9a-f]{1,6})\}|\\u(d83[0-9a-f])\\u(d[c-f][0-9a-f]{2})|\\u([0-9a-f]{4})/gi;

function forbiddenBlock(codePoint) {
  return FORBIDDEN.find(([, from, to]) => codePoint >= from && codePoint <= to);
}

function uiSourceFiles() {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (
        entry.isFile() &&
        UI_EXTENSIONS.test(entry.name) &&
        !/\.test\.mjs$/.test(entry.name)
      )
        files.push(absolute);
    }
  };
  for (const root of UI_ROOTS) visit(path.join(REPO_ROOT, root));
  for (const file of UI_FILES) files.push(path.join(REPO_ROOT, file));
  const publicRoot = path.join(REPO_ROOT, 'public');
  for (const entry of readdirSync(publicRoot, { withFileTypes: true })) {
    if (entry.isFile() && /\.html$/.test(entry.name))
      files.push(path.join(publicRoot, entry.name));
  }
  return files.sort();
}

/** Every forbidden occurrence in `text` as `line:col U+XXXX (block)`. */
export function findForbiddenGlyphs(text) {
  const hits = [];
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    let column = 0;
    for (const character of line) {
      column += 1;
      const codePoint = character.codePointAt(0);
      const block = forbiddenBlock(codePoint);
      if (block)
        hits.push(
          `${index + 1}:${column} U+${codePoint.toString(16).toUpperCase().padStart(4, '0')} (${block[0]})`,
        );
    }
    for (const match of line.matchAll(ENTITY)) {
      const value = match[1];
      const codePoint = /^x/i.test(value)
        ? Number.parseInt(value.slice(1), 16)
        : Number.parseInt(value, 10);
      const block = forbiddenBlock(codePoint);
      if (block)
        hits.push(
          `${index + 1}:${match.index + 1} entity ${match[0]} (${block[0]})`,
        );
    }
    for (const match of line.matchAll(JS_ESCAPE)) {
      let codePoint;
      if (match[1]) codePoint = Number.parseInt(match[1], 16);
      else if (match[2])
        codePoint =
          (Number.parseInt(match[2], 16) - 0xd800) * 0x400 +
          (Number.parseInt(match[3], 16) - 0xdc00) +
          0x10000;
      else codePoint = Number.parseInt(match[4], 16);
      const block = forbiddenBlock(codePoint);
      if (block)
        hits.push(
          `${index + 1}:${match.index + 1} escape ${match[0]} (${block[0]})`,
        );
    }
  });
  return hits;
}

test('UI source files carry no emoji or icon-glyph code points', () => {
  const offenders = [];
  for (const file of uiSourceFiles()) {
    const hits = findForbiddenGlyphs(readFileSync(file, 'utf8'));
    for (const hit of hits)
      offenders.push(`${path.relative(REPO_ROOT, file)}:${hit}`);
  }
  assert.deepEqual(
    offenders,
    [],
    `Emoji / glyph icons in UI source (use src/ui/icons/layerIcon.js):\n${offenders.join('\n')}`,
  );
});

test('the assembled application markup renders icons, not glyphs', () => {
  const html = expandApplicationHtml(
    readFileSync(path.join(REPO_ROOT, 'index.html'), 'utf8'),
  );
  assert.deepEqual(findForbiddenGlyphs(html), []);
  // Every former glyph slot is an inline Lucide icon.
  const icons = [...html.matchAll(/<svg [^>]*data-icon="([a-z0-9-]+)"/g)].map(
    (match) => match[1],
  );
  assert.ok(icons.length >= 30, `expected inline icons, found ${icons.length}`);
  for (const name of icons)
    assert.ok(hasIcon(name), `unregistered icon ${name}`);
  // Rendering contract (ICON_SOURCE.md §4): every inline icon — the ones
  // inlined in templates as much as the ones LayerPanel creates — renders at
  // ICON_STROKE_WIDTH, not the vendored files' stroke-width="2".
  const roots = [...html.matchAll(/<svg [^>]*data-icon="[a-z0-9-]+"[^>]*>/g)];
  const offStroke = roots
    .map((match) => match[0])
    .filter(
      (tag) => !tag.includes(`stroke-width="${ICON_STROKE_WIDTH}"`),
    );
  assert.deepEqual(
    offStroke,
    [],
    `template icons must carry stroke-width="${ICON_STROKE_WIDTH}"`,
  );
  for (const expected of [
    'chevron-left',
    'skip-back',
    'play',
    'skip-forward',
    'plus',
    'map-pin',
    'search',
    'link',
    'moon',
    'thermometer',
    'snowflake',
  ])
    assert.ok(icons.includes(expected), `template lacks ${expected}`);
});

test('every layer icon declared in source is a registered Lucide icon', () => {
  const declared = new Map();
  for (const file of uiSourceFiles()) {
    if (!/\.(?:js|mjs)$/.test(file)) continue;
    const source = readFileSync(file, 'utf8');
    // Icon-name shaped values only; a glyph value is caught by the code-point
    // scan above and a data: URL is an image, not a registry name.
    for (const match of source.matchAll(
      /\bicon(?:\s*[:=]|\s*\?\?)\s*'([a-z0-9-]+)'/g,
    ))
      declared.set(`${path.relative(REPO_ROOT, file)} → ${match[1]}`, match[1]);
    for (const match of source.matchAll(
      /icon(?:Markup|Content)?\(\s*'([a-z0-9-]+)'/g,
    ))
      declared.set(`${path.relative(REPO_ROOT, file)} → ${match[1]}`, match[1]);
  }
  assert.ok(declared.size >= 20, 'layer icon declarations were not found');
  const unknown = [...declared].filter(([, name]) => !hasIcon(name));
  assert.deepEqual(
    unknown.map(([where]) => where),
    [],
    'icon names must exist in src/ui/icons/lucide-manifest.json',
  );
});

test('manifest, generated registry and public/brand/icons agree', () => {
  const manifest = JSON.parse(
    readFileSync(path.join(SRC_ROOT, 'ui/icons/lucide-manifest.json'), 'utf8'),
  );
  assert.equal(manifest.version, LUCIDE_VERSION);
  assert.equal(manifest.license, 'ISC');
  const names = manifest.icons.map((entry) => entry.name);
  assert.deepEqual(iconNames(), names, 'registry order follows the manifest');
  assert.ok(names.includes(ICON_FALLBACK));
  const iconsDir = path.join(REPO_ROOT, 'public/brand/icons');
  assert.ok(
    existsSync(path.join(iconsDir, 'LICENSE')),
    'LICENSE ships with the icons',
  );
  const shipped = readdirSync(iconsDir)
    .filter((file) => file.endsWith('.svg'))
    .map((file) => file.replace(/\.svg$/, ''))
    .sort();
  assert.deepEqual(shipped, [...names].sort());
  for (const name of names) {
    const svg = readFileSync(path.join(iconsDir, `${name}.svg`), 'utf8');
    for (const attribute of [
      'viewBox="0 0 24 24"',
      'fill="none"',
      'stroke="currentColor"',
      'stroke-width="2"',
      'stroke-linecap="round"',
      'stroke-linejoin="round"',
    ])
      assert.ok(svg.includes(attribute), `${name}.svg lacks ${attribute}`);
    assert.doesNotMatch(svg, /\bclass=/, `${name}.svg keeps a class attribute`);
  }
  const pkg = JSON.parse(
    readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'),
  );
  assert.equal(
    pkg.devDependencies['lucide-static'],
    manifest.version,
    'exact pin',
  );
});

test('icons.json covers every layer id that used to carry an emoji or glyph', () => {
  const icons = JSON.parse(
    readFileSync(path.join(REPO_ROOT, 'public/brand/icons/icons.json'), 'utf8'),
  );
  assert.equal(icons.version, LUCIDE_VERSION);
  // Layer ids whose panel row icon was an emoji / text glyph at 18e2a68.
  const formerEmojiLayers = [
    'satellites',
    'flights',
    'military',
    'ais-live-vessels',
    'traffic',
    'transit',
    'bikeshare',
    'cctv',
    'alpr-cameras',
    'military-installations',
    'local-datacenters',
    'telegeography-submarine-cables',
    'local-dams',
    'rocket-launches',
    'earthquakes',
    'local-firms',
    'directions',
    'radio',
    'military-awareness',
    'bhote-koshi-2026',
    'bhote-koshi-locator',
  ];
  for (const id of formerEmojiLayers) {
    const slot = icons.slots[id];
    assert.ok(slot, `icons.json lacks layer ${id}`);
    assert.ok(hasIcon(slot.iconName), `${id}: unregistered icon ${slot.iconName}`);
    assert.ok(existsSync(path.join(REPO_ROOT, slot.file)), `${id}: ${slot.file} missing`);
    assert.match(slot.sourceUrl, /^https:\/\/unpkg\.com\/lucide-static@1\.47\.0\/icons\/[a-z0-9-]+\.svg$/);
    assert.equal(slot.license, 'ISC');
    assert.match(slot.retrievedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  }
  // Every icon the source declares for a layer is the one icons.json points at.
  for (const file of uiSourceFiles()) {
    if (!/\.(?:js|mjs)$/.test(file)) continue;
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/id:\s*'([a-z0-9-]+)',[\s\S]{0,400}?\bicon:\s*'([a-z0-9-]+)'/g)) {
      const [, id, icon] = match;
      if (icons.slots[id]) assert.equal(icons.slots[id].iconName, icon, `${id} icon drifted from icons.json`);
    }
  }
  assert.ok(existsSync(path.join(REPO_ROOT, 'public/brand/icons/LICENSE-icons.md')));
});

test('iconMarkup is accessible by construction', () => {
  const decorative = iconMarkup('satellite');
  assert.match(decorative, /^<svg /);
  assert.match(decorative, /aria-hidden="true"/);
  assert.match(decorative, /focusable="false"/);
  assert.doesNotMatch(decorative, /<title>/);
  assert.match(
    decorative,
    new RegExp(`class="${ICON_CLASS} ${ICON_CLASS}--satellite"`),
  );
  const labelled = iconMarkup('circle', {
    label: 'Recording',
    className: 'od-icon--solid',
  });
  assert.match(labelled, /role="img"/);
  assert.match(labelled, /aria-label="Recording"/);
  assert.match(labelled, /<title>Recording<\/title>/);
  assert.match(labelled, /od-icon--solid/);
  assert.deepEqual(findForbiddenGlyphs(iconMarkup('layers')), []);
});

// ── Rendered DATA LAYERS panel ───────────────────────────────────────────────

class FakeNode {
  constructor(tagName, namespace = null) {
    this.tagName = tagName;
    this.namespace = namespace;
    this.childNodes = [];
    this.attributes = new Map();
    this.dataset = {};
    this.style = {};
    this.parentNode = null;
    this.nodeValue = null;
    this._className = '';
    this._hidden = false;
    const classes = () => new Set(this._className.split(/\s+/).filter(Boolean));
    this.classList = {
      toggle: (name, force) => {
        const set = classes();
        const on = force === undefined ? !set.has(name) : Boolean(force);
        if (on) set.add(name);
        else set.delete(name);
        this._className = [...set].join(' ');
        return on;
      },
      add: (...names) => {
        const set = classes();
        for (const name of names) set.add(name);
        this._className = [...set].join(' ');
      },
      contains: (name) => classes().has(name),
    };
  }
  get className() {
    return this._className;
  }
  set className(value) {
    this._className = String(value);
  }
  get hidden() {
    return this._hidden;
  }
  set hidden(value) {
    this._hidden = Boolean(value);
  }
  get children() {
    return this.childNodes.filter((node) => node instanceof FakeNode);
  }
  get firstChild() {
    return this.childNodes[0] || null;
  }
  appendChild(node) {
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }
  append(...nodes) {
    for (const node of nodes)
      this.appendChild(typeof node === 'string' ? new FakeText(node) : node);
  }
  insertBefore(node, reference) {
    const at = this.childNodes.indexOf(reference);
    if (at < 0) return this.appendChild(node);
    node.parentNode = this;
    this.childNodes.splice(at, 0, node);
    return node;
  }
  removeChild(node) {
    this.childNodes = this.childNodes.filter((child) => child !== node);
    node.parentNode = null;
    return node;
  }
  replaceChildren(...nodes) {
    for (const child of [...this.childNodes]) this.removeChild(child);
    for (const node of nodes) this.appendChild(node);
  }
  remove() {
    this.parentNode?.removeChild(this);
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }
  addEventListener() {}
  removeEventListener() {}
  get textContent() {
    return this.childNodes.map((node) => node.textContent).join('');
  }
  set textContent(value) {
    this.replaceChildren(new FakeText(String(value ?? '')));
  }
  set innerHTML(value) {
    // Only the icon registry writes markup here (into an <svg>); a container
    // is only ever cleared. Keep the markup as a text-free marker.
    this.replaceChildren();
    if (value) this._innerHTML = String(value);
  }
  get innerHTML() {
    return this._innerHTML || '';
  }
  matchesSelector(selector) {
    const byClass = /^\.([\w-]+)$/.exec(selector);
    if (byClass) return this.classList.contains(byClass[1]);
    const byData = /^\[data-([\w-]+)="([^"]*)"\]$/.exec(selector);
    if (byData) {
      const key = byData[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      return this.dataset[key] === byData[2];
    }
    return this.tagName === selector;
  }
  querySelectorAll(selector) {
    const found = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (child.matchesSelector(selector)) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

class FakeText {
  constructor(text) {
    this.nodeValue = text;
    this.parentNode = null;
  }
  get textContent() {
    return this.nodeValue;
  }
}

function fakeDocument() {
  return {
    hidden: false,
    createElement: (tag) => new FakeNode(tag),
    createElementNS: (namespace, tag) => new FakeNode(tag, namespace),
    createTextNode: (text) => new FakeText(text),
  };
}

function textNodes(node, out = []) {
  for (const child of node.childNodes) {
    if (child instanceof FakeText) out.push(child.nodeValue);
    else textNodes(child, out);
  }
  return out;
}

const MOVEMENT_LAYERS = [
  [
    'satellites',
    'Satellites',
    'satellite',
    'CelesTrak',
    { status: 'unavailable', error: 'CelesTrak unreachable' },
  ],
  [
    'flights',
    'Live Flights',
    'plane',
    'OpenSky',
    { count: 412, lastUpdate: Date.now(), providerStatus: 'live' },
  ],
  [
    'military',
    'Military Flights',
    'shield',
    'adsb.lol',
    { count: 9, lastUpdate: Date.now(), stale: true },
  ],
  [
    'ais-live-vessels',
    'Live Vessels',
    'ship',
    'AISStream',
    { status: 'degraded', providerError: 'demo replay' },
  ],
  [
    'traffic',
    'Street Traffic',
    'car',
    'TomTom',
    { count: 120, lastUpdate: Date.now() },
  ],
  ['transit', 'Transit', 'bus', 'MBTA', { count: 30, lastUpdate: Date.now() }],
  [
    'bikeshare',
    'Bike Share',
    'bike',
    'GBFS',
    { count: 44, lastUpdate: Date.now() },
  ],
];

async function renderPanel(layers) {
  const documentRef = fakeDocument();
  const previous = globalThis.document;
  globalThis.document = documentRef;
  try {
    const { LayerPanel } = await import('./ui/layerPanel.js');
    const panel = new LayerPanel({
      getLayers: () => layers,
      isEnabled: (id) => layers.find((layer) => layer.id === id)?.enabled,
      setEnabled: async () => {},
      setLayerParams: () => {},
      getRowControls: () => null,
      hasRowControls: () => false,
      subscribeRowControls: () => null,
    });
    const container = new FakeNode('div');
    panel.mount(container);
    return { panel, container };
  } finally {
    globalThis.document = previous;
  }
}

test('DATA LAYERS rows render an inline <svg> icon and no glyph text', async () => {
  const layers = MOVEMENT_LAYERS.map(([id, name, icon, source, stats]) => ({
    id,
    name,
    icon,
    source,
    enabled: true,
    showInTogglePanel: true,
    stats,
  }));
  const { container } = await renderPanel(layers);
  const rows = container.querySelectorAll('.data-toggle-row');
  assert.equal(rows.length, MOVEMENT_LAYERS.length);
  for (const [index, row] of rows.entries()) {
    const [id, , icon] = MOVEMENT_LAYERS[index];
    assert.equal(row.dataset.layerId, id);
    const slot = row.querySelector('.data-icon');
    assert.ok(slot, `${id}: icon slot`);
    const svg = slot.children.find((node) => node.tagName === 'svg');
    assert.ok(svg, `${id}: inline <svg>`);
    assert.equal(svg.namespace, 'http://www.w3.org/2000/svg');
    assert.equal(svg.getAttribute('data-icon'), icon);
    assert.equal(svg.getAttribute('stroke'), 'currentColor');
    assert.equal(svg.getAttribute('fill'), 'none');
    assert.equal(svg.getAttribute('stroke-width'), '1.75');
    assert.equal(
      svg.getAttribute('aria-hidden'),
      'true',
      'decorative beside the visible name',
    );
    assert.equal(
      textNodes(slot).join(''),
      '',
      'no glyph text in the icon slot',
    );
    assert.ok(
      row.dataset.feedState,
      `${id}: row carries its feed state for the icon colour`,
    );
  }
  // Status colour hooks: unavailable / live / stale / degraded rows are distinguishable.
  const state = Object.fromEntries(
    rows.map((row) => [row.dataset.layerId, row.dataset.feedState]),
  );
  assert.equal(state.satellites, 'unavailable');
  assert.equal(state.flights, 'nominal');
  assert.equal(state.military, 'stale');
  assert.equal(state['ais-live-vessels'], 'degraded');
  const glyphs = textNodes(container).flatMap((text) =>
    findForbiddenGlyphs(text),
  );
  assert.deepEqual(
    glyphs,
    [],
    'rendered DATA LAYERS text carries no emoji / glyphs',
  );
});

test('a legacy emoji icon value still renders an <svg>, never the glyph', async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const { container } = await renderPanel([
      {
        id: 'legacy',
        name: 'Legacy layer',
        icon: '\u{1F6F0}\uFE0F',
        source: 'test',
        enabled: false,
        showInTogglePanel: true,
        stats: {},
      },
    ]);
    const slot = container.querySelector('.data-icon');
    const svg = slot.children.find((node) => node.tagName === 'svg');
    assert.ok(svg, 'fallback icon rendered');
    assert.equal(svg.getAttribute('data-icon'), ICON_FALLBACK);
    assert.deepEqual(textNodes(slot), []);
    assert.equal(
      container.querySelector('.data-toggle-row').dataset.feedState,
      'off',
    );
    assert.ok(
      warnings.some((line) => line.includes('not a registered Lucide icon')),
    );
  } finally {
    console.warn = originalWarn;
  }
});

test('an icon chip (Directions SWAP) renders an inline <svg> with an accessible name, never a glyph', async () => {
  const documentRef = fakeDocument();
  const previous = globalThis.document;
  globalThis.document = documentRef;
  try {
    const { LayerPanel } = await import('./ui/layerPanel.js');
    const layers = [
      {
        id: 'directions',
        name: 'Directions',
        icon: 'compass',
        source: 'OSM routing',
        enabled: true,
        showInTogglePanel: true,
        stats: {},
      },
    ];
    const controls = {
      chips: [
        {
          id: 'swap',
          icon: 'move-horizontal',
          label: '',
          ariaLabel: 'Swap A and B',
          title: 'Swap A and B',
          state: 'idle',
        },
        { id: 'fly', label: 'FLY', state: 'idle' },
      ],
      legend: [],
    };
    const panel = new LayerPanel({
      getLayers: () => layers,
      isEnabled: () => true,
      setEnabled: async () => {},
      setLayerParams: () => {},
      getRowControls: () => controls,
      hasRowControls: () => true,
      subscribeRowControls: () => null,
    });
    const container = new FakeNode('div');
    panel.mount(container);
    panel.refresh?.();
    const chips = container.querySelectorAll('.data-toggle-chip');
    assert.ok(chips.length >= 2, `expected chips, found ${chips.length}`);
    const swap = chips.find((chip) => chip.dataset.chipId === 'swap');
    assert.ok(swap, 'swap chip rendered');
    const svg = swap.children.find((node) => node.tagName === 'svg');
    assert.ok(svg, 'swap chip renders an inline <svg>');
    assert.equal(svg.getAttribute('data-icon'), 'move-horizontal');
    assert.equal(svg.getAttribute('stroke-width'), ICON_STROKE_WIDTH);
    assert.equal(svg.getAttribute('aria-hidden'), 'true');
    assert.equal(swap.getAttribute('aria-label'), 'Swap A and B');
    assert.equal(swap.dataset.chipIcon, 'move-horizontal');
    assert.deepEqual(
      textNodes(swap).flatMap((text) => findForbiddenGlyphs(text)),
      [],
    );
    // A text chip is untouched by the icon path.
    const fly = chips.find((chip) => chip.dataset.chipId === 'fly');
    assert.equal(textNodes(fly).join(''), 'FLY');
    assert.ok(!fly.getAttribute('aria-label'), 'text chip has no aria-label');
  } finally {
    globalThis.document = previous;
  }
});

// ── Material Symbols ligature guard (docs/brand/ICON_SOURCE.md) ────────────
// `layers_clear` (top-centre "Clear selected data layers") migrated to the
// Lucide `layers-minus` icon on 2026-09-20. The cockpit/context/display/
// provider/welcome surfaces (plus a few JS/CSS files) still render Material
// Symbols; this pins their usage so it can only shrink as each surface
// migrates to Lucide, never grow, and so no new file starts using the font.

/**
 * Every Material Symbols ligature-font usage in `text`, one entry per
 * matching line: an HTML/SVG element whose `class` carries
 * `material-symbols-outlined`, `material-symbols` or `material-icons`
 * (captures the ligature name as its text content), a Google Fonts
 * `Material+Symbols` stylesheet link, an `@font-face` naming "Material
 * Symbols", or a bare reference to one of those class tokens (a CSS
 * selector, or a JS class string / `querySelector` argument).
 */
export function findMaterialSymbolsUsages(text) {
  const CLASS_TOKEN = /material-(?:symbols(?:-outlined)?|icons)/;
  const ELEMENT =
    /<([a-zA-Z][\w-]*)\b[^>]*\bclass="[^"]*\bmaterial-(?:symbols(?:-outlined)?|icons)\b[^"]*"[^>]*>([^<]*)/;
  const FONT_LINK = /fonts\.googleapis\.com\/css2\?family=Material\+Symbols/;
  const FONT_FACE_FAMILY = /Material\s*Symbols/;
  const hits = [];
  let inFontFace = false;
  text.split('\n').forEach((line, index) => {
    const lineNo = index + 1;
    if (/@font-face/.test(line)) inFontFace = true;
    if (inFontFace && FONT_FACE_FAMILY.test(line)) {
      hits.push({ line: lineNo, kind: 'font-face', detail: line.trim() });
      inFontFace = false;
      return;
    }
    if (line.includes('}')) inFontFace = false;
    const element = ELEMENT.exec(line);
    if (element) {
      const glyph = element[2].trim();
      hits.push({
        line: lineNo,
        kind: 'element',
        detail: glyph ? `<${element[1]}> "${glyph}"` : `<${element[1]}>`,
      });
      return;
    }
    if (FONT_LINK.test(line)) {
      hits.push({ line: lineNo, kind: 'font-link', detail: line.trim() });
      return;
    }
    if (CLASS_TOKEN.test(line))
      hits.push({ line: lineNo, kind: 'reference', detail: line.trim() });
  });
  return hits;
}

/**
 * file (repo-relative, POSIX separators) -> pinned Material Symbols usage
 * count, measured 2026-09-20 immediately after the clear-layers migration.
 * These are the not-yet-migrated cockpit/context/display/provider/welcome
 * surfaces (docs/brand/ICON_SOURCE.md). A count may only decrease as a
 * surface migrates to Lucide, never increase, and no file outside this list
 * may carry a usage at all.
 */
const MATERIAL_SYMBOLS_LEGACY_ALLOWLIST = Object.freeze({
  'index.html': 1,
  'src/celestialRing.js': 2,
  'src/ui/cockpitLayout.js': 2,
  'src/ui/cockpitSignals.js': 1,
  'src/ui/styles/layers.css': 4,
  'src/ui/styles/status.css': 1,
  'src/ui/styles/first-run.css': 1,
  'src/ui/styles/controls.css': 1,
  'src/ui/styles/cockpit.css': 8,
  'src/ui/styles/provider-settings.css': 2,
  'src/ui/templates/cockpit.html': 16,
  'src/ui/templates/scene-chrome.html': 3,
  'src/ui/templates/display-controls.html': 3,
  'src/ui/templates/context.html': 6,
  'src/ui/templates/welcome.html': 8,
  'src/ui/templates/provider-settings.html': 2,
});

test('findMaterialSymbolsUsages catches ligature markup, the font link and @font-face, and ignores Lucide SVGs', () => {
  const span = findMaterialSymbolsUsages(
    '<span class="material-symbols-outlined" aria-hidden="true">layers_clear</span>',
  );
  assert.equal(span.length, 1);
  assert.equal(span[0].kind, 'element');
  assert.match(span[0].detail, /layers_clear/);

  const link = findMaterialSymbolsUsages(
    '<link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20,400,0,0&icon_names=close" rel="stylesheet" />',
  );
  assert.equal(link.length, 1);
  assert.equal(link[0].kind, 'font-link');

  const fontFace = findMaterialSymbolsUsages(
    "@font-face {\n  font-family: 'Material Symbols Outlined';\n  src: url(fake.woff2);\n}\n",
  );
  assert.equal(fontFace.length, 1);
  assert.equal(fontFace[0].kind, 'font-face');

  const lucide = findMaterialSymbolsUsages(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" data-icon="layers-minus" class="od-icon od-icon--layers-minus" aria-hidden="true" focusable="false"><path d="M16 17h6"/></svg>',
  );
  assert.deepEqual(lucide, []);
});

test('Material Symbols usage is confined to the pinned legacy allowlist; layer-panels.html and layerPanel.js have none', () => {
  const strictlyZero = [
    'src/ui/templates/layer-panels.html',
    'src/ui/layerPanel.js',
  ];
  const counts = {};
  for (const file of uiSourceFiles()) {
    const relative = path.relative(REPO_ROOT, file).split(path.sep).join('/');
    const hits = findMaterialSymbolsUsages(readFileSync(file, 'utf8'));
    if (hits.length) counts[relative] = hits.length;
  }

  for (const file of strictlyZero)
    assert.equal(
      counts[file] || 0,
      0,
      `${file} must not use the Material Symbols ligature font`,
    );

  // The clear-layers control itself is migrated, even though scene-chrome.html
  // keeps 3 other, unrelated Material Symbols icons in the same nav (pinned
  // in the allowlist below, docs/brand/ICON_SOURCE.md).
  const sceneChrome = readFileSync(
    path.join(REPO_ROOT, 'src/ui/templates/scene-chrome.html'),
    'utf8',
  );
  assert.doesNotMatch(
    sceneChrome,
    /layers_clear/,
    'clear-layers must not use the layers_clear ligature',
  );
  assert.match(
    sceneChrome,
    /<svg[^>]*\bdata-icon="layers-minus"/,
    'clear-layers must render the inline layers-minus icon',
  );

  const unexpected = Object.keys(counts).filter(
    (file) => !(file in MATERIAL_SYMBOLS_LEGACY_ALLOWLIST),
  );
  assert.deepEqual(
    unexpected,
    [],
    `Material Symbols usage outside the pinned legacy allowlist (docs/brand/ICON_SOURCE.md): ${unexpected.join(', ')}`,
  );

  const regressed = Object.entries(counts)
    .filter(([file, count]) => count > (MATERIAL_SYMBOLS_LEGACY_ALLOWLIST[file] ?? 0))
    .map(
      ([file, count]) =>
        `${file}: ${count} > ${MATERIAL_SYMBOLS_LEGACY_ALLOWLIST[file]}`,
    );
  assert.deepEqual(
    regressed,
    [],
    'Material Symbols usage regressed above its pinned count',
  );
});

