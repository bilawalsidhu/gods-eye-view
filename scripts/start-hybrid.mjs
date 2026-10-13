#!/usr/bin/env node
/** Run two local upstream applications with one globe and one MCP surface. */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { loadEnv } from 'vite';
import { resolveLocalModelConfig } from '../server/providers/local-model.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const { values } = parseArgs({
  options: {
    'world-monitor-root': { type: 'string' },
    port: { type: 'string', default: '4173' },
    help: { type: 'boolean', default: false },
  },
});
if (values.help) {
  console.log(
    'node scripts/start-hybrid.mjs --world-monitor-root /path/to/worldmonitor [--port 4173]',
  );
  process.exit(0);
}
const worldMonitorRoot =
  values['world-monitor-root'] && path.resolve(values['world-monitor-root']);
const port = Number(values.port);
if (
  !worldMonitorRoot ||
  !Number.isInteger(port) ||
  port < 1024 ||
  port > 65535
) {
  console.error(
    'Supply --world-monitor-root and an unused local port from 1024 to 65535.',
  );
  process.exit(1);
}
const sidecarEntry = path.join(
  worldMonitorRoot,
  'src-tauri/sidecar/local-api-server.mjs',
);
const compiledNews = path.join(worldMonitorRoot, 'api/news/v1/[rpc].js');
if (!existsSync(sidecarEntry) || !existsSync(compiledNews)) {
  console.error(
    'World Monitor needs its local backend build. In that checkout, run node scripts/build-sidecar-handlers.mjs.',
  );
  process.exit(1);
}

const children = [];
let stopping = false;
let temporaryDirectory;
let portFile;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children)
    if (child.exitCode === null) child.kill('SIGTERM');
  await Promise.all(
    children.map(
      (child) =>
        new Promise((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null)
            return resolve();
          const timer = setTimeout(() => {
            child.kill('SIGKILL');
            resolve();
          }, 5000);
          child.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        }),
    ),
  );
  if (portFile) await unlink(portFile).catch(() => {});
  if (temporaryDirectory) await rmdir(temporaryDirectory).catch(() => {});
}
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());

function launch(entry, args, cwd, environment) {
  const child = spawn(process.execPath, [entry, ...args], {
    cwd,
    env: environment,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  children.push(child);
  child.once('error', () => {
    console.error('A local application could not start.');
    void stop(1);
  });
  child.once('exit', (code) => {
    if (!stopping) void stop(code || 1);
  });
  return child;
}

try {
  const environment = { ...loadEnv('development', root, ''), ...process.env };
  const model = await resolveLocalModelConfig(environment);
  // Credentials belong only to these child processes. They are neither saved
  // to .env nor passed on the command line or exposed to the browser.
  const transportToken = randomBytes(32).toString('hex');
  const operatorKey = randomBytes(32).toString('hex');
  temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), 'gods-eye-view-hybrid-'),
  );
  portFile = path.join(temporaryDirectory, 'world-monitor-port');
  const worldMonitorEnvironment = {
    ...loadEnv('development', worldMonitorRoot, ''),
    ...environment,
    LOCAL_API_MODE: 'tauri-sidecar',
    LOCAL_API_CLOUD_FALLBACK: 'false',
    LOCAL_API_RESOURCE_DIR: worldMonitorRoot,
    LOCAL_API_PORT: '0',
    LOCAL_API_PORT_FILE: portFile,
    LOCAL_API_TOKEN: transportToken,
    WORLDMONITOR_VALID_KEYS: operatorKey,
    WORLDMONITOR_API_KEY: operatorKey,
    LLM_PROVIDER: 'generic',
    LLM_API_URL: model.url,
    LLM_API_KEY: model.apiKey,
    LLM_MODEL: model.model,
    // Saved tier overrides must not bypass the selected gateway/model.
    LLM_TOOL_PROVIDER: 'generic',
    LLM_TOOL_MODEL: model.model,
    LLM_REASONING_PROVIDER: 'generic',
    LLM_REASONING_MODEL: model.model,
    LLM_API_AUTH_TYPE: model.provider === 'bifrost' ? 'x-bf-vk' : 'bearer',
  };
  // Legacy direct-provider paths must report unavailable in this profile.
  // These overrides affect only this child, never the operator's saved files.
  for (const key of [
    'OPENAI_API_KEY',
    'OPENROUTER_API_KEY',
    'GROQ_API_KEY',
    'CEREBRAS_API_KEY',
    'ANTHROPIC_API_KEY',
    'GEMINI_API_KEY',
  ]) {
    worldMonitorEnvironment[key] = '';
  }
  const sidecar = launch(
    sidecarEntry,
    [],
    worldMonitorRoot,
    worldMonitorEnvironment,
  );
  let apiBase;
  for (let attempt = 0; attempt < 100 && !stopping; attempt++) {
    if (sidecar.exitCode !== null) break;
    const announced = Number(await readFile(portFile, 'utf8').catch(() => ''));
    if (Number.isInteger(announced) && announced > 0 && announced <= 65535) {
      apiBase = `http://127.0.0.1:${announced}`;
      break;
    }
    await delay(100);
  }
  if (!apiBase || stopping)
    throw new Error('World Monitor did not become ready.');
  const health = await fetch(`${apiBase}/api/local-status`, {
    headers: { 'x-worldmonitor-local-token': transportToken },
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  });
  const status = await health.json();
  if (!health.ok || status.cloudFallback !== false)
    throw new Error('Local backend verification failed.');
  launch(
    path.join(root, 'node_modules/vite/bin/vite.js'),
    ['--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    root,
    {
      ...environment,
      GEV_HYBRID_ENABLED: 'true',
      GEV_LLM_API_KEY: model.apiKey,
      WORLD_MONITOR_API_BASE: apiBase,
      WORLD_MONITOR_LOCAL_TOKEN: transportToken,
      WORLD_MONITOR_API_KEY: operatorKey,
      // These credentials belong to the sidecar just started above. Saved files
      // for a different local service must not override this launch's keys.
      WORLD_MONITOR_LOCAL_TOKEN_FILE: '',
      WORLD_MONITOR_API_KEY_FILE: '',
    },
  );
  console.log(
    `Hybrid starting at http://127.0.0.1:${port}; local agent MCP at /mcp. Stop with Ctrl+C.`,
  );
} catch (error) {
  console.error(
    error?.status === 503
      ? error.message
      : 'Hybrid startup failed. Check the local backend build and configuration.',
  );
  await stop(1);
}
