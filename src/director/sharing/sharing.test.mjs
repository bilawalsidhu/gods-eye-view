import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSceneBundle,
  parseSceneShare,
  readSceneShare,
  createBundleAssets,
  BUNDLE_SOURCE,
  SHARE_LIMITS,
} from './bundle.js';
import { describeSceneShare } from './preview.js';
import { editSceneDetails, selectSceneDocument } from '../authoring.js';
const bytes = new TextEncoder().encode(
  JSON.stringify({ type: 'FeatureCollection', features: [] }),
);
const fixture = () => ({
  version: 6,
  scenes: [
    {
      id: 'one',
      title: 'Example',
      dataPacks: [
        {
          id: 'data',
          version: 1,
          format: 'geojson',
          source: { adapter: 'assets', path: 'test/data.geojson' },
          attribution: {
            text: 'Example author',
            license: 'CC0-1.0',
            url: 'https://example.org/source',
          },
          placement: { altitudeReference: 'ellipsoid' },
        },
      ],
      shots: [
        {
          id: 'shot',
          title: 'Original',
          durationSec: 3,
          holdSec: 2,
          camera: { lat: 1, lon: 2, alt: 300, pitch: -60 },
          layers: { traffic: false },
          dataPackIds: ['data'],
        },
      ],
    },
    { id: 'other', shots: [] },
  ],
});
const asset = () => ({
  bytes: bytes.slice(),
  mimeType: 'application/geo+json',
});

test('selected-scene bundles round trip bytes and attribution without mutating the project or fetching', async () => {
  const original = fixture(),
    before = JSON.stringify(original);
  let reads = 0;
  const text = await createSceneBundle(
    selectSceneDocument(original, 'one'),
    () => {
      reads++;
      return asset();
    },
  );
  const parsed = await parseSceneShare(text);
  assert.equal(reads, 1);
  assert.equal(JSON.stringify(original), before);
  assert.equal(parsed.project.scenes.length, 1);
  const pack = parsed.project.scenes[0].dataPacks[0];
  assert.equal(pack.source.adapter, BUNDLE_SOURCE);
  assert.equal(pack.byteLength, bytes.length);
  assert.deepEqual(
    pack.attribution,
    original.scenes[0].dataPacks[0].attribution,
  );
  assert.deepEqual(parsed.assets.get(pack.source.path).bytes, bytes);
});

test('bundle rejects malformed bytes, unknown fields, traversal, duplicates, missing files and broken integrity', async () => {
  const valid = JSON.parse(await createSceneBundle(fixture(), () => asset()));
  const mutations = [
    (b) => (b.version = 2),
    (b) => (b.assets[0].path = '../secret'),
    (b) => (b.assets[0].base64 = 'A==='),
    (b) => (b.assets[0].base64 = '____'),
    (b) => (b.assets[0].base64 = btoa('different')),
    (b) => (b.assets[0].headers = {}),
    (b) => (b.assets[0].mimeType = 'text/html'),
    (b) => b.assets.push(b.assets[0]),
    (b) => (b.assets = []),
    (b) => (b.project.scenes[0].dataPacks[0].source.adapter = 'assets'),
    (b) => (b.project.scenes[0].dataPacks = []),
    (b) => (b.project.scenes[0].dataPacks[0].sha256 = '0'.repeat(64)),
    (b) => (b.assets = Array.from({ length: 65 }, () => b.assets[0])),
  ];
  for (const mutate of mutations) {
    const b = structuredClone(valid);
    mutate(b);
    await assert.rejects(parseSceneShare(JSON.stringify(b)));
  }
});

test('asset caps and declared integrity are enforced before creating a downloadable bundle', async () => {
  await assert.rejects(
    createSceneBundle(fixture(), () => ({
      bytes: new Uint8Array(8 * 1024 * 1024 + 1),
      mimeType: 'image/png',
    })),
    /limit/,
  );
  const p = fixture();
  p.scenes[0].dataPacks[0].sha256 = '0'.repeat(64);
  await assert.rejects(
    createSceneBundle(p, () => asset()),
    /integrity/,
  );
  await assert.rejects(
    createSceneBundle(fixture(), () => null),
    /select a file/,
  );
});

test('duplicate pack paths share one asset and reject conflicting integrity', async () => {
  const p = fixture();
  p.scenes[0].dataPacks.push({
    ...structuredClone(p.scenes[0].dataPacks[0]),
    id: 'second',
  });
  let reads = 0;
  const text = await createSceneBundle(p, () => {
    reads++;
    return asset();
  });
  assert.equal(reads, 1);
  assert.equal((await parseSceneShare(text)).assets.size, 1);
  p.scenes[0].dataPacks[1].byteLength = 1;
  await assert.rejects(
    createSceneBundle(p, () => asset()),
    /integrity/,
  );
});

test('preview reports unavailable sources/layers and missing bundle assets without applying anything', () => {
  const p = fixture();
  const report = describeSceneShare(
    { project: p, assets: new Map() },
    { sourceIds: [], layerIds: [] },
  );
  assert.equal(report.packs[0].status, 'Source unavailable');
  assert.deepEqual(report.missingLayers, ['traffic']);
  p.scenes[0].dataPacks[0].source.adapter = BUNDLE_SOURCE;
  assert.match(
    describeSceneShare({ project: p, assets: new Map() }).packs[0].status,
    /Missing bundle/,
  );
});

test('bundle byte owner releases replacement data and has no network fallback', async () => {
  const parsed = await parseSceneShare(
    await createSceneBundle(fixture(), () => asset()),
  );
  const store = createBundleAssets();
  store.replace(parsed.assets);
  const path = parsed.project.scenes[0].dataPacks[0].source.path;
  const first = store.source({ path });
  first.bytes[0] = 0;
  assert.deepEqual(store.source({ path }).bytes, bytes);
  const controller = new AbortController();
  controller.abort();
  assert.throws(() => store.source({ path, signal: controller.signal }));
  store.clear();
  assert.deepEqual(store.getState(), { count: 0, bytes: 0 });
  assert.throws(() => store.source({ path }), /unavailable/);
});

test('oversized files fail before reading and cancellation settles a stalled file without a late result', async () => {
  let reads = 0;
  await assert.rejects(
    readSceneShare({
      name: 'large.json',
      size: 6 * 1024 * 1024,
      text: () => {
        reads++;
      },
    }),
    /5 MiB/,
  );
  await assert.rejects(
    readSceneShare({
      name: 'large.gevbundle.json',
      size: SHARE_LIMITS.bytes + 1,
      text: () => {
        reads++;
      },
    }),
    /50 MiB/,
  );
  assert.equal(reads, 0);
  let resolve;
  const owner = new AbortController();
  const work = readSceneShare(
    { name: 'pending.json', text: () => new Promise((r) => (resolve = r)) },
    { signal: owner.signal },
  );
  owner.abort();
  await assert.rejects(work, /abort/i);
  resolve(JSON.stringify(fixture()));
});

test('cancelled bundle export never resolves another asset or produces partial output', async () => {
  let resolve;
  const owner = new AbortController();
  const work = createSceneBundle(
    fixture(),
    () => new Promise((r) => (resolve = r)),
    { signal: owner.signal },
  );
  owner.abort();
  await assert.rejects(work, /abort/i);
  resolve(asset());
});

test('details editing preserves content IDs, layers and provenance, rejects invalid drafts atomically', () => {
  const p = fixture(),
    before = JSON.stringify(p);
  p.scenes[0].shots[0].sourcePackId = 'existing';
  const scene = p.scenes[0],
    shot = scene.shots[0];
  const edited = editSceneDetails(
    p,
    'one',
    'shot',
    {
      anchors: [
        { id: 'a', lat: 1, lon: 2, alt: 400, altitudeReference: 'ellipsoid' },
      ],
      dataPacks: scene.dataPacks,
    },
    {
      camera: { anchorId: 'a' },
      durationSec: 4,
      holdSec: 0,
      dataPackIds: ['data'],
    },
  );
  assert.equal(edited.scenes[0].shots[0].sourcePackId, 'existing');
  assert.deepEqual(edited.scenes[0].shots[0].layers, shot.layers);
  assert.equal(edited.scenes[0].shots[0].id, 'shot');
  assert.throws(() =>
    editSceneDetails(
      p,
      'one',
      'shot',
      { anchors: [] },
      { camera: { anchorId: 'missing' } },
    ),
  );
  assert.throws(() =>
    editSceneDetails(p, 'one', 'shot', { source: 'remote' }, {}),
  );
  assert.throws(() =>
    editSceneDetails(p, 'one', 'shot', {}, { sourcePackId: 'replacement' }),
  );
  delete p.scenes[0].shots[0].sourcePackId;
  assert.equal(JSON.stringify(p), before);
});

test('long valid source filenames still produce an importable bundle', async () => {
  const p = fixture();
  p.scenes[0].dataPacks[0].source.path = 'x'.repeat(1024);
  const parsed = await parseSceneShare(
    await createSceneBundle(p, () => asset()),
  );
  assert.equal(parsed.assets.size, 1);
});
