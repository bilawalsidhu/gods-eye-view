// Location bar — city pills, the QWERTY POI row, geocode search and the
// inter-city world-jump transition, extracted from src/ui.js (Batch 5 seam 5).
// StyleManager keeps the public method surface (_initLocationBar,
// beginLocationNavigation, clearSearchedLocation, the world-jump and
// mini-status helpers) as thin delegates; everything else is module-internal.

import * as Cesium from 'cesium';
import { logError, logWarn } from '../logger.js';
import { CITY_POIS, flyToPresetLocation, flyToPOI, searchAndFlyTo } from '../locations.js';
import { locationMiniStatus } from '../locationStatus.js';
import trafficLayer from '../data/traffic.js';
import {
  suspendDetection,
  resumeDetection,
} from '../data/detection.js';

/**
 * Initializes the location bar: renders city pills from CITY_POIS, sets up
 * QWERTY keyboard navigation for POI selection, wires the search toggle
 * and geocoding search input.
 * @param {object} mgr - StyleManager instance (src/ui.js) owning the
 *   location-bar DOM the pills and listeners are attached to, plus the
 *   deferred-navigation bookkeeping the search handler writes back through.
 * @returns {void}
 */
export function initLocationBar(mgr) {
  const QWERTY_KEYS = ['Q', 'W', 'E', 'R', 'T'];

  // Render city pills (no submenu wrappers — POI row is separate)
  for (const [cityId, city] of Object.entries(CITY_POIS)) {
    const pill = document.createElement('button');
    pill.className = 'location-pill';
    pill.dataset.locationId = cityId;
    pill.textContent = city.name;
    pill.addEventListener('click', () => onCityPillClick(mgr, cityId));
    mgr._locationPills.appendChild(pill);
  }

  // QWERTY keyboard navigation for POIs
  mgr._poiKeydownHandler = (e) => {
    if (!mgr._expandedCityId) return;
    // Bail while a form control is focused so POI hotkeys don't fire from a
    // <select> dropdown's type-ahead or while typing in a field (M9).
    const isFormControl = e.target?.matches?.('select, input, textarea')
      || e.target === mgr._locationSearch;
    if (isFormControl) return;

    const keyIndex = QWERTY_KEYS.indexOf(e.key.toUpperCase());
    if (keyIndex === -1) return;

    const city = CITY_POIS[mgr._expandedCityId];
    if (city && keyIndex < city.pois.length) {
      onPoiClick(mgr, mgr._expandedCityId, keyIndex);
    }
  };
  document.addEventListener('keydown', mgr._poiKeydownHandler);

  // Search toggle (expand/collapse)
  mgr._searchToggle.addEventListener('click', () => {
    mgr._locationSearch.classList.toggle('expanded');
    if (mgr._locationSearch.classList.contains('expanded')) {
      mgr._locationSearch.focus();
    }
  });

  // Search submit on Enter
  mgr._locationSearch.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      const query = mgr._locationSearch.value.trim();
      if (!query) return;
      const generation = mgr._beginDeferredNavigation('location');
      if (generation === false) {
        mgr._locationSearch.classList.remove('searching');
        mgr._locationSearch.blur();
        return;
      }
      mgr._activeLocationSearchGeneration = generation;
      mgr._locationSearch.classList.add('searching');
      try {
        const destination = await searchAndFlyTo(mgr.viewer, query, {
          beforeFly: () => mgr._reassertNavigationHandoff(generation),
        });
        if (mgr._disposed || generation !== mgr._navigationGeneration) return;
        if (destination?.cancelled) {
          // Authority changed while the lookup was resolving; remain inert.
        } else if (destination) {
          // The ACTIVE STYLE indicator reports the STYLE and nothing else.
          // Writing the searched city here made the top-right corner read
          // "ACTIVE STYLE / TOKYO"; where the camera is belongs to the
          // LOCATION panel's own readout, which is updated below.
          //
          // Set before setActiveLocation(mgr, null) so its own mini-status
          // refresh already sees the destination — the readout never blinks
          // through "Location: --" on the way to the searched place.
          mgr._searchedLocationLabel = destination.label || query;
          setActiveLocation(mgr, null);
          mgr._currentPoi = null;
          collapsePOIRow(mgr);
          updateLocationMiniStatus(mgr);
        } else {
          mgr._showToast('Location not found');
        }
      } catch (err) {
        logError('Search', 'Geocoding failed:', err);
        if (mgr._disposed || generation !== mgr._navigationGeneration) return;
        mgr._showToast('Search failed');
      } finally {
        mgr._settleLocationSearchUi(generation);
      }
    }
  });

  // Set up Google Places Autocomplete for location search dropdown
  window.__googleMapsReady__.then((google) => {
    if (!google || !google.maps?.places) return;
    const input = mgr._locationSearch;
    if (!input) return;
    try {
      const autocomplete = new google.maps.places.Autocomplete(input, {
        types: ['geocode'],
        fields: ['name', 'formatted_address', 'geometry.location'],
      });
      autocomplete.addListener('place_changed', () => {
        const place = autocomplete.getPlace();
        if (!place.geometry?.location) return;
        const lat = place.geometry.location.lat();
        const lon = place.geometry.location.lng();
        const label = place.formatted_address || place.name || input.value;
        input.value = label;
        const dest = {
          destination: Cesium.Cartesian3.fromDegrees(lon, lat, 800),
          label,
          orientation: { direction: Cesium.HeadingPitchRoll.heading(0), pitch: -35, roll: 0 },
        };
        mgr._searchedLocationLabel = label;
        setActiveLocation(mgr, null);
        mgr._currentPoi = null;
        collapsePOIRow(mgr);
        updateLocationMiniStatus(mgr);
        void mgr._flyToDestination(dest);
      });
    } catch (err) {
      logWarn('LocationSearch', 'Autocomplete setup failed:', err);
    }
  });
}

/**
 * Signals the start of an inter-city world jump: notifies the traffic layer
 * to pause tile fetching and suspends detection overlays to prevent stale
 * rendering during the flight.
 * @param {object} mgr - StyleManager instance (src/ui.js) whose
 *   `_trafficTransitionTimer` id is cleared and re-armed by the paired
 *   begin/end calls.
 * @returns {void}
 */
export function beginWorldJumpTransition(mgr) {
  clearTimeout(mgr._trafficTransitionTimer);
  trafficLayer.beginWorldJump?.();
  suspendDetection('intercity');
}

/**
 * Signals the end of an inter-city world jump: resumes traffic tile fetching,
 * resumes detection overlays, and forces a traffic sync chip update.
 * @param {object} mgr - StyleManager instance (src/ui.js) whose
 *   `_trafficTransitionTimer` id is cleared and whose traffic-sync chip is
 *   repainted after the layer resumes.
 * @returns {void}
 */
export function endWorldJumpTransition(mgr) {
  clearTimeout(mgr._trafficTransitionTimer);
  trafficLayer.endWorldJump?.();
  resumeDetection();
  mgr._updateTrafficSyncChip(true);
}

/**
 * Wraps a fly-to action with world-jump transition hooks when the target
 * city differs from the current one. Applies begin/end transition signals
 * with a 5.2s safety timeout to guarantee cleanup if the flight callback
 * never fires onComplete.
 * @param {object} mgr - StyleManager instance supplying the explicit-navigation runner and the world-jump transition timer.
 * @param {boolean} cityChanged - Whether the destination is in a different city.
 * @param {function} flyAction - Callback receiving `{onStart, onComplete}` hooks; should return a result with targetPosition.
 * @returns {*} Return value from flyAction.
 */
function flyWithTransition(mgr, cityChanged, flyAction) {
  return mgr._runExplicitNavigation('location', () => {
    if (!cityChanged) return flyAction({});
    let completed = false;
    const finalize = () => {
      if (completed) return;
      completed = true;
      endWorldJumpTransition(mgr);
    };
    const result = flyAction({
      onStart: () => beginWorldJumpTransition(mgr),
      onComplete: finalize,
    });
    mgr._trafficTransitionTimer = window.setTimeout(finalize, 5200);
    return result;
  });
}

/**
 * Release camera ownership when a resolved Location destination starts.
 * Contact mode and its selected subject remain intact so FOCUS can return to
 * that subject after the user finishes inspecting the destination.
 * @param {object} mgr - StyleManager instance (src/ui.js) whose navigation
 *   stamp, cockpit view, and follow-camera ownership this navigation takes
 *   over.
 * @returns {boolean} Whether a Contact subject remains selected.
 */
export function beginLocationNavigation(mgr) {
  mgr._stampNavigation();
  mgr.cockpitView?.exit({ restoreTracking: false });
  return mgr._releaseFollowCamera({ preserveVesselSelection: false });
}

/**
 * Handles a city pill click: toggles POI row collapse if same city,
 * otherwise expands the POI row, flies to the city's first POI, and
 * tracks the target position for orbit mode.
 * @param {object} mgr - StyleManager instance holding the expanded-city, active-location, and orbit target state this click updates.
 * @param {string} cityId - Identifier of the clicked city.
 * @returns {void}
 */
function onCityPillClick(mgr, cityId) {
  if (mgr._expandedCityId === cityId) {
    // Same city clicked again — toggle collapse
    collapsePOIRow(mgr);
    return;
  }

  const isCityChanged = mgr._activeLocationId && mgr._activeLocationId !== cityId;
  const result = flyWithTransition(mgr, Boolean(isCityChanged), (hooks) => flyToPresetLocation(mgr.viewer, cityId, hooks));
  if (result === false) return;
  expandPOIRow(mgr, cityId);
  setActiveLocation(mgr, cityId);
  mgr._activePoiIndex = 0;
  updatePoiHighlight(mgr);

  // Track current target + POI for orbit
  if (result) {
    mgr._currentTarget = result.targetPosition;
    mgr._currentPoi = CITY_POIS[cityId].pois[0];
  }
  updateLocationMiniStatus(mgr);
}

/**
 * Handles a POI pill click: stops orbit, flies to the POI, highlights it,
 * and saves the target position for future orbit activation.
 * @param {object} mgr - StyleManager instance holding the active-location and orbit target state this click updates.
 * @param {string} cityId - Parent city identifier.
 * @param {number} poiIndex - Index of the POI within the city's pois array.
 * @returns {void}
 */
function onPoiClick(mgr, cityId, poiIndex) {
  const isCityChanged = mgr._activeLocationId && mgr._activeLocationId !== cityId;
  const result = flyWithTransition(mgr, Boolean(isCityChanged), (hooks) => flyToPOI(mgr.viewer, cityId, poiIndex, hooks));
  if (result === false) return;
  setActiveLocation(mgr, cityId);
  mgr._activePoiIndex = poiIndex;
  updatePoiHighlight(mgr);

  // Track current target + POI for orbit
  if (result) {
    mgr._currentTarget = result.targetPosition;
    mgr._currentPoi = CITY_POIS[cityId].pois[poiIndex];
  }
  updateLocationMiniStatus(mgr);
}

/**
 * Builds and shows the POI pill row for a city. Each pill displays a
 * QWERTY keyboard shortcut key and the POI name.
 * @param {object} mgr - StyleManager instance holding the POI row and location-bar divider elements the pills are rendered into.
 * @param {string} cityId - City whose POIs to render.
 * @returns {void}
 */
function expandPOIRow(mgr, cityId) {
  const QWERTY_KEYS = ['Q', 'W', 'E', 'R', 'T'];
  const city = CITY_POIS[cityId];
  if (!city) return;

  mgr._expandedCityId = cityId;

  // Build POI pill buttons
  mgr._poiRow.innerHTML = '';
  city.pois.forEach((poi, idx) => {
    const pill = document.createElement('button');
    pill.className = 'poi-pill';
    pill.dataset.poiIndex = idx;
    pill.innerHTML = `<span class="poi-pill-key">${QWERTY_KEYS[idx] || idx + 1}</span><span class="poi-pill-name">${poi.name}</span>`;
    pill.addEventListener('click', () => onPoiClick(mgr, cityId, idx));
    mgr._poiRow.appendChild(pill);
  });

  // Animate expansion
  requestAnimationFrame(() => {
    mgr._poiRow.classList.add('expanded');
    mgr._locationBarDivider.classList.add('visible');
  });
}

/**
 * Hides the POI pill row and clears the expanded city state.
 * @param {object} mgr - StyleManager instance (src/ui.js) holding the POI
 *   row and divider elements plus the `_expandedCityId`/`_activePoiIndex`
 *   pair this reset nulls.
 * @returns {void}
 */
function collapsePOIRow(mgr) {
  mgr._expandedCityId = null;
  mgr._activePoiIndex = null;
  mgr._poiRow.classList.remove('expanded');
  mgr._locationBarDivider.classList.remove('visible');
}

/**
 * Highlights the active POI pill and removes highlight from all others.
 * @param {object} mgr - StyleManager instance (src/ui.js) holding the POI
 *   row whose pills are compared against `_activePoiIndex`.
 * @returns {void}
 */
function updatePoiHighlight(mgr) {
  mgr._poiRow.querySelectorAll('.poi-pill').forEach(pill => {
    pill.classList.toggle('active', Number.parseInt(pill.dataset.poiIndex) === mgr._activePoiIndex);
  });
}

/**
 * Forget the last free-text search destination and repaint the LOCATION
 * readout. Public so camera owners that fly on their own — scene playback
 * most of all — can invalidate it without reaching into private state.
 * @param {object} mgr - StyleManager instance (src/ui.js) caching
 *   `_searchedLocationLabel` and owning the mini-status elements the repaint
 *   targets.
 * @returns {void}
 */
export function clearSearchedLocation(mgr) {
  if (mgr._searchedLocationLabel === null) return;
  mgr._searchedLocationLabel = null;
  updateLocationMiniStatus(mgr);
}

/**
 * Sets the active city location, highlights its pill, and updates the mini-status readout.
 * @param {object} mgr - StyleManager instance holding the active location id, searched-label cache, and location pill elements.
 * @param {string|null} locationId - City identifier, or null to clear.
 * @returns {void}
 */
function setActiveLocation(mgr, locationId) {
  mgr._activeLocationId = locationId;
  // A preset city is now what the camera is framed on, so any earlier
  // free-text destination has been superseded. Clearing only on a real id
  // leaves the search path's own setActiveLocation(mgr, null) untouched.
  if (locationId) mgr._searchedLocationLabel = null;
  mgr._locationPills.querySelectorAll('.location-pill').forEach(pill => {
    pill.classList.toggle('active', pill.dataset.locationId === locationId);
  });
  updateLocationMiniStatus(mgr);
}

/**
 * Updates the collapsed mini-status readout with the current destination:
 * a preset city + POI/landmark, or the last free-text geocode search.
 * @param {object} mgr - StyleManager instance (src/ui.js) holding the
 *   active-location/POI/searched-label state the readout is derived from and
 *   the `_locationMiniCity`/`_locationMiniPoi` elements it is written into.
 * @returns {void}
 */
export function updateLocationMiniStatus(mgr) {
  if (!mgr._locationMiniCity || !mgr._locationMiniPoi) return;
  const lines = locationMiniStatus({
    city: mgr._activeLocationId ? CITY_POIS[mgr._activeLocationId] : null,
    currentPoi: mgr._currentPoi,
    searchedLabel: mgr._searchedLocationLabel,
  });
  mgr._locationMiniCity.textContent = lines.city;
  mgr._locationMiniPoi.textContent = lines.poi;
}
