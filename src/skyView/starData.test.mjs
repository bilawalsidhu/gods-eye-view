import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import {
  CONSTELLATION_COUNT,
  MIN_STARS,
  SkyDataError,
  loadSkyData,
  parseSkyData,
  resetSkyDataCache,
} from './starData.js';

const dataUrl = (name) => new URL(`./data/${name}`, import.meta.url);
const raw = (name) => readFileSync(dataUrl(name));
const json = (name) => JSON.parse(raw(name).toString('utf8'));
const clone = (value) => structuredClone(value);

test('bundled catalogues validate: >= 8,500 stars, 88 constellations, every line endpoint resolves', () => {
  const { stars, hipIndex, constellations } = parseSkyData(
    json('stars.json'),
    json('constellations.json'),
  );
  assert.ok(stars.count >= MIN_STARS, `${stars.count} stars`);
  assert.equal(constellations.length, CONSTELLATION_COUNT);
  let endpoints = 0;
  for (const c of constellations)
    for (const chain of c.lines)
      for (const index of chain) {
        assert.ok(index >= 0 && index < stars.count, `${c.iau} endpoint`);
        endpoints += 1;
      }
  assert.ok(endpoints > 700);
  assert.ok(hipIndex.size > 8000);
  // Brightest first, Sirius by proper name; IAU set includes the usual suspects.
  assert.equal(stars.names.get(0), 'Sirius');
  assert.equal(stars.names.get(hipIndex.get(11767)), 'Polaris');
  const iau = new Set(constellations.map((c) => c.iau));
  for (const name of ['Ori', 'UMa', 'Cru', 'Ser', 'Oct'])
    assert.ok(iau.has(name), name);
  assert.equal(constellations.find((c) => c.iau === 'Ori').native, 'Orion');
});

test('every star is <= mag 6.5 or used by a constellation line', () => {
  const starsJson = json('stars.json');
  const lineHips = new Set(
    json('constellations.json').constellations.flatMap((c) => c.lines.flat()),
  );
  for (let i = 0; i < starsJson.count; i++)
    assert.ok(
      starsJson.mag[i] <= 6.5 || lineHips.has(starsJson.hip[i]),
      `star ${i}`,
    );
});

test('manifest checksums match the committed files and the gzipped total is <= 200 KB', (t) => {
  const manifest = json('manifest.json');
  let gz = 0;
  for (const [name, info] of Object.entries(manifest.outputs)) {
    const buffer = raw(name);
    assert.equal(
      createHash('sha256').update(buffer).digest('hex'),
      info.sha256,
      name,
    );
    assert.equal(buffer.length, info.bytes, name);
    gz += gzipSync(buffer, { level: 9 }).length;
  }
  assert.equal(manifest.counts.stars, json('stars.json').count);
  assert.equal(manifest.counts.constellations, CONSTELLATION_COUNT);
  assert.ok(gz <= 200 * 1024, `gzipped data ${gz} bytes`);
  t.diagnostic(`sky data gzipped total ${gz} bytes`);
});

test('schema validation rejects broken data with a useful message', () => {
  const stars = json('stars.json');
  const lines = json('constellations.json');
  const expectProblem = (s, c, pattern) =>
    assert.throws(
      () => parseSkyData(s, c),
      (error) =>
        error instanceof SkyDataError &&
        error.problems.some((p) => pattern.test(p)),
    );

  expectProblem({ ...stars, format: 'x' }, lines, /stars format/);
  expectProblem(stars, { ...lines, format: 'y' }, /constellations format/);

  const few = clone(stars);
  few.count = 100;
  expectProblem(few, lines, /star count 100/);

  const short = clone(stars);
  short.mag.pop();
  expectProblem(short, lines, /column mag length/);

  const badRa = clone(stars);
  badRa.ra[5] = 400;
  expectProblem(badRa, lines, /ra 400 out of range/);

  const dupHip = clone(stars);
  dupHip.hip[1] = dupHip.hip[0];
  expectProblem(dupHip, lines, /duplicate hip/);

  const missing = clone(lines);
  missing.constellations[0].lines[0][0] = 999_999_999;
  expectProblem(stars, missing, /HIP 999999999 not in star data/);

  const fewer = clone(lines);
  fewer.constellations.pop();
  expectProblem(stars, fewer, /constellation count 87/);

  const dupCon = clone(lines);
  dupCon.constellations[1].iau = dupCon.constellations[0].iau;
  expectProblem(stars, dupCon, /duplicate constellation/);

  const oneStar = clone(lines);
  oneStar.constellations[3].lines.push([oneStar.constellations[3].lines[0][0]]);
  expectProblem(stars, oneStar, /one-star line/);
});

test('loadSkyData fetches both files same-origin, validates, memoises, and retries after failure', async () => {
  resetSkyDataCache();
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(String(url));
    const name = String(url).split('/').at(-1);
    return { ok: true, status: 200, json: async () => json(name) };
  };
  const first = await loadSkyData({ fetchImpl });
  const second = await loadSkyData({ fetchImpl });
  assert.equal(first, second);
  assert.equal(seen.length, 2);
  assert.ok(
    seen.every(
      (url) => url.startsWith('file:') && /\/skyView\/data\//.test(url),
    ),
  );

  resetSkyDataCache();
  let calls = 0;
  const flaky = async (url) => {
    calls += 1;
    if (calls <= 2) return { ok: false, status: 503, json: async () => ({}) };
    return fetchImpl(url);
  };
  await assert.rejects(loadSkyData({ fetchImpl: flaky }), /503/);
  const recovered = await loadSkyData({ fetchImpl: flaky });
  assert.equal(recovered.constellations.length, 88);
  resetSkyDataCache();
});
