import { parseSceneDocument, stringifySceneDocument } from '../document.js';
import { withShareSignal } from './lifetime.js';
import { fields, array, fail } from '../documentFields.js';
import { PACK_LIMITS, validateAssetPath } from '../packs/manifest.js';

export const BUNDLE_SOURCE = 'scene-bundle';
export const SHARE_LIMITS = Object.freeze({
  bytes: 50 * 1024 * 1024,
  assets: 64,
});
const MIME = new Set([
  'application/json',
  'application/geo+json',
  'image/png',
  'video/mp4',
  'video/webm',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'audio/webm',
]);
const packsOf = (project) =>
  project.scenes.flatMap((scene) => scene.dataPacks || []);
const checkAbort = (signal) => signal?.throwIfAborted();
const digest = async (bytes) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    (n) => n.toString(16).padStart(2, '0'),
  ).join('');
function encode(bytes) {
  const chunks = [];
  for (let i = 0; i < bytes.length; i += 32768)
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + 32768)));
  return btoa(chunks.join(''));
}
function decode(value) {
  if (
    typeof value !== 'string' ||
    !value.length ||
    value.length > Math.ceil(PACK_LIMITS.bytes / 3) * 4 ||
    value.length % 4 !== 0 ||
    /[^A-Za-z0-9+/=]/.test(value) ||
    (value.includes('=') && !/^[A-Za-z0-9+/]+={1,2}$/.test(value))
  )
    fail('assets', 'invalid or oversized base64 asset');
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}
function checkBytes(bytes, total) {
  if (
    !(bytes instanceof Uint8Array) ||
    !bytes.length ||
    bytes.length > PACK_LIMITS.bytes ||
    total > PACK_LIMITS.totalBytes
  )
    fail('assets', 'asset byte limit exceeded');
}
function checkMime(mimeType) {
  if (!MIME.has(mimeType)) fail('assets', 'unsupported media type');
}

/** Read inert scene JSON or a bounded asset bundle, verifying bytes before admission. */
export async function parseSceneShare(text, { signal } = {}) {
  checkAbort(signal);
  if (
    typeof text !== 'string' ||
    text.length > SHARE_LIMITS.bytes ||
    new TextEncoder().encode(text).length > SHARE_LIMITS.bytes
  )
    fail('$', 'share exceeds 50 MiB');
  let input;
  try {
    input = JSON.parse(text);
  } catch {
    fail('$', 'invalid JSON');
  }
  if (input?.format !== 'gev-scene-bundle')
    return { project: parseSceneDocument(text), assets: new Map() };
  fields(input, '$', ['format', 'version', 'project', 'assets']);
  if (input.version !== 1) fail('version', 'unsupported bundle version');
  const project = parseSceneDocument(JSON.stringify(input.project));
  array(input.assets, 'assets', SHARE_LIMITS.assets);
  const assets = new Map();
  let total = 0;
  for (const entry of input.assets) {
    checkAbort(signal);
    fields(entry, 'assets', ['path', 'mimeType', 'base64', 'sha256']);
    validateAssetPath(entry.path);
    checkMime(entry.mimeType);
    if (assets.has(entry.path)) fail('assets', 'duplicate asset path');
    const bytes = decode(entry.base64);
    total += bytes.length;
    checkBytes(bytes, total);
    const hash = await digest(bytes);
    checkAbort(signal);
    if (entry.sha256 !== hash) fail('assets', 'asset integrity mismatch');
    assets.set(entry.path, { bytes, mimeType: entry.mimeType, sha256: hash });
  }
  const used = new Set();
  for (const pack of packsOf(project)) {
    if (pack.source.adapter !== BUNDLE_SOURCE)
      fail('project', 'bundle must include every declared pack');
    const asset = assets.get(pack.source.path);
    used.add(pack.source.path);
    if (
      !asset ||
      pack.byteLength !== asset.bytes.length ||
      pack.sha256 !== asset.sha256
    )
      fail('project', 'missing or mismatched bundle asset');
  }
  if (used.size !== assets.size) fail('assets', 'unreferenced bundle asset');
  return { project, assets };
}

/** File reads have a known budget before text decoding; large bundles use a distinct suffix. */
export async function readSceneShare(file, options) {
  const limit = file.name?.endsWith('.gevbundle.json')
    ? SHARE_LIMITS.bytes
    : 5 * 1024 * 1024;
  if (file.size > limit)
    fail(
      '$',
      limit === SHARE_LIMITS.bytes
        ? 'share exceeds 50 MiB'
        : 'file exceeds 5 MiB',
    );
  checkAbort(options?.signal);
  const text = await withShareSignal(file.text(), options?.signal);
  checkAbort(options?.signal);
  return parseSceneShare(text, options);
}

/** Export only explicitly supplied pack bytes; never fetch external assets or alter the source project. */
export async function createSceneBundle(
  project,
  resolveAsset,
  { signal } = {},
) {
  const copy = parseSceneDocument(stringifySceneDocument(project));
  const assets = [],
    known = new Map();
  let total = 0;
  for (const pack of packsOf(copy)) {
    checkAbort(signal);
    const key = JSON.stringify([pack.source.adapter, pack.source.path]);
    let entry = known.get(key);
    if (!entry) {
      if (assets.length >= SHARE_LIMITS.assets)
        fail('assets', 'too many bundled assets');
      const asset = await withShareSignal(
        resolveAsset(pack, { signal }),
        signal,
      );
      checkAbort(signal);
      if (!asset) fail('assets', 'select a file for every declared data pack');
      const bytes = asset.bytes;
      total += bytes?.length || 0;
      checkBytes(bytes, total);
      checkMime(asset.mimeType);
      const sha256 = await digest(bytes);
      checkAbort(signal);
      if (
        (pack.byteLength && pack.byteLength !== bytes.length) ||
        (pack.sha256 && pack.sha256 !== sha256)
      )
        fail('assets', 'selected file does not match declared integrity');
      const path = `files/${assets.length}-${pack.source.path.split('/').at(-1).slice(0, 160)}`;
      entry = {
        path,
        mimeType: asset.mimeType,
        base64: encode(bytes),
        sha256,
        byteLength: bytes.length,
      };
      known.set(key, entry);
      assets.push(entry);
    } else if (
      (pack.byteLength && pack.byteLength !== entry.byteLength) ||
      (pack.sha256 && pack.sha256 !== entry.sha256)
    )
      fail('assets', 'conflicting shared asset integrity');
    pack.source = { adapter: BUNDLE_SOURCE, path: entry.path };
    pack.byteLength = entry.byteLength;
    pack.sha256 = entry.sha256;
  }
  const text = JSON.stringify({
    format: 'gev-scene-bundle',
    version: 1,
    project: copy,
    assets: assets.map(({ byteLength, ...entry }) => entry),
  });
  if (new TextEncoder().encode(text).length > SHARE_LIMITS.bytes)
    fail('$', 'share exceeds 50 MiB');
  return text;
}

/** Keep bundled bytes in this project lifetime only; never fall back to a network source. */
export function createBundleAssets() {
  let assets = new Map();
  return {
    replace(next = new Map()) {
      assets = new Map(next);
    },
    clear() {
      assets.clear();
    },
    snapshot: () => new Map(assets),
    getState: () => ({
      count: assets.size,
      bytes: [...assets.values()].reduce((n, a) => n + a.bytes.length, 0),
    }),
    source({ path, signal, maxBytes = PACK_LIMITS.bytes }) {
      checkAbort(signal);
      validateAssetPath(path);
      const asset = assets.get(path);
      if (!asset || asset.bytes.length > maxBytes)
        throw new Error('Bundle asset unavailable — reimport the bundle');
      return { bytes: asset.bytes.slice(), mimeType: asset.mimeType };
    },
  };
}
