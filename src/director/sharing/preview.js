import { msg } from '../../i18n/marker.js';
import { BUNDLE_SOURCE } from './bundle.js';

// Statuses stay English; scenes/sharing.js translates them for the dialog.

/** Describe an import without fetching assets, applying state or exposing source configuration. */
export function describeSceneShare(
  { project, assets },
  { sourceIds = [], layerIds = [] } = {},
) {
  const sources = new Set(sourceIds),
    layers = new Set(layerIds);
  const packs = project.scenes.flatMap((scene) =>
    (scene.dataPacks || []).map((pack) => ({
      scene: scene.title || scene.id,
      id: pack.id,
      path: pack.source.path,
      attribution: pack.attribution,
      status:
        pack.source.adapter === BUNDLE_SOURCE
          ? assets.has(pack.source.path)
            ? msg('Included in bundle')
            : msg('Missing bundle file — reimport its bundle')
          : sources.has(pack.source.adapter)
            ? msg('Source configured; file checked when loaded')
            : msg('Source unavailable'),
    })),
  );
  return {
    scenes: project.scenes.length,
    shots: project.scenes.reduce((n, s) => n + s.shots.length, 0),
    packs,
    missingLayers: [
      ...new Set(
        project.scenes.flatMap((s) =>
          s.shots.flatMap((shot) => Object.keys(shot.layers || {})),
        ),
      ),
    ].filter((id) => !layers.has(id)),
    externalContent: project.scenes.some(
      (s) =>
        s.appliedShotPacks?.length || s.shots.some((shot) => shot.sourcePackId),
    ),
    bundledBytes: [...assets.values()].reduce((n, a) => n + a.bytes.length, 0),
  };
}
