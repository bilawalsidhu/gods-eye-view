/** Scene-only ownership shared by the observed aircraft layers. Source
 * requests, classification, selection and track history outlive this binding. */
export function createAircraftSceneBinding({
  id,
  flightState,
  services,
  parts,
  resolveModel,
  enable,
}) {
  let resumeFollow = false;
  // The tracked aircraft's selection origin outlives the renderer, as the
  // tracking itself does.
  let resumeOrigin = 'programmatic';
  function removeSceneListeners() {
    parts.tracking._removeClickHandler();
    services.picking.unregisterPickOwner(id, flightState._renderer?.engine);
    if (flightState._preRenderRemove) {
      flightState._preRenderRemove();
      flightState._preRenderRemove = null;
    }
    if (flightState._trackedModelPreUpdateRemove) {
      flightState._trackedModelPreUpdateRemove();
      flightState._trackedModelPreUpdateRemove = null;
    }
    if (flightState._moveEndRemove) {
      flightState._moveEndRemove();
      flightState._moveEndRemove = null;
    }
  }

  const methods = {
    attachRenderer(viewer, { engine = null } = {}) {
      if (!flightState.initialized)
        throw new Error('Initialize the flight layer before attaching');
      if (flightState._renderer)
        throw new Error('Flight renderer already attached');
      const renderer = services.renderer.create({ viewer, engine });
      flightState._renderer = renderer;
      try {
        renderer.fleet.attach();
        // Warm the glTF cache so the tracked plane's model instantiates instantly when first needed
        // (keeps the retained instance referenced; never rendered). Captured against this epoch so a
        // destroy/re-init mid-load doesn't flip the flag for a torn-down lifecycle.
        if (!flightState._preloadModel) {
          const epoch = flightState._modelEpoch;
          renderer.models
            .preload(resolveModel())
            .then((m) => {
              if (epoch === flightState._modelEpoch) {
                flightState._preloadModel = m;
                flightState._planeModelLoaded = true;
              } else {
                renderer.models.destroy(m);
              }
            })
            .catch(() => {
              /* tracked plane just stays a billboard a beat longer */
            });
        }
        parts.snapshots.presentRecords();
        if (flightState._trackedIcao) {
          parts.tracking._trackFlight(flightState._trackedIcao, {
            origin: resumeOrigin,
            resume: true,
            follow: resumeFollow,
          });
        }
        renderer.fleet.setVisible(flightState.enabled);
        renderer.models.setVisible(flightState.enabled);
        renderer.fleet.restoreOrder();
        if (flightState.enabled) {
          enable();
          parts.tracking._applyPendingTrackingRestore();
        }
      } catch (error) {
        methods.detachRenderer(viewer);
        throw error;
      }
    },

    detachRenderer(viewer) {
      const renderer = flightState._renderer;
      if (!renderer) return;
      removeSceneListeners();
      services.render.releaseContinuousRender(
        id,
        flightState._renderer?.engine,
      );
      flightState._trackedCameraFrameStop?.();
      flightState._trackedCameraFrameStop = null;
      if (flightState._trackedEntity) {
        resumeOrigin =
          flightState._trackedEntity.gevSelectionOrigin ?? 'programmatic';
        resumeFollow = renderer.follow.isFollowing(flightState._trackedEntity);
        if (resumeFollow) renderer.follow.release();
        renderer.tracked.remove(flightState._trackedEntity);
        flightState._trackedEntity = null;
      }
      parts.rendering._releaseTrackedModel();
      parts.tracking._detachTrail();
      parts.rendering._releaseModels();
      // Removing the model collection destroys it and its models.
      renderer.fleet.detach(viewer);
      flightState._modelEpoch += 1; // invalidate any in-flight load from this lifecycle (settles post-destroy)
      flightState._modelPending.clear();
      flightState._modelGen.clear();
      if (flightState._preloadModel) {
        renderer.models.destroy(flightState._preloadModel);
        flightState._preloadModel = null;
      }
      flightState._planeModelLoaded = false;
      flightState._billboards.clear();
      flightState._cullPositions.clear();
      flightState._detectionObjects.clear();
      flightState._displayFloorState?.clear();
      flightState._groundSnap.clear();
      parts.motion._resetTrackedDisplay();
      renderer.destroy();
      flightState._renderer = null;
    },

    removeSceneListeners,
  };
  return methods;
}
