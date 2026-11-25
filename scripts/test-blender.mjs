#!/usr/bin/env node
/**
 * test-blender.mjs: run the tests that start the real Blender, which
 * `npm test` skips (headless Blender crashes on some machines). Needs
 * Blender 5.2+ (`$BLENDER`, else `blender` on the PATH).
 *
 * Run:  npm run test:blender
 */
import { spawnSync } from 'node:child_process';

const FILES = ['src/aircraftViewsUnknownSubject.test.mjs'];
const run = spawnSync(process.execPath, ['--test', ...FILES], {
  stdio: 'inherit',
  env: { ...process.env, GEV_BLENDER_TESTS: '1' },
});
process.exit(run.status ?? 1);
