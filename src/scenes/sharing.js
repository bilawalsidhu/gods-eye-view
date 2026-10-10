import { withShareSignal } from '../director/sharing/lifetime.js';
import { t } from '../i18n/index.js';
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
            : t('director.sharing.genericFailure');
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
      t('director.sharing.inventorySummary', {
        scenes: report.scenes,
        shots: report.shots,
        packs: report.packs.length,
      }),
    );
    for (const pack of report.packs)
      dialog.text(
        t('director.sharing.packLine', {
          scene: pack.scene,
          id: pack.id,
          status: pack.status,
          path: pack.path,
          attribution: pack.attribution.text,
          license: pack.attribution.license,
        }),
      );
    if (report.missingLayers.length)
      dialog.text(
        t('director.sharing.unavailableLayers', {
          layers: report.missingLayers.join(', '),
        }),
      );
    if (report.externalContent)
      dialog.text(t('director.sharing.externalContent'));
    if (report.bundledBytes)
      dialog.text(
        t('director.sharing.bundledBytes', { bytes: report.bundledBytes }),
      );
    return report;
  }
  async function preview(file) {
    const owner = open(t('director.sharing.reviewTitle'));
    if (!owner) return;
    const expected = currentProject();
    dialog.text(t('director.sharing.nothingApplied'));
    await run(owner, async () => {
      const input = await readSceneShare(file, { signal: owner.signal });
      if (!alive(owner)) return;
      staged = input;
      inventory(input);
      dialog.status.textContent = t('director.sharing.readyToImport');
      dialog.text(t('director.sharing.applyWarning'));
      const apply = dialog.button(t('director.sharing.applyImport'), () =>
        run(owner, async () => {
          if (expected !== currentProject())
            throw new Error(t('director.sharing.projectChanged'));
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
              dialog.status.textContent = t('director.sharing.notApplied');
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
      director._updateStatus(t('director.authoring.selectSceneShot'));
      return;
    }
    const owner = open(t('director.sharing.editTitle'));
    if (!owner) return;
    const original = structuredClone(director._project),
      expected = currentProject();
    dialog.text(t('director.sharing.editIntro'));
    const sceneText = dialog.input(
      t('director.sharing.anchorsInput'),
      json(subset(scene, sceneKeys)),
      { multiline: true },
    );
    const shotText = dialog.input(
      t('director.sharing.shotInput'),
      json(subset(shot, shotKeys)),
      { multiline: true },
    );
    const anchorName = dialog.input(
      t('director.sharing.anchorIdInput'),
      'anchor-1',
    );
    dialog.button(
      t('director.sharing.captureAnchor'),
      () =>
        run(owner, async () => {
          const details = JSON.parse(sceneText.value),
            camera = director.styleManager.getCameraState();
          if (!camera) throw new Error(t('director.sharing.cameraUnavailable'));
          const anchors = details.anchors || [];
          if (anchors.some((a) => a.id === anchorName.value))
            throw new Error(t('director.sharing.duplicateAnchor'));
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
          dialog.status.textContent = t('director.sharing.anchorAdded');
        }),
      dialog.body,
    );
    dialog.button(
      t('director.sharing.setMoveStart'),
      () =>
        run(owner, async () => {
          const details = JSON.parse(shotText.value),
            camera = director.styleManager.getCameraState();
          if (!camera) throw new Error(t('director.sharing.cameraUnavailable'));
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
          dialog.status.textContent = t('director.sharing.moveAdded');
        }),
      dialog.body,
    );
    dialog.button(
      t('director.sharing.ordinaryFlight'),
      () => {
        if (!alive(owner)) return;
        try {
          const details = JSON.parse(shotText.value);
          delete details.move;
          shotText.value = json(details);
        } catch {
          dialog.status.textContent = t('director.sharing.invalidShotJson');
        }
      },
      dialog.body,
    );
    const apply = dialog.button(t('director.sharing.applyDetails'), () =>
      run(owner, async () => {
        if (expected !== currentProject())
          throw new Error(t('director.sharing.projectChanged'));
        const project = editSceneDetails(
          original,
          scene.id,
          shot.id,
          JSON.parse(sceneText.value),
          JSON.parse(shotText.value),
        );
        const ok = await director.importProjectFile(
          {
            name: t('director.sharing.detailsName'),
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
      director._updateStatus(t('director.authoring.selectScene'));
      return;
    }
    const owner = open(t('director.sharing.shareTitle'));
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
    dialog.text(t('director.sharing.shareIntro'));
    dialog.button(t('director.sharing.downloadJson'), () => {
      if (alive(owner)) download(stringifySceneDocument(project), 'scene.json');
    });
    const files = dialog.input(t('director.sharing.chooseFiles'), '', {
      type: 'file',
    });
    files.multiple = true;
    const folder = dialog.input(t('director.sharing.chooseFolder'), '', {
      type: 'file',
    });
    folder.multiple = true;
    folder.setAttribute('webkitdirectory', '');
    dialog.button(t('director.sharing.downloadBundle'), () =>
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
              throw new Error(t('director.sharing.missingFile'));
            const file = matches[0];
            if (!file.size || file.size > PACK_LIMITS.bytes)
              throw new Error(t('director.sharing.assetSizeLimit'));
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
          dialog.status.textContent = t('director.sharing.bundleDownloaded');
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
