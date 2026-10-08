import { COLORS } from './policy.js';

/**
 * @typedef {object} ProviderSnapshot
 * @property {string} id
 * @property {string} name
 * @property {string} label
 * @property {boolean} on
 * @property {boolean|null} configured   null until the status call answers
 * @property {boolean} keyRequired   no usable key: missing or rejected
 * @property {boolean} [keyRejected] the provider refused the configured key
 * @property {string|null} requiresKeyId
 * @property {boolean} loading
 * @property {number} count
 * @property {string} hint
 * @property {string|null} error
 * @property {string} color   The source's one colour.
 */

/**
 * Totals over switched-on providers. Key-gated only when every one lacks its
 * key; `keyRejected` when that is because a key was refused.
 * @param {Array<ProviderSnapshot>} providers
 */
export function summarizeCoverage(providers) {
  const active = providers.filter((p) => p.on);
  return {
    count: active.reduce((sum, p) => sum + (p.count || 0), 0),
    loading: active.some((p) => p.loading),
    hint: [...new Set(active.map((p) => p.hint).filter(Boolean))].join(' · '),
    error: active.find((p) => p.error)?.error || null,
    keyRequired:
      active.length > 0 && active.every((p) => p.keyRequired === true),
    keyRejected:
      active.length > 0 &&
      active.every((p) => p.keyRequired === true) &&
      active.some((p) => p.keyRejected === true),
  };
}

/**
 * The panel snapshot from core state and provider snapshots. The legend has
 * one swatch per active source, then the shared selection colour.
 * @param {{enabled: boolean, filter: object, providers: Array<ProviderSnapshot>, street: object, sequence: object}} input
 */
export function composeUIState({
  enabled,
  groundClickReady = false,
  filter,
  providers,
  street,
  sequence,
  surface = 'draped',
}) {
  const active = providers.filter((p) => p.on);
  const { keyRequired, keyRejected, ...coverage } =
    summarizeCoverage(providers);
  const legend = active.map((provider) => ({
    key: provider.id,
    label: provider.name,
    color: provider.color,
  }));
  if (active.length)
    legend.push({ key: 'selected', label: 'Selected', color: COLORS.selected });
  return {
    enabled,
    /** The camera is at street zoom: a ground-click provider can open here. */
    groundClickReady: groundClickReady === true,
    keyRequired,
    keyRejected,
    filter: { ...filter },
    providers: providers.map((p) => ({ ...p })),
    coverage,
    legend,
    sequence: { ...sequence },
    street: { ...street },
    surface,
  };
}
