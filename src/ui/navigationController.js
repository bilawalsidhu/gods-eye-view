import { findCamera } from '../render/rendererOf.js';
import { stopFollowing } from '../data/followed.js';
import { cancelCameraArrival } from '../data/cameraArrival.js';
import { createStateChannel } from '../app/stateChannel.js';
import {
  beginDeferredNavigation,
  reassertNavigationHandoff,
  runExplicitNavigation,
} from '../navigationPolicy.js';

/** Own camera authority generations, pending search UI and tracking handoff. */
export class NavigationController {
  constructor({
    viewer,
    tracking,
    settleSearch = () => {},
    interruptCameraMotion,
    interruptGlobeRotation = () => {},
    isCockpitActive,
    cancelShareSelection,
    getDataManager,
    stopOrbit,
    showToast,
    cancelOrientation = () => {},
  }) {
    Object.assign(this, {
      viewer,
      tracking,
      settleSearch,
      interruptCameraMotion,
      interruptGlobeRotation,
      isCockpitActive,
      cancelShareSelection,
      getDataManager,
      stopOrbit,
      showToast,
      cancelOrientation,
    });
    this._navigationGeneration = 0;
    this._cameraHandoffs = createStateChannel(() => ({
      generation: this._navigationGeneration,
    }));
    this._activeLocationSearchGeneration = null;
    this._disposed = false;
  }
  _stampNavigation({ cancelPendingSelection = true } = {}) {
    this.interruptGlobeRotation('navigation-intent');
    cancelCameraArrival(this.viewer);
    this.cancelOrientation();
    const { flightsLayer, militaryFlightsLayer, satellitesLayer } =
      this.tracking;
    this._navigationGeneration += 1;
    this._cameraHandoffs?.publish();
    if (cancelPendingSelection) {
      const passivelyClearedShareSelection = this.cancelShareSelection();
      try {
        flightsLayer.cancelPendingTrackingRestore?.();
      } catch {
        /* best effort */
      }
      try {
        militaryFlightsLayer.cancelPendingTrackingRestore?.();
      } catch {
        /* best effort */
      }
      try {
        satellitesLayer.cancelPendingTrackingRestore?.();
      } catch {
        /* best effort */
      }
      // A deliberate destination supersedes share-selected entities that have
      // not arrived yet. Active owners publish their clear when released.
      if (!passivelyClearedShareSelection && !flightsLayer.getTrackedInfo?.()) {
        this.getDataManager()?.setLayerParams(
          'flights',
          {
            selectedFlightsTrackingId: null,
          },
          { origin: 'tool' },
        );
      }
      if (
        !passivelyClearedShareSelection &&
        !militaryFlightsLayer.getTrackedInfo?.()
      ) {
        this.getDataManager()?.setLayerParams(
          'military',
          {
            selectedMilitaryTrackingId: null,
          },
          { origin: 'tool' },
        );
      }
      if (
        !passivelyClearedShareSelection &&
        !satellitesLayer.getTrackedInfo?.()
      ) {
        this.getDataManager()?.setLayerParams(
          'satellites',
          {
            selectedSatTrackingId: null,
          },
          { origin: 'tool' },
        );
      }
    }
    if (this._activeLocationSearchGeneration !== null) {
      this._settleLocationSearchUi(this._activeLocationSearchGeneration);
    }
    return this._navigationGeneration;
  }

  /** Settle the search presentation of the lookup `generation`, once. */
  _settleLocationSearchUi(generation) {
    if (this._activeLocationSearchGeneration !== generation) return;
    this._activeLocationSearchGeneration = null;
    this.settleSearch();
  }

  _releaseFollowCamera({
    preserveVesselSelection = true,
    preserveCameraFlight = false,
    trackingOrigin = 'tool',
  } = {}) {
    const {
      flightsLayer,
      militaryFlightsLayer,
      satellitesLayer,
      aisLiveVesselsLayer,
      militaryAwarenessLayer,
      rocketLaunchesLayer,
    } = this.tracking;
    let contactSelected = false;
    try {
      contactSelected = Boolean(
        militaryAwarenessLayer.releaseCameraOwnership?.({
          preserveVesselSelection,
          origin: trackingOrigin,
        }),
      );
    } catch {
      try {
        flightsLayer.stopTracking?.({ origin: trackingOrigin });
      } catch {
        /* best-effort release */
      }
      try {
        militaryFlightsLayer.stopTracking?.({ origin: trackingOrigin });
      } catch {
        /* best-effort release */
      }
      if (!preserveVesselSelection) {
        try {
          aisLiveVesselsLayer.clearSelection?.();
        } catch {
          /* best-effort release */
        }
      }
    }
    try {
      satellitesLayer.stopTracking?.({ origin: trackingOrigin });
    } catch {
      /* best-effort release */
    }
    try {
      rocketLaunchesLayer.releaseCameraOwnership?.();
    } catch {
      /* best-effort release */
    }
    stopFollowing(this.viewer);
    this.interruptCameraMotion('explicit-navigation');
    this.stopOrbit();
    const camera = findCamera(this.viewer);
    if (!preserveCameraFlight) camera?.cancelFlight();
    try {
      camera?.release();
    } catch {
      /* teardown race */
    }
    return contactSelected;
  }

  _runExplicitNavigation(noun, navigate, releaseOptions = undefined) {
    return runExplicitNavigation({
      disposed: this._disposed,
      cockpitActive: this.isCockpitActive(),
      noun,
      showToast: (text) => this.showToast(text),
      stamp: () => this._stampNavigation(),
      release: () => this._releaseFollowCamera(releaseOptions),
      navigate,
    });
  }

  /** Change the viewing angle without clearing selection or follow ownership. */
  runOrientation(noun, navigate) {
    return runExplicitNavigation({
      disposed: this._disposed,
      cockpitActive: this.isCockpitActive(),
      noun,
      showToast: (text) => this.showToast(text),
      stamp: () => this._stampNavigation({ cancelPendingSelection: false }),
      release: () => {
        this.interruptCameraMotion('camera-orientation');
        this.stopOrbit();
        findCamera(this.viewer)?.cancelFlight();
      },
      navigate,
    });
  }

  _beginDeferredNavigation(
    noun = 'location',
    { cancelPendingSelection = true } = {},
  ) {
    return beginDeferredNavigation({
      disposed: this._disposed,
      cockpitActive: this.isCockpitActive(),
      noun,
      showToast: (text) => this.showToast(text),
      stamp: () => this._stampNavigation({ cancelPendingSelection }),
    });
  }

  _reassertNavigationHandoff(generation, { trackingOrigin = 'tool' } = {}) {
    return reassertNavigationHandoff({
      generation,
      currentGeneration: this._navigationGeneration,
      cockpitActive: this.isCockpitActive(),
      disposed: this._disposed,
      showToast: (text) => this.showToast(text),
      // Reached only once the handoff is granted, immediately before the
      // deferred flight starts.
      release: () => this._releaseFollowCamera({ trackingOrigin }),
    });
  }
  /** Subscribe to ownership changes without claiming the camera or exposing mutable state. */
  subscribeCameraHandoff(listener) {
    return this._cameraHandoffs.subscribe(listener, { emitCurrent: false });
  }
  stop() {
    cancelCameraArrival(this.viewer);
    this._disposed = true;
    this._cameraHandoffs?.publish();
    this._cameraHandoffs?.destroy();
  }
  destroy() {
    this.stop();
    this._stampNavigation();
  }
}
