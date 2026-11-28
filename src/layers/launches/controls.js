import { formatNumber, t } from '../../i18n/index.js';

export function createControls({ state: layerState, services, parts, source }) {
  let unsubscribeRowControls = null;

  function cycleMission(step) {
    const entries = layerState._missionRosterView?.entries;
    if (!layerState._enabled || !entries?.length) return;
    const index = entries.findIndex(
      ({ id }) => id === layerState._selectedLaunchId,
    );
    const next =
      index < 0
        ? step > 0
          ? 0
          : entries.length - 1
        : (index + step + entries.length) % entries.length;
    parts.panel.selectMissionAt(entries[next].index);
    // Stepped from the Data Layers row: the panel opens, as for a globe pick.
    const id = layerState._selectedLaunchId;
    for (const listener of [...(layerState._globePickListeners || [])]) {
      try {
        listener(id);
      } catch (error) {
        console.warn(
          '[Data:RocketLaunches] mission step listener failed',
          error,
        );
      }
    }
  }

  const methods = {
    id: 'rocket-launches',

    name: 'Space Missions (30d)',

    icon: '🚀',

    source: 'Launch Library 2',

    updateInterval: 300000,

    getRowControls() {
      const entries = layerState._missionRosterView?.entries;
      if (!layerState._enabled || !entries?.length) return null;
      const index = entries.findIndex(
        ({ id }) => id === layerState._selectedLaunchId,
      );
      const disabled = entries.length === 1 && index >= 0;
      return {
        info:
          index < 0
            ? t('SELECT A MISSION TO INSPECT')
            : `${formatNumber(index + 1)} / ${formatNumber(entries.length)} · ${entries[index].label}`,
        chips: [
          {
            id: 'previous-mission',
            label: t('Previous mission'),
            icon: 'chevron_left',
            action: true,
            disabled,
            onClick: () => cycleMission(-1),
          },
          {
            id: 'next-mission',
            label: t('Next mission'),
            icon: 'chevron_right',
            action: true,
            disabled,
            onClick: () => cycleMission(1),
          },
        ],
      };
    },

    /**
     * Hear each mission picked on the globe (a marker or its label), after
     * it is selected. The app reveals the Space Missions panel for it.
     * @param {(launchId: string) => void} listener
     * @returns {() => void} Unsubscribe.
     */
    subscribeGlobePick(listener) {
      layerState._globePickListeners.add(listener);
      return () => layerState._globePickListeners.delete(listener);
    },

    /** Release only Space Mission camera ownership, preserving layer and selection state. */
    releaseCameraOwnership() {
      // Navigation takes the camera; a failed entry must not restore the old view.
      layerState._entryCameraView = null;
      layerState._cameraReleased = true;
      parts.panel.clearMissionRosterHover();
      parts.replay.stopMissionReplay();
      parts.selection.stopMissionZoomAnchor();
    },

    /**
     * Snapshot loaded launches as plain JSON-safe records for the analyst
     * query engine. On demand only (once per spoken query); [] while the
     * layer is off.
     * @param {number} [maxCount=Infinity] Most records to return.
     * @returns {Array<Object>} {id, name, provider, status, launchSite, missionName, lat, lon, launchTimeMs, hoursUntil}.
     */
    getAnalystRecords(maxCount = Infinity) {
      if (!layerState._enabled) return [];
      const now = layerState.now();
      const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
      const result = [];
      for (const launch of layerState._launches || []) {
        if (result.length >= maxCount) break;
        const at = Date.parse(launch.launchTime);
        result.push({
          id: launch.id,
          name: text(launch.name),
          provider: text(launch.provider),
          status: text(launch.status),
          launchSite: text(launch.launchSite),
          missionName: text(launch.missionName),
          lat: launch.lat,
          lon: launch.lon,
          launchTimeMs: Number.isFinite(at) ? at : null,
          // Negative for launches already flown.
          hoursUntil: Number.isFinite(at)
            ? Math.round(((at - now) / 3_600_000) * 10) / 10
            : null,
        });
      }
      return result;
    },

    /**
     * Why a start failed, for the person: the mission index never loaded.
     * Null when the failure is not the index's (the app then names it).
     * @returns {?string}
     */
    enableFailureMessage() {
      return layerState._lastError && layerState._lastUpdate == null
        ? t(
            'Space Missions unavailable: the mission index could not load. Try again later.',
          )
        : null;
    },

    getStats() {
      return {
        count: layerState._count,
        orbitMatches: layerState._orbitMatches,
        lastUpdate: layerState._lastUpdate,
        error: layerState._lastError,
        stale: layerState._stale,
      };
    },

    attachDataManager(dataManager) {
      layerState._dataManager = dataManager;
      parts.satelliteIntents.connect(dataManager);
    },
  };

  /**
   * Invalidate the panels' row while `panel` is given: a new roster or
   * mission pick changes the row, while replay and telemetry updates do not.
   * @param {{ invalidate: () => void } | null} panel
   */
  function watchRowControls(panel) {
    unsubscribeRowControls?.();
    unsubscribeRowControls = null;
    if (!panel) return;
    let previousRoster;
    let previousSelection;
    unsubscribeRowControls = parts.panel.subscribePanel(({ roster }) => {
      const selection = layerState._selectedLaunchId;
      if (roster === previousRoster && selection === previousSelection) return;
      previousRoster = roster;
      previousSelection = selection;
      panel.invalidate();
    });
  }

  return { methods, watchRowControls };
}
