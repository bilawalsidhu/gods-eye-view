/**
 * Key-setup registry — the one place that owns what each provider key is
 * called and how an operator obtains it (ported from upstream, which named
 * the module keySetupCore.mjs). A layer declares WHICH key it needs
 * (`requiresKeyId`) and reports `stats.keyRequired` while that key is
 * absent; the row guidance is built from this table, so renaming a variable
 * or changing where it is documented never drifts from the UI copy.
 *
 * An unknown id returns '' rather than guessing: guidance naming the wrong
 * variable sends the operator to the wrong provider. Pure and worker-safe —
 * string table only, no `process`, no `fetch`.
 *
 * @module data/keySetup
 */

/**
 * Registry of provider keys a layer can be gated on, keyed by registry id.
 * `envVar` is the exact variable an operator sets (server-side keys stay
 * server-side; see .env.example for each one's scope and caveats).
 * @type {Readonly<Record<string, {envVar: string, text: string}>>}
 */
export const KEY_SETUP_REQUIREMENTS = Object.freeze({
  // The /api/firms proxy answers 503 {error:'no_key'} without it. KEY
  // REQUIRED only shows when even NASA's public keyless 24h SNPP fallback
  // was unreachable, so the guidance names the key that lifts the layer to
  // the full three-feed NRT service.
  firms: Object.freeze({
    envVar: 'FIRMS_MAP_KEY',
    text: 'Set FIRMS_MAP_KEY in .env — free key at firms.modaps.eosdis.nasa.gov/api/map_key/',
  }),
});

/**
 * Setup guidance for a provider key by registry id.
 * @param {string} keyId Registry id, e.g. 'firms'.
 * @returns {string} Human guidance naming the variable, or '' when unknown.
 */
export function keySetupRequirement(keyId) {
  const entry = KEY_SETUP_REQUIREMENTS[String(keyId || '').trim()];
  return entry ? entry.text : '';
}

/**
 * Guidance for a layer control a missing provider key is holding back.
 *
 * A row reading KEY REQUIRED without saying WHICH key leaves a dead control
 * and no next step. Empty when the layer needs no key, already has one, or
 * declares an id the registry doesn't know (never guess a variable name).
 *
 * @param {object} [layer] Row from the layer manager's getAll().
 * @returns {string} Guidance text, or '' when no key guidance applies.
 */
export function layerKeyRequirementTooltip(layer = {}) {
  if (layer?.stats?.keyRequired !== true) return '';
  const requiresKeyId = String(layer.requiresKeyId || '').trim();
  return requiresKeyId ? keySetupRequirement(requiresKeyId) : '';
}
