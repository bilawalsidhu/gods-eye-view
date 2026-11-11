import * as geo from '../../geo/index.js';
import {
  MARKER_LIFT_M,
  SELECTED_LIFT_M,
  RADIO_OVERLAY_SOURCE_ID,
  RADIO_OVERLAY_COHORT_LIMIT,
  RADIO_OVERLAY_SOURCE_OPTIONS,
  DEFAULT_RADIO_FILTER,
} from './policy.js';

export function createRendering({
  state: layerState,
  services,
  parts,
  source,
}) {
  const { clearSource, setVisible, setEntries } = services.overlays;
  const { governorRequestRender } = services.render;

  function markerPosition(station, liftM = MARKER_LIFT_M) {
    return parts.renderer.markerPosition(station, liftM);
  }

  function updateSelectionEntity() {
    parts.renderer?.clearSelected();
    layerState._selectedPosition = null;
    const station = parts.queries.selectedPresentationStation();
    if (
      !parts.interaction.radioPresentationAllowed() ||
      !parts.renderer?.ready ||
      !station
    ) {
      scheduleRadioOverlayPublish();
      return;
    }
    const color = parts.model.radioCategoryColor(
      parts.model.radioStationCategoryId(station),
    );
    const position = markerPosition(station, SELECTED_LIFT_M);
    layerState._selectedPosition = position;
    parts.renderer.addSelected(station, position, color);
    scheduleRadioOverlayPublish();
  }

  function publishRadioOverlayEntries() {
    layerState._overlayPublishTimer = null;
    if (
      !parts.renderer?.ready ||
      !parts.interaction.radioPresentationAllowed()
    ) {
      parts.clustering.resetRadioClusterOverlayIdentities();
      layerState._overlayDiagnostics =
        parts.clustering.emptyRadioOverlayDiagnostics();
      clearSource(RADIO_OVERLAY_SOURCE_ID);
      setVisible(RADIO_OVERLAY_SOURCE_ID, false);
      return;
    }

    const entries = [];
    const station = parts.queries.selectedPresentationStation();
    if (station) {
      const selectedEntry = parts.labels.createRadioSelectedOverlayEntry(
        station,
        markerPosition(station, SELECTED_LIFT_M),
      );
      if (selectedEntry) entries.push(selectedEntry);
    }

    const clusterCandidates = [];
    const clusteredStationIds = new Set();
    for (const point of parts.renderer?.clusters() || []) {
      const stationIds = point.stationIds
        .filter((id) => {
          const station = layerState._stationById.get(id);
          return (
            station &&
            parts.categories.stationMatchesRadioCategory(
              station,
              layerState._filter,
            )
          );
        })
        .sort();
      if (stationIds.length < 3) continue;
      for (const stationId of stationIds) clusteredStationIds.add(stationId);
      const clusteredStations = stationIds.map((id) =>
        layerState._stationById.get(id),
      );
      const category = parts.model.radioClusterCategoryId(
        clusteredStations,
        layerState._filter,
      );
      clusterCandidates.push({
        id: `${stationIds[0]}:${stationIds.at(-1)}:${stationIds.length}`,
        stationIds,
        point,
        text: parts.model.radioClusterBadgeText(category, stationIds.length),
        accent: parts.model.radioCategoryColor(category),
        stationCount: stationIds.length,
      });
    }
    const selectedClusterCandidates =
      parts.clustering.selectRadioClusterCandidates(clusterCandidates);
    layerState._clusterOverlayIdentities =
      parts.clustering.reconcileRadioClusterCandidates(
        selectedClusterCandidates,
        layerState._clusterOverlayIdentities,
        () => `stable:${++layerState._clusterOverlayIdentitySequence}`,
      );
    for (const candidate of layerState._clusterOverlayIdentities) {
      const clusterEntry = parts.labels.createRadioClusterOverlayEntry({
        ...candidate,
        position: () => candidate.point.position,
      });
      if (clusterEntry) entries.push(clusterEntry);
    }

    const cameraPosition = parts.renderer?.cameraPosition();
    const singletonAllowance = Math.min(
      parts.clustering.radioSingletonLabelLimit(parts.renderer?.cameraHeight()),
      Math.max(
        0,
        RADIO_OVERLAY_COHORT_LIMIT - selectedClusterCandidates.length,
      ),
    );
    const singletonCandidates = parts.clustering.selectRadioSingletonCandidates(
      [...layerState._renderById.values()]
        .filter(
          (record) =>
            record.visible &&
            record.station?.id !== station?.id &&
            !clusteredStationIds.has(record.station?.id),
        )
        .map((record) => ({
          ...record,
          distanceM: cameraPosition
            ? geo.cartesian3.distance(cameraPosition, record.position)
            : Number.POSITIVE_INFINITY,
        })),
      singletonAllowance,
    );
    for (let index = 0; index < singletonCandidates.length; index += 1) {
      const candidate = singletonCandidates[index];
      const singletonEntry = parts.labels.createRadioSingletonOverlayEntry({
        station: candidate.station,
        position: candidate.position,
        // Cluster priorities begin at three. Keep clusters authoritative while
        // retaining nearest-first singleton ordering inside the ambient lane.
        priority: 2 - index / Math.max(1, singletonCandidates.length + 1),
      });
      if (singletonEntry) entries.push(singletonEntry);
    }

    setEntries(RADIO_OVERLAY_SOURCE_ID, entries, RADIO_OVERLAY_SOURCE_OPTIONS);
    setVisible(RADIO_OVERLAY_SOURCE_ID, true);
    layerState._overlayDiagnostics = {
      entryCount: entries.length,
      selectedCount: entries.filter((entry) => entry.selected).length,
      singletonTexts: entries
        .filter((entry) => entry.id.startsWith('station:'))
        .map((entry) => entry.title),
      singletonIds: entries
        .filter((entry) => entry.id.startsWith('station:'))
        .map((entry) => entry.id),
      clusterTexts: entries
        .filter((entry) => entry.id.startsWith('cluster:'))
        .map((entry) => entry.title),
      clusterIds: entries
        .filter((entry) => entry.id.startsWith('cluster:'))
        .map((entry) => entry.id),
      clusterMemberships: layerState._clusterOverlayIdentities.map(
        (candidate) => ({
          membershipId: candidate.membershipId,
          entryId: `cluster:${candidate.id}`,
        }),
      ),
    };
  }

  function scheduleRadioOverlayPublish() {
    if (layerState._overlayPublishTimer)
      clearTimeout(layerState._overlayPublishTimer);
    const sessionGeneration = layerState._sessionGeneration;
    layerState._overlayPublishTimer = setTimeout(() => {
      if (sessionGeneration === layerState._sessionGeneration)
        publishRadioOverlayEntries();
    }, 0);
  }

  function updateRenderVisibility({ force = true } = {}) {
    if (!parts.renderer?.ready) return;
    const cameraPosition = parts.renderer.cameraPosition();
    if (
      !force &&
      !parts.navigation.radioCameraPositionChanged(
        layerState._lastHorizonCameraPosition,
        cameraPosition,
      )
    )
      return;
    layerState._lastHorizonCameraPosition = cameraPosition
      ? { x: cameraPosition.x, y: cameraPosition.y, z: cameraPosition.z }
      : null;
    layerState._horizonScanCount += 1;
    let visibilityChanged = false;
    for (const record of layerState._renderById.values()) {
      const matches = parts.categories.stationMatchesRadioCategory(
        record.station,
        layerState._filter,
      );
      const visible = matches && parts.renderer.horizonVisible(record.position);
      if (record.visible !== visible) visibilityChanged = true;
      record.visible = visible;
      parts.renderer.setStationVisible(record, visible);
    }
    if (layerState._selectedPosition) {
      visibilityChanged =
        parts.renderer.setSelectedVisible(
          parts.renderer.horizonVisible(layerState._selectedPosition),
        ) || visibilityChanged;
    }
    scheduleRadioOverlayPublish();
    // The horizon timer can commit AFTER the camera settles and the governor
    // parks the scene — a changed show flag needs one frame. (perf wave 2 fix)
    if (visibilityChanged)
      governorRequestRender('radio-horizon', parts.renderer?.engine);
  }

  function reconcileStations(stations) {
    if (!layerState._tuningActive)
      layerState._cancelledTuningPresentationStation = null;
    layerState._clusterOverlayIdentities =
      parts.clustering.retainRadioClusterIdentitiesForStations(
        layerState._clusterOverlayIdentities,
        stations,
      );
    layerState._stations = Object.freeze([...stations]);
    layerState._stationById = new Map(
      stations.map((station) => [station.id, station]),
    );
    parts.presentation.buildCategories();
    if (
      layerState._filter === DEFAULT_RADIO_FILTER &&
      !parts.categories.filterRadioStations(stations, DEFAULT_RADIO_FILTER)
        .length
    ) {
      layerState._filter = 'all';
    }
    if (
      layerState._selectedId &&
      !layerState._stationById.has(layerState._selectedId)
    ) {
      if (layerState._audioStationId === layerState._selectedId)
        parts.playback.stopRadioPlayback();
      layerState._selectedId = null;
    }

    drawStations(stations);
  }

  function drawStations(stations) {
    if (!parts.renderer?.ready) return;
    parts.renderer.clearStations();
    layerState._renderById.clear();
    for (const station of stations) {
      const position = markerPosition(station);
      const markerColor = parts.model.radioCategoryColor(
        parts.model.radioStationCategoryId(station),
      );
      const record = parts.renderer.addStation(station, position, markerColor);
      layerState._renderById.set(station.id, record);
    }
    updateSelectionEntity();
    updateRenderVisibility();
  }

  return {
    markerPosition,
    updateSelectionEntity,
    publishRadioOverlayEntries,
    scheduleRadioOverlayPublish,
    updateRenderVisibility,
    reconcileStations,
    drawStations,
  };
}
