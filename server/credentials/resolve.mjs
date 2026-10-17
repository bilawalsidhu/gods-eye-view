import { spawnSync } from 'node:child_process';

import { knownKeySetupEnvVars } from '../../src/keySetupCore.mjs';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BUFFER = 1024 * 1024;

const BWS_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

// Pass only the OS/runtime context each CLI needs, never other provider keys,
// the GEV_SECRET_* configuration, or credentials fetched earlier in this pass.
const MANAGER_OS_ENV = Object.freeze([
  'PATH', 'Path', 'PATHEXT', 'HOME', 'USERPROFILE', 'APPDATA',
  'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
  'XDG_RUNTIME_DIR', 'TMP', 'TEMP', 'TMPDIR', 'SystemRoot', 'SYSTEMROOT',
  'WINDIR', 'LANG', 'LC_ALL', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
]);

function managerCommandEnvironment(env, command) {
  const allowed = command === 'bws'
    ? [...MANAGER_OS_ENV, 'BWS_ACCESS_TOKEN', 'BWS_API_URL', 'BWS_IDENTITY_URL']
    : MANAGER_OS_ENV;
  const child = {};
  for (const name of allowed) {
    if (env[name] !== undefined) child[name] = String(env[name]);
  }
  return child;
}

function safeBwsId(value) {
  const id = String(value ?? '').trim();
  if (!BWS_ID_PATTERN.test(id))
    throw new Error('Invalid Bitwarden Secrets Manager identifier');
  return id;
}

export function credentialReference(value) {
  const raw = String(value ?? '').trim();
  if (raw.startsWith('pass://')) {
    return raw.length > 'pass://'.length
      ? { provider: 'proton-pass', reference: raw }
      : null;
  }
  const bws = raw.match(/^bws:\/\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})$/);
  return bws ? { provider: 'bws', secretId: bws[1] } : null;
}

export function parseBwsSecretObject(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(String(stdout || ''));
  } catch {
    throw new Error('Bitwarden Secrets Manager returned invalid JSON');
  }
  const item = Array.isArray(parsed) ? parsed[0] : parsed;
  const value = String(item?.value ?? '').trim();
  if (!value)
    throw new Error('Bitwarden Secrets Manager returned an empty secret');
  return value;
}

export function parseBwsProjectSecrets(stdout, allowedNames) {
  let parsed;
  try {
    parsed = JSON.parse(String(stdout || ''));
  } catch {
    throw new Error('Bitwarden Secrets Manager returned invalid project JSON');
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      'Bitwarden Secrets Manager project response was not a list',
    );
  }
  const allowed = new Set(allowedNames || []);
  const secrets = {};
  for (const item of parsed) {
    const key = String(item?.key ?? '').trim();
    const value = String(item?.value ?? '').trim();
    if (allowed.has(key) && value && secrets[key] === undefined)
      secrets[key] = value;
  }
  return secrets;
}

function defaultRunCommand(command, args, env) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env,
    windowsHide: true,
    timeout: DEFAULT_TIMEOUT_MS,
    maxBuffer: DEFAULT_MAX_BUFFER,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error?.code === 'ENOENT') {
    throw new Error(`${command} is not installed or not on PATH`);
  }
  if (result.error?.code === 'ETIMEDOUT') {
    throw new Error(`${command} timed out while resolving credentials`);
  }
  if (result.error) throw new Error(`${command} could not be started`);
  if (result.status !== 0) {
    // Deliberately do not include stderr: auth tools may print sensitive data.
    throw new Error(`${command} failed while resolving credentials`);
  }
  return String(result.stdout || '');
}

function resolveReference(ref, { env, runCommand }) {
  if (ref.provider === 'proton-pass') {
    const value = String(
      runCommand('pass-cli', ['item', 'view', ref.reference], managerCommandEnvironment(env, 'pass-cli')),
    ).trim();
    if (!value) throw new Error('Proton Pass returned an empty secret');
    return value;
  }
  if (ref.provider === 'bws') {
    return parseBwsSecretObject(
      runCommand(
        'bws',
        ['secret', 'get', safeBwsId(ref.secretId), '--output', 'json'],
        managerCommandEnvironment(env, 'bws'),
      ),
    );
  }
  throw new Error('Unsupported credential reference');
}

function bwsProjectIds(env) {
  const raw = [env.GEV_BWS_PROJECT_IDS, env.GEV_BWS_PROJECT_ID]
    .filter((value) => value != null && String(value).trim())
    .join(',');
  if (!raw) return [];
  return [...new Set(raw.split(',').map((value) => safeBwsId(value)))];
}

/**
 * Resolve external secret-manager references into the process environment.
 *
 * Precedence per provider key:
 *   1. existing literal ENV_VAR
 *   2. reference already stored in ENV_VAR (`pass://...` or `bws://...`)
 *   3. GEV_SECRET_<ENV_VAR> reference
 *   4. matching secret name from GEV_BWS_PROJECT_ID(S)
 *
 * Only env vars registered by Provider Settings are eligible for bulk BWS
 * import. Values are held in process memory only and are never logged here.
 */
export function resolveCredentialEnvironment({
  env = process.env,
  runCommand = defaultRunCommand,
} = {}) {
  const names = [...knownKeySetupEnvVars()];
  const sources = {};

  // Resolve explicit per-key references first. A literal key always wins.
  for (const name of names) {
    const current = String(env[name] ?? '').trim();
    const currentRef = credentialReference(current);
    if (current.startsWith('bws://') && !currentRef)
      throw new Error('Invalid Bitwarden Secrets Manager secret reference');
    if (current && !currentRef) continue;

    const companion = String(env[`GEV_SECRET_${name}`] ?? '').trim();
    const companionRef = credentialReference(companion);
    if (companion.startsWith('bws://') && !companionRef)
      throw new Error('Invalid Bitwarden Secrets Manager secret reference');
    const configured = currentRef || companionRef;
    if (!configured) continue;

    env[name] = resolveReference(configured, { env, runCommand });
    sources[name] = configured.provider;
  }

  // Bulk BWS project hydration is intentionally last: it fills blanks only.
  // This makes project-level configuration ergonomic without overriding a
  // deliberately supplied per-key env value or reference.
  const missing = () => names.filter((name) => !String(env[name] ?? '').trim());
  for (const projectId of bwsProjectIds(env)) {
    const wanted = missing();
    if (!wanted.length) break;
    const project = parseBwsProjectSecrets(
      runCommand('bws', ['secret', 'list', projectId, '--output', 'json'], managerCommandEnvironment(env, 'bws')),
      wanted,
    );
    for (const [name, value] of Object.entries(project)) {
      if (String(env[name] ?? '').trim()) continue;
      env[name] = value;
      sources[name] = 'bws';
    }
  }

  return {
    resolved: Object.fromEntries(
      names
        .filter((name) => sources[name])
        .map((name) => [name, sources[name]]),
    ),
  };
}
