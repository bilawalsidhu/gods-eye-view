import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { analyzeFirmsGlow } from '../../scripts/qa-firms-glow-metrics.mjs';
const root = new URL(
  '../../scripts/fixtures/w2/glow-metrics/',
  import.meta.url,
);
async function captures() {
  const frames = {};
  for (const engine of ['cesium', 'navara']) {
    frames[engine] = {};
    for (const mode of ['raw', 'matched-sharpen', 'default-sharpen'])
      frames[engine][mode] = await sharp(
        new URL(engine + '-' + mode + '.png', root).pathname,
      )
        .raw()
        .toBuffer();
  }
  return frames;
}
test('real source/layer crops retain independent geometry, full alpha/color and exact shader-kernel gates', async () => {
  const manifest = JSON.parse(
    await fs.readFile(new URL('capture.json', root), 'utf8'),
  );
  for (const item of manifest.files)
    assert.equal(
      crypto
        .createHash('sha256')
        .update(await fs.readFile(new URL(item.file, root)))
        .digest('hex'),
      item.sha256,
    );
  const result = analyzeFirmsGlow(await captures());
  assert.ok(
    Object.values(result.checks).every(Boolean),
    JSON.stringify(result),
  );
  assert.ok(
    result.raw.directMax > 3,
    'fixture retains the measured native UV precision difference',
  );
  assert.ok(Math.max(...result.geometry.shift.map(Math.abs)) < 0.05);
  assert.ok(result.raw.sourceAlignedMax < 1.1);
  assert.ok(result.sharpen.sourceAlignedMax < 2.7);
});
test('a chroma error cannot influence the alpha-derived alignment', async () => {
  const frames = await captures(),
    original = analyzeFirmsGlow(frames);
  frames.navara.raw[(30 * 61 + 30) * 3 + 1] = Math.min(
    255,
    frames.navara.raw[(30 * 61 + 30) * 3 + 1] + 20,
  );
  const result = analyzeFirmsGlow(frames);
  assert.deepEqual(result.geometry, original.geometry);
  assert.equal(result.checks.rawColor, false);
});
test('faint halo clipping remains a failure before any geometric alignment', async () => {
  const frames = await captures();
  for (let i = 0; i < frames.navara.raw.length; i += 3)
    if (frames.navara.raw[i] - 16 < 5) frames.navara.raw.set([16, 32, 48], i);
  assert.equal(analyzeFirmsGlow(frames).checks.unalignedAlpha, false);
});
test('wrong alpha cannot be disguised by fitting position and size', async () => {
  const frames = await captures();
  for (let i = 0; i < frames.navara.raw.length; i += 3)
    frames.navara.raw[i] = Math.round(16 + (frames.navara.raw[i] - 16) * 0.7);
  assert.equal(analyzeFirmsGlow(frames).checks.unalignedAlpha, false);
});
test('a three-pixel displaced glow exceeds the existing geometry limit', async () => {
  const frames = await captures(),
    old = frames.navara.raw;
  frames.navara.raw = Buffer.alloc(old.length);
  for (let y = 0; y < 61; y++)
    for (let x = 0; x < 61; x++)
      for (let c = 0; c < 3; c++)
        frames.navara.raw[(y * 61 + x) * 3 + c] =
          x >= 3 ? old[(y * 61 + x - 3) * 3 + c] : [16, 32, 48][c];
  assert.equal(analyzeFirmsGlow(frames).checks.geometry, false);
});
test('twenty-percent larger geometry is refused even when the color fit could align it', async () => {
  const frames = await captures(),
    old = frames.navara.raw;
  frames.navara.raw = Buffer.alloc(old.length);
  for (let y = 0; y < 61; y++)
    for (let x = 0; x < 61; x++)
      for (let c = 0; c < 3; c++) {
        const xx = Math.round(30 + (x - 30) / 1.2),
          yy = Math.round(30 + (y - 30) / 1.2);
        frames.navara.raw[(y * 61 + x) * 3 + c] = old[(yy * 61 + xx) * 3 + c];
      }
  assert.equal(analyzeFirmsGlow(frames).checks.geometry, false);
});
test('the actual previous gamma-2.2 GPU shader fails its independent encoded-space kernel oracle', async () => {
  const frames = await captures();
  frames.navara['matched-sharpen'] = await sharp(
    new URL('navara-gamma22-matched-sharpen.png', root).pathname,
  )
    .raw()
    .toBuffer();
  assert.equal(analyzeFirmsGlow(frames).checks.navaraKernel, false);
});
test('missing pixel evidence is refused rather than graded as an empty match', async () => {
  const frames = await captures();
  frames.navara.raw = [];
  assert.throws(() => analyzeFirmsGlow(frames), /real61x61/);
});
