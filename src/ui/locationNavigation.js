import { findCamera } from '../render/rendererOf.js';
import { stopFollowing } from '../data/followed.js';
import { t } from '../i18n/index.js';
import { createStateChannel } from '../app/stateChannel.js';
import { LocationControls } from './location.js';
import { worldClock } from '../time/worldClock.js';

/** Own destination selection, lookup, orbit and world-jump lifetime. */
export class LocationNavigation {
  constructor({
    viewer,
    placeSearch,
    services,
    navigation,
    readCockpit,
    operations,
    homeView = null,
  }) {
    Object.assign(
      this,
      { viewer, placeSearch, services, navigation, readCockpit, homeView },
      operations,
    );
    this._disposed = false;
    this._activeLocationId = null;
    this._expandedCityId = null;
    this._activePoiIndex = null;
    this._currentTarget = null;
    this._currentPoi = null;
    this._trafficTransitionTimer = null;
    this._globeResetPromise = null;
    this._cancelGlobeReset = null;
    this._worldJumpActive = false;
    this.orbitController = new services.OrbitController(viewer);
    this._locationState = createStateChannel(
      () => this._locationLookup?.getState() || null,
    );
    this._locationState.subscribe(
      ({ state, change }) => this._handleLocationSearchState(state, change),
      { emitCurrent: false },
    );
  }
  get cockpitView() {
    return this.readCockpit();
  }
  get _navigationGeneration() {
    return this.navigation._navigationGeneration;
  }
  get _activeLocationSearchGeneration() {
    return this.navigation._activeLocationSearchGeneration;
  }
  set _activeLocationSearchGeneration(value) {
    this.navigation._activeLocationSearchGeneration = value;
  }

  setOrbit(enabled) {
    const active = !!this.orbitController?.active;
    if (typeof enabled === 'boolean' && enabled === active) {
      return { ok: true, orbiting: active };
    }
    if (enabled === false) {
      this._stopOrbit();
      return { ok: true, orbiting: false };
    }
    if (!this._currentTarget) {
      return {
        ok: false,
        orbiting: false,
        error: 'No active landmark to orbit — fly to a landmark first',
      };
    }
    this._toggleOrbit();
    return { ok: true, orbiting: !!this.orbitController?.active };
  }

  subscribeLocationSearch(listener, options) {
    return this._locationState.subscribe(listener, options);
  }

  _handleLocationSearchState(state, change) {
    if (this._disposed || !change) return;
    if (change.type === 'started') {
      this._activeLocationSearchGeneration = change.generation;
      this._setLocationSearchError(null);
    } else if (change.type === 'found') {
      this._setActiveLocation(null);
      this._currentPoi = null;
      this._collapsePOIRow();
    } else if (change.type === 'missing')
      this._setLocationSearchError(
        `${t('Location not found')}. ${t('Check the spelling and press Enter to search again.')}`,
      );
    else if (change.type === 'failed')
      this._setLocationSearchError(
        `${t('Search failed')}. ${t('Press Enter to try again.')}`,
      );
    else if (change.type === 'settled')
      this._settleLocationSearchUi(change.generation);
    else if (
      change.type === 'reset' &&
      this._activeLocationSearchGeneration !== null
    ) {
      this._settleLocationSearchUi(this._activeLocationSearchGeneration);
    }
  }

  /** Show, or with null clear, the lookup's announced error. */
  _setLocationSearchError(message) {
    this._locationControls?.setSearchError(message);
  }

  _initLocationControls() {
    const { CITY_POIS, searchAndFlyTo, LocationSearch } = this.services;
    this._locationControls?.destroy();
    this._locationLookupUnsubscribe?.();
    this._locationLookup?.destroy();
    this._locationLookup = new LocationSearch({
      setSearching: (active) => this._locationControls?.setSearching(active),
      begin: () => this._beginDeferredNavigation('location'),
      isCurrent: (generation) =>
        !this._disposed && generation === this._navigationGeneration,
      beforeFly: (generation) => this._reassertNavigationHandoff(generation),
      search: (query, options) =>
        searchAndFlyTo(this.viewer, query, {
          placeSearch: this.placeSearch,
          ...options,
        }),
      onResult: (destination) => {
        if (destination.outlineUnavailable)
          this._showToast(t('Detailed outline unavailable'));
      },
      onError: (error) => console.error('[Search] Geocoding failed:', error),
    });
    this._locationControls = new LocationControls({
      publish: (view) => this._publishLocation?.(view),
      cities: CITY_POIS,
      getExpandedCity: () => this._expandedCityId,
      onCity: (id) => this._onCityPillClick(id),
      onPoi: (id, index) => this._onPoiClick(id, index),
      onSearch: (query) => this._locationLookup.run(query),
      onSearchEdit: () => this._setLocationSearchError(null),
      onReset: () => this.resetToGlobeView(),
    });
    // The new lookup's reset settles a replaced lookup's search through the
    // new controls, so it subscribes once they are in place.
    this._locationLookupUnsubscribe = this._locationLookup.subscribe(
      ({ initial, change }) => {
        this._locationState.publish(initial ? { type: 'reset' } : change);
      },
    );
    this._connectLocation?.(this._locationControls);
    this._connectGlobeReset?.(this._locationControls);
  }

  _beginWorldJumpTransition() {
    const { suspendDetection, trafficLayer } = this.services;
    clearTimeout(this._trafficTransitionTimer);
    this._worldJumpActive = true;
    trafficLayer.beginWorldJump?.();
    suspendDetection('intercity');
  }

  _endWorldJumpTransition() {
    const { resumeDetection, trafficLayer } = this.services;
    clearTimeout(this._trafficTransitionTimer);
    this._worldJumpActive = false;
    this._trafficTransitionTimer = null;
    trafficLayer.endWorldJump?.();
    resumeDetection();
    this._updateTrafficSyncChip(true);
  }

  _flyWithTransition(cityChanged, flyAction) {
    return this._runExplicitNavigation('location', () => {
      if (!cityChanged) return flyAction({});
      let completed = false;
      const finalize = () => {
        if (completed || this._disposed) return;
        completed = true;
        this._endWorldJumpTransition();
      };
      const result = flyAction({
        onStart: () => this._beginWorldJumpTransition(),
        onComplete: finalize,
      });
      this._trafficTransitionTimer = window.setTimeout(finalize, 5200);
      return result;
    });
  }

  _onCityPillClick(cityId) {
    const { CITY_POIS, flyToPresetLocation } = this.services;
    if (this._expandedCityId === cityId) {
      // Same city clicked again — toggle collapse
      this._collapsePOIRow();
      return;
    }

    const isCityChanged =
      this._activeLocationId && this._activeLocationId !== cityId;
    const result = this._flyWithTransition(!!isCityChanged, (hooks) =>
      flyToPresetLocation(this.viewer, cityId, hooks),
    );
    if (result === false) return;
    this._expandPOIRow(cityId);
    this._setActiveLocation(cityId);
    this._activePoiIndex = 0;

    // Track current target + POI for orbit
    if (result) {
      this._currentTarget = result.targetPosition;
      this._currentPoi = CITY_POIS[cityId].pois[0];
    }
  }

  _onPoiClick(cityId, poiIndex) {
    const { CITY_POIS, flyToPOI } = this.services;
    const isCityChanged =
      this._activeLocationId && this._activeLocationId !== cityId;
    const result = this._flyWithTransition(!!isCityChanged, (hooks) =>
      flyToPOI(this.viewer, cityId, poiIndex, hooks),
    );
    if (result === false) return;
    this._setActiveLocation(cityId);
    this._activePoiIndex = poiIndex;

    // Track current target + POI for orbit
    if (result) {
      this._currentTarget = result.targetPosition;
      this._currentPoi = CITY_POIS[cityId].pois[poiIndex];
    }
  }

  _expandPOIRow(cityId) {
    const { CITY_POIS } = this.services;
    if (!CITY_POIS[cityId]) return;
    this._expandedCityId = cityId;
    this._locationControls.showPois(cityId);
  }

  _collapsePOIRow() {
    this._expandedCityId = null;
    this._activePoiIndex = null;
  }

  _setActiveLocation(locationId) {
    this._activeLocationId = locationId;
  }

  _initOrbit() {
    this._locationControls?.showOrbit(false);
  }

  _toggleOrbit() {
    if (!this._currentTarget) {
      this._showToast(t('Fly to a POI first'));
      return;
    }

    this.services.interruptGlobeRotation?.('orbit-intent');
    const isActive = this.orbitController.toggle(this._currentTarget, {
      radius: this._currentPoi?.alt || 500,
      pitch: this._currentPoi?.pitch || -30,
    });

    this._locationControls?.showOrbit(isActive);
  }

  _stopOrbit() {
    if (this.orbitController.active) {
      this.orbitController.stop();
      this._locationControls?.showOrbit(false);
    }
  }

  /**
   * Back to live, at the view the app started from (the logo): the world
   * clock goes live and the camera flies to the start view as the globe reset
   * does, letting go of whatever it follows.
   */
  returnToStart() {
    if (!this._disposed) worldClock.goLive();
    if (!this.homeView) return this.resetToGlobeView();
    // A globe reset under way flies elsewhere: this one replaces it.
    this._cancelGlobeReset?.();
    return this.resetToGlobeView({ view: this.homeView });
  }

  /**
   * Fly out to the full globe over the current spot, or to `view` (the start
   * view's shape: `{ lon, lat, height, heading?, pitch? }`, degrees).
   */
  resetToGlobeView({ view = null } = {}) {
    const {
      GLOBE_VIEW,
      flyToGlobeView,
      interruptCameraMotion,
      flightsLayer,
      militaryFlightsLayer,
      satellitesLayer,
      aisLiveVesselsLayer,
      militaryAwarenessLayer,
      rocketLaunchesLayer,
    } = this.services;
    if (this._disposed)
      return Promise.resolve({
        ok: false,
        action: 'zoom_to_globe',
        cancelled: true,
      });
    if (this._globeResetPromise) return this._globeResetPromise;
    this._stampNavigation();
    interruptCameraMotion('reset-globe');
    this._stopOrbit();
    this.cockpitView?.exit({ restoreTracking: false });
    try {
      militaryAwarenessLayer.releaseCameraOwnership?.({ origin: 'tool' });
    } catch {
      // Keep reset available if Context has not initialized completely.
      try {
        flightsLayer.stopTracking?.({ origin: 'tool' });
      } catch {
        /* best-effort release */
      }
      try {
        militaryFlightsLayer.stopTracking?.({ origin: 'tool' });
      } catch {
        /* best-effort release */
      }
      try {
        aisLiveVesselsLayer.clearSelection?.();
      } catch {
        /* best-effort release */
      }
    }
    try {
      satellitesLayer.stopTracking?.({ origin: 'tool' });
    } catch {
      /* best-effort release */
    }
    try {
      rocketLaunchesLayer.releaseCameraOwnership?.();
    } catch {
      /* best-effort release */
    }
    stopFollowing(this.viewer);
    const camera = findCamera(this.viewer);
    camera?.cancelFlight();
    camera?.release();
    this._beginWorldJumpTransition();

    const heightM = view?.height ?? GLOBE_VIEW.heightM;
    let resolveReset;
    const resetPromise = new Promise((resolve) => {
      resolveReset = resolve;
    });
    this._globeResetPromise = resetPromise;
    let settled = false;
    let timer = null;
    const finish = (cancelled = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      this._endWorldJumpTransition();
      const pose = findCamera(this.viewer)?.pose();
      const result = {
        ok: !cancelled,
        action: 'zoom_to_globe',
        cancelled,
        heightKm: Math.round(heightM / 1000),
        centeredOn: {
          latitude: Number.isFinite(pose?.lat)
            ? Number(pose.lat.toFixed(2))
            : null,
          longitude: Number.isFinite(pose?.lon)
            ? Number(pose.lon.toFixed(2))
            : null,
        },
      };
      this._publishGlobeResetting?.(false);
      this._globeResetPromise = null;
      this._cancelGlobeReset = null;
      resolveReset(result);
    };
    this._cancelGlobeReset = () => finish(true);
    timer = window.setTimeout(() => {
      const height = findCamera(this.viewer)?.pose().height;
      finish(!Number.isFinite(height) || Math.abs(height - heightM) > 1000);
    }, 4200);
    this._publishGlobeResetting?.(true);
    const target = flyToGlobeView(this.viewer, {
      onComplete: () => finish(false),
      onCancel: () => finish(true),
      ...(view ? { view } : {}),
    });
    if (!target) finish(true);
    return resetPromise;
  }

  /** Settle the lookup's presentation once it has (LocationControls.settleSearch). */
  settleSearch() {
    this._locationControls?.settleSearch();
  }

  /** Revoke callbacks and settle owned camera work before the viewer is released. */
  destroy() {
    if (this._disposed) return;
    this._disposed = true;
    this._locationState.destroy();
    this._locationLookupUnsubscribe?.();
    this._locationLookupUnsubscribe = null;
    this._locationLookup?.destroy();
    this._locationControls?.destroy();
    this._connectLocation?.(null);
    this._connectGlobeReset?.(null);
    this._publishLocation?.(null);
    this._cancelGlobeReset?.();
    this._cancelGlobeReset = null;
    if (this._worldJumpActive) this._endWorldJumpTransition();
    clearTimeout(this._trafficTransitionTimer);
    this._trafficTransitionTimer = null;
    this.orbitController?.stop();
  }
}
