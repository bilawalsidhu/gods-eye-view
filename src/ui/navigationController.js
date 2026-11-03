import { cancelCameraArrival } from '../data/cameraArrival.js';
import { createStateChannel } from '../app/stateChannel.js';
import { engineFromViewer } from '../globe/cesium/engineFromViewer.js';
import {
  beginDeferredNavigation,
  reassertNavigationHandoff,
  runExplicitNavigation,
} from '../navigationPolicy.js';

/**
 * Own camera authority generations, pending search UI and tracking handoff.
 * The camera is the globe `engine`'s. `viewer` is optional and only clears
 * Cesium's tracked entity (entity tracking moves to the engine in phase 1c).
 */
export class NavigationController {
  constructor({
    viewer = null,
    engine = engineFromViewer(viewer),
    tracking,
    settleSearch = () => {},
    interruptCameraMotion,
    interruptGlobeRotation = () => {},
    isCockpitActive,
    clearLocation,
    cancelShareSelection,
    getDataManager,
    stopOrbit,
    showToast,
    cancelOrientation = () => {},
  }) {
    Object.assign(this, {
      viewer,
      engine,
      tracking,
      settleSearch,
      interruptCameraMotion,
      interruptGlobeRotation,
      isCockpitActive,
      clearLocation,
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
  _stampNavigation({
    cancelPendingSelection = true,
    clearSearchedLocation = true,
  } = {}) {
    this.interruptGlobeRotation('navigation-intent');
    cancelCameraArrival(this.engine);
    this.cancelOrientation();
    const { flightsLayer, militaryFlightsLayer, satellitesLayer } =
      this.tracking;
    this._navigationGeneration += 1;
    this._cameraHandoffs?.publish();
    // A newer destination owns the camera, so the last free-text search is no
    // longer where we are. DEFERRED navigation opts out here and clears at the
    // reassert seam instead: a geocode that never resolves moves no camera, and
    // a lookup that fails must not blank a readout that is still true.
    if (clearSearchedLocation) this.clearLocation();
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

  /** A search that found nothing keeps its query and focus so it can be corrected. */
  _settleLocationSearchUi(generation, { keepQuery = false } = {}) {
    if (this._activeLocationSearchGeneration !== generation) return;
    this._activeLocationSearchGeneration = null;
    this.settleSearch({ keepQuery });
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
      // A layer an engine leaves out (military awareness on Navara) has no
      // controls: release the trackers it would release, below.
      if (typeof militaryAwarenessLayer?.releaseCameraOwnership !== 'function')
        throw new Error('no military awareness controls');
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
    if (this.viewer) this.viewer.trackedEntity = undefined;
    this.interruptCameraMotion('explicit-navigation');
    this.stopOrbit();
    const camera = this.engine?.camera;
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
      stamp: () =>
        this._stampNavigation({
          cancelPendingSelection: false,
          clearSearchedLocation: false,
        }),
      release: () => {
        this.interruptCameraMotion('camera-orientation');
        this.stopOrbit();
        // Only a running flight: a cancel is a camera command, which ends an
        // engine's own follow (Navara) that the orientation keeps.
        if (this.engine?.camera.flightActive?.() !== false)
          this.engine?.camera.cancelFlight();
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
      // The searched-location readout survives the STAMP; only a flight that
      // actually starts invalidates it (see the release hook below).
      stamp: () =>
        this._stampNavigation({
          cancelPendingSelection,
          clearSearchedLocation: false,
        }),
    });
  }

  _reassertNavigationHandoff(generation, { trackingOrigin = 'tool', keepTracking = false } = {}) {
    return reassertNavigationHandoff({
      generation,
      currentGeneration: this._navigationGeneration,
      cockpitActive: this.isCockpitActive(),
      disposed: this._disposed,
      showToast: (text) => this.showToast(text),
      // Reached only once the handoff is granted, immediately before the
      // deferred flight starts — so a lookup that failed, was superseded, or
      // was refused by the cockpit leaves the old readout standing.
      release: () => {
        this.clearLocation();
        if (!keepTracking) return this._releaseFollowCamera({ trackingOrigin });
      },
    });
  }
  /** Subscribe to ownership changes without claiming the camera or exposing mutable state. */
  subscribeCameraHandoff(listener) {
    return this._cameraHandoffs.subscribe(listener, { emitCurrent: false });
  }
  stop() {
    cancelCameraArrival(this.engine);
    this._disposed = true;
    this._cameraHandoffs?.publish();
    this._cameraHandoffs?.destroy();
  }
  destroy({ retainScene = false } = {}) {
    this.stop();
    this._stampNavigation({cancelPendingSelection: !retainScene});
  }
}
