/** Scene-only ownership shared by the observed aircraft layers. Source
 * requests, classification, selection and track history outlive this binding. */
export function createAircraftSceneBinding({
  id,
  flightState,
  services,
  parts,
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
    cameraOwner: {
      suspend() {},
      resume() {
        if (!flightState._renderer) return;
        if (flightState._trackedIcao) {
          parts.tracking._trackFlight(flightState._trackedIcao, {
            origin: resumeOrigin,
            resume: true,
            follow: resumeFollow,
          });
        }
        if (flightState.enabled) parts.tracking._applyPendingTrackingRestore();
      },
    },
    show(enabled) {
      flightState._renderer?.fleet.setVisible(enabled);
      flightState._renderer?.models.setVisible(enabled);
    },
    attachRenderer({ engine = null, viewRestored } = {}) {
      if (!flightState.initialized)
        throw new Error('Initialize the flight layer before attaching');
      if (flightState._renderer)
        throw new Error('Flight renderer already attached');
      const renderer = services.renderer.create({ engine });
      flightState._renderer = renderer;
      try {
        renderer.fleet.attach();
        parts.snapshots.presentRecords();
        renderer.fleet.setVisible(flightState.enabled);
        renderer.models.setVisible(flightState.enabled);
        renderer.fleet.restoreOrder();
        if (!viewRestored) methods.cameraOwner.resume();
        if (flightState.enabled) {
          enable();
        }
      } catch (error) {
        methods.detachRenderer();
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
      flightState._modelEpoch += 1; // Ignore loads from the detached scene.
      flightState._modelPending.clear();
      flightState._modelGen.clear();
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
