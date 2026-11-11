/** Release layer camera owners in their handoff order. */
export function releaseTrackers(tracking, options) {
  const {
    flightsLayer,
    militaryFlightsLayer,
    satellitesLayer,
    aisLiveVesselsLayer,
    militaryAwarenessLayer,
    rocketLaunchesLayer,
  } = tracking;
  let contactSelected = false;
  try {
    // If awareness controls are unavailable, release the trackers directly.
    if (typeof militaryAwarenessLayer?.releaseCameraOwnership !== 'function')
      throw new Error('no military awareness controls');
    contactSelected = Boolean(
      militaryAwarenessLayer.releaseCameraOwnership?.({
        ...options,
      }),
    );
  } catch {
    try {
      flightsLayer.stopTracking?.({ origin: options.origin });
    } catch {
      /* best-effort release */
    }
    try {
      militaryFlightsLayer.stopTracking?.({ origin: options.origin });
    } catch {
      /* best-effort release */
    }
    if (!options.preserveVesselSelection) {
      try {
        aisLiveVesselsLayer.clearSelection?.();
      } catch {
        /* best-effort release */
      }
    }
  }
  try {
    satellitesLayer.stopTracking?.({ origin: options.origin });
  } catch {
    /* best-effort release */
  }
  try {
    rocketLaunchesLayer.releaseCameraOwnership?.();
  } catch {
    /* best-effort release */
  }
  return contactSelected;
}
