import {
  AWARENESS_RADIUS_M,
  AWARENESS_RELATIONSHIP,
} from '../../data/militaryAwarenessEngine.js';
import * as Cesium from 'cesium';
import { t } from '../../i18n/index.js';
import {
  AWARENESS_QUERY_LIMIT,
  SOURCE_LABEL,
  SUBJECT_PRESENCE,
  AWARENESS_PAGE_SIZE,
} from './policy.js';

export function createSubject({ state: layerState, services, parts, source }) {
  const aisLiveVesselsLayer = services.vessels;
  const militaryInstallationsLayer = services.installations;
  const flightsLayer = services.flights;
  const militaryFlightsLayer = services.military;

  /**
   * Decide whether a source-scoped context clear belongs to the current subject.
   * @param {{layerId?: string}|null} subject Current awareness subject.
   * @param {{layerId?: string}|null} cleared Cleared source detail.
   * @returns {boolean} Whether the current subject should be cleared.
   */

  function awarenessClearMatchesSubject(subject, cleared) {
    return Boolean(subject?.layerId && cleared?.layerId === subject.layerId);
  }

  function evaluateSubject(
    subject,
    sourceStates = parts.queries.collectSourceStates(),
  ) {
    const position = subject?.position;
    if (!position) return null;
    const flightsState = sourceStates.flights;
    const militaryState = sourceStates.military;
    const vesselsState = sourceStates['ais-live-vessels'];
    const installationsState = sourceStates['military-installations'];
    // Same engine the voice analyst calls — see collectAircraftProximityWindow.
    const { flights, military } = parts.queries.collectAircraftProximityWindow(
      position,
      { subject },
    );
    const vessels = aisLiveVesselsLayer
      .getNearby(position, AWARENESS_RADIUS_M, AWARENESS_QUERY_LIMIT)
      .filter(
        (item) =>
          !parts.queries.isSame(subject, item, 'ais-live-vessels', 'mmsi'),
      );
    const installations = militaryInstallationsLayer
      .getNearby(position, AWARENESS_RADIUS_M, AWARENESS_QUERY_LIMIT)
      .filter(
        (item) =>
          !parts.queries.isSame(subject, item, 'military-installations', 'id'),
      );
    return {
      subject,
      evaluatedAt: Date.now(),
      radiusM: AWARENESS_RADIUS_M,
      cohorts: [
        {
          id: 'flights',
          label: t('layers.awareness.cohort.flights'),
          source: flightsState.stats.source || SOURCE_LABEL.flights,
          summary: parts.navigation.summarizeAwarenessCohortForNavigation(
            flights,
            flightsState,
          ),
        },
        {
          id: 'military',
          label: t('layers.awareness.cohort.military'),
          source: militaryState.stats.source || SOURCE_LABEL.military,
          summary: parts.navigation.summarizeAwarenessCohortForNavigation(
            military,
            militaryState,
          ),
        },
        {
          id: 'ais-live-vessels',
          label: t('layers.awareness.cohort.vessels'),
          source: vesselsState.stats.source || SOURCE_LABEL['ais-live-vessels'],
          summary: parts.navigation.summarizeAwarenessCohortForNavigation(
            vessels,
            vesselsState,
          ),
        },
        {
          id: 'military-installations',
          label: t('layers.awareness.cohort.installations'),
          source:
            installationsState.stats.source ||
            SOURCE_LABEL['military-installations'],
          coverage: t('layers.awareness.coverage.viewport'),
          summary: parts.queries.summarizeInstallationViewport(
            installations,
            installationsState,
          ),
        },
      ],
    };
  }

  function subjectKey(subject) {
    return subject ? `${subject.layerId}:${subject.id}` : '';
  }

  function normalizeContextId(value) {
    return String(value || '')
      .trim()
      .toLowerCase();
  }

  function normalizedSubjectKey(subject) {
    if (!subject) return '';
    return `${normalizeContextId(subject.layerId)}:${normalizeContextId(subject.id)}`;
  }

  /**
   * Resolve the source-owned aircraft that currently owns Cesium tracking.
   * Both flight layers may briefly retain local state during a cross-layer
   * handoff, so the viewer's normalized tracked identity is the tie-breaker.
   * @returns {{layerId: string, id: string, label: string, position: Cesium.Cartesian3}|null}
   *   Detached awareness subject, or null when no flight owns the follow camera.
   */

  function currentTrackedFlightSubject() {
    const trackedKey = normalizeContextId(
      layerState.viewer?.trackedEntity?.gevTrackedId,
    );
    if (!trackedKey) return null;
    const subjects = [
      flightsLayer.getTrackedSubject?.(),
      militaryFlightsLayer.getTrackedSubject?.(),
    ];
    return (
      subjects.find(
        (subject) => normalizedSubjectKey(subject) === trackedKey,
      ) || null
    );
  }

  function subjectCohortFeedUnknown() {
    const cohort = layerState.results?.cohorts?.find(
      (item) => item.id === layerState.subject?.layerId,
    );
    return (
      cohort?.summary?.relationship === AWARENESS_RELATIONSHIP.UNKNOWN &&
      cohort.summary.count === null
    );
  }

  function selectSubject(subject) {
    if (!layerState.enabled || !subject?.position) return;
    parts.panel.startAwarenessPageRotation();
    const key = subjectKey(subject);
    layerState.navigationVisited.add(key);
    const suppressHistory = layerState.suppressedHistoryKey === key;
    layerState.pendingSelectionKey = null;
    layerState.suppressedHistoryKey = null;
    if (!suppressHistory) {
      const current = layerState.navigationHistory[layerState.navigationIndex];
      if (subjectKey(current) !== key) {
        layerState.navigationHistory.splice(layerState.navigationIndex + 1);
        layerState.navigationHistory.push({
          ...parts.history.historySubjectSnapshot(
            subject,
            parts.history.historySourceItem(subject),
          ),
          position: Cesium.Cartesian3.clone(subject.position),
        });
        layerState.navigationIndex = layerState.navigationHistory.length - 1;
      }
    }
    layerState.subject = subject;
    // A newly chosen contact starts present; the next refresh re-decides.
    layerState.subjectMissing = false;
    refreshSelectedSubject(true);
  }

  /**
   * Resolve the currently displayed position for a selected live subject. Flight
   * tracking owns the motion callback, so awareness consumes its cached display
   * position instead of creating a second tracker or extrapolation path.
   * @param {{layerId: string, id: string, position: Cesium.Cartesian3}} subject Current subject.
   * @param {object} [options] Position materialization controls.
   * @param {boolean} [options.allowCollectionMaterialization=true] Whether a layer-wide fallback may run.
   * @returns {Cesium.Cartesian3|null} A cloned live position when one is available.
   */

  function resolveSubjectPosition(
    subject,
    { allowCollectionMaterialization = true } = {},
  ) {
    if (!subject?.position) return null;
    if (subject.layerId === 'flights' || subject.layerId === 'military') {
      const trackedPosition =
        layerState.viewer?.trackedEntity?.gevDisplayPosition?.();
      if (trackedPosition) {
        return {
          position: Cesium.Cartesian3.clone(trackedPosition),
          // Only the follow camera's own contact proves presence this way; a
          // different tracked entity says nothing about this subject.
          presence:
            String(layerState.viewer?.trackedEntity?.gevTrackedId || '') ===
            subjectKey(subject)
              ? SUBJECT_PRESENCE.LIVE
              : SUBJECT_PRESENCE.UNCHECKED,
        };
      }
      // Cockpit already materializes its tracked position on a fixed 20 Hz loop.
      // If that frame-owned cache is temporarily unavailable, keep the last
      // awareness position instead of allocating/scanning up to 1,000 contacts.
      if (!allowCollectionMaterialization) {
        return {
          position: Cesium.Cartesian3.clone(subject.position),
          presence: SUBJECT_PRESENCE.UNCHECKED,
        };
      }
      const layer =
        subject.layerId === 'flights' ? flightsLayer : militaryFlightsLayer;
      return collectionSubjectPosition(
        subject,
        layer.getAllPositions(1000),
        layer,
      );
    }
    if (subject.layerId === 'ais-live-vessels') {
      if (!allowCollectionMaterialization) {
        return {
          position: Cesium.Cartesian3.clone(subject.position),
          presence: SUBJECT_PRESENCE.UNCHECKED,
        };
      }
      return collectionSubjectPosition(
        subject,
        aisLiveVesselsLayer.getAllPositions(12000),
        aisLiveVesselsLayer,
      );
    }
    // Mapped installations come from static geometry, not a live feed: there is
    // nothing to be culled from.
    return {
      position: Cesium.Cartesian3.clone(subject.position),
      presence: SUBJECT_PRESENCE.LIVE,
    };
  }

  /**
   * Locate a subject inside its layer's live collection, keeping the last known
   * position when it is gone.
   *
   * Presence comes from the layer's O(1) `hasContact`, never from the rows:
   * `getAllPositions` stops at its cap and the flights layer routinely carries
   * ~11k contacts against a 1,000-row cap, so "not in the rows" is not "gone".
   * The rows are only consulted for a fresher position — a contact past the cap
   * keeps its last known position while still reading as present.
   * @param {{id: string, position: Cesium.Cartesian3}} subject Current subject.
   * @param {Array<{id: string, position: Cesium.Cartesian3}>} rows Live collection rows.
   * @param {{hasContact?: function}} layer The owning source layer.
   * @returns {{position: Cesium.Cartesian3, presence: string}} Position plus presence verdict.
   */

  function collectionSubjectPosition(subject, rows, layer) {
    const collection = Array.isArray(rows) ? rows : [];
    const current = collection.find(
      (item) => String(item.id) === String(subject.id),
    );
    // null/undefined means the layer cannot answer (disabled or not yet loaded).
    const known = layer?.hasContact?.(subject.id);
    const presence =
      known === true
        ? SUBJECT_PRESENCE.LIVE
        : known === false
          ? SUBJECT_PRESENCE.MISSING
          : SUBJECT_PRESENCE.UNCHECKED;
    return {
      position: current?.position
        ? Cesium.Cartesian3.clone(current.position)
        : Cesium.Cartesian3.clone(subject.position),
      presence,
    };
  }

  /**
   * Re-resolve a live subject's DISPLAY label from the layer that owns it.
   *
   * The subject snapshot is captured once at selection time, but a contact's
   * label INPUTS can arrive later: adsbdb enrichment supplies a registration
   * seconds after a callsign-less aircraft is selected, so every other surface
   * swapped `ae1fa4` → `N123AB` while the cached Context subject kept the hex.
   * The owning layer's tracked-subject accessor already applies the layer's
   * label convention (callsign → registration → icao24), so ask it rather than
   * re-deriving the chain here.
   *
   * Identity (`subject.id`) is NEVER re-derived — only the rendered string.
   * @param {{layerId: string, id: string, label: string}} subject Current subject.
   * @returns {string} The current label, or the cached one when the owning layer
   *   has no tracked subject (e.g. a cross-layer handoff is in flight).
   */

  function resolveSubjectLabel(subject) {
    if (!parts.navigation.isFlightLayer(subject?.layerId))
      return subject?.label;
    const layer =
      subject.layerId === 'flights' ? flightsLayer : militaryFlightsLayer;
    const tracked = layer.getTrackedSubject?.();
    if (tracked?.label && String(tracked.id) === String(subject.id))
      return tracked.label;
    return subject.label;
  }

  /** Refresh proximity counts/distances against the subject's current live position. */

  function refreshSelectedSubject(force = false) {
    if (!layerState.enabled || !layerState.subject) return;
    const sources = parts.queries.collectSourceStates();
    const nextSourceRevision = parts.queries.sourceRevision(sources);
    const sourceRevisionChanged =
      nextSourceRevision !== layerState.sourceRevision;
    const resolved = resolveSubjectPosition(layerState.subject, {
      allowCollectionMaterialization:
        !document.body?.classList?.contains('cockpit-mode') ||
        sourceRevisionChanged,
    });
    if (!resolved) return;
    const { position, presence } = resolved;
    // UNCHECKED leaves the verdict alone: this tick simply did not look.
    if (presence === SUBJECT_PRESENCE.LIVE) layerState.subjectMissing = false;
    else if (presence === SUBJECT_PRESENCE.MISSING)
      layerState.subjectMissing = true;
    const nextLabel = resolveSubjectLabel(layerState.subject);
    const labelChanged = nextLabel !== layerState.subject.label;
    layerState.subject = { ...layerState.subject, position, label: nextLabel };
    const movementM = layerState.lastEvaluatedPosition
      ? Cesium.Cartesian3.distance(layerState.lastEvaluatedPosition, position)
      : Infinity;
    if (
      !parts.model.awarenessRefreshRequired({
        force,
        hasResults: Boolean(layerState.results),
        movementM,
        sourceRevisionChanged,
      })
    ) {
      layerState.results.subject = layerState.subject;
      parts.rendering.renderVisual(layerState.subject);
      // The panel markup embeds `subject.label`, so a label that changed while
      // the contact was stationary (async enrichment answering after selection)
      // is render-worthy ON ITS OWN. Without this the standalone Context panel
      // kept the ICAO hex until unrelated movement, a source-revision bump, or
      // page rotation happened to repaint it. Gated on an ACTUAL change so the
      // common no-op refresh (every 750 ms) still costs no repaint.
      if (labelChanged) parts.panel.renderResults();
      parts.rendering.scheduleDirectionOverlayUpdate(force);
      return;
    }
    layerState.results = evaluateSubject(layerState.subject, sources);
    layerState.sourceRevision = nextSourceRevision;
    layerState.lastEvaluatedPosition = Cesium.Cartesian3.clone(
      position,
      layerState.lastEvaluatedPosition,
    );
    for (const cohort of layerState.results.cohorts) {
      const maxPage = Math.max(
        0,
        Math.floor(
          Math.max(0, cohort.summary.nearest.length - 1) / AWARENESS_PAGE_SIZE,
        ) * AWARENESS_PAGE_SIZE,
      );
      layerState.cohortPages.set(
        cohort.id,
        Math.min(layerState.cohortPages.get(cohort.id) || 0, maxPage),
      );
    }
    parts.rendering.renderVisual(layerState.subject);
    parts.panel.renderResults();
    parts.rendering.scheduleDirectionOverlayUpdate(force);
  }

  function subjectFromContext(record) {
    if (
      !record ||
      !['ais-live-vessels', 'military-installations'].includes(record.layerId)
    )
      return null;
    const latitude = Number(record.latitude);
    const longitude = Number(record.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
    return {
      layerId: record.layerId,
      id: record.properties?.mmsi || record.id,
      label: record.label || record.id,
      position: Cesium.Cartesian3.fromDegrees(longitude, latitude, 0),
    };
  }

  /**
   * Record that the current subject left its feed on its own.
   *
   * The subject, its cohort results and its navigation history all survive: the
   * Contact panel keeps rendering them behind a CONTACT LOST cue, and PREVIOUS /
   * NEXT stay operable so the operator can step off. Nulling the subject here
   * instead would take the panel — and those controls — off screen.
   */

  function markSubjectEvicted() {
    if (!layerState.subject) return;
    layerState.subjectMissing = true;
  }

  function clearAwarenessSubject() {
    layerState.autoFocusRetryPending = false;
    layerState.subject = null;
    layerState.subjectMissing = false;
    layerState.results = null;
    layerState.navigationHistory = [];
    layerState.navigationVisited.clear();
    layerState.navigationIndex = -1;
    layerState.suppressedHistoryKey = null;
    layerState.pendingSelectionKey = null;
    layerState.lastEvaluatedPosition = null;
    layerState.sourceRevision = '';
    layerState.cohortPages.clear();
    parts.panel.stopAwarenessPageRotation();
    parts.rendering.clearVisual();
    parts.panel.hidePanel();
  }
  return {
    awarenessClearMatchesSubject,
    evaluateSubject,
    subjectKey,
    normalizeContextId,
    normalizedSubjectKey,
    currentTrackedFlightSubject,
    subjectCohortFeedUnknown,
    selectSubject,
    resolveSubjectPosition,
    collectionSubjectPosition,
    resolveSubjectLabel,
    refreshSelectedSubject,
    subjectFromContext,
    markSubjectEvicted,
    clearAwarenessSubject,
  };
}
