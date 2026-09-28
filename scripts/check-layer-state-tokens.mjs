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

// The pre-ledger main revision had exactly the 28 pinned v2 registry entries.
// Accept only that source blob as the one-time bootstrap; any other published
// source without a ledger must fail closed rather than risk losing a token.
const PRE_LEDGER_LAYER_STATE_BLOB = 'e559a4c40191512dcefb83134958a3bfd4a98a69';
// This snapshot belongs to the verified published blob above, not to the PR's
// editable legacy map. Otherwise a candidate could redefine both its ledger
// and its comparison baseline before the first ledger reaches main.
export const PRE_LEDGER_LAYER_STATE_TOKENS = Object.freeze({
  'ais-live-vessels': 'a',
  'alpr-cameras': 'p',
  'bhote-koshi-2026': 'h',
  'bhote-koshi-locator': 'z',
  bikeshare: 'b',
  cctv: 'c',
  directions: 'n',
  earthquakes: 'e',
  'fire-perimeters': '2',
  flights: 'f',
  'local-dams': 'q',
  'local-datacenters': 'd',
  'local-firms': 'w',
  military: 'm',
  'military-awareness': 'g',
  'military-installations': 'i',
  radio: 'r',
  'recent-imagery': '1',
  'rocket-launches': 'x',
  satellites: 's',
  'telegeography-submarine-cables': 'u',
  traffic: 't',
  transit: 'j',
  'weather-cyclones': 'y',
  'weather-lightning': 'l',
  'weather-radar': 'v',
  'weather-satellite': 'o',
  wind: 'k',
});
const LEDGER_PATH = 'src/data/layerStateTokenReservations.json';
const SOURCE_PATH = 'src/data/layerState.js';

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
    const sourceBlob = git(['rev-parse', `${commit}:${SOURCE_PATH}`], cwd);
    if (sourceBlob !== PRE_LEDGER_LAYER_STATE_BLOB) {
      throw new Error(
        'Published base has no recognizable layer-state token ledger',
      );
    }
    return PRE_LEDGER_LAYER_STATE_TOKENS;
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
