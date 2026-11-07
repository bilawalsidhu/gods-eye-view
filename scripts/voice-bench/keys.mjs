/**
 * Runtime key lookup for the voice benchmark. Keys are read from the
 * environment, then the macOS Keychain, at call time. They are never written
 * to results, logs, or files.
 */
import { execFileSync } from 'node:child_process';

const KEYCHAIN = {
  openai: { env: 'OPENAI_API_KEY', service: 'openai-api', account: 'api-key' },
  gemini: { env: 'GEMINI_API_KEY', service: 'gemini-api', account: 'api-key' },
};

const cache = new Map();

/** Resolve a provider key from the environment, then the Keychain. */
export function providerKey(provider) {
  if (cache.has(provider)) return cache.get(provider);
  const spec = KEYCHAIN[provider];
  if (!spec) throw new Error(`unknown key provider: ${provider}`);
  let value = process.env[spec.env] || '';
  if (!value && process.platform === 'darwin') {
    try {
      value = execFileSync(
        'security',
        ['find-generic-password', '-s', spec.service, '-a', spec.account, '-w'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim();
    } catch {
      value = '';
    }
  }
  if (!value) throw new Error(`${spec.env} is not available (env or Keychain)`);
  cache.set(provider, value);
  return value;
}
