import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Codex CLI access tokens live about an hour; when the JWT carries no exp
// claim the estimate anchors on the auth.json mtime, which every vendor-side
// refresh bumps.
const CODEX_FALLBACK_EXPIRY_S = 60 * 60;
const REFRESH_MARGIN_S = 60;
const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);

const SOURCE_ENV = 'env';
const SOURCE_CODEX_OAUTH = 'codex-oauth';

const NO_CREDENTIAL_MESSAGE =
  'OPENAI_API_KEY is not set and no usable Codex login was found — add an ' +
  'OpenAI key or run `codex login` to use a ChatGPT subscription';

/**
 * Raised when no OpenAI credential can be resolved, or when the operator
 * pinned the Codex lane and it is unusable. The message is safe to surface
 * to the browser: it names lanes, never secrets.
 */
class OpenAiAuthError extends Error {}

/**
 * Whether the operator pinned voice auth to the Codex OAuth lane.
 *
 * Absence preserves the key-first order. A present but unparsable value is
 * configuration ambiguity at a billing boundary and fails closed instead of
 * silently choosing a possibly metered lane.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {boolean}
 */
function preferCodexOauth(env = process.env) {
  if (!('GEV_PREFER_CODEX_OAUTH' in env)) return false;
  const raw = String(env.GEV_PREFER_CODEX_OAUTH || '')
    .trim()
    .toLowerCase();
  if (TRUE_VALUES.has(raw)) return true;
  if (FALSE_VALUES.has(raw)) return false;
  throw new OpenAiAuthError(
    'GEV_PREFER_CODEX_OAUTH must be true or false; refusing to choose a ' +
      'possibly metered auth lane',
  );
}

/**
 * Decode a JWT payload without verifying the signature. Only the exp claim
 * is consumed, on a credential the local vendor CLI issued.
 *
 * @param {string} token
 * @returns {{ payload: Record<string, unknown> | null, malformed: boolean }}
 */
function decodeJwtPayload(token) {
  const parts = String(token).split('.');
  if (parts.length < 2) return { payload: null, malformed: false };
  try {
    const data = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf8'),
    );
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      return { payload: null, malformed: true };
    }
    return { payload: data, malformed: false };
  } catch {
    return { payload: null, malformed: true };
  }
}

/**
 * The Codex CLI credential store: $CODEX_HOME/auth.json, else ~/.codex/auth.json.
 *
 * @param {Record<string, string | undefined>} env
 * @param {string | undefined} codexHome
 * @returns {string}
 */
function codexAuthPath(env, codexHome) {
  if (codexHome) return join(codexHome, 'auth.json');
  const configured = String(env.CODEX_HOME || '').trim();
  return join(configured || join(homedir(), '.codex'), 'auth.json');
}

/**
 * Mirror of the vendor rule: an auth.json in ChatGPT token mode, not an
 * auth.json that only wraps a plain API key.
 *
 * @param {Record<string, unknown>} data
 * @returns {boolean}
 */
function usesChatGptTokens(data) {
  const mode = data.auth_mode;
  if (typeof mode === 'string' && mode.trim()) {
    return ['chatgpt', 'chatgptauthtokens'].includes(mode.trim().toLowerCase());
  }
  return typeof data.OPENAI_API_KEY !== 'string';
}

/**
 * Read and validate the Codex CLI login. READ-ONLY by contract: this file
 * belongs to the Codex CLI, so an expired token is reported, never refreshed
 * or rewritten here — the operator re-runs `codex login`.
 *
 * @param {object} options
 * @param {Record<string, string | undefined>} options.env
 * @param {string} [options.codexHome]
 * @param {number} options.nowMs
 * @returns {{ token: string, expiresAt: Date | null } | null} null when no lane exists
 * @throws {OpenAiAuthError} when a login exists but the token is expired
 */
function readCodexOAuthCredential({ env, codexHome, nowMs }) {
  const authPath = codexAuthPath(env, codexHome);
  let data;
  try {
    data = JSON.parse(readFileSync(authPath, 'utf8'));
  } catch {
    return null; // unreadable or malformed auth.json means "no OAuth lane"
  }
  if (data === null || typeof data !== 'object' || !usesChatGptTokens(data)) {
    return null;
  }
  const tokens = data.tokens;
  if (tokens === null || typeof tokens !== 'object') return null;
  const access = tokens.access_token;
  const refresh = tokens.refresh_token;
  if (typeof access !== 'string' || !access) return null;
  if (typeof refresh !== 'string' || !refresh) return null;
  const { payload, malformed } = decodeJwtPayload(access);
  if (malformed) return null;

  let expiresS =
    payload && typeof payload.exp === 'number' ? payload.exp : null;
  if (expiresS === null) {
    let base = nowMs / 1000;
    try {
      base = statSync(authPath).mtimeMs / 1000;
    } catch {
      // keep nowMs as the anchor
    }
    expiresS = Math.round(base) + CODEX_FALLBACK_EXPIRY_S;
  }
  if (expiresS <= nowMs / 1000 + REFRESH_MARGIN_S) {
    throw new OpenAiAuthError(
      'OPENAI_API_KEY is not set and the Codex login token is expired — ' +
        'run `codex login` and retry; the vendor credential file is never ' +
        'refreshed here',
    );
  }
  return { token: access, expiresAt: new Date(expiresS * 1000) };
}

/**
 * Resolve the OpenAI Realtime bearer token in fail-closed order.
 *
 * Order: GEV_PREFER_CODEX_OAUTH pin -> OPENAI_API_KEY -> Codex OAuth login.
 * A blank OPENAI_API_KEY falls through to the Codex lane: both lanes mint
 * the same ephemeral secret for the same provider, so there is no billing
 * ambiguity in falling through.
 *
 * Ported from hermes-talk's talk_auth.py (itself a port of OpenClaw PR
 * #100671, "Reuse Codex OAuth for OpenAI Realtime voice").
 *
 * @param {object} [options]
 * @param {Record<string, string | undefined>} [options.env]
 * @param {string} [options.codexHome]
 * @param {number} [options.nowMs]
 * @returns {{ token: string, source: string, detail: string }}
 * @throws {OpenAiAuthError} when no credential resolves
 */
function resolveOpenAiCredential({
  env = process.env,
  codexHome,
  nowMs = Date.now(),
} = {}) {
  if (preferCodexOauth(env)) {
    const oauth = readCodexOAuthCredential({ env, codexHome, nowMs });
    if (oauth !== null) {
      return {
        token: oauth.token,
        source: SOURCE_CODEX_OAUTH,
        detail: 'Codex CLI login (ChatGPT subscription)',
      };
    }
    throw new OpenAiAuthError(
      'GEV_PREFER_CODEX_OAUTH is enabled but no usable Codex login exists — ' +
        'run `codex login` or unset it; metered API keys were not used',
    );
  }

  const key = String(env.OPENAI_API_KEY || '').trim();
  if (key) {
    return {
      token: key,
      source: SOURCE_ENV,
      detail: 'OPENAI_API_KEY environment variable',
    };
  }

  const oauth = readCodexOAuthCredential({ env, codexHome, nowMs });
  if (oauth !== null) {
    return {
      token: oauth.token,
      source: SOURCE_CODEX_OAUTH,
      detail: 'Codex CLI login (ChatGPT subscription)',
    };
  }
  throw new OpenAiAuthError(NO_CREDENTIAL_MESSAGE);
}

/**
 * Read-only Codex lane state for diagnostics: 'valid', 'expired', or
 * 'missing'. Never refreshes, never writes, never exposes the token.
 *
 * @param {object} [options]
 * @param {Record<string, string | undefined>} [options.env]
 * @param {string} [options.codexHome]
 * @param {number} [options.nowMs]
 * @returns {'valid' | 'expired' | 'missing'}
 */
function codexOAuthStatus({
  env = process.env,
  codexHome,
  nowMs = Date.now(),
} = {}) {
  try {
    return readCodexOAuthCredential({ env, codexHome, nowMs }) === null
      ? 'missing'
      : 'valid';
  } catch {
    return 'expired';
  }
}

export {
  NO_CREDENTIAL_MESSAGE,
  OpenAiAuthError,
  SOURCE_CODEX_OAUTH,
  SOURCE_ENV,
  codexOAuthStatus,
  preferCodexOauth,
  resolveOpenAiCredential,
};
