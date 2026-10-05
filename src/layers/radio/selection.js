import { normalizeRadioFilter } from '../../data/layerState.js';
import { RADIO_TUNER_DIRECTORY_LIMIT } from './policy.js';

export function createSelection({
  state: layerState,
  services,
  parts,
  source,
}) {
  const { warmGroundFloor } = services.ground;

  /** Durable Radio preferences; this surface never creates or plays audio. */

  function setRadioParams(params = {}) {
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
    if (changed && parts.interaction.radioPresentationAllowed()) {
      parts.rendering.updateRenderVisibility();
      if (filterChanged && layerState._dataSource?.clustering?.enabled) {
        const clusterPoints = layerState._dataSource.clustering.clusterPoints;
        layerState._dataSource.clustering.clusterPoints = !clusterPoints;
        layerState._dataSource.clustering.clusterPoints = clusterPoints;
        layerState._viewer?.scene?.requestRender();
      }
      parts.rendering.scheduleRadioOverlayPublish();
    }
    parts.presentation.emitState();
    return true;
  }

  function getRadioParams() {
    return { filter: layerState._filter, volume: layerState._userVolume };
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
    } = {},
  ) {
    if (!parts.interaction.radioPresentationAllowed()) return false;
    const station = layerState._stationById.get(String(id));
    if (!station) return false;
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
    return true;
  }

  /** Select the previous or next station and optionally retain a UI-owned band order. */

  function cycleRadioStation(
    direction = 1,
    {
      rotate = false,
      stationIds = null,
      autoplay = true,
      origin = 'programmatic',
    } = {},
  ) {
    if (!parts.interaction.radioPresentationAllowed()) return false;
    const ranked =
      Array.isArray(stationIds) && stationIds.length
        ? stationIds
            .slice(0, RADIO_TUNER_DIRECTORY_LIMIT)
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
    const current = ranked.findIndex(
      (station) => station.id === layerState._selectedId,
    );
    const nextIndex =
      current < 0
        ? 0
        : (current + (direction < 0 ? -1 : 1) + ranked.length) % ranked.length;
    layerState._playFallbackId =
      ranked.length > 1 ? ranked[(nextIndex + 1) % ranked.length].id : null;
    const rotationCameraState = rotate
      ? parts.navigation.radioCameraState()
      : null;
    const rotationNavigation = rotate
      ? parts.navigation.beginRadioCameraNavigation(rotationCameraState)
      : null;
    layerState._playFallbackFocus = rotate
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
    const station = ranked[nextIndex];
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
    layerState._playFallbackId = ranked[1]?.id || null;
    layerState._playFallbackFocus = false;
    selectRadioStation(ranked[0].id, { autoplay, focus: false, origin });
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
    if (changed && layerState._dataSource?.clustering?.enabled) {
      // Entity visibility changes do not invalidate Cesium's existing cluster
      // primitives. Toggle a public clustering input twice to mark the current
      // cluster set dirty without changing its effective configuration.
      const clusterPoints = layerState._dataSource.clustering.clusterPoints;
      layerState._dataSource.clustering.clusterPoints = !clusterPoints;
      layerState._dataSource.clustering.clusterPoints = clusterPoints;
      layerState._viewer?.scene?.requestRender();
    }
    parts.rendering.scheduleRadioOverlayPublish();
    parts.presentation.emitState();
    return true;
  }
  return {
    setRadioParams,
    getRadioParams,
    selectRadioStation,
    cycleRadioStation,
    selectRequestedRadioStation,
    setRadioFilter,
  };
}
