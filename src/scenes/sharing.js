import { withShareSignal } from '../director/sharing/lifetime.js';
import {
  readSceneShare,
  createSceneBundle,
  BUNDLE_SOURCE,
} from '../director/sharing/bundle.js';
import { describeSceneShare } from '../director/sharing/preview.js';
import { stringifySceneDocument } from '../director/document.js';
import {
  editSceneDetails,
  selectSceneDocument,
} from '../director/authoring.js';
import { createSceneDialog, mountSceneSharing } from '../ui/sceneSharing.js';
import { PACK_LIMITS } from '../director/packs/manifest.js';
import { t, tn } from '../i18n/index.js';

function download(text, name) {
  const url = URL.createObjectURL(
    new Blob([text], { type: 'application/json' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
    URL.revokeObjectURL(url);
  }
}
const subset = (value, keys) =>
  Object.fromEntries(
    keys
      .filter((key) => Object.hasOwn(value, key))
      .map((key) => [key, value[key]]),
  );
const sceneKeys = ['anchors', 'dataPacks'];
const shotKeys = [
  'camera',
  'move',
  'durationSec',
  'holdSec',
  'dataPackIds',
  'interactions',
];
const json = (value) => JSON.stringify(value, null, 2);
const mimeFor = (file) =>
  file.type ||
  {
    json: 'application/json',
    geojson: 'application/geo+json',
    png: 'image/png',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
  }[file.name.split('.').at(-1)];

/** Own staged imports, author drafts and share bytes separately from playback and project state. */
export function createSceneSharing(director) {
  let dialog,
    controller,
    disposed = false,
    staged = null,
    busy = false;
  const alive = (owner) =>
    !disposed && controller === owner && !owner.signal.aborted;
  function close() {
    controller?.abort();
    controller = null;
    dialog?.dispose();
    dialog = null;
    staged = null;
    busy = false;
  }
  function open(title) {
    close();
    if (disposed) return null;
    controller = new AbortController();
    dialog = createSceneDialog(title, close);
    return controller;
  }
  async function run(owner, job) {
    if (!alive(owner) || busy) return;
    busy = true;
    try {
      await job();
    } catch (error) {
      if (alive(owner))
        dialog.status.textContent =
          error?.name === 'SceneDocumentError'
            ? error.message
            : t(
                'Could not complete this action. Check the file, references and selected assets.',
              );
    } finally {
      if (alive(owner)) busy = false;
    }
  }
  const currentProject = () => json(director._project);
  function inventory(input) {
    const report = describeSceneShare(input, {
      sourceIds: director._dataPacks.sourceIds(),
      layerIds: director.dataManager.getAll().map((l) => l.id),
    });
    dialog.text(
      [
        tn(report.scenes, '{count} scene', '{count} scenes'),
        tn(report.shots, '{count} shot', '{count} shots'),
        tn(report.packs.length, '{count} data pack', '{count} data packs'),
      ].join(' · '),
    );
    for (const pack of report.packs)
      dialog.text(
        t(
          '{scene} / {pack}: {status}. File: {path}. {attribution} · {license}',
          {
            scene: pack.scene,
            pack: pack.id,
            status: t(pack.status),
            path: pack.path,
            attribution: pack.attribution.text,
            license: pack.attribution.license,
          },
        ),
      );
    if (report.missingLayers.length)
      dialog.text(
        t('Unavailable layers: {layers}', {
          layers: report.missingLayers.join(', '),
        }),
      );
    if (report.externalContent)
      dialog.text(
        t(
          'Uses registered content or linked media. Those external files are not included in a scene bundle. Their original notices still apply.',
        ),
      );
    if (report.bundledBytes)
      dialog.text(
        t(
          '{bytes} bundled bytes verified. Files stay in memory for this session. Reimport the bundle after reloading the app.',
          { bytes: report.bundledBytes },
        ),
      );
    return report;
  }
  async function preview(file) {
    const owner = open(t('Review scene import'));
    if (!owner) return;
    const expected = currentProject();
    dialog.text(t('Nothing is loaded or changed until you apply this file.'));
    await run(owner, async () => {
      const input = await readSceneShare(file, { signal: owner.signal });
      if (!alive(owner)) return;
      staged = input;
      inventory(input);
      dialog.status.textContent = t('Ready to import');
      dialog.text(
        t(
          'Apply replaces the current project. Export your current project first if you want to keep both.',
        ),
      );
      const apply = dialog.button(t('Apply import'), () =>
        run(owner, async () => {
          if (expected !== currentProject()) throw new Error('Project changed');
          apply.disabled = true;
          const ok = await director.importProjectFile(file, {
            prepared: input,
            expectedProject: expected,
            signal: owner.signal,
          });
          if (alive(owner)) {
            if (ok) close();
            else {
              apply.disabled = false;
              dialog.status.textContent = t(
                'Import was not applied. The current project may have changed.',
              );
            }
          }
        }),
      );
      apply.dataset.directorApplyImport = '';
    });
  }
  function edit() {
    const scene = director._getSelectedScene(),
      shot = scene?.shots.find((s) => s.id === director._selectedShotId);
    if (!scene || !shot) {
      director._updateStatus(t('Select a scene and shot first'));
      return;
    }
    const owner = open(t('Edit scene details'));
    if (!owner) return;
    const original = structuredClone(director._project),
      expected = currentProject();
    dialog.text(
      t(
        'Camera positions use degrees and meters above the ellipsoid. Drafts are validated before they replace your saved scene.',
      ),
    );
    const sceneText = dialog.input(
      t('Anchors and data packs'),
      json(subset(scene, sceneKeys)),
      { multiline: true },
    );
    const shotText = dialog.input(
      t('Shot camera, timing, packs and actions'),
      json(subset(shot, shotKeys)),
      { multiline: true },
    );
    const anchorName = dialog.input(t('New anchor ID'), 'anchor-1');
    dialog.button(
      t('Capture camera as anchor'),
      () =>
        run(owner, async () => {
          const details = JSON.parse(sceneText.value),
            camera = director.styleManager.getCameraState();
          if (!camera) throw new Error('Camera unavailable');
          const anchors = details.anchors || [];
          if (anchors.some((a) => a.id === anchorName.value))
            throw new Error('Duplicate anchor');
          details.anchors = [
            ...anchors,
            {
              id: anchorName.value,
              lat: camera.lat,
              lon: camera.lon,
              alt: camera.alt,
              altitudeReference: 'ellipsoid',
            },
          ];
          editSceneDetails(
            original,
            scene.id,
            shot.id,
            details,
            JSON.parse(shotText.value),
          );
          sceneText.value = json(details);
          dialog.status.textContent = t('Anchor added to draft');
        }),
      dialog.body,
    );
    dialog.button(
      t('Set move start to current camera'),
      () =>
        run(owner, async () => {
          const details = JSON.parse(shotText.value),
            camera = director.styleManager.getCameraState();
          if (!camera) throw new Error('Camera unavailable');
          details.move = {
            from: {
              ...subset(camera, [
                'lat',
                'lon',
                'alt',
                'heading',
                'pitch',
                'roll',
              ]),
              altitudeReference: 'ellipsoid',
            },
            easing: 'cubic-in-out',
          };
          if (!details.camera.anchorId)
            details.camera.altitudeReference = 'ellipsoid';
          details.durationSec = Math.max(0.2, details.durationSec || 3);
          editSceneDetails(
            original,
            scene.id,
            shot.id,
            JSON.parse(sceneText.value),
            details,
          );
          shotText.value = json(details);
          dialog.status.textContent = t(
            'Move added to draft; destination remains the shot camera',
          );
        }),
      dialog.body,
    );
    dialog.button(
      t('Use ordinary flight'),
      () => {
        if (!alive(owner)) return;
        try {
          const details = JSON.parse(shotText.value);
          delete details.move;
          shotText.value = json(details);
        } catch {
          dialog.status.textContent = t('Invalid shot JSON');
        }
      },
      dialog.body,
    );
    const apply = dialog.button(t('Apply details'), () =>
      run(owner, async () => {
        if (expected !== currentProject()) throw new Error('Project changed');
        const project = editSceneDetails(
          original,
          scene.id,
          shot.id,
          JSON.parse(sceneText.value),
          JSON.parse(shotText.value),
        );
        const ok = await director.importProjectFile(
          {
            name: 'scene details',
            text: async () => stringifySceneDocument(project),
          },
          {
            prepared: { project, assets: director._bundleAssets.snapshot() },
            expectedProject: expected,
            signal: owner.signal,
            selection: { sceneId: scene.id, shotId: shot.id },
          },
        );
        if (alive(owner) && ok) close();
      }),
    );
    apply.dataset.directorApplyDetails = '';
  }
  function share() {
    let project;
    try {
      project = selectSceneDocument(
        director._project,
        director._selectedSceneId,
      );
    } catch {
      director._updateStatus(t('Select a scene first'));
      return;
    }
    const owner = open(t('Share selected scene'));
    if (!owner) return;
    const paths = new Set(
      project.scenes.flatMap((s) =>
        (s.dataPacks || [])
          .filter((p) => p.source.adapter === BUNDLE_SOURCE)
          .map((p) => p.source.path),
      ),
    );
    const existing = new Map(
      [...director._bundleAssets.snapshot()].filter(([path]) =>
        paths.has(path),
      ),
    );
    staged = { project, assets: existing };
    inventory(staged);
    dialog.text(
      t(
        'Scene JSON preserves authored settings and attribution. It does not include asset files. Bundles include only pack files you choose here or previously imported bundle files.',
      ),
    );
    dialog.button(t('Download scene JSON'), () => {
      if (alive(owner)) download(stringifySceneDocument(project), 'scene.json');
    });
    const files = dialog.input(t('Choose data-pack files'), '', {
      type: 'file',
    });
    files.multiple = true;
    const folder = dialog.input(t('Or choose a data-pack folder'), '', {
      type: 'file',
    });
    folder.multiple = true;
    folder.setAttribute('webkitdirectory', '');
    dialog.button(t('Download asset bundle'), () =>
      run(owner, async () => {
        const selected = [...files.files, ...folder.files];
        const packs = project.scenes.flatMap((s) => s.dataPacks || []);
        const text = await createSceneBundle(
          project,
          async (pack, { signal }) => {
            if (
              pack.source.adapter === BUNDLE_SOURCE &&
              existing.has(pack.source.path)
            )
              return existing.get(pack.source.path);
            const exact = selected.filter(
              (f) =>
                f.webkitRelativePath === pack.source.path ||
                f.webkitRelativePath?.split('/').slice(1).join('/') ===
                  pack.source.path,
            );
            const name = pack.source.path.split('/').at(-1),
              matches = exact.length
                ? exact
                : selected.filter((f) => f.name === name);
            const keys = new Set(
              packs
                .filter((p) => p.source.path.split('/').at(-1) === name)
                .map((p) => JSON.stringify(p.source)),
            );
            if (matches.length !== 1 || (!exact.length && keys.size > 1))
              throw new Error('Missing or ambiguous file');
            const file = matches[0];
            if (!file.size || file.size > PACK_LIMITS.bytes)
              throw new Error('Asset size limit');
            const bytes = new Uint8Array(
              await withShareSignal(file.arrayBuffer(), signal),
            );
            signal.throwIfAborted();
            return { bytes, mimeType: mimeFor(file) };
          },
          { signal: owner.signal },
        );
        if (alive(owner)) {
          download(text, 'scene.gevbundle.json');
          dialog.status.textContent = t('Asset bundle downloaded');
        }
      }),
    );
  }
  const unmount = () => {};
  let removeToolbar = unmount;
  return {
    preview,
    edit,
    share,
    close,
    mount() {
      removeToolbar();
      removeToolbar = mountSceneSharing({ edit, share });
    },
    getState: () => ({
      open: !!dialog,
      busy,
      stagedAssets: staged?.assets.size || 0,
    }),
    destroy() {
      disposed = true;
      close();
      removeToolbar();
    },
  };
}
