/** Browser-local display choices. Shared views keep their own visual state. */
export const DISPLAY_PREFERENCES_KEY = 'gev:display-preferences:v1';

const BOOLEAN_FIELDS = [
  'bloom',
  'sharpen',
  'hudVisible',
  'scopeEnabled',
  'celestialRing',
];
const NUMBER_FIELDS = {
  bloomIntensity: [0, 200],
  bloomVersion: [1, 10],
  sharpenIntensity: [0, 100],
  detectionDensity: [0, 100],
  detectionFadePct: [0, 100],
  detectionOutsideOpacityPct: [0, 100],
  scopeFeatherPct: [0, 200],
  scopeTerminusPct: [94, 100],
};

/** Ignore damaged, unknown or incompatible values rather than failing startup. */
export function readDisplayPreferences(
  storage,
  { styles, layouts, maps } = {},
) {
  try {
    const saved = JSON.parse(
      storage?.getItem(DISPLAY_PREFERENCES_KEY) || 'null',
    );
    if (!saved || saved.version !== 1) return null;
    const state = {};
    for (const field of BOOLEAN_FIELDS) {
      if (typeof saved[field] === 'boolean') state[field] = saved[field];
    }
    for (const [field, [min, max]] of Object.entries(NUMBER_FIELDS)) {
      if (typeof saved[field] === 'number' && Number.isFinite(saved[field])) {
        state[field] = Math.max(min, Math.min(max, saved[field]));
      }
    }
    if (saved.scopeTerminusPct === null) state.scopeTerminusPct = null;
    for (const [field, choices] of Object.entries({
      style: ['normal', ...Object.keys(styles || {})],
      hudVariant: layouts || [],
      mapStack: maps || [],
      detectionMode: ['OFF', 'SPARSE', 'BALANCED', 'DENSE'],
      detectionAllocation: ['ELASTIC', 'WEIGHTED'],
    })) {
      if (choices.includes(saved[field])) state[field] = saved[field];
    }
    const uniforms = styles?.[state.style]?.uniforms;
    if (
      uniforms &&
      saved.styleParams &&
      typeof saved.styleParams === 'object'
    ) {
      state.styleParams = Object.fromEntries(
        Object.entries(saved.styleParams)
          .filter(
            ([key, value]) =>
              Object.hasOwn(uniforms, key) &&
              typeof value === 'number' &&
              Number.isFinite(value),
          )
          .map(([key, value]) => [
            key,
            Math.max(uniforms[key].min, Math.min(uniforms[key].max, value)),
          ]),
      );
    }
    if (saved.sonar && typeof saved.sonar === 'object') {
      state.sonar = {};
      if (typeof saved.sonar.enabled === 'boolean')
        state.sonar.enabled = saved.sonar.enabled;
      for (const key of ['rings', 'range', 'intensity', 'opacity', 'sector']) {
        if (
          typeof saved.sonar[key] === 'number' &&
          Number.isFinite(saved.sonar[key])
        ) {
          state.sonar[key] = saved.sonar[key];
        }
      }
    }
    return state;
  } catch {
    return null;
  }
}

export function writeDisplayPreferences(storage, state) {
  try {
    const encoded = JSON.stringify({ ...state, version: 1 });
    // Avoid synchronous storage writes for unrelated panel/URL updates.
    if (storage?.getItem(DISPLAY_PREFERENCES_KEY) !== encoded) {
      storage?.setItem(DISPLAY_PREFERENCES_KEY, encoded);
    }
  } catch {
    // Private browsing and full/disabled storage must leave controls usable.
  }
}
