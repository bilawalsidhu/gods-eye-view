const INVALID = Symbol('invalid-action-episode-value');

export const ACTION_EPISODE_VERSION = 1;

export const ACTION_EPISODE_OUTCOMES = Object.freeze([
  'success',
  'failed',
  'cancelled',
]);

function boundedText(value, maxLength) {
  const text = String(value ?? '').trim();
  return text && text.length <= maxLength ? text : null;
}

function normalizePlainValue(value, ancestors = new Set()) {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number')
    return Number.isFinite(value) ? value : INVALID;
  if (Array.isArray(value)) {
    if (ancestors.has(value)) return INVALID;
    const next = new Set(ancestors).add(value);
    const normalized = value.map((item) => normalizePlainValue(item, next));
    return normalized.includes(INVALID) ? INVALID : normalized;
  }
  if (!value || typeof value !== 'object') return INVALID;
  if (
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    return INVALID;
  if (ancestors.has(value)) return INVALID;
  const next = new Set(ancestors).add(value);
  const normalized = {};
  for (const key of Object.keys(value).sort()) {
    const item = normalizePlainValue(value[key], next);
    if (item === INVALID) return INVALID;
    normalized[key] = item;
  }
  return normalized;
}

export function normalizeActionEpisodeStep(value) {
  if (!value || typeof value !== 'object') return null;
  const name = boundedText(value.name, 120);
  const schemaFingerprint = boundedText(value.schemaFingerprint, 160);
  const capabilityFingerprint = boundedText(value.capabilityFingerprint, 160);
  const outcome = String(value.outcome || '');
  if (
    !name ||
    !schemaFingerprint ||
    !capabilityFingerprint ||
    !ACTION_EPISODE_OUTCOMES.includes(outcome)
  )
    return null;
  const args = normalizePlainValue(value.args ?? {});
  if (args === INVALID || Array.isArray(args) || args === null) return null;
  return {
    name,
    schemaFingerprint,
    capabilityFingerprint,
    args,
    outcome,
  };
}

/**
 * Normalize one bounded verified interaction episode.
 *
 * The receipt stores semantic action names/arguments, schema/capability
 * fingerprints, and observed outcomes. It deliberately does not store DOM
 * selectors, pointer coordinates, model reasoning, full capability snapshots,
 * or arbitrary result payloads.
 */
export function normalizeActionEpisode(value) {
  if (!value || typeof value !== 'object') return null;
  if (Number(value.version) !== ACTION_EPISODE_VERSION) return null;
  const contextFingerprint = boundedText(value.contextFingerprint, 256);
  const actions = Array.isArray(value.actions)
    ? value.actions.map(normalizeActionEpisodeStep)
    : [];
  const startedAt = Number(value.startedAt);
  const completedAt = Number(value.completedAt);
  if (
    !contextFingerprint ||
    actions.length === 0 ||
    actions.length > 32 ||
    actions.some((action) => !action) ||
    !Number.isFinite(startedAt) ||
    !Number.isFinite(completedAt) ||
    startedAt < 0 ||
    completedAt < startedAt
  )
    return null;
  return {
    version: ACTION_EPISODE_VERSION,
    contextFingerprint,
    actions,
    correctedOrUndone: value.correctedOrUndone === true,
    startedAt,
    completedAt,
  };
}

function stepIdentity(step) {
  return JSON.stringify([
    step.name,
    step.schemaFingerprint,
    step.capabilityFingerprint,
    step.args,
  ]);
}

function sequenceIdentity(episode) {
  return JSON.stringify([
    episode.version,
    episode.contextFingerprint,
    episode.actions.map(stepIdentity),
  ]);
}

function episodeSucceeded(episode) {
  return (
    !episode.correctedOrUndone &&
    episode.actions.every((action) => action.outcome === 'success')
  );
}

/**
 * Detect exact repeated semantic action sequences.
 *
 * This performs no fuzzy matching and no model call. Argument object key order
 * is normalized before identity is calculated, so logically identical typed
 * actions group together.
 */
export function detectReflexCandidates(
  episodes,
  { minOccurrences = 3, minSuccessRate = 1 } = {},
) {
  const minimum = Math.max(2, Math.floor(Number(minOccurrences) || 0));
  const requiredRate = Math.min(
    1,
    Math.max(
      0,
      Number.isFinite(Number(minSuccessRate)) ? Number(minSuccessRate) : 1,
    ),
  );
  const groups = new Map();

  for (const value of Array.isArray(episodes) ? episodes : []) {
    const episode = normalizeActionEpisode(value);
    if (!episode) continue;
    const key = sequenceIdentity(episode);
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        contextFingerprint: episode.contextFingerprint,
        steps: episode.actions.map(
          ({ name, schemaFingerprint, capabilityFingerprint, args }) => ({
            name,
            schemaFingerprint,
            capabilityFingerprint,
            args,
          }),
        ),
        occurrences: 0,
        verifiedSuccesses: 0,
      };
      groups.set(key, group);
    }
    group.occurrences += 1;
    if (episodeSucceeded(episode)) group.verifiedSuccesses += 1;
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      successRate: group.verifiedSuccesses / group.occurrences,
    }))
    .filter(
      (group) =>
        group.occurrences >= minimum && group.successRate >= requiredRate,
    )
    .sort(
      (a, b) =>
        b.occurrences - a.occurrences ||
        a.contextFingerprint.localeCompare(b.contextFingerprint) ||
        a.key.localeCompare(b.key),
    );
}
