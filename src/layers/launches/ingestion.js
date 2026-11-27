import { isFollowing } from '../../data/followed.js';
import {
  MAX_POST_TLE_RETRIES,
  POST_TLE_RETRY_DELAY_MS,
  cockpitActive,
} from './policy.js';

/**
 * Let pending Satellites work finish, including requests that join it while
 * waiting, so the mission dependency cannot overtake it. Bounded: a
 * Satellites change that never settles cannot hold missions forever.
 */
async function waitForSatelliteVisibility(manager, { signal, timeoutMs }) {
  if (typeof manager.waitForLayerIdle !== 'function') return true;
  return manager.waitForLayerIdle('satellites', { signal, timeoutMs });
}

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
      // A failed retry is already recorded in the layer stats.
      if (layerState._enabled && token === layerState._lifecycleToken)
        requestMissionUpdate().catch(() => {});
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
    const manager = layerState._dataManager;
    if (!manager) return;
    const token = layerState._lifecycleToken;
    // Let a pending Satellites action finish before reserving dependency ON.
    // A successful explicit OFF can cancel this mission entry while we wait.
    const idle = await waitForSatelliteVisibility(manager, {
      signal: layerState._sourceController?.signal,
      timeoutMs: layerState.satelliteSettleTimeoutMs,
    });
    if (token !== layerState._lifecycleToken) return;
    if (!idle && layerState._enabled)
      throw new Error(
        'Space Missions could not start: the satellites layer did not settle',
      );
    if (
      !layerState._enabled ||
      (manager.layers?.has('rocket-launches') &&
        !manager.isEffectivelyEnabled('rocket-launches'))
    )
      return;
    // A busy restore may still own its temporary display change. Keep the
    // saved choices, but take a settled explicit switch as the new visibility.
    const kept = layerState._satelliteStateBeforeMission;
    if (!kept || kept.restoreVisibility === false) {
      const enabled = manager.isEnabled('satellites');
      const { showPoints, showOrbits } =
        parts.policyHelpers.satelliteParamsAfterSpaceMissions(
          kept?.display ?? manager.getLayerParams('satellites'),
        );
      layerState._satelliteStateBeforeMission = {
        enabled,
        display: enabled ? null : { showPoints, showOrbits },
      };
      if (enabled && kept?.display)
        manager.setLayerParams('satellites', kept.display);
    }
    if (layerState._satelliteStateBeforeMission.display) {
      manager.setLayerParams('satellites', {
        showPoints: false,
        showOrbits: false,
      });
    }
    if (manager.isEnabled('satellites')) return;
    const activation = Promise.resolve(manager.setEnabled('satellites', true));
    layerState._satelliteActivationPromise = activation;
    try {
      const activated = await activation;
      // Space Missions without its satellite dependency is a broken replay
      // surface; fail the mission enable so the manager's fail-closed path and
      // the Context rollback see an honest failure instead of a silent success.
      if (
        token === layerState._lifecycleToken &&
        layerState._enabled &&
        (activated === false || !manager.isEnabled('satellites'))
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
    const manager = layerState._dataManager;
    const snapshot = layerState._satelliteStateBeforeMission;
    if (!snapshot || !manager) return;
    // Keep the snapshot available until any explicit Satellites action settles.
    const token = layerState._lifecycleToken;
    const idle = await waitForSatelliteVisibility(manager, {
      timeoutMs: layerState.satelliteSettleTimeoutMs,
    });
    if (
      token !== layerState._lifecycleToken ||
      layerState._satelliteStateBeforeMission !== snapshot
    )
      return;
    // An accepted Satellites action owns visibility through mission teardown.
    const restoreVisibility = snapshot.restoreVisibility !== false;
    // Satellites is still busy: change nothing and keep the saved state, so
    // turning Space Missions off again can finish the restore.
    if (restoreVisibility && !idle)
      throw new Error(
        'Space Missions could not restore the satellites layer: it did not settle',
      );
    layerState._satelliteStateBeforeMission = null;
    layerState._satelliteActivationPromise = null;
    if (snapshot.display)
      manager.setLayerParams('satellites', snapshot.display);
    if (
      !restoreVisibility ||
      (snapshot.enabled && manager.isEnabled('satellites'))
    )
      return;
    const restored = await manager.setEnabled('satellites', snapshot.enabled);
    if (
      restored === false ||
      manager.isEnabled('satellites') !== snapshot.enabled
    ) {
      throw new Error('Space Missions could not restore the satellites layer');
    }
  }

  async function performMissionUpdate(token) {
    try {
      ensureActiveTleLookup(token);
      const { payload, stale } = source.getLaunchSnapshot
        ? await source.getLaunchSnapshot({
            signal: layerState._sourceController.signal,
          })
        : {
            payload: await source.getLaunches({
              signal: layerState._sourceController.signal,
            }),
            stale: false,
          };
      const launches = parts.model.normalizeRocketLaunches(payload);
      if (
        !layerState._enabled ||
        token !== layerState._lifecycleToken ||
        !layerState._missionSets
      )
        return;
      const activeTleText = layerState._activeTleText;
      if (layerState._replayCameraLaunchId) parts.replay.stopMissionReplay();
      layerState._launches = launches;
      parts.orbitRendering.removeMissionOrbitPrimitives();
      parts.rendering.clearLaunchEntities();
      layerState._missionOverlayRecords.clear();
      layerState._satelliteTelemetry.clear();
      layerState._replayTracks.clear();
      layerState._orbitMatches = 0;
      launches.forEach((launch) =>
        parts.rendering.addLaunchEntity(launch, activeTleText, { defer: true }),
      );
      parts.rendering.flushLaunchEntities();
      layerState._renderedTleText = activeTleText;
      if (layerState._renderedTleText === layerState._activeTleText)
        clearPostTleRetry();
      layerState._count = launches.length;
      // The roster reads these to tell a loaded empty index from loading.
      layerState._lastUpdate = Date.now();
      layerState._lastError = null;
      layerState._stale = stale === true;
      parts.panel.renderMissionRoster();
      if (
        !layerState._selectedLaunchId ||
        !launches.some((launch) => launch.id === layerState._selectedLaunchId)
      ) {
        parts.selection.setSelectedMission(null, false);
      } else {
        parts.selection.setSelectedMission(layerState._selectedLaunchId, true, {
          refresh: true,
        });
        // The camera can pick up a follow or enter Cockpit while the orbit
        // is loading. Refresh the mission while leaving that view in place.
        if (
          activeTleText &&
          layerState._focusAfterActiveLookup &&
          !cockpitActive() &&
          !isFollowing(layerState._viewer)
        ) {
          parts.selection.focusMission(
            launches.find(
              (launch) => launch.id === layerState._selectedLaunchId,
            ),
          );
        }
      }
      if (activeTleText) layerState._focusAfterActiveLookup = false;
      parts.panel.renderMissionPanel();
      layerState.coverageChanged();
      layerState._entryCameraView = null;
    } catch (error) {
      if (layerState._enabled && token === layerState._lifecycleToken) {
        layerState._lastError = error.message;
        console.warn('[Data:RocketLaunches] Fetch error:', error);
        // No index yet: fail the enable so Context rolls back.
        // After a loaded index, a failed refresh keeps its records.
        if (layerState._lastUpdate === null) {
          parts.panel.renderMissionRoster();
          throw error;
        }
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
