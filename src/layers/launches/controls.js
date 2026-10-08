export function createControls({ state: layerState, services, parts, source }) {
  const methods = {
    id: 'rocket-launches',

    name: 'Space Missions (30d)',

    icon: '🚀',

    source: 'Launch Library 2',

    updateInterval: 300000,

    /** Release only Space Mission camera ownership, preserving layer and selection state. */
    releaseCameraOwnership() {
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
      const now = Date.now();
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

    getStats() {
      return {
        count: layerState._count,
        orbitMatches: layerState._orbitMatches,
        lastUpdate: layerState._lastUpdate,
        error: layerState._lastError,
      };
    },

    attachDataManager(dataManager) {
      layerState._dataManager = dataManager;
    },
  };

  return { methods };
}
