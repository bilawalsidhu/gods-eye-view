import { inputFor } from '../../input/dispatcher.js';
import { modelHitNorad } from './stationModels.js';
import { onFollowChanged } from '../../data/followed.js';

export function createInteraction({
  state: layerState,
  services,
  parts,
  source,
}) {
  const { resolvePickId, isOwnedByOtherLayer, isUnderOtherCard } =
    services.picking;

  function _onKeyDown(e) {
    // The Cockpit owns Escape while it rides the tracked satellite.
    if (parts.cockpit?._cockpitHeld()) return;
    if (layerState._enabled && e.key === 'Escape' && layerState._trackedNorad) {
      parts.tracking._cancelPendingTrackingRestore();
      parts.tracking._clearTracking(false, { origin: 'user' });
    }
  }

  function _installClickHandler(viewer) {
    if (layerState._clickSubscription) return; // already installed

    // Cross-layer untrack (H2, mirror of flights): if ANOTHER layer (flights,
    // military, …) grabs the follow-camera, drop our tracking so the orbit ring /
    // tracked dot don't orphan — without touching viewer.trackedEntity (the
    // new owner controls it). Guarded so our OWN switch (viewer.trackedEntity
    // briefly undefined mid-_trackSatellite) doesn't self-clear.
    if (!layerState._trackedEntityChangedRemove) {
      layerState._trackedEntityChangedRemove = onFollowChanged(
        viewer,
        (followed) => {
          if (!layerState._enabled) return;
          if (
            layerState._trackedNorad &&
            layerState._viewer &&
            followed &&
            followed !== layerState._followTarget
          ) {
            parts.tracking._clearTracking(true, {
              origin: followed.selectionOrigin || 'programmatic',
            });
          }
        },
      );
    }

    layerState._clickSubscription = inputFor(viewer).onClick((event) => {
      if (!layerState._enabled) return;
      // The Cockpit camera rides the tracked satellite: a click on the
      // picture below must not untrack it or switch satellites.
      if (parts.cockpit?._cockpitHeld()) return;
      // Another layer's card or label painted on top takes the click: the item
      // under it does not act, and the click is not empty space either.
      if (isUnderOtherCard?.(event)) return;
      const picked = event.topHit;
      const hit = event.drawHit;

      // Clicking the tracked satellite's own dot — ignore
      if (parts.rendering._hitIsTracked(hit)) return;

      // A satellite dot (its item id is the NORAD catalog number)
      const noradId = parts.rendering._hitPointId(hit);
      if (noradId !== null && layerState._catalog.has(noradId)) {
        parts.tracking._cancelPendingTrackingRestore();
        parts.tracking._trackSatellite(noradId, { origin: 'user' });
        return;
      }
      // A station's 3D model (stationModel.js) names its station. A click
      // on the tracked station's own model is already tracked; on another
      // station's model it tracks that one.
      const modelNorad = modelHitNorad(parts, hit);
      if (modelNorad !== null) {
        if (modelNorad === layerState._trackedNorad) return;
        if (layerState._catalog.has(modelNorad)) {
          parts.tracking._cancelPendingTrackingRestore();
          parts.tracking._trackSatellite(modelNorad, { origin: 'user' });
          return;
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
    });

    document.addEventListener('keydown', _onKeyDown);
  }
  return { _onKeyDown, _installClickHandler };
}
