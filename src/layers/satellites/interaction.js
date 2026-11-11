import { isPointerFree } from '../../data/inputOwnership.js';

export function createInteraction({
  state: layerState,
  services,
  parts,
  source,
  getRenderer,
}) {
  const { resolvePickId, isOwnedByOtherLayer } = services.picking;

  function _onKeyDown(e) {
    // The Cockpit owns Escape while it rides the tracked satellite.
    if (parts.cockpit?._cockpitHeld()) return;
    if (layerState._enabled && e.key === 'Escape' && layerState._trackedNorad) {
      parts.tracking._cancelPendingTrackingRestore();
      parts.tracking._clearTracking(false, { origin: 'user' });
    }
  }

  function _installClickHandler() {
    if (layerState._clickHandler || !getRenderer()) return; // already installed

    // Cross-layer untrack (H2, mirror of flights): if ANOTHER layer (flights,
    // military, …) grabs the follow-camera, drop our tracking so the orbit ring /
    // tracked dot don't orphan — without releasing the follow (the new owner
    // controls it). Guarded so our OWN switch (the follow briefly null
    // mid-_trackSatellite) doesn't self-clear.
    if (!layerState._trackedEntityChangedRemove) {
      layerState._trackedEntityChangedRemove = getRenderer().follow.onChanged(
        () => {
          if (!layerState._enabled) return;
          if (
            layerState._trackedNorad &&
            getRenderer() &&
            ((getRenderer().follow.current() &&
              getRenderer().follow.current() !== layerState._trackedEntity) ||
              (!getRenderer().follow.current() &&
                !getRenderer().follow.releasing() &&
                !parts.cockpit?._cockpitHeld()))
          ) {
            parts.tracking._clearTracking(true, {
              origin:
                getRenderer().follow.current()?.gevSelectionOrigin ||
                'programmatic',
            });
          }
        },
      );
    }

    layerState._clickHandler = getRenderer().listenClick(
      ({ picked }) => {
        // A tool owns the pointer (src/data/inputOwnership.js): yield the click.
        if (!isPointerFree()) return;
        if (!layerState._enabled) return;
        // The Cockpit camera rides the tracked satellite: a click on the
        // picture below must not untrack it or switch satellites.
        if (parts.cockpit?._cockpitHeld()) return;

        if (picked) {
          // Clicking tracked entity itself — ignore
          if (getRenderer().isTrackedPick(picked, layerState._trackedEntity))
            return;

          // Check if it's a satellite point (id is NORAD catalog number)
          if (Number.isFinite(getRenderer().pickedNorad(picked))) {
            const noradId = getRenderer().pickedNorad(picked);
            if (!isNaN(noradId) && layerState._catalog.has(noradId)) {
              parts.tracking._cancelPendingTrackingRestore();
              parts.tracking._trackSatellite(noradId, { origin: 'user' });
              return;
            }
          }
        }

        // A pick that belongs to a sibling layer (plane, vessel, station, CCTV
        // camera…) is not "empty space" — leave OUR tracking (and crucially
        // the follow, which that sibling may have JUST started) alone (H2).
        if (picked) {
          const pickedId = resolvePickId(picked);
          if (
            pickedId &&
            isOwnedByOtherLayer('satellites', pickedId, layerState._engine)
          )
            return;
        }

        // Clicked empty space — deselect
        if (layerState._trackedNorad) {
          parts.tracking._cancelPendingTrackingRestore();
          parts.tracking._clearTracking(false, { origin: 'user' });
        }
      },
      { enabled: () => layerState._enabled },
    );

    document.addEventListener('keydown', _onKeyDown);
  }
  return { _onKeyDown, _installClickHandler };
}
