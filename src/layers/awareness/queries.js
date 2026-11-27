import { AWARENESS_RADIUS_M } from '../../data/militaryAwarenessEngine.js';

// The reason stays English for the voice analyst; the Contacts panel shows it
// in the UI language from `reasonTemplate`.
const msg = (text) => text;
const fillTemplate = (template, values = {}) =>
  template.replace(/\{(\w+)\}/g, (_, name) => String(values[name]));
const withReason = (summary, template, values) => ({
  ...summary,
  reason: fillTemplate(template, values),
  reasonTemplate: template,
  reasonValues: values,
});
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
    // `enabling` covers the first fetch inside enable/update (military-installations).
    // `neverAnswered` covers a lifecycle that settles before data arrives
    // (ais-live-vessels reports loading with no lastUpdate). Checking `loading === true`
    // lets layers without a busy flag answer for themselves. A source that answered once
    // keeps its last count.
    const neverAnswered = stats.loading === true && !stats.lastUpdate;
    const unavailable =
      enabling ||
      !enabled ||
      neverAnswered ||
      ['unavailable', 'zoom-in'].includes(stats.status) ||
      Boolean(stats.error && stats.count === 0);
    return {
      available: !unavailable,
      enabled,
      stale: Boolean(stats.stale),
      stats,
    };
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
        stats.source || null,
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
    const coverage = source.stats?.coverage;
    // getNearby measures these distances from the current subject, independent
    // of the retained square used to fetch installation tiles.
    const withinRadius =
      coverage?.kind === 'subject' && Number.isFinite(coverage.radiusM)
        ? items.filter(
            (item) => (item.distanceM ?? item.distance) <= coverage.radiusM,
          )
        : items;
    const summary = parts.navigation.summarizeAwarenessCohortForNavigation(
      withinRadius,
      source,
    );
    if (summary.count === null)
      return source.stats?.statusMessage
        ? { ...summary, reason: source.stats.statusMessage }
        : summary;
    // A subject window is its own bounded area: name it instead of the viewport.
    if (coverage?.kind === 'subject' && Number.isFinite(coverage.radiusM)) {
      const km = Math.round(coverage.radiusM / 1000);
      return withReason(
        summary,
        summary.count
          ? msg('mapped matches within {km} km of the subject')
          : msg('none mapped within {km} km; not a complete 250 km survey'),
        { km },
      );
    }
    return withReason(
      summary,
      summary.count
        ? msg('mapped matches from the loaded viewport')
        : msg('viewport feed is not a complete 250 km survey'),
    );
  }

  /**
   * THE aircraft-proximity engine. One computation, two consumers: the Contacts
   * panel window and the voice analyst's entity-centred "how many nearby".
   *
   * One computation serves the Contacts panel window and the analyst's entity-centred
   * nearby count, so the two numbers agree.
   *
   * The subject is excluded from its own window, which is why the panel reads
   * "contacts around X" rather than "including X".
   * @param {Cesium.Cartesian3} position Window centre.
   * @param {object} [options]
   * @param {number} [options.radiusM=AWARENESS_RADIUS_M] Window radius.
   * @param {object|null} [options.subject=null] Contact at the centre, excluded.
   * @returns {{flights: Array, military: Array, aircraft: number,
   *   completeByLayer: {flights: boolean, military: boolean}}|null} Cohorts,
   *   their lower-bound completeness, and the combined aircraft count, or
   *   null without a position.
   */

  function collectAircraftProximityWindow(
    position,
    { radiusM = AWARENESS_RADIUS_M, subject = null } = {},
  ) {
    if (!position) return null;
    // Ask for one usable row beyond the retained limit so a capped cohort is
    // reported as a lower bound instead of an exact count. The selected
    // subject can consume one slot before exclusion, hence the extra two.
    const sampleLimit = AWARENESS_QUERY_LIMIT + 2;
    const flightSample = flightsLayer
      .getNearby(position, radiusM, sampleLimit, {
        includeHidden: true,
      })
      .filter(
        (item) => !subject || !isSame(subject, item, 'flights', 'icao24'),
      );
    const militarySample = militaryFlightsLayer
      .getNearby(position, radiusM, sampleLimit, {
        includeHidden: true,
      })
      .filter(
        (item) => !subject || !isSame(subject, item, 'military', 'icao24'),
      );
    const flights = flightSample.slice(0, AWARENESS_QUERY_LIMIT);
    const military = militarySample.slice(0, AWARENESS_QUERY_LIMIT);
    return {
      flights,
      military,
      aircraft: flights.length + military.length,
      completeByLayer: {
        flights: flightSample.length <= AWARENESS_QUERY_LIMIT,
        military: militarySample.length <= AWARENESS_QUERY_LIMIT,
      },
    };
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
