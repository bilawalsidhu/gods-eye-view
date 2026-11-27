import { cycleIndex } from '../../data/layerSteps.js';
import { normalizeRadioFilter } from '../../data/layerState.js';
import { RADIO_DIRECTORY_REFRESH_MS, RADIO_SOURCES } from './policy.js';

export function createSelection({
  state: layerState,
  services,
  parts,
  source,
}) {
  const { warmGroundFloor } = services.ground;
  let directoryReadInterrupted = false;

  /** Durable Radio preferences; this surface never creates or plays audio. */

  function setRadioParams(params = {}, { origin } = {}) {
    const nextFilter = Object.hasOwn(params, 'filter')
      ? normalizeRadioFilter(params.filter)
      : null;
    if (Object.hasOwn(params, 'filter') && !nextFilter) return false;
    const numericVolume = Object.hasOwn(params, 'volume')
      ? Number(params.volume)
      : null;
    if (Object.hasOwn(params, 'volume') && !Number.isFinite(numericVolume))
      return false;
    const nextVolume =
      numericVolume === null
        ? null
        : parts.volume.clampRadioVolume(numericVolume);
    const nextSource = Object.hasOwn(params, 'source')
      ? RADIO_SOURCES.includes(params.source)
        ? params.source
        : null
      : undefined;
    if (nextSource === null) return false;

    let changed = false;
    let filterChanged = false;
    let clearedCancelledPresentation = false;
    if (nextFilter !== null) {
      filterChanged = nextFilter !== layerState._filter;
      if (
        filterChanged &&
        (layerState._tuningActive || layerState._tuningAwaitingStationId)
      )
        parts.tuning.endRadioTuning();
      clearedCancelledPresentation = Boolean(
        layerState._cancelledTuningPresentationStation,
      );
      layerState._cancelledTuningPresentationStation = null;
      layerState._filter = nextFilter;
      if (clearedCancelledPresentation) parts.rendering.updateSelectionEntity();
      if (filterChanged) parts.clustering.resetRadioClusterOverlayIdentities();
      changed ||= filterChanged || clearedCancelledPresentation;
    }
    if (nextVolume !== null && nextVolume !== layerState._userVolume) {
      layerState._userVolume = nextVolume;
      if (layerState._audio && !layerState._voiceDucked) {
        parts.volume.cancelRadioVolumeTransition();
        layerState._voiceRestoring = false;
        layerState._audio.volume = nextVolume;
      }
      parts.tuningNoise.syncTuningNoiseGain();
      changed = true;
    }
    const sourceChanged =
      nextSource !== undefined && nextSource !== layerState._source;
    if (sourceChanged) {
      setRadioSource(nextSource);
      changed = true;
    }
    if (changed && parts.interaction.radioPresentationAllowed()) {
      parts.rendering.updateRenderVisibility();
      if (filterChanged) parts.rendering.reclusterStations();
      parts.rendering.scheduleRadioOverlayPublish();
    }
    parts.presentation.emitState(sourceChanged ? origin : undefined);
    return true;
  }

  function getRadioParams() {
    return {
      filter: layerState._filter,
      volume: layerState._userVolume,
      source: layerState._source,
    };
  }

  /**
   * Switch between the internet stations and a local receiver. The local
   * receiver stops the internet stream and takes the stations off the map;
   * back on Internet, cached stations are drawn while any due read runs. The receiver's own audio is stopped by its controls
   * (LocalSdrControls), which follow this source.
   */
  function setRadioSource(next) {
    layerState._source = next;
    if (next === 'local') {
      parts.tuning.endRadioTuning();
      if (layerState._audioStationId)
        parts.playback.stopRadioPlayback({ origin: 'user' });
      directoryReadInterrupted = Boolean(layerState._abortController);
      layerState._requestGeneration += 1;
      layerState._abortController?.abort();
      layerState._abortController = null;
      layerState._loading = false;
    }
    parts.interaction.syncRadioLifecyclePresentation();
    if (
      next === 'internet' &&
      layerState._enabled &&
      (!layerState._stations.length ||
        directoryReadInterrupted ||
        Date.now() - Date.parse(layerState._updatedAt) >=
          RADIO_DIRECTORY_REFRESH_MS)
    )
      void parts.ingestion?.methods?.update?.();
  }

  // A paused or failed stream of another station would outlive its selection.
  function releaseStaleRadioStream(stationId) {
    if (
      layerState._audioStationId &&
      layerState._audioStationId !== stationId &&
      ['paused', 'error'].includes(layerState._audioState)
    )
      parts.playback.stopRadioPlayback();
  }

  /** Select a station. Playback occurs only when autoplay is explicitly true. */

  function selectRadioStation(
    id,
    {
      autoplay = false,
      focus = false,
      origin = 'programmatic',
      attemptId = null,
      cameraNavigation = null,
      playFallback = null,
    } = {},
  ) {
    if (!parts.interaction.radioPresentationAllowed()) return false;
    const station = layerState._stationById.get(String(id));
    if (!station) return false;
    if (!autoplay) releaseStaleRadioStream(station.id);
    // Set after the release, which clears fallbacks.
    if (playFallback) {
      layerState._playFallbackId = playFallback.id;
      layerState._playFallbackFocus = playFallback.focus;
    }
    layerState._tuningUnavailableStationId = null;
    if (
      !parts.navigation.radioCameraNavigationOwnsSelection(
        cameraNavigation,
        station,
      )
    ) {
      parts.navigation.invalidateRadioCameraNavigation();
    }
    if (
      layerState._tuningActive ||
      (layerState._tuningAwaitingStationId &&
        layerState._tuningAwaitingStationId !== station.id)
    )
      parts.tuning.endRadioTuning();
    layerState._cancelledTuningPresentationStation = null;
    const changed = layerState._selectedId !== station.id;
    layerState._selectedId = station.id;
    const generation = ++layerState._selectionGeneration;
    const sessionGeneration = layerState._sessionGeneration;
    parts.rendering.updateSelectionEntity();
    warmGroundFloor([{ lat: station.lat, lon: station.lon }]);
    if (layerState._selectionTimer) clearTimeout(layerState._selectionTimer);
    layerState._selectionTimer = setTimeout(() => {
      layerState._selectionTimer = null;
      if (
        sessionGeneration === layerState._sessionGeneration &&
        generation === layerState._selectionGeneration &&
        layerState._selectedId === station.id
      )
        parts.rendering.updateSelectionEntity();
    }, 1300);
    if (focus) parts.navigation.focusStation(station);
    parts.presentation.emitState();
    if (autoplay) void parts.playback.playSelectedRadio({ origin, attemptId });
    // A user step to another station cancels a playback voice prepared.
    else if (origin === 'user' && changed)
      parts.presentation.emitPlaybackControl('select', origin);
    return true;
  }

  /**
   * Play a station whether or not the layer is on: with the layer off (a
   * pinned station, the mini player) the stream starts from the station
   * catalogue already read, without drawing the layer or turning it on.
   * False when the catalogue has no such station, or while the local
   * receiver is the source: it plays no internet station until the user
   * switches back.
   */
  function playRadioStation(id, { origin = 'programmatic' } = {}) {
    if (layerState._source === 'local') return false;
    const station = layerState._stationById.get(String(id));
    if (!station?.streamUrl) return false;
    parts.playback.clearRadioFallback();
    if (parts.interaction.radioPresentationAllowed())
      return selectRadioStation(id, { autoplay: true, origin });
    releaseStaleRadioStream(station.id);
    parts.navigation.invalidateRadioCameraNavigation();
    layerState._cancelledTuningPresentationStation = null;
    layerState._tuningUnavailableStationId = null;
    layerState._selectedId = station.id;
    layerState._selectionGeneration += 1;
    parts.presentation.emitState();
    void parts.playback.playSelectedRadio({ origin, whileOff: true });
    return true;
  }

  function steppedStationIndex(ranked, direction) {
    const current = ranked.findIndex(
      (station) => station.id === layerState._selectedId,
    );
    return cycleIndex(current, direction < 0 ? -1 : 1, ranked.length, 0);
  }

  /**
   * Step to the previous or next station of the catalogue already read,
   * with the layer off: nearest the view first, as with the layer on, but
   * without moving the camera or drawing anything. The stream follows the
   * step while one is heard. False when there is nothing to step to.
   */
  function stepRadioStationWhileOff(
    direction = 1,
    { origin = 'programmatic' } = {},
  ) {
    const ranked = parts.queries.rankedVisibleStations();
    if (ranked.length < 2) return false;
    const next = ranked[steppedStationIndex(ranked, direction)];
    const sounding = ['loading', 'buffering', 'playing'].includes(
      layerState._audioState,
    );
    if (sounding) return playRadioStation(next.id, { origin });
    releaseStaleRadioStream(next.id);
    layerState._selectedId = next.id;
    layerState._selectionGeneration += 1;
    parts.presentation.emitState();
    return true;
  }

  /** Select the previous or next station and optionally retain a UI-owned band order. */

  function cycleRadioStation(
    direction = 1,
    {
      rotate = false,
      stationIds = null,
      autoplay = true,
      fallback = autoplay,
      origin = 'programmatic',
    } = {},
  ) {
    if (!parts.interaction.radioPresentationAllowed()) return false;
    const ranked =
      Array.isArray(stationIds) && stationIds.length
        ? stationIds
            .map((id) => layerState._stationById.get(String(id)))
            .filter(
              (station) =>
                station &&
                parts.categories.stationMatchesRadioCategory(
                  station,
                  layerState._filter,
                ),
            )
        : parts.queries.rankedVisibleStations();
    if (!ranked.length) return false;
    const nextIndex = steppedStationIndex(ranked, direction);
    const station = ranked[nextIndex];
    if (
      autoplay &&
      station.id === layerState._selectedId &&
      station.id === layerState._audioStationId &&
      ['loading', 'buffering', 'playing'].includes(layerState._audioState)
    )
      return false;
    // Voice defers playback, so its silent step keeps a fallback; silent UI steps do not.
    const fallbackId =
      fallback && ranked.length > 1
        ? ranked[(nextIndex + 1) % ranked.length].id
        : null;
    const rotationCameraState = rotate
      ? parts.navigation.radioCameraState()
      : null;
    const rotationNavigation = rotate
      ? parts.navigation.beginRadioCameraNavigation(rotationCameraState)
      : null;
    const fallbackFocus =
      fallback && rotate
        ? (fallbackStation) => {
            parts.navigation.rotateRadioStationIntoView(
              fallbackStation,
              0.65,
              rotationCameraState,
              rotationNavigation,
            );
            return rotationNavigation;
          }
        : false;
    if (rotate)
      parts.navigation.rotateRadioStationIntoView(
        station,
        0.65,
        rotationCameraState,
        rotationNavigation,
      );
    return selectRadioStation(station.id, {
      autoplay,
      focus: false,
      origin,
      cameraNavigation: rotationNavigation,
      playFallback: { id: fallbackId, focus: fallbackFocus },
    });
  }

  /** Select and optionally play the best station for a location/category request. */

  function selectRequestedRadioStation(
    criteria = {},
    { autoplay = true, origin = 'programmatic' } = {},
  ) {
    if (!parts.interaction.radioPresentationAllowed()) return null;
    const requestedCategory = String(criteria.categoryId || 'all');
    const categoryId = layerState._categories.some(
      (category) => category.id === requestedCategory,
    )
      ? requestedCategory
      : 'all';
    setRadioFilter(categoryId);
    const ranked = parts.queries.rankRadioStationsForRequest(
      layerState._stations,
      {
        ...criteria,
        categoryId,
        anchor: criteria.anchor || parts.queries.viewportRadioAnchor(),
      },
    );
    if (!ranked.length) return null;
    selectRadioStation(ranked[0].id, {
      autoplay,
      focus: false,
      origin,
      playFallback: { id: ranked[1]?.id || null, focus: false },
    });
    return ranked[0];
  }

  /** Change marker/list category without interrupting an active station. */

  function setRadioFilter(categoryId) {
    if (!parts.interaction.radioPresentationAllowed()) return false;
    const valid = layerState._categories.some(
      (category) => category.id === categoryId,
    );
    const nextFilter = valid ? categoryId : 'all';
    const changed = nextFilter !== layerState._filter;
    if (
      changed &&
      (layerState._tuningActive || layerState._tuningAwaitingStationId)
    )
      parts.tuning.endRadioTuning();
    const clearsCancelledPresentation = Boolean(
      layerState._cancelledTuningPresentationStation,
    );
    layerState._cancelledTuningPresentationStation = null;
    layerState._filter = nextFilter;
    if (clearsCancelledPresentation) parts.rendering.updateSelectionEntity();
    if (changed) parts.clustering.resetRadioClusterOverlayIdentities();
    parts.rendering.updateRenderVisibility();
    if (changed) parts.rendering.reclusterStations();
    parts.rendering.scheduleRadioOverlayPublish();
    parts.presentation.emitState();
    return true;
  }
  return {
    setRadioParams,
    getRadioParams,
    selectRadioStation,
    playRadioStation,
    stepRadioStationWhileOff,
    cycleRadioStation,
    selectRequestedRadioStation,
    setRadioFilter,
  };
}
