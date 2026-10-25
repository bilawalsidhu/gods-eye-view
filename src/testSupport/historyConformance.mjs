import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compareHistoryRecords } from '../data/historyRecords.js';

/** The cases, version and notation notes. */
export const HISTORY_CONFORMANCE = JSON.parse(
  readFileSync(
    new URL('../data/fixtures/history-conformance.json', import.meta.url),
    'utf8',
  ),
);
const TIME_FIELDS = new Set(['t', 'receivedAt', 'fromMs', 'toMs']);

/** Expand the fixture notation into the values a store is called with. */
export function historyFixtureValue(value, field = '') {
  if (Array.isArray(value))
    return value.map((item) => historyFixtureValue(item));
  if (value && typeof value === 'object') {
    if (Object.hasOwn(value, '$repeat'))
      return value.$repeat.repeat(value.times);
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, historyFixtureValue(v, k)]),
    );
  }
  if (TIME_FIELDS.has(field) && typeof value === 'string')
    return value === 'NaN' ? NaN : Date.parse(value);
  return value;
}
/** A record as the fixture writes it: absent numbers as null. */
const comparable = (record) =>
  Object.fromEntries(
    Object.entries(record).map(([k, v]) => [k, Number.isNaN(v) ? null : v]),
  );
/** Expected records with every optional number spelled out. */
const expected = (records) =>
  historyFixtureValue(records).map((r) =>
    comparable({
      heightM: null,
      bearingDeg: null,
      receivedAt: null,
      flags: 0,
      ...r,
    }),
  );

/**
 * Every page of one query, checking each page against its size and the
 * whole sequence for store order.
 */
export async function readAllPages(store, query, pageSize = 1000) {
  const records = [];
  let cursor;
  for (let pages = 0; ; pages += 1) {
    assert.ok(pages <= 10_000, 'paging does not end');
    const page = await store.query({ ...query, limit: pageSize, cursor });
    assert.ok(page.records.length <= pageSize, 'page larger than its limit');
    if (page.nextCursor !== null)
      assert.equal(page.records.length, pageSize, 'short page with a cursor');
    // Strictly increasing across pages: nothing repeated, nothing out of order.
    for (const record of page.records) {
      const previous = records.at(-1);
      if (previous)
        assert.ok(
          compareHistoryRecords(previous, record) < 0,
          `page order: ${previous.key}@${previous.t} then ${record.key}@${record.t}`,
        );
      records.push(record);
    }
    if (page.nextCursor === null) return records;
    cursor = page.nextCursor;
  }
}

async function codeOf(work) {
  try {
    await work();
  } catch (error) {
    return error.code ?? `uncoded: ${error.message}`;
  }
  return 'none';
}

async function runStep(store, step) {
  if (step.write) {
    const result = await store.write(historyFixtureValue(step.write));
    const expect = step.expect ?? {};
    for (const field of ['accepted', 'repeats', 'conflicts', 'rejected'])
      if (field in expect)
        assert.deepEqual(result[field], expect[field], field);
    if (expect.coverage) assert.deepEqual(result.coverage, expect.coverage);
  } else if (step.query) {
    const records = await readAllPages(
      store,
      historyFixtureValue(step.query),
      step.pageSize,
    );
    assert.deepEqual(records.map(comparable), expected(step.expect.records));
  } else if (step.coverage) {
    const { intervals } = await store.coverage(
      historyFixtureValue(step.coverage),
    );
    assert.deepEqual(intervals, historyFixtureValue(step.expect.intervals));
  } else if (step.queryError) {
    assert.equal(
      await codeOf(() => store.query(historyFixtureValue(step.queryError))),
      step.expect.code,
    );
  } else if (step.cursorReuse) {
    const first = await store.query(
      historyFixtureValue(step.cursorReuse.query),
    );
    assert.ok(first.nextCursor, 'the first query needs a second page');
    assert.equal(
      await codeOf(() =>
        store.query({
          ...historyFixtureValue(step.cursorReuse.with),
          cursor: first.nextCursor,
        }),
      ),
      step.expect.code,
    );
  } else if (step.prune) {
    const result = await store.prune();
    assert.deepEqual(result.droppedDays, step.expect.droppedDays);
  } else throw new Error(`Unknown conformance step ${Object.keys(step)}`);
}

/**
 * Run the language-neutral history conformance cases
 * (`src/data/fixtures/history-conformance.json`) against one store.
 * @param {object} options
 * @param {Function} options.test - `node:test`'s `test`.
 * @param {string} options.label - Prefix for each test name.
 * @param {(options: {now: () => number, retentionDays?: number}, t: object) =>
 *   object | Promise<object>} options.open - A fresh, empty store; may register
 *   its cleanup with `t.after`. Store calls may return promises.
 */
export function runHistoryConformance({ test, label, open }) {
  for (const testCase of HISTORY_CONFORMANCE.cases)
    test(`${label}: ${testCase.name} — ${testCase.clause}`, async (t) => {
      const nowMs = Date.parse(testCase.now);
      const store = await open({ now: () => nowMs, ...testCase.open }, t);
      for (const [index, step] of testCase.steps.entries())
        await t.test(`step ${index}`, () => runStep(store, step));
    });
}
