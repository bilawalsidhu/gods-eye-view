import { describe, expect, it } from 'vitest';

/**
 * Every module under `src/` is imported, so a fatal error at module load cannot hide in one that
 * no other test happens to import.
 *
 * Measured 2026-08-24, and this exists because both gates miss it. A module whose top-level
 * constant is derived by a function reading a constant declared below it throws
 * `Cannot access 'X' before initialization` the moment anything imports it. Planted in
 * `src/globe/` as an experiment: `tsc --noEmit` reported **nothing**, because TypeScript's
 * use-before-declaration check does not follow a call into another function, and
 * `vitest run --coverage` reported **35 files and 1,130 tests passed**, because
 * `coverage.include` counts a file's lines without executing it. So the module was fatally
 * broken and entirely green.
 *
 * It matters more as the codebase grows into it rather than less. Deriving a constant at import
 * is now the house style for anything a later edit could invalidate: the cloud gap bounds are
 * scanned off the satellite positions and the vessel coverage reason is built from the providers
 * actually reporting, both so that neither can go stale behind a change somewhere else. Every one
 * of those is another chance to declare a constant above the thing it reads, and the failure is
 * always at import rather than at the line, so the stack trace names the importer.
 *
 * `import.meta.glob` is resolved by Vite at build time, so this cannot drift as modules are added
 * or renamed. Non-eager on purpose: awaiting each one separately means the failure names the
 * module rather than collapsing the whole file into one collection error.
 */
const loaders = import.meta.glob('./**/*.ts', { eager: false });

describe('every module can be imported', () => {
  /**
   * The two modules that genuinely cannot load outside a browser, named rather than matched by a
   * pattern.
   *
   * `worker.ts` runs in a Web Worker and reads `self`; `main.ts` is the application entry and reads
   * `document`. Both are browser scope by definition rather than by accident, so neither is a defect
   * this test should report. Named individually on purpose: a wildcard would silently swallow the
   * third browser-only module somebody adds, where a name means it fails here and someone decides.
   */
  const BROWSER_ONLY = new Set(['./globe/satellites/worker.ts', './main.ts']);

  const paths = Object.keys(loaders).filter(
    (path) => !path.endsWith('.test.ts') && !path.endsWith('.d.ts') && !BROWSER_ONLY.has(path),
  );

  it('found modules to check, so a broken glob cannot pass as an empty suite', () => {
    // Without this the whole file is vacuous the day the glob stops matching, which is the
    // failure mode of every test that iterates a discovered set.
    expect(paths.length).toBeGreaterThan(20);
  });

  it.each(paths)('%s', async (path) => {
    const load = loaders[path];
    expect(load).toBeDefined();
    await expect(load?.()).resolves.toBeDefined();
  });
});
