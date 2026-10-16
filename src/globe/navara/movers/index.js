// engine.movers on Navara: each set is one Navara mesh descriptor (public
// MeshDesc API) holding its instanced meshes (moverMesh.js, modelMover.js).
// Pickable sets register a PickableInstancedMeshWrapper so Navara's pick
// pass sees each instance; pickIds.js turns its batch ids back into
// instances. commit() uploads and asks for one frame (view.forceUpdate): a
// descriptor's update() runs only on frames the view draws anyway (S5), so
// an idle view stays idle.

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

  // Sprites and points are screen overlays: the transparent pass, unlit.
  getPassKey() {
    return this.gev?.kind === 'model' ? super.getPassKey() : 'transparent';
  }

  createMesh() {
    const { mover, pickable, onPickable, kind } = this.gev;
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
    if (kind !== 'model') {
      register(mover.mesh, this.id);
      return mover.mesh;
    }
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
    const raw = this.view.camera.raw;
    const height = this.ctx.getRenderer().domElement.clientHeight;
    if (!raw || !(height > 0)) return;
    raw.updateMatrixWorld();
    const e = raw.matrixWorld.elements;
    const cameraPosition = { x: e[12], y: e[13], z: e[14] };
    const cameraHeight =
      Math.hypot(cameraPosition.x, cameraPosition.y, cameraPosition.z) -
      EARTH_RADIUS_M;
    this.gev.mover.update({
      cameraPosition,
      cameraHeight,
      fovDeg: raw.fov,
      viewportHeightPx: height,
    });
  }

  onDestroy() {
    this.destroyedByGev = true;
    for (const key of this.wrappers) this.ctx.unregisterPickableMesh(key);
    this.gev.mover.dispose();
    super.onDestroy();
  }
}

/**
 * @param {object} view an initialised Navara ThreeView
 * @returns {{ movers: import('../../contract.js').GlobeMovers,
 *   resolvePick: (batchId: number) => ({ set: string, instance: number, pickId: any } | null),
 *   destroy: () => void }}
 */
export function createNavaraMovers(view) {
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
  const registry = createMoverRegistry((options, store) => {
    const mover =
      options.kind === 'model'
        ? createModelMover(options, store, { load: loadGltf, onLoad: request })
        : createMoverMesh(options, store, { onTextureLoad: request });
    const handle = view.addMesh({
      ...(options.kind === 'model' ? {} : { lit: false }),
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
    destroy: () => registry.destroyAll(),
  };
}
