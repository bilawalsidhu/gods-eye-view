import * as Cesium from 'cesium';
import { isPointerFree } from '../../data/inputOwnership.js';

export function createInteraction({
  state: layerState,
  services,
  parts,
  source,
}) {
  const { resolvePickId, isOwnedByOtherLayer } = services.picking;

  function _onKeyDown(e) {
    if (layerState._enabled && e.key === 'Escape' && layerState._trackedNorad) {
      parts.tracking._cancelPendingTrackingRestore();
      parts.tracking._clearTracking(false, { origin: 'user' });
    }
  }

  function _installClickHandler(viewer) {
    if (layerState._clickHandler) return; // already installed

    // Cross-layer untrack (H2, mirror of flights): if ANOTHER layer (flights,
    // military, …) grabs the follow-camera, drop our tracking so the orbit ring /
    // tracked entity don't orphan — without touching viewer.trackedEntity (the
    // new owner controls it). Guarded so our OWN switch (viewer.trackedEntity
    // briefly undefined mid-_trackSatellite) doesn't self-clear.
    if (!layerState._trackedEntityChangedRemove) {
      layerState._trackedEntityChangedRemove =
        viewer.trackedEntityChanged.addEventListener(() => {
          if (!layerState._enabled) return;
          if (
            layerState._trackedNorad &&
            layerState._viewer &&
            layerState._viewer.trackedEntity &&
            layerState._viewer.trackedEntity !== layerState._trackedEntity
          ) {
            parts.tracking._clearTracking(true, {
              origin:
                layerState._viewer.trackedEntity?.gevSelectionOrigin ||
                'programmatic',
            });
          }
        });
    }

    layerState._clickHandler = new Cesium.ScreenSpaceEventHandler(
      viewer.scene.canvas,
    );
    layerState._clickHandler.setInputAction((click) => {
      // A tool owns the pointer (src/data/inputOwnership.js): yield the click.
      if (!isPointerFree()) return;
      if (!layerState._enabled) return;
      const picked = viewer.scene.pick(click.position);

      if (picked) {
        // Clicking tracked entity itself — ignore
        if (picked.id === layerState._trackedEntity) return;

        // Check if it's a satellite point (id is NORAD catalog number)
        const prim = picked.primitive;
        if (prim && prim.id != null) {
          const noradId = Number(prim.id);
          if (!isNaN(noradId) && layerState._catalog.has(noradId)) {
            parts.tracking._cancelPendingTrackingRestore();
            parts.tracking._trackSatellite(noradId, { origin: 'user' });
            return;
          }
        }
      }

      // A pick that belongs to a sibling layer (plane, vessel, station, CCTV
      // camera…) is not "empty space" — leave OUR tracking (and crucially
      // viewer.trackedEntity, which that sibling may have JUST set) alone (H2).
      if (picked) {
        const pickedId = resolvePickId(picked);
        if (pickedId && isOwnedByOtherLayer('satellites', pickedId)) return;
      }

      // Clicked empty space — deselect
      if (layerState._trackedNorad) {
        parts.tracking._cancelPendingTrackingRestore();
        parts.tracking._clearTracking(false, { origin: 'user' });
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

    document.addEventListener('keydown', _onKeyDown);
  }
  return { _onKeyDown, _installClickHandler };
}
