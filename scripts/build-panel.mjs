#!/usr/bin/env node
/**
 * Build the MCP Apps panel: the app under dist/panel, served at /panel/.
 * See build/panel.js.
 */

import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import standaloneConfig from '../server/standalone/vite.config.js';
import {
  PANEL_BASE,
  PANEL_OUT_DIR,
  PANEL_WORKER_FILES,
  PANEL_WORKER_PRELUDE_PATH,
  panelBuildConfig,
  workerFilesPrelude,
} from '../build/panel.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const outDir = join(root, PANEL_OUT_DIR);

const config = standaloneConfig({ command: 'build', mode: 'production' });
await build({
  configFile: false,
  root,
  ...panelBuildConfig(config),
});

// Cesium's plugin copies its files under the base path inside outDir.
const nested = join(outDir, PANEL_BASE, 'cesium');
await rm(join(outDir, 'cesium'), { recursive: true, force: true });
await rename(nested, join(outDir, 'cesium'));
await rm(join(outDir, PANEL_BASE.split('/')[1]), { recursive: true });

// Cesium's workers load these files themselves; embed them in a prelude the
// panel runs ahead of Cesium's workers script.
const files = {};
for (const name of PANEL_WORKER_FILES)
  files[name] = await readFile(join(outDir, 'cesium', name), 'utf8');
await writeFile(
  join(outDir, PANEL_WORKER_PRELUDE_PATH),
  workerFilesPrelude(files),
);
console.log(`Panel build written to ${PANEL_OUT_DIR}`);
