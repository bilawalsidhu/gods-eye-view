import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Read actual component owners for structural regression assertions. */
export function readLayerSource(file) {
  const path = file instanceof URL ? fileURLToPath(file) : file;
  if (
    ![
      'flights.js',
      'militaryFlights.js',
      'aisLiveVessels.js',
      'firmsHeatmap.js',
      'satellites.js',
      'rocketLaunches.js',
      'militaryInstallations.js',
      'militaryAwareness.js',
      'traffic.js',
      'bikeshare.js',
      'cctv.js',
    ].includes(basename(path))
  )
    return readFileSync(path, 'utf8');
  const directory = join(
    dirname(path),
    basename(path) === 'flights.js'
      ? '../layers/flights'
      : basename(path) === 'militaryFlights.js'
        ? '../layers/military'
        : basename(path) === 'firmsHeatmap.js'
          ? '../layers/firms'
          : basename(path) === 'satellites.js'
            ? '../layers/satellites'
            : basename(path) === 'rocketLaunches.js'
              ? '../layers/launches'
              : basename(path) === 'militaryInstallations.js'
                ? '../layers/installations'
                : basename(path) === 'militaryAwareness.js'
                  ? '../layers/awareness'
                  : basename(path) === 'traffic.js'
                    ? '../layers/traffic'
                    : basename(path) === 'bikeshare.js'
                      ? '../layers/bikeshare'
                      : basename(path) === 'cctv.js'
                        ? '../layers/cctv'
                        : '../layers/vessels',
  );
  // A layer's code includes its renderers (render/*.js) and, for
  // the aircraft layers, the shared aircraft renderer and tracking they draw
  // through: checks on what the layer does keep finding it where it moved.
  const directories = [directory, join(directory, 'render')];
  const shared = [];
  if (['flights.js', 'militaryFlights.js'].includes(basename(path))) {
    directories.push(join(directory, '../aircraft/render'));
    shared.push(join(directory, '../aircraft/tracking.js'));
  }
  return [
    ...directories
      .filter((dir) => existsSync(dir))
      .flatMap((dir) =>
        readdirSync(dir)
          .filter((name) => name.endsWith('.js'))
          .sort()
          .map((name) => readFileSync(join(dir, name), 'utf8')),
      ),
    ...shared.map((file) => readFileSync(file, 'utf8')),
  ].join('\n');
}
