import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  rankEntryImports,
  readModule,
  resolveSpecifier,
  staticImportGraph,
} from './importGraph.js';

/**
 * Unit tests for the static import-graph walker that backs the Phase 15A
 * boot-boundary guard (src/main.importgraph.test.mjs). The walker is
 * regex-based ON PURPOSE — these tests pin the exact behaviors that make
 * that safe: statement anchoring (prose never forms an edge), comment
 * stripping, static/dynamic classification, and first-root attribution in
 * the ranking.
 */

/** Build a synthetic module tree and hand back a disposable repo root. */
function fixtureTree() {
  const root = mkdtempSync(join(tmpdir(), 'gev-import-graph-'));
  const write = (relative, content) => {
    const target = join(root, relative);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, content);
  };
  // entry imports ui (static), seam (static), and lazily imports a chunk;
  // ui and seam both import shared — attribution must charge shared to ui.
  write('entry.js', [
    "import { ui } from './ui.js';",
    "import { seam } from './seam/index.js';",
    "const chunk = import('./lazy.js');",
    'export { boot } from "./reexport.js";',
    'void [ui, seam, chunk];',
    // Prose that must NEVER become an edge:
    'const hint = "downloaded from \'./ghost.js\'";',
    "// import './commented.js';",
    '/*',
    " * import './blocked.js';",
    " * see also: from './blocked2.js'",
    ' */',
    "const template = `run import('./templateGhost.js') first`;",
  ].join('\n'));
  write('ui.js', "import { shared } from './shared.js';\nexport const ui = shared;\n");
  write('shared.js', 'export const shared = 1;\n');
  write('reexport.js', 'export const boot = 2;\n');
  write('seam/index.js', [
    "import { shared } from '../shared.js';",
    "import { deep } from './deep.js';",
    'export const seam = shared + deep;',
  ].join('\n'));
  write('seam/deep.js', 'export const deep = 3;\n');
  write('lazy.js', 'export const lazy = 4;\n');
  write('ghost.js', 'export const ghost = 5;\n');
  write('commented.js', 'export const commented = 6;\n');
  write('blocked.js', 'export const blocked = 7;\n');
  write('blocked2.js', 'export const blocked2 = 8;\n');
  write('templateGhost.js', 'export const templateGhost = 9;\n');
  return root;
}

test('resolveSpecifier handles extensionless, .js, .mjs, and directory imports', () => {
  const root = fixtureTree();
  try {
    const entry = join(root, 'entry.js');
    assert.equal(resolveSpecifier('./ui', entry, root), join(root, 'ui.js'));
    assert.equal(resolveSpecifier('./ui.js', entry, root), join(root, 'ui.js'));
    assert.equal(resolveSpecifier('./seam', entry, root), join(root, 'seam/index.js'));
    const mjs = join(root, 'extra.mjs');
    writeFileSync(mjs, 'export {};\n');
    assert.equal(resolveSpecifier('./extra', entry, root), mjs);
    assert.equal(resolveSpecifier('./missing', entry, root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readModule classifies static vs dynamic edges and ignores prose', () => {
  const root = fixtureTree();
  try {
    const module = readModule(join(root, 'entry.js'), root);
    const rel = (p) => p.slice(root.length + 1);
    assert.deepEqual(
      module.staticDeps.map(rel).sort(),
      ['reexport.js', 'seam/index.js', 'ui.js'],
    );
    assert.deepEqual(module.dynamicDeps.map(rel), ['lazy.js']);
    const ghostEdges = [...module.staticDeps, ...module.dynamicDeps].filter((dep) => (
      ['ghost.js', 'commented.js', 'blocked.js', 'blocked2.js', 'templateGhost.js']
        .includes(rel(dep))
    ));
    assert.deepEqual(ghostEdges, [], 'prose, comments, and template text never form edges');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('staticImportGraph cuts dynamic edges and reports chunk exits', () => {
  const root = fixtureTree();
  try {
    const { files, dynamicOnly } = staticImportGraph(join(root, 'entry.js'), root);
    const rel = (p) => p.slice(root.length + 1);
    const members = [...files.keys()].map(rel).sort();
    assert.deepEqual(members, [
      'entry.js',
      'reexport.js',
      'seam/deep.js',
      'seam/index.js',
      'shared.js',
      'ui.js',
    ], 'lazy.js is a chunk exit, not a closure member');
    assert.deepEqual(
      (dynamicOnly.get(join(root, 'entry.js')) || []).map(rel),
      ['lazy.js'],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rankEntryImports attributes shared modules to the first import in order', () => {
  const root = fixtureTree();
  try {
    const { totalBytes, rows } = rankEntryImports(join(root, 'entry.js'), root);
    const byName = new Map(rows.map((row) => [row.file.slice(root.length + 1), row]));
    const ui = byName.get('ui.js');
    const seam = byName.get('seam/index.js');
    // shared.js is reachable through both; first-root attribution charges it
    // to ui (imported first), so the seam row must exclude it.
    const sharedBytes = readModule(join(root, 'shared.js'), root).bytes;
    assert.equal(
      seam.exclusiveBytes,
      readModule(join(root, 'seam/index.js'), root).bytes
        + readModule(join(root, 'seam/deep.js'), root).bytes,
      'seam exclusivity excludes the shared module claimed by the earlier import',
    );
    assert.equal(
      ui.exclusiveBytes,
      ui.directBytes + sharedBytes,
      'the first import owns the shared module',
    );
    const closureSum = rows.reduce((sum, row) => sum + row.exclusiveBytes, 0);
    assert.ok(
      closureSum <= totalBytes,
      'exclusive attribution never exceeds the closure total',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rankEntryImports honours the exclude predicate in totals only', () => {
  const root = fixtureTree();
  try {
    const bare = rankEntryImports(join(root, 'entry.js'), root);
    const excluded = rankEntryImports(join(root, 'entry.js'), root, {
      exclude: (file) => file.endsWith('reexport.js'),
    });
    const reexportBytes = readModule(join(root, 'reexport.js'), root).bytes;
    assert.equal(bare.totalBytes - excluded.totalBytes, reexportBytes);
    assert.equal(bare.rows.length, excluded.rows.length, 'rows still walk excluded files');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
