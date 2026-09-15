import * as Cesium from 'cesium';
import { horizonOccluder } from '../../data/iconOrientation.js';
import {
  MARKER_LIFT_M,
  RADIO_PREFIX,
  SELECTED_LIFT_M,
  RADIO_GLOBE_INTERACTION_MAX_DISTANCE_M,
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
  const { cachedGroundFloor } = services.ground;
  const { clearOverlaySource, setOverlaySourceVisible, setOverlayEntries } =
    services.overlays;
  const { governorRequestRender } = services.render;

  function markerPosition(station, liftM = MARKER_LIFT_M) {
    const floor = cachedGroundFloor(station.lat, station.lon);
    return Cesium.Cartesian3.fromDegrees(
      station.lon,
      station.lat,
      (Number.isFinite(floor) ? floor : 0) + liftM,
    );
  }

  function updateSelectionEntity() {
    if (layerState._selectedEntity && layerState._viewer)
      layerState._viewer.entities.remove(layerState._selectedEntity);
    layerState._selectedEntity = null;
    const station = parts.queries.selectedPresentationStation();
    if (
      !parts.interaction.radioPresentationAllowed() ||
      !layerState._viewer ||
      !station
    ) {
      scheduleRadioOverlayPublish();
      return;
    }
    const selectionColor = parts.model.radioCategoryColor(
      parts.model.radioStationCategoryId(station),
    );
    const bracketImage = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(parts.labels.radioSelectionBracketSvg(selectionColor))}`;

    layerState._selectedEntity = layerState._viewer.entities.add({
      id: `${RADIO_PREFIX}selected:${station.id}`,
      position: markerPosition(station, SELECTED_LIFT_M),
      point: {
        pixelSize: 14,
        color: Cesium.Color.fromCssColorString(selectionColor),
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(
          0,
          RADIO_GLOBE_INTERACTION_MAX_DISTANCE_M,
        ),
      },
      billboard: {
        image: bracketImage,
        width: 40,
        height: 40,
        horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
        verticalOrigin: Cesium.VerticalOrigin.CENTER,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(
          0,
          RADIO_GLOBE_INTERACTION_MAX_DISTANCE_M,
        ),
        scaleByDistance: new Cesium.NearFarScalar(100_000, 1, 12_000_000, 0.72),
      },
    });
    scheduleRadioOverlayPublish();
  }

  function clusterPointCollection() {
    return layerState._dataSource?.clustering?._clusterPointCollection || null;
  }

  function publishRadioOverlayEntries() {
    layerState._overlayPublishTimer = null;
    if (!parts.interaction.radioPresentationAllowed()) {
      parts.clustering.resetRadioClusterOverlayIdentities();
      layerState._overlayDiagnostics =
        parts.clustering.emptyRadioOverlayDiagnostics();
      clearOverlaySource(RADIO_OVERLAY_SOURCE_ID);
      setOverlaySourceVisible(RADIO_OVERLAY_SOURCE_ID, false);
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
    const points = clusterPointCollection();
    for (let index = 0; index < (points?.length || 0); index += 1) {
      const point = points.get(index);
      if (
        !point?.show ||
        !point.position ||
        !Array.isArray(point.id) ||
        point.id.length < 3
      )
        continue;
      const stationIds = point.id
        .map((entity) => String(entity?.id || '').slice(RADIO_PREFIX.length))
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

    const cameraPosition = layerState._viewer?.camera?.positionWC;
    const singletonAllowance = Math.min(
      parts.clustering.radioSingletonLabelLimit(
        layerState._viewer?.camera?.positionCartographic?.height,
      ),
      Math.max(
        0,
        RADIO_OVERLAY_COHORT_LIMIT - selectedClusterCandidates.length,
      ),
    );
    const singletonCandidates = parts.clustering.selectRadioSingletonCandidates(
      [...layerState._renderById.values()]
        .filter(
          (record) =>
            record.entity?.show &&
            record.station?.id !== station?.id &&
            !clusteredStationIds.has(record.station?.id),
        )
        .map((record) => ({
          ...record,
          distanceM: cameraPosition
            ? Cesium.Cartesian3.distance(cameraPosition, record.position)
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

    setOverlayEntries(
      RADIO_OVERLAY_SOURCE_ID,
      entries,
      RADIO_OVERLAY_SOURCE_OPTIONS,
    );
    setOverlaySourceVisible(RADIO_OVERLAY_SOURCE_ID, true);
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
    if (!layerState._viewer || !layerState._dataSource) return;
    const cameraPosition = layerState._viewer.camera?.positionWC;
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
    const occluder = horizonOccluder(layerState._viewer.camera);
    let visibilityChanged = false;
    for (const [id, record] of layerState._renderById) {
      const matches = parts.categories.stationMatchesRadioCategory(
        record.station,
        layerState._filter,
      );
      const visible = matches && occluder.isPointVisible(record.position);
      if (record.entity.show !== visible) visibilityChanged = true;
      record.entity.show = visible;
    }
    if (layerState._selectedEntity) {
      const position = layerState._selectedEntity.position?.getValue?.(
        Cesium.JulianDate.now(),
      );
      const selectedVisible = !position || occluder.isPointVisible(position);
      if (layerState._selectedEntity.show !== selectedVisible)
        visibilityChanged = true;
      layerState._selectedEntity.show = selectedVisible;
    }
    scheduleRadioOverlayPublish();
    // The horizon timer can commit AFTER the camera settles and the governor
    // parks the scene — a changed show flag needs one frame. (perf wave 2 fix)
    if (visibilityChanged) governorRequestRender('radio-horizon');
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
    layerState._categories = Object.freeze(
      parts.categories
        .buildRadioCategories(stations)
        .map((category) => Object.freeze(category)),
    );
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

    if (layerState._dataSource) layerState._dataSource.entities.removeAll();
    layerState._renderById.clear();
    for (const station of stations) {
      const position = markerPosition(station);
      const markerColor = parts.model.radioCategoryColor(
        parts.model.radioStationCategoryId(station),
      );
      const entity = layerState._dataSource.entities.add({
        id: `${RADIO_PREFIX}${station.id}`,
        position,
        point: {
          pixelSize: 13,
          color: Cesium.Color.fromCssColorString(markerColor).withAlpha(0.86),
          outlineColor: Cesium.Color.fromCssColorString('#071b25'),
          outlineWidth: 1,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scaleByDistance: new Cesium.NearFarScalar(
            100_000,
            1.15,
            12_000_000,
            1,
          ),
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(
            0,
            RADIO_GLOBE_INTERACTION_MAX_DISTANCE_M,
          ),
        },
      });
      layerState._renderById.set(station.id, { station, entity, position });
    }
    updateSelectionEntity();
    updateRenderVisibility();
  }

  function installClusterStyling() {
    if (!layerState._dataSource || layerState._removeClusterListener) return;
    const clustering = layerState._dataSource.clustering;
    clustering.enabled = true;
    clustering.pixelRange = 42;
    clustering.minimumClusterSize = 3;
    clustering.clusterPoints = true;
    clustering.clusterLabels = false;
    clustering.clusterBillboards = false;
    layerState._removeClusterListener =
      clustering.clusterEvent.addEventListener((clusteredEntities, cluster) => {
        const clusteredStations = [];
        for (const entity of clusteredEntities) {
          const stationId = String(entity.id || '').slice(RADIO_PREFIX.length);
          const station = layerState._renderById.get(stationId)?.station;
          if (station) clusteredStations.push(station);
        }
        const clusterCategory = parts.model.radioClusterCategoryId(
          clusteredStations,
          layerState._filter,
        );
        const clusterColor = Cesium.Color.fromCssColorString(
          parts.model.radioCategoryColor(clusterCategory),
        );
        // Cesium assigns the entity-id array only to the generated cluster label.
        // Mirror it to the visible point so clicking either part of the callout
        // resolves the first station and remains a direct playback gesture.
        cluster.point.id = clusteredEntities;
        cluster.billboard.id = clusteredEntities;
        cluster.label.show = false;
        cluster.label.text = '';
        cluster.point.show = true;
        cluster.point.pixelSize = Math.min(
          26,
          12 + Math.log2(clusteredEntities.length) * 1.6,
        );
        cluster.point.color = clusterColor.withAlpha(0.9);
        cluster.point.outlineColor = Cesium.Color.BLACK;
        cluster.point.outlineWidth = 2;
        cluster.point.disableDepthTestDistance = Number.POSITIVE_INFINITY;
        cluster.point.distanceDisplayCondition =
          new Cesium.DistanceDisplayCondition(
            0,
            RADIO_GLOBE_INTERACTION_MAX_DISTANCE_M,
          );
        scheduleRadioOverlayPublish();
      });
  }
  return {
    markerPosition,
    updateSelectionEntity,
    clusterPointCollection,
    publishRadioOverlayEntries,
    scheduleRadioOverlayPublish,
    updateRenderVisibility,
    reconcileStations,
    installClusterStyling,
  };
}
