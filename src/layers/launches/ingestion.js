import { MAX_POST_TLE_RETRIES, POST_TLE_RETRY_DELAY_MS } from './policy.js';

export function createIngestion({
  state: layerState,
  services,
  parts,
  source,
}) {
  /**
   * Decide whether one bounded rebuild is needed after the active TLE lookup.
   * @param {object} input Retry state.
   * @param {boolean} input.enabled Whether Space Missions is active.
   * @param {number} input.retryCount Number of post-TLE retries already used.
   * @param {string|null} input.activeTleText Resolved active TLE catalog.
   * @param {string|null} input.renderedTleText TLE catalog used for the last build.
   * @returns {boolean} Whether to schedule a refresh.
   */

  function shouldRetryAfterActiveTle({
    enabled,
    retryCount,
    activeTleText,
    renderedTleText,
  }) {
    return Boolean(
      enabled &&
      activeTleText &&
      activeTleText !== renderedTleText &&
      retryCount < MAX_POST_TLE_RETRIES,
    );
  }

  function clearPostTleRetry() {
    if (layerState._retryTimer) clearTimeout(layerState._retryTimer);
    layerState._retryTimer = null;
  }

  function schedulePostTleRetry(token) {
    if (
      layerState._retryTimer ||
      token !== layerState._lifecycleToken ||
      !shouldRetryAfterActiveTle({
        enabled: layerState._enabled,
        retryCount: layerState._postTleRetryCount,
        activeTleText: layerState._activeTleText,
        renderedTleText: layerState._renderedTleText,
      })
    )
      return;
    layerState._postTleRetryCount++;
    layerState._retryTimer = setTimeout(() => {
      layerState._retryTimer = null;
      if (layerState._enabled && token === layerState._lifecycleToken)
        requestMissionUpdate();
    }, POST_TLE_RETRY_DELAY_MS);
  }

  function ensureActiveTleLookup(token) {
    if (layerState._activeTleText)
      return Promise.resolve(layerState._activeTleText);
    if (
      layerState._activeTlePromise &&
      layerState._activeTlePromiseToken === token
    )
      return layerState._activeTlePromise;
    const request = source
      .getActiveTle({ signal: layerState._sourceController.signal })
      .then((text) => {
        if (!layerState._enabled || token !== layerState._lifecycleToken)
          return null;
        layerState._activeTleText = text;
        layerState._focusAfterActiveLookup = Boolean(
          layerState._selectedLaunchId,
        );
        schedulePostTleRetry(token);
        return text;
      })
      .catch((error) => {
        if (layerState._enabled && token === layerState._lifecycleToken) {
          console.warn(
            '[Data:RocketLaunches] Active satellite lookup unavailable:',
            error.message,
          );
        }
        return null;
      })
      .finally(() => {
        if (layerState._activeTlePromise === request) {
          layerState._activeTlePromise = null;
          layerState._activeTlePromiseToken = 0;
        }
      });
    layerState._activeTlePromise = request;
    layerState._activeTlePromiseToken = token;
    return request;
  }

  async function captureSatelliteDependency() {
    if (!layerState._dataManager || layerState._satelliteStateBeforeMission)
      return;
    layerState._satelliteStateBeforeMission = {
      // Effective visibility: a user enable still mid-activation is intent ON —
      // capturing settled false would restore the user's enable away on exit.
      enabled:
        layerState._dataManager.isEffectivelyEnabled?.('satellites') ??
        layerState._dataManager.isEnabled('satellites'),
      params: parts.policyHelpers.satelliteParamsAfterSpaceMissions(
        layerState._dataManager.getLayerParams('satellites'),
      ),
    };
    layerState._dataManager.setLayerParams(
      'satellites',
      parts.policyHelpers.satelliteParamsForSpaceMissions(
        layerState._satelliteStateBeforeMission.params,
      ),
    );
    const token = layerState._lifecycleToken;
    const activation = Promise.resolve(
      layerState._dataManager.setEnabled('satellites', true),
    );
    layerState._satelliteActivationPromise = activation;
    try {
      const activated = await activation;
      // Space Missions without its satellite dependency is a broken replay
      // surface; fail the mission enable so the manager's fail-closed path and
      // the Context rollback see an honest failure instead of a silent success.
      if (
        token === layerState._lifecycleToken &&
        layerState._enabled &&
        (activated === false ||
          !layerState._dataManager.isEnabled('satellites'))
      ) {
        throw new Error(
          'Space Missions requires the satellites layer, which failed to start',
        );
      }
    } finally {
      if (
        token === layerState._lifecycleToken &&
        layerState._satelliteActivationPromise === activation
      ) {
        layerState._satelliteActivationPromise = null;
      }
    }
  }

  async function restoreSatelliteDependency() {
    const snapshot = layerState._satelliteStateBeforeMission;
    if (!snapshot || !layerState._dataManager) return;
    layerState._satelliteStateBeforeMission = null;
    layerState._satelliteActivationPromise = null;
    layerState._dataManager.setLayerParams(
      'satellites',
      parts.policyHelpers.satelliteParamsAfterSpaceMissions(snapshot.params),
    );
    const restored = await layerState._dataManager.setEnabled(
      'satellites',
      snapshot.enabled,
    );
    if (
      restored === false ||
      layerState._dataManager.isEnabled('satellites') !== snapshot.enabled
    ) {
      throw new Error('Space Missions could not restore the satellites layer');
    }
  }

  async function performMissionUpdate(token) {
    try {
      ensureActiveTleLookup(token);
      const payload = await source.getLaunches({
        signal: layerState._sourceController.signal,
      });
      const launches = parts.model.normalizeRocketLaunches(payload);
      if (
        !layerState._enabled ||
        token !== layerState._lifecycleToken ||
        !layerState._dataSource
      )
        return;
      const activeTleText = layerState._activeTleText;
      if (layerState._replayCameraLaunchId) parts.replay.stopMissionReplay();
      layerState._launches = launches;
      parts.orbitRendering.removeMissionOrbitPrimitives();
      layerState._dataSource.entities.removeAll();
      layerState._missionOverlayRecords.clear();
      layerState._satelliteTelemetry.clear();
      layerState._replayTracks.clear();
      layerState._orbitMatches = 0;
      launches.forEach((launch) =>
        parts.rendering.addLaunchEntity(launch, activeTleText),
      );
      layerState._renderedTleText = activeTleText;
      if (layerState._renderedTleText === layerState._activeTleText)
        clearPostTleRetry();
      layerState._count = launches.length;
      parts.panel.renderMissionRoster();
      if (
        !layerState._selectedLaunchId ||
        !launches.some((launch) => launch.id === layerState._selectedLaunchId)
      ) {
        parts.selection.setSelectedMission(null, false);
      } else {
        parts.selection.setSelectedMission(layerState._selectedLaunchId, true);
        if (layerState._focusAfterActiveLookup) {
          parts.selection.focusMission(
            launches.find(
              (launch) => launch.id === layerState._selectedLaunchId,
            ),
          );
        }
      }
      layerState._focusAfterActiveLookup = false;
      parts.panel.renderMissionPanel();
      layerState._lastUpdate = Date.now();
      layerState._lastError = null;
    } catch (error) {
      if (layerState._enabled && token === layerState._lifecycleToken) {
        layerState._lastError = error.message;
        console.warn('[Data:RocketLaunches] Fetch error:', error);
      }
    }
  }

  function requestMissionUpdate() {
    if (!layerState._enabled) return Promise.resolve();
    const token = layerState._lifecycleToken;
    layerState._updateDirty = true;
    if (layerState._updatePromise && layerState._updatePromiseToken === token)
      return layerState._updatePromise;
    let request;
    request = (async () => {
      while (
        layerState._enabled &&
        token === layerState._lifecycleToken &&
        layerState._updateDirty
      ) {
        layerState._updateDirty = false;
        await performMissionUpdate(token);
      }
    })().finally(() => {
      if (layerState._updatePromise === request) {
        layerState._updatePromise = null;
        layerState._updatePromiseToken = 0;
      }
    });
    layerState._updatePromise = request;
    layerState._updatePromiseToken = token;
    return request;
  }
  const methods = {
    update() {
      return requestMissionUpdate();
    },
  };

  return {
    shouldRetryAfterActiveTle,
    clearPostTleRetry,
    schedulePostTleRetry,
    ensureActiveTleLookup,
    captureSatelliteDependency,
    restoreSatelliteDependency,
    performMissionUpdate,
    requestMissionUpdate,
    methods,
  };
}
