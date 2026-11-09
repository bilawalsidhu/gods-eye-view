// A Vite build through the panel alias resolves renderers.js's relative
// import of Navara's wind mesh to the stub (scripts/build-panel.mjs uses the
// same alias).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'vite';
import { panelBuildConfig } from './panel.js';

test('a Vite build resolves the relative wind-mesh import through the panel alias', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'panel-alias-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'src/app/layers'), { recursive: true });
  mkdirSync(join(root, 'src/globe/navara'), { recursive: true });
  writeFileSync(
    join(root, 'src/app/layers/renderers.js'),
    "export const load = () => import('../../globe/navara/windFlowMesh.js');\n",
  );
  writeFileSync(
    join(root, 'src/globe/navara/windFlowMesh.js'),
    'export const real = true;\n',
  );
  const { resolve } = panelBuildConfig({ plugins: [] });
  const [output] = await build({
    configFile: false,
    root,
    logLevel: 'silent',
    resolve,
    build: {
      outDir: join(root, 'out'),
      write: false,
      lib: {
        entry: join(root, 'src/app/layers/renderers.js'),
        formats: ['es'],
        fileName: 'x',
      },
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  });
  const [chunk] = output.output;
  assert.match(chunk.code, /Navara is unavailable in the panel/);
  assert.doesNotMatch(chunk.code, /real = true/);
});
