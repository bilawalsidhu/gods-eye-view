import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import parityEvidenceReporter, {
  ACCEPTANCE_PATH,
  EVIDENCE_PATH,
  INTERFACES_PATH,
  PARITY_PATH,
  RESULT,
  evaluateAll,
  indexTestReport,
  judgeEntry,
  loadAcceptance,
  parseEvidence,
  parseInterfaces,
  parseParity,
  resultFor,
  serializeTsv,
  splitTestRef,
  staleRows,
  withResults,
} from './parity-evidence.mjs';

const PARITY_HEADER =
  'прежний_файл\tстрока\tраздел\tсценарий_как_был_описан\tназначение\tправило';
const INTERFACES_HEADER =
  'вид\tидентификатор\tцель/зависимости\tпакет_работ\tпроверка';
const EVIDENCE_HEADER = 'ключ\tвид\tссылка\tчто_проверяет';

function parityText(rows) {
  return (
    [PARITY_HEADER, ...rows.map((row) => row.join('\t'))].join('\n') + '\n'
  );
}

function context({ outcomes = {}, scenarios = {} } = {}) {
  return {
    testOutcomes: new Map(Object.entries(outcomes)),
    acceptance: {
      commit: 'd472208f2d96',
      scenarios: new Map(Object.entries(scenarios)),
    },
  };
}

async function collect(events) {
  async function* source() {
    yield* events;
  }
  let text = '';
  for await (const chunk of parityEvidenceReporter(source())) text += chunk;
  return text;
}

test('a unit reference splits at the first separator after the test file', () => {
  assert.deepEqual(splitTestRef('src/a.test.mjs::name :: with colons'), {
    file: 'src/a.test.mjs',
    name: 'name :: with colons',
  });
  assert.equal(splitTestRef('src/a.js::name'), null);
  assert.equal(splitTestRef('src/a.test.mjs::'), null);
  assert.equal(splitTestRef('no separator'), null);
});

test('the reporter names nested tests by leaf and by describe path; a failure wins', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'parity-reporter-'));
  try {
    const file = path.join(root, 'src', 'a.test.mjs');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '');
    const event = (type, name, nesting, extra = {}) => ({
      type,
      data: { file, name, nesting, ...extra },
    });
    const text = await collect([
      event('test:start', 'suite', 0),
      event('test:start', 'inner', 1),
      event('test:pass', 'inner', 1),
      event('test:pass', 'suite', 0),
      event('test:start', 'skipped', 0),
      event('test:pass', 'skipped', 0, { skip: true }),
      event('test:start', 'twice', 0),
      event('test:fail', 'twice', 0),
      event('test:start', 'twice', 0),
      event('test:pass', 'twice', 0),
      { type: 'test:diagnostic', data: { message: 'ignored' } },
    ]);
    const outcomes = indexTestReport(text, root);
    assert.equal(outcomes.get('src/a.test.mjs::inner'), 'pass');
    assert.equal(outcomes.get('src/a.test.mjs::suite > inner'), 'pass');
    assert.equal(outcomes.get('src/a.test.mjs::suite'), 'pass');
    assert.equal(outcomes.get('src/a.test.mjs::skipped'), 'skip');
    assert.equal(outcomes.get('src/a.test.mjs::twice'), 'fail');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('evidence lines are judged against test outcomes and the acceptance report', () => {
  const ctx = context({
    outcomes: {
      'src/a.test.mjs::ok': 'pass',
      'src/a.test.mjs::bad': 'fail',
      'src/a.test.mjs::skip': 'skip',
    },
    scenarios: {
      good: { status: 'pass', logMatches: true },
      edited: { status: 'pass', logMatches: false },
      broken: { status: 'fail', logMatches: true },
    },
  });
  const judge = (kind, ref) => judgeEntry({ kind, ref }, ctx).state;
  assert.equal(judge('unit', 'src/a.test.mjs::ok'), 'ok');
  assert.equal(judge('unit', 'src/a.test.mjs::bad'), 'failed');
  assert.equal(judge('unit', 'src/a.test.mjs::skip'), 'stale');
  assert.equal(judge('unit', 'src/a.test.mjs::missing'), 'stale');
  assert.equal(judge('fail', 'src/a.test.mjs::ok'), 'confirmed-fail');
  assert.equal(judge('qa', 'good'), 'ok');
  assert.equal(judge('qa', 'edited'), 'stale');
  assert.equal(judge('qa', 'broken'), 'failed');
  assert.equal(judge('qa', 'absent'), 'stale');
  assert.equal(judge('платный сервис', 'Bing'), 'paid');
  assert.equal(
    judge('parity', 'layers-a.md:25'),
    'stale',
    'a parity link only works for interfaces rows',
  );
  assert.equal(judge('maybe', 'x'), 'stale');
});

test('a paid service wins, then a failure, then anything unverified', () => {
  assert.equal(resultFor(['ok', 'paid', 'failed']), RESULT.paid);
  assert.equal(resultFor(['ok', 'confirmed-fail']), RESULT.fail);
  assert.equal(resultFor(['ok', 'failed', 'stale']), RESULT.fail);
  assert.equal(resultFor(['ok', 'stale']), RESULT.unverified);
  assert.equal(resultFor(['ok', 'unverified']), RESULT.unverified);
  assert.equal(resultFor([]), RESULT.unverified);
  assert.equal(resultFor(['ok', 'ok']), RESULT.pass);
});

test('the acceptance log must still hash to the recorded SHA-256', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'parity-acceptance-'));
  try {
    const report = path.join(root, ACCEPTANCE_PATH);
    mkdirSync(path.dirname(report), { recursive: true });
    writeFileSync(path.join(path.dirname(report), 'a.log'), 'PASS\n');
    writeFileSync(path.join(path.dirname(report), 'b.log'), 'edited\n');
    const sha = createHash('sha256').update('PASS\n').digest('hex');
    writeFileSync(
      report,
      JSON.stringify({
        commit: 'abc',
        scenarios: [
          { label: 'a', status: 'pass', log: 'a.log', logSha256: sha },
          { label: 'b', status: 'pass', log: 'b.log', logSha256: sha },
          { label: 'c', status: 'pass', log: 'c.log', logSha256: sha },
        ],
      }),
    );
    const { commit, scenarios } = loadAcceptance(root);
    assert.equal(commit, 'abc');
    assert.equal(scenarios.get('a').logMatches, true);
    assert.equal(scenarios.get('b').logMatches, false);
    assert.equal(scenarios.get('c').logMatches, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('results fill both registries, interfaces rows share a parity result, and staleness is reported', () => {
  const parity = parseParity(
    parityText([
      ['a.md', '1', 's', '"""quoted"" text"', 'TOOLS', 'r'],
      ['a.md', '2', 's', 'paid', 'MAP', 'r'],
      ['a.md', '3', 's', 'nothing', 'UI', 'r'],
    ]),
  );
  const interfaces = parseInterfaces(
    [
      INTERFACES_HEADER,
      'export\t./x\t./src/x.js\tLAYER\tcheck',
      'tool\tget_x\tx\tTOOLS\tcheck',
      'action\tdo_x\tx\tNAV\tcheck',
    ].join('\n') + '\n',
  );
  const entries = parseEvidence(
    [
      EVIDENCE_HEADER,
      'a.md:1\tunit\tsrc/a.test.mjs::ok\tпроверяет',
      'a.md:1\tqa\tgood\tсценарий',
      'a.md:2\tunit\tsrc/a.test.mjs::ok\tпроверяет',
      'a.md:2\tплатный сервис\tGoogle 3D Tiles\tключ',
      'a.md:1\tunit\tsrc/a.test.mjs::ok\tповтор',
      'a.md:9\tunit\tsrc/a.test.mjs::ok\tнет строки',
      'interfaces.tsv:tool:get_x\tparity\ta.md:1\tта же строка',
      'interfaces.tsv:action:do_x\tparity\ta.md:3\tта же строка',
    ].join('\n') + '\n',
  );
  const ctx = context({
    outcomes: { 'src/a.test.mjs::ok': 'pass' },
    scenarios: { good: { status: 'pass', logMatches: true } },
  });
  const evaluated = evaluateAll(parity, interfaces, entries, ctx);
  assert.deepEqual(evaluated.parity.get('a.md:1'), {
    result: RESULT.pass,
    evidence: 'unit src/a.test.mjs::ok; qa good, прогон d472208f',
  });
  assert.equal(evaluated.parity.get('a.md:2').result, RESULT.paid);
  assert.deepEqual(evaluated.parity.get('a.md:3'), {
    result: RESULT.unverified,
    evidence: '',
  });
  assert.equal(
    evaluated.interfaces.get('interfaces.tsv:tool:get_x').result,
    RESULT.pass,
  );
  assert.equal(
    evaluated.interfaces.get('interfaces.tsv:tool:get_x').evidence,
    'parity a.md:1 (pass)',
  );
  assert.equal(
    evaluated.interfaces.get('interfaces.tsv:action:do_x').result,
    RESULT.unverified,
  );
  assert.equal(evaluated.problems.length, 2);
  assert.match(evaluated.problems.join('\n'), /нет строки a\.md:9/);
  assert.match(evaluated.problems.join('\n'), /повтор a\.md:1/);

  assert.deepEqual(staleRows(parity, evaluated.parity), [
    'a.md:1',
    'a.md:2',
    'a.md:3',
  ]);
  const written = parseParity(
    serializeTsv(withResults(parity, evaluated.parity)),
  );
  assert.deepEqual(staleRows(written, evaluated.parity), []);
  assert.equal(
    written.rows[0][3],
    '"""quoted"" text"',
    'quoting is kept as written',
  );
  assert.deepEqual(written.rows[2].slice(6), [RESULT.unverified, '']);

  const writtenInterfaces = parseInterfaces(
    serializeTsv(withResults(interfaces, evaluated.interfaces)),
  );
  assert.deepEqual(
    writtenInterfaces.rows[0].slice(5),
    ['', ''],
    'exports keep empty cells',
  );
  assert.deepEqual(writtenInterfaces.rows[1].slice(5), [
    RESULT.pass,
    'parity a.md:1 (pass)',
  ]);
  assert.deepEqual(staleRows(writtenInterfaces, evaluated.interfaces), []);
  writtenInterfaces.rows[1][5] = RESULT.fail;
  assert.deepEqual(staleRows(writtenInterfaces, evaluated.interfaces), [
    'interfaces.tsv:tool:get_x',
  ]);
});

test('the checked-in evidence names existing registry rows, kinds and test files', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const parity = parseParity(
    readFileSync(path.join(root, PARITY_PATH), 'utf8'),
  );
  const interfaces = parseInterfaces(
    readFileSync(path.join(root, INTERFACES_PATH), 'utf8'),
  );
  const entries = parseEvidence(
    readFileSync(path.join(root, EVIDENCE_PATH), 'utf8'),
  );
  const keys = new Set([
    ...parity.rows.map(parity.keyOf),
    ...interfaces.rows.map(interfaces.keyOf).filter(Boolean),
  ]);
  const kinds = new Set(['unit', 'qa', 'fail', 'платный сервис', 'parity']);
  for (const entry of entries) {
    assert.ok(
      keys.has(entry.key),
      `line ${entry.line}: unknown key ${entry.key}`,
    );
    assert.ok(
      kinds.has(entry.kind),
      `line ${entry.line}: unknown kind ${entry.kind}`,
    );
    assert.ok(
      entry.note,
      `line ${entry.line}: what the evidence checks is empty`,
    );
    if (entry.kind === 'unit' || entry.kind === 'fail') {
      const ref = splitTestRef(entry.ref);
      assert.ok(ref, `line ${entry.line}: ${entry.ref}`);
      assert.ok(
        existsSync(path.join(root, ref.file)),
        `line ${entry.line}: ${ref.file}`,
      );
    }
  }
});
