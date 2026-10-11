import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LAUNCH_MISSION_EVENT,
  WIKIDATA_DOSSIER_ROOT_ID,
  dossierContent,
  installWikidataDossier,
} from './wikidataDossier.js';

class Cartesian3 {
  constructor(x = 0, y = 0, z = 0) {
    Object.assign(this, { x, y, z });
  }
  static clone(p, out = new Cartesian3()) {
    return Object.assign(out, { x: p.x, y: p.y, z: p.z });
  }
  static distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  }
  static fromDegrees(lon, lat, height = 0, _ellipsoid, out = new Cartesian3()) {
    return Object.assign(out, { x: lon, y: lat, z: height });
  }
}
const cesium = {
  Cartesian2: class {},
  Cartesian3,
  Cartographic: { fromCartesian: (p) => ({ height: p.z }) },
};

function fakeElement(tag) {
  const classes = new Set();
  const element = {
    tag,
    id: '',
    children: [],
    attributes: {},
    style: {
      setProperty(name, value) {
        this[name] = value;
      },
      removeProperty(name) {
        delete this[name];
      },
    },
    textContent: '',
    offsetWidth: 200,
    offsetHeight: 100,
    removed: false,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
    },
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    appendChild(child) {
      this.children.push(child);
    },
    append(...nodes) {
      this.children.push(...nodes);
    },
    replaceChildren(...nodes) {
      this.children = nodes;
    },
    remove() {
      this.removed = true;
    },
    set className(value) {
      classes.clear();
      for (const c of value.split(' ')) classes.add(c);
    },
  };
  return element;
}

function allText(node) {
  return [node.textContent, ...node.children.map(allText)]
    .filter(Boolean)
    .join(' ');
}

function fakeHost({ reducedMotion = true } = {}) {
  const body = fakeElement('body');
  const doc = {
    body,
    documentElement: { dataset: {} },
    createElement: fakeElement,
  };
  const listeners = new Map();
  const timeouts = [];
  const intervals = new Map();
  let nextId = 1;
  const win = {
    addEventListener: (n, fn) => listeners.set(n, fn),
    removeEventListener: (n) => listeners.delete(n),
    dispatch: (n, detail) => listeners.get(n)?.({ detail }),
    listeners,
    matchMedia: () => ({ matches: reducedMotion }),
    setTimeout: (fn) => {
      const id = nextId++;
      timeouts.push({ id, fn });
      return id;
    },
    clearTimeout: (id) => {
      const index = timeouts.findIndex((t) => t.id === id);
      if (index >= 0) timeouts.splice(index, 1);
    },
    setInterval: (fn) => {
      const id = nextId++;
      intervals.set(id, fn);
      return id;
    },
    clearInterval: (id) => intervals.delete(id),
    runTimeouts() {
      for (const t of timeouts.splice(0)) t.fn();
    },
    tickIntervals(times = 1) {
      for (let i = 0; i < times; i += 1)
        for (const fn of [...intervals.values()]) fn();
    },
    intervals,
  };
  return { doc, win, body };
}

function fakeViewer({ point = { x: 300, y: 200 }, width = 1000 } = {}) {
  const postRender = new Set();
  return {
    container: null,
    clock: { currentTime: 0 },
    trackedEntity: null,
    scene: {
      canvas: { clientWidth: width, clientHeight: 600 },
      camera: {},
      postRender: {
        addEventListener(fn) {
          postRender.add(fn);
          return () => postRender.delete(fn);
        },
      },
      cartesianToCanvasCoordinates: () => ({ ...point }),
      requestRender() {},
    },
    render() {
      for (const fn of postRender) fn();
    },
    postRender,
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function setup(options = {}) {
  const host = fakeHost(options);
  const viewer = fakeViewer(options);
  let record = {
    layerId: 'flights',
    id: 'abc123',
    latitude: 51.47,
    longitude: -0.45,
    properties: { type: 'Boeing 737-8AS' },
  };
  const lookups = [];
  const source = {
    lookup: (type, { signal }) => {
      lookups.push({ type, signal });
      return (
        options.lookup?.(type) ??
        Promise.resolve({
          id: 'Q1084919',
          title: 'Boeing 737 Next Generation',
          image: {
            file: 'B737NG.jpg',
            url: 'https://commons.wikimedia.org/wiki/Special:FilePath/B737NG.jpg?width=320',
          },
          lines: [
            { label: 'Model', value: 'Boeing 737 Next Generation' },
            { label: 'Wingspan', value: '34.3 m (113 ft)' },
          ],
        })
      );
    },
  };
  const spaceLookups = [];
  const spaceSource = {
    lookupSatellite: (subject, { signal }) => {
      spaceLookups.push({ kind: 'satellite', subject, signal });
      return Promise.resolve({
        id: 'Q25271',
        title: 'International Space Station',
        image: null,
        lines: [{ label: 'Inclination', value: '51.64°' }],
      });
    },
    lookupLaunch: (subject, { signal }) => {
      spaceLookups.push({ kind: 'launch', subject, signal });
      return Promise.resolve({
        id: 'Q28450215, Q115651848',
        title: 'SpaceX Crew-9',
        image: null,
        lines: [
          { section: 'Rocket · Falcon 9 Block 5' },
          { label: 'Maker', value: 'SpaceX' },
          { section: 'Mission · SpaceX Crew-9' },
          { label: 'Crew', value: 'Nick Hague' },
        ],
      });
    },
  };
  const uninstall = installWikidataDossier(viewer, {
    cesium,
    aircraftSource: source,
    spaceSource,
    getContext: () => record,
    doc: host.doc,
    win: host.win,
  });
  const root = host.body.children.find(
    (c) => c.id === WIKIDATA_DOSSIER_ROOT_ID,
  );
  const select = (detail = {}) =>
    host.win.dispatch('gev:awareness-subject-selected', {
      layerId: 'flights',
      id: 'abc123',
      position: new Cartesian3(-0.45, 51.47, 10_000),
      ...detail,
    });
  return {
    ...host,
    viewer,
    root,
    lookups,
    spaceLookups,
    select,
    uninstall,
    setRecord: (next) => (record = next),
  };
}

test('dossierContent covers loading, empty, error and ready states', () => {
  assert.match(
    dossierContent({ status: 'loading', query: 'B738' }).lines[0].value,
    /B738/,
  );
  assert.match(
    dossierContent({ status: 'empty', query: 'B738' }).lines[0].value,
    /No match/,
  );
  assert.match(
    dossierContent({ status: 'error' }).lines[0].value,
    /Unavailable/,
  );
  const ready = dossierContent({
    status: 'ready',
    result: {
      id: 'Q1',
      title: 'Jet',
      lines: [
        { label: 'Model', value: 'Jet' },
        { label: 'Wingspan', value: '1 m' },
      ],
    },
  });
  assert.equal(ready.title, 'Jet');
  assert.deepEqual(
    ready.lines.map((l) => l.label),
    ['Wingspan', 'Source'],
  );
  assert.match(ready.lines.at(-1).value, /Wikidata Q1 \(CC0\)/);
});

test('selecting an aircraft looks up its settled type and shows the dossier beside it', async () => {
  const t = setup();
  t.select();
  t.viewer.render();
  assert.equal(t.lookups.length, 0, 'waits for the type to settle');
  t.win.runTimeouts();
  await flush();
  assert.deepEqual(
    t.lookups.map((l) => l.type),
    ['Boeing 737-8AS'],
  );
  t.viewer.render();
  assert.ok(t.root.classList.contains('is-active'));
  assert.match(t.root.style.transform, /translate3d\(440\.0px, 150\.0px/);
  const text = allText(t.root);
  assert.match(text, /BOEING 737 NEXT GENERATION/);
  assert.match(text, /WINGSPAN/);
  assert.match(text, /34\.3 m \(113 ft\)/);
  assert.match(text, /Wikidata Q1084919/);
  const figure = t.root.children[0].children.find((c) => c.tag === 'figure');
  assert.equal(figure.hidden, false);
  assert.match(figure.children[0].src, /Special:FilePath\/B737NG\.jpg/);
  assert.match(figure.children[1].textContent, /Wikimedia Commons/);
  t.uninstall();
  assert.ok(t.root.removed);
});

test('the dossier types out over time unless motion is reduced', async () => {
  const t = setup({ reducedMotion: false });
  t.select();
  t.viewer.render();
  t.win.runTimeouts();
  await flush();
  assert.ok(t.win.intervals.size > 0, 'typing timer running');
  const partial = allText(t.root);
  t.win.tickIntervals(2);
  assert.ok(allText(t.root).length > partial.length);
  t.win.tickIntervals(200);
  assert.equal(t.win.intervals.size, 0, 'typing finishes');
  assert.match(allText(t.root), /34\.3 m \(113 ft\)/);
  t.uninstall();
});

test('the dossier flips to the left near the right edge and clears with the subject', async () => {
  const t = setup({ point: { x: 900, y: 300 } });
  t.select();
  t.viewer.render();
  t.win.runTimeouts();
  await flush();
  t.viewer.render();
  assert.ok(t.root.classList.contains('is-left'));
  assert.match(t.root.style.transform, /translate3d\(560\.0px/);
  const [{ signal }] = t.lookups;
  t.win.dispatch('gev:awareness-subject-cleared', {
    layerId: 'flights',
    id: 'abc123',
    reason: 'deliberate',
  });
  assert.ok(!t.root.classList.contains('is-active'));
  assert.ok(signal.aborted);
  t.uninstall();
});

test('non-aircraft selections and missing context records drop the dossier', async () => {
  const t = setup();
  t.select({ layerId: 'vessels' });
  t.viewer.render();
  t.win.runTimeouts();
  assert.equal(t.lookups.length, 0);
  t.select();
  t.viewer.render();
  t.win.runTimeouts();
  await flush();
  t.viewer.render();
  assert.ok(t.root.classList.contains('is-active'));
  t.setRecord(null);
  t.viewer.render();
  assert.ok(!t.root.classList.contains('is-active'));
  t.uninstall();
});

test('lookup failures show an unavailable notice', async () => {
  const t = setup({ lookup: () => Promise.reject(new Error('429')) });
  t.select();
  t.viewer.render();
  t.win.runTimeouts();
  await flush();
  t.viewer.render();
  assert.match(allText(t.root), /Unavailable/);
  t.uninstall();
});

test('selecting a satellite looks up its NORAD id and follows the tracked entity', async () => {
  const t = setup();
  t.setRecord({
    layerId: 'satellites',
    id: '25544',
    latitude: 10,
    longitude: 20,
    properties: { noradId: '25544', name: 'ISS (ZARYA)' },
  });
  let projected = null;
  t.viewer.scene.cartesianToCanvasCoordinates = (position) => {
    projected = position;
    return { x: 300, y: 200 };
  };
  const far = new Cartesian3(9e6, 9e6, 9e6);
  t.viewer.trackedEntity = {
    gevTrackedId: 'satellites:25544',
    gevLabelModel: { title: 'ISS', details: [], accent: '#ffd84d' },
    position: { getValue: () => far },
  };
  t.select({ layerId: 'satellites', id: 25544 });
  t.viewer.render();
  t.win.runTimeouts();
  await flush();
  assert.deepEqual(t.spaceLookups[0].subject, {
    noradId: '25544',
    name: 'ISS (ZARYA)',
  });
  t.viewer.render();
  assert.ok(t.root.classList.contains('is-active'));
  assert.equal(projected, far, 'tracked entity wins despite distance');
  assert.equal(
    t.root.style['--dossier-color'],
    '#ffd84d',
    'dossier takes the tracked label color',
  );
  assert.match(allText(t.root), /INTERNATIONAL SPACE STATION/);
  assert.match(allText(t.root), /51\.64°/);
  t.uninstall();
});

test('a selected launch shows rocket and mission sections at its pad', async () => {
  const t = setup();
  let projected = null;
  t.viewer.scene.cartesianToCanvasCoordinates = (position) => {
    projected = position;
    return { x: 300, y: 200 };
  };
  t.win.dispatch(LAUNCH_MISSION_EVENT, {
    id: 'launch-1',
    rocket: 'Falcon 9 Block 5',
    missionName: 'Crew-9',
    launchYear: 2024,
    lat: 28.56,
    lon: -80.58,
    accent: '#22e6e6',
  });
  await flush();
  assert.equal(t.root.style['--dossier-color'], '#22e6e6');
  assert.deepEqual(t.spaceLookups[0].subject, {
    rocket: 'Falcon 9 Block 5',
    missionName: 'Crew-9',
    launchYear: 2024,
  });
  t.viewer.render();
  assert.ok(t.root.classList.contains('is-active'));
  assert.deepEqual({ x: projected.x, y: projected.y }, { x: -80.58, y: 28.56 });
  const list = t.root.children[0].children.find((c) => c.tag === 'dl');
  const sections = list.children.filter((c) =>
    c.classList.contains('gev-dossier__section'),
  );
  assert.deepEqual(
    sections.map((c) => c.textContent),
    ['ROCKET · FALCON 9 BLOCK 5', 'MISSION · SPACEX CREW-9'],
  );
  const [{ signal }] = t.spaceLookups;
  t.win.dispatch(LAUNCH_MISSION_EVENT, { id: null });
  assert.ok(!t.root.classList.contains('is-active'));
  assert.ok(signal.aborted);
  assert.equal(t.root.style['--dossier-color'], undefined);
  t.uninstall();
});

test('unsafe label colors are ignored', async () => {
  const t = setup();
  t.win.dispatch(LAUNCH_MISSION_EVENT, {
    id: 'launch-2',
    rocket: 'Electron',
    lat: 1,
    lon: 2,
    accent: 'red; background: url(x)',
  });
  await flush();
  assert.equal(t.root.style['--dossier-color'], undefined);
  t.uninstall();
});
