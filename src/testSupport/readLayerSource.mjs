import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Read actual component owners for structural regression assertions. */
export function readLayerSource(file) {
  const path = file instanceof URL ? fileURLToPath(file) : file;
  if (!['flights.js', 'militaryFlights.js'].includes(basename(path)))
    return readFileSync(path, 'utf8');
  const directory = join(
    dirname(path),
    basename(path) === 'flights.js'
      ? '../layers/flights'
      : '../layers/military',
  );
  return readdirSync(directory)
    .filter((name) => name.endsWith('.js'))
    .sort()
    .map((name) => readFileSync(join(directory, name), 'utf8'))
    .join('\n');
}
