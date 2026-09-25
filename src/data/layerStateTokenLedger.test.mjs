import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
const CODEC_SOURCE_PATH = fileURLToPath(
  new URL('./layerState.js', import.meta.url),
);
const CHECKER_PATH = fileURLToPath(
  new URL('../../scripts/check-layer-state-tokens.mjs', import.meta.url),
);
const NEXT_PATH = fileURLToPath(
  new URL('../../scripts/next-layer-state-token.mjs', import.meta.url),
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

function writeCodecFixture(cwd, rows, entries) {
  const source = readFileSync(CODEC_SOURCE_PATH, 'utf8');
  const registryEnd = ']);\n\nexport const REGISTERED_LAYER_IDS';
  assert.equal(source.split(registryEnd).length, 2);
  const additions = entries
    .map(
      ({ id, token }) =>
        `  Object.freeze({ id: '${id}', token: '${token}', disposition: 'enabled-only' }),`,
    )
    .join('\n');
  mkdirSync(path.join(cwd, 'src/data'), { recursive: true });
  writeFileSync(path.join(cwd, 'package.json'), '{"type":"module"}');
  writeFileSync(
    path.join(cwd, SOURCE_PATH),
    source.replace(registryEnd, `${additions}\n${registryEnd}`),
  );
  writeFileSync(path.join(cwd, LEDGER_PATH), JSON.stringify(rows));
  return path.join(cwd, SOURCE_PATH);
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

test('PR B manually replaces provisional 0 with 3 after PR A publishes 0', () => {
  withPublishedBase({ rows: [...reservationRows, ['pr-a', '0']] }, (cwd) => {
    mkdirSync(path.join(cwd, 'scripts'));
    const fixtureChecker = path.join(
      cwd,
      'scripts/check-layer-state-tokens.mjs',
    );
    writeFileSync(fixtureChecker, readFileSync(CHECKER_PATH, 'utf8'));
    const fixtureNext = path.join(cwd, 'scripts/next-layer-state-token.mjs');
    writeFileSync(fixtureNext, readFileSync(NEXT_PATH, 'utf8'));
    const runCheck = () =>
      spawnSync(
        process.execPath,
        [realpathSync(fixtureChecker), '--base-ref', 'HEAD'],
        {
          cwd,
          encoding: 'utf8',
        },
      );

    writeCodecFixture(
      cwd,
      [...reservationRows, ['pr-b', '0']],
      [{ id: 'pr-b', token: '0' }],
    );
    const beforeRebase = runCheck();
    assert.equal(beforeRebase.status, 1);
    assert.match(beforeRebase.stderr, /changed or removed: pr-a/);

    writeCodecFixture(
      cwd,
      [...reservationRows, ['pr-a', '0'], ['pr-b', '0']],
      [
        { id: 'pr-a', token: '0' },
        { id: 'pr-b', token: '0' },
      ],
    );
    const staleRebase = runCheck();
    assert.equal(staleRebase.status, 1);
    assert.match(staleRebase.stderr, /Duplicate layer-state token reservation/);

    const published = readPublishedLayerStateReservations('HEAD', cwd);
    assert.equal(nextLayerStateToken(published), '3');
    const validBaselineRows = [...reservationRows, ['pr-a', '0']];
    writeCodecFixture(cwd, validBaselineRows, [{ id: 'pr-a', token: '0' }]);
    const helper = spawnSync(
      process.execPath,
      [realpathSync(fixtureNext), 'pr-b'],
      { cwd, encoding: 'utf8' },
    );
    assert.equal(helper.status, 0, helper.stderr);
    assert.match(helper.stdout, /pr-b: 3/);
    assert.deepEqual(
      JSON.parse(readFileSync(path.join(cwd, LEDGER_PATH), 'utf8')),
      validBaselineRows,
      'the helper reports a token without rewriting the ledger',
    );
    writeCodecFixture(
      cwd,
      [...reservationRows, ['pr-a', '0'], ['pr-b', '3']],
      [
        { id: 'pr-a', token: '0' },
        { id: 'pr-b', token: '3' },
      ],
    );
    const corrected = runCheck();
    assert.equal(corrected.status, 0, corrected.stderr);
    assert.match(corrected.stdout, /29 published, 1 new/);
  });
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

test('an isolated valid two-character fixture round-trips an l field beyond the old 64-character cap', async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'gev-layer-token-width-'));
  try {
    const priorDigits = [...'03456789'].map((digit) => [
      `qa-prior-digit-${digit}`,
      digit,
    ]);
    const fixtureLayers = ['00', '01', '02', '03'].map((token) => ({
      id: `qa-layer-${token}`,
      token,
    }));
    const fixtureRows = [
      ...reservationRows,
      ...priorDigits,
      ...fixtureLayers.map(({ id, token }) => [id, token]),
    ];
    const fixtureModule = writeCodecFixture(cwd, fixtureRows, fixtureLayers);
    const codec = await import(pathToFileURL(fixtureModule));
    assert.equal(codec.validateLayerStateRegistry(), true);
    assert.equal(
      nextLayerStateToken(
        parseLayerStateTokenReservations([...reservationRows, ...priorDigits]),
      ),
      '00',
    );
    assert.equal(
      validateLayerStateAllocations(
        LAYER_STATE_TOKEN_RESERVATIONS,
        codec.LAYER_STATE_TOKEN_RESERVATIONS,
      ),
      true,
    );

    const expectedLayerIds = codec.REGISTERED_LAYER_IDS;
    const state = codec.normalizeLayerState({
      enabledLayerIds: expectedLayerIds,
    });
    const params = new URLSearchParams([['v', '2']]);
    codec.encodeLayerStateParams(params, state);
    assert.ok(params.get('l').length > 64, 'fixture must cross the old cap');
    assert.equal(params.get('l').length, 67);
    const restored = codec.decodeLayerStateParams(params);
    assert.deepEqual(restored?.enabledLayerIds, expectedLayerIds);
    assert.deepEqual(restored?.options, state.options);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
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
