import { AWARENESS_RADIUS_M } from '../../data/militaryAwarenessEngine.js';
import { DEPENDENCIES, AWARENESS_QUERY_LIMIT } from './policy.js';

export function createQueries({ state: layerState, services, parts, source }) {
  const flightsLayer = services.flights;
  const militaryFlightsLayer = services.military;

  function sourceState(layerId) {
    const lifecycle =
      layerState.dataManager?.getLayerLifecycleState?.(layerId) || null;
    const enabled =
      lifecycle?.enabled === true ||
      layerState.dataManager?.isEnabled(layerId) === true;
    const enabling = lifecycle?.lifecycleState === 'enabling';
    const moduleStats =
      layerState.dataManager?.layers?.get(layerId)?.module?.getStats?.() || {};
    const stats = enabling
      ? { ...moduleStats, loading: true, status: 'loading' }
      : moduleStats;
    // A deferred source that has started but not settled is not evidence of an
    // empty cohort. Keep it explicitly unavailable so the panel cannot flash a
    // false all-clear, even if a lifecycle adapter briefly reports the requested
    // visibility intent as enabled.
    //
    // `enabling` and the never-answered predicate cover two DIFFERENT windows, and
    // both are needed because these dependencies do not settle the same way.
    //
    //   - military-installations is covered by `enabling` alone. Its enable() is
    //     SYNCHRONOUS and the manager awaits update(), which owns the first
    //     Overpass fetch, so the lifecycle stays `enabling` for that whole window
    //     however long the fetch takes. Confirmed live: a held 17 s first fetch
    //     read `enabling` across 34 samples with the panel non-numeric throughout,
    //     and a failing one settled to `enabled` with status 'unavailable'. Its
    //     getStats() also reports loading while a request is in progress —
    //     setInstallationStatus is only ever called with
    //     loading/zoom-in/ready/stale/empty/unavailable.
    //   - ais-live-vessels is what the predicate below is FOR. Its enable() and
    //     update() both resolve as soon as the first /api/ais-live poll answers,
    //     so the lifecycle settles to `enabled` — but until the server-side socket
    //     delivers a position, firstConnectPhase is 'loading' and getStats()
    //     reports loading: true, lastUpdate: null, count 0, and an UNDEFINED
    //     status. That zero is an absence of evidence, not evidence of absence,
    //     and neither the lifecycle nor the status list can tell.
    //
    // Deliberately `loading === true` and not truthiness: layers that never report
    // a busy flag (flights, military) must keep answering for themselves, and a
    // source that HAS answered once (lastUpdate set) keeps its last real count
    // through every later poll rather than blanking to `?` on each refresh.
    const neverAnswered = stats.loading === true && !stats.lastUpdate;
    const unavailable =
      enabling ||
      !enabled ||
      neverAnswered ||
      ['unavailable', 'zoom-in'].includes(stats.status) ||
      Boolean(stats.error && stats.count === 0);
    return { available: !unavailable, stale: Boolean(stats.stale), stats };
  }

  function collectSourceStates() {
    return Object.fromEntries(
      DEPENDENCIES.map((layerId) => [layerId, sourceState(layerId)]),
    );
  }

  function sourceRevision(sourceStates) {
    return DEPENDENCIES.map((layerId) => {
      const source = sourceStates[layerId];
      const stats = source?.stats || {};
      return [
        layerId,
        source?.available,
        source?.stale,
        stats.lastUpdate || null,
        stats.count ?? null,
        stats.status || null,
        stats.error || null,
      ];
    })
      .map((parts) => parts.join(':'))
      .join('|');
  }

  function isSame(subject, item, prefix, key) {
    return (
      subject?.layerId === prefix && String(subject.id) === String(item?.[key])
    );
  }

  /**
   * Summarize viewport-backed installations without implying radius-complete coverage.
   * @param {Array<object>} items Loaded installation matches.
   * @param {object} source Current source availability and staleness.
   * @returns {object} Awareness summary with viewport-honest reasoning.
   */

  function summarizeInstallationViewport(items, source) {
    const summary = parts.navigation.summarizeAwarenessCohortForNavigation(
      items,
      source,
    );
    if (summary.count === null)
      return source.stats?.statusMessage
        ? { ...summary, reason: source.stats.statusMessage }
        : summary;
    return {
      ...summary,
      reason: summary.count
        ? 'mapped matches from the loaded viewport'
        : 'viewport feed is not a complete 250 km survey',
    };
  }

  /**
   * THE aircraft-proximity engine. One computation, two consumers: the Contacts
   * panel window and the voice analyst's entity-centred "how many nearby".
   *
   * They used to be separate. The panel read live billboard positions through
   * `getNearby` with a 20 000 cap; the analyst re-derived its own answer from
   * last-fix coordinates over a 2 000-record slice. Same question, same centre,
   * two numbers — and in the owner's trial the spoken answer (15) and the panel
   * (111) disagreed badly enough that the model narrated the difference away.
   * Routing both through here makes them the same number BY CONSTRUCTION, so
   * they cannot drift again.
   *
   * The subject is excluded from its own window, which is why the panel reads
   * "contacts around X" rather than "including X".
   * @param {Cesium.Cartesian3} position Window centre.
   * @param {object} [options]
   * @param {number} [options.radiusM=AWARENESS_RADIUS_M] Window radius.
   * @param {object|null} [options.subject=null] Contact at the centre, excluded.
   * @returns {{flights: Array, military: Array, aircraft: number}|null} Cohorts
   *   plus the combined aircraft count, or null without a position.
   */

  function collectAircraftProximityWindow(
    position,
    { radiusM = AWARENESS_RADIUS_M, subject = null } = {},
  ) {
    if (!position) return null;
    const flights = flightsLayer
      .getNearby(position, radiusM, AWARENESS_QUERY_LIMIT, {
        includeHidden: true,
      })
      .filter(
        (item) => !subject || !isSame(subject, item, 'flights', 'icao24'),
      );
    const military = militaryFlightsLayer
      .getNearby(position, radiusM, AWARENESS_QUERY_LIMIT, {
        includeHidden: true,
      })
      .filter(
        (item) => !subject || !isSame(subject, item, 'military', 'icao24'),
      );
    return { flights, military, aircraft: flights.length + military.length };
  }
  return {
    sourceState,
    collectSourceStates,
    sourceRevision,
    isSame,
    summarizeInstallationViewport,
    collectAircraftProximityWindow,
  };
}
