// engine.movers on Navara. Sprites and points are one instanced quad mesh
// per set (moverMesh.js) in gev's overlay (overlay.js: drawn after tone
// mapping, so their colours are exact); models are a Navara mesh descriptor
// (public MeshDesc API) holding one InstancedMesh per glTF mesh
// (modelMover.js), lit and graded like the scene. Pickable sets register a
// PickableInstancedMeshWrapper so Navara's pick pass sees each instance;
// pickIds.js turns its batch ids back into instances. commit() uploads and
// asks for one frame (view.forceUpdate); per-frame work runs only on frames
// the view draws anyway (S5), so an idle view stays idle.

import {
  MeshDesc,
  PickableInstancedMeshWrapper,
  createGltfLoader,
} from '@navaramap/three';
import { Group } from 'three';
import { createMoverRegistry } from '../../movers.js';
import { createModelMover } from './modelMover.js';
import { createMoverMesh } from './moverMesh.js';
import { createPickIndex } from './pickIds.js';

const DESC_NAME = 'gevMoverSet';
const registered = new WeakSet();
const EARTH_RADIUS_M = 6_371_000;

class GevMoverSetDesc extends MeshDesc {
  constructor(view, ctx, config) {
    super(view, ctx, config);
    this.gev = config[DESC_NAME];
    this.wrappers = [];
  }

  createMesh() {
    const { mover, pickable, onPickable } = this.gev;
    const register = (mesh, key) => {
      if (!pickable) return;
      const wrapper = new PickableInstancedMeshWrapper(
        mesh,
        mesh.instanceMatrix.count,
        this.ctx,
      );
      this.ctx.registerPickableMesh(key, wrapper);
      this.wrappers.push(key);
      onPickable(wrapper);
    };
    const group = new Group();
    group.frustumCulled = false;
    // Meshes arrive with the glTF; they join the group (and the pick pass).
    mover.group.ready.then(() => {
      if (this.destroyedByGev) return;
      mover.group.meshes.forEach((mesh, index) => {
        group.add(mesh);
        register(mesh, `${this.id}#${index}`);
      });
      this.view.forceUpdate();
    });
    return group;
  }

  update() {
    updateMover(this.view, this.ctx, this.gev.mover);
  }

  onDestroy() {
    this.destroyedByGev = true;
    for (const key of this.wrappers) this.ctx.unregisterPickableMesh(key);
    this.gev.mover.dispose();
    super.onDestroy();
  }
}

// The camera a mover needs each drawn frame (scratch: no allocation).
const frameCamera = {
  cameraPosition: { x: 0, y: 0, z: 0 },
  cameraHeight: 0,
  fovDeg: 60,
  viewportHeightPx: 0,
};
function updateMover(view, ctx, mover) {
  const raw = view.camera.raw;
  const height = ctx?.getRenderer().domElement.clientHeight;
  if (!raw || !(height > 0)) return;
  raw.updateMatrixWorld();
  const e = raw.matrixWorld.elements;
  const position = frameCamera.cameraPosition;
  position.x = e[12];
  position.y = e[13];
  position.z = e[14];
  frameCamera.cameraHeight =
    Math.hypot(position.x, position.y, position.z) - EARTH_RADIUS_M;
  frameCamera.fovDeg = raw.fov;
  frameCamera.viewportHeightPx = height;
  mover.update(frameCamera);
}

/**
 * @param {object} view an initialised Navara ThreeView
 * @param {{ overlay: ReturnType<import('../overlay.js').createNavaraOverlay> }} ports
 * @returns {{ movers: import('../../contract.js').GlobeMovers,
 *   resolvePick: (batchId: number) => ({ set: string, instance: number, pickId: any } | null),
 *   destroy: () => void }}
 */
export function createNavaraMovers(view, { overlay }) {
  if (!registered.has(view)) {
    view.registerMesh(DESC_NAME, GevMoverSetDesc);
    registered.add(view);
  }
  const pickIndex = createPickIndex();
  let loader = null;
  const loadGltf = (url) => {
    loader ??= createGltfLoader();
    return loader.loadAsync(url);
  };
  const request = () => view.forceUpdate();
  const overlaySet = (options, store) => {
    const mover = createMoverMesh(options, store, {
      onTextureLoad: request,
      overlayUniforms: overlay.uniforms,
    });
    const key = `gevMovers:${options.id}`;
    if (options.pickable) {
      const wrapper = new PickableInstancedMeshWrapper(
        mover.mesh,
        options.capacity,
        overlay.ctx,
      );
      overlay.registerPickable(key, wrapper);
      pickIndex.add(options.id, wrapper, (index) => store.pickIds[index]);
    }
    overlay.add(mover.mesh, () => updateMover(view, overlay.ctx, mover));
    return {
      commit() {
        mover.commit(store.dirty());
        request();
      },
      destroy() {
        pickIndex.remove(options.id);
        if (options.pickable) overlay.unregisterPickable(key);
        overlay.remove(mover.mesh);
        mover.dispose();
        request();
      },
    };
  };
  const registry = createMoverRegistry((options, store) => {
    if (options.kind !== 'model') return overlaySet(options, store);
    const mover = createModelMover(options, store, {
      load: loadGltf,
      onLoad: request,
    });
    const handle = view.addMesh({
      [DESC_NAME]: {
        mover,
        kind: options.kind,
        pickable: options.pickable,
        onPickable: (wrapper) =>
          pickIndex.add(options.id, wrapper, (index) => store.pickIds[index]),
      },
    });
    return {
      commit() {
        mover.commit(store.dirty());
        request();
      },
      destroy() {
        pickIndex.remove(options.id);
        handle.delete();
        request();
      },
    };
  });
  return {
    movers: registry.movers,
    resolvePick: (batchId) => pickIndex.resolve(batchId),
    /** The live sets' options and stores, for CPU picks. */
    pickables: () =>
      [...registry.sets.values()].map(({ options, store }) => ({
        options,
        store,
      })),
    destroy: () => registry.destroyAll(),
  };
}
