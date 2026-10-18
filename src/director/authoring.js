import { parseSceneDocument, stringifySceneDocument } from './document.js';

/** Build a validated immutable edit while preserving IDs, existing content and provenance. */
export function editSceneDetails(
  project,
  sceneId,
  shotId,
  sceneDetails,
  shotDetails,
) {
  const copy = parseSceneDocument(stringifySceneDocument(project));
  const scene = copy.scenes.find((s) => s.id === sceneId),
    shot = scene?.shots.find((s) => s.id === shotId);
  if (!scene || !shot) throw new Error('Select a scene and shot first');
  for (const key of Object.keys(sceneDetails))
    if (!['anchors', 'dataPacks'].includes(key))
      throw new Error('Unsupported scene detail');
  for (const key of Object.keys(shotDetails))
    if (
      ![
        'camera',
        'move',
        'durationSec',
        'holdSec',
        'dataPackIds',
        'interactions',
      ].includes(key)
    )
      throw new Error('Unsupported shot detail');
  for (const key of ['anchors', 'dataPacks']) {
    delete scene[key];
    if (Object.hasOwn(sceneDetails, key)) scene[key] = sceneDetails[key];
  }
  for (const key of [
    'camera',
    'move',
    'durationSec',
    'holdSec',
    'dataPackIds',
    'interactions',
  ]) {
    delete shot[key];
    if (Object.hasOwn(shotDetails, key)) shot[key] = shotDetails[key];
  }
  return parseSceneDocument(stringifySceneDocument(copy));
}

/** Export exactly one authored scene; no live state or service configuration is consulted. */
export function selectSceneDocument(project, sceneId) {
  const copy = parseSceneDocument(stringifySceneDocument(project));
  const scene = copy.scenes.find((s) => s.id === sceneId);
  if (!scene) throw new Error('Select a scene first');
  return { ...copy, scenes: [scene] };
}
