export const STATUSES = ['pass', 'flaky', 'hung', 'timeout', 'fail'];

export function classifyAttempt(run, manifest, { external = false } = {}) {
  if (run.error?.code === 'ETIMEDOUT')
    return manifest?.status === 'pass' ? 'hung' : 'timeout';
  if (run.error || run.signal || run.status !== 0) return 'fail';
  return manifest?.status === 'pass' || (external && !manifest)
    ? 'pass'
    : 'fail';
}

export function retryStatus(first, second) {
  return first !== 'pass' && second === 'pass' ? 'flaky' : (second ?? first);
}

export function statusCounts(scenarios) {
  return Object.fromEntries(
    STATUSES.map((status) => [
      status,
      scenarios.filter((row) => row.status === status).length,
    ]),
  );
}

export function historyLine(report) {
  return {
    commit: report.commit,
    dirty: report.dirty,
    startedAt: report.startedAt,
    finishedAt: report.finishedAt,
    seconds:
      (Date.parse(report.finishedAt) - Date.parse(report.startedAt)) / 1000,
    counts: statusCounts(report.scenarios),
    // Keep the denominator correct for --only runs too.
    scenarios: report.scenarios.map((row) => row.label),
    nonPass: report.scenarios
      .filter((row) => row.status !== 'pass')
      .map(({ label, status }) => ({ label, status })),
  };
}

export function flakeReport(history) {
  const rows = new Map();
  for (const run of history) {
    const nonPass = new Set(run.nonPass.map((row) => row.label));
    for (const label of run.scenarios) {
      const row = rows.get(label) ?? { label, runs: 0, passes: 0 };
      row.runs++;
      if (!nonPass.has(label)) row.passes++;
      rows.set(label, row);
    }
  }
  const share = (row) => ({
    ...row,
    nonPassShare: row.runs ? (row.runs - row.passes) / row.runs : 0,
  });
  const scenarios = [...rows.values()]
    .map(share)
    .sort(
      (a, b) =>
        b.nonPassShare - a.nonPassShare || a.label.localeCompare(b.label),
    );
  const overall = share(
    scenarios.reduce(
      (total, row) => ({
        runs: total.runs + row.runs,
        passes: total.passes + row.passes,
      }),
      { runs: 0, passes: 0 },
    ),
  );
  return { scenarios, overall };
}

export function formatFlakeReport(history) {
  const { scenarios, overall } = flakeReport(history);
  return [
    'scenario\truns\tpasses\tnon-pass',
    ...[...scenarios, { label: 'overall', ...overall }].map(
      (row) =>
        `${row.label}\t${row.runs}\t${row.passes}\t${(row.nonPassShare * 100).toFixed(1)}%`,
    ),
  ].join('\n');
}
