// engine.movers on Navara. Sprites and points are one instanced quad mesh
// per set (moverMesh.js) in gev's overlay (overlay.js: drawn after tone
// mapping, so their colours are exact); models are a Navara mesh descriptor
// (public MeshDesc API) holding one InstancedMesh per glTF mesh
// (modelMover.js). In the cinematic look, depth stays in that scene and
// lit model colour resolves in the display pass. Pickable sets register a
// PickableInstancedMeshWrapper so Navara's pick pass sees each instance;
// pickIds.js turns its batch ids back into instances, and batchIds.js gives
// a removed set's ids to the next one. commit() uploads and
// asks for one frame (view.forceUpdate); per-frame work runs only on frames
// the view draws anyway, so an idle view stays idle.

import { withFrameUpdates } from '../frameDescriptor.js';
import {
  MeshDesc,
  PickableInstancedMeshWrapper,
  createGltfLoader,
} from '@navaramap/three';
import { Group } from 'three';
import { createMoverRegistry } from '../../movers.js';
import { createBatchIdPool } from './batchIds.js';
import { createModelMover } from './modelMover.js';
import { createMoverMesh } from './moverMesh.js';
import { createPickIndex } from './pickIds.js';
import { createMoverFrameCamera } from './frameCamera.js';
import { createNavaraOverlay } from '../overlay.js';

const DESC_NAME = 'gevMoverSet';
const registered = new WeakSet();

class GevMoverSetDesc extends withFrameUpdates(MeshDesc) {
  constructor(view, ctx, config) {
    super(view, ctx, config);
    this.gev = config[DESC_NAME];
    this.wrappers = [];
  }

  createMesh() {
    const { mover, pickable, onPickable, batchIds } = this.gev;
    const register = (mesh, key) => {
      if (!pickable) return;
      const wrapper = new PickableInstancedMeshWrapper(
        mesh,
        mesh.instanceMatrix.count,
        batchIds.source(this.ctx),
      );
      this.ctx.registerPickableMesh(key, wrapper);
      this.wrappers.push({ key, wrapper });
      onPickable(wrapper);
    };
    const group = new Group();
    group.frustumCulled = false;
    // Meshes arrive with the glTF; they join the group (and the pick pass).
    mover.group.onLoad = () => {
      if (this.destroyedByGev) return;
      for (const { key, wrapper } of this.wrappers) {
        this.ctx.unregisterPickableMesh(key);
        batchIds.release(wrapper);
      }
      this.wrappers.length = 0;
      this.gev.clearPickable();
      group.clear();
      mover.group.meshes.forEach((mesh, index) => {
        group.add(mesh);
        register(mover.group.pickMeshes[index], `${this.id}#${index}`);
      });
      this.view.forceUpdate();
    };
    if (mover.group.meshes.length) mover.group.onLoad();
    return group;
  }

  updateFrame(time) {
    updateMover(this.gev.readFrameCamera, this.ctx, this.gev.mover, time);
  }

  onDestroy() {
    this.destroyedByGev = true;
    this.gev.mover.group.onLoad = null;
    for (const { key } of this.wrappers) this.ctx.unregisterPickableMesh(key);
    this.gev.mover.dispose();
    for (const { wrapper } of this.wrappers) this.gev.batchIds.release(wrapper);
    super.onDestroy();
  }
}

function updateMover(readFrameCamera, ctx, mover, time) {
  const camera = readFrameCamera(ctx, time);
  if (camera) mover.update(camera);
}

/**
 * @param {object} view an initialised Navara ThreeView
 * @param {{ overlay: ReturnType<import('../overlay.js').createNavaraOverlay>, aces?: boolean }} ports
 * @returns {{ movers: import('../../contract.js').GlobeMovers,
 *   resolvePick: (batchId: number) => ({ set: string, instance: number, pickId: any } | null),
 *   destroy: () => void }}
 */
export function createNavaraMovers(view, { overlay, aces = false }) {
  if (!registered.has(view)) {
    view.registerMesh(DESC_NAME, GevMoverSetDesc);
    registered.add(view);
  }
  const pickIndex = createPickIndex();
  const batchIds = createBatchIdPool();
  const readFrameCamera = createMoverFrameCamera(view);
  let loader = null;
  const loadGltf = (url) => {
    loader ??= createGltfLoader();
    return loader.loadAsync(url);
  };
  let preSharpenOverlay = null,
    preSharpenUsers = 0;
  const request = () => view.forceUpdate();
  const overlaySet = (options, store) => {
    const targetOverlay = options.sharpen
      ? (preSharpenOverlay ??= createNavaraOverlay(view, {
          beforeSharpen: true,
        }))
      : overlay;
    if (options.sharpen) preSharpenUsers++;
    const mover = createMoverMesh(options, store, {
      onTextureLoad: request,
      overlayUniforms: targetOverlay.uniforms,
    });
    const key = `gevMovers:${options.id}`;
    let wrapper = null;
    if (options.pickable) {
      wrapper = new PickableInstancedMeshWrapper(
        mover.mesh,
        options.capacity,
        batchIds.source(targetOverlay.ctx),
      );
      targetOverlay.registerPickable(key, wrapper);
      pickIndex.add(options.id, wrapper, (index) => store.pickIds[index]);
    }
    targetOverlay.add(mover.mesh, (time) => {
      mover.uniforms.tGevGlobeDepth.value =
        targetOverlay.ctx.getGlobeDepthTexture();
      updateMover(readFrameCamera, targetOverlay.ctx, mover, time);
    });
    return {
      ready: mover.ready,
      failed: mover.failed,
      commit() {
        mover.commit(store.dirty());
        request();
      },
      destroy() {
        pickIndex.remove(options.id);
        if (options.pickable) targetOverlay.unregisterPickable(key);
        targetOverlay.remove(mover.mesh);
        mover.dispose();
        batchIds.release(wrapper);
        if (options.sharpen && --preSharpenUsers === 0) {
          preSharpenOverlay.destroy();
          preSharpenOverlay = null;
        }
        request();
      },
    };
  };
  const registry = createMoverRegistry((options, store) => {
    if (options.kind !== 'model') return overlaySet(options, store);
    const mover = createModelMover(options, store, {
      load: loadGltf,
      onLoad: request,
      overlay: aces ? overlay : null,
    });
    const handle = view.addMesh({
      [DESC_NAME]: {
        mover,
        readFrameCamera,
        kind: options.kind,
        pickable: options.pickable,
        batchIds,
        clearPickable: () => pickIndex.remove(options.id),
        onPickable: (wrapper) =>
          pickIndex.add(options.id, wrapper, (index) => store.pickIds[index]),
      },
    });
    return {
      ready: mover.ready,
      failed: mover.failed,
      pickRadiusPx: mover.pickRadiusPx,
      commit() {
        mover.commit(store.dirty());
        request();
      },
      destroy() {
        pickIndex.remove(options.id);
        handle.delete();
        // A descriptor deleted before its first update may never own a mesh.
        // Release the pending load as well; dispose is idempotent.
        mover.dispose();
        request();
      },
    };
  });
  return {
    movers: registry.movers,
    resolvePick: (batchId) => pickIndex.resolve(batchId),
    /** The live sets' options and stores, for CPU picks. */
    pickables: () =>
      [...registry.sets.values()].map(({ options, store, part }) => ({
        options,
        store,
        // Models: the drawn radius the CPU checks a model hit against.
        pickRadiusPx: part?.pickRadiusPx ?? null,
      })),
    destroy: () => registry.destroyAll(),
  };
}
