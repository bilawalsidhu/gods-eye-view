import test from 'node:test';
import assert from 'node:assert/strict';

import {
  planSplitFlap,
  setSplitFlapText,
  visibleGlyphs,
  FLAP_CHAR_MS,
  FLAP_STAGGER_MS,
  FLAP_MAX_TOTAL_MS,
  FLAP_TURN_RATIO,
  SPLIT_FLAP_ENABLED,
} from './splitFlap.js';

const settledText = (plan) => plan.cells.map((cell) => cell.to).join('');
const flapping = (plan) => plan.cells.filter((cell) => cell.changed);

test('identical text plans no work at all — the tickers must not restart it', () => {
  const plan = planSplitFlap('LOAD COMPLETE', 'LOAD COMPLETE');
  assert.equal(plan.changedCount, 0);
  assert.equal(plan.cells.length, 0);
  assert.equal(plan.durationMs, 0);
  assert.equal(plan.firstChanged, -1);
});

test('a settled cell keeps its glyph and never animates', () => {
  // "LOAD" survives the transition, so those four cells hold still — the way
  // a real split-flap cell that already shows the right letter does not move.
  const plan = planSplitFlap('LOADING LIVE DATA', 'LOAD COMPLETE');
  const held = plan.cells.slice(0, 4);
  assert.deepEqual(held.map((cell) => cell.to), ['L', 'O', 'A', 'D']);
  assert.ok(held.every((cell) => cell.changed === false));
  assert.ok(held.every((cell) => cell.delayMs === 0));
  // "LOADING" still has its I where "LOAD COMPLETE" has a space, so column 4
  // is the first that has to move.
  assert.equal(plan.firstChanged, 4);
  assert.equal(plan.cells[4].delayMs, 0);
});

test('the concatenated cells are exactly the target string — DOM text stays the truth', () => {
  const cases = [
    ['LOADING LIVE DATA', 'LOAD COMPLETE'],
    ['loading frames', 'camera grid ready'],
    ['', 'LOAD FAILED'],
    ['TURNING OFF LIVE DATA', ''],
    ['LIVE · TomTom flow · 87% cov', 'SIMULATED — add TomTom key for live'],
  ];
  for (const [from, to] of cases) {
    assert.equal(settledText(planSplitFlap(from, to)), to, `${from} -> ${to}`);
  }
});

test('the cascade sweeps left to right, rebased on the first changed column', () => {
  const plan = planSplitFlap('AAAA', 'BBBB');
  assert.deepEqual(plan.cells.map((cell) => cell.delayMs), [
    0,
    FLAP_STAGGER_MS,
    FLAP_STAGGER_MS * 2,
    FLAP_STAGGER_MS * 3,
  ]);
  // Rebasing matters: a stable head must not idle through untouched columns.
  const rebased = planSplitFlap('LOAD XX', 'LOAD YY');
  assert.equal(rebased.firstChanged, 5);
  assert.equal(rebased.cells[5].delayMs, 0);
  assert.equal(rebased.cells[6].delayMs, FLAP_STAGGER_MS);
});

test('every real chip transition finishes well under a second', () => {
  const transitions = [
    ['LOADING LIVE DATA', 'LOAD COMPLETE'],
    ['LOADING LIVE DATA', 'LOAD FAILED'],
    ['REFRESHING LIVE DATA', 'LOAD CANCELLED'],
    ['TURNING OFF LIVE DATA', 'LIVE DATA OFF'],
    ['loading frames', 'camera grid ready'],
    ['syncing road network', 'LIVE · TomTom flow · 100% cov'],
    ['SIMULATED — traffic service unreachable', 'LIVE · TomTom flow · 42% cov'],
  ];
  for (const [from, to] of transitions) {
    const plan = planSplitFlap(from, to);
    assert.ok(
      plan.durationMs <= FLAP_MAX_TOTAL_MS,
      `${from} -> ${to} ran ${plan.durationMs}ms, over the ${FLAP_MAX_TOTAL_MS}ms budget`,
    );
    assert.ok(plan.durationMs > 0);
  }
});

test('long labels compress their stagger instead of running past the budget', () => {
  const long = planSplitFlap('x'.repeat(80), 'y'.repeat(80));
  assert.ok(long.durationMs <= FLAP_MAX_TOTAL_MS);
  assert.ok(long.staggerMs < FLAP_STAGGER_MS, 'stagger should compress');
  // Still a cascade, not a single simultaneous snap.
  assert.ok(long.staggerMs > 0);
  assert.ok(long.cells.at(-1).delayMs > long.cells[0].delayMs);
});

test('a short label keeps the full, unhurried stagger', () => {
  const plan = planSplitFlap('AB', 'CD');
  assert.equal(plan.staggerMs, FLAP_STAGGER_MS);
  assert.equal(plan.durationMs, FLAP_STAGGER_MS + FLAP_CHAR_MS);
});

test('a single changed character has no stagger and takes exactly one char time', () => {
  const plan = planSplitFlap('LOAD COMPLETE', 'LOAD COMPLETEX');
  assert.equal(plan.changedCount, 1);
  assert.equal(plan.staggerMs, 0);
  assert.equal(plan.durationMs, FLAP_CHAR_MS);
});

test('a shrinking label marks its surplus columns vacating', () => {
  const plan = planSplitFlap('TURNING OFF LIVE DATA', 'LIVE DATA OFF');
  const vacating = plan.cells.filter((cell) => cell.vacating);
  assert.equal(vacating.length, 'TURNING OFF LIVE DATA'.length - 'LIVE DATA OFF'.length);
  // Vacating cells carry an outgoing glyph but contribute nothing to the text;
  // their width is zero, and the container width transition covers the shrink.
  assert.ok(vacating.every((cell) => cell.to === '' && cell.from !== ''));
  assert.equal(settledText(plan), 'LIVE DATA OFF');
});

test('a growing label flaps its new columns in with no outgoing glyph', () => {
  const plan = planSplitFlap('LOAD', 'LOAD COMPLETE');
  const grown = plan.cells.slice(4);
  assert.ok(grown.every((cell) => cell.from === '' && cell.changed));
  assert.ok(grown.every((cell) => cell.vacating === false));
  assert.equal(settledText(plan), 'LOAD COMPLETE');
});

test('cell width covers the longer of the two strings', () => {
  assert.equal(planSplitFlap('ABC', 'AB').cells.length, 3);
  assert.equal(planSplitFlap('AB', 'ABC').cells.length, 3);
});

test('multi-byte separators stay one cell, never split into surrogate halves', () => {
  const plan = planSplitFlap('A · B', 'A · C');
  assert.ok(plan.cells.every((cell) => Array.from(cell.to).length <= 1));
  assert.equal(settledText(plan), 'A · C');
  // An astral character must occupy exactly one flap cell.
  const astral = planSplitFlap('', '\u{1F6EB}');
  assert.equal(astral.cells.length, 1);
  assert.equal(astral.cells[0].to, '\u{1F6EB}');
});

test('null and undefined are treated as empty, never stringified into the chip', () => {
  assert.equal(settledText(planSplitFlap(null, 'READY')), 'READY');
  assert.equal(planSplitFlap(undefined, undefined).changedCount, 0);
  assert.equal(settledText(planSplitFlap('READY', null)), '');
});

test('option overrides drive both the stagger and the budget', () => {
  const plan = planSplitFlap('AAAA', 'BBBB', { charMs: 100, staggerMs: 10, maxTotalMs: 1000 });
  assert.deepEqual(plan.cells.map((cell) => cell.delayMs), [0, 10, 20, 30]);
  assert.equal(plan.durationMs, 130);
  // Invalid overrides fall back to the defaults rather than producing NaN.
  const guarded = planSplitFlap('AB', 'CD', { charMs: 0, staggerMs: -5, maxTotalMs: Number.NaN });
  assert.equal(guarded.durationMs, FLAP_STAGGER_MS + FLAP_CHAR_MS);
});

test('delays are whole milliseconds so the CSS custom property stays clean', () => {
  const plan = planSplitFlap('x'.repeat(37), 'y'.repeat(37));
  assert.ok(plan.cells.every((cell) => Number.isInteger(cell.delayMs)));
  assert.ok(Number.isInteger(plan.durationMs));
});

test('no cell is ever scheduled to start after the cascade has ended', () => {
  const plan = planSplitFlap('syncing road network', 'LIVE · TomTom flow · 100% cov');
  for (const cell of flapping(plan)) {
    assert.ok(
      cell.delayMs + FLAP_CHAR_MS <= plan.durationMs + 1,
      `cell ${cell.index} lands after the reported duration`,
    );
  }
});

test('the feature ships enabled behind a single flippable constant', () => {
  assert.equal(typeof SPLIT_FLAP_ENABLED, 'boolean');
  assert.equal(SPLIT_FLAP_ENABLED, true);
});

// ── Interrupted cascades: only what was visible may flap away ──────────────

test('at the start of a cascade the board still reads the old label', () => {
  const plan = planSplitFlap('LOADING LIVE DATA', 'LOAD COMPLETE');
  assert.equal(visibleGlyphs(plan, 0), 'LOADING LIVE DATA');
});

test('once the cascade is over the board reads the new label', () => {
  const plan = planSplitFlap('LOADING LIVE DATA', 'LOAD COMPLETE');
  const landed = visibleGlyphs(plan, plan.durationMs + 1000);
  // The cleared columns are still ON the board as blanks until settlement
  // strips them — that is what stops columns renumbering mid-flight.
  assert.equal(landed.trimEnd(), 'LOAD COMPLETE');
  assert.equal(landed.length, 'LOADING LIVE DATA'.length);
});

test('a column turns over at its own delay, not the cascade start', () => {
  const plan = planSplitFlap('AAAA', 'BBBB');
  const turn = FLAP_CHAR_MS * FLAP_TURN_RATIO;
  // Just after column 0 turns, only column 0 has changed.
  assert.equal(visibleGlyphs(plan, turn + 1), 'BAAA');
  // Just after column 2's delay + turn, three columns have.
  assert.equal(visibleGlyphs(plan, FLAP_STAGGER_MS * 2 + turn + 1), 'BBBA');
});

test('an interrupted cascade never flaps away a glyph that was never on screen', () => {
  // A -> B interrupted mid-stagger by C. This is the ghost-glyph pin.
  const A = 'LOADING LIVE DATA';
  const B = 'LOAD COMPLETE';
  const C = 'LOAD FAILED';
  const first = planSplitFlap(A, B);
  const interruptAt = 150; // mid-stagger: some columns turned, others have not

  const displayed = visibleGlyphs(first, interruptAt);
  const aChars = Array.from(A);
  const bChars = Array.from(B);
  const shown = Array.from(displayed);

  // Every visible glyph is either the old label's or the new one's, per column.
  // A column the new label does not reach reads as a reserved blank.
  shown.forEach((glyph, index) => {
    const candidates = [aChars[index] || ' ', bChars[index] || ' '];
    assert.ok(
      candidates.includes(glyph),
      `column ${index} shows ${JSON.stringify(glyph)}, which is neither `
        + `${JSON.stringify(candidates[0])} nor ${JSON.stringify(candidates[1])}`,
    );
  });

  // The interrupting cascade flaps away exactly those visible glyphs.
  const second = planSplitFlap(displayed, C);
  second.cells.forEach((cell) => {
    assert.equal(
      cell.from,
      shown[cell.index] ?? '',
      `column ${cell.index} would flap away a glyph that was not on screen`,
    );
  });

  // And this genuinely differs from the naive "flap away the pending target"
  // approach — otherwise the pin would pass without the fix.
  const naive = planSplitFlap(B, C);
  const naiveFrom = naive.cells.map((cell) => cell.from).join('');
  const honestFrom = second.cells.map((cell) => cell.from).join('');
  assert.notEqual(honestFrom, naiveFrom);
  assert.equal(honestFrom, displayed);
});

test('interrupting before anything turned flaps away the ORIGINAL label', () => {
  const first = planSplitFlap('LOADING LIVE DATA', 'LOAD COMPLETE');
  // Nothing has reached its turn point yet.
  const displayed = visibleGlyphs(first, 0);
  const second = planSplitFlap(displayed, 'LOAD FAILED');
  assert.equal(second.cells.map((cell) => cell.from).join(''), 'LOADING LIVE DATA');
});

test('interrupting after the cascade landed flaps away the settled label', () => {
  const first = planSplitFlap('LOADING LIVE DATA', 'LOAD COMPLETE');
  const displayed = visibleGlyphs(first, 10_000);
  assert.equal(displayed.trimEnd(), 'LOAD COMPLETE');
  const second = planSplitFlap(displayed, 'LOAD FAILED');
  assert.equal(second.cells.map((cell) => cell.from).join(''), displayed);
});

test('a shrinking cascade shows its surplus glyphs until each column turns', () => {
  const plan = planSplitFlap('TURNING OFF LIVE DATA', 'LIVE DATA OFF');
  assert.equal(visibleGlyphs(plan, 0), 'TURNING OFF LIVE DATA');
  // Mid-cascade the tail columns still carry the old glyphs.
  assert.ok(visibleGlyphs(plan, 120).trimEnd().length > 'LIVE DATA OFF'.length);
  assert.equal(visibleGlyphs(plan, plan.durationMs + 100).trimEnd(), 'LIVE DATA OFF');
});

// ── Positional truth: columns never renumber mid-cascade ──────────────────

test('a cleared column holds its place instead of letting later glyphs slide left', () => {
  // The revert-proof pin. If a cleared column collapsed to nothing, this
  // sampling would catch "ABCD" -> "ABD" and D sitting in column 2.
  const plan = planSplitFlap('ABCD', 'AB');
  const samples = [];
  for (let t = 0; t <= plan.durationMs + 50; t += 5) samples.push(visibleGlyphs(plan, t));

  for (const sample of samples) {
    const columns = Array.from(sample);
    assert.equal(
      columns.length,
      plan.cells.length,
      `board width changed mid-cascade: ${JSON.stringify(sample)}`,
    );
    assert.notEqual(columns[2], 'D', `D slid into column 2: ${JSON.stringify(sample)}`);
    if (columns.includes('D')) {
      assert.equal(columns[3], 'D', `D left column 3: ${JSON.stringify(sample)}`);
    }
    if (columns.includes('C')) {
      assert.equal(columns[2], 'C', `C left column 2: ${JSON.stringify(sample)}`);
    }
  }

  assert.equal(samples[0], 'ABCD');
  assert.equal(samples.at(-1), 'AB  ');
});

test('every column keeps its index for the whole cascade, growing or shrinking', () => {
  for (const [from, to] of [
    ['LOADING LIVE DATA', 'LOAD COMPLETE'],
    ['LOAD', 'LOAD COMPLETE'],
    ['TURNING OFF LIVE DATA', 'LIVE DATA OFF'],
    ['', 'LOAD FAILED'],
  ]) {
    const plan = planSplitFlap(from, to);
    const widths = new Set();
    for (let t = 0; t <= plan.durationMs + 50; t += 7) {
      widths.add(Array.from(visibleGlyphs(plan, t)).length);
    }
    assert.deepEqual(
      [...widths],
      [plan.cells.length],
      `${from} -> ${to} changed column count mid-cascade`,
    );
  }
});

test('an interrupt mid-shrink flaps away the blanks and glyphs actually on screen', () => {
  const first = planSplitFlap('ABCD', 'AB');
  const turn = FLAP_CHAR_MS * FLAP_TURN_RATIO;
  // Sample after column 2 turns to a blank but before column 3 turns.
  const at = first.cells[2].delayMs + turn + 1;
  assert.ok(at < first.cells[3].delayMs + turn, 'sample must sit between the two turns');
  const displayed = visibleGlyphs(first, at);
  assert.equal(displayed, 'AB D');
  const second = planSplitFlap(displayed, 'ABXY');
  assert.equal(second.cells[2].from, ' ');
  assert.equal(second.cells[3].from, 'D');
});

test('visibleGlyphs is defensive about junk input', () => {
  assert.equal(visibleGlyphs(null, 100), '');
  assert.equal(visibleGlyphs({ cells: [] }, 100), '');
  const plan = planSplitFlap('AB', 'CD');
  // Negative and non-finite elapsed times read as "nothing has turned yet".
  assert.equal(visibleGlyphs(plan, -500), 'AB');
  assert.equal(visibleGlyphs(plan, Number.NaN), 'AB');
});

// ── DOM runtime: setSplitFlapText against a minimal fake DOM ───────────────

/** Long-lived characterData node — the "truth" of invariant 1. */
class FakeTextNode {
  constructor(data) {
    this.nodeType = 3;
    this.data = data;
    this.parentNode = null;
  }
}

class FakeClassList {
  constructor() { this.set = new Set(); }
  add(...names) { for (const name of names) this.set.add(name); }
  remove(...names) { for (const name of names) this.set.delete(name); }
  contains(name) { return this.set.has(name); }
}

class FakeStyle {
  setProperty(name, value) { this[name] = value; }
  removeProperty(name) { const value = this[name]; delete this[name]; return value === undefined ? null : value; }
}

/**
 * The slice of HTMLElement the runtime touches: a stable child list with
 * sibling/first-child getters, classList/style/dataset, textContent derived
 * from real child nodes, and a width oracle driven by a queue of reads so a
 * test can script grow/shrink measurements per call.
 */
class FakeElement {
  constructor(tag = 'span') {
    this.nodeType = 1;
    this.tagName = tag;
    this.ownerDocument = null;
    this.parentNode = null;
    this.children = [];
    this.classList = new FakeClassList();
    this.style = new FakeStyle();
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.isConnected = true;
    this.widthReads = [];
    this.clientRects = null;
  }

  // The runtime sets className directly; route it through classList so the
  // two views (CSS class string / contains()) can never disagree.
  get className() { return [...this.classList.set].join(' '); }
  set className(value) { this.classList.set = new Set(String(value).split(/\s+/).filter(Boolean)); }

  get firstChild() { return this.children[0] ?? null; }
  get firstElementChild() { return this.children.find((c) => c.nodeType === 1) ?? null; }
  get nextElementSibling() {
    if (!this.parentNode) return null;
    const siblings = this.parentNode.children;
    return siblings.slice(siblings.indexOf(this) + 1).find((c) => c.nodeType === 1) ?? null;
  }
  get parentElement() { return this.parentNode?.nodeType === 1 ? this.parentNode : null; }
  get textContent() {
    return this.children.map((c) => (c.nodeType === 3 ? c.data : c.textContent)).join('');
  }

  append(node) { node.parentNode = this; this.children.push(node); }
  replaceChildren(...nodes) {
    for (const node of this.children) node.parentNode = null;
    this.children = nodes;
    for (const node of nodes) node.parentNode = this;
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener(type, fn) {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  removeEventListener(type, fn) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== fn));
  }
  /** Invoke registered listeners directly — the fake has no event loop. */
  emit(type, event) { for (const fn of this.listeners.get(type) ?? []) fn(event); }
  getBoundingClientRect() {
    return { width: this.widthReads.length > 0 ? this.widthReads.shift() : 0, height: 20 };
  }
  getClientRects() { return this.clientRects; }
}

function makeDoc() {
  return {
    createElement: (tag) => new FakeElement(tag),
    createTextNode: (data) => new FakeTextNode(data),
  };
}

/** A chip label element attached to a fake document, ready for the runtime. */
function makeChip() {
  const element = new FakeElement('span');
  element.ownerDocument = makeDoc();
  return element;
}

test('setSplitFlapText with no element is a safe false', () => {
  assert.equal(setSplitFlapText(null, 'X'), false);
});

test('the first write upgrades the label to its permanent shell, in place', () => {
  const element = makeChip();
  assert.equal(setSplitFlapText(element, 'LOADING', { immediate: true }), false);

  const text = element.firstElementChild;
  assert.ok(text.classList.contains('gev-flap-text'), 'text span class');
  assert.equal(text.firstChild.nodeType, 3, 'one long-lived Text node');
  assert.equal(text.firstChild.data, 'LOADING');
  const cells = text.nextElementSibling;
  assert.ok(cells.classList.contains('gev-flap-cells'), 'cells sibling class');
  assert.equal(cells.getAttribute('aria-hidden'), 'true', 'cells are decorative');
  assert.ok(element.classList.contains('gev-flap-host'));
  assert.equal(element.textContent, 'LOADING');

  // The repeating tickers must be a no-op on an unchanged label — and must
  // not rebuild the shell (same Text node object stays).
  assert.equal(setSplitFlapText(element, 'LOADING', { immediate: true }), false);
  assert.equal(element.firstElementChild.firstChild, text.firstChild);
});

test('a hidden element still gets the true text but never flaps', () => {
  const element = makeChip();
  setSplitFlapText(element, 'OLD', { immediate: true });
  element.checkVisibility = () => false;
  assert.equal(setSplitFlapText(element, 'NEW'), false, 'invisible: no flap');
  assert.equal(element.textContent, 'NEW', 'text is the truth regardless');
  assert.equal(element.firstElementChild.nextElementSibling.children.length, 0);
});

test('prefers-reduced-motion collapses the animation, not the write', () => {
  const savedWindow = globalThis.window;
  globalThis.window = { matchMedia: () => ({ matches: true }) };
  try {
    const element = makeChip();
    assert.equal(setSplitFlapText(element, 'A', { immediate: true }), false);
    assert.equal(setSplitFlapText(element, 'B'), false, 'reduced motion: no flap');
    assert.equal(element.textContent, 'B');
  } finally {
    globalThis.window = savedWindow;
  }
});

test('the checkVisibility fallback walks ancestors by hand', () => {
  // No checkVisibility and no client rects: off-screen, never animate.
  const detached = makeChip();
  detached.clientRects = [];
  setSplitFlapText(detached, 'OLD', { immediate: true });
  assert.equal(setSplitFlapText(detached, 'NEW'), false);

  // Client rects exist but an ancestor is visibility:hidden (clean-UI mode).
  const hidden = makeChip();
  hidden.clientRects = [{}];
  setSplitFlapText(hidden, 'OLD', { immediate: true });
  hidden.ownerDocument = {
    defaultView: { getComputedStyle: () => ({ visibility: 'hidden', display: 'block', opacity: '1' }) },
  };
  assert.equal(setSplitFlapText(hidden, 'NEW'), false, 'ancestor-hidden: no flap');

  // All ancestors visible: the fallback approves the animation.
  const visible = makeChip();
  visible.clientRects = [{}];
  setSplitFlapText(visible, 'AB', { immediate: true });
  const docs = visible.ownerDocument;
  visible.ownerDocument = {
    createElement: (tag) => docs.createElement(tag),
    createTextNode: (data) => docs.createTextNode(data),
    defaultView: { getComputedStyle: () => ({ visibility: 'visible', display: 'block', opacity: '1' }) },
  };
  assert.equal(setSplitFlapText(visible, 'CD'), true, 'fallback-visible: flap runs');
  const cellNodes = visible.firstElementChild.nextElementSibling.children;
  assert.equal(cellNodes.length, 2);
  assert.equal(cellNodes[0].dataset.flapPrev, 'A');
  assert.equal(cellNodes[1].dataset.flapNext, 'D');
});

test('a visible flap builds honest cells, eases width, and settles on one timer', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const element = makeChip();
  element.checkVisibility = () => true;
  setSplitFlapText(element, 'LOAD', { immediate: true });
  // Width reads, in call order: before-change 40, cascade reserve 60, then
  // settle's cascade/natural reads at 60 (already eased to natural by then).
  element.widthReads = [40, 60, 60, 60];

  assert.equal(setSplitFlapText(element, 'LOADX'), true);
  assert.equal(element.firstElementChild.firstChild.data, 'LOADX', 'one characterData write');

  const cellNodes = element.firstElementChild.nextElementSibling.children;
  assert.equal(cellNodes.length, 5, 'one column per character of the longer string');
  assert.ok(!cellNodes[0].classList.contains('is-flapping'), 'held columns do not animate');
  assert.equal(cellNodes[0].dataset.flapNext, 'L');
  assert.ok(cellNodes[4].classList.contains('is-flapping'));
  assert.equal(cellNodes[4].dataset.flapPrev, ' ', 'a new column flaps in from a blank');
  assert.equal(cellNodes[4].dataset.flapNext, 'X');
  assert.equal(cellNodes[4].style['--gev-flap-delay'], '0ms');
  assert.ok(element.classList.contains('gev-flap-active'), 'chip marked active during the cascade');
  assert.equal(element.style['--gev-flap-dur'], `${FLAP_CHAR_MS}ms`);

  // The grow ease reserved the new column: pinned at the target width under
  // the sizing class.
  assert.ok(element.classList.contains('gev-flap-sizing'));
  assert.equal(element.style.width, '60px');
  assert.equal(element.style['--gev-flap-total'], `${FLAP_CHAR_MS}ms`);

  // An unrelated transitionend must NOT tear the ease down…
  element.emit('transitionend', { target: {}, propertyName: 'width' });
  assert.equal(element.style.width, '60px', 'foreign event ignored');
  // …but the real one ends it: listeners gone, sizing cleared, no timer added.
  element.emit('transitionend', { target: element, propertyName: 'width' });
  assert.ok(!element.classList.contains('gev-flap-sizing'), 'ease finished cleanly');
  assert.equal(element.style.width, undefined);

  // The one settle timer lands, strips the cells, and rests the chip.
  t.mock.timers.tick(FLAP_CHAR_MS + 60);
  assert.equal(element.firstElementChild.nextElementSibling.children.length, 0, 'cells stripped');
  assert.ok(!element.classList.contains('gev-flap-active'), 'resting state restored');
  assert.equal(element.style['--gev-flap-dur'], undefined);
  assert.equal(element.textContent, 'LOADX', 'settled text survives the strip');
});

test('an interrupt mid-cascade flaps away the glyphs actually on screen', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const element = makeChip();
  element.checkVisibility = () => true;

  assert.equal(setSplitFlapText(element, 'AAAAA'), true);
  // Interrupt before ANY column has turned (no timer ticks). The first
  // cascade grew from an empty chip, so what is actually on screen is the
  // reserved blanks — not the pending A's — and that is what the interrupt
  // must flap away (invariant 3).
  assert.equal(setSplitFlapText(element, 'BBBBB'), true);
  assert.equal(element.textContent, 'BBBBB');
  const cellNodes = element.firstElementChild.nextElementSibling.children;
  assert.equal(cellNodes[0].dataset.flapPrev, ' ', 'outgoing glyph is what was shown: a blank');
  assert.equal(cellNodes[0].dataset.flapNext, 'B');

  // The superseded cascade's settle timer was cancelled; only the new one
  // fires, and it settles on the interrupting text.
  t.mock.timers.tick(4 * FLAP_STAGGER_MS + FLAP_CHAR_MS + 60);
  assert.equal(element.firstElementChild.nextElementSibling.children.length, 0);
  assert.equal(element.textContent, 'BBBBB');
});

test('a shrinking board takes up its width slack only after the flaps land', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const element = makeChip();
  element.checkVisibility = () => true;
  setSplitFlapText(element, 'ABCD', { immediate: true });
  // Reads: before 60 (natural width now), cascade 60 (no grow ease), then at
  // settle the board is measured wide (100, columns held) and settles to 60.
  element.widthReads = [60, 60, 100, 60];

  assert.equal(setSplitFlapText(element, 'AB'), true);
  assert.ok(!element.classList.contains('gev-flap-sizing'), 'shrink holds width during the cascade');
  assert.equal(element.style.width, undefined);

  t.mock.timers.tick(FLAP_STAGGER_MS + FLAP_CHAR_MS + 60);
  assert.ok(element.classList.contains('gev-flap-sizing'), 'slack ease starts after landing');
  assert.equal(element.style.width, '60px');

  element.emit('transitionend', { target: element, propertyName: 'width' });
  assert.ok(!element.classList.contains('gev-flap-sizing'), 'and ends cleanly');
  assert.equal(element.textContent, 'AB');
});

test('a clobbered label is rebuilt from its current text, not the old one', () => {
  const element = makeChip();
  setSplitFlapText(element, 'FIRST', { immediate: true });

  // Something outside this module replaced the shell with junk.
  const junk = element.ownerDocument.createElement('div');
  junk.append(element.ownerDocument.createTextNode('JUNK'));
  element.replaceChildren(junk);
  assert.equal(element.textContent, 'JUNK');

  setSplitFlapText(element, 'SECOND', { immediate: true });
  assert.equal(element.textContent, 'SECOND', 'carried text replaced by the write');
  assert.ok(element.firstElementChild.classList.contains('gev-flap-text'), 'shell rebuilt');
  assert.equal(element.firstElementChild.firstChild.data, 'SECOND');
  assert.ok(element.firstElementChild.nextElementSibling.classList.contains('gev-flap-cells'));
});
