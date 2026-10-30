import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createHybridAnnotationRenderer } from './hybridAnnotationRenderer.js';
import { showOsmCredit, hideOsmCredit } from '../data/dataCredits.js';

class FakeClassList {
  constructor(owner) {
    this.owner = owner;
    this.names = new Set();
  }

  reset(value) {
    this.names = new Set(String(value || '').split(/\s+/).filter(Boolean));
  }

  add(...names) {
    for (const name of names) this.names.add(name);
    this.owner.attributes.set('class', Array.from(this.names).join(' '));
  }

  remove(...names) {
    for (const name of names) this.names.delete(name);
    this.owner.attributes.set('class', Array.from(this.names).join(' '));
  }

  contains(name) {
    return this.names.has(name);
  }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.attributes = new Map();
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this.classList = new FakeClassList(this);
    this.textContent = '';
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'class') this.classList.reset(value);
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  set className(value) {
    this.setAttribute('class', value);
  }

  get className() {
    return this.getAttribute('class') || '';
  }

  set id(value) {
    this.setAttribute('id', value);
  }

  get id() {
    return this.getAttribute('id') || '';
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  remove() {
    this.parentNode?.removeChild(this);
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    const className = selector.startsWith('.') ? selector.slice(1) : null;
    const matches = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (className && child.classList.contains(className)) matches.push(child);
        visit(child);
      }
    };
    visit(this);
    return matches;
  }

  addEventListener() {}

  getBBox() {
    return { x: 0, y: 0, width: 40, height: 16 };
  }

  set innerHTML(value) {
    this._innerHTML = value;
  }
}

function fakeDocument() {
  const head = new FakeElement('head');
  const body = new FakeElement('body');
  const roots = [head, body];
  return {
    head,
    body,
    createElement: (tag) => new FakeElement(tag),
    createElementNS: (_namespace, tag) => new FakeElement(tag),
    getElementById(id) {
      let found = null;
      const visit = (node) => {
        if (node.getAttribute('id') === id) found = node;
        for (const child of node.children) visit(child);
      };
      for (const root of roots) visit(root);
      return found;
    },
  };
}

function findAnnotationGroup(document) {
  const layer = document.body.children.find((child) => child.classList.contains('gev-screen-whiteboard'));
  const svg = layer.children.find((child) => child.classList.contains('gev-screen-whiteboard-svg'));
  return {
    svg,
    group: svg.children.find((child) => child.classList.contains('gev-anno')),
  };
}

function cameraLookingAt(lon, lat) {
  const target = Cesium.Cartesian3.fromDegrees(lon, lat);
  const radial = Cesium.Cartesian3.normalize(target, new Cesium.Cartesian3());
  const position = Cesium.Cartesian3.multiplyByScalar(
    radial,
    Cesium.Cartesian3.magnitude(target) + 1_000_000,
    new Cesium.Cartesian3(),
  );
  const direction = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.subtract(target, position, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  );
  const right = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.cross(direction, Cesium.Cartesian3.UNIT_Z, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  );
  const up = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.cross(right, direction, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  );
  const frustum = new Cesium.PerspectiveFrustum({
    fov: Cesium.Math.toRadians(60),
    aspectRatio: 1280 / 720,
    near: 1,
    far: 20_000_000,
  });
  return {
    positionWC: position,
    directionWC: direction,
    rightWC: right,
    upWC: up,
    viewMatrix: Cesium.Matrix4.computeView(
      position,
      direction,
      up,
      right,
      new Cesium.Matrix4(),
    ),
    frustum,
    positionCartographic: { height: 1_000_000 },
  };
}

/** Install the browser globals both renderers touch, restored after the test. */
function installBrowserGlobals(t) {
  const originalDocument = globalThis.document;
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalWindow = globalThis.window;
  const originalBrowserConstructors = new Map([
    ['HTMLCanvasElement', globalThis.HTMLCanvasElement],
    ['HTMLImageElement', globalThis.HTMLImageElement],
    ['ImageBitmap', globalThis.ImageBitmap],
    ['OffscreenCanvas', globalThis.OffscreenCanvas],
  ]);
  globalThis.document = fakeDocument();
  globalThis.requestAnimationFrame = (callback) => { callback(); return 1; };
  globalThis.window = { setTimeout: (fn) => { fn(); return 1; } };
  for (const name of originalBrowserConstructors.keys()) globalThis[name] = class {};
  t.after(() => {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalRequestAnimationFrame === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    for (const [name, original] of originalBrowserConstructors) {
      if (original === undefined) delete globalThis[name];
      else globalThis[name] = original;
    }
  });
}

/** A viewer whose scene/camera is just enough for both sub-renderers. */
function fakeViewer(lon, lat) {
  const credits = new Set();
  const camera = cameraLookingAt(lon, lat);
  const dataSources = [];
  const frames = controlledFrames();
  const scene = {
    camera,
    canvas: { clientWidth: 1280, clientHeight: 720, width: 1280, height: 720 },
    frameState: { mode: Cesium.SceneMode.SCENE3D },
    clampToHeightSupported: true,
    clampToHeight: (world) => world,
    postRender: frames.event,
    requestRender() {},
  };
  return {
    dataSources,
    frames,
    viewer: {
      credits,
      creditDisplay: {
        addStaticCredit: (credit) => credits.add(credit),
        removeStaticCredit: (credit) => credits.delete(credit),
      },
      scene,
      camera,
      trackedEntity: null,
      dataSources: {
        add(dataSource) {
          dataSources.push(dataSource);
          return dataSource;
        },
        remove(dataSource) {
          const index = dataSources.indexOf(dataSource);
          if (index >= 0) dataSources.splice(index, 1);
          return index >= 0;
        },
      },
    },
  };
}

function controlledFrames() {
  const listeners = new Set();
  return {
    event: {
      addEventListener(listener) { listeners.add(listener); },
      removeEventListener(listener) { listeners.delete(listener); },
    },
    emit() { for (const listener of [...listeners]) listener(); },
    snapshot() { return [...listeners]; },
    get size() { return listeners.size; },
  };
}

function buildingAnnotation(id, offset = 0) {
  const ring = [
    [-99 + offset, 31], [-98.999 + offset, 31],
    [-98.999 + offset, 31.001], [-99 + offset, 31.001],
    [-99 + offset, 31],
  ];
  return {
    id, type: 'area', color: 'primary', label: null, alpha: 1,
    anchor: { ...naiveRingCentroid(ring), height: 100 },
    ring, footprintKind: 'building', buildingHeight: 20, outlineCredit: 'tiles',
  };
}

function annotationGroups(svg) {
  return svg.children.filter((child) => child.classList.contains('gev-anno'));
}

function naiveRingCentroid(ring) {
  const totals = ring.reduce(
    (sum, [lon, lat]) => ({ lon: sum.lon + lon, lat: sum.lat + lat }),
    { lon: 0, lat: 0 },
  );
  return { lon: totals.lon / ring.length, lat: totals.lat / ring.length, height: 0 };
}

test('hybrid outline upgrade preserves the screen group and adds world geometry', async (t) => {
  const originalDocument = globalThis.document;
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalWindow = globalThis.window;
  globalThis.window = { setTimeout: (fn) => { fn(); return 1; } };
  const originalBrowserConstructors = new Map([
    ['HTMLCanvasElement', globalThis.HTMLCanvasElement],
    ['HTMLImageElement', globalThis.HTMLImageElement],
    ['ImageBitmap', globalThis.ImageBitmap],
    ['OffscreenCanvas', globalThis.OffscreenCanvas],
  ]);
  globalThis.document = fakeDocument();
  globalThis.requestAnimationFrame = (callback) => { callback(); return 1; };
  for (const name of originalBrowserConstructors.keys()) globalThis[name] = class {};
  t.after(() => {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalRequestAnimationFrame === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    for (const [name, original] of originalBrowserConstructors) {
      if (original === undefined) delete globalThis[name];
      else globalThis[name] = original;
    }
  });

  const camera = cameraLookingAt(-99, 31);
  const dataSources = [];
  const frames = controlledFrames();
  const scene = {
    camera,
    canvas: { clientWidth: 1280, clientHeight: 720, width: 1280, height: 720 },
    frameState: { mode: Cesium.SceneMode.SCENE3D },
    clampToHeightSupported: true,
    clampToHeight: (world) => world,
    postRender: frames.event,
    requestRender() {},
  };
  const viewer = {
    scene,
    camera,
    trackedEntity: null,
    dataSources: {
      add(dataSource) {
        dataSources.push(dataSource);
        return dataSource;
      },
      remove(dataSource) {
        const index = dataSources.indexOf(dataSource);
        if (index >= 0) dataSources.splice(index, 1);
        return index >= 0;
      },
    },
  };
  const renderer = createHybridAnnotationRenderer(viewer);
  const anno = {
    id: 'anno-hybrid-fb3',
    type: 'area',
    color: 'primary',
    label: 'Texas',
    alpha: 1,
    anchor: { lon: -99, lat: 31, height: 0 },
    ring: null,
    footprintKind: null,
    synthesized: false,
  };

  renderer.add(anno);
  const before = findAnnotationGroup(globalThis.document);
  const originalCallout = before.group.querySelector('.gev-anno-callout');
  const originalDot = before.group.querySelector('.gev-anno-dot');
  assert.equal(before.group.querySelectorAll('.gev-anno-ring').length, 2);
  assert.equal(dataSources.length, 1);
  assert.equal(dataSources[0].entities.values.length, 0);

  const ring = [
    [-106, 25],
    [-93, 25],
    [-93, 36],
    [-106, 36],
    [-106, 25],
  ];
  const centroid = naiveRingCentroid(ring);
  anno.ring = ring;
  anno.anchor = centroid;
  anno.footprintKind = 'area';
  renderer.update(anno);

  const after = findAnnotationGroup(globalThis.document);
  const expectedWindow = Cesium.SceneTransforms.worldToWindowCoordinates(
    scene,
    Cesium.Cartesian3.fromDegrees(centroid.lon, centroid.lat, centroid.height),
  );
  assert.equal(after.group, before.group, 'the real hybrid keeps the existing SVG group');
  assert.equal(after.svg.children.filter((child) => child.classList.contains('gev-anno')).length, 1);
  assert.equal(after.group.querySelectorAll('.gev-anno-ring').length, 0, 'screen reticle rings are removed');
  assert.equal(after.group.querySelector('.gev-anno-callout'), originalCallout, 'the callout node is retained');
  assert.equal(after.group.querySelector('.gev-anno-dot'), originalDot, 'the anchor dot is retained');
  assert.equal(originalDot.getAttribute('cx'), expectedWindow.x.toFixed(1));
  assert.equal(originalDot.getAttribute('cy'), expectedWindow.y.toFixed(1));
  assert.deepEqual(centroid, { lon: -100.8, lat: 29.4, height: 0 }, 'closed-ring vertex mean stays pinned');
  assert.equal(dataSources[0].entities.values.length, 2, 'world area adds one fill and one outline');
  assert.equal(dataSources[0].entities.values.filter((entity) => entity.polygon).length, 1);
  assert.equal(dataSources[0].entities.values.filter((entity) => entity.polyline).length, 1);
  assert.equal(Object.hasOwn(anno, '_entities'), false, 'world entity state stays on the inherited proxy');
  const outer = [
    [-99, 31],
    [-98.999, 31],
    [-98.999, 31.001],
    [-99, 31.001],
    [-99, 31],
  ];
  const hole = [
    [-98.9998, 31.0002],
    [-98.9996, 31.0002],
    [-98.9996, 31.0004],
    [-98.9998, 31.0004],
    [-98.9998, 31.0002],
  ];
  const island = outer.map(([lon, lat]) => [lon + 0.002, lat]);
  const building = {
    ...anno,
    id: 'anno-multipart-building',
    label: 'Building',
    anchor: { lon: -99, lat: 31, height: 0 },
    ring: outer,
    polygons: [[outer, hole], [island]],
    footprintKind: 'building',
    buildingHeight: 20,
  };
  const completion = renderer.add(building);
  assert.equal(dataSources[0].entities.values.length, 2, 'building geometry waits for all probes');
  for (let frame = 0; frame < 8; frame += 1) frames.emit();
  assert.equal((await completion).status, 'installed');
  const added = dataSources[0].entities.values.slice(2);
  const fills = added.filter(
    (entity) => entity.polygon && entity.polygon.fill?.getValue() !== false,
  );
  assert.equal(
    fills.length,
    2,
    'every building part gets a classification volume',
  );
  assert.equal(fills[0].polygon.hierarchy.getValue().holes.length, 1);
  assert.equal(fills[1].polygon.hierarchy.getValue().holes.length, 0);
  assert.equal(
    fills[0].polygon.material,
    fills[1].polygon.material,
    'parts share the fill material',
  );
  assert.equal(
    added.filter((entity) => entity.polyline).length,
    3,
    'all outer and hole outlines are retained',
  );
  renderer.remove(building);
  assert.equal(
    dataSources[0].entities.values.length,
    2,
    'multipart removal leaves only the earlier area',
  );
  renderer.destroy();
});

// ── Partial-add rollback (review round 2) ─────────────────────────────────────
//
// The hybrid builds a mark across TWO sub-renderers. It used to record the
// route only after both had run, so a throw in the second one left the first
// one's content live with nothing pointing at it: remove() was a no-op and the
// engine's rollback (which knows only the id) could not reach it. The next
// annotate of the same geometry then stacked a fresh mark over that orphan.

test('a sub-renderer throw mid-add leaves state the rollback can still remove', (t) => {
  installBrowserGlobals(t);
  const { viewer, dataSources } = fakeViewer(-99, 31);
  const renderer = createHybridAnnotationRenderer(viewer);
  const ring = [[-106, 25], [-93, 25], [-93, 36], [-106, 36], [-106, 25]];
  const anno = {
    id: 'anno-partial-add',
    type: 'area',
    color: 'primary',
    label: 'Texas',
    alpha: 1,
    anchor: naiveRingCentroid(ring),
    ring,
    footprintKind: 'area',
    synthesized: false,
  };

  // The world drape lands first; the screen caption then fails the way a lost
  // context does, AFTER the world geometry is already on the board.
  const { svg } = findAnnotationGroup(globalThis.document);
  const appendChild = svg.appendChild.bind(svg);
  let failNextInsert = true;
  svg.appendChild = (child) => {
    if (failNextInsert) {
      failNextInsert = false;
      throw new Error('screen insert failed');
    }
    return appendChild(child);
  };

  assert.throws(() => renderer.add(anno), /screen insert failed/);
  assert.equal(dataSources[0].entities.values.length, 2, 'the world drape is already live');
  assert.equal(annotationGroups(svg).length, 0, 'the half-built screen group detached itself');

  // The engine's rollback path — it must reach the partial state by id.
  renderer.remove(anno);
  assert.equal(dataSources[0].entities.values.length, 0, 'partial world state must be released');

  // …and the id is free again: a retry draws ONE mark, not a second one over
  // an orphan nothing owns.
  renderer.add(anno);
  assert.equal(dataSources[0].entities.values.length, 2, 'the retry draws exactly one world drape');
  assert.equal(annotationGroups(svg).length, 1, 'and exactly one screen caption');
  renderer.remove(anno);
  assert.equal(dataSources[0].entities.values.length, 0);
  renderer.destroy();
});

test('a release that throws keeps the mark addressable for a retry cleanup', (t) => {
  installBrowserGlobals(t);
  const { viewer, dataSources } = fakeViewer(-99, 31);
  const renderer = createHybridAnnotationRenderer(viewer);
  const ring = [[-106, 25], [-93, 25], [-93, 36], [-106, 36], [-106, 25]];
  const anno = {
    id: 'anno-release-throw',
    type: 'area',
    color: 'primary',
    label: 'Texas',
    alpha: 1,
    anchor: naiveRingCentroid(ring),
    ring,
    footprintKind: 'area',
    synthesized: false,
  };

  renderer.add(anno);
  const { svg } = findAnnotationGroup(globalThis.document);
  assert.equal(dataSources[0].entities.values.length, 2);
  assert.equal(annotationGroups(svg).length, 1);

  // The world route releases fine, then the screen release fails part-way
  // (its fade-out timer throws) — so its SVG group is still in the document.
  const workingSetTimeout = globalThis.window.setTimeout;
  globalThis.window.setTimeout = () => { throw new Error('teardown scheduling failed'); };
  assert.throws(() => renderer.remove(anno), /teardown scheduling failed/);
  assert.equal(dataSources[0].entities.values.length, 0, 'the world route did release');
  assert.equal(annotationGroups(svg).length, 1, 'the screen route did NOT — that is the orphan');

  // Dropping the routing entry here would make that orphan permanently
  // unreachable. It must still be addressable, so a retry finishes the job.
  globalThis.window.setTimeout = workingSetTimeout;
  renderer.remove(anno);
  assert.equal(annotationGroups(svg).length, 0, 'the retry cleanup must reach the orphan');
  assert.equal(dataSources[0].entities.values.length, 0, 'without double-releasing the world route');

  // Fully released now — a third call is inert.
  renderer.remove(anno);
  assert.equal(annotationGroups(svg).length, 0);
  renderer.destroy();
});

test('a world add that fails mid-way leaves its landed entities removable', (t) => {
  installBrowserGlobals(t);
  const { viewer, dataSources } = fakeViewer(-99, 31);
  const renderer = createHybridAnnotationRenderer(viewer);
  const ring = [[-106, 25], [-93, 25], [-93, 36], [-106, 36], [-106, 25]];
  const anno = {
    id: 'anno-partial-world-add',
    type: 'area',
    color: 'primary',
    label: 'Texas',
    alpha: 1,
    anchor: naiveRingCentroid(ring),
    ring,
    footprintKind: 'area',
    synthesized: false,
  };

  // The draped fill lands; the outline throws (bad geometry / lost context).
  const entities = dataSources[0].entities;
  const realAdd = entities.add.bind(entities);
  let addsLeft = 1;
  entities.add = (options) => {
    if (addsLeft <= 0) throw new Error('entity add failed');
    addsLeft -= 1;
    return realAdd(options);
  };

  assert.throws(() => renderer.add(anno), /entity add failed/);
  assert.equal(entities.values.length, 1, 'one entity landed before the failure');

  entities.add = realAdd;
  renderer.remove(anno);
  assert.equal(entities.values.length, 0,
    'the rollback must see the entities that landed before the throw');

  const { svg } = findAnnotationGroup(globalThis.document);
  renderer.add(anno);
  assert.equal(entities.values.length, 2, 'the retry draws a complete mark');
  assert.equal(annotationGroups(svg).length, 1);
  renderer.destroy();
});

function workTrace() {
  return { timeOrigin: performance.timeOrigin, slices: [], dropped: 0 };
}

test('buildings share one probe per frame and preserve probe geometry, filtering and fallback', async (t) => {
  installBrowserGlobals(t);
  const { viewer, dataSources, frames } = fakeViewer(-99, 31);
  const renderer = createHybridAnnotationRenderer(viewer);
  t.after(() => renderer.destroy());
  const first = buildingAnnotation('sampled-building');
  const second = buildingAnnotation('fallback-building', 0.01);
  second.outlineCredit = 'osm';
  const otherOwner = {};
  showOsmCredit(viewer, otherOwner);
  const probes = [];
  const outcomes = [-500, 120, 30, null, new Error('tile unavailable'), 60, 9001, 90];
  viewer.scene.clampToHeight = (position) => {
    const cartographic = Cesium.Cartographic.fromCartesian(position);
    const lon = Cesium.Math.toDegrees(cartographic.longitude);
    const lat = Cesium.Math.toDegrees(cartographic.latitude);
    probes.push([lon, lat]);
    const outcome = outcomes[probes.length - 1];
    if (outcome instanceof Error) throw outcome;
    return outcome == null ? undefined : Cesium.Cartesian3.fromDegrees(lon, lat, outcome);
  };
  // Suppress screen points: these counts concern the eight outside-building
  // probes, not the screen renderer's separate anchor-height sampling.
  const firstTrace = workTrace();
  const secondTrace = workTrace();
  let diagnosticWriteFaults = 0;
  Object.defineProperty(secondTrace, 'groundDetailDropped', {
    get: () => 0,
    set() {
      diagnosticWriteFaults += 1;
      throw new Error('diagnostic sink unavailable');
    },
    enumerable: true,
  });
  const firstCompletion = renderer.add(first, { pendingVisible: false, workTrace: firstTrace });
  const secondCompletion = renderer.add(second, { pendingVisible: false, workTrace: secondTrace });
  assert.equal(probes.length, 0, 'enqueue must not probe synchronously');
  assert.equal(dataSources[0].entities.values.length, 0);
  assert.equal([...viewer.credits].filter(c => c.showOnScreen).length, 1,
    'pending outlines add no tile credit to the other owner');
  for (let frame = 0; frame < 16; frame += 1) {
    const before = probes.length;
    frames.emit();
    assert.equal(probes.length, before + 1, 'the two buildings share one total probe budget');
    if (frame < 7) assert.equal(dataSources[0].entities.values.length, 0, 'no partial world parts');
  }
  const [installed, fallback] = await Promise.all([firstCompletion, secondCompletion]);
  assert.equal(installed.status, 'installed');
  assert.equal(fallback.status, 'installed');
  assert.equal([...viewer.credits].filter(c => c.showOnScreen).length, 2);
  assert.equal(installed.timing.probes, 8);
  assert.equal(fallback.timing.probes, 8);
  assert.ok(diagnosticWriteFaults > 0, 'the diagnostic failure was exercised');
  for (const trace of [firstTrace, secondTrace]) {
    assert.equal(trace.probes, 8);
    assert.equal(trace.samplerStatus, 'installed');
    assert.equal(trace.rendererStatus, 'installed');
    assert.equal(trace.slices.filter(s => s.phase === 'ground-step').length, 8);
    assert.equal(trace.slices.filter(s => s.phase === 'hybrid-complete').length, 1);
    assert.equal(trace.dropped, 0);
    assert.ok(trace.slices.every(s => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end >= s.start));
    assert.equal(trace.timeOrigin, performance.timeOrigin);
    const parents = trace.slices.filter(s => s.phase === 'ground-step');
    for (const [index, parent] of parents.entries()) {
      const detail = parent.detail;
      assert.equal(detail.index, index);
      assert.equal(detail.status, trace === firstTrace ? 'recorded' : 'missing');
      assert.equal(detail.clampResult,
        trace === firstTrace && index === 4 ? 'threw' : 'returned');
      assert.ok(Number.isFinite(detail.clampStart) && Number.isFinite(detail.clampEnd));
      assert.ok(parent.start <= detail.clampStart && detail.clampStart <= detail.clampEnd && detail.clampEnd <= parent.end);
      if (index === 7) {
        assert.equal(detail.commitStatus, 'attempted');
        assert.ok(Number.isFinite(detail.commitStart) && Number.isFinite(detail.commitEnd));
        assert.ok(detail.clampEnd <= detail.commitStart && detail.commitStart <= detail.commitEnd && detail.commitEnd <= parent.end);
      } else {
        assert.equal(detail.commitStatus, 'not-run');
        assert.equal(detail.commitStart, null);
        assert.equal(detail.commitEnd, null);
      }
    }
  }
  assert.notEqual(firstTrace.slices, secondTrace.slices);
  assert.ok(firstTrace.slices.filter(s => s.phase === 'ground-step').at(-1).end <= secondTrace.slices.find(s => s.phase === 'ground-step').start, 'each queued task records only its own sampling frames');
  const centroid = naiveRingCentroid(first.ring);
  const lonScale = 111320 * Math.cos(Cesium.Math.toRadians(centroid.lat));
  const radius = Math.max(...first.ring.map(([lon, lat]) =>
    Math.hypot((lon - centroid.lon) * lonScale, (lat - centroid.lat) * 111320)));
  const distance = radius * 1.5 + 12;
  const directions = [[1, 0], [-1, 0], [0, 1], [0, -1], [0.7, 0.7], [-0.7, -0.7], [0.7, -0.7], [-0.7, 0.7]];
  for (let index = 0; index < 8; index += 1) {
    const [dx, dy] = directions[index];
    assert.ok(Math.abs(probes[index][0] - (centroid.lon + dx * distance / lonScale)) < 1e-10);
    assert.ok(Math.abs(probes[index][1] - (centroid.lat + dy * distance / 111320)) < 1e-10);
    assert.ok(Math.abs(probes[index + 8][0] - probes[index][0] - 0.01) < 1e-10);
    assert.ok(Math.abs(probes[index + 8][1] - probes[index][1]) < 1e-10);
  }
  assert.equal(new Set(probes.slice(0, 8).map((point) => point.join(','))).size, 8);
  const fills = dataSources[0].entities.values.filter((entity) => entity.polygon?.fill?.getValue() !== false && entity.polygon);
  assert.equal(fills.length, 2);
  assert.ok(Math.abs(fills[0].polygon.height.getValue() - 57) < 1e-6, 'four accepted samples select floor(4 * 0.3), height 60 minus 3');
  assert.ok(Math.abs(fills[1].polygon.height.getValue() - 77) < 1e-6, 'all unavailable probes retain anchor minus building height fallback');
  const afterCompletion = probes.length;
  frames.emit();
  assert.equal(probes.length, afterCompletion, 'completion releases the sampler');
  renderer.remove(first);
  assert.equal([...viewer.credits].filter(c => c.showOnScreen).length, 1,
    'removing the last tile proxy retains the OSM building and other owner');
  renderer.remove(second);
  assert.equal([...viewer.credits].filter(c => c.showOnScreen).length, 1);
  hideOsmCredit(viewer, otherOwner);
  assert.equal(viewer.credits.size, 0);
});

test('building cancellation, queued deadline and destroy prevent saved callbacks from committing', async (t) => {
  installBrowserGlobals(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => t.mock.timers.reset());
  const { viewer, dataSources, frames } = fakeViewer(-99, 31);
  const renderer = createHybridAnnotationRenderer(viewer);
  let probeCount = 0;
  viewer.scene.clampToHeight = (position) => { probeCount += 1; return position; };
  const cancelled = buildingAnnotation('cancelled-building');
  const cancelledTrace = workTrace();
  const cancelledCompletion = renderer.add(cancelled, { pendingVisible: false, workTrace: cancelledTrace });
  const savedCancelled = frames.snapshot();
  renderer.remove(cancelled);
  assert.equal((await cancelledCompletion).status, 'cancelled');
  assert.equal(cancelledTrace.samplerStatus, 'cancelled');
  assert.equal(cancelledTrace.rendererStatus, 'cancelled');
  assert.equal(cancelledTrace.slices.filter(s => s.phase === 'ground-step').length, 0);
  for (const listener of savedCancelled) listener();
  assert.equal(probeCount, 0);
  assert.equal(viewer.credits.size, 0);

  const head = buildingAnnotation('deadline-head');
  const tail = buildingAnnotation('deadline-tail', 0.01);
  const headCompletion = renderer.add(head, { pendingVisible: false });
  const tailTrace = workTrace();
  const tailCompletion = renderer.add(tail, { pendingVisible: false, workTrace: tailTrace });
  frames.emit();
  assert.equal(probeCount, 1);
  const savedTimeout = frames.snapshot();
  // No further renderer frames arrive: both enqueue deadlines must still fire,
  // including the tail task that has never had a chance to sample.
  t.mock.timers.tick(2000);
  assert.equal((await headCompletion).status, 'timeout');
  const tailResult = await tailCompletion;
  assert.equal(tailResult.status, 'timeout');
  assert.equal(tailResult.timing.probes, 0);
  assert.equal(tailTrace.samplerStatus, 'timeout');
  assert.equal(tailTrace.rendererStatus, 'timeout');
  assert.equal(tailTrace.slices.filter(s => s.phase === 'ground-step').length, 0);
  assert.equal(tailTrace.slices.filter(s => s.phase === 'hybrid-complete').length, 1);
  assert.equal(viewer.credits.size, 0);
  for (const listener of savedTimeout) listener();
  assert.equal(probeCount, 1, 'saved callbacks cannot revive timed-out tasks');
  assert.equal(dataSources[0].entities.values.length, 0);

  const pending = buildingAnnotation('destroyed-building');
  const destruction = renderer.add(pending, { pendingVisible: false });
  const savedDestroy = frames.snapshot();
  renderer.destroy();
  assert.equal((await destruction).status, 'cancelled');
  for (const listener of savedDestroy) listener();
  t.mock.timers.tick(2000);
  assert.equal(probeCount, 1);
  assert.equal(dataSources.length, 0, 'destroy removes the owned data source');
  assert.equal(frames.size, 0, 'destroy removes frame listeners');
  assert.equal(viewer.credits.size, 0);
});

test('a timed-out building upgrade keeps its existing pending screen group', async (t) => {
  installBrowserGlobals(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => t.mock.timers.reset());
  const { viewer, dataSources, frames } = fakeViewer(-99, 31);
  const renderer = createHybridAnnotationRenderer(viewer);
  const anno = { ...buildingAnnotation('pending-upgrade'), ring: null, label: 'Building' };
  renderer.add(anno);
  const before = findAnnotationGroup(globalThis.document);
  anno.ring = buildingAnnotation('geometry').ring;
  const completion = renderer.update(anno);
  t.mock.timers.tick(2000);
  assert.equal((await completion).status, 'timeout');
  const after = findAnnotationGroup(globalThis.document);
  assert.equal(after.group, before.group);
  assert.ok(after.group.querySelector('.gev-anno-ring'), 'the honest pending point is not converted');
  assert.equal(dataSources[0].entities.values.length, 0);
  frames.emit();
  assert.equal(dataSources[0].entities.values.length, 0);
  renderer.destroy();
});

test('an asynchronous caption-conversion throw rolls back multipart world geometry and remains removable', async (t) => {
  installBrowserGlobals(t);
  const { viewer, dataSources, frames } = fakeViewer(-99, 31);
  const renderer = createHybridAnnotationRenderer(viewer);
  const anno = { ...buildingAnnotation('caption-failure'), ring: null, label: 'Building' };
  renderer.add(anno);
  const { group, svg } = findAnnotationGroup(globalThis.document);
  const dot = group.querySelector('.gev-anno-dot');
  anno.ring = buildingAnnotation('geometry').ring;
  const hole = anno.ring.map(([lon, lat]) => [lon + 0.0002, lat + 0.0002]);
  const island = anno.ring.map(([lon, lat]) => [lon + 0.002, lat]);
  anno.polygons = [[anno.ring, hole], [island]];
  const captionTrace = workTrace();
  const completion = renderer.update(anno, { workTrace: captionTrace });
  // Frame projection is still ordinary pending-point work. Arm the failure
  // only after sampling completes, before its promise converts the caption.
  for (let frame = 0; frame < 8; frame += 1) frames.emit();
  assert.ok(dataSources[0].entities.values.length > 0, 'multipart world geometry landed before caption conversion');
  assert.equal(viewer.credits.size, 2, 'credit belongs to the committed world proxy');
  const originalSetAttribute = dot.setAttribute.bind(dot);
  const failure = new Error('caption conversion failed');
  dot.setAttribute = (name, value) => {
    if (name === 'r') throw failure;
    return originalSetAttribute(name, value);
  };
  // Also fail screen teardown once: the routing entry must survive this second
  // failure so explicit cleanup can still reach the partial screen state.
  const workingSetTimeout = globalThis.window.setTimeout;
  globalThis.window.setTimeout = () => { throw new Error('teardown scheduling failed'); };
  const rejected = assert.rejects(completion, (error) => error === failure);
  await rejected;
  assert.equal(captionTrace.rendererStatus, 'failed');
  assert.equal(captionTrace.slices.filter(s => s.phase === 'ground-step').length, 8);
  assert.equal(captionTrace.slices.filter(s => s.phase === 'hybrid-complete').length, 1);
  assert.equal(captionTrace.slices.filter(s => s.phase === 'hybrid-rollback').length, 1);
  assert.equal(dataSources[0].entities.values.length, 0, 'all classification, cage and outline parts roll back');
  assert.equal(viewer.credits.size, 0, 'caption rollback releases that same proxy');
  assert.equal(annotationGroups(svg).length, 1, 'failed screen cleanup remains addressable');
  globalThis.window.setTimeout = workingSetTimeout;
  dot.setAttribute = originalSetAttribute;
  renderer.remove(anno);
  assert.equal(annotationGroups(svg).length, 0);
  renderer.remove(anno);
  renderer.destroy();
});
