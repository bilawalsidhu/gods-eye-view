import assert from 'node:assert/strict';
import test from 'node:test';
import { bindWeatherControls } from './weatherControls.js';
import {
  FIELD,
  OVERLAY,
  drapedSelection,
  WEATHER_LAYER_SPECS,
  defaultActiveCodes,
} from '../layers/weather/policy.js';

/** A DOM node with just enough surface for the panel to build and paint. */
function node(tag = 'div') {
  const classes = new Set();
  const attributes = new Map();
  const listeners = new Map();
  const self = {
    tagName: tag,
    children: [],
    dataset: {},
    disabled: false,
    hidden: false,
    textContent: '',
    title: '',
    value: '',
    options: [],
    classList: {
      add: (...v) => v.forEach((c) => classes.add(c)),
      remove: (...v) => v.forEach((c) => classes.delete(c)),
      contains: (c) => classes.has(c),
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
    },
    setAttribute: (name, value) => attributes.set(name, String(value)),
    getAttribute: (name) => attributes.get(name) ?? null,
    appendChild(child) {
      this.children.push(child);
      if (tag === 'select') this.options.push(child);
      return child;
    },
    addEventListener: (type, handler) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
    },
    removeEventListener: (type, handler) =>
      listeners.get(type)?.delete(handler),
    dispatch(type, event = {}) {
      for (const handler of listeners.get(type) ?? []) handler(event);
    },
    listenerCount: (type) => listeners.get(type)?.size ?? 0,
    querySelector(selector) {
      if (selector !== '.weather-chip-label') return null;
      return this.children.find((c) => c.className === 'weather-chip-label');
    },
  };
  return self;
}

/** Every option button the panel rendered, keyed by its visible label. */
function optionsByLabel(container) {
  const map = new Map();
  for (const button of container.children) {
    map.set(button.querySelector('.weather-chip-label')?.textContent, button);
  }
  return map;
}

/** Click as the panel's delegated handler sees it. */
const clickOn = (container, button) =>
  container.dispatch('click', { target: { closest: () => button } });

function harness() {
  const prior = globalThis.document;
  globalThis.document = {
    createElement: (tag) => {
      const el = node(tag);
      Object.defineProperty(el, 'className', {
        writable: true,
        value: '',
        enumerable: true,
      });
      return el;
    },
  };
  const elements = {
    overlays: node(),
    fields: node(),
    refresh: node('button'),
    auto: node('button'),
    interval: node('select'),
    budget: node('p'),
    unavailable: node('p'),
  };
  const calls = [];
  const control = bindWeatherControls({
    elements,
    actions: {
      setLayers: (layers) => calls.push(['layers', layers]),
      setAuto: (auto) => calls.push(['auto', auto]),
      setInterval: (every) => calls.push(['interval', every]),
      refreshNow: () => calls.push(['refresh']),
    },
  });
  return {
    elements,
    calls,
    control,
    restore: () => {
      control.destroy();
      globalThis.document = prior;
    },
  };
}

test('the panel renders every offered layer, grouped', () => {
  const h = harness();
  try {
    const overlays = WEATHER_LAYER_SPECS.filter((s) => s.group === OVERLAY);
    const fields = WEATHER_LAYER_SPECS.filter((s) => s.group === FIELD);
    assert.equal(h.elements.overlays.children.length, overlays.length);
    assert.equal(h.elements.fields.children.length, fields.length);

    // Fields are single-select, so they are a radio group; overlays are not.
    assert.equal(h.elements.fields.children[0].getAttribute('role'), 'radio');
    assert.equal(h.elements.overlays.children[0].getAttribute('role'), null);
    assert.equal(
      h.elements.overlays.children[0].getAttribute('aria-pressed'),
      'false',
    );
  } finally {
    h.restore();
  }
});

test('a layer that does not cover the whole globe says so', () => {
  // Otherwise "switched on and drawing nothing over Europe" looks like a fault
  // rather than the coverage it is.
  const h = harness();
  try {
    // Coverage and forecast markers only; every row also carries a hidden
    // "not drawing in 3D" marker, which is a different kind of fact.
    const isCoverageTag = (child) =>
      child.className?.includes('weather-chip-tag') &&
      !child.className.includes('weather-chip-held');
    const tagged = h.elements.overlays.children.filter((button) =>
      button.children.some(isCoverageTag),
    );
    const expected = WEATHER_LAYER_SPECS.filter(
      (s) => s.group === OVERLAY && (s.coverage || s.forecast),
    );
    assert.equal(tagged.length, expected.length);
    assert.ok(expected.length > 0, 'the fixture needs at least one tagged row');

    // Each row carries its own coverage, not one blanket marker: the panel
    // offers both United States and North America layers and they are not
    // interchangeable.
    const distinct = new Set(
      expected.filter((s) => s.coverage).map((s) => s.coverage.tag),
    );
    assert.ok(distinct.size > 1, 'the fixture needs more than one coverage');
    for (const spec of expected) {
      if (!spec.coverage) continue;
      const button = h.elements.overlays.children.find(
        (b) => b.dataset.layerCode === spec.code,
      );
      const tags = button.children
        .filter(isCoverageTag)
        .map((c) => c.textContent);
      assert.ok(
        tags.includes(spec.coverage.tag),
        `${spec.label} must be marked ${spec.coverage.tag}`,
      );
      // The chip has room for an abbreviation; the hover text is where that
      // abbreviation is spelled out, so it has to actually be there.
      assert.ok(
        button.title.includes(spec.coverage.note),
        `${spec.label} must explain ${spec.coverage.tag} on hover`,
      );
    }
  } finally {
    h.restore();
  }
});

test('every row explains itself in a sentence a person would write', () => {
  // The hover text is assembled from catalogue fields rather than written per
  // layer, so the fields have to be phrases that compose. A cadence is
  // whatever follows "Updates": an interval brings its own "every", a named
  // rhythm stands alone, and neither is capitalised mid-sentence.
  const CADENCE = /^(every \d+(-\d+)? (min|hr)|as issued|hourly|daily|weekly)$/;
  const h = harness();
  try {
    const rows = [
      ...h.elements.overlays.children,
      ...h.elements.fields.children,
    ];
    assert.equal(rows.length, WEATHER_LAYER_SPECS.length);

    for (const spec of WEATHER_LAYER_SPECS) {
      assert.match(
        spec.cadence,
        CADENCE,
        `${spec.label} would read "Updates ${spec.cadence}"`,
      );
      const button = rows.find((b) => b.dataset.layerCode === spec.code);
      // Rendered verbatim: anything the panel splices in around the phrase is
      // a second grammar to keep in step with the first.
      assert.ok(
        button.title.includes(`Updates ${spec.cadence}`),
        `${spec.label} hover text: "${button.title}"`,
      );
      assert.ok(button.title.startsWith(spec.detail), spec.label);
      assert.doesNotMatch(button.title, /\s{2,}|·\s*·|·\s*$/, spec.label);
    }
  } finally {
    h.restore();
  }
});

test('the default selection is painted before any params arrive', () => {
  // The panel can be built before the layer is registered; showing everything
  // off would misreport what the globe is actually drawing.
  const h = harness();
  try {
    h.control.sync({}, null);
    const active = [...h.elements.overlays.children].filter((b) =>
      b.classList.contains('active'),
    );
    assert.equal(active.length, defaultActiveCodes().length);
  } finally {
    h.restore();
  }
});

test('overlays accumulate and fields replace one another', () => {
  const h = harness();
  try {
    const radar = WEATHER_LAYER_SPECS.find((s) => s.defaultOn);
    const overlay = WEATHER_LAYER_SPECS.find(
      (s) => s.group === OVERLAY && !s.defaultOn,
    );
    const [fieldA, fieldB] = WEATHER_LAYER_SPECS.filter(
      (s) => s.group === FIELD,
    );

    h.control.sync({ layers: radar.code }, null);
    const overlayButtons = optionsByLabel(h.elements.overlays);
    const fieldButtons = optionsByLabel(h.elements.fields);

    clickOn(h.elements.overlays, overlayButtons.get(overlay.label));
    assert.deepEqual(h.calls.at(-1), ['layers', radar.code + overlay.code]);

    // Picking a field adds it to whatever overlays are on.
    h.control.sync({ layers: radar.code + overlay.code }, null);
    clickOn(h.elements.fields, fieldButtons.get(fieldA.label));
    assert.equal(h.calls.at(-1)[1].includes(fieldA.code), true);

    // Picking a second field replaces the first rather than stacking: fields
    // are opaque, so two would bill for one visible layer.
    h.control.sync({ layers: radar.code + fieldA.code }, null);
    clickOn(h.elements.fields, fieldButtons.get(fieldB.label));
    const next = h.calls.at(-1)[1];
    assert.equal(next.includes(fieldB.code), true);
    assert.equal(next.includes(fieldA.code), false);

    // Clicking the active field again clears it, so "no field" stays reachable.
    h.control.sync({ layers: radar.code + fieldB.code }, null);
    clickOn(h.elements.fields, fieldButtons.get(fieldB.label));
    assert.equal(h.calls.at(-1)[1].includes(fieldB.code), false);
  } finally {
    h.restore();
  }
});

test('a row that cannot draw in 3D says so, and only that row', () => {
  // The drape budget is much smaller than the globe's, so some selected rows
  // are on but not on screen. Saying nothing would make them indistinguishable
  // from the ones that are drawing.
  const h = harness();
  try {
    const field = WEATHER_LAYER_SPECS.find((s) => s.group === FIELD);
    const radar = WEATHER_LAYER_SPECS.find((s) => s.defaultOn);
    const overlays = WEATHER_LAYER_SPECS.filter(
      (s) => s.group === OVERLAY && s.rung > radar.rung,
    ).slice(0, 2);
    const chosen = [field, radar, ...overlays];
    const layers = chosen.map((s) => s.code).join('');

    const markerFor = (spec) => {
      const button = [
        ...h.elements.overlays.children,
        ...h.elements.fields.children,
      ].find((b) => b.dataset.layerCode === spec.code);
      return button.children.find((c) =>
        c.className?.includes('weather-chip-held'),
      );
    };

    // On the globe every selected row draws, so nothing is marked.
    h.control.sync({ layers }, null, 'globe');
    for (const spec of WEATHER_LAYER_SPECS)
      assert.equal(markerFor(spec).hidden, true, `${spec.label} on the globe`);

    h.control.sync({ layers }, null, 'tileset');
    const drawing = new Set(
      drapedSelection(chosen, 'tileset').map((s) => s.id),
    );
    assert.ok(
      drawing.size < chosen.length,
      'the fixture must exceed the budget',
    );
    for (const spec of chosen) {
      assert.equal(
        markerFor(spec).hidden,
        drawing.has(spec.id),
        `${spec.label} should ${drawing.has(spec.id) ? 'draw' : 'be marked'}`,
      );
    }

    // A row that is switched off is not "held back" — it is simply off.
    const off = WEATHER_LAYER_SPECS.filter(
      (s) => !chosen.some((c) => c.id === s.id),
    );
    assert.ok(off.length > 0);
    for (const spec of off)
      assert.equal(markerFor(spec).hidden, true, `${spec.label} is off`);
  } finally {
    h.restore();
  }
});

test('the interval is inert until auto-refresh is on', () => {
  const h = harness();
  try {
    h.control.sync({ layers: 'r', auto: false, every: 'd' }, null);
    assert.equal(h.elements.interval.disabled, true);
    assert.equal(h.elements.auto.getAttribute('aria-pressed'), 'false');

    h.control.sync({ layers: 'r', auto: true, every: 'q' }, null);
    assert.equal(h.elements.interval.disabled, false);
    assert.equal(h.elements.auto.getAttribute('aria-pressed'), 'true');
    assert.equal(h.elements.interval.value, 'q');

    // The button reports the state it is moving to, not the one it shows.
    h.elements.auto.dispatch('click');
    assert.deepEqual(h.calls.at(-1), ['auto', false]);
  } finally {
    h.restore();
  }
});

test('the spend is reported against the monthly allowance', () => {
  const h = harness();
  try {
    h.control.sync(
      { layers: 'r' },
      { hasKey: true, monthCount: 1234, budget: 15000 },
    );
    assert.match(h.elements.budget.textContent, /1,234/);
    assert.match(h.elements.budget.textContent, /15,000/);
    assert.equal(h.elements.unavailable.hidden, true);
    assert.equal(h.elements.refresh.disabled, false);
  } finally {
    h.restore();
  }
});

test('without a key the panel says so and refuses to spend', () => {
  const h = harness();
  try {
    h.control.sync(
      { layers: 'r' },
      { hasKey: false, monthCount: 0, budget: 15000 },
    );
    assert.equal(h.elements.unavailable.hidden, false);
    assert.equal(h.elements.refresh.disabled, true);
  } finally {
    h.restore();
  }
});

test('destroyed controls cannot issue stale actions', () => {
  const h = harness();
  const { overlays } = h.elements;
  h.restore();
  assert.equal(overlays.listenerCount('click'), 0);
});
