import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  LEGACY_LAYER_STATE_TOKENS,
  LAYER_STATE_TOKEN_ALPHABET,
  LAYER_STATE_TOKEN_RESERVATIONS,
  nextLayerStateToken,
  parseLayerStateTokenReservations,
  validateLayerStateAllocations,
} from './layerState.js';
import {
  PRE_LEDGER_LAYER_STATE_TOKENS,
  checkLayerStateTokens,
  readPublishedLayerStateReservations,
} from '../../scripts/check-layer-state-tokens.mjs';

const LEDGER_PATH = 'src/data/layerStateTokenReservations.json';
const SOURCE_PATH = 'src/data/layerState.js';
const CHECKER_PATH = fileURLToPath(
  new URL('../../scripts/check-layer-state-tokens.mjs', import.meta.url),
);
const reservationRows = JSON.parse(
  readFileSync(
    new URL('./layerStateTokenReservations.json', import.meta.url),
    'utf8',
  ),
);

test('pre-ledger published ownership is independent of the candidate mapping', () => {
  assert.notStrictEqual(
    PRE_LEDGER_LAYER_STATE_TOKENS,
    LEGACY_LAYER_STATE_TOKENS,
  );
  assert.deepEqual(PRE_LEDGER_LAYER_STATE_TOKENS, LEGACY_LAYER_STATE_TOKENS);
  assert.equal(Object.keys(PRE_LEDGER_LAYER_STATE_TOKENS).length, 28);
  assert.equal(PRE_LEDGER_LAYER_STATE_TOKENS['recent-imagery'], '1');
  assert.equal(PRE_LEDGER_LAYER_STATE_TOKENS['fire-perimeters'], '2');
  assert.throws(
    () =>
      validateLayerStateAllocations(PRE_LEDGER_LAYER_STATE_TOKENS, {
        ...LAYER_STATE_TOKEN_RESERVATIONS,
        flights: '00',
      }),
    /Published layer-state token changed or removed: flights/,
  );
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function withPublishedBase(
  { rows, source = 'export const changed = true;\n' },
  check,
) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'gev-layer-token-ledger-'));
  try {
    git(cwd, 'init', '-q');
    mkdirSync(path.join(cwd, 'src/data'), { recursive: true });
    writeFileSync(path.join(cwd, SOURCE_PATH), source);
    if (rows !== undefined) {
      writeFileSync(path.join(cwd, LEDGER_PATH), JSON.stringify(rows));
    }
    git(cwd, 'add', 'src/data');
    git(
      cwd,
      '-c',
      'user.name=Layer Token Test',
      '-c',
      'user.email=layer-token-test@example.invalid',
      'commit',
      '-q',
      '-m',
      'published base',
    );
    check(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

test('reservation ledger is complete, pinned, and rejects duplicate or malformed rows', () => {
  assert.deepEqual(
    { ...parseLayerStateTokenReservations(reservationRows) },
    { ...LAYER_STATE_TOKEN_RESERVATIONS },
  );
  assert.equal(Object.keys(LAYER_STATE_TOKEN_RESERVATIONS).length, 28);
  assert.deepEqual(
    { ...LAYER_STATE_TOKEN_RESERVATIONS },
    { ...LEGACY_LAYER_STATE_TOKENS },
  );
  assert.throws(
    () => parseLayerStateTokenReservations(reservationRows.slice(1)),
    /Missing or changed legacy/,
  );
  assert.throws(
    () =>
      parseLayerStateTokenReservations([
        ...reservationRows,
        reservationRows[0],
      ]),
    /Duplicate layer-state token reservation id/,
  );
  assert.throws(
    () =>
      parseLayerStateTokenReservations([...reservationRows, ['future', 'a']]),
    /Duplicate layer-state token reservation/,
  );
  assert.equal(
    parseLayerStateTokenReservations([...reservationRows, ['future', '0']])
      .future,
    '0',
  );
  assert.throws(
    () =>
      parseLayerStateTokenReservations([
        ...reservationRows.filter(([id]) => id !== 'transit'),
        ['future', 'j'],
      ]),
    /Legacy layer-state token is immutable/,
  );
  assert.throws(
    () => parseLayerStateTokenReservations([...reservationRows, ['future']]),
    /Invalid layer-state token ledger row/,
  );
});

test('published retired digits and competing PRs advance the merge-time allocation', () => {
  withPublishedBase(
    { rows: [...reservationRows, ['retired-layer', '0']] },
    (cwd) => {
      const published = readPublishedLayerStateReservations('HEAD', cwd);
      assert.equal(nextLayerStateToken(published), '3');
      assert.equal(
        validateLayerStateAllocations(published, {
          ...published,
          newcomer: '3',
        }),
        true,
      );
      assert.throws(
        () =>
          validateLayerStateAllocations(published, {
            ...published,
            competing: '0',
          }),
        /next free token 3/,
      );
      assert.throws(
        () =>
          validateLayerStateAllocations(published, {
            ...LAYER_STATE_TOKEN_RESERVATIONS,
            newcomer: '0',
          }),
        /changed or removed: retired-layer/,
      );
    },
  );
});

test('allocation batches cross the last digit and base-36 pair boundaries in order', () => {
  const digitRows = [...'03456789'].map((digit) => [`retired-${digit}`, digit]);
  const allDigits = parseLayerStateTokenReservations([
    ...reservationRows,
    ...digitRows,
  ]);
  const beforeNine = { ...allDigits };
  delete beforeNine['retired-9'];
  assert.equal(
    validateLayerStateAllocations(beforeNine, {
      ...beforeNine,
      pair: '00',
      lastDigit: '9',
    }),
    true,
  );
  const baseBefore0a = {
    ...allDigits,
    ...Object.fromEntries(
      [...'012345678'].map((second) => [`retired-0${second}`, `0${second}`]),
    ),
  };
  assert.equal(nextLayerStateToken(baseBefore0a), '09');
  assert.equal(
    validateLayerStateAllocations(baseBefore0a, {
      ...baseBefore0a,
      after: '0a',
      before: '09',
    }),
    true,
  );
  const baseBefore10 = {
    ...allDigits,
    ...Object.fromEntries(
      [...LAYER_STATE_TOKEN_ALPHABET]
        .slice(0, -1)
        .map((second) => [`retired-0${second}`, `0${second}`]),
    ),
  };
  assert.equal(nextLayerStateToken(baseBefore10), '0z');
  assert.equal(
    validateLayerStateAllocations(baseBefore10, {
      ...baseBefore10,
      after: '10',
      before: '0z',
    }),
    true,
  );
});

test('checker reads a complete future base ledger and rejects retired-token reuse', () => {
  withPublishedBase(
    {
      rows: [...reservationRows, ['retired-layer', '00']],
      source:
        'export const LAYER_STATE_TOKEN_RESERVATIONS = Object.freeze({ ["retired-layer"]: "00" });\n',
    },
    (cwd) => {
      const published = readPublishedLayerStateReservations('HEAD', cwd);
      assert.equal(Object.keys(published).length, 29);
      assert.equal(published['retired-layer'], '00');
      assert.throws(
        () =>
          validateLayerStateAllocations(published, {
            ...LAYER_STATE_TOKEN_RESERVATIONS,
            newcomer: '00',
          }),
        /changed or removed/,
      );
      assert.throws(
        () => checkLayerStateTokens('HEAD', cwd),
        /changed or removed/,
      );
      const cli = spawnSync(
        process.execPath,
        [CHECKER_PATH, '--base-ref', 'HEAD'],
        {
          cwd,
          encoding: 'utf8',
        },
      );
      assert.equal(cli.status, 1);
      assert.match(cli.stderr, /changed or removed/);
    },
  );
});

test('checker fails closed on unknown or malformed published ledgers', () => {
  withPublishedBase({}, (cwd) => {
    assert.throws(
      () => readPublishedLayerStateReservations('HEAD', cwd),
      /no recognizable layer-state token ledger/,
    );
  });
  withPublishedBase({ rows: [...reservationRows, ['future', 'a']] }, (cwd) => {
    assert.throws(
      () => readPublishedLayerStateReservations('HEAD', cwd),
      /Duplicate layer-state token reservation/,
    );
  });
});
