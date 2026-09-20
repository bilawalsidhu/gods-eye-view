// src/annotations/worldAnnotationRenderer.test.mjs
// Drives the world-space annotation renderer headless against a fake viewer
// and the REAL Cesium Entity graph: entities added through a real
// CustomDataSource are inspected through their public Property surface
// (hierarchies, materials, positions) — no WebGL scene involved. Cesium's
// Material factory touches the DOM's canvas/image classes even when the
// fabric is pure GLSL, so the browser globals are stubbed per test the same
// way hybridAnnotationRenderer.test.mjs does.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createWorldAnnotationRenderer } from './worldAnnotationRenderer.js';

/** Browser globals Cesium's resource pipeline touches; restored after each test. */
function stubBrowserGlobals() {
  const originals = new Map([
    ['document', globalThis.document],
    ['HTMLCanvasElement', globalThis.HTMLCanvasElement],
    ['HTMLImageElement', globalThis.HTMLImageElement],
    ['ImageBitmap', globalThis.ImageBitmap],
    ['OffscreenCanvas', globalThis.OffscreenCanvas],
  ]);
  class FakeCanvas { constructor() { this.width = 2; this.height = 2; } getContext() { return new Proxy({}, { get: () => () => undefined }); } }
  globalThis.HTMLCanvasElement = FakeCanvas;
  globalThis.HTMLImageElement = class HTMLImageElement {};
  globalThis.ImageBitmap = class ImageBitmap {};
  globalThis.OffscreenCanvas = class OffscreenCanvas {};
  globalThis.document = {
    createElement: () => new FakeCanvas(),
    createElementNS: () => new FakeCanvas(),
  };
  return () => {
    for (const [name, prior] of originals) globalThis[name] = prior;
  };
}

/** Fake viewer: records data-source ops; camera height drives ring sizing. */
function fakeViewer({ cameraHeight = 1000, scene = {} } = {}) {
  const ops = { added: [], removed: [] };
  return {
    camera: { positionCartographic: { height: cameraHeight } },
    scene,
    dataSources: {
      add: (ds) => ops.added.push(ds),
      remove: (ds, destroy) => { ops.removed.push({ ds, destroy }); return true; },
    },
    ops,
  };
}

const RING = [[0, 0], [0.001, 0], [0.001, 0.001], [0, 0.001], [0, 0]];
const PIN = { type: 'pin', anchor: { lon: 11.5, lat: 48.1, height: 516 }, label: 'Depot' };

/** The renderer's `add()` return contract is nothing — the entities land on the anno. */
function entitiesOf(anno) {
  assert.ok(Array.isArray(anno._entities), 'the anno carries its published entity list');
  return anno._entities;
}

const materialOf = (graphic) => graphic.material;
const staticNumber = (property) => property.getValue(undefined);

test('the factory installs one annotation data source and destroy removes it', () => {
  const restore = stubBrowserGlobals();
  try {
    const viewer = fakeViewer();
    const renderer = createWorldAnnotationRenderer(viewer);
    assert.equal(typeof renderer.add, 'function');
    assert.equal(typeof renderer.remove, 'function');
    assert.equal(typeof renderer.sync, 'function');
    assert.equal(typeof renderer.destroy, 'function');
    assert.equal(viewer.ops.added.length, 1);
    assert.ok(viewer.ops.added[0] instanceof Cesium.CustomDataSource);
    assert.equal(viewer.ops.added[0].name, 'gev-annotations');
    renderer.destroy();
    assert.deepEqual(viewer.ops.removed, [{ ds: viewer.ops.added[0], destroy: true }]);
  } finally {
    restore();
  }
});

test('a building footprint renders an extruded classification volume, a decimated cage, and a glow base', () => {
  const restore = stubBrowserGlobals();
  try {
    const viewer = fakeViewer();
    const renderer = createWorldAnnotationRenderer(viewer);
    const dataSource = viewer.ops.added[0];
    const anno = {
      type: 'highlight',
      anchor: { lon: 11.5, lat: 48.1, height: 40 },
      ring: RING,
      footprintKind: 'building',
      buildingHeight: 25,
      label: 'Tower',
      color: 'amber',
    };
    renderer.add(anno);
    const entities = entitiesOf(anno);
    assert.equal(entities.length, 4, 'volume + cage + base outline + label');
    assert.equal(dataSource.entities.values.length, 4, 'all entities live in the shared data source');

    const [volume, cage, base] = entities;
    // Classification volume: extrudes from a ground base to clear the roof.
    assert.equal(volume.polygon.classificationType.getValue(undefined), Cesium.ClassificationType.CESIUM_3D_TILE);
    assert.equal(staticNumber(volume.polygon.height), 12, 'base = sampled ground (15) minus 3 m of margin');
    assert.equal(staticNumber(volume.polygon.extrudedHeight), 64, 'top = ground + buildingHeight + 24 m of headroom');
    const hierarchy = volume.polygon.hierarchy.getValue(undefined);
    assert.ok(hierarchy instanceof Cesium.PolygonHierarchy);
    assert.equal(hierarchy.positions.length, RING.length, 'the ring is buffered, not resampled');

    // Cage: outline-only, decimated to at most 14 verticals.
    assert.equal(staticNumber(cage.polygon.fill), false);
    assert.equal(staticNumber(cage.polygon.outline), true);
    assert.ok(cage.polygon.hierarchy.getValue(undefined).positions.length <= 14);

    // Base outline drapes on the tiles with a glow material.
    assert.equal(staticNumber(base.polyline.clampToGround), true);
    assert.ok(base.polyline.material instanceof Cesium.PolylineGlowMaterialProperty);
  } finally {
    restore();
  }
});

test('the building base height prefers ground sampling and falls back to the anchor datum', () => {
  const restore = stubBrowserGlobals();
  try {
    // Ground sampling supported: the first probe lands on something tall
    // (a roof), the rest report true ground — the low-percentile sample
    // must outvote the tall outlier.
    let probe = 0;
    const samplingScene = {
      clampToHeightSupported: true,
      clampToHeight: () => {
        probe += 1;
        return Cesium.Cartesian3.fromDegrees(0, 0, probe === 1 ? 100 : 12);
      },
    };
    const renderer = createWorldAnnotationRenderer(fakeViewer({ scene: samplingScene }));
    const anno = {
      type: 'highlight',
      anchor: { lon: 0, lat: 0, height: 112 },
      ring: RING,
      footprintKind: 'building',
      buildingHeight: 25,
    };
    renderer.add(anno);
    const [volume] = entitiesOf(anno);
    assert.equal(staticNumber(volume.polygon.height), 9, 'ground 12 → base 9; the 100 m probe is outvoted');
    assert.equal(staticNumber(volume.polygon.extrudedHeight), 61, '12 + default 25 m height + 24 m headroom');

    // Sampling unavailable → the anchor datum minus the building height.
    const fallback = createWorldAnnotationRenderer(fakeViewer());
    const anno2 = {
      type: 'highlight',
      anchor: { lon: 0, lat: 0, height: 40 },
      ring: RING,
      footprintKind: 'building',
      buildingHeight: 30,
    };
    fallback.add(anno2);
    const [volume2] = entitiesOf(anno2);
    assert.equal(staticNumber(volume2.polygon.height), 7, '40 − 30 − 3');
  } finally {
    restore();
  }
});

test('invalid ground samples are rejected wholesale and the anchor fallback takes over', () => {
  const restore = stubBrowserGlobals();
  try {
    // Every probe is unusable: below-seafloor, above-max, NaN, and null. The
    // valid band is (−430, 9000) — all eight probes fall outside it.
    let probe = 0;
    const junkScene = {
      clampToHeightSupported: true,
      clampToHeight: () => {
        const rejection = probe % 4;
        probe += 1;
        if (rejection === 0) return Cesium.Cartesian3.fromDegrees(0, 0, -500);
        if (rejection === 1) return Cesium.Cartesian3.fromDegrees(0, 0, 9999);
        if (rejection === 2) return Cesium.Cartesian3.fromDegrees(0, 0, Number.NaN);
        return null;
      },
    };
    const renderer = createWorldAnnotationRenderer(fakeViewer({ scene: junkScene }));
    const anno = {
      type: 'highlight',
      anchor: { lon: 0, lat: 0, height: 50 },
      ring: RING,
      footprintKind: 'building',
      buildingHeight: 25,
    };
    renderer.add(anno);
    const [volume] = entitiesOf(anno);
    assert.equal(staticNumber(volume.polygon.height), 22, 'fallback: 50 − 25 − 3');
  } finally {
    restore();
  }
});

test('an area annotation drapes a fill + outline; synthesized areas dash and fade', () => {
  const restore = stubBrowserGlobals();
  try {
    const viewer = fakeViewer();
    const renderer = createWorldAnnotationRenderer(viewer);
    const real = {
      type: 'highlight', anchor: { lon: 0, lat: 0, height: 0 },
      ring: RING, label: 'Compound', color: 'green',
    };
    renderer.add(real);
    const [fill, outline] = entitiesOf(real);
    assert.equal(fill.polygon.classificationType.getValue(undefined), Cesium.ClassificationType.CESIUM_3D_TILE);
    assert.ok(outline.polyline.material instanceof Cesium.PolylineGlowMaterialProperty, 'a real boundary glows');
    // Fill alpha 0.20 × live pulse (0.6..1.0): reads solid but never blinks out.
    const fillAlpha = materialOf(fill.polygon).color.getValue(undefined).alpha;
    assert.ok(fillAlpha > 0.20 * 0.6 - 1e-9 && fillAlpha <= 0.20 + 1e-9, `fill alpha ${fillAlpha} within pulse band`);

    const synthesized = {
      type: 'highlight', anchor: { lon: 1, lat: 1, height: 0 },
      ring: RING, synthesized: true,
    };
    renderer.add(synthesized);
    const [sFill, sOutline] = entitiesOf(synthesized);
    assert.ok(sOutline.polyline.material instanceof Cesium.PolylineDashMaterialProperty,
      'a synthesized boundary is dashed to signal approximation');
    const sAlpha = materialOf(sFill.polygon).color.getValue(undefined).alpha;
    assert.ok(sAlpha > 0.10 * 0.6 - 1e-9 && sAlpha <= 0.10 + 1e-9, `synthesized alpha ${sAlpha} is half as strong`);
  } finally {
    restore();
  }
});

test('a route renders the flowing-dash material whose uniforms are written per frame', () => {
  const restore = stubBrowserGlobals();
  try {
    const viewer = fakeViewer();
    const renderer = createWorldAnnotationRenderer(viewer);
    const anno = {
      type: 'route',
      anchor: { lon: 0, lat: 0, height: 0 },
      path: [{ lon: 0, lat: 0 }, { lon: 0.5, lat: 0.5 }, { lon: 1, lat: 0.25 }],
      label: 'Ingress',
      color: 'cyan',
    };
    renderer.add(anno);
    const [route, label] = entitiesOf(anno);
    assert.equal(staticNumber(route.polyline.clampToGround), true);
    const material = route.polyline.material;
    assert.equal(material.getType(), 'GevRouteFlow');
    assert.equal(material.isConstant, false, 'the route re-evaluates every frame so it can flow');
    const uniforms = material.getValue(undefined, {});
    assert.equal(uniforms.repeat, 64);
    assert.equal(uniforms.duty, 0.46);
    assert.equal(uniforms.speed, 0.55);
    assert.ok(Number.isFinite(uniforms.time) && uniforms.time > 0, 'time is the wall clock, driving the flow');
    assert.ok(uniforms.color instanceof Cesium.Color);
    // getValue must also tolerate being called without a result object.
    const fresh = material.getValue(undefined);
    assert.equal(fresh.repeat, 64);
    assert.equal(staticNumber(label.label.text), 'Ingress');
    // Cesium's material cache compares properties with equals() before reusing
    // a shader/pipeline: identity semantics keep each route's uniforms (its own
    // color + flowing time) independent of every other route's.
    assert.equal(material.equals(material), true, 'a material equals itself');
    assert.equal(material.equals(new (material.constructor)('rgba(0,229,255,0.9)')), false,
      'another instance is never equal, even with the same color');
    assert.equal(material.equals(new Cesium.PolylineDashMaterialProperty()), false);
  } finally {
    restore();
  }
});

test('an arrow connects anchor to target and labels the midpoint', () => {
  const restore = stubBrowserGlobals();
  try {
    const viewer = fakeViewer();
    const renderer = createWorldAnnotationRenderer(viewer);
    const anno = {
      type: 'arrow',
      anchor: { lon: 0, lat: 0, height: 0 },
      to: { lon: 2, lat: 2 },
      label: 'link',
    };
    renderer.add(anno);
    const [line, labelEntity] = entitiesOf(anno);
    const positions = line.polyline.positions.getValue(undefined);
    assert.equal(positions.length, 2);
    assert.ok(line.polyline.material instanceof Cesium.PolylineArrowMaterialProperty);
    const mid = Cesium.Cartesian3.fromDegrees(1, 1);
    assert.ok(Cesium.Cartesian3.distance(labelEntity.position.getValue(undefined), mid) < 1e-6,
      'the label sits at the connector midpoint');
  } finally {
    restore();
  }
});

test('pins and highlights get a camera-proportional ring; labels get none', () => {
  const restore = stubBrowserGlobals();
  try {
    const close = createWorldAnnotationRenderer(fakeViewer({ cameraHeight: 100 }));
    const pin = { ...PIN, color: 'red' };
    close.add(pin);
    const [ellipse, marker] = entitiesOf(pin);
    assert.equal(staticNumber(ellipse.ellipse.semiMajorAxis), 14, 'near ground, the ring floors at 14 m');
    assert.equal(staticNumber(ellipse.ellipse.semiMinorAxis), 14, 'both axes read the same radius every frame');
    assert.equal(staticNumber(marker.point.pixelSize), 14, 'a pin carries a 14 px point');
    assert.equal(staticNumber(marker.label.text), 'Depot');

    const far = createWorldAnnotationRenderer(fakeViewer({ cameraHeight: 10_000 }));
    const pin2 = { ...PIN };
    far.add(pin2);
    const [ellipse2] = entitiesOf(pin2);
    assert.equal(staticNumber(ellipse2.ellipse.semiMajorAxis), 170, 'the ring caps at 170 m from orbit');

    const mid = createWorldAnnotationRenderer(fakeViewer({ cameraHeight: 1000 }));
    const pin3 = { ...PIN };
    mid.add(pin3);
    assert.equal(staticNumber(entitiesOf(pin3)[0].ellipse.semiMajorAxis), 30, '3% of camera height');

    const labelOnly = { type: 'label', anchor: { lon: 0, lat: 0, height: 0 }, label: 'Note' };
    mid.add(labelOnly);
    const labelEntities = entitiesOf(labelOnly);
    assert.equal(labelEntities.length, 1, 'a label annotation draws no ring');
    assert.equal(staticNumber(labelEntities[0].point.pixelSize), 8, 'a label point is the smaller 8 px dot');
    assert.equal(labelEntities[0].ellipse, undefined);
  } finally {
    restore();
  }
});

test('live alpha fades follow the anno and clamp to the legal color range', () => {
  const restore = stubBrowserGlobals();
  try {
    const renderer = createWorldAnnotationRenderer(fakeViewer({ cameraHeight: 1000 }));
    const invisible = { ...PIN, alpha: -2 };
    renderer.add(invisible);
    const [ellipse, marker] = entitiesOf(invisible);
    assert.equal(materialOf(ellipse.ellipse).color.getValue(undefined).alpha, 0,
      'a negative alpha bottoms out at fully transparent');
    assert.equal(marker.point.color.getValue(undefined).alpha, 0);

    const blazing = { ...PIN, alpha: 5 };
    renderer.add(blazing);
    const [ellipse2, marker2] = entitiesOf(blazing);
    assert.equal(materialOf(ellipse2.ellipse).color.getValue(undefined).alpha, 1,
      'an oversized alpha saturates at fully opaque, even with the pulse factor');
    assert.equal(marker2.point.color.getValue(undefined).alpha, 1);
  } finally {
    restore();
  }
});

test('remove() retracts exactly this annotation and tolerates repeats', () => {
  const restore = stubBrowserGlobals();
  try {
    const viewer = fakeViewer();
    const renderer = createWorldAnnotationRenderer(viewer);
    const dataSource = viewer.ops.added[0];
    const a = { ...PIN };
    const b = { ...PIN, label: 'Other' };
    renderer.add(a);
    renderer.add(b);
    assert.equal(dataSource.entities.values.length, 4, 'two pins, two entities each');
    const aEntities = [...a._entities];
    renderer.remove(a);
    assert.equal(a._entities, null, 'the entity list is released');
    assert.equal(dataSource.entities.values.length, 2, 'only the removed annotation went away');
    for (const entity of aEntities) {
      assert.equal(dataSource.entities.values.includes(entity), false);
    }
    renderer.remove(a); // second remove: no _entities, no throw
    renderer.remove({}); // never added: no throw
    assert.equal(dataSource.entities.values.length, 2);
    renderer.destroy();
  } finally {
    restore();
  }
});

test('a sprawling footprint is decimated to exactly the 14-vertical cage budget', () => {
  const restore = stubBrowserGlobals();
  try {
    const viewer = fakeViewer();
    const renderer = createWorldAnnotationRenderer(viewer);
    // 41 vertices (40 + closure) — far past the cage budget.
    const sprawl = [];
    for (let i = 0; i < 40; i += 1) {
      const a = (i / 40) * Math.PI * 2;
      sprawl.push([11.5 + 0.0004 * Math.cos(a), 48.1 + 0.0004 * Math.sin(a)]);
    }
    sprawl.push(sprawl[0]);
    const anno = {
      type: 'highlight',
      anchor: { lon: 11.5, lat: 48.1, height: 45 },
      ring: sprawl,
      footprintKind: 'building',
      buildingHeight: 25,
      label: 'Terminal',
    };
    renderer.add(anno);
    const [volume, cage] = entitiesOf(anno);
    assert.equal(volume.polygon.hierarchy.getValue(undefined).positions.length, sprawl.length,
      'the classification volume keeps every vertex of the footprint');
    assert.equal(cage.polygon.hierarchy.getValue(undefined).positions.length, 14,
      'the cage is evenly down-sampled to the budget, not truncated');
    // Down-sampling must span the ring, not just its head: the last cage
    // vertex sits at the bearing of a far-stride ring vertex, not vertex 13.
    // (The cage ring is the 3 m buffered copy, so bearings — which the buffer
    // preserves exactly — are the stable comparison, not raw distances.)
    const cageRing = cage.polygon.hierarchy.getValue(undefined).positions;
    const lastStride = Math.floor((13 * sprawl.length) / 14);
    assert.ok(lastStride > 13, 'sanity: the final stride lands past the head of the ring');
    const bearingOf = (lon, lat) => Math.atan2(lat - 48.1, lon - 11.5);
    const bearingOfCartesian = (cartesian) => {
      const c = Cesium.Cartographic.fromCartesian(cartesian);
      return Math.atan2(
        c.latitude - Cesium.Math.toRadians(48.1),
        c.longitude - Cesium.Math.toRadians(11.5),
      );
    };
    const got = bearingOfCartesian(cageRing.at(-1));
    assert.ok(Math.abs(got - bearingOf(sprawl[lastStride][0], sprawl[lastStride][1])) < 0.05,
      'the decimation stride reaches the far side of the ring');
    assert.ok(Math.abs(got - bearingOf(sprawl[13][0], sprawl[13][1])) > 0.2,
      'the cage is not simply the first 14 vertices');
  } finally {
    restore();
  }
});

test('teardown tolerates a scene that is already coming apart', () => {
  const restore = stubBrowserGlobals();
  try {
    const viewer = fakeViewer();
    const renderer = createWorldAnnotationRenderer(viewer);
    const anno = { ...PIN };
    renderer.add(anno);
    const count = anno._entities.length;
    assert.ok(count > 0, 'the pin published entities');
    const dataSource = viewer.ops.added[0];
    let entityRemovals = 0;
    dataSource.entities.remove = () => {
      entityRemovals += 1;
      throw new Error('entity collection detached');
    };
    renderer.remove(anno);
    assert.equal(entityRemovals, count, 'every entity was still attempted, not just the first');
    assert.equal(anno._entities, null, 'the list is released even though nothing was retracted');

    let sourceRemovals = 0;
    viewer.dataSources.remove = () => {
      sourceRemovals += 1;
      throw new Error('scene torn down');
    };
    renderer.destroy();
    assert.equal(sourceRemovals, 1, 'destroy still makes its one removal attempt');
  } finally {
    restore();
  }
});
