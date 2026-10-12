import {
  fields,
  string,
  number,
  array,
  optional,
  fail,
} from '../documentFields.js';

export const PACK_LIMITS = Object.freeze({
  packs: 8,
  bytes: 8 * 1024 * 1024,
  totalBytes: 32 * 1024 * 1024,
  features: 2000,
  positions: 50000,
});

/** Asset names are relative directory paths, never requests or executable modules. */
export function validateAssetPath(value, path = 'source.path') {
  string(value, path, 1024);
  if (
    !value
      .split('/')
      .every((part) => /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(part))
  )
    fail(
      path,
      'expected a relative asset path without URL syntax or traversal',
    );
}

/** Validate one declarative pack; loading requires separately registered application adapters. */
export function validateDataPack(pack, path, anchorIds) {
  fields(pack, path, [
    'id',
    'version',
    'format',
    'source',
    'attribution',
    'placement',
    'byteLength',
    'sha256',
  ]);
  string(pack.id, `${path}.id`);
  if (pack.version !== 1) fail(`${path}.version`, 'unsupported pack version');
  if (!['geojson', 'image', 'media'].includes(pack.format))
    fail(`${path}.format`, 'unsupported pack format');
  fields(pack.source, `${path}.source`, ['adapter', 'path']);
  string(pack.source.adapter, `${path}.source.adapter`);
  validateAssetPath(pack.source.path, `${path}.source.path`);
  fields(pack.attribution, `${path}.attribution`, ['text', 'license', 'url']);
  string(pack.attribution.text, `${path}.attribution.text`, 4096);
  string(pack.attribution.license, `${path}.attribution.license`, 4096);
  optional(pack.attribution, 'url', `${path}.attribution`, (url, at) => {
    string(url, at, 2048);
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      fail(at, 'expected an HTTPS source link');
    }
    if (
      parsed.protocol !== 'https:' ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    )
      fail(
        at,
        'expected an HTTPS source link without credentials, query or fragment',
      );
  });
  optional(pack, 'byteLength', path, (v, at) => {
    number(v, at, 1, PACK_LIMITS.bytes, false);
    if (!Number.isInteger(v)) fail(at, 'expected an integer');
  });
  optional(pack, 'sha256', path, (v, at) => {
    if (typeof v !== 'string' || !/^[a-f0-9]{64}$/.test(v))
      fail(at, 'expected a lowercase SHA-256 digest');
  });
  const p = pack.placement,
    at = `${path}.placement`;
  fields(
    p,
    at,
    pack.format === 'image'
      ? ['bounds', 'height', 'altitudeReference']
      : pack.format === 'media'
        ? ['anchorId']
        : ['altitudeReference'],
  );
  if (pack.format === 'media') {
    if (!anchorIds.has(p.anchorId))
      fail(`${at}.anchorId`, 'unknown scene anchor');
  } else {
    if (p.altitudeReference !== 'ellipsoid')
      fail(`${at}.altitudeReference`, 'expected ellipsoid height in meters');
    if (pack.format === 'image') {
      array(p.bounds, `${at}.bounds`, 4);
      if (p.bounds.length !== 4)
        fail(`${at}.bounds`, 'expected west, south, east, north');
      p.bounds.forEach((v, i) =>
        number(
          v,
          `${at}.bounds[${i}]`,
          i % 2 ? -90 : -180,
          i % 2 ? 90 : 180,
          false,
        ),
      );
      if (p.bounds[0] >= p.bounds[2] || p.bounds[1] >= p.bounds[3])
        fail(`${at}.bounds`, 'expected increasing non-dateline bounds');
      number(p.height, `${at}.height`, -12000, 1e9, false);
    }
  }
}

/** Validate scene-local pack IDs and shot references without acquiring assets. */
export function validateSceneDataPacks(scene, path) {
  const packs = Object.hasOwn(scene, 'dataPacks') ? scene.dataPacks : [];
  array(packs, `${path}.dataPacks`, PACK_LIMITS.packs);
  const anchors = new Set((scene.anchors || []).map((a) => a.id));
  const seen = new Set();
  packs.forEach((pack, i) => {
    validateDataPack(pack, `${path}.dataPacks[${i}]`, anchors);
    if (seen.has(pack.id))
      fail(`${path}.dataPacks[${i}].id`, 'duplicate pack ID');
    seen.add(pack.id);
  });
  scene.shots.forEach((shot, i) => {
    optional(shot, 'dataPackIds', `${path}.shots[${i}]`, (ids, at) => {
      array(ids, at, PACK_LIMITS.packs);
      if (new Set(ids).size !== ids.length || ids.some((id) => !seen.has(id)))
        fail(at, 'expected distinct scene pack IDs');
    });
  });
}
