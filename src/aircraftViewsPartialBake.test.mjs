// Reproduction: `npm run build:aircraft-views -- --only glider` (no --out)
// replaces the shipped sheet with one whose other subjects' cells are empty,
// and the shipped-sheet predicates of src/data/viewSheet.test.mjs accept it.
// Runs the real wrapper in a disposable copy of the project with a Blender
// stand-in that writes what the bake writes for --only (skipped blocks zero).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const shippedWebp = path.join(repo, 'public/sprites/aircraft-views.webp');
const shippedJson = path.join(repo, 'src/data/aircraftViews.json');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'partial-bake-'));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.mkdirSync(path.join(root, 'public/sprites'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src/data'), { recursive: true });
  fs.copyFileSync(
    path.join(repo, 'scripts/build-aircraft-views.mjs'),
    path.join(root, 'scripts/build-aircraft-views.mjs'),
  );
  fs.copyFileSync(shippedWebp, path.join(root, 'public/sprites/aircraft-views.webp'));
  fs.copyFileSync(shippedJson, path.join(root, 'src/data/aircraftViews.json'));
  fs.symlinkSync(path.join(repo, 'node_modules'), path.join(root, 'node_modules'));
  // Blender stand-in: the shipped sheet with every block not in --only zeroed,
  // as build-aircraft-view-sheet.py leaves it (np.zeros, skipped subjects).
  const stub = path.join(root, 'blender-stub.mjs');
  fs.writeFileSync(
    stub,
    `import fs from 'node:fs'; import path from 'node:path'; import sharp from 'sharp';
const a = process.argv.slice(process.argv.indexOf('--') + 1);
const out = a[a.indexOf('--out') + 1];
const only = a.includes('--only') ? a[a.indexOf('--only') + 1].split(',') : null;
const m = JSON.parse(fs.readFileSync(${JSON.stringify(shippedJson)}, 'utf8'));
const { data, info } = await sharp(${JSON.stringify(shippedWebp)}).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const frames = m.rings.reduce((s, n) => s + n, 0), c = m.cellPx;
for (const [name, e] of Object.entries(m.subjects)) {
  if (!only || only.includes(name)) continue;
  for (let n = e.first; n < e.first + frames; n++) {
    const left = (n % m.columns) * c, top = Math.floor(n / m.columns) * c;
    for (let y = 0; y < c; y++) data.fill(0, ((top + y) * info.width + left) * 4, ((top + y) * info.width + left + c) * 4);
  }
}
await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toFile(path.join(out, 'aircraft-views.png'));
fs.writeFileSync(path.join(out, 'aircraft-views.json'), JSON.stringify(m));
console.log('baked (stub)');
`,
  );
  const sh = path.join(root, 'blender');
  fs.writeFileSync(sh, `#!/bin/sh\ncd ${JSON.stringify(root)} && exec ${JSON.stringify(process.execPath)} ${JSON.stringify(stub)} "$@"\n`);
  fs.chmodSync(sh, 0o755);
  return { root, blender: sh };
}

async function cells(file) {
  const m = JSON.parse(fs.readFileSync(shippedJson, 'utf8'));
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const frames = m.rings.reduce((s, n) => s + n, 0), c = m.cellPx;
  const used = Object.keys(m.subjects).length * frames;
  let grey = true, edgeClear = true;
  for (let i = 0; i < data.length; i += 4)
    if (data[i] !== data[i + 1] || data[i] !== data[i + 2]) { grey = false; break; }
  const empty = [];
  for (let n = 0; n < used; n++) {
    const left = (n % m.columns) * c, top = Math.floor(n / m.columns) * c;
    let lit = 0;
    for (let y = 0; y < c; y++)
      for (let x = 0; x < c; x++) {
        const a = data[((top + y) * info.width + left + x) * 4 + 3];
        if (a) lit++;
        if (a && (x < 2 || y < 2 || x >= c - 2 || y >= c - 2)) edgeClear = false;
      }
    if (!lit) empty.push(n);
  }
  const size = info.width === m.columns * c && info.height === m.rows * c;
  return { size, grey, edgeClear, empty, airliner0: !empty.includes(0) };
}

const posixTest = process.platform === 'win32' ? test.skip : test;

posixTest('partial bake: --only glider without --out keeps the shipped sheet whole', { timeout: 600000 }, async () => {
  const before = await cells(shippedWebp);
  assert.equal(before.empty.length, 0, 'the shipped sheet has no empty used cell');
  const { root, blender } = fixture();
  try {
    const run = spawnSync(process.execPath, ['scripts/build-aircraft-views.mjs', '--only', 'glider'], {
      cwd: root,
      env: { ...process.env, BLENDER: blender },
      encoding: 'utf8',
    });
    const after = await cells(path.join(root, 'public/sprites/aircraft-views.webp'));
    console.log(JSON.stringify({ status: run.status, stdout: run.stdout.trim(), ...after, empty: after.empty.length }));
    // The shipped-sheet predicates of viewSheet.test.mjs still pass on the result:
    assert.ok(after.size && after.grey && after.edgeClear, 'size, grey and edge checks');
    // ...but the fix must either refuse the run or keep every used cell lit.
    assert.ok(
      run.status !== 0 || after.empty.length === 0,
      `wrapper exit ${run.status}, ${after.empty.length} used cells now empty (airliner cell 0 lit: ${after.airliner0})`,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
