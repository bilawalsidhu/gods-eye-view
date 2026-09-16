import { spawn } from 'node:child_process';
import { accessSync, constants as fsConstants, readFileSync } from 'node:fs';
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

export function readCodexOAuthAccessToken({
  authPath = codexAuthPath(),
  readFile = readFileSync,
} = {}) {
  let parsed;
  try {
    parsed = JSON.parse(readFile(authPath, 'utf8'));
  } catch {
    throw new Error(
      'ChatGPT sign-in is unavailable. Sign in to Codex or the ChatGPT desktop app and try again.',
    );
  }
  const token = String(parsed?.tokens?.access_token || '').trim();
  if (!token) {
    throw new Error(
      'ChatGPT sign-in is unavailable. Sign in to Codex or the ChatGPT desktop app and try again.',
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
