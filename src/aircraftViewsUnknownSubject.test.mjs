// Reproduction: `--only` with a name the bake does not
// know (the app's class is `helicopter`, the bake's subjects are
// `helicopter0..2`) bakes nothing yet exits 0 and writes a fully
// transparent sheet. Needs Blender 5.2+ (`$BLENDER` or `blender` on PATH);
// no model is rendered, so it takes a few seconds.
//
// Opt-in: it starts the real Blender, which crashes headless on some
// machines, so `npm test` skips it without starting Blender at all. Run it
// with `npm run test:blender` (sets GEV_BLENDER_TESTS=1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BLENDER = process.env.BLENDER || 'blender';
const optedIn = process.env.GEV_BLENDER_TESTS === '1';
const hasBlender =
  optedIn &&
  spawnSync(BLENDER, ['-b', '--factory-startup', '--python-expr', 'pass'])
    .status === 0;

test(
  'bake: an unknown --only name fails before writing anything',
  {
    timeout: 600000,
    skip: !optedIn
      ? 'starts Blender: run with npm run test:blender'
      : !hasBlender && 'Blender could not start in background mode',
  },
  async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'unknown-subject-'));
    try {
      const run = spawnSync(
        process.execPath,
        [
          'scripts/build-aircraft-views.mjs',
          '--only',
          'helicopter',
          '--out',
          out,
        ],
        { cwd: repo, encoding: 'utf8', env: { ...process.env, BLENDER } },
      );
      const webp = path.join(out, 'aircraft-views.webp');
      let visible = null;
      if (fs.existsSync(webp)) {
        const { data } = await sharp(webp)
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        visible = 0;
        for (let i = 3; i < data.length; i += 4) if (data[i]) visible++;
      }
      console.log(
        JSON.stringify({
          status: run.status,
          wroteWebp: fs.existsSync(webp),
          visible,
        }),
      );
      assert.notEqual(
        run.status,
        0,
        `exit ${run.status}, wrote a sheet with ${visible} visible pixels`,
      );
      assert.match(run.stderr, /unknown --only subjects: helicopter\b/);
      assert.equal(
        fs.existsSync(webp),
        false,
        'no sheet is written for an unknown subject',
      );
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  },
);
