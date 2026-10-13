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
 * @property {boolean} [groundClick]
 * @property {Array<'pano'|'since'>} [filters]
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
    hint:
      providers.length === 0
        ? 'No street-level imagery providers configured'
        : [...new Set(active.map((p) => p.hint).filter(Boolean))].join(' · '),
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
 * Switched-off providers that would draw with a key already set, offered
 * while the switched-on ones lack theirs.
 * @param {Array<ProviderSnapshot>} providers
 * @returns {Array<{id: string, label: string, requiresKeyId: string|null}>}
 */
export function keyAlternatives(providers) {
  if (!summarizeCoverage(providers).keyRequired) return [];
  return providers
    .filter((p) => !p.on && p.configured === true && p.keyRequired !== true)
    .map(({ id, label, requiresKeyId }) => ({ id, label, requiresKeyId }));
}

/**
 * The filter controls a switched-on provider honours (both when none is on).
 * @param {Array<ProviderSnapshot>} providers
 */
export function filterControls(providers) {
  const active = providers.filter((p) => p.on);
  const honoured = (key) =>
    active.length === 0 ||
    active.some((p) => (p.filters ?? ['pano', 'since']).includes(key));
  return { pano: honoured('pano'), since: honoured('since') };
}

/**
 * The panel snapshot from core state and provider snapshots. The legend has
 * one swatch per active source that draws coverage lines, then Selected.
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
  const legend = active
    .filter((provider) => provider.groundClick !== true)
    .map((provider) => ({
      key: provider.id,
      label: provider.name,
      color: provider.color,
    }));
  if (legend.length)
    legend.push({ key: 'selected', label: 'Selected', color: COLORS.selected });
  return {
    enabled,
    groundClickReady: groundClickReady === true,
    keyRequired,
    keyAlternatives: keyAlternatives(providers),
    keyRejected,
    filter: { ...filter },
    filterControls: filterControls(providers),
    providers: providers.map((p) => ({ ...p })),
    coverage,
    legend,
    sequence: { ...sequence },
    street: { ...street },
    surface,
  };
}
