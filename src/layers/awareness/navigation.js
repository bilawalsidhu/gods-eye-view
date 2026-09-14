import {
  summarizeAwarenessCohort,
  getAwarenessNavigationTargets,
  AWARENESS_MAX_FLIGHT_SEARCH_RADIUS_M,
  findByDoublingRadius,
  AWARENESS_RADIUS_M,
} from '../../data/militaryAwarenessEngine.js';
import {
  AWARENESS_MAX_EXAMPLES,
  AWARENESS_MAX_NAVIGATION_EXAMPLES,
} from './policy.js';

export function createNavigation({
  state: layerState,
  services,
  parts,
  source,
}) {
  const flightsLayer = services.flights;
  const militaryFlightsLayer = services.military;

  function summarizeAwarenessCohortForNavigation(
    items,
    source,
    {
      displayLimit = AWARENESS_MAX_EXAMPLES,
      navigationLimit = AWARENESS_MAX_NAVIGATION_EXAMPLES,
    } = {},
  ) {
    const summary = summarizeAwarenessCohort(items, {
      ...source,
      limit: navigationLimit,
    });
    if (summary.count === null) return summary;
    return {
      ...summary,
      nearest: summary.nearest.slice(0, displayLimit),
      navigationNearest: summary.nearest,
    };
  }

  function resetNavigationVisitedCycle() {
    layerState.navigationVisited.clear();
    const currentKey = parts.subject.subjectKey(layerState.subject);
    if (currentKey) layerState.navigationVisited.add(currentKey);
  }

  function isFlightLayer(layerId) {
    return layerId === 'flights' || layerId === 'military';
  }

  function normalizeAircraftClass(value) {
    return String(value || '')
      .trim()
      .toLowerCase();
  }

  function aircraftClassMatchesFilter(item, aircraftClass) {
    const requested = normalizeAircraftClass(aircraftClass);
    if (!requested) return true;
    const candidates = [
      item?.aircraftClass,
      item?.klass,
      item?.type,
      item?.typeCode,
      item?.typeName,
    ]
      .map((value) => normalizeAircraftClass(value))
      .filter(Boolean);
    if (!candidates.length) return false;
    return candidates.some(
      (candidate) => candidate === requested || candidate.includes(requested),
    );
  }

  function selectNavigationTargets(
    sourceCohorts,
    subject,
    visitedKeys,
    { targetLayer = null, aircraftClass = null, aircraftOnly = false } = {},
  ) {
    let targets = getAwarenessNavigationTargets(
      sourceCohorts,
      subject,
      visitedKeys,
    );
    if (aircraftOnly) {
      targets = targets.filter((target) => isFlightLayer(target.layerId));
    }
    if (targetLayer) {
      targets = targets.filter((target) => target.layerId === targetLayer);
    }
    if (aircraftClass) {
      targets = targets.filter((target) =>
        aircraftClassMatchesFilter(target.item, aircraftClass),
      );
    }
    return targets;
  }

  function alternativeFlightAvailable({
    targetLayer = null,
    aircraftClass = null,
  } = {}) {
    if (
      !isFlightLayer(layerState.subject?.layerId) ||
      !layerState.subject?.position
    )
      return false;
    if (targetLayer && !isFlightLayer(targetLayer)) return false;

    const flights =
      targetLayer === 'military'
        ? []
        : flightsLayer
            .getNearby(
              layerState.subject.position,
              AWARENESS_MAX_FLIGHT_SEARCH_RADIUS_M,
              2,
              { includeHidden: true },
            )
            .filter((item) => aircraftClassMatchesFilter(item, aircraftClass));

    const military =
      targetLayer === 'flights'
        ? []
        : militaryFlightsLayer
            .getNearby(
              layerState.subject.position,
              AWARENESS_MAX_FLIGHT_SEARCH_RADIUS_M,
              2,
              { includeHidden: true },
            )
            .filter((item) => aircraftClassMatchesFilter(item, aircraftClass));

    return [
      ['flights', flights],
      ['military', military],
    ].some(([layerId, items]) =>
      items.some(
        (item) =>
          `${layerId}:${item.icao24 || item.id}` !==
          parts.subject.subjectKey(layerState.subject),
      ),
    );
  }

  function closestFlightWithinRadius(
    radiusM,
    visitedKeys,
    excludeVisited,
    { targetLayer = null, aircraftClass = null } = {},
  ) {
    if (!layerState.subject?.position) return null;
    const visited = new Set(visitedKeys);
    if (targetLayer && !isFlightLayer(targetLayer)) return null;
    const candidates = [
      ...(targetLayer === 'military'
        ? []
        : flightsLayer
            .getNearby(layerState.subject.position, radiusM, 25000, {
              includeHidden: true,
            })
            .filter((item) => aircraftClassMatchesFilter(item, aircraftClass))
            .map((item) => ({
              layerId: 'flights',
              id: String(item.icao24),
              item,
            }))),
      ...(targetLayer === 'flights'
        ? []
        : militaryFlightsLayer
            .getNearby(layerState.subject.position, radiusM, 5000, {
              includeHidden: true,
            })
            .filter((item) => aircraftClassMatchesFilter(item, aircraftClass))
            .map((item) => ({
              layerId: 'military',
              id: String(item.icao24),
              item,
            }))),
    ].filter((target) => {
      const key = `${target.layerId}:${target.id}`;
      if (key === parts.subject.subjectKey(layerState.subject)) return false;
      return !excludeVisited || !visited.has(key);
    });
    candidates.sort(
      (a, b) =>
        (a.item.distanceM ?? a.item.distance ?? Infinity) -
        (b.item.distanceM ?? b.item.distance ?? Infinity),
    );
    return candidates[0] || null;
  }

  function findExpandedFlightTarget(options = {}) {
    if (!isFlightLayer(layerState.subject?.layerId)) return null;
    let visitedKeys = [...layerState.navigationVisited];
    const search = () =>
      findByDoublingRadius(
        (radiusM) =>
          closestFlightWithinRadius(radiusM, visitedKeys, true, options),
        {
          initialRadiusM: AWARENESS_RADIUS_M,
          maxRadiusM: AWARENESS_MAX_FLIGHT_SEARCH_RADIUS_M,
        },
      );
    const target = search();
    if (target) return target;
    resetNavigationVisitedCycle();
    visitedKeys = [...layerState.navigationVisited];
    return search();
  }

  /**
   * Resolves NEXT availability from the same three branches used by navigation.
   * Forward history remains usable while a feed is unavailable; discovering a
   * new nearby or expanded target requires a known subject cohort.
   * @param {Object} availability Navigation branch availability.
   * @returns {boolean} Whether NEXT has a path that can run.
   */

  function canNavigateAwarenessNext({
    hasForwardHistory = false,
    hasExpandedFlightTarget = false,
    hasNearbyTarget = false,
    subjectCohortUnknown = false,
  } = {}) {
    return Boolean(
      hasForwardHistory ||
      (!subjectCohortUnknown && (hasExpandedFlightTarget || hasNearbyTarget)),
    );
  }

  function canNavigateNext({ targetLayer = null, aircraftClass = null } = {}) {
    return canNavigateAwarenessNext({
      hasForwardHistory:
        parts.history.findCompatibleHistoryIndex(
          layerState.navigationHistory,
          layerState.navigationIndex,
          1,
          {
            targetLayer,
            aircraftClass,
            resolveItem: parts.history.historySubjectItem,
          },
        ) !== -1,
      hasNearbyTarget:
        selectNavigationTargets(
          layerState.results?.cohorts,
          layerState.subject,
          [...layerState.navigationVisited],
          { targetLayer, aircraftClass },
        ).length > 0,
      hasExpandedFlightTarget: alternativeFlightAvailable({
        targetLayer,
        aircraftClass,
      }),
      subjectCohortUnknown: parts.subject.subjectCohortFeedUnknown(),
    });
  }
  return {
    summarizeAwarenessCohortForNavigation,
    resetNavigationVisitedCycle,
    isFlightLayer,
    normalizeAircraftClass,
    aircraftClassMatchesFilter,
    selectNavigationTargets,
    alternativeFlightAvailable,
    closestFlightWithinRadius,
    findExpandedFlightTarget,
    canNavigateAwarenessNext,
    canNavigateNext,
  };
}
