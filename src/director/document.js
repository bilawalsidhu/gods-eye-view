/** Bounded, renderer-independent validation for authored scene documents. */
import {
  SCENE_DOCUMENT_LIMITS,
  fail,
  object,
  fields,
  string,
  number,
  optional,
  array,
  ids,
  uniqueId,
  jsonTree,
} from './documentFields.js';
import { validateSceneDataPacks } from './packs/manifest.js';
import { validateSceneCameras } from './cameraDocument.js';
export { SCENE_DOCUMENT_LIMITS, SceneDocumentError } from './documentFields.js';
import { validateSceneInteractions } from './interactions/document.js';
export const SCENE_DOCUMENT_VERSION = 6;

function visual(value, path, legacy) {
  fields(value, path, [
    'style',
    'bloom',
    'sharpen',
    'hud',
    'detection',
    'scope',
    'mapStack',
    'styleParams',
  ]);
  for (const key of ['style', 'mapStack']) optional(value, key, path, string);
  optional(value, 'styleParams', path, object);
  const specs = {
    bloom: { enabled: 'boolean', intensity: [-100, 10000], version: [1, 100] },
    sharpen: { enabled: 'boolean', intensity: [0, 100] },
    hud: { visible: 'boolean', variant: 'string' },
    detection: {
      mode: 'string',
      density: [0, 100],
      allocation: 'string',
      fadePct: [0, 100],
      outsideOpacityPct: [0, 100],
    },
    scope: { enabled: 'boolean', featherPct: [0, 100] },
  };
  for (const [key, spec] of Object.entries(specs))
    optional(value, key, path, (entry, field) => {
      fields(entry, field, Object.keys(spec));
      for (const [name, type] of Object.entries(spec))
        optional(entry, name, field, (item, at) => {
          if (Array.isArray(type)) number(item, at, ...type, legacy);
          else if (type === 'string') string(item, at);
          else if (typeof item !== 'boolean') fail(at, 'expected a boolean');
        });
    });
}

/** Validate a parsed scene project without mutating it or applying any state. */
export function validateSceneDocument(project) {
  jsonTree(project, '$', { nodes: 0 });
  fields(project, '$', [
    'version',
    'createdAt',
    'updatedAt',
    'installedBuiltInSceneIds',
    'scenes',
  ]);
  const version = Object.hasOwn(project, 'version') ? project.version : 1;
  if (![1, 2, 3, 4, 5, 6].includes(version))
    fail('$.version', 'unsupported scene project version');
  const legacy = version < 3;
  for (const key of ['createdAt', 'updatedAt'])
    optional(project, key, '$', string);
  optional(project, 'installedBuiltInSceneIds', '$', ids);
  array(project.scenes, '$.scenes', SCENE_DOCUMENT_LIMITS.scenes);
  const sceneIds = new Set();
  let shotCount = 0;
  project.scenes.forEach((scene, index) => {
    const path = `$.scenes[${index}]`;
    fields(scene, path, [
      'id',
      'title',
      'releaseLayerIds',
      'appliedShotPacks',
      'shots',
      ...(version >= 4 ? ['anchors'] : []),
      ...(version >= 5 ? ['dataPacks'] : []),
    ]);
    uniqueId(scene, path, sceneIds);
    optional(scene, 'title', path, (v, p) => string(v, p, 4096));
    optional(scene, 'releaseLayerIds', path, ids);
    optional(scene, 'appliedShotPacks', path, (packs, field) => {
      array(packs, field);
      const packIds = new Set();
      packs.forEach((pack, i) => {
        const at = `${field}[${i}]`;
        fields(pack, at, ['id', 'version', 'shotBindings']);
        string(pack.id, `${at}.id`);
        uniqueId(pack, at, packIds);
        optional(pack, 'version', at, (v, p) =>
          number(v, p, 1, 1000000, legacy),
        );
        optional(pack, 'shotBindings', at, (bindings, p) => {
          object(bindings, p);
          for (const [title, id] of Object.entries(bindings))
            string(id, `${p}.${title}`);
        });
      });
    });
    array(scene.shots, `${path}.shots`);
    shotCount += scene.shots.length;
    if (shotCount > SCENE_DOCUMENT_LIMITS.shots)
      fail(`${path}.shots`, 'too many shots in project');
    const shotIds = new Set();
    scene.shots.forEach((shot, i) => {
      const at = `${path}.shots[${i}]`;
      fields(shot, at, [
        'id',
        'title',
        'durationSec',
        'holdSec',
        'camera',
        'visual',
        'layers',
        'sourcePackId',
        'sourcePackVersion',
        ...(version >= 4 ? ['move'] : []),
        ...(version >= 5 ? ['dataPackIds'] : []),
        ...(version >= 6 ? ['interactions'] : []),
      ]);
      uniqueId(shot, at, shotIds);
      optional(shot, 'title', at, (v, p) => string(v, p, 4096));
      optional(shot, 'sourcePackId', at, string);
      optional(shot, 'sourcePackVersion', at, (v, p) =>
        number(v, p, 1, 1000000, legacy),
      );
      optional(shot, 'durationSec', at, (v, p) =>
        number(v, p, 0, 86400, legacy),
      );
      optional(shot, 'holdSec', at, (v, p) => number(v, p, 0, 86400, legacy));
      optional(shot, 'visual', at, (v, p) => visual(v, p, legacy));
      optional(shot, 'layers', at, (layers, field) => {
        object(layers, field);
        for (const [id, entry] of Object.entries(layers)) {
          string(id, field);
          if (typeof entry === 'boolean') continue;
          const p = `${field}.${id}`;
          fields(entry, p, ['enabled', 'params']);
          if (typeof entry.enabled !== 'boolean')
            fail(`${p}.enabled`, 'expected a boolean');
          optional(entry, 'params', p, object);
        }
      });
    });
    validateSceneCameras(scene, path, version);
    validateSceneDataPacks(scene, path);
    validateSceneInteractions(scene, path);
  });
  return project;
}

/** Read bounded JSON. No URLs, modules or actions are executed during import. */
export function parseSceneDocument(text) {
  if (
    typeof text !== 'string' ||
    text.length > SCENE_DOCUMENT_LIMITS.bytes ||
    new TextEncoder().encode(text).byteLength > SCENE_DOCUMENT_LIMITS.bytes
  )
    fail('$', 'file exceeds 5 MiB');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail('$', 'invalid JSON');
  }
  return validateSceneDocument(parsed);
}

/** Export authored project fields only; callers pass the project, never run state. */
export function stringifySceneDocument(project) {
  // Round-trip drops optional undefined fields created by the editor.
  const text = JSON.stringify(project, null, 2);
  parseSceneDocument(text);
  return text;
}
