import { spawn } from 'node:child_process';
import {
  accessSync,
  constants as fsConstants,
  readFileSync,
  statSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function codexAuthPath({
  environment = process.env,
  home = os.homedir(),
} = {}) {
  const explicit = String(environment.CODEX_AUTH_JSON || '').trim();
  if (explicit) return path.resolve(explicit);
  const codexHome = String(environment.CODEX_HOME || '').trim();
  return path.join(
    codexHome ? path.resolve(codexHome) : path.join(home, '.codex'),
    'auth.json',
  );
}

/** An optional operator lock that refuses the metered API-key voice lane. */
export function preferCodexOAuth(environment = process.env) {
  if (!Object.hasOwn(environment, 'GEV_PREFER_CODEX_OAUTH')) return false;
  const value = String(environment.GEV_PREFER_CODEX_OAUTH || '')
    .trim()
    .toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  throw new Error(
    'GEV_PREFER_CODEX_OAUTH must be true or false. Refusing to choose a voice auth mode.',
  );
}

export function readCodexOAuthAccessToken({
  authPath = codexAuthPath(),
  readFile = readFileSync,
  statFile = statSync,
  nowMs = Date.now(),
} = {}) {
  const unavailable =
    'ChatGPT sign-in is unavailable. Sign in to Codex or the ChatGPT desktop app and try again.';
  let parsed;
  try {
    parsed = JSON.parse(readFile(authPath, 'utf8'));
  } catch {
    throw new Error(unavailable);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(unavailable);
  }
  const mode = String(parsed.auth_mode || '')
    .trim()
    .toLowerCase();
  const chatGptMode = mode
    ? mode === 'chatgpt' || mode === 'chatgptauthtokens'
    : typeof parsed.OPENAI_API_KEY !== 'string';
  const token = parsed.tokens?.access_token;
  const refresh = parsed.tokens?.refresh_token;
  if (
    !chatGptMode ||
    typeof token !== 'string' ||
    !token.trim() ||
    typeof refresh !== 'string' ||
    !refresh.trim()
  ) {
    throw new Error(unavailable);
  }

  // This only checks token shape and expiry. OpenAI verifies the signature when
  // minting the short-lived Realtime credential; we never modify auth.json.
  const parts = token.split('.');
  if (
    parts.length !== 3 ||
    parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))
  ) {
    throw new Error(unavailable);
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw new Error(unavailable);
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(unavailable);
  }
  let expiresAtMs;
  if (Object.hasOwn(payload, 'exp')) {
    if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) {
      throw new Error(unavailable);
    }
    expiresAtMs = payload.exp * 1000;
  } else {
    try {
      expiresAtMs = statFile(authPath).mtimeMs + 60 * 60 * 1000;
    } catch {
      throw new Error(unavailable);
    }
  }
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs + 60_000) {
    throw new Error(
      'ChatGPT sign-in has expired. Run codex login and try again.',
    );
  }
  return token;
}

export function resolveCodexExecutable({
  environment = process.env,
  home = os.homedir(),
  access = accessSync,
} = {}) {
  const explicit = String(environment.CODEX_BIN || '').trim();
  if (explicit) return explicit;

  for (const candidate of [
    path.join(home, '.local', 'bin', 'codex'),
    path.join(
      home,
      '.codex',
      'packages',
      'standalone',
      'current',
      'bin',
      'codex',
    ),
  ]) {
    try {
      access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Fall through to the next known location, then PATH.
    }
  }
  return 'codex';
}

export function startCodexChatGptLogin({
  spawnImpl = spawn,
  environment = process.env,
  home = os.homedir(),
  executable = resolveCodexExecutable({ environment, home }),
} = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(executable, ['login'], {
        cwd: home,
        detached: true,
        stdio: 'ignore',
        env: environment,
      });
    } catch (error) {
      reject(error);
      return;
    }

    child.once('error', reject);
    child.once('spawn', () => {
      child.unref?.();
      resolve({ executable });
    });
  }).catch((error) => {
    throw new Error(
      `Could not start ChatGPT sign-in with Codex: ${error?.message || error}`,
    );
  });
}
