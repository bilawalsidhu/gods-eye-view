import { msg, t } from '../../i18n/index.js';

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
 * @property {{noun: string, action: string}|null} [coverageLabel]
 * @property {'capture'|'upload'} [sinceBasis]   What its SINCE compares.
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
        ? msg('No street-level imagery providers configured')
        : [...new Set(active.map((p) => p.hint).filter(Boolean))].join(' · '),
    error: active.find((p) => p.error)?.error || null,
    // One source is lit at a time; its wording counts the lines.
    label: active.find((p) => p.coverageLabel)?.coverageLabel || null,
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
function filterControls(providers) {
  const active = providers.filter((p) => p.on);
  const honoured = (key) =>
    active.length === 0 ||
    active.some((p) => (p.filters ?? ['pano', 'since']).includes(key));
  return { pano: honoured('pano'), since: honoured('since') };
}

/**
 * The note beside the SINCE value when a lit provider dates its imagery by
 * upload, "(by upload date)", or null. One source is lit at a time, so the
 * note needs no provider name.
 * @param {Array<ProviderSnapshot>} providers
 */
function sinceNote(providers) {
  return providers.some((p) => p.on && p.sinceBasis === 'upload')
    ? t('(by upload date)')
    : null;
}

/**
 * The panel snapshot from core state and provider snapshots.
 * @param {{enabled: boolean, groundClickReady?: boolean, filter: object, providers: Array<ProviderSnapshot>, street: object, sequence: object}} input
 */
export function composeUIState({
  enabled,
  groundClickReady = false,
  filter,
  providers,
  street,
  sequence,
}) {
  const { keyRequired, keyRejected, ...coverage } =
    summarizeCoverage(providers);
  return {
    enabled,
    groundClickReady: groundClickReady === true,
    keyRequired,
    keyAlternatives: keyAlternatives(providers),
    keyRejected,
    filter: { ...filter },
    filterControls: filterControls(providers),
    sinceNote: sinceNote(providers),
    providers: providers.map((p) => ({ ...p })),
    coverage,
    sequence: { ...sequence },
    street: { ...street },
  };
}
