/**
 * The smallest viewer the voice action runner starts with: a clock, a canvas
 * and a camera that accept listeners and never call them. `overrides` replace
 * whole members, so a test that needs a richer scene or camera passes it.
 */
export function fakeVoiceViewer(overrides = {}) {
  return {
    clock: { onTick: { addEventListener: () => () => {} } },
    scene: { canvas: { addEventListener() {}, removeEventListener() {} } },
    camera: { moveEnd: { addEventListener() {} } },
    ...overrides,
  };
}

/** A layer manager holding `entries` (`[[id, { module }]]`), with the visibility-intent API. */
export function fakeVoiceManager(entries = [], overrides = {}) {
  return withVisibilityIntent({
    layers: new Map(entries),
    getAll: () => [],
    ...overrides,
  });
}

/**
 * Gives a fake manager that only has `setEnabled` the intent API the runner
 * calls: the change runs at once and has no intent epoch to wait for.
 */
export function withVisibilityIntent(manager) {
  if (
    typeof manager.setEnabled === 'function' &&
    typeof manager._setEnabledWithIntent !== 'function'
  ) {
    manager._setEnabledWithIntent = (layerId, enabled, options) => ({
      promise: (async () => manager.setEnabled(layerId, enabled, options))(),
    });
  }
  manager._waitForVisibilityIntent ??= async () => null;
  return manager;
}

/** The browser timers the runner reads from `window`, for Node. */
export function installVoiceWindow() {
  globalThis.window = globalThis.window || {
    clearTimeout,
    setTimeout,
    requestIdleCallback: null,
  };
}
