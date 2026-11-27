import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The layer directory each layer file's code lives in. */
const LAYER_DIRS = {
  'flights.js': 'flights',
  'militaryFlights.js': 'military',
  'aisLiveVessels.js': 'vessels',
  'firmsHeatmap.js': 'firms',
  'satellites.js': 'satellites',
  'rocketLaunches.js': 'launches',
  'militaryInstallations.js': 'installations',
  'militaryAwareness.js': 'awareness',
  'traffic.js': 'traffic',
  'bikeshare.js': 'bikeshare',
  'cctv.js': 'cctv',
};

/** Read actual component owners for structural regression assertions. */
export function readLayerSource(file) {
  const path = file instanceof URL ? fileURLToPath(file) : file;
  const layer = Object.hasOwn(LAYER_DIRS, basename(path))
    ? LAYER_DIRS[basename(path)]
    : null;
  if (!layer) return readFileSync(path, 'utf8');
  const directory = join(dirname(path), '../layers', layer);
  // The aircraft layers draw through shared icon and model layers; they are
  // their code too.
  const shared = ['flights.js', 'militaryFlights.js'].includes(basename(path))
    ? ['aircraftIconLayer.js', 'aircraftModelLayer.js'].map((name) =>
        join(dirname(path), name),
      )
    : [];
  return readdirSync(directory)
    .filter((name) => name.endsWith('.js'))
    .sort()
    .map((name) => join(directory, name))
    .concat(shared)
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');
}
