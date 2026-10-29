import test from 'node:test';
import assert from 'node:assert/strict';
import { Mesh } from 'three';
import { createInstallationsNavaraRenderer } from './navara.js';

test('selected installation fill is reused and removed with its scene resources', () => {
  const record = {
    id: 'osm:way:12',
    longitude: 179.9,
    latitude: 70,
    class: 'military_land',
    footprint: [
      [179.88, 69.99],
      [179.92, 69.99],
      [179.92, 70.01],
      [179.88, 70.01],
    ],
  };
  const state = {
    enabled: true,
    records: [record],
    recordById: new Map([[record.id, record]]),
    selectedId: null,
  };
  const color = {
    red: 0.6,
    green: 0.6,
    blue: 0.6,
    alpha: 1,
    toCssColorString: () => '#9ca6b0',
  };
  const contexts = new Map();
  let selectedContext = null;
  const services = {
    context: {
      getSelectedEntityContext: () => selectedContext,
      registerEntityContext: (entity, value) => contexts.set(value.id, entity),
      selectEntityContext: (entity) => {
        selectedContext = {
          id: entity.gevContextId,
          layerId: 'military-installations',
        };
      },
      removeEntityContextsForLayer() {},
      clearSelectedEntityContextForLayer() {},
    },
    picking: { registerPickOwner() {}, unregisterPickOwner() {} },
  };
  const sets = [];
  const engine = {
    movers: {
      createSet(options) {
        const set = {
          options,
          setCount() {},
          set() {},
          commit() {},
          destroy() {},
        };
        sets.push(set);
        return set;
      },
    },
    camera: { height: () => 1_000 },
    render: { request() {} },
  };
  let effectConfig;
  let deletedEffects = 0;
  const view = {
    canvas: { clientHeight: 800 },
    camera: { raw: { fov: 60 } },
    registerEffect() {},
    addEffect(config) {
      effectConfig = config;
      return {
        update() {},
        delete() {
          deletedEffects++;
        },
      };
    },
  };
  let meshCount = 0;
  class TestDrapedMesh extends Mesh {
    constructor(geometry, material) {
      super(geometry, material);
      meshCount++;
    }
  }
  class TestEffectDesc {}
  const parts = {
    model: {
      colorFor: () => color,
      installationSurfaceHeightM: () => 0,
      installationSourceLabel: () => 'OpenStreetMap',
    },
    namedMarkers: { sync() {}, enable() {}, hide() {}, destroy() {} },
    viewport: { clearUnavailableRetry() {} },
    ingestion: { setInstallationStatus() {} },
  };
  const renderer = createInstallationsNavaraRenderer(engine, {
    state,
    services,
    parts,
    source: {},
    overlayHost: {
      setVisible() {},
      setEntries() {},
      clearSource() {},
    },
    view,
    EffectDesc: TestEffectDesc,
    NavaraEffect: class {},
    DrapedMesh: TestDrapedMesh,
    setupMaterialForDrape() {},
  });

  renderer.lifecycle.methods.enable();
  assert.equal(
    meshCount,
    1,
    'the ordinary outline is present before selection',
  );
  assert.equal(renderer.selection.selectRecord(record.id), true);
  assert.equal(meshCount, 2, 'selection adds one fill beside the outline');
  const mesh = [...effectConfig.gevInstallationsDrape.owner.meshes].find(
    (item) => !item.userData.installationOutline,
  );
  let disposed = false;
  mesh.geometry.addEventListener('dispose', () => {
    disposed = true;
  });
  const scene = {
    add(child) {
      child.parent = this;
    },
    remove(child) {
      child.parent = null;
    },
  };
  scene.add(mesh);
  renderer.rendering.renderRecords();
  assert.equal(meshCount, 2, 'an unchanged selection keeps its geometry');

  renderer.rendering.clearSelectionFill();
  assert.equal(mesh.parent, null);
  assert.equal(disposed, true);
  assert.equal(
    [...effectConfig.gevInstallationsDrape.owner.meshes].some(
      (item) => item.userData.installationOutline,
    ),
    true,
    'clearing selection preserves the ordinary outline',
  );
  assert.equal(sets.length, 3);
  renderer.lifecycle.methods.destroy();
  assert.equal(deletedEffects, 1, 'destroy deletes the public effect handle');
  assert.equal(effectConfig.gevInstallationsDrape.owner.meshes.size, 0);
});
