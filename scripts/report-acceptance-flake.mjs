import { readFileSync } from 'node:fs';
import { formatFlakeReport } from './qa/acceptance.mjs';

try {
  if (process.argv.length !== 3)
    throw new Error('Usage: node scripts/report-acceptance-flake.mjs FILE');
  const history = readFileSync(process.argv[2], 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
  console.log(formatFlakeReport(history));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
