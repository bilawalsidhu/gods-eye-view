export const SCOPE_PREFERENCE_KEY = 'gev:scope-enabled:v1';
export function readScopePreference(storage) {
  try {
    const value = (storage ?? globalThis.localStorage)?.getItem(
      SCOPE_PREFERENCE_KEY,
    );
    return value === '0' ? false : value === '1' ? true : null;
  } catch {
    return null;
  }
}
export function writeScopePreference(enabled, storage) {
  try {
    (storage ?? globalThis.localStorage)?.setItem(
      SCOPE_PREFERENCE_KEY,
      enabled ? '1' : '0',
    );
  } catch {
    /* Private/denied storage still keeps this session's choice. */
  }
}
export function resolveScopeEnabled(requested, preference) {
  return preference === false ? false : Boolean(requested);
}
