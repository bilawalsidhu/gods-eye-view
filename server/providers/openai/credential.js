import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Public Codex CLI client. Not registered to God's Eye View. */
export const CODEX_PUBLIC_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const ISSUER = 'https://auth.openai.com';
const TOKEN_URL = `${ISSUER}/oauth/token`;

export function defaultOAuthStorePath() {
  return fileURLToPath(
    new URL('../../../.gev/openai-oauth.json', import.meta.url),
  );
}

export function readOAuthStore(file = defaultOAuthStorePath()) {
  try {
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function nowSeconds(now) {
  const value = typeof now === 'function' ? now() : now;
  const n = Number(value);
  if (!Number.isFinite(n)) return Math.floor(Date.now() / 1000);
  return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
}

function jwtExpiry(token) {
  const parts = String(token || '').split('.');
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

function usable(token, seconds) {
  const value = String(token || '').trim();
  if (!value) return false;
  const exp = jwtExpiry(value);
  return exp == null || exp > seconds;
}

/**
 * Prefer a platform API key. A ChatGPT OAuth access token is Realtime-only.
 * `now` is unix seconds, or milliseconds when the value is large.
 */
export function resolveOpenAiCredential({
  env = process.env,
  now = () => Date.now(),
  readStore = readOAuthStore,
} = {}) {
  const seconds = nowSeconds(now);
  const apiKey = String(env.OPENAI_API_KEY || '').trim();
  if (apiKey) return { source: 'api-key', bearer: apiKey, hud: true };

  const fromEnv = String(env.OPENAI_OAUTH_ACCESS_TOKEN || '').trim();
  if (usable(fromEnv, seconds)) {
    return { source: 'oauth', bearer: fromEnv, hud: false };
  }

  const store = readStore() || {};
  const stored = String(store.access_token || '').trim();
  const storeExpiry = Number(store.expires_at);
  const storeFresh =
    usable(stored, seconds) &&
    (!Number.isFinite(storeExpiry) ||
      storeExpiry <= 0 ||
      storeExpiry > seconds);
  if (storeFresh) {
    return { source: 'oauth-file', bearer: stored, hud: false };
  }
  return { source: 'missing', bearer: '', hud: false };
}

export async function requestDeviceCode({
  fetchImpl = (...args) => fetch(...args),
} = {}) {
  const response = await fetchImpl(
    `${ISSUER}/api/accounts/deviceauth/usercode`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: CODEX_PUBLIC_CLIENT_ID }),
    },
  );
  if (!response.ok) {
    throw new Error(`Device code request failed (${response.status})`);
  }
  return response.json();
}

export async function exchangeDeviceCode({
  fetchImpl = (...args) => fetch(...args),
  authorizationCode,
  codeVerifier,
} = {}) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: authorizationCode,
    redirect_uri: `${ISSUER}/deviceauth/callback`,
    client_id: CODEX_PUBLIC_CLIENT_ID,
    code_verifier: codeVerifier,
  });
  const response = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!response.ok) {
    throw new Error(`Token exchange failed (${response.status})`);
  }
  const tokens = await response.json();
  if (!tokens.access_token)
    throw new Error('Token exchange returned no access_token');
  return tokens;
}

/** Persist a GEV-owned session. Does not read or write another app's auth file. */
export function writeOAuthStore(file, tokens) {
  mkdirSync(path.dirname(file), { recursive: true });
  const exp = jwtExpiry(tokens.access_token);
  const body = {
    client: 'codex-public',
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token || '',
    expires_at: tokens.expires_at || exp || 0,
  };
  writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}
