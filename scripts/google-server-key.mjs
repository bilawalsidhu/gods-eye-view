import { isUnresolvedKeyVaultReference } from './secret-env.mjs';

/** Resolve server credentials after applying environment overrides per key. */
export function resolveGoogleServerKey(environment = {}, defaults = {}) {
  const value = (name) => {
    const raw = String(environment[name] ?? defaults[name] ?? '').trim();
    // An unresolved App Service Key Vault reference is not a key.
    return isUnresolvedKeyVaultReference(raw) ? '' : raw;
  };
  return value('GOOGLE_MAPS_SERVER_API_KEY') || value('GOOGLE_MAPS_API_KEY');
}
