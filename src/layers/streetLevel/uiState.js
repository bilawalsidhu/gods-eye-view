import { COLORS } from './policy.js';

/**
 * @typedef {object} ProviderSnapshot
 * @property {string} id
 * @property {string} name
 * @property {string} label
 * @property {boolean} on
 * @property {boolean|null} configured   null until the status call answers
 * @property {boolean} keyRequired
 * @property {string|null} requiresKeyId
 * @property {boolean} loading
 * @property {number} count
 * @property {string} hint
 * @property {string|null} error
 * @property {string} color   The source's one colour.
 */

/**
 * What the switched-on providers add up to: summed counts, any loading, the
 * first hint and error, and whether every one of them lacks its key.
 * @param {Array<ProviderSnapshot>} providers
 */
export function summarizeCoverage(providers) {
  const active = providers.filter((p) => p.on);
  return {
    count: active.reduce((sum, p) => sum + (p.count || 0), 0),
    loading: active.some((p) => p.loading),
    hint: active.find((p) => p.hint)?.hint || '',
    error: active.find((p) => p.error)?.error || null,
    keyRequired:
      active.length > 0 && active.every((p) => p.keyRequired === true),
  };
}

/**
 * Compose the snapshot the panel renders from the core state and one
 * snapshot per registered provider. Pure, so the merge rules are testable:
 * counts add up across active providers, the layer is key-gated only when
 * every switched-on provider lacks its key, and the legend lists one swatch
 * per active source, in its colour and under its name, followed by the
 * shared selection colour.
 * @param {{enabled: boolean, filter: object, providers: Array<ProviderSnapshot>, street: object, sequence: object}} input
 */
export function composeUIState({
  enabled,
  filter,
  providers,
  street,
  sequence,
  surface = 'draped',
}) {
  const active = providers.filter((p) => p.on);
  const { keyRequired, ...coverage } = summarizeCoverage(providers);
  const legend = active.map((provider) => ({
    key: provider.id,
    label: provider.name,
    color: provider.color,
  }));
  if (active.length)
    legend.push({ key: 'selected', label: 'Selected', color: COLORS.selected });
  return {
    enabled,
    keyRequired,
    filter: { ...filter },
    providers: providers.map((p) => ({ ...p })),
    coverage,
    legend,
    sequence: { ...sequence },
    street: { ...street },
    surface,
  };
}
