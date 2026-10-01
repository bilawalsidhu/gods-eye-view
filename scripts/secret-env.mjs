const KEY_VAULT_REFERENCE_PREFIX = '@Microsoft.KeyVault(';
const warned = new Set();

/**
 * Whether a configuration value is an App Service Key Vault reference the
 * platform could not resolve. App Service passes such a reference through
 * as the literal `@Microsoft.KeyVault(...)` string (missing secret, missing
 * role assignment), which is never a usable credential.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isUnresolvedKeyVaultReference(value) {
  return String(value ?? '')
    .trim()
    .startsWith(KEY_VAULT_REFERENCE_PREFIX);
}

/**
 * Remove every unresolved Key Vault reference from an environment object so
 * each provider sees the key as unset (its keyless path) instead of sending
 * the reference string upstream. Warns once per variable name; the warning
 * names the variable only.
 *
 * @param {Record<string, string|undefined>} environment - Mutated in place.
 * @param {(message: string) => void} [warn]
 * @returns {string[]} Names that were removed.
 */
export function scrubUnresolvedKeyVaultReferences(
  environment,
  warn = console.warn,
) {
  const removed = [];
  for (const [name, value] of Object.entries(environment)) {
    if (!isUnresolvedKeyVaultReference(value)) continue;
    delete environment[name];
    removed.push(name);
    if (warned.has(name)) continue;
    warned.add(name);
    warn(
      `[config] ${name} is an unresolved Key Vault reference; treating it as unset. ` +
        'Check the secret exists and the app identity can read it.',
    );
  }
  return removed;
}
