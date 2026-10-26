#!/usr/bin/env node
// CPU-only comparison of the 18 recorded Cesium canvas images, with manifest
// hash/dimension validation. Original W1 limits: >16/255 per channel on at
// most 0.5% of pixels. A different population/pose is checked separately by
// qa-w1-baseline.mjs --compare=A,B.
// Usage: --compare=OLD/summary.json,NEW/summary.json --out=report.json
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
const argument = (name) =>
  process.argv
    .find((value) => value.startsWith(`--${name}=`))
    ?.slice(name.length + 3);
const [oldFile, newFile] = (argument('compare') ?? '').split(',');
const outFile = argument('out');
if (!oldFile || !newFile || !outFile)
  throw new Error('Supply old/new summaries and output');
const old = JSON.parse(await fs.readFile(oldFile)),
  fresh = JSON.parse(await fs.readFile(newFile));
const results = [];
for (const layer of [
  'flights',
  'military',
  'localAdsb',
  'vessels',
  'satellites',
  'launches',
])
  for (const pose of ['global', 'city', 'orbit']) {
    const v = old.layers?.[layer]?.poses?.[pose];
    const next = fresh.layers?.[layer]?.poses?.[pose];
    if (!v?.shot || !next?.shot)
      throw new Error(`Missing ${layer}/${pose} image`);
    const files = [
      path.join(path.dirname(oldFile), v.shot.file),
      path.join(path.dirname(newFile), next.shot.file),
    ];
    const inputs = await Promise.all(files.map((f) => fs.readFile(f)));
    const hashes = inputs.map((b) =>
      crypto.createHash('sha256').update(b).digest('hex'),
    );
    if (hashes[0] !== v.shot.sha256 || hashes[1] !== next.shot.sha256)
      throw new Error('Shot hash mismatch');
    const [a, b] = await Promise.all(
      inputs.map((input) =>
        sharp(input).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
      ),
    );
    if (
      a.info.width !== b.info.width ||
      a.info.height !== b.info.height ||
      a.info.channels !== 3 ||
      b.info.channels !== 3
    )
      throw new Error('Shot format mismatch');
    let bad = 0,
      max = 0;
    for (let i = 0; i < a.data.length; i += 3) {
      const d = Math.max(
        Math.abs(a.data[i] - b.data[i]),
        Math.abs(a.data[i + 1] - b.data[i + 1]),
        Math.abs(a.data[i + 2] - b.data[i + 2]),
      );
      if (d > 16) bad++;
      max = Math.max(max, d);
    }
    const pixels = a.info.width * a.info.height;
    const result = {
      layer,
      pose,
      width: a.info.width,
      height: a.info.height,
      sha256: hashes,
      identical: hashes[0] === hashes[1],
      thresholdChannel: 16,
      badPixels: bad,
      pixels,
      fraction: bad / pixels,
      maxChannelDelta: max,
      limit: 0.005,
      pass: bad / pixels <= 0.005,
    };
    results.push(result);
    console.log(
      layer,
      pose,
      result.fraction.toFixed(6),
      result.pass ? 'PASS' : 'FAIL',
    );
  }
await fs.writeFile(
  outFile,
  JSON.stringify({ results, pass: results.every((r) => r.pass) }, null, 2) +
    '\n',
);
process.exitCode = results.every((r) => r.pass) ? 0 : 1;
