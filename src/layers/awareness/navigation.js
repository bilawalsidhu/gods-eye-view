import {
  summarizeAwarenessCohort,
  getAwarenessNavigationTargets,
  AWARENESS_MAX_FLIGHT_SEARCH_RADIUS_M,
  findByDoublingRadius,
  AWARENESS_RADIUS_M,
  aircraftClassMatches,
} from '../../data/militaryAwarenessEngine.js';
import {
  AWARENESS_MAX_EXAMPLES,
  AWARENESS_MAX_NAVIGATION_EXAMPLES,
} from './policy.js';

export function summarizeAwarenessCohortForNavigation(
  items,
  source,
  {
    displayLimit = AWARENESS_MAX_EXAMPLES,
    navigationLimit = AWARENESS_MAX_NAVIGATION_EXAMPLES,
    complete = true,
  } = {},
) {
  const summary = summarizeAwarenessCohort(items, {
    ...source,
    limit: navigationLimit,
  });
  if (summary.count === null) return summary;
  return {
    ...summary,
    complete: Boolean(complete),
    truncated: !complete,
    nearest: summary.nearest.slice(0, displayLimit),
    navigationNearest: summary.nearest,
  };
}

export function isFlightLayer(layerId) {
  return layerId === 'flights' || layerId === 'military';
}

/**
 * Resolves NEXT availability from the same three branches used by navigation.
 * Forward history remains usable while a feed is unavailable; discovering a
 * new nearby or expanded target requires a known subject cohort.
 * @param {Object} availability Navigation branch availability.
 * @returns {boolean} Whether NEXT has a path that can run.
 */

export function canNavigateAwarenessNext({
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

export function createNavigation({ state: layerState, services, parts }) {
  const flightsLayer = services.flights;
  const militaryFlightsLayer = services.military;

  function resetNavigationVisitedCycle() {
    layerState.navigationVisited.clear();
    const currentKey = parts.subject.subjectKey(layerState.subject);
    if (currentKey) layerState.navigationVisited.add(currentKey);
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
        aircraftClassMatches(target.item, aircraftClass),
      );
    }
    return targets;
  }

  /** Nearby aircraft of both layers, flights first, filtered by layer and class. */
  function nearbyAircraft(
    radiusM,
    limits,
    { targetLayer = null, aircraftClass = null } = {},
  ) {
    const near = (layerId, layer, limit) =>
      targetLayer && targetLayer !== layerId
        ? []
        : layer
            .getNearby(layerState.subject.position, radiusM, limit, {
              includeHidden: true,
            })
            .filter((item) => aircraftClassMatches(item, aircraftClass))
            .map((item) => ({ layerId, item }));
    return [
      ...near('flights', flightsLayer, limits.flights),
      ...near('military', militaryFlightsLayer, limits.military),
    ];
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
    return nearbyAircraft(
      AWARENESS_MAX_FLIGHT_SEARCH_RADIUS_M,
      { flights: 2, military: 2 },
      { targetLayer, aircraftClass },
    ).some(
      ({ layerId, item }) =>
        `${layerId}:${item.icao24 || item.id}` !==
        parts.subject.subjectKey(layerState.subject),
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
    const candidates = nearbyAircraft(
      radiusM,
      { flights: 25000, military: 5000 },
      { targetLayer, aircraftClass },
    )
      .map(({ layerId, item }) => ({ layerId, id: String(item.icao24), item }))
      .filter((target) => {
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
    selectNavigationTargets,
    findExpandedFlightTarget,
    canNavigateAwarenessNext,
    canNavigateNext,
  };
}
