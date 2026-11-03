// Fill the result and evidence columns of docs/migration/planet-separation/parity.tsv
// and of the action, tool and basemap rows of interfaces.tsv from the hand-kept
// parity-evidence.tsv.
//
// parity-evidence.tsv has one line per (row, evidence):
//   ключ           a parity row as <прежний_файл>:<строка>, e.g. layers-a.md:25, or an
//                  interfaces row as interfaces.tsv:<вид>:<идентификатор>
//   вид            unit | qa | fail | платный сервис | parity
//   ссылка         unit/fail: <test file>::<test name>; qa: acceptance scenario label;
//                  платный сервис: the service; parity: the parity key whose result an
//                  interfaces row shares
//   что_проверяет  what the evidence asserts, for the reader
//
// A unit or fail line is valid when the named test runs and passes now (the
// referenced files are run with node:test and this module as the reporter). A
// qa line is valid when acceptance-run/acceptance.json lists the scenario as
// passed and the log file still has the recorded SHA-256. A fail line cites a
// test that asserts the obligation does not hold on Navara.
//
// Result per row: платный сервис when any line says so; fail when a fail line is
// valid or a cited test or scenario fails; не проверено when a line is stale, a
// linked parity row is unverified or the row has no evidence; pass otherwise.
//
//   node scripts/parity-evidence.mjs           print counts by group and result
//   node scripts/parity-evidence.mjs --write   fill результат and доказательство in both registries
//   node scripts/parity-evidence.mjs --check   exit 1 on stale evidence, unknown keys or
//                                              results that differ from the evidence
//
// The default export is the node:test reporter used for the unit run.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { UNIT_TEST_NODE_FLAGS } from './run-unit-tests.mjs';

export const REGISTRY_DIR = 'docs/migration/planet-separation';
export const PARITY_PATH = `${REGISTRY_DIR}/parity.tsv`;
export const EVIDENCE_PATH = `${REGISTRY_DIR}/parity-evidence.tsv`;
export const INTERFACES_PATH = `${REGISTRY_DIR}/interfaces.tsv`;
export const ACCEPTANCE_PATH = `${REGISTRY_DIR}/acceptance-run/acceptance.json`;
/** interfaces.tsv kinds that get a result; exports and boundaries keep empty cells. */
export const INTERFACE_RESULT_KINDS = Object.freeze([
  'action',
  'tool',
  'basemap',
]);

export const RESULT = Object.freeze({
  pass: 'pass',
  fail: 'fail',
  unverified: 'не проверено',
  paid: 'платный сервис',
});
export const KIND = Object.freeze({
  unit: 'unit',
  qa: 'qa',
  fail: 'fail',
  paid: 'платный сервис',
  parity: 'parity',
});
export const PARITY_BASE_HEADER = [
  'прежний_файл',
  'строка',
  'раздел',
  'сценарий_как_был_описан',
  'назначение',
  'правило',
];
export const INTERFACES_BASE_HEADER = [
  'вид',
  'идентификатор',
  'цель/зависимости',
  'пакет_работ',
  'проверка',
];
export const RESULT_COLUMNS = ['результат', 'доказательство'];
export const EVIDENCE_HEADER = ['ключ', 'вид', 'ссылка', 'что_проверяет'];
const TEST_NAME_SEPARATOR = '::';
const REPORT_PREFIX = 'parity-evidence\t';

/** Split a TSV file into header and raw fields; quoting is left untouched. */
export function parseTsv(text) {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const header = (lines.shift() ?? '').split('\t');
  return { header, rows: lines.map((line) => line.split('\t')) };
}

export function serializeTsv({ header, rows }) {
  return [header, ...rows].map((fields) => fields.join('\t')).join('\n') + '\n';
}

export function parityKey(fields) {
  return `${fields[0]}:${fields[1]}`;
}

export function interfaceKey(fields) {
  return `interfaces.tsv:${fields[0]}:${fields[1]}`;
}

/** Rows of a registry whose two result columns are optional on input. */
function parseRegistry(text, baseHeader, name) {
  const { header, rows } = parseTsv(text);
  const base = header.slice(0, baseHeader.length);
  const extra = header.slice(baseHeader.length);
  if (
    base.join('\t') !== baseHeader.join('\t') ||
    (extra.length && extra.join('\t') !== RESULT_COLUMNS.join('\t'))
  ) {
    throw new Error(`Unexpected ${name} header: ${header.join(' | ')}`);
  }
  rows.forEach((fields, index) => {
    if (fields.length !== header.length) {
      throw new Error(
        `${name} line ${index + 2}: expected ${header.length} fields`,
      );
    }
  });
  return {
    header,
    rows,
    baseLength: baseHeader.length,
    hasResults: extra.length > 0,
  };
}

export function parseParity(text) {
  return {
    ...parseRegistry(text, PARITY_BASE_HEADER, 'parity.tsv'),
    keyOf: parityKey,
  };
}

export function parseInterfaces(text) {
  return {
    ...parseRegistry(text, INTERFACES_BASE_HEADER, 'interfaces.tsv'),
    keyOf: (fields) =>
      INTERFACE_RESULT_KINDS.includes(fields[0]) ? interfaceKey(fields) : null,
  };
}

export function parseEvidence(text) {
  const { header, rows } = parseTsv(text);
  if (header.join('\t') !== EVIDENCE_HEADER.join('\t')) {
    throw new Error(
      `Unexpected parity-evidence.tsv header: ${header.join(' | ')}`,
    );
  }
  return rows.map((fields, index) => {
    if (fields.length !== EVIDENCE_HEADER.length) {
      throw new Error(
        `parity-evidence.tsv line ${index + 2}: expected 4 fields`,
      );
    }
    const [key, kind, ref, note] = fields;
    return { line: index + 2, key, kind, ref, note };
  });
}

/** `<file>::<test name>`; the name may itself contain the separator. */
export function splitTestRef(ref) {
  const at = ref.indexOf(TEST_NAME_SEPARATOR);
  if (at <= 0) return null;
  const file = ref.slice(0, at);
  const name = ref.slice(at + TEST_NAME_SEPARATOR.length);
  if (!/\.test\.mjs$/.test(file) || !name) return null;
  return { file, name };
}

/**
 * node:test reporter: one line per finished test with its file, nesting path
 * and outcome. Events of one file arrive in order, so a stack of started
 * names per file gives the describe path.
 */
export default async function* parityEvidenceReporter(source) {
  const stacks = new Map();
  for await (const event of source) {
    const data = event.data || {};
    if (!data.file || typeof data.name !== 'string') continue;
    const stack = stacks.get(data.file) || [];
    stacks.set(data.file, stack);
    if (event.type === 'test:start') {
      stack.length = data.nesting;
      stack[data.nesting] = data.name;
    } else if (event.type === 'test:pass' || event.type === 'test:fail') {
      const outcome =
        event.type === 'test:fail'
          ? 'fail'
          : data.skip || data.todo
            ? 'skip'
            : 'pass';
      const names = [...stack.slice(0, data.nesting), data.name];
      yield `${REPORT_PREFIX}${JSON.stringify({ file: data.file, path: names, outcome })}\n`;
    }
  }
}

/** Index reporter lines by `<file>::<leaf name>` and `<file>::<a > b > leaf>`. */
export function indexTestReport(text, root) {
  const realRoot = realpathSync(root);
  const outcomes = new Map();
  const record = (key, outcome) => {
    const previous = outcomes.get(key);
    // A failure anywhere under that name wins; a pass beats a skip.
    if (previous === 'fail' || (previous === 'pass' && outcome === 'skip'))
      return;
    outcomes.set(key, outcome);
  };
  for (const line of text.split('\n')) {
    if (!line.startsWith(REPORT_PREFIX)) continue;
    const {
      file,
      path: names,
      outcome,
    } = JSON.parse(line.slice(REPORT_PREFIX.length));
    let absolute = file.startsWith('file:') ? fileURLToPath(file) : file;
    try {
      absolute = realpathSync(absolute);
    } catch {
      // keep the reported path
    }
    const relative = path
      .relative(realRoot, absolute)
      .split(path.sep)
      .join('/');
    record(`${relative}${TEST_NAME_SEPARATOR}${names.at(-1)}`, outcome);
    if (names.length > 1) {
      record(`${relative}${TEST_NAME_SEPARATOR}${names.join(' > ')}`, outcome);
    }
  }
  return outcomes;
}

/** Run the cited test files once, keyless, and index every test outcome. */
export function runCitedTests(files, root) {
  const existing = [...new Set(files)]
    .filter((file) => existsSync(path.join(root, file)))
    .sort();
  if (!existing.length) return new Map();
  const dir = mkdtempSync(path.join(tmpdir(), 'parity-evidence-'));
  const destination = path.join(dir, 'report.txt');
  try {
    const result = spawnSync(
      process.execPath,
      [
        ...UNIT_TEST_NODE_FLAGS,
        '--test',
        `--test-reporter=${fileURLToPath(import.meta.url)}`,
        `--test-reporter-destination=${destination}`,
        ...existing,
      ],
      {
        cwd: root,
        env: { ...process.env, GOOGLE_MAPS_API_KEY: '', CESIUM_ION_TOKEN: '' },
        stdio: ['ignore', 'ignore', 'inherit'],
      },
    );
    if (result.error) throw result.error;
    return indexTestReport(
      existsSync(destination) ? readFileSync(destination, 'utf8') : '',
      root,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Acceptance scenarios by label, with whether the recorded log still matches. */
export function loadAcceptance(root) {
  const file = path.join(root, ACCEPTANCE_PATH);
  if (!existsSync(file)) return { commit: '', scenarios: new Map() };
  const report = JSON.parse(readFileSync(file, 'utf8'));
  const scenarios = new Map();
  for (const scenario of report.scenarios || []) {
    const log = scenario.log ? path.join(path.dirname(file), scenario.log) : '';
    const sha =
      log && existsSync(log)
        ? createHash('sha256').update(readFileSync(log)).digest('hex')
        : '';
    scenarios.set(scenario.label, {
      status: scenario.status,
      logMatches: Boolean(sha) && sha === scenario.logSha256,
    });
  }
  return { commit: String(report.commit || ''), scenarios };
}

/**
 * Judge one evidence line.
 * state: ok (supports pass), confirmed-fail, failed, stale, paid, unverified.
 */
export function judgeEntry(entry, { testOutcomes, acceptance, parityResults }) {
  if (entry.kind === KIND.paid) return { state: 'paid' };
  if (entry.kind === KIND.parity) {
    if (!parityResults)
      return { state: 'stale', reason: 'вид parity только для interfaces.tsv' };
    const linked = parityResults.get(entry.ref);
    if (!linked)
      return { state: 'stale', reason: 'нет такой строки parity.tsv' };
    if (linked.result === RESULT.pass) return { state: 'ok' };
    if (linked.result === RESULT.fail) return { state: 'failed' };
    if (linked.result === RESULT.paid) return { state: 'paid' };
    return { state: 'unverified' };
  }
  if (entry.kind === KIND.unit || entry.kind === KIND.fail) {
    const ref = splitTestRef(entry.ref);
    if (!ref)
      return {
        state: 'stale',
        reason: 'ссылка не в формате <файл>::<имя теста>',
      };
    const outcome = testOutcomes.get(
      `${ref.file}${TEST_NAME_SEPARATOR}${ref.name}`,
    );
    if (!outcome) return { state: 'stale', reason: 'тест не найден' };
    if (outcome === 'skip') return { state: 'stale', reason: 'тест пропущен' };
    if (outcome === 'fail') return { state: 'failed', reason: 'тест падает' };
    return { state: entry.kind === KIND.fail ? 'confirmed-fail' : 'ok' };
  }
  if (entry.kind === KIND.qa) {
    const scenario = acceptance.scenarios.get(entry.ref);
    if (!scenario)
      return { state: 'stale', reason: 'сценария нет в acceptance.json' };
    if (!scenario.logMatches)
      return { state: 'stale', reason: 'журнал не совпадает с logSha256' };
    if (scenario.status !== 'pass')
      return { state: 'failed', reason: `статус ${scenario.status}` };
    return { state: 'ok' };
  }
  return { state: 'stale', reason: `неизвестный вид «${entry.kind}»` };
}

export function resultFor(states) {
  if (states.includes('paid')) return RESULT.paid;
  if (states.includes('confirmed-fail') || states.includes('failed'))
    return RESULT.fail;
  if (
    !states.length ||
    states.includes('stale') ||
    states.includes('unverified')
  ) {
    return RESULT.unverified;
  }
  return RESULT.pass;
}

function describeEntry(entry, judgement, context) {
  const { acceptance } = context;
  const stale =
    judgement.reason && judgement.state !== 'ok'
      ? ` [${judgement.reason}]`
      : '';
  if (entry.kind === KIND.paid) return `${KIND.paid}: ${entry.ref}`;
  if (entry.kind === KIND.parity) {
    const linked = context.parityResults?.get(entry.ref);
    return `parity ${entry.ref}${linked ? ` (${linked.result})` : ''}${stale}`;
  }
  if (entry.kind === KIND.qa) {
    const commit = acceptance.commit
      ? `, прогон ${acceptance.commit.slice(0, 8)}`
      : '';
    return `qa ${entry.ref}${commit}${stale}`;
  }
  return `${entry.kind} ${entry.ref}${stale}`;
}

/** Keys of a parsed registry that get a result. */
export function registryKeys(registry) {
  return registry.rows.map(registry.keyOf).filter(Boolean);
}

/** Results and evidence text per key, plus problems for --check. */
export function evaluate(keyList, entries, context) {
  const keys = new Set(keyList);
  const byKey = new Map();
  const problems = [];
  const seen = new Set();
  for (const entry of entries) {
    if (!keys.has(entry.key)) continue;
    const identity = `${entry.key}\t${entry.kind}\t${entry.ref}`;
    if (seen.has(identity)) {
      problems.push(
        `parity-evidence.tsv:${entry.line}: повтор ${entry.key} ${entry.ref}`,
      );
      continue;
    }
    seen.add(identity);
    const judgement = judgeEntry(entry, context);
    if (judgement.state === 'stale') {
      problems.push(
        `parity-evidence.tsv:${entry.line}: ${entry.key} ${entry.ref}: ${judgement.reason}`,
      );
    }
    const list = byKey.get(entry.key) || [];
    list.push({ entry, judgement });
    byKey.set(entry.key, list);
  }
  const results = new Map();
  for (const key of keys) {
    const list = byKey.get(key) || [];
    results.set(key, {
      result: resultFor(list.map(({ judgement }) => judgement.state)),
      evidence: list
        .map(({ entry, judgement }) => describeEntry(entry, judgement, context))
        .join('; '),
    });
  }
  return { results, problems };
}

/** Parity, then interfaces (whose parity links read the parity results). */
export function evaluateAll(parity, interfaces, entries, context) {
  const parityKeys = registryKeys(parity);
  const interfaceKeys = registryKeys(interfaces);
  const known = new Set([...parityKeys, ...interfaceKeys]);
  const problems = entries
    .filter((entry) => !known.has(entry.key))
    .map(
      (entry) => `parity-evidence.tsv:${entry.line}: нет строки ${entry.key}`,
    );
  const forParity = evaluate(parityKeys, entries, context);
  const forInterfaces = evaluate(interfaceKeys, entries, {
    ...context,
    parityResults: forParity.results,
  });
  return {
    parity: forParity.results,
    interfaces: forInterfaces.results,
    problems: [...problems, ...forParity.problems, ...forInterfaces.problems],
  };
}

const EMPTY = Object.freeze({ result: '', evidence: '' });

function cellsFor(registry, results, fields) {
  const key = registry.keyOf(fields);
  return key ? results.get(key) : EMPTY;
}

export function withResults(registry, results) {
  const header = [
    ...registry.header.slice(0, registry.baseLength),
    ...RESULT_COLUMNS,
  ];
  const rows = registry.rows.map((fields) => {
    const { result, evidence } = cellsFor(registry, results, fields);
    return [...fields.slice(0, registry.baseLength), result, evidence];
  });
  return { header, rows };
}

/** Rows whose written result or evidence differs from the computed one. */
export function staleRows(registry, results) {
  return registry.rows
    .filter((fields) => {
      if (!registry.hasResults) return true;
      const { result, evidence } = cellsFor(registry, results, fields);
      return (
        fields[registry.baseLength] !== result ||
        fields[registry.baseLength + 1] !== evidence
      );
    })
    .map(
      (fields) =>
        registry.keyOf(fields) || `interfaces.tsv:${fields[0]}:${fields[1]}`,
    );
}

/** Counts by назначение group and result. */
export function countByGroup(rows, results, keyOf, groupOf) {
  const counts = new Map();
  for (const fields of rows) {
    const key = keyOf(fields);
    if (!key) continue;
    const group = groupOf(fields);
    const row =
      counts.get(group) ||
      Object.fromEntries(Object.values(RESULT).map((r) => [r, 0]));
    row[results.get(key).result] += 1;
    counts.set(group, row);
  }
  return counts;
}

function formatCounts(counts) {
  const columns = Object.values(RESULT);
  const total = Object.fromEntries(columns.map((r) => [r, 0]));
  const lines = [['группа', ...columns].join('\t')];
  for (const [group, row] of [...counts.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    lines.push([group, ...columns.map((r) => row[r])].join('\t'));
    for (const r of columns) total[r] += row[r];
  }
  lines.push(['всего', ...columns.map((r) => total[r])].join('\t'));
  return lines.join('\n');
}

export function main(argv = process.argv.slice(2), root = process.cwd()) {
  const parity = parseParity(
    readFileSync(path.join(root, PARITY_PATH), 'utf8'),
  );
  const interfaces = parseInterfaces(
    readFileSync(path.join(root, INTERFACES_PATH), 'utf8'),
  );
  const entries = parseEvidence(
    readFileSync(path.join(root, EVIDENCE_PATH), 'utf8'),
  );
  const testFiles = entries
    .filter((entry) => entry.kind === KIND.unit || entry.kind === KIND.fail)
    .map((entry) => splitTestRef(entry.ref)?.file)
    .filter(Boolean);
  const context = {
    testOutcomes: runCitedTests(testFiles, root),
    acceptance: loadAcceptance(root),
  };
  const evaluated = evaluateAll(parity, interfaces, entries, context);
  console.log('parity.tsv по назначению');
  console.log(
    formatCounts(
      countByGroup(parity.rows, evaluated.parity, parityKey, (f) => f[4]),
    ),
  );
  console.log('\ninterfaces.tsv по виду');
  console.log(
    formatCounts(
      countByGroup(
        interfaces.rows,
        evaluated.interfaces,
        interfaces.keyOf,
        (f) => f[0],
      ),
    ),
  );

  const registries = [
    [PARITY_PATH, parity, evaluated.parity],
    [INTERFACES_PATH, interfaces, evaluated.interfaces],
  ];
  if (argv.includes('--write')) {
    for (const [file, registry, results] of registries) {
      writeFileSync(
        path.join(root, file),
        serializeTsv(withResults(registry, results)),
      );
    }
    console.log(`wrote ${PARITY_PATH} and ${INTERFACES_PATH}`);
  }
  for (const problem of evaluated.problems) console.error(problem);
  if (argv.includes('--check')) {
    let failed = evaluated.problems.length > 0;
    for (const [file, registry, results] of registries) {
      const stale = staleRows(registry, results);
      if (!stale.length) continue;
      failed = true;
      console.error(
        `${file}: ${stale.length} rows differ from the evidence (run --write), e.g. ${stale.slice(0, 5).join(', ')}`,
      );
    }
    if (failed) return 1;
  }
  return 0;
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : '';
if (import.meta.url === invokedPath) process.exitCode = main();
