import '../testSupport/registerDom.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createApp, nextTick } from 'vue';
import { createPinia } from 'pinia';
import { useScreenAnnotationsStore } from '../ui/stores/screenAnnotations.js';
import ScreenAnnotations from '../ui/views/panels/ScreenAnnotations.vue';
import { createScreenAnnotationRenderer } from './screenAnnotationRenderer.js';

// happy-dom does not lay out SVG; every element measures as a 40 x 16 box.
for (const type of [globalThis.SVGElement, globalThis.SVGGraphicsElement]) {
  if (type) type.prototype.getBBox = () => ({ x: 0, y: 0, width: 40, height: 16 });
}

const settle = async () => {
  for (let flush = 0; flush < 4; flush += 1) await nextTick();
};

/** Mount the board's view; animation frames run when `frames()` is called. */
function board(t) {
  document.body.replaceChildren();
  const pinia = createPinia();
  const store = useScreenAnnotationsStore(pinia);
  const app = createApp(ScreenAnnotations).use(pinia);
  app.mount(document.body.appendChild(document.createElement('div')));
  const queued = [];
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (callback) => queued.push(callback);
  t.after(() => {
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    app.unmount();
  });
  const frames = () => {
    for (const callback of queued.splice(0)) callback();
  };
  const svg = () => document.querySelector('.gev-screen-whiteboard-svg');
  const groups = () => [...(svg()?.querySelectorAll('g.gev-anno') ?? [])];
  return { store, frames, svg, groups };
}

function cameraOver(lon, lat) {
  const positionWC = Cesium.Cartesian3.fromDegrees(lon, lat, 1000);
  const directionWC = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.negate(positionWC, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  );
  // Low enough that point marks keep their full size.
  return { positionWC, directionWC, positionCartographic: { height: 500 } };
}

function sceneFor(camera, extra = {}) {
  return {
    camera,
    canvas: { clientWidth: 800, clientHeight: 600, width: 800, height: 600 },
    clampToHeightSupported: false,
    postRender: { addEventListener() {}, removeEventListener() {} },
    ...extra,
  };
}

/** Project every point to the given window position for the test's length. */
function projectTo(t, at) {
  const original = Cesium.SceneTransforms.worldToWindowCoordinates;
  Cesium.SceneTransforms.worldToWindowCoordinates = typeof at === 'function' ? at : () => at;
  t.after(() => {
    Cesium.SceneTransforms.worldToWindowCoordinates = original;
  });
}

test('a pin renders its reticle, leader and callout on the page board', async (t) => {
  const { store, frames, svg, groups } = board(t);
  projectTo(t, { x: 200, y: 300 });
  const camera = cameraOver(0, 0);
  const renderer = createScreenAnnotationRenderer(
    { scene: sceneFor(camera), camera, trackedEntity: null },
    { store, activeTrackedReadoutId: () => null },
  );
  t.after(() => renderer.destroy());
  renderer.add({
    id: 'pin',
    type: 'pin',
    color: 'amber',
    label: 'Capitol',
    alpha: 1,
    anchor: { lon: 0, lat: 0, height: 0 },
  });
  await settle();
  const layer = document.body.querySelector(':scope > .gev-screen-whiteboard');
  assert.ok(layer);
  assert.equal(svg().getAttribute('preserveAspectRatio'), 'none');
  assert.equal(svg().getAttribute('viewBox'), '0 0 800 600');
  assert.ok(svg().querySelector('defs > filter#gev-sketch > feTurbulence'));
  const [group] = groups();
  assert.equal(group.getAttribute('class'), 'gev-anno');
  assert.equal(group.getAttribute('opacity'), '1');
  assert.deepEqual(
    [...group.children].map((child) => [child.tagName.toLowerCase(), child.getAttribute('class')]),
    [
      ['circle', 'gev-anno-ring gev-pulse'],
      ['circle', 'gev-anno-ring'],
      ['circle', 'gev-anno-dot'],
      ['line', 'gev-anno-leader'],
      ['g', 'gev-anno-callout'],
    ],
  );
  const [outer, inner, dot, leader, callout] = group.children;
  assert.equal(outer.getAttribute('stroke'), '#ffb547');
  assert.equal(outer.getAttribute('cx'), '200.0');
  assert.equal(outer.getAttribute('r'), '34.0');
  assert.equal(inner.getAttribute('fill-opacity'), '0.12');
  assert.equal(inner.getAttribute('filter'), 'url(#gev-sketch)');
  assert.equal(dot.getAttribute('r'), '5.0');
  assert.equal(leader.getAttribute('x1'), '200.0');
  assert.equal(leader.getAttribute('x2'), '218.0');
  // The card is sized to its measured text, and the leader meets its bottom.
  const [card, accent, text] = callout.children;
  assert.equal(text.textContent, 'Capitol');
  assert.equal(text.getAttribute('x'), '9');
  assert.equal(card.getAttribute('width'), '58');
  assert.equal(card.getAttribute('height'), '26');
  assert.equal(accent.getAttribute('height'), '18');
  assert.equal(accent.getAttribute('fill'), '#ffb547');
  assert.equal(callout.getAttribute('transform'), 'translate(218.0, 266.0)');
  assert.equal(leader.getAttribute('y2'), '292.0');
  frames();
  await settle();
  assert.equal(group.getAttribute('class'), 'gev-anno gev-in');
});

test('an arrow defines its arrowhead and drops the dash once drawn on', async (t) => {
  const { store, frames, svg, groups } = board(t);
  let calls = 0;
  projectTo(t, () => (calls++ % 2 ? { x: 400, y: 100 } : { x: 100, y: 100 }));
  const camera = cameraOver(0, 0);
  const renderer = createScreenAnnotationRenderer(
    { scene: sceneFor(camera), camera, trackedEntity: null },
    { store, activeTrackedReadoutId: () => null },
  );
  t.after(() => renderer.destroy());
  renderer.add({
    id: 'arrow',
    type: 'arrow',
    color: 'green',
    alpha: 1,
    anchor: { lon: 0, lat: 0 },
    to: { lon: 0.01, lat: 0 },
  });
  await settle();
  const marker = svg().querySelector('defs > marker#gev-arrow-green');
  assert.equal(marker.getAttribute('orient'), 'auto-start-reverse');
  assert.equal(marker.querySelector('path').getAttribute('fill'), '#5dff9f');
  const path = groups()[0].querySelector('path');
  assert.equal(path.getAttribute('class'), 'gev-anno-arrow gev-draw');
  assert.equal(path.getAttribute('marker-end'), 'url(#gev-arrow-green)');
  assert.match(path.getAttribute('d'), /^M 100\.0 100\.0 Q /);
  frames();
  await settle();
  const ended = new Event('transitionend', { bubbles: true });
  ended.propertyName = 'stroke-dashoffset';
  path.dispatchEvent(ended);
  await settle();
  assert.equal(path.style.strokeDasharray, 'none');
});

test('outline upgrade preserves the existing SVG group identity', async (t) => {
  const { store, svg, groups } = board(t);
  const camera = {
    positionWC: Cesium.Cartesian3.ZERO,
    directionWC: Cesium.Cartesian3.ZERO,
    positionCartographic: { height: 1000 },
  };
  const sampledAnchors = [];
  const scene = sceneFor(camera, {
    canvas: { clientWidth: 1280, clientHeight: 720, width: 1280, height: 720 },
    clampToHeightSupported: true,
    clampToHeight(world) {
      const cartographic = Cesium.Cartographic.fromCartesian(world);
      sampledAnchors.push([
        Number(Cesium.Math.toDegrees(cartographic.longitude).toFixed(4)),
        Number(Cesium.Math.toDegrees(cartographic.latitude).toFixed(4)),
      ]);
      return world;
    },
  });
  const renderer = createScreenAnnotationRenderer(
    { scene, camera, trackedEntity: null },
    { store, activeTrackedReadoutId: () => null },
  );
  t.after(() => renderer.destroy());
  const anno = {
    id: 'anno-fb3',
    type: 'area',
    color: 'primary',
    label: 'Texas',
    alpha: 1,
    anchor: { lon: -99, lat: 31, height: 0 },
    ring: null,
  };
  renderer.add(anno);
  await settle();
  const [before] = groups();
  assert.ok(before.querySelector('.gev-anno-ring'), 'pending area starts as a reticle');
  const callout = before.querySelector('.gev-anno-callout');
  const dot = before.querySelector('.gev-anno-dot');

  const labelProxy = Object.assign(Object.create(anno), {
    type: 'label',
    ring: null,
    anchor: { lon: -97.5, lat: 31.2, height: 0 },
  });
  renderer.update(labelProxy);
  await settle();
  const [after] = groups();

  assert.ok(after === before, 'the rendered group is mutated, not replaced');
  assert.deepEqual(sampledAnchors.at(-1), [-97.5, 31.2], 'the existing group projects from the re-seated anchor');
  assert.equal(groups().length, 1);
  assert.equal(after.querySelector('.gev-anno-ring'), null, 'reticle rings are removed in place');
  assert.ok(after.querySelector('.gev-anno-callout') === callout, 'the original callout remains in the group');
  assert.ok(after.querySelector('.gev-anno-dot') === dot, 'the anchor dot remains in the group');
  assert.ok(svg());
});

test('a callout whose text changes is sized to the new text', async (t) => {
  const { store, groups } = board(t);
  projectTo(t, { x: 100, y: 100 });
  // Text measures 7px a character; everything else keeps the shared box.
  const original = globalThis.SVGGraphicsElement.prototype.getBBox;
  globalThis.SVGGraphicsElement.prototype.getBBox = function () {
    return this.tagName.toLowerCase() === 'text'
      ? { x: 0, y: 0, width: this.textContent.length * 7, height: 16 }
      : original.call(this);
  };
  t.after(() => {
    globalThis.SVGGraphicsElement.prototype.getBBox = original;
  });
  const camera = cameraOver(0, 0);
  const renderer = createScreenAnnotationRenderer(
    { scene: sceneFor(camera), camera, trackedEntity: null },
    { store, activeTrackedReadoutId: () => null },
  );
  t.after(() => renderer.destroy());
  const anno = {
    id: 'upgrade',
    type: 'label',
    color: 'primary',
    label: 'Texas',
    alpha: 1,
    anchor: { lon: 0, lat: 0 },
  };
  renderer.add(anno);
  await settle();
  const card = () => groups()[0].querySelector('.gev-anno-card');
  assert.equal(card().getAttribute('width'), String(5 * 7 + 18));
  renderer.update({ ...anno, outlineUnavailable: true });
  await settle();
  const text = 'Texas · Detailed outline unavailable';
  assert.equal(groups()[0].querySelector('text').textContent, text);
  assert.equal(card().getAttribute('width'), String(text.length * 7 + 18));
});

test('annotation fade consumes the actual tracked host paint rectangle after layout', async (t) => {
  const { store, groups } = board(t);
  projectTo(t, { x: 0, y: 0 });
  const camera = cameraOver(0, 0);
  const paintRectCalls = [];
  const renderer = createScreenAnnotationRenderer(
    { scene: sceneFor(camera), camera, trackedEntity: null },
    {
      store,
      activeTrackedReadoutId: () => 'installations:test',
      overlayPaintRect(sourceId, entryId) {
        paintRectCalls.push({ sourceId, entryId });
        return { x: -10, y: -10, w: 120, h: 80 };
      },
    },
  );
  t.after(() => renderer.destroy());
  renderer.add({
    id: 'anno-overlap',
    type: 'label',
    color: 'primary',
    label: 'OVERLAP',
    alpha: 1,
    anchor: { lon: 0, lat: 0, height: 0 },
  });
  await settle();
  const [group] = groups();
  assert.deepEqual(paintRectCalls.at(-1), {
    sourceId: 'tracked',
    entryId: 'installations:test',
  });
  assert.ok(
    Number(group.getAttribute('opacity')) < 1,
    'final annotation bbox fades against the complete painted card rectangle',
  );
});

test('a removed mark fades out, then leaves the board', async (t) => {
  const { store, groups } = board(t);
  projectTo(t, { x: 100, y: 100 });
  const camera = cameraOver(0, 0);
  const renderer = createScreenAnnotationRenderer(
    { scene: sceneFor(camera), camera, trackedEntity: null },
    { store, activeTrackedReadoutId: () => null },
  );
  t.after(() => renderer.destroy());
  const anno = {
    id: 'fading',
    type: 'label',
    color: 'primary',
    label: 'Gone soon',
    alpha: 1,
    anchor: { lon: 0, lat: 0 },
  };
  renderer.add(anno);
  await settle();
  const [group] = groups();
  renderer.remove(anno);
  // A new mark for the same place gets its own group beside the fading one.
  renderer.add(anno);
  await settle();
  assert.equal(group.getAttribute('class'), 'gev-anno gev-out');
  assert.equal(groups().length, 2);
  assert.ok(groups()[1] !== group);
  await new Promise((resolve) => setTimeout(resolve, 400));
  await settle();
  assert.deepEqual(groups().length, 1);
  assert.equal(group.isConnected, false);
  renderer.destroy();
  await settle();
  assert.equal(document.querySelector('.gev-screen-whiteboard'), null);
});

// ── Partial-add unwind (review round 2) ───────────────────────────────────────
//
// add() records the mark, then does more work (presenting it, the first
// projection pass). A throw in that tail used to leave an ORPHANED mark plus a
// record nobody owned — the engine's rollback only deletes its own map entry —
// so re-annotating the same place stacked a second mark over the corpse.

test('an add that throws after inserting its group unwinds instead of orphaning it', async (t) => {
  const { store, groups } = board(t);
  const camera = cameraOver(0, 0);
  const renderer = createScreenAnnotationRenderer(
    { scene: sceneFor(camera, { canvas: { clientWidth: 1280, clientHeight: 720, width: 1280, height: 720 } }), camera, trackedEntity: null },
    { store, activeTrackedReadoutId: () => null },
  );
  t.after(() => renderer.destroy());
  const anno = {
    id: 'anno-partial-screen',
    type: 'pin',
    color: 'primary',
    label: 'Capitol',
    alpha: 1,
    anchor: { lon: 0, lat: 0, height: 0 },
  };

  // The mark is on the board by the time add() reaches its first projection
  // pass — so a throw there is real partial state, not a clean bail-out.
  projectTo(t, () => {
    throw new Error('projection failed');
  });
  assert.throws(() => renderer.add(anno), /projection failed/);
  Cesium.SceneTransforms.worldToWindowCoordinates = () => ({ x: 0, y: 0 });
  await settle();
  assert.equal(groups().length, 0, 'the half-built group must not stay in the document');

  // The id is free again: a retry draws exactly one mark, and remove() still
  // owns it (a leaked record would leave a second group behind).
  renderer.add(anno);
  await settle();
  assert.equal(groups().length, 1, 'the retry must draw one mark, not stack over an orphan');
});

test("an earlier renderer leaves a later renderer's board alone", async (t) => {
  const { store, groups } = board(t);
  projectTo(t, { x: 100, y: 100 });
  const camera = cameraOver(0, 0);
  const viewer = { scene: sceneFor(camera), camera, trackedEntity: null };
  const options = { store, activeTrackedReadoutId: () => null };
  const earlier = createScreenAnnotationRenderer(viewer, options);
  const later = createScreenAnnotationRenderer(viewer, options);
  t.after(() => later.destroy());
  later.add({ id: 'kept', type: 'label', label: 'Kept', alpha: 1, anchor: { lon: 0, lat: 0 } });
  earlier.add({ id: 'ignored', type: 'label', label: 'Ignored', alpha: 1, anchor: { lon: 0, lat: 0 } });
  earlier.destroy();
  await settle();
  assert.equal(groups().length, 1);
  assert.equal(groups()[0].querySelector('text').textContent, 'Kept');
});

test('a multipart area with holes draws every visible part and keeps holes open', async (t) => {
  const { store, svg } = board(t);
  // A fixed projection: 0.001 degrees spans 100 px.
  projectTo(t, (_scene, world) => {
    const c = Cesium.Cartographic.fromCartesian(world);
    return {
      x: 100 + Cesium.Math.toDegrees(c.longitude) * 1e5,
      y: 100 + Cesium.Math.toDegrees(c.latitude) * 1e5,
    };
  });
  const camera = cameraOver(0, 0);
  const renderer = createScreenAnnotationRenderer(
    { scene: sceneFor(camera), camera, trackedEntity: null },
    { store, activeTrackedReadoutId: () => null },
  );
  t.after(() => renderer.destroy());
  const outer = [[0, 0], [0.001, 0], [0.001, 0.001], [0, 0.001], [0, 0]];
  const hole = [[0.0002, 0.0002], [0.0004, 0.0002], [0.0004, 0.0004], [0.0002, 0.0004], [0.0002, 0.0002]];
  const island = outer.map(([lon, lat]) => [lon + 0.002, lat]);
  const anno = {
    id: 'anno-multipart-screen',
    label: 'Multipart',
    type: 'area',
    color: 'primary',
    alpha: 1,
    anchor: { lon: 0, lat: 0, height: 0 },
    ring: outer,
    polygons: [[outer, hole], [island]],
    synthesized: false,
  };
  renderer.add(anno);
  await settle();
  const area = () => svg().querySelector('.gev-anno-area');
  const subpaths = () => (area().getAttribute('d').match(/M /g) || []).length;
  assert.equal(area().tagName.toLowerCase(), 'path');
  assert.equal(area().getAttribute('fill-rule'), 'evenodd');
  assert.equal(subpaths(), 3, 'screen fill retains both parts and the hole');

  // The first part is behind the globe: the label centres on the next part.
  anno.polygons = [[island.map(([lon, lat]) => [lon + 180, lat])], [outer, hole]];
  renderer.sync();
  await settle();
  assert.equal(subpaths(), 2, 'an island behind the globe cannot hide the visible part and its hole');
  assert.notEqual(area().parentNode.style.display, 'none');
  assert.doesNotMatch(
    area().parentNode.querySelector('.gev-anno-callout').getAttribute('transform'),
    /NaN/,
  );

  anno.polygons = [[outer, hole]];
  projectTo(t, (_scene, world) => {
    const lon = Cesium.Math.toDegrees(Cesium.Cartographic.fromCartesian(world).longitude);
    return { x: lon > 0.0009 ? 2401 : 0, y: 0 };
  });
  renderer.sync();
  await settle();
  assert.equal(subpaths(), 2, 'finite offscreen shell coordinates cannot hide a visible holed part');
  assert.notEqual(area().parentNode.style.display, 'none');

  anno.polygons = [[outer, hole], [island]];
  projectTo(t, (_scene, world) => {
    const lon = Cesium.Math.toDegrees(Cesium.Cartographic.fromCartesian(world).longitude);
    return Math.abs(lon - 0.0002) < 1e-7 ? undefined : { x: 0, y: 0 };
  });
  renderer.sync();
  await settle();
  assert.equal(subpaths(), 1, 'an unprojectable hole omits its entire part, not the independently visible island');
  assert.notEqual(area().parentNode.style.display, 'none');
});

test('Preview avoids the map callout without moving its world anchor', async (t) => {
  const { store, svg, groups } = board(t);
  projectTo(t, (_scene, world) => {
    const lon = Cesium.Math.toDegrees(Cesium.Cartographic.fromCartesian(world).longitude);
    return { x: 400, y: lon > 0.0005 ? 166 : 200 };
  });
  const camera = cameraOver(0, 0);
  const scene = sceneFor(camera, {
    canvas: { clientWidth: 1280, clientHeight: 720, width: 1280, height: 720 },
  });
  const panel = document.body.appendChild(document.createElement('section'));
  panel.id = 'gev-voice-panel';
  panel.dataset.view = 'preview';
  panel.hidden = true;
  let panelRect = { left: 210, top: 120, width: 100, height: 120 };
  let panelVisible = true;
  panel.getBoundingClientRect = () => panelRect;
  panel.checkVisibility = () => panelVisible;
  const renderer = createScreenAnnotationRenderer(
    { scene, camera, trackedEntity: null },
    { store, activeTrackedReadoutId: () => null },
  );
  t.after(() => renderer.destroy());
  const anno = { id: 'preview-label', type: 'label', color: 'primary', label: 'Texas', alpha: 1, anchor: { lon: 0, lat: 0, height: 0 } };
  renderer.add(anno);
  await settle();
  // Non-unit, independent axis scales and a nonzero client offset: the
  // overlay uses preserveAspectRatio="none", not letterboxing.
  svg().getBoundingClientRect = () => ({ left: 10, top: 20, width: 640, height: 400 });
  renderer.sync();
  await settle();
  const [group] = groups();
  const callout = () => group.querySelector('.gev-anno-callout');
  const leader = group.querySelector('.gev-anno-leader');
  const dot = group.querySelector('.gev-anno-dot');
  const natural = callout().getAttribute('transform');
  const anchor = structuredClone(anno.anchor);
  panel.hidden = false;
  renderer.sync();
  await settle();
  assert.equal(callout().getAttribute('transform'), 'translate(418.0, 146.0)');
  assert.equal(leader.getAttribute('x2'), '418.0');
  assert.equal(leader.getAttribute('y2'), '172.0');
  assert.equal(leader.getAttribute('x1'), '400.0');
  assert.equal(leader.getAttribute('y1'), '200.0');
  assert.equal(dot.getAttribute('cx'), '400.0');
  assert.equal(dot.getAttribute('cy'), '200.0');
  assert.deepEqual(anno.anchor, anchor);
  assert.ok(groups()[0] === group, 'the group is kept, not replaced');
  panel.hidden = true;
  renderer.sync();
  await settle();
  assert.equal(callout().getAttribute('transform'), natural, 'closing Preview restores natural placement');
  for (const variant of ['settings', 'invisible', 'no-overlap', 'no-room', 'collision']) {
    panel.hidden = false;
    panel.dataset.view = variant === 'settings' ? 'settings' : 'preview';
    panelVisible = variant !== 'invisible';
    panelRect = variant === 'no-overlap'
      ? { left: 510, top: 120, width: 100, height: 120 }
      : variant === 'no-room'
        ? { left: 210, top: 25, width: 100, height: 180 }
        : { left: 210, top: 120, width: 100, height: 120 };
    if (variant === 'collision') renderer.add({ ...anno, id: 'above-slot', anchor: { lon: 0.001, lat: 0, height: 0 } });
    renderer.sync();
    await settle();
    assert.equal(callout().getAttribute('transform'), natural, variant);
  }
});

test('a mark hidden from Draw is not drawn or placed, and comes back when shown', async (t) => {
  // happy-dom measures every SVG box the same, so callout spreading cannot
  // settle here; a hidden mark simply has to stay out of drawing and
  // placement, which is what keeps it from pushing a visible callout aside.
  const { store, svg } = board(t);
  projectTo(t, { x: 200, y: 300 });
  const camera = cameraOver(0, 0);
  let project = null;
  const renderer = createScreenAnnotationRenderer(
    {
      scene: sceneFor(camera, {
        postRender: {
          addEventListener: (listener) => (project = listener),
          removeEventListener() {},
        },
      }),
      camera,
      trackedEntity: null,
    },
    { store, activeTrackedReadoutId: () => null },
  );
  t.after(() => renderer.destroy());
  const camp = {
    id: 'camp',
    type: 'pin',
    color: 'amber',
    label: 'Camp',
    alpha: 1,
    hidden: true,
    anchor: { lon: 0, lat: 0, height: 0 },
  };
  renderer.add(camp);
  project();
  await settle();
  const drawn = () =>
    [...svg().querySelectorAll('g.gev-anno')].some(
      (group) =>
        group.textContent.includes('Camp') && group.style.display !== 'none',
    );
  assert.equal(drawn(), false, 'the hidden mark is not drawn');
  camp.hidden = false;
  project();
  await settle();
  assert.equal(drawn(), true, 'shown again, it is drawn');
});
