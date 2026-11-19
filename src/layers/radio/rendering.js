import { cssColor } from '../../render/color.js';
import {
  canvasOf,
  drawOf,
  findCamera,
  findQuery,
} from '../../render/rendererOf.js';
import { fromDegrees } from '../../geo/ellipsoid.js';
import { horizonFrom } from '../../geo/horizon.js';
import { distance } from '../../geo/vector.js';
import { clusterScreenPoints } from '../../geo/screenCluster.js';
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

/** Draw sets made so far, by every Radio layer: set ids unique to each. */
let instances = 0;

/** Where a station's dot shows: from the ground out to the globe view. */
const DISPLAY_RANGE = Object.freeze([
  0,
  RADIO_GLOBE_INTERACTION_MAX_DISTANCE_M,
]);
const STATION_SCALE_BY_DISTANCE = Object.freeze({
  near: 100_000,
  nearValue: 1.15,
  far: 12_000_000,
  farValue: 1,
});
const BRACKET_SCALE_BY_DISTANCE = Object.freeze({
  near: 100_000,
  nearValue: 1,
  far: 12_000_000,
  farValue: 0.72,
});
const STATION_PIXEL_SIZE = 13;
const STATION_OUTLINE = cssColor('#071b25');
const BLACK = Object.freeze([0, 0, 0, 1]);
/** Stations' screen clustering, as the stations' data source clustered them. */
const CLUSTER_PIXEL_RANGE = 42;
const CLUSTER_MINIMUM_SIZE = 3;

/** A CSS colour with another alpha. */
function withAlpha(css, alpha) {
  const [r, g, b] = cssColor(css) ?? [1, 1, 1];
  return [r, g, b, alpha];
}

/**
 * A station id from ordinary, selected, or cluster pick shapes: a pick id,
 * a renderer pick's `{set, id}`, or a list of them.
 * @param {object|null|undefined} picked A scene pick result.
 * @returns {string|null}
 */
export function radioStationIdFromPick(picked) {
  const pending = [picked?.id, picked?.primitive?.id];
  const seen = new Set();
  while (pending.length) {
    const value = pending.shift();
    if (typeof value === 'string' || typeof value === 'number') {
      const id = String(value);
      if (id.startsWith(`${RADIO_PREFIX}selected:`))
        return id.slice(`${RADIO_PREFIX}selected:`.length);
      if (id.startsWith(RADIO_PREFIX)) return id.slice(RADIO_PREFIX.length);
      continue;
    }
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) pending.push(...value);
    else {
      pending.push(value.id);
      if (value.primitive) pending.push(value.primitive.id);
    }
  }
  return null;
}

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

  /**
   * The layer's draw sets (made with `installDataSource`): the station
   * dots, the cluster dots that stand in for stations drawn too close
   * together, and the selected station's dot and bracket.
   */
  let sets = null;
  /** The camera subscription that clusters the stations again as it moves. */
  let offCameraChanged = null;
  /** What the last clustering pass leaves for the next. */
  let clusterState = null;
  /**
   * The clusters drawn now, each `{position, stationIds}` with its seed
   * station first, and the stations they hold.
   */
  let clusters = [];
  let clusteredIds = new Set();
  /**
   * The stations the last clustering pass left on their own, or null before
   * one: a station it passed over (past the horizon or behind the eye) is
   * hidden until the next, as the default renderer's clustering hid it.
   */
  let singleIds = null;
  /** Each station dot's drawn show, by station id. */
  const drawnShow = new Map();
  /** The selected station's items while it has them, and whether shown. */
  let selection = null;

  function markerPosition(station, liftM = MARKER_LIFT_M) {
    const floor = cachedGroundFloor(station.lat, station.lon);
    return fromDegrees(
      station.lon,
      station.lat,
      (Number.isFinite(floor) ? floor : 0) + liftM,
    );
  }

  /** The eye's pose, or null without a camera. */
  const pose = () => findCamera(layerState._viewer)?.pose() ?? null;

  /** A station's dot item, shown or not. */
  function stationItem(record, show) {
    const markerColor = parts.model.radioCategoryColor(
      parts.model.radioStationCategoryId(record.station),
    );
    return {
      id: `${RADIO_PREFIX}${record.station.id}`,
      pos: record.position,
      pixelSize: STATION_PIXEL_SIZE,
      color: withAlpha(markerColor, 0.86),
      outlineColor: STATION_OUTLINE,
      outlineWidth: 1,
      disableDepthTest: Infinity,
      scaleByDistance: STATION_SCALE_BY_DISTANCE,
      displayRange: DISPLAY_RANGE,
      show,
    };
  }

  /**
   * Draw each station dot that is visible and not standing in a cluster,
   * writing only the dots whose show changed.
   */
  function syncStationShows() {
    if (!sets) return false;
    const changed = [];
    for (const record of layerState._renderById.values()) {
      const show =
        record.visible &&
        (singleIds
          ? singleIds.has(record.station.id)
          : !clusteredIds.has(record.station.id));
      if (drawnShow.get(record.station.id) === show) continue;
      drawnShow.set(record.station.id, show);
      changed.push(stationItem(record, show));
    }
    if (changed.length) sets.stations.upsert(changed);
    return changed.length > 0;
  }

  function updateSelectionEntity() {
    removeSelectionEntity();
    const station = parts.queries.selectedPresentationStation();
    if (
      !parts.interaction.radioPresentationAllowed() ||
      !layerState._viewer ||
      !sets ||
      !station
    ) {
      scheduleRadioOverlayPublish();
      return;
    }
    const selectionColor = parts.model.radioCategoryColor(
      parts.model.radioStationCategoryId(station),
    );
    const id = `${RADIO_PREFIX}selected:${station.id}`;
    const position = markerPosition(station, SELECTED_LIFT_M);
    selection = {
      position,
      shown: true,
      dot: {
        id,
        pos: position,
        pixelSize: 14,
        color: cssColor(selectionColor),
        outlineColor: BLACK,
        outlineWidth: 2,
        disableDepthTest: Infinity,
        displayRange: DISPLAY_RANGE,
      },
      bracket: {
        id,
        pos: position,
        image: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(parts.labels.radioSelectionBracketSvg(selectionColor))}`,
        size: [40, 40],
        disableDepthTest: Infinity,
        displayRange: DISPLAY_RANGE,
        scaleByDistance: BRACKET_SCALE_BY_DISTANCE,
      },
    };
    sets.selectedDot.set([selection.dot]);
    sets.selectedBracket.set([selection.bracket]);
    scheduleRadioOverlayPublish();
  }

  /** Show or hide the selected station's dot and bracket. */
  function showSelection(shown) {
    if (!selection || selection.shown === shown) return false;
    selection.shown = shown;
    sets.selectedDot.upsert([{ ...selection.dot, show: shown }]);
    sets.selectedBracket.upsert([{ ...selection.bracket, show: shown }]);
    return true;
  }

  /**
   * Cluster the visible stations on screen, as the stations' data source
   * clustered them (`geo/screenCluster.js`), draw each cluster as a dot
   * sized by its count and coloured by its stations' category, and hide the
   * stations it holds.
   */
  function clusterStations() {
    if (!sets) return;
    const query = findQuery(layerState._viewer);
    const eye = pose();
    const points = [];
    if (query && eye) {
      const horizon = horizonFrom(eye.position);
      for (const record of layerState._renderById.values()) {
        if (!record.visible || !horizon.isPointVisible(record.position))
          continue;
        const screen = query.project(record.position);
        if (!screen) continue;
        points.push({
          id: record.station.id,
          position: record.position,
          screen,
          pixelSize: STATION_PIXEL_SIZE,
        });
      }
    }
    const viewHeight = canvasOf(layerState._viewer)?.clientHeight ?? 0;
    const result = clusterScreenPoints({
      points,
      pixelRange: CLUSTER_PIXEL_RANGE,
      minimumClusterSize: CLUSTER_MINIMUM_SIZE,
      viewHeight,
      eyeHeight: eye?.height ?? Number.POSITIVE_INFINITY,
      previous: clusterState,
      project: (position) => query.project(position),
      isOccluded: (position) =>
        !horizonFrom(eye.position).isPointVisible(position),
    });
    clusterState = result.state;
    clusters = result.clusters.map(({ position, ids }) => ({
      position,
      stationIds: ids,
    }));
    clusteredIds = new Set(clusters.flatMap((cluster) => cluster.stationIds));
    singleIds = query && eye ? new Set(result.single) : null;
    sets.clusters.set(clusters.map(clusterItem));
    syncStationShows();
    scheduleRadioOverlayPublish();
  }

  /** A cluster's dot: its seed station's id, so a click plays that one. */
  function clusterItem(cluster) {
    const clusteredStations = [];
    for (const stationId of cluster.stationIds) {
      const station = layerState._renderById.get(stationId)?.station;
      if (station) clusteredStations.push(station);
    }
    const clusterCategory = parts.model.radioClusterCategoryId(
      clusteredStations,
      layerState._filter,
    );
    return {
      id: `${RADIO_PREFIX}${cluster.stationIds[0]}`,
      pos: cluster.position,
      pixelSize: Math.min(26, 12 + Math.log2(cluster.stationIds.length) * 1.6),
      color: withAlpha(parts.model.radioCategoryColor(clusterCategory), 0.9),
      outlineColor: BLACK,
      outlineWidth: 2,
      disableDepthTest: Infinity,
      displayRange: DISPLAY_RANGE,
      meta: { stationIds: cluster.stationIds },
    };
  }

  /** The clusters drawn now: `{position, stationIds}`, seed first. */
  function stationClusters() {
    return clusters;
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
    for (const cluster of clusters) {
      if (cluster.stationIds.length < 3) continue;
      const stationIds = cluster.stationIds
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
        point: cluster,
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

    const eye = pose();
    const cameraPosition = eye?.position ?? null;
    const singletonAllowance = Math.min(
      parts.clustering.radioSingletonLabelLimit(eye?.height),
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
            ? distance(cameraPosition, record.position)
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
    if (!layerState._viewer || !sets) return;
    const eye = pose();
    const cameraPosition = eye?.position ?? null;
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
    // With no eye, as with no camera before, nothing is hidden by a horizon.
    const visibleFrom = cameraPosition
      ? horizonFrom(cameraPosition)
      : { isPointVisible: () => true };
    let shownChanged = false;
    for (const record of layerState._renderById.values()) {
      const matches = parts.categories.stationMatchesRadioCategory(
        record.station,
        layerState._filter,
      );
      const visible = matches && visibleFrom.isPointVisible(record.position);
      if (visible !== record.visible) shownChanged = true;
      record.visible = visible;
    }
    // A station shown or hidden clusters the stations again, as the default
    // renderer's clustering did whenever one of its entities came or went.
    let visibilityChanged = false;
    if (shownChanged && sets.stations.show) {
      clusterStations();
      visibilityChanged = true;
    } else visibilityChanged = syncStationShows();
    if (selection)
      visibilityChanged =
        showSelection(visibleFrom.isPointVisible(selection.position)) ||
        visibilityChanged;
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

    layerState._renderById.clear();
    drawnShow.clear();
    clusteredIds = new Set();
    singleIds = null;
    const items = [];
    for (const station of stations) {
      const record = { station, position: markerPosition(station) };
      // Shown until the horizon pass below says otherwise.
      record.visible = true;
      layerState._renderById.set(station.id, record);
      drawnShow.set(station.id, true);
      items.push(stationItem(record, true));
    }
    sets?.stations.set(items);
    updateSelectionEntity();
    updateRenderVisibility();
    clusterStations();
  }

  /**
   * Make the stations' draw sets on the viewer's renderer (`drawOf`), once,
   * and cluster the stations again whenever the camera moves enough.
   * @param {object} viewer
   */
  function installDataSource(viewer) {
    if (sets) return;
    const draw = drawOf(viewer);
    const prefix = `radio:${++instances}`;
    sets = {
      stations: draw.points({ id: `${prefix}:stations` }),
      clusters: draw.points({ id: `${prefix}:clusters` }),
      selectedDot: draw.points({ id: `${prefix}:selected` }),
      selectedBracket: draw.icons({ id: `${prefix}:selected-bracket` }),
    };
    offCameraChanged =
      findCamera(viewer)?.on('changed', () => {
        if (sets?.stations.show) clusterStations();
      }) ?? null;
  }

  /** Stop clustering and let the stations' draw sets go. */
  function removeDataSource() {
    offCameraChanged?.();
    offCameraChanged = null;
    if (sets) for (const set of Object.values(sets)) set.dispose();
    sets = null;
    selection = null;
    clusterState = null;
    clusters = [];
    clusteredIds = new Set();
    singleIds = null;
    drawnShow.clear();
  }

  /** Show or hide the stations and their clusters. */
  function setStationsShown(shown) {
    if (!sets) return;
    const was = sets.stations.show;
    sets.stations.show = shown;
    sets.clusters.show = shown;
    // Hidden, the stations leave nothing for a later pass to keep, as the
    // default renderer's clustering kept nothing of a hidden source.
    if (!shown) clusterState = null;
    if (shown && !was) clusterStations();
  }

  /** Take the selected station's dot and bracket down, if it has them. */
  function removeSelectionEntity() {
    if (!selection) return;
    selection = null;
    sets?.selectedDot.clear();
    sets?.selectedBracket.clear();
  }

  /**
   * Cluster the stations again now: a filter change hides or shows
   * stations, which the camera's next move would otherwise wait for.
   */
  function reclusterStations() {
    if (!sets) return;
    clusterStations();
    governorRequestRender('radio-recluster');
  }

  return {
    radioStationIdFromPick,
    installDataSource,
    removeDataSource,
    setStationsShown,
    removeSelectionEntity,
    reclusterStations,
    markerPosition,
    updateSelectionEntity,
    stationClusters,
    publishRadioOverlayEntries,
    scheduleRadioOverlayPublish,
    updateRenderVisibility,
    reconcileStations,
  };
}
