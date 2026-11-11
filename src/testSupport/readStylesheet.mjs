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
    // Package-owned CSS is compiled by Vite/Tailwind; these checks inspect
    // the application's ordered local rules rather than vendor utilities.
    (_, imported) =>
      imported.startsWith('.')
        ? readStylesheet(path.resolve(path.dirname(resolved), imported), next)
        : '',
  );
}
