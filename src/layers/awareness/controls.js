import { AWARENESS_RADIUS_M } from '../../data/militaryAwarenessEngine.js';

export function createControls({ state: layerState, services, parts, source }) {
  const flightsLayer = services.flights;
  const militaryFlightsLayer = services.military;
  const aisLiveVesselsLayer = services.vessels;

  const methods = {
    id: 'military-awareness',

    name: 'Global Context',

    icon: '◎',

    source: 'Open-source proximity context',

    // Context is entered from its dedicated right rail, not as a raw layer.
    showInTogglePanel: false,

    updateInterval: 0,

    statsRefreshInterval: 1000,

    attachDataManager(dataManager) {
      layerState.dataManager = dataManager;
    },

    setParams(params = {}) {
      if (typeof params.passive !== 'boolean') return;
      const wasPassive = layerState.passive;
      layerState.passive = params.passive;
      if (layerState.passive) services.installations?.setContextAnchor?.(null);
      if (layerState.enabled && wasPassive && !layerState.passive)
        parts.dependencies.activateOperationalContext();
    },

    /** @returns {{ passive: boolean }} Current runtime parameters. */
    getParams() {
      return { passive: layerState.passive };
    },

    getStats() {
      return {
        count: layerState.results ? 1 : 0,
        lastUpdate: layerState.results?.evaluatedAt || null,
        stale: false,
        error: null,
        status: layerState.enabled ? 'ready' : 'idle',
      };
    },

    /** Return the latest read-only context result for compact HUD consumers. */
    getContextSnapshot() {
      if (!layerState.enabled || !layerState.subject) return null;
      if (!layerState.results) {
        return parts.model.buildAwarenessContextSnapshot(
          {
            subject: { ...layerState.subject },
            evaluatedAt: null,
            radiusM: AWARENESS_RADIUS_M,
            cohorts: [],
          },
          parts.model.navigationState(),
          {
            subjectPresent: !layerState.subjectMissing,
          },
        );
      }
      return parts.model.buildAwarenessContextSnapshot(
        layerState.results,
        parts.model.navigationState(),
        {
          subjectPresent: !layerState.subjectMissing,
        },
      );
    },

    /**
     * Return the exact retained aircraft cohorts behind the current Contacts
     * panel snapshot. Voice reads this immutable copy instead of re-scanning
     * live layers, so panel and spoken counts share one evaluation timestamp.
     */
    getAircraftQuerySnapshot() {
      if (!layerState.enabled || !layerState.subject || !layerState.results)
        return null;
      // Build every public count from this exact results object before
      // returning. A refresh may replace `layerState.results` as soon as the
      // caller awaits, so consumers must not make a second read later and
      // accidentally combine two evaluation timestamps.
      const panelSnapshot = parts.model.buildAwarenessContextSnapshot(
        layerState.results,
        parts.model.navigationState(),
        {
          subjectPresent: !layerState.subjectMissing,
        },
      );
      const cohorts = {};
      for (const cohort of layerState.results.cohorts || []) {
        if (!['flights', 'military'].includes(cohort?.id)) continue;
        cohorts[cohort.id] = {
          count: cohort.summary?.count ?? null,
          complete:
            Number.isFinite(cohort.summary?.count) &&
            cohort.summary?.complete !== false,
          truncated:
            !Number.isFinite(cohort.summary?.count) ||
            cohort.summary?.truncated === true,
          // These records carry structured values such as Cartesian positions.
          // A shallow spread would let a voice consumer mutate the retained
          // Contacts cohort through the advertised read-only snapshot.
          items: structuredClone(cohort.summary?.navigationNearest || []),
          source: cohort.source || null,
          provenance: cohort.provenance
            ? structuredClone(cohort.provenance)
            : null,
          reason: cohort.summary?.reason || null,
        };
      }
      return {
        subject: structuredClone(layerState.results.subject),
        evaluatedAt: layerState.results.evaluatedAt,
        radiusM: layerState.results.radiusM,
        cohorts,
        contactsWindow: parts.model.contactsWindowFromSnapshot(panelSnapshot),
      };
    },

    /**
     * Release Contact-owned camera tracking without discarding the selected
     * subject. Reset-to-globe uses this route so the normal Context FOCUS action
     * can explicitly return to the same contact, while delayed activation work
     * cannot silently reclaim the camera after the reset.
     * @returns {boolean} Whether a Contact subject remains selected.
     */
    releaseCameraOwnership({
      preserveVesselSelection = false,
      origin = 'programmatic',
    } = {}) {
      ++layerState.activationId;
      layerState.autoFocusAttempted = true;
      layerState.autoFocusRetryPending = false;

      const preservedSelectionKey =
        parts.subject.subjectKey(layerState.subject) || 'camera-release';
      layerState.pendingSelectionKey = preservedSelectionKey;
      try {
        flightsLayer.stopTracking?.({ origin });
        militaryFlightsLayer.stopTracking?.({ origin });
        if (!preserveVesselSelection) aisLiveVesselsLayer.clearSelection?.();
      } finally {
        if (layerState.pendingSelectionKey === preservedSelectionKey) {
          layerState.pendingSelectionKey = null;
        }
      }
      return Boolean(layerState.subject);
    },

    navigatePrevious(options = {}) {
      return parts.history.navigateHistory(-1, options);
    },

    focusCurrent(options = {}) {
      return parts.focus.focusCurrentSubject(options);
    },

    navigateNext(options = {}) {
      return parts.history.navigateHistory(1, options);
    },

    /** Select a context target through its owning layer's established tracker. */
    focusTarget(layerId, id, options = {}) {
      return parts.focus.requestFocus(layerId, id, false, options);
    },
  };

  return { methods };
}
