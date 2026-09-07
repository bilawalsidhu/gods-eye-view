#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const CONFIGURATION = Object.freeze([
  { name: 'AZURE_CLIENT_ID', label: 'User-assigned managed identity selector', keychain: [] },
  { name: 'AZURE_MAPS_CLIENT_ID', label: 'Azure Maps account client ID', keychain: [] },
  { name: 'FOUNDRY_ENDPOINT', label: 'Microsoft Foundry endpoint', keychain: [] },
  { name: 'FOUNDRY_REALTIME_DEPLOYMENT', label: 'Foundry realtime deployment', keychain: [] },
  { name: 'FOUNDRY_HUD_DEPLOYMENT', label: 'Foundry HUD deployment', keychain: [] },
  { name: 'AISSTREAM_API_KEY', label: 'AISStream vessels', keychain: [['aisstream-api', 'api-key']] },
  { name: 'FIRMS_MAP_KEY', label: 'NASA FIRMS fires', keychain: [['firms-map', 'map-key']] },
  { name: 'TOMTOM_API_KEY', label: 'TomTom traffic', keychain: [['tomtom-api', 'api-key']] },
  {
    name: 'OPENSKY_CLIENT_ID',
    label: 'OpenSky client ID',
    keychain: ['opensky-network', 'opensky'].flatMap((service) => (
      ['client_id', 'client-id', 'client', 'api-key'].map((account) => [service, account])
    )),
  },
  {
    name: 'OPENSKY_CLIENT_SECRET',
    label: 'OpenSky client secret',
    keychain: ['opensky-network', 'opensky'].flatMap((service) => (
      ['client_secret', 'client-secret', 'secret'].map((account) => [service, account])
    )),
  },
]);
export const CREDENTIALS = CONFIGURATION;

export function isConfiguredValue(value) {
  const normalized = String(value || '').trim();
  return normalized.length > 0 && !/^(your_|replace_|example|changeme)/i.test(normalized);
}

export function classifyNodeVersion(version = process.versions.node) {
  const [major = 0, minor = 0] = String(version).split('.').map(Number);
  if (major === 24 && minor >= 14) {
    return { level: 'ok', summary: 'supported LTS and calibrated for release gates' };
  }
  if (major === 26) return { level: 'ok', summary: 'supported runtime' };
  if (major === 25) {
    return { level: 'warn', summary: 'usable but EOL; allocation benchmarks will be skipped' };
  }
  if (major < 24 || (major === 24 && minor < 14)) {
    return { level: 'error', summary: 'too old; install Node 24.14 or newer' };
  }
  // NEWER than this release has verified is a warning, never a refusal: a
  // future Node must not brick a no-terminal install with advice its user
  // cannot follow. Too-old stays an error above — old runtimes genuinely fail.
  return { level: 'warn', summary: 'newer than this release has verified; Node 24.14.x or 26.x is the tested path' };
}

/** Verify that every direct package declared by this checkout is present. */
export function hasRequiredDependencies(rootDir = ROOT) {
  try {
    const manifest = JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
    const packages = new Set([
      ...Object.keys(manifest.dependencies || {}),
      ...Object.keys(manifest.devDependencies || {}),
    ]);
    return packages.size > 0 && [...packages].every((name) => (
      existsSync(path.join(rootDir, 'node_modules', ...name.split('/'), 'package.json'))
    ));
  } catch {
    return false;
  }
}

/** Return the npm command and spawn mode required by the target platform. */
export function npmProcessSpec(platform = process.platform) {
  const windows = platform === 'win32';
  return { command: windows ? 'npm.cmd' : 'npm', shell: windows };
}

/** Read one key from Vite's dotenv file ladder without depending on Vite. */
export function readDoctorDotenvValue(
  variableName,
  rootDir = ROOT,
  mode = 'development',
) {
  const key = String(variableName || '').trim();
  if (!/^[A-Z_][A-Z0-9_]*$/i.test(key)) return '';

  const values = {};
  for (const filename of ['.env', '.env.local', `.env.${mode}`, `.env.${mode}.local`]) {
    const filepath = path.join(rootDir, filename);
    if (!existsSync(filepath)) continue;
    try {
      Object.assign(values, parseEnv(readFileSync(filepath, 'utf8')));
    } catch {
      // A malformed optional dotenv file must not crash the setup diagnosis.
    }
  }
  return String(values[key] ?? '');
}

function hasKeychainItem(service, account) {
  if (process.platform !== 'darwin') return false;
  const result = spawnSync('security', [
    'find-generic-password',
    '-s', service,
    '-a', account,
  ], { stdio: 'ignore' });
  return result.status === 0;
}

function hasAzureCliSession() {
  const windows = process.platform === 'win32';
  const result = spawnSync(windows ? 'az.cmd' : 'az', ['account', 'show', '--output', 'none'], {
    stdio: 'ignore',
    shell: windows,
  });
  return result.status === 0;
}

export function detectDefaultAzureCredential({
  environment = process.env,
  azureCliLookup = hasAzureCliSession,
} = {}) {
  const workloadIdentity = [
    'AZURE_CLIENT_ID',
    'AZURE_TENANT_ID',
    'AZURE_FEDERATED_TOKEN_FILE',
  ].every((name) => isConfiguredValue(environment[name]));
  if (workloadIdentity) return { configured: true, source: 'workload identity environment' };
  if (isConfiguredValue(environment.IDENTITY_ENDPOINT) || isConfiguredValue(environment.MSI_ENDPOINT)) {
    return { configured: true, source: 'managed identity host' };
  }
  if (azureCliLookup()) return { configured: true, source: 'Azure CLI session' };
  return { configured: false, source: null };
}

export function resolveCredential(spec, {
  includeKeychain = true,
  authoritativeEnvironment = false,
  environment = process.env,
  rootDir = ROOT,
  keychainLookup = hasKeychainItem,
} = {}) {
  const environmentDefinesKey = Object.prototype.hasOwnProperty.call(environment, spec.name);
  if (isConfiguredValue(environment[spec.name])) return { configured: true, source: 'environment' };
  if (authoritativeEnvironment && environmentDefinesKey) return { configured: false, source: null };
  if (isConfiguredValue(readDoctorDotenvValue(spec.name, rootDir))) return { configured: true, source: 'dotenv files' };
  if (includeKeychain && spec.keychain.some(([service, account]) => keychainLookup(service, account))) {
    return { configured: true, source: 'macOS Keychain' };
  }
  return { configured: false, source: null };
}

export function buildCapabilitySummary(configuration, {
  azureCredential = { configured: false, source: null },
  environment = process.env,
} = {}) {
  const configured = (name) => configuration[name]?.configured === true;
  const foundryConfigured = [
    'FOUNDRY_ENDPOINT',
    'FOUNDRY_REALTIME_DEPLOYMENT',
    'FOUNDRY_HUD_DEPLOYMENT',
  ].every(configured);
  const vitePort = Number.parseInt(environment.PORT, 10) || 4173;
  const bffPort = Number.parseInt(environment.BFF_PORT, 10) || 3000;
  return {
    bff: `Fastify BFF :${bffPort}; Vite :${vitePort}`,
    azureAuth: azureCredential.configured
      ? `DefaultAzureCredential available through ${azureCredential.source}`
      : 'DefaultAzureCredential has no detected local source; run az login',
    map: azureCredential.configured && configured('AZURE_MAPS_CLIENT_ID')
      ? 'Azure Maps through the same-origin BFF; OSM fallback available'
      : 'OpenStreetMap fallback (Azure Maps needs DefaultAzureCredential + AZURE_MAPS_CLIENT_ID)',
    flights: configured('OPENSKY_CLIENT_ID') && configured('OPENSKY_CLIENT_SECRET')
      ? 'OpenSky OAuth credentials present (runtime mode and validity not verified)'
      : 'OpenSky OAuth credentials not configured',
    voice: azureCredential.configured && foundryConfigured
      ? 'Microsoft Foundry realtime and HUD deployments configured through the BFF'
      : 'off until DefaultAzureCredential and all Foundry settings are configured',
    vessels: configured('AISSTREAM_API_KEY') ? 'live AISStream feed' : 'off until an AISStream key is added',
    fires: configured('FIRMS_MAP_KEY') ? 'live NASA FIRMS feed' : 'off until a FIRMS key is added',
    traffic: configured('TOMTOM_API_KEY') ? 'live TomTom flow' : 'built-in traffic simulation',
  };
}

export function inspectSetup({
  includeKeychain = true,
  authoritativeEnvironment = false,
  environment = process.env,
  rootDir = ROOT,
  azureCliLookup = hasAzureCliSession,
} = {}) {
  const node = classifyNodeVersion();
  const npm = npmProcessSpec();
  const npmResult = spawnSync(npm.command, ['--version'], {
    encoding: 'utf8',
    shell: npm.shell,
  });
  const credentials = Object.fromEntries(CONFIGURATION.map((spec) => [
    spec.name,
    resolveCredential(spec, {
      includeKeychain,
      authoritativeEnvironment,
      environment,
      rootDir,
    }),
  ]));
  const azureCredential = detectDefaultAzureCredential({ environment, azureCliLookup });
  const dependenciesInstalled = hasRequiredDependencies(rootDir);
  return {
    ready: node.level !== 'error' && npmResult.status === 0 && dependenciesInstalled,
    node: { version: process.versions.node, ...node },
    npm: npmResult.status === 0
      ? { available: true, version: String(npmResult.stdout || '').trim() }
      : { available: false, version: null },
    dependenciesInstalled,
    credentials,
    azureCredential,
    capabilities: buildCapabilitySummary(credentials, { azureCredential, environment }),
  };
}

function symbol(level) {
  if (level === 'ok') return 'OK';
  if (level === 'warn') return 'WARN';
  return 'ERROR';
}

export function formatSetupReport(report, { readyMessage } = {}) {
  const hasKeychainSource = Object.values(report.credentials || {})
    .some((credential) => credential?.source === 'macOS Keychain');
  const resolvedReadyMessage = readyMessage || (hasKeychainSource
    ? 'Ready. Run ./scripts/dev-fresh.sh, then open http://localhost:4173.'
    : 'Ready. Run npm run dev, then open http://localhost:4173.');
  const lines = [
    "God's Eye View setup doctor",
    '',
    `[${symbol(report.node.level)}] Node ${report.node.version}: ${report.node.summary}`,
    report.npm.available ? `[OK] npm ${report.npm.version}` : '[ERROR] npm was not found',
    report.dependenciesInstalled ? '[OK] dependencies installed' : '[WARN] dependencies missing; run npm install',
    '',
    `BFF:     ${report.capabilities.bff}`,
    `Azure:   ${report.capabilities.azureAuth}`,
    `Map:     ${report.capabilities.map}`,
    `Flights: ${report.capabilities.flights}`,
    `Voice:   ${report.capabilities.voice}`,
    `Vessels: ${report.capabilities.vessels}`,
    `Fires:   ${report.capabilities.fires}`,
    `Traffic: ${report.capabilities.traffic}`,
    '',
    'Configured services:',
    ...CONFIGURATION.map((spec) => {
      const state = report.credentials[spec.name];
      return state.configured
        ? `  [OK] ${spec.label} (${state.source})`
        : `  [--] ${spec.label}`;
    }),
    '',
    report.ready
      ? resolvedReadyMessage
      : 'Setup needs attention before the app can start.',
  ];
  return lines.join('\n');
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const report = inspectSetup();
  if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else console.log(formatSetupReport(report));
  if (!report.ready) process.exitCode = 1;
}
