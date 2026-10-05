/** Resolve the actual ordered local CSS imports used by the application entry. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export function readStylesheet(file, ancestors = new Set()) {
  const resolved = path.resolve(
    file instanceof URL ? fileURLToPath(file) : file,
  );
  if (ancestors.has(resolved)) throw new Error('Circular stylesheet import');
  const next = new Set(ancestors).add(resolved);
  return readFileSync(resolved, 'utf8').replace(
    /@import ['"]([^'"]+)['"];\s*/g,
    (_, imported) =>
      readStylesheet(path.resolve(path.dirname(resolved), imported), next),
  );
}
