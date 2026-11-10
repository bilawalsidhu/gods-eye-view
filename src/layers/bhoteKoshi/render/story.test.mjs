import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { GROUND_HARNESSES } from '../../../testSupport/groundDisplayEngines.mjs';
import { drawStorySource } from './story.js';

for (const make of GROUND_HARNESSES) {
  const name = make.name;
  test(`story reveal, materials, holes and lifecycle (${name})`, (t) => {
    const h = make();
    t.after(() => h.destroy());
    const source = new Cesium.CustomDataSource('story');
    let path = Cesium.Cartesian3.fromDegreesArray([85, 28, 85.1, 28.1]);
    let alpha = 0.38;
    const halo = source.entities.add({
      id: 'halo',
      polyline: {
        positions: new Cesium.CallbackProperty(() => path, false),
        width: 18,
        classificationType: Cesium.ClassificationType.TERRAIN,
        material: new Cesium.PolylineDashMaterialProperty({
          color: new Cesium.CallbackProperty(
            () => new Cesium.Color(0.8, 0.5, 0.3, alpha),
            false,
          ),
          dashLength: 18,
        }),
      },
    });
    source.entities.add({
      id: 'core',
      polyline: {
        positions: new Cesium.CallbackProperty(() => path, false),
        width: 5,
        material: new Cesium.PolylineGlowMaterialProperty({
          color: Cesium.Color.CYAN.withAlpha(0.96),
          glowPower: 0.24,
          taperPower: 0.7,
        }),
      },
    });
    const ring = Cesium.Cartesian3.fromDegreesArray([
      85, 28, 86, 28, 86, 29, 85, 29,
    ]);
    const hole = Cesium.Cartesian3.fromDegreesArray([
      85.2, 28.2, 85.8, 28.2, 85.8, 28.8,
    ]);
    source.entities.add({
      id: 'fill',
      polygon: {
        hierarchy: new Cesium.PolygonHierarchy(ring, [
          new Cesium.PolygonHierarchy(hole),
        ]),
        material: Cesium.Color.CYAN.withAlpha(0.055),
      },
    });
    const before = h.engine.frames.preRender.numberOfListeners;
    const display = drawStorySource(h.engine, source);
    const frame = () => h.engine.fake.frame();
    frame();
    assert.equal(h.sets(), 3);
    const haloSet = h.set('story-halo');
    assert.equal(haloSet.options.dynamic, true);
    assert.equal(haloSet.options.drape, 'terrain');
    assert.equal(haloSet.options.pickable, true);
    assert.equal(haloSet.items[0].pickId, halo);
    let picked;
    const offPick = h.engine.input.on(
      'click',
      (event) => {
        picked = event.picked?.id;
      },
      { pick: true },
    );
    h.click({ set: 'story-halo', instance: 0 });
    assert.equal(picked, halo);
    offPick();
    assert.equal(haloSet.items[0].widthPx, 18);
    assert.deepEqual(haloSet.items[0].dashPattern, {
      lengthPx: 18,
      pattern: 255,
    });
    assert.deepEqual(h.set('story-core').items[0].glow, {
      power: 0.24,
      taper: 0.7,
    });
    assert.equal(h.set('story-fill').items[0].rings.length, 2);
    assert.equal(h.set('story-fill').items[0].fill[3], 0.055);

    frame();
    assert.equal(
      h.set('story-halo').commits,
      1,
      'settled paths do not rebuild',
    );
    path.push(Cesium.Cartesian3.fromDegrees(85.2, 28.2));
    frame();
    assert.equal(
      h.set('story-halo').items[0].positions.length,
      3,
      'in-place reveal advances',
    );
    alpha = 0.2;
    frame();
    assert.equal(
      h.set('story-halo').items[0].color[3],
      0.2,
      'style-only changes draw',
    );
    source.show = false;
    frame();
    assert.ok(h.engine.ground.list().every((set) => !set.shown));
    source.show = true;
    halo.show = false;
    frame();
    assert.equal(h.set('story-halo').shown, false);
    assert.equal(h.set('story-core').shown, true);
    path = [];
    frame();
    assert.equal(
      h.set('story-core').shown,
      false,
      'empty reveal hides the corridor',
    );
    source.entities.removeAll();
    frame();
    assert.equal(h.sets(), 0);
    display.destroy();
    display.destroy();
    assert.equal(h.engine.frames.preRender.numberOfListeners, before);
  });

  test(`story points keep independent fill and outline animation (${name})`, (t) => {
    const h = make();
    t.after(() => h.destroy());
    const source = new Cesium.CustomDataSource('points');
    let size = 11;
    let outline = 0.85;
    source.entities.add({
      id: 'front',
      position: Cesium.Cartesian3.fromDegrees(85, 28, 900),
      point: {
        pixelSize: new Cesium.CallbackProperty(() => size, false),
        color: Cesium.Color.CYAN.withAlpha(0.2),
        outlineColor: new Cesium.CallbackProperty(
          () => Cesium.Color.BLACK.withAlpha(outline),
          false,
        ),
        outlineWidth: 3,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Infinity,
        scaleByDistance: new Cesium.NearFarScalar(100, 1, 100000, 0.8),
      },
    });
    const writes = [];
    const create = h.engine.movers.createSet;
    let options, pointSet;
    h.engine.movers.createSet = (input) => {
      options = input;
      const set = create(input);
      pointSet = set;
      const write = set.set;
      set.set = (index, fields) => {
        writes.push(fields);
        write(index, fields);
      };
      return set;
    };
    h.engine.projector.worldToWindow = () => ({ x: 1, y: 1 });
    let ground = 1200;
    h.engine.surface.sampleHeight = (_place, exclude) => {
      assert.deepEqual(exclude, [pointSet]);
      return ground;
    };
    const display = drawStorySource(h.engine, source);
    const frame = () => h.engine.fake.frame();
    frame();
    assert.equal(options.kind, 'point');
    assert.equal(options.depthTest, 'always');
    assert.deepEqual(options.point.scaleByDistance, [100, 1, 100000, 0.8]);
    assert.equal(options.point.outlinePx, 3);
    assert.ok(
      Math.abs(
        Cesium.Cartographic.fromCartesian(writes.at(-1).position).height - 1200,
      ) < 1e-6,
    );
    frame();
    const settled = writes.length;
    frame();
    assert.equal(writes.length, settled);
    ground = 1250;
    h.engine.fake.maps.terrainRevision++;
    frame();
    assert.ok(
      Math.abs(
        Cesium.Cartographic.fromCartesian(writes.at(-1).position).height - 1250,
      ) < 0.01,
    );
    size = 38;
    outline = 0.12;
    frame();
    assert.equal(writes.at(-1).scale, 38);
    assert.deepEqual(writes.at(-1).outlineColor, [0, 0, 0, 0.12]);
    assert.equal(writes.at(-1).color[3], 0.2);
    display.destroy();
    assert.equal(h.engine.movers.list().length, 0);
    const attached = drawStorySource(h.engine, source);
    frame();
    assert.equal(h.engine.movers.list().length, 1);
    attached.destroy();
  });
}
