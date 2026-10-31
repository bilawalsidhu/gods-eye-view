#!/usr/bin/env node
/**
 * Repeatable acceptance protocol for the Sky view redraw budget
 *. One harness run is noisy on a shared host with
 * a software-GL browser, so the acceptance is a SERIES:
 *
 *   node scripts/qa-sky-render-series.mjs --url http://127.0.0.1:4337 \
 *        --out <dir> [--runs 5] [--settle-ms 20000]
 *
 * - runs scripts/qa-sky-render.mjs --runs times back to back, unchanged
 *   (same thresholds: overlay redraw p95 < 8 ms desktop, < 16 ms mid-phone,
 *   Orion reference diff, Betelgeuse/Rigel <= 1 px, no page errors);
 * - every run keeps its own directory (<out>/run-NN: results.json, log.txt,
 *   screenshots) and its exit code, whatever the outcome;
 * - <out>/series.json and series.txt list every run's numbers and the host
 *   load average before it;
 * - the series passes only when EVERY run passes. There is no best-of and no
 *   retry: a miss is a fail of the series and stays in the record.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { loadavg } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const URL_ = arg('--url', 'http://127.0.0.1:4337');
const OUT = path.resolve(arg('--out', 'qa-sky-render-series'));
const RUNS = Number(arg('--runs', '5'));
const SETTLE = arg('--settle-ms', '20000');
mkdirSync(OUT, { recursive: true });

const series = {
  url: URL_,
  started: new Date().toISOString(),
  protocol:
    'qa-sky-render.mjs run back to back, unchanged thresholds; every run kept; pass = all runs pass',
  runs: [],
};
const lines = [];
const say = (line) => {
  lines.push(line);
  console.log(line);
};

for (let n = 1; n <= RUNS; n++) {
  const dir = path.join(OUT, `run-${String(n).padStart(2, '0')}`);
  const load = loadavg().map((v) => Number(v.toFixed(2)));
  const t0 = Date.now();
  const r = spawnSync(
    process.execPath,
    [
      path.join(ROOT, 'scripts/qa-sky-render.mjs'),
      '--url',
      URL_,
      '--out',
      dir,
      '--settle-ms',
      SETTLE,
    ],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  writeFileSync(
    path.join(OUT, `run-${String(n).padStart(2, '0')}.stdout.txt`),
    `${r.stdout ?? ''}\n${r.stderr ?? ''}`,
  );
  const entry = {
    run: n,
    dir,
    exitCode: r.status,
    loadBefore: load,
    seconds: Math.round((Date.now() - t0) / 1000),
    pass: r.status === 0,
  };
  const file = path.join(dir, 'results.json');
  if (existsSync(file)) {
    const res = JSON.parse(readFileSync(file, 'utf8'));
    entry.errors = res.errors;
    entry.orionDiffPixels = res.profiles.desktop?.reference?.differingPixels;
    entry.orionErrorPx = (res.profiles.desktop?.orion?.stars ?? []).map(
      (s) => s.errorPx,
    );
    entry.redrawP95 = {};
    for (const [name, p] of Object.entries(res.profiles))
      for (const run of p.runs) {
        const key = `${name} fov${run.fovDeg} ${run.layers}${
          run.info
            ? run.cesiumPaused
              ? ' (info, no satellites)'
              : ' (info, Cesium on)'
            : ''
        }`;
        entry.redrawP95[key] = {
          p95: run.overlayRedraw.p95,
          p50: run.overlayRedraw.p50,
          budget: run.info ? null : p.budgetMs,
          pass: run.pass,
        };
      }
  } else entry.missingResults = true;
  series.runs.push(entry);
  say(
    `run ${n}: exit ${r.status} load ${load.join('/')} ${entry.seconds}s ` +
      Object.entries(entry.redrawP95 ?? {})
        .filter(([, v]) => v.budget)
        .map(([k, v]) => `${k}=${v.p95}`)
        .join(' '),
  );
  // write after every run, so an interrupted series keeps what it measured
  series.pass = series.runs.every((x) => x.pass) && series.runs.length === RUNS;
  writeFileSync(
    path.join(OUT, 'series.json'),
    `${JSON.stringify(series, null, 2)}\n`,
  );
  writeFileSync(path.join(OUT, 'series.txt'), `${lines.join('\n')}\n`);
}

// worst p95 per measurement over the whole series (not a best-of)
const worst = {};
for (const run of series.runs)
  for (const [k, v] of Object.entries(run.redrawP95 ?? {}))
    worst[k] = Math.max(worst[k] ?? 0, v.p95);
series.worstP95 = worst;
series.finished = new Date().toISOString();
series.pass = series.runs.length === RUNS && series.runs.every((x) => x.pass);
writeFileSync(
  path.join(OUT, 'series.json'),
  `${JSON.stringify(series, null, 2)}\n`,
);
say(`worst p95 over ${series.runs.length} runs: ${JSON.stringify(worst)}`);
say(series.pass ? 'SERIES PASS' : 'SERIES FAIL');
writeFileSync(path.join(OUT, 'series.txt'), `${lines.join('\n')}\n`);
process.exitCode = series.pass ? 0 : 1;
