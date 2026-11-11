// Between two globe engines the shell has no visual settings of its own:
// the outgoing ones are released and the incoming ones are not built yet.
// A choice the person makes meanwhile (a style key, a Display control, a
// voice command) is kept and applied to the next engine's settings once
// that engine has restored the address's view, so the person's choice wins.
// Reads answer from the outgoing settings' last state.

/** The visual choices kept for the next engine, by method name. */
const PENDING_VISUAL_CHOICES = Object.freeze(
  new Set([
    'setStyle',
    'setBloom',
    'setSharpen',
    'setDetection',
    'setCelestialRingEnabled',
    'setStyleParameter',
    'applyVisualState',
    'applyCinematicPreset',
    '_setBloomEnabled',
    '_setBloomIntensity',
    '_setSharpenEnabled',
    '_setSharpenIntensity',
    '_setScope',
    '_setHudVariant',
    '_setDetectionDensity',
    '_setDetectionAllocation',
    '_setDetectionFade',
    '_setDetectionModeByLabel',
    '_setCyberSonarEnabled',
    '_setCyberSonarSetting',
  ]),
);

/**
 * Stand in for released visual settings: choices are queued (`queue`),
 * everything else reads the released settings.
 * @param {object} released The outgoing engine's VisualSettings.
 * @returns {{settings: object, queue: Array<[string, unknown[]]>}}
 */
export function pendingVisualSettings(released) {
  const queue = [];
  const settings = new Proxy(released, {
    get(target, name) {
      if (PENDING_VISUAL_CHOICES.has(name))
        return (...args) => {
          queue.push([name, args]);
          return { ok: true, pending: true };
        };
      const value = Reflect.get(target, name, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { settings, queue };
}

/** Apply the queued choices, in order, to the next engine's settings. */
export function applyPendingVisualChoices(settings, queue) {
  for (const [name, args] of queue.splice(0)) {
    try {
      settings[name]?.(...args);
    } catch (error) {
      console.error(
        `A visual choice made during the switch failed (${name}):`,
        error,
      );
    }
  }
}
