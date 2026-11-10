import * as Cesium from 'cesium';
import { t } from '../i18n/index.js';
import { createStateChannel } from '../app/stateChannel.js';
import { LocationControls } from './location.js';
import { createFlightNumberSearch } from './flightNumberSearch.js';

/** Own destination selection, lookup, orbit and world-jump lifetime. */
export class LocationNavigation {
  constructor({
    viewer,
    placeSearch,
    services,
    elements,
    navigation,
    readCockpit,
    operations,
  }) {
    Object.assign(
      this,
      { viewer, placeSearch, services, navigation, readCockpit },
      elements,
      operations,
    );
    this._disposed = false;
    this._activeLocationId = null;
    this._expandedCityId = null;
    this._activePoiIndex = null;
    this._currentTarget = null;
    this._currentPoi = null;
    this._searchedLocationLabel = null;
    this._trafficTransitionTimer = null;
    this._globeResetPromise = null;
    this._cancelGlobeReset = null;
    this._worldJumpActive = false;
    this.orbitController = new services.OrbitController(viewer);
    this._flightNumberSearch =
      services.flightNumberSearch ||
      createFlightNumberSearch({
        readLayer: (layerId) => ({
          enabled: services.isLayerEnabled?.(layerId) === true,
          module:
            layerId === 'military'
              ? services.militaryFlightsLayer || null
              : services.flightsLayer || null,
        }),
      });
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
      // A followed aircraft is announced by its own tracking card; the
      // location status keeps describing places.
      if (state.destination.kind === 'aircraft') {
        this._followSearchedAircraft(state.destination);
        return;
      }
      this._searchedLocationLabel = state.destination.label || state.query;
      this._setActiveLocation(null);
      this._currentPoi = null;
      this._collapsePOIRow();
      this._updateLocationMiniStatus();
    } else if (change.type === 'missing')
      this._setLocationSearchError(
        state.missingMessage ||
          `${t('Location not found')}. ${t('Check the spelling and press Enter to search again.')}`,
      );
    else if (change.type === 'failed')
      this._setLocationSearchError(
        `${t('Search failed')}. ${t('Press Enter to try again.')}`,
      );
    else if (change.type === 'settled')
      this._settleLocationSearchUi(change.generation, {
        keepQuery: state.status === 'missing' || state.status === 'failed',
      });
    else if (
      change.type === 'reset' &&
      this._activeLocationSearchGeneration !== null
    ) {
      this._settleLocationSearchUi(this._activeLocationSearchGeneration);
    }
  }

  /** Show, or with null clear, the announced error under the search field. */
  _setLocationSearchError(message) {
    this._locationControls?.setSearchError(message);
  }

  _initLocationBar() {
    const { CITY_POIS, searchAndFlyTo, LocationSearch } = this.services;
    // An open field stays open in the new controls.
    const searchExpanded = Boolean(this._locationControls?.searchExpanded);
    this._locationControls?.destroy();
    this._locationLookupUnsubscribe?.();
    this._locationLookup?.destroy();
    this._locationLookup = new LocationSearch({
      input: this._locationSearch,
      setSearching: (active) => this._locationControls?.setSearching(active),
      begin: () => this._beginDeferredNavigation('location'),
      isCurrent: (generation) =>
        !this._disposed && generation === this._navigationGeneration,
      beforeFly: (generation) => this._reassertNavigationHandoff(generation),
      search: (query, options) =>
        this._searchFlightOrPlace(query, options, () =>
          searchAndFlyTo(this.viewer, query, {
            placeSearch: this.placeSearch,
            ...options,
          }),
        ),
      onResult: (destination) => {
        if (destination.outlineUnavailable)
          this._showToast(t('Detailed outline unavailable'));
      },
      onError: (error) => console.error('[Search] Geocoding failed:', error),
    });
    this._locationControls = new LocationControls({
      elements: {
        search: this._locationSearch,
      },
      publish: (view) => this._publishLocation?.(view),
      cities: CITY_POIS,
      getExpandedCity: () => this._expandedCityId,
      onCity: (id) => this._onCityPillClick(id),
      onPoi: (id, index) => this._onPoiClick(id, index),
      onSearch: (query) => this._locationLookup.run(query),
      onSearchEdit: () => this._setLocationSearchError(null),
      onReset: () => this.resetToGlobeView(),
      searchExpanded,
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

  /**
   * Follow the aircraft flying a typed flight number, else search places.
   *
   * A flight number answers only when an aircraft on the map broadcasts its
   * exact callsign. Otherwise the text still goes to place search (a road
   * such as "A10" reads as a flight number too), and only when no place
   * answers does the miss explain what the flight lookup found.
   */
  async _searchFlightOrPlace(query, options, searchPlaces) {
    const { signal, beforeFly } = options;
    const flight = await this._flightNumberSearch.find(query, { signal });
    signal?.throwIfAborted();
    if (flight.status === 'found') {
      if (beforeFly() === false) return { cancelled: true };
      // Following starts once the lookup has reported `found`
      // (_followSearchedAircraft): a user track supersedes pending location
      // work, so starting it here would cancel this very search.
      return {
        kind: 'aircraft',
        label: flight.match.callsign,
        flightLabel: flight.flight.label,
        icao24: flight.match.icao24,
        layerId: flight.layerId,
      };
    }
    if (flight.status === 'ambiguous') {
      return {
        missingMessage: t(
          '{flight} matches several aircraft: {callsigns}. Type one callsign to follow it.',
          {
            flight: flight.flight.label,
            callsigns: flight.matches
              .map(({ match }) => match.callsign)
              .join(', '),
          },
        ),
      };
    }
    const place = await searchPlaces();
    if (place || flight.status === 'not-flight') return place;
    return { missingMessage: flightMissMessage(flight) };
  }

  /** Follow the aircraft a flight-number search found, or say why not. */
  _followSearchedAircraft({ icao24, layerId, label, flightLabel }) {
    const layer =
      layerId === 'military'
        ? this.services.militaryFlightsLayer
        : this.services.flightsLayer;
    const tracked = Boolean(layer?.trackById?.(icao24, { origin: 'user' }));
    if (!tracked) {
      this._setLocationSearchError(
        t(
          '{flight} is on the map as {callsign}, but tracking it failed. Press Enter to try again.',
          { flight: flightLabel, callsign: label },
        ),
      );
      return false;
    }
    this._showToast(
      t('Tracking {callsign} ({flight})', {
        callsign: label,
        flight: flightLabel,
      }),
    );
    return true;
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
    this._updatePoiHighlight();

    // Track current target + POI for orbit
    if (result) {
      this._currentTarget = result.targetPosition;
      this._currentPoi = CITY_POIS[cityId].pois[0];
    }
    this._updateLocationMiniStatus();
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
    this._updatePoiHighlight();

    // Track current target + POI for orbit
    if (result) {
      this._currentTarget = result.targetPosition;
      this._currentPoi = CITY_POIS[cityId].pois[poiIndex];
    }
    this._updateLocationMiniStatus();
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
    this._locationControls.hidePois();
  }

  _updatePoiHighlight() {
    this._locationControls.highlightPoi(this._activePoiIndex);
  }

  clearSearchedLocation() {
    if (this._searchedLocationLabel === null) return;
    this._searchedLocationLabel = null;
    this._updateLocationMiniStatus();
  }

  _setActiveLocation(locationId) {
    this._activeLocationId = locationId;
    // A preset city is now what the camera is framed on, so any earlier
    // free-text destination has been superseded. Clearing only on a real id
    // leaves the search path's own _setActiveLocation(null) untouched.
    if (locationId) this._searchedLocationLabel = null;
    this._locationControls?.highlightCity(locationId);
    this._updateLocationMiniStatus();
  }

  _updateLocationMiniStatus() {
    const { CITY_POIS } = this.services;
    this._locationControls?.renderStatus({
      city: this._activeLocationId ? CITY_POIS[this._activeLocationId] : null,
      currentPoi: this._currentPoi,
      searchedLabel: this._searchedLocationLabel,
    });
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

  resetToGlobeView() {
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
    this.viewer.trackedEntity = undefined;
    this.viewer.camera.cancelFlight();
    this.viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    this._beginWorldJumpTransition();

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
      const carto = this.viewer.camera.positionCartographic;
      const result = {
        ok: !cancelled,
        action: 'zoom_to_globe',
        cancelled,
        heightKm: Math.round(GLOBE_VIEW.heightM / 1000),
        centeredOn: {
          latitude: Number(Cesium.Math.toDegrees(carto.latitude).toFixed(2)),
          longitude: Number(Cesium.Math.toDegrees(carto.longitude).toFixed(2)),
        },
      };
      this._publishGlobeResetting?.(false);
      this._globeResetPromise = null;
      this._cancelGlobeReset = null;
      resolveReset(result);
    };
    this._cancelGlobeReset = () => finish(true);
    timer = window.setTimeout(() => {
      const height = this.viewer.camera.positionCartographic?.height;
      finish(
        !Number.isFinite(height) ||
          Math.abs(height - GLOBE_VIEW.heightM) > 1000,
      );
    }, 4200);
    this._publishGlobeResetting?.(true);
    const target = flyToGlobeView(this.viewer, {
      onComplete: () => finish(false),
      onCancel: () => finish(true),
    });
    if (!target) finish(true);
    return resetPromise;
  }

  /** Settle the search field once its lookup has (LocationControls.settleSearch). */
  settleSearch(options) {
    this._locationControls?.settleSearch(options);
  }

  /** Close the search field; with `ifOpen`, only when it is open. */
  closeSearch({ ifOpen = false } = {}) {
    const controls = this._locationControls;
    if (ifOpen && !controls?.searchExpanded) return;
    controls?.closeSearch();
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

/** Explain why a typed flight number found no aircraft (and no place). */
function flightMissMessage({ flight, reason }) {
  const values = { flight: flight.label };
  if (reason === 'layers-off')
    return t(
      'No place or aircraft found for {flight}. Turn on the Flights layer to search aircraft by flight number.',
      values,
    );
  if (reason === 'airline-unavailable')
    return t(
      'No place found for {flight}, and the airline code lookup is unavailable. Try the ICAO callsign instead, such as BAW123.',
      values,
    );
  if (reason === 'airline-unknown')
    return t(
      'No place found for {flight}, and no airline uses that code.',
      values,
    );
  return t(
    'No place found for {flight}, and no aircraft on the map is flying it. Only aircraft already loaded on the map can be found.',
    values,
  );
}
