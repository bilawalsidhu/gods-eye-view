export const DEFAULT_AR_PROVIDER_SELECTION = 'all';
export const AR_PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9:_-]{0,63}$/;
const MAX_PROVIDER_SELECTION_LENGTH = 512;

export function parseArProviderSelection(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized.length > MAX_PROVIDER_SELECTION_LENGTH) return null;
  if (normalized === 'all' || normalized === 'none') return normalized;
  const ids = normalized.split(',');
  if (!ids.length || ids.some((id) => !AR_PROVIDER_ID_PATTERN.test(id))) return null;
  return [...new Set(ids)].sort().join(',');
}

export function normalizeArProviderSelection(value) {
  return parseArProviderSelection(value) || DEFAULT_AR_PROVIDER_SELECTION;
}
