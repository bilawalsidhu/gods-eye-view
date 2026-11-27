import { aircraftClassMatches } from '../../data/militaryAwarenessEngine.js';
import { isFlightLayer } from './navigation.js';

/** Retain filter metadata when a production subject enters navigation history. */

export function historySubjectSnapshot(subject, sourceItem = null) {
  const aircraftClass =
    sourceItem?.aircraftClass ||
    sourceItem?.klass ||
    sourceItem?.type ||
    subject?.aircraftClass ||
    null;
  return aircraftClass ? { ...subject, aircraftClass } : { ...subject };
}

/** Find the next history entry compatible with requested navigation filters. */

export function findCompatibleHistoryIndex(
  history,
  startIndex,
  direction,
  {
    targetLayer = null,
    aircraftClass = null,
    aircraftOnly = false,
    resolveItem = (subject) => subject,
  } = {},
) {
  const step = direction < 0 ? -1 : 1;
  for (
    let index = startIndex + step;
    index >= 0 && index < history.length;
    index += step
  ) {
    const subject = history[index];
    if (aircraftOnly && !isFlightLayer(subject?.layerId)) continue;
    if (targetLayer && subject?.layerId !== targetLayer) continue;
    if (
      aircraftClass &&
      !aircraftClassMatches(resolveItem(subject), aircraftClass)
    )
      continue;
    return index;
  }
  return -1;
}

export function createHistory({ state: layerState, services, parts }) {
  const militaryFlightsLayer = services.military;
  const flightsLayer = services.flights;

  /**
   * Walk navigation history for the next entry that can still be focused.
   *
   * A history entry only holds a SNAPSHOT of a contact; the live contact behind
   * it can be evicted from its layer at any time (the cull that drives
   * CONTACT LOST). Focusing an evicted entry fails, so stepping over it is the
   * only way PREVIOUS/NEXT survives a lost subject — stopping at the first dead
   * entry strands the operator there for the rest of the session, because the
   * index never advances past it.
   *
   * `state.navigationIndex` moves only on a successful focus: a caller that
   * falls through to the live cohort must still splice forward history from the
   * position the operator actually occupies.
   * @param {number} direction Walk direction (negative = previous).
   * @param {{targetLayer: string|null, aircraftClass: string|null}} filters Navigation filters.
   * @returns {boolean} Whether a history entry was focused.
   */

  function focusCompatibleHistory(
    direction,
    { targetLayer, aircraftClass, aircraftOnly, origin = 'programmatic' },
  ) {
    let cursor = layerState.navigationIndex;
    for (;;) {
      const historyIndex = findCompatibleHistoryIndex(
        layerState.navigationHistory,
        cursor,
        direction,
        {
          targetLayer,
          aircraftClass,
          aircraftOnly,
          resolveItem: historySubjectItem,
        },
      );
      if (historyIndex === -1) return false;
      if (
        parts.focus.focusSubject(
          layerState.navigationHistory[historyIndex],
          true,
          { origin },
        )
      ) {
        layerState.navigationIndex = historyIndex;
        return true;
      }
      // Contact evicted since it entered history — step over it. The scan is
      // strictly monotonic, so this terminates at the end of history.
      cursor = historyIndex;
    }
  }

  function navigateHistory(
    direction,
    {
      targetLayer = null,
      aircraftClass = null,
      aircraftOnly = false,
      origin = 'programmatic',
    } = {},
  ) {
    if (
      focusCompatibleHistory(direction, {
        targetLayer,
        aircraftClass,
        aircraftOnly,
        origin,
      })
    )
      return true;

    if (direction < 0) return false;

    const focusExpanded = () => {
      const expanded = parts.navigation.findExpandedFlightTarget({
        targetLayer,
        aircraftClass,
      });
      return expanded
        ? parts.focus.requestFocus(
            expanded.candidate.layerId,
            expanded.candidate.id,
            false,
            { origin },
          )
        : null;
    };
    let targets = parts.navigation.selectNavigationTargets(
      layerState.results?.cohorts,
      layerState.subject,
      [...layerState.navigationVisited],
      { targetLayer, aircraftClass, aircraftOnly },
    );
    const targetHistoryFullyVisited =
      targets.length > 0 && targets.every((target) => target.visited);
    const subjectCohortUnknown = parts.subject.subjectCohortFeedUnknown();
    if (
      targetHistoryFullyVisited &&
      parts.navigation.isFlightLayer(layerState.subject?.layerId) &&
      !subjectCohortUnknown
    ) {
      const focused = focusExpanded();
      if (focused !== null) return focused;
    }
    if (targetHistoryFullyVisited) {
      parts.navigation.resetNavigationVisitedCycle();
      targets = parts.navigation.selectNavigationTargets(
        layerState.results?.cohorts,
        layerState.subject,
        [...layerState.navigationVisited],
        { targetLayer, aircraftClass, aircraftOnly },
      );
    }
    const hasNearbyFlight = targets.some((target) =>
      parts.navigation.isFlightLayer(target.layerId),
    );
    if (
      parts.navigation.isFlightLayer(layerState.subject?.layerId) &&
      !hasNearbyFlight &&
      !subjectCohortUnknown
    ) {
      const focused = focusExpanded();
      if (focused !== null) return focused;
    }
    if (parts.subject.subjectCohortFeedUnknown()) return false;
    const candidate = targets[0];
    if (!candidate) return false;
    return parts.focus.requestFocus(candidate.layerId, candidate.id, false, {
      origin,
    });
  }

  /** The subject's record in the current sweep's cohort, if it is there. */
  function cohortItem(subject) {
    const cohort = layerState.results?.cohorts?.find(
      (item) => item.id === subject.layerId,
    );
    return (
      cohort?.summary?.navigationNearest ||
      cohort?.summary?.nearest ||
      []
    ).find(
      (item) =>
        String(item?.icao24 || item?.id || item?.mmsi) === String(subject.id),
    );
  }

  function historySubjectItem(subject) {
    if (!subject) return null;
    return cohortItem(subject) || subject;
  }

  function historySourceItem(subject) {
    if (!parts.navigation.isFlightLayer(subject?.layerId) || !subject?.position)
      return null;
    // The current sweep already holds this contact's record. Reusing it keeps
    // selection O(1) against the cohort instead of paying a fresh full-layer
    // proximity scan per selection — the burst cost when NEXT walks a cohort.
    const fromSweep = cohortItem(subject);
    if (fromSweep) return fromSweep;
    const layer =
      subject.layerId === 'military' ? militaryFlightsLayer : flightsLayer;
    return (
      layer
        .getNearby(subject.position, 1000, 25, { includeHidden: true })
        .find(
          (item) => String(item?.icao24 || item?.id) === String(subject.id),
        ) || null
    );
  }

  return {
    navigateHistory,
    historySubjectItem,
    historySubjectSnapshot,
    historySourceItem,
    findCompatibleHistoryIndex,
  };
}
