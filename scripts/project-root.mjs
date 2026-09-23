import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Resolve the explicit CLI project directory, defaulting to the tool's repository. */
export function projectRoot(moduleUrl, environment = process.env) {
  return path.resolve(
    environment.GEV_PROJECT_ROOT ||
      path.join(path.dirname(fileURLToPath(moduleUrl)), '..'),
  );
}
