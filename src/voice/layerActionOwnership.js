/**
 * Observe an explicit request to turn a layer off while a feature action is
 * pending. The visibility-request stream is synchronous, so an OFF owns the
 * action even before the layer's queued lifecycle work settles.
 *
 * @module voice/layerActionOwnership
 */

const EXPLICIT_OFF_ORIGINS = new Set(['user', 'voice', 'tool']);

export function watchExplicitLayerOff(dataManager, layerId, { onOff } = {}) {
  let requested = false;
  const observe = (change) => {
    if (
      change?.layerId === layerId &&
      change.enabled === false &&
      EXPLICIT_OFF_ORIGINS.has(change.origin)
    ) {
      requested = true;
      onOff?.(change);
    }
  };
  const stopRequest =
    dataManager?.subscribeVisibilityRequests?.(observe) || (() => {});
  // Lightweight managers sometimes expose only the settled change stream.
  const stopSettled = dataManager?.subscribe?.(observe) || (() => {});
  return {
    requested: () => requested,
    stop() {
      stopRequest();
      stopSettled();
    },
  };
}

export function displacedLayerResult(dataManager, layerId, action, error) {
  const state = dataManager?.getLayerLifecycleState?.(layerId);
  return {
    ok: false,
    action,
    code: 'DISPLACED',
    cancelled: true,
    layerId,
    requestedEnabled: false,
    error,
    enabled:
      typeof state?.enabled === 'boolean'
        ? state.enabled
        : Boolean(dataManager?.isEnabled?.(layerId)),
    ...(state?.lifecycleState ? { lifecycleState: state.lifecycleState } : {}),
    ...(typeof state?.uncertain === 'boolean'
      ? { lifecycleUncertain: state.uncertain }
      : {}),
  };
}
