import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Resolve defaultSourceRoot for ESM context. */
const defaultSourceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..',
);

export { defaultSourceRoot };
