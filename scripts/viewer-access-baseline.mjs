/**
 * Lower `src/render/viewerAccessAllowList.json` to the Cesium-shaped viewer
 * accesses the files off the Cesium list still hold
 * (`src/render/viewerAccess.test.mjs`). It only lowers counts and drops
 * entries (files with none left, gone, or back on the Cesium list); it never
 * adds a file or raises a count. A file over its count is reported and the
 * script exits 1: port that access instead.
 *
 * `--check` reports what it would change without writing, and exits 1 when
 * there is anything to lower.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  BASELINE,
  countedFiles,
  currentHits,
  readBaseline,
  ROOT,
} from '../src/testSupport/viewerAccess.mjs';

const check = process.argv.includes('--check');
const baseline = readBaseline();
const hits = currentHits();
const counted = new Set(countedFiles());

const next = {};
const changes = [];
for (const [file, allowed] of Object.entries(baseline)) {
  const found = counted.has(file) ? (hits.get(file)?.length ?? 0) : 0;
  const count = Math.min(allowed, found);
  if (count > 0) next[file] = count;
  if (count !== allowed) changes.push(`${file}: ${allowed} → ${count}`);
}
const over = [...hits]
  .filter(([file, found]) => found.length > (baseline[file] ?? 0))
  .map(
    ([file, found]) =>
      `${file}: ${found.length} found, ${baseline[file] ?? 0} recorded`,
  );

if (changes.length) {
  console.log(
    `${check ? 'Would lower' : 'Lowered'}:\n  ${changes.join('\n  ')}`,
  );
  if (!check) {
    const sorted = Object.fromEntries(
      Object.keys(next)
        .sort()
        .map((file) => [file, next[file]]),
    );
    writeFileSync(
      path.join(ROOT, BASELINE),
      `${JSON.stringify(sorted, null, 2)}\n`,
    );
  } else process.exitCode = 1;
} else console.log(`${BASELINE} is as low as it goes.`);
if (over.length) {
  console.error(
    `Over their counts (never raised; port these):\n  ${over.join('\n  ')}`,
  );
  process.exitCode = 1;
}
