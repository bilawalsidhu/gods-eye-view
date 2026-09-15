import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  chooseLiveCities,
  selectStyle,
  detectOn,
} from '../../scripts/qa-transit-controls.mjs';
import { createStyleParameters } from '../ui/styleParameters.js';
import { bindDisplayControls } from '../ui/displayControls.js';
import { thermalShader } from '../styles/thermal.js';
import {
  cycleMode,
  setMode,
  getMode,
  setDetectionTuning,
} from '../data/detection.js';

const pause = async () => {};
class Element extends EventTarget {
  constructor() {
    super();
    this.children = [];
    this.attributes = new Map();
    this.classList = { contains: () => false };
  }
  setAttribute(name, value) {
    this.attributes.set(name, value);
  }
  getAttribute(name) {
    return this.attributes.get(name);
  }
  append(...children) {
    this.children.push(...children);
  }
  appendChild(child) {
    this.children.push(child);
  }
  replaceChildren() {
    this.children = [];
  }
  scrollIntoView() {}
  getBoundingClientRect() {
    return { width: 100 };
  }
}
function pageFixture(t) {
  const prior = { document: globalThis.document, window: globalThis.window };
  const elements = new Map();
  const document = {
    documentElement: { dataset: { gevStyle: 'normal' } },
    createElement: () => new Element(),
    getElementById: (id) => elements.get(id),
    querySelector: () => null,
  };
  globalThis.document = document;
  globalThis.window = {};
  t.after(() => {
    for (const [name, value] of Object.entries(prior)) {
      if (value === undefined) delete globalThis[name];
      else globalThis[name] = value;
    }
  });
  const find = (selector) => {
    if (selector.startsWith('#param-sliders ')) {
      const label = selector.match(/aria-label="([^"]+)"/)[1];
      return elements
        .get('param-sliders')
        .children.flatMap((row) => row.children)
        .find((el) => el.getAttribute('aria-label') === label);
    }
    return elements.get(selector.slice(1));
  };
  const page = {
    evaluate: async (fn, ...args) => fn(...args),
    waitForFunction: async (fn, options, ...args) =>
      assert.ok(fn(...args), 'UI condition must hold'),
    waitForSelector: async (selector) =>
      assert.ok(find(selector), `missing ${selector}`),
    $eval: async (selector, fn, ...args) => {
      const el = find(selector);
      assert.ok(el, `missing ${selector}`);
      return fn(el, ...args);
    },
    click: async (selector) =>
      find(selector)?.dispatchEvent(new Event('click')),
  };
  return { page, elements, document };
}

test('live visual cities follow local operating hours in summer and winter', () => {
  for (const date of ['2026-09-15T06:30:00Z', '2026-01-15T06:30:00Z']) {
    assert.equal(chooseLiveCities(new Date(date))[0].id, 'helsinki');
  }
  assert.deepEqual(
    chooseLiveCities(new Date('2026-09-15T17:00:00Z')).map((c) => c.id),
    ['boston', 'austin'],
  );
  for (let hour = 0; hour < 24; hour++) {
    const now = new Date(`2026-09-15T${String(hour).padStart(2, '0')}:00:00Z`);
    const cities = chooseLiveCities(now);
    assert.ok(cities.length >= 1);
    for (const city of cities) {
      const local = Number(
        new Intl.DateTimeFormat('en', {
          timeZone: city.zone,
          hour: 'numeric',
          hourCycle: 'h23',
        }).format(now),
      );
      assert.ok(local >= 6 && local < 22);
    }
  }
});

test('thermal controls wait for activation and use the real generated parameter rows', async (t) => {
  const { page, document, elements } = pageFixture(t);
  const container = new Element();
  container.ownerDocument = document;
  elements.set('param-sliders', container);
  const parameters = createStyleParameters({ container });
  t.after(() => parameters.destroy());
  const values = Object.fromEntries(
    Object.entries(thermalShader.uniforms).map(([key, meta]) => [
      key,
      meta.default,
    ]),
  );
  window.__godsEyeView = {
    styleManager: {
      setPanelCollapsed() {},
      setStyle(name) {
        document.documentElement.dataset.gevStyle = name;
        parameters.render({
          uniforms: thermalShader.uniforms,
          readValue: (key) => values[key],
          writeValue: (key, value) => {
            values[key] = value;
          },
          onChange() {},
        });
      },
    },
  };
  // A swallowed click resolves normally; the helper must notice no activation.
  page.$eval = async (selector, fn, ...args) => {
    if (selector.startsWith('.style-btn')) return fn(new Element(), ...args);
    const label = selector.match(/aria-label="([^"]+)"/)[1];
    const slider = container.children
      .flatMap((row) => row.children)
      .find((el) => el.getAttribute('aria-label') === label);
    assert.ok(slider);
    return fn(slider, ...args);
  };
  const how = await selectStyle(
    page,
    'thermal',
    { 'WHOT/BHOT': 1, Ironbow: 1 },
    pause,
  );
  assert.match(how, /button did not activate/);
  assert.equal(values.mode, 1);
  assert.equal(values.palette, 1);
});

test('DETECT uses the real OFF/restore button and density input to reach DENSE', async (t) => {
  const { page, elements } = pageFixture(t);
  const button = new Element(),
    slider = new Element();
  elements.set('detection-toggle', button);
  elements.set('detection-density-slider', slider);
  button.getAttribute = (name) =>
    name === 'aria-pressed'
      ? String(getMode() !== 'OFF')
      : `Detection overlay: ${getMode().toLowerCase()}`;
  setMode('BALANCED');
  setMode('OFF');
  const modes = [];
  const controls = bindDisplayControls({
    elements: { detectionButton: button, densitySlider: slider },
    actions: {
      cycleDetection() {
        cycleMode();
        modes.push(getMode());
      },
      setDensity(value) {
        setDetectionTuning({ densityPct: Number(value) });
      },
    },
  });
  t.after(() => {
    controls.destroy();
    setMode('OFF');
  });
  assert.equal(await detectOn(page, pause), 'DENSE');
  assert.deepEqual(modes, ['BALANCED', 'OFF', 'DENSE']);
  const template = readFileSync(
    new URL('../ui/templates/display-controls.html', import.meta.url),
    'utf8',
  );
  assert.match(template, /id="detection-density-slider"/);
  assert.match(template, /id="detection-toggle"/);
});

test('city motion checks load deterministic playback before reading rendered samples', () => {
  const source = readFileSync(
    new URL('../../scripts/qa-transit.mjs', import.meta.url),
    'utf8',
  );
  const fixture = source.indexOf('_loadTransitFleetForTest(16');
  assert.ok(fixture >= 0);
  assert.ok(
    source.indexOf('const motionFirst = await sampleVisible(page)', fixture) >
      fixture,
  );
  assert.ok(
    source.indexOf('const glideA = await sampleVisible(page)', fixture) >
      fixture,
  );
  assert.ok(
    source.indexOf('const headingA = await sampleScreen(page)', fixture) >
      fixture,
  );
  assert.match(source, /scene.renderError.addEventListener/);
});

const { boundPageEvaluations, restoreRetainedTransit, sampleTransitPixels } =
  await import('../../scripts/qa-transit-browser.mjs');

test('page promise deadline rejects a stuck enable or teardown and preserves ordinary results', async () => {
  const page = { evaluate: async (fn, ...args) => fn(...args) };
  boundPageEvaluations(page, 15);
  assert.equal(await page.evaluate((a, b) => a + b, 3, 4), 7);
  await assert.rejects(
    page.evaluate(() => new Promise(() => {})),
    /Transit QA page wait timed out after 15 ms/,
  );
});

test('reload picks a surviving primed vehicle and reports unavailable snapshots as unexercised', async (t) => {
  const previous = globalThis.window;
  t.after(() => {
    globalThis.window = previous;
  });
  let selected;
  const entry = { key: 'mbta:survivor', record: { lon: -71.06, lat: 42.36 } };
  const vehicles = new Map([[entry.key, entry]]);
  globalThis.window = {
    __godsEyeView: {
      viewer: {
        camera: {
          positionCartographic: {
            constructor: { fromDegrees: (...v) => v, toCartesian: (v) => v },
          },
          setView() {},
        },
      },
      dataManager: {
        setEnabled: async () => {},
        layers: new Map([
          [
            'transit',
            {
              module: {
                update: async () => {},
                _transitStateForTest: () => ({ _vehicles: vehicles }),
                _transitPartsForTest: () => ({
                  selection: {
                    selectVehicle: (key) => {
                      selected = key;
                    },
                  },
                }),
              },
            },
          ],
        ]),
      },
    },
  };
  const primed = [
    { vehicleId: 'departed', oldestT: 10 },
    { vehicleId: 'survivor', oldestT: 20 },
  ];
  assert.deepEqual(await restoreRetainedTransit(primed), {
    key: entry.key,
    oldest: 20,
  });
  assert.equal(selected, entry.key);
  vehicles.clear();
  const manager = window.__godsEyeView.dataManager;
  const layer = manager.layers.get('transit').module;
  layer._transitStateForTest = () => ({
    _vehicles: vehicles,
    _activeFeeds: new Map([['mbta', {}]]),
  });
  manager.setEnabled = async () => {
    setTimeout(() => vehicles.set(entry.key, entry), 5);
  };
  assert.equal(
    (await restoreRetainedTransit(primed)).key,
    entry.key,
    'wait for discovery instead of declaring every vehicle departed',
  );
  manager.setEnabled = async () => {};
  assert.equal(
    (
      await restoreRetainedTransit([
        { ...primed[1], feedId: 'mbta', primedAt: Date.now() - 60000 },
      ])
    ).unexercised,
    true,
    'expired priming cannot pass',
  );
  layer._transitStateForTest = () => ({ _vehicles: vehicles });
  vehicles.clear();
  assert.equal((await restoreRetainedTransit(primed)).unexercised, true);
  assert.equal((await restoreRetainedTransit([])).unexercised, true);
});

test('sensor sampler waits for postRender and reads framebuffer pixels; stopped rendering rejects and removes listener', async (t) => {
  const previousWindow = globalThis.window,
    previousDocument = globalThis.document,
    previousImage = globalThis.Image;
  t.after(() => {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    globalThis.Image = previousImage;
  });
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  let listener,
    reads = 0,
    render = true;
  const gl = {
    RGBA: 1,
    UNSIGNED_BYTE: 2,
    readPixels(x, y, w, h, format, type, buffer) {
      reads++;
      buffer.set([255, 255, 255, 255]);
    },
  };
  const scene = {
    camera: { viewMatrix: identity, frustum: { projectionMatrix: identity } },
    canvas: {
      width: 400,
      height: 400,
      clientWidth: 400,
      clientHeight: 400,
      getContext: () => gl,
    },
    postRender: {
      addEventListener(fn) {
        listener = fn;
        return () => {
          listener = null;
        };
      },
    },
    requestRender() {
      if (render) queueMicrotask(() => listener?.());
    },
  };
  const raster = new Uint8ClampedArray(16 * 16 * 4).fill(255);
  globalThis.Image = class {
    width = 16;
    height = 16;
    async decode() {}
  };
  globalThis.document = {
    getElementById: () => null,
    createElement: () => ({
      getContext: () => ({
        drawImage() {},
        getImageData: () => ({ data: raster }),
      }),
    }),
  };
  globalThis.window = {
    __godsEyeView: {
      viewer: { scene },
      dataManager: {
        layers: new Map([
          [
            'transit',
            {
              module: {
                _transitStateForTest: () => ({
                  _vehicles: new Map([
                    [
                      'bus',
                      {
                        key: 'bus',
                        mode: 'bus',
                        marker: {
                          show: true,
                          image: 'raster',
                          position: { x: 0, y: 0, z: 0 },
                        },
                      },
                    ],
                  ]),
                }),
              },
            },
          ],
        ]),
      },
    },
  };
  const page = { evaluate: async (fn, ...args) => fn(...args) };
  const pixels = await sampleTransitPixels(page, {});
  assert.ok(
    reads >= 13,
    'centre, rings and background come from WebGL readPixels',
  );
  assert.ok(Math.abs(pixels[0].centre - 1) < 1e-6);
  assert.equal(listener, null);
  scene.pick = () => ({ id: 'overlapping-label' });
  assert.equal(
    (await sampleTransitPixels(page, {})).length,
    0,
    'a foreign pick across the sampled core disqualifies an obscured sprite',
  );
  scene.pick = ({ x }) => ({ id: x < 200 ? 'overlapping-sprite' : 'bus' });
  assert.equal(
    (await sampleTransitPixels(page, {})).length,
    0,
    'a clear centre cannot qualify a partially obscured core',
  );
  delete scene.pick;
  // The fixture returns fresh wrapper objects, so exercise raster and DOM
  // eligibility independently of framebuffer brightness.
  raster.fill(0);
  assert.equal((await sampleTransitPixels(page, {})).length, 0);
  raster.fill(255);
  document.elementFromPoint = () => ({ tagName: 'DIV', closest: () => null });
  assert.equal((await sampleTransitPixels(page, {})).length, 0);
  delete document.elementFromPoint;
  document.getElementById = () => ({
    width: 400,
    clientWidth: 400,
    getContext: () => ({
      getImageData: () => ({ data: new Uint8ClampedArray(144).fill(255) }),
    }),
  });
  assert.equal((await sampleTransitPixels(page, {})).length, 0);
  document.getElementById = () => null;
  window.__godsEyeView.styleManager = {
    getDetectionDiagnostics: () => ({
      calloutRects: [{ x: 205, y: 195, w: 10, h: 10, alpha: 1 }],
    }),
  };
  assert.equal(
    (await sampleTransitPixels(page, {})).length,
    0,
    'plate over the edge excludes the whole sprite even with a clear centre',
  );
  delete window.__godsEyeView.styleManager;
  document.getElementById = () => ({
    width: 400,
    clientWidth: 400,
    getContext: () => ({
      getImageData: (x, y, w = 1, h = 1) => ({
        data:
          w > 1
            ? new Uint8ClampedArray(w * h * 4)
            : new Uint8ClampedArray(
                x === 191 && [190, 193, 196].includes(y)
                  ? [20, 30, 40, 255]
                  : x === 191 && y === 207
                    ? [94, 240, 138, 255]
                    : [0, 0, 0, 0],
              ),
      }),
    }),
  });
  assert.deepEqual(
    (await sampleTransitPixels(page, {}))[0].bracket,
    [94, 240, 138],
    'stroke centre is sampled away from the top label plate',
  );
  document.getElementById = () => null;
  render = false;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = sampleTransitPixels(page, {});
  const rejected = assert.rejects(pending, /no postRender within 5000 ms/);
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(5000);
  await rejected;
  assert.equal(listener, null);
});

test('preset baseline clears a previous city selection before comparing fleet sizes', async (t) => {
  const { readTransitFleetStyle } =
    await import('../../scripts/qa-transit-browser.mjs');
  const prior = globalThis.window;
  t.after(() => {
    globalThis.window = prior;
  });
  const entry = {
    key: 'mbta:tram',
    marker: {
      show: true,
      width: 33.75,
      image: 'raster-selected',
      color: { toCssColorString: () => 'rgb(255,194,74)' },
    },
  };
  const state = {
    _selectedKey: entry.key,
    _vehicles: new Map([[entry.key, entry]]),
  };
  globalThis.window = {
    __godsEyeView: {
      dataManager: {
        layers: new Map([
          [
            'transit',
            {
              module: {
                _transitStateForTest: () => state,
                _transitPartsForTest: () => ({
                  selection: {
                    clearSelection() {
                      state._selectedKey = null;
                      entry.marker.width = 22.5;
                      entry.marker.image = 'raster-fleet';
                    },
                  },
                }),
              },
            },
          ],
        ]),
      },
    },
  };
  const baseline = readTransitFleetStyle({ resetSelection: true });
  assert.equal(baseline.width, 22.5);
  assert.equal(baseline.selected, false);
  assert.deepEqual(readTransitFleetStyle({ key: entry.key }), baseline);
});

test('allocation accounting includes Cesium render aliases and excludes QA helper subtrees', async () => {
  const { allocationTotals } =
    await import('../../scripts/qa-transit-scenes.mjs');
  const node = (functionName, url, selfSize, children = []) => ({
    callFrame: { functionName, url },
    selfSize,
    children,
  });
  const profile = {
    head: node('(root)', '', 0, [
      node('render2', 'cesium.js', 0, [
        node('Scene4.render', 'cesium.js', 10, [
          node('_drawOverlay', '/src/data/detection.js', 100),
          node('', '/src/layers/transit/testing.js', 200, [
            node('hypot', '', 300),
            node('onPreRender', '/src/layers/transit/rendering.js', 20, [
              node('sampleAt', '/src/data/contactPlayback.js', 30),
              node('style', '/src/data/transitPresetStyle.js', 10),
            ]),
          ]),
        ]),
      ]),
    ]),
  };
  const { topAllocators, ...totals } = allocationTotals(profile);
  assert.equal(topAllocators[0].bytes, 100);
  assert.deepEqual(totals, {
    frameBytes: 170,
    layerFrameBytes: 60,
    sharedOverlayBytes: 100,
    qaBytes: 500,
  });
});

test('public transit documentation uses courtesy attribution and the approved ground sentence', () => {
  const data = readFileSync(
    new URL('../../DATA_SOURCES.md', import.meta.url),
    'utf8',
  );
  const rows = data
    .split('\n')
    .filter((line) =>
      /^\| \*\*(MBTA|CapMetro|Metro Transit|OVapi|Entur|TransLink|HSL)/.test(
        line,
      ),
    );
  assert.equal(rows.length, 7);
  for (const row of rows) {
    assert.doesNotMatch(
      row,
      /licen[cs]e|unlicensed|unstated|grants|permits|public.domain|CC BY|NLOD|terms|trademarks/i,
    );
    assert.match(row, /open realtime vehicle data/);
    assert.match(row, /published for developer use and not against their use/);
  }
  const readme = readFileSync(
    new URL('../../README.md', import.meta.url),
    'utf8',
  );
  assert.ok(
    readme.includes(
      'Fifteen layers and map sources. **Thirteen have a keyless path.**',
    ),
  );
  assert.ok(
    readme.includes(
      '**Sits on the real ground.** Entity heights are aligned to work with Google 3D tiles, so aircraft park on aprons and cameras stand on street corners instead of floating.',
    ),
  );
  assert.doesNotMatch(
    readme,
    /geoid-aware|sampled against the _rendered_ terrain mesh/,
  );
});
