/**
 * Space Missions owns its Satellites dependency. While the layer is on or
 * starting, an explicit Satellites action from the person (a Data Layers
 * click, a voice command) wins over the dependency:
 *  - the mission teardown leaves Satellites as that action set it, and
 *  - a Satellites OFF asked for after the newest Space Missions ON ends Space
 *    Missions, which cannot replay without it.
 * Whether an OFF ends the missions depends on which of the two was asked for
 * first, not on which settles first, so request order is recorded when each
 * intent is published.
 */
const ORDERED_REQUEST_LAYER_IDS = new Set(['rocket-launches', 'satellites']);
const LAYER_ID = 'rocket-launches';

function isExplicitOrigin(origin) {
  return origin === 'user' || origin === 'voice';
}

/**
 * A setting changed on purpose: by the person, by voice, or by a tool such
 * as a place search (the layer state's own rule, isExplicitLayerStateOrigin
 * in src/data/layerState.js).
 */
function isDeliberateOrigin(origin) {
  return isExplicitOrigin(origin) || origin === 'tool';
}

export function createSatelliteIntents({ state: layerState }) {
  const requestOrder = new Map();
  let sequence = 0;
  let unsubscribe = null;
  /** The Space Missions stop a Satellites OFF started, while it runs. */
  let pendingStop = null;

  /**
   * Whether an accepted Satellites OFF was requested after the newest Space
   * Missions ON. An OFF asked for before the entry belongs to the view the
   * entry started from, so the entry it races with is kept. Without request
   * records the OFF is treated as the newer action.
   */
  function offFollowsMissionsEntry(change) {
    const satellites = requestOrder.get('satellites');
    const missions = requestOrder.get(LAYER_ID);
    if (satellites?.intentEpoch !== change.intentEpoch || !missions?.enabled)
      return true;
    return satellites.sequence > missions.sequence;
  }

  function recordRequest(change) {
    if (!ORDERED_REQUEST_LAYER_IDS.has(change?.layerId)) return;
    requestOrder.set(change.layerId, {
      enabled: change.enabled,
      intentEpoch: change.intentEpoch,
      sequence: ++sequence,
    });
  }

  /**
   * Hand an explicit Satellites action its visibility while Space Missions is
   * on or starting.
   * @returns {Promise<boolean>|boolean} Whether Space Missions was asked to stop.
   */
  function handleVisibility(change) {
    const manager = layerState._dataManager;
    if (
      !manager ||
      change?.type !== 'visibility' ||
      change.layerId !== 'satellites' ||
      !isExplicitOrigin(change.origin)
    )
      return false;
    const missionsRequested = manager.isEffectivelyEnabled(LAYER_ID);
    if (!missionsRequested && !layerState._satelliteStateBeforeMission)
      return false;
    // A newer Satellites request is queued; it will report for itself.
    if (manager.isEffectivelyEnabled('satellites') !== change.enabled)
      return false;
    // The person's choice survives the mission teardown.
    const previous = layerState._satelliteStateBeforeMission;
    if (previous) previous.restoreVisibility = false;
    if (change.enabled && previous?.display) {
      // Explicit ON takes over a layer started only for mission data.
      if (manager.setLayerParams('satellites', previous.display) !== false)
        previous.display = null;
    }
    if (
      change.enabled ||
      !missionsRequested ||
      !offFollowsMissionsEntry(change)
    )
      return false;
    const stop = Promise.resolve(
      manager.setEnabled(LAYER_ID, false, { origin: change.origin }),
    )
      .then(() => true)
      .catch((error) => {
        console.warn(
          '[Data:RocketLaunches] Satellites OFF could not stop Space Missions',
          error,
        );
        return false;
      })
      .finally(() => {
        if (pendingStop === stop) pendingStop = null;
      });
    pendingStop = stop;
    return stop;
  }

  /**
   * Keep deliberate changes to the borrowed layer's display choices.
   * Everything else remains live and needs no replay on mission exit.
   */
  function handleParams(change) {
    if (
      change?.type !== 'params' ||
      change.layerId !== 'satellites' ||
      !isDeliberateOrigin(change.origin)
    )
      return;
    const display = layerState._satelliteStateBeforeMission?.display;
    const requested = change.requestedParams;
    if (!display || !requested) return;
    for (const key of ['showPoints', 'showOrbits']) {
      if (requested[key] !== undefined) display[key] = change.params[key];
    }
  }

  /** Settle once a Satellites OFF has finished stopping Space Missions. */
  function settled() {
    return pendingStop ?? Promise.resolve(false);
  }

  /** Follow the manager the layer is attached to; null detaches. */
  function connect(manager) {
    unsubscribe?.();
    unsubscribe = null;
    requestOrder.clear();
    if (!manager) return;
    const unsubscribeRequests =
      manager.subscribeVisibilityRequests?.(recordRequest) ?? null;
    const unsubscribeChanges =
      manager.subscribe?.((change) => {
        handleParams(change);
        void handleVisibility(change);
      }) ?? null;
    unsubscribe = () => {
      unsubscribeRequests?.();
      unsubscribeChanges?.();
    };
  }

  return {
    connect,
    settled,
    handleVisibility,
    handleParams,
    recordRequest,
    offFollowsMissionsEntry,
  };
}
