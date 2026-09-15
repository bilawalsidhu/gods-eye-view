import {
  RADIO_TUNER_STATION_LIMIT,
  RADIO_TUNER_DIRECTORY_LIMIT,
  EMPTY_ACCEPTED_CATALOG_SNAPSHOT,
} from './policy.js';

export function createTuning({ state: layerState, services, parts, source }) {
  /** Bound one already ordered filtered directory without injecting outside selections. */

  function buildRadioTunerBand(
    rankedStations,
    selected,
    limit = RADIO_TUNER_STATION_LIMIT,
  ) {
    const boundedLimit = Math.min(
      RADIO_TUNER_DIRECTORY_LIMIT,
      Math.max(1, Math.floor(Number(limit) || RADIO_TUNER_STATION_LIMIT)),
    );
    return (Array.isArray(rankedStations) ? rankedStations : []).slice(
      0,
      boundedLimit,
    );
  }

  function captureRadioTuningResolutionSnapshot() {
    return layerState._acceptedCatalogSnapshot;
  }

  /** Return the complete accepted filtered directory in stable catalog order. */

  function getRadioTunerStations(limit = RADIO_TUNER_STATION_LIMIT) {
    if (
      !parts.interaction.radioPresentationAllowed() ||
      !layerState._acceptedCatalogSnapshot.stations.length
    )
      return [];
    return buildRadioTunerBand(
      parts.queries.visibleStations(),
      parts.queries.selectedStation(),
      limit,
    );
  }

  /** Begin a direct-manipulation tuning gesture and pause the current stream. */

  function beginRadioTuning() {
    if (
      !parts.interaction.radioPresentationAllowed() ||
      !parts.queries.visibleStations().length
    )
      return false;
    const snapshot = captureRadioTuningResolutionSnapshot();
    if (!Number.isSafeInteger(snapshot.generation) || !snapshot.stations.length)
      return false;
    layerState._tuningResolutionSnapshot = snapshot;
    layerState._tuningStationById = new Map(
      layerState._tuningResolutionSnapshot.stations.map((station) => [
        station.id,
        station,
      ]),
    );
    layerState._tuningUnavailableStationId = null;
    layerState._tuningActive = true;
    layerState._tuningStatic = false;
    layerState._tuningAwaitingStationId = null;
    layerState._cancelledTuningPresentationStation = null;
    layerState._tuningStartStationId = layerState._selectedId;
    layerState._tuningPreviewId = layerState._selectedId;
    parts.tuningNoise.installTuningNoise();
    parts.playback.pauseRadioPlayback({ origin: 'user' });
    parts.tuningNoise.syncTuningNoiseGain();
    parts.presentation.emitState();
    return true;
  }

  /** Toggle low-volume synthesized static for tuner preview and stream handoff. */

  function setRadioTuningStatic(active) {
    if (
      !parts.interaction.radioPresentationAllowed() ||
      !layerState._tuningActive
    )
      return false;
    const next = Boolean(active);
    if (next === layerState._tuningStatic) return true;
    layerState._tuningStatic = next;
    parts.tuningNoise.syncTuningNoiseGain();
    parts.presentation.emitState();
    return true;
  }

  /** Preview a tuner station bracket and camera orientation without starting audio. */

  function previewRadioTuningStation(id, { rotate = true } = {}) {
    if (
      !parts.interaction.radioPresentationAllowed() ||
      !layerState._tuningActive
    )
      return false;
    const station = parts.model.tuningResolutionStation(id);
    const nextId = station?.id || null;
    const changed = nextId !== layerState._tuningPreviewId;
    layerState._tuningPreviewId = nextId;
    layerState._tuningStatic = !station;
    if (changed) {
      parts.rendering.updateSelectionEntity();
      if (station && rotate) {
        const cameraState = parts.navigation.radioCameraState();
        layerState._tuningCameraNavigation =
          parts.navigation.beginRadioCameraNavigation(cameraState);
        parts.navigation.rotateRadioStationIntoView(
          station,
          0.35,
          cameraState,
          layerState._tuningCameraNavigation,
        );
      } else if (rotate) {
        layerState._tuningCameraNavigation = null;
        parts.navigation.invalidateRadioCameraNavigation();
      }
    }
    parts.tuningNoise.syncTuningNoiseGain();
    parts.presentation.emitState();
    return Boolean(station);
  }

  /** Finish a tuning gesture and release its synthesized noise source. */

  function endRadioTuning() {
    if (
      !layerState._tuningActive &&
      !layerState._tuningStatic &&
      !layerState._tuningAwaitingStationId &&
      !layerState._tuningNoiseSource &&
      !layerState._cancelledTuningPresentationStation
    )
      return;
    parts.tuningNoise.clearRadioTuningNoise();
  }

  /** Cancel a tuning gesture and restore its frozen start marker for presentation only. */

  function cancelRadioTuning() {
    if (!layerState._tuningActive) return false;
    const restoredStation = parts.model.tuningResolutionStation(
      layerState._tuningStartStationId,
    );
    parts.tuningNoise.clearRadioTuningNoise({ restoredStation });
    return true;
  }

  /** Commit the exact frozen drag resolution or report that it is unavailable. */

  function commitRadioTuningStation(id, { origin = 'programmatic' } = {}) {
    const frozenStation = parts.model.tuningResolutionStation(id);
    const currentStation = layerState._stationById.get(String(id)) || null;
    const generation = layerState._tuningResolutionSnapshot.generation;
    if (
      !parts.interaction.radioPresentationAllowed() ||
      !layerState._tuningActive ||
      !frozenStation
    ) {
      endRadioTuning();
      return Object.freeze({
        ok: false,
        reason: 'not-tuning',
        stationId: String(id || ''),
        generation,
      });
    }
    if (
      !parts.model.radioStationResolutionMatches(frozenStation, currentStation)
    ) {
      const stationId = frozenStation.id;
      // A failed exact release owns the visible outcome. Do not let the previous
      // selection—or changed metadata under the same ID—reappear between the
      // frozen preview and the unavailable state.
      layerState._selectedId = null;
      layerState._selectionGeneration += 1;
      parts.tuningNoise.clearRadioTuningNoise({ emit: false });
      layerState._tuningUnavailableStationId = stationId;
      parts.presentation.emitState();
      return Object.freeze({
        ok: false,
        reason: 'station-unavailable',
        stationId,
        generation,
      });
    }
    layerState._tuningActive = false;
    layerState._tuningStatic = true;
    layerState._tuningAwaitingStationId = frozenStation.id;
    layerState._tuningPreviewId = null;
    layerState._tuningStartStationId = null;
    layerState._tuningUnavailableStationId = null;
    const cameraNavigation = layerState._tuningCameraNavigation;
    layerState._tuningCameraNavigation = null;
    layerState._tuningResolutionSnapshot = EMPTY_ACCEPTED_CATALOG_SNAPSHOT;
    layerState._tuningStationById = new Map();
    // An exact tuner release owns its frozen target. A fallback armed by an
    // earlier non-playing selection must never retarget this gesture if the
    // broadcaster fails after release.
    layerState._playFallbackId = null;
    layerState._playFallbackFocus = null;
    layerState._playFallbackOrigin = 'programmatic';
    layerState._playFallbackAttemptId = null;
    parts.tuningNoise.syncTuningNoiseGain();
    parts.presentation.emitState();
    const selected = parts.selection.selectRadioStation(frozenStation.id, {
      autoplay: true,
      focus: false,
      origin,
      cameraNavigation,
    });
    return Object.freeze({
      ok: selected,
      reason: selected ? null : 'station-unavailable',
      stationId: frozenStation.id,
      generation,
    });
  }
  return {
    buildRadioTunerBand,
    captureRadioTuningResolutionSnapshot,
    getRadioTunerStations,
    beginRadioTuning,
    setRadioTuningStatic,
    previewRadioTuningStation,
    endRadioTuning,
    cancelRadioTuning,
    commitRadioTuningStation,
  };
}
