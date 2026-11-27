#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  LAYER_STATE_TOKEN_RESERVATIONS,
  parseLayerStateTokenReservations,
  validateLayerStateAllocations,
  validateLayerStateRegistry,
} from '../src/data/layerState.js';

const LEDGER_PATH = 'src/data/layerStateTokenReservations.json';

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** Read every permanent assignment from a published Git revision. */
export function readPublishedLayerStateReservations(
  baseRef,
  cwd = process.cwd(),
) {
  const commit = git(
    ['rev-parse', '--verify', '--end-of-options', `${baseRef}^{commit}`],
    cwd,
  );
  const ledgerSpec = `${commit}:${LEDGER_PATH}`;
  let hasLedger = true;
  try {
    git(['cat-file', '-e', ledgerSpec], cwd);
  } catch {
    hasLedger = false;
  }
  if (!hasLedger) {
    throw new Error(
      'Published base has no recognizable layer-state token ledger',
    );
  }
  let rows;
  try {
    rows = JSON.parse(git(['show', ledgerSpec], cwd));
  } catch (error) {
    throw new Error(
      `Cannot read published layer-state token ledger: ${error.message}`,
    );
  }
  return parseLayerStateTokenReservations(rows);
}

export function checkLayerStateTokens(baseRef, cwd = process.cwd()) {
  const base = readPublishedLayerStateReservations(baseRef, cwd);
  validateLayerStateRegistry();
  validateLayerStateAllocations(base, LAYER_STATE_TOKEN_RESERVATIONS);
  return {
    published: Object.keys(base).length,
    added:
      Object.keys(LAYER_STATE_TOKEN_RESERVATIONS).length -
      Object.keys(base).length,
  };
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : '';
if (import.meta.url === invokedPath) {
  const args = process.argv.slice(2);
  const baseRef =
    args[0] === '--base-ref' && args.length === 2 ? args[1] : null;
  if (!baseRef || baseRef.startsWith('-')) {
    console.error('Usage: npm run layer-token:check -- --base-ref origin/main');
    process.exitCode = 1;
  } else {
    try {
      const result = checkLayerStateTokens(baseRef);
      console.log(
        `Layer tokens valid against ${baseRef}: ${result.published} published, ` +
          `${result.added} new.`,
      );
    } catch (error) {
      console.error(`Layer token check failed: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
