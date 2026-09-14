/** Read layer lifecycle through the supplied manager. */
export function readLayerLifecycleSummary(
  dataManager,
  layerId,
  { fallbackEnabled = false } = {},
) {
  let lifecycle = null;
  try {
    lifecycle = dataManager?.getLayerLifecycleState?.(layerId) || null;
  } catch {
    lifecycle = null;
  }
  if (lifecycle) {
    const enabled = Boolean(lifecycle.enabled);
    return {
      enabled,
      lifecycleState:
        lifecycle.lifecycleState || (enabled ? 'enabled' : 'disabled'),
      lifecycleUncertain: Boolean(
        lifecycle.uncertain ?? lifecycle.lifecycleUncertain,
      ),
    };
  }

  let enabled = Boolean(fallbackEnabled);
  try {
    const managerEnabled = dataManager?.isEnabled?.(layerId);
    if (typeof managerEnabled === 'boolean') enabled = managerEnabled;
  } catch {
    // Retain the caller's observed fallback when the lightweight adapter fails.
  }
  return {
    enabled,
    lifecycleState: enabled ? 'enabled' : 'disabled',
    lifecycleUncertain: false,
  };
}
