/**
 * @module scenes/director
 *
 * Deterministic cinematic scene playback engine for social-media clip capture.
 *
 * Manages a persistent project of scenes, each containing an ordered shot list.
 * Each shot stores camera position, visual style, post-processing state, HUD mode,
 * detection overlay, and data-layer toggles. During playback the director sequences
 * through shots with timed camera flights, hold pauses, and visual-state transitions,
 * while recording telemetry events for post-run metadata export.
 *
 * State is persisted to localStorage and can be exported/imported as JSON.
 */

import { resolveCameraPose, resolveCameraMove } from '../director/camera.js';
import { createCameraMotion } from './cameraMotion.js';
import { createStateChannel } from '../app/stateChannel.js';
import { SceneControls } from '../ui/scenes.js';
import { buildPlaybackQueue, playSceneQueue } from '../director/playback.js';
import { createScenePlaybackAdapter } from './playbackAdapter.js';
import * as Cesium from 'cesium';
import {
  SCENE_APPEND_RECIPES,
  SCENE_RECIPES,
  getSceneAppendRecipeById,
} from './recipes.js';
import { sceneLayerPlan, sceneRequiresContextModeExit } from './scenePolicy.js';
import { t } from '../i18n/index.js';
import { createSceneDataPacks } from './dataPacks/controller.js';
import { createSceneInteractions } from './interactions.js';
import { createSceneSharing } from './sharing.js';
import {
  createBundleAssets,
  BUNDLE_SOURCE,
  readSceneShare,
} from '../director/sharing/bundle.js';
import { createDefaultScenePacks } from './packs/defaults.js';
import {
  layerStatesForShot,
  visualStateForShot,
  effectiveShotHoldSec,
  shotRuntimeDurationSec,
} from './shotPresentation.js';
import { sceneTimingForShot, sceneSeekState } from '../director/timeline.js';
import { createPlaybackClock } from '../director/clock.js';
import {
  normalizeLayerEntry,
  PROJECT_VERSION,
  DEFAULT_SHOT_DURATION_SEC,
  DEFAULT_HOLD_SEC,
  uid,
  deepClone,
  recipeToScene,
  createDefaultProject,
  normalizeShot,
  normalizeProject,
} from './project.js';
import {
  parseSceneDocument,
  stringifySceneDocument,
  SceneDocumentError,
} from '../director/document.js';

// Built-in recipe DISPLAY names. Recipe ids, the URL 'scene' param, stored
// project titles, and voice-matching titles all stay English (keep-English
// boundary + persisted data); only the presentation of an UNRENAMED built-in
// localizes, so an operator's renamed scene is never masked by the catalog.
const RECIPE_TITLE_KEYS = Object.freeze({
  'flights-radar': 'setup.scenes.recipe.flightsRadar',
  'orbital-watch': 'setup.scenes.recipe.orbitalWatch',
  'thermal-threats': 'setup.scenes.recipe.thermalThreats',
  'city-overload': 'setup.scenes.recipe.cityOverload',
  'omniscience-pullback': 'setup.scenes.recipe.omnisciencePullback',
});

/**
 * Display title for a scene: the localized recipe name while the stored title
 * still matches the built-in verbatim, the stored title otherwise.
 * @param {{id?: string, title?: string}} scene
 * @returns {string}
 */
function displaySceneTitle(scene) {
  const key = RECIPE_TITLE_KEYS[scene?.id];
  if (!key) return scene?.title || '';
  const builtin = SCENE_RECIPES.find((recipe) => recipe.id === scene.id);
  return scene.title === builtin?.title ? t(key) : scene.title;
}

/** @constant {string} localStorage key for the serialized project */
const STORAGE_KEY = 'godsEyeView.sceneProject.v2';
const STORAGE_CHECKPOINT_KEY = 'godsEyeView.sceneProject.checkpoint.v1';
/**
 * Orchestrates deterministic cinematic scene playback.
 *
 * The director owns a mutable project (persisted in localStorage) containing
 * scenes and shots. It drives camera flights via Cesium, applies visual/style
 * state through the styleManager, toggles data layers via the dataManager, and
 * records timestamped telemetry events during each run for later export.
 */
export class SceneDirector {
  /**
   * @param {Cesium.Viewer} viewer - The Cesium viewer instance
   * @param {Object} styleManager - Controls visual state (bloom, sharpen, HUD, detection, style presets)
   * @param {Object} dataManager - Manages data layer enable/disable and per-layer params
   */
  constructor(
    viewer,
    styleManager,
    dataManager,
    {
      isMapStackAvailable = () => false,
      scenePacks = createDefaultScenePacks(),
      dataPacks = {},
    } = {},
  ) {
    this._destroyed = false;
    this._pendingWork = new Set();
    this.viewer = viewer;
    this.styleManager = styleManager;
    this.dataManager = dataManager;
    this._isMapStackAvailable = isMapStackAvailable;
    this._scenePacks = scenePacks;
    this._bundleAssets = createBundleAssets();
    this._dataPacks = createSceneDataPacks(viewer, {
      ...dataPacks,
      sources: {
        ...dataPacks.sources,
        [BUNDLE_SOURCE]: this._bundleAssets.source,
      },
    });
    this._sharing = createSceneSharing(this);
    this._interactionTransitions = 0;
    this._interactions = createSceneInteractions(viewer, {
      available: () =>
        !this._destroyed && !this._running && !this.viewer.trackedEntity,
      execute: (action, signal) =>
        this._trackWork(this._executeInteraction(action, signal)),
    });
    this._cameraMotion = createCameraMotion({
      applyPose: (pose) => this._setCameraView(pose),
    });
    const yieldCamera = (event) => {
      // A settled feature click belongs to the action picker, not a new camera gesture.
      if (
        event?.type === 'pointerdown' &&
        this._interactions?.getState().active
      )
        return;
      if (this._usesAuthoredCamera && !this._claimingCamera)
        this.stopScene('Camera ownership changed');
    };
    this._cameraHandoffUnsubscribe =
      styleManager.subscribeCameraHandoff?.(yieldCamera);
    const canvas = viewer.scene?.canvas;
    for (const event of ['pointerdown', 'wheel'])
      canvas?.addEventListener(event, yieldCamera, { passive: true });
    this._removeCameraInput = () => {
      for (const event of ['pointerdown', 'wheel'])
        canvas?.removeEventListener(event, yieldCamera);
    };

    /** @type {boolean} True while a scene run is in progress */
    this._running = false;
    this._previewRun = false;
    /** @type {{ cancelled: boolean }|null} Cancellation token for the active run */
    this._runToken = null;
    /** @type {number} Monotonic LOAD counter — only the newest LOAD may land */
    this._loadGeneration = 0;
    /** @type {number} Monotonic camera-travel id for layer-owned motion. */
    this._sceneTravelGeneration = 0;
    /** @type {{id:number,scene:Object,shot:Object,durationSec:number}|null} */
    this._activeSceneTravel = null;
    /** @type {AbortController|null} Aborts the active run's layer transitions */
    this._runAbort = null;
    /** @type {AbortController|null} Aborts the in-flight LOAD's layer transitions */
    this._loadAbort = null;
    this._clock = createPlaybackClock({
      isRunning: () => this._running,
      timingForShot: (scene, shot) => this._sceneTimingForShot(scene, shot),
      onProgress: (progress) => this._setProgress(progress),
    });
    this._runIdleResolvers = new Set();
    this._sceneSeekGeneration = 0;
    /** @type {Object|null} Telemetry accumulator for the current run */
    this._activeRun = null;
    /** @type {Object|null} Telemetry from the most recent completed run */
    this._lastRun = null;
    /** @type {string} JSON string of _lastRun for download */
    this._lastRunJson = '';

    this._project = this._loadProject();
    this._selectedSceneId = this._project.scenes[0]?.id || null;
    this._selectedShotId = this._project.scenes[0]?.shots[0]?.id || null;
    /** @type {string|null} Scene whose layer state most recently landed. */
    this._loadedSceneId = null;

    this._presentation = {
      status: this._storageReadError
        ? 'Saved project could not be read; storage preserved. Import a valid file to resume saving.'
        : t('setup.scenes.statusReady'),
      progress: 0,
      runtime: '',
      playbackActive: false,
      keyboardEnabled: false,
    };
    this._state = createStateChannel(() => ({
      ...this.getPlaybackStatus(),
      ...this._presentation,
      hasRun: !!this._lastRunJson,
    }));
    this._bootstrapLegacyShotPacks();
    // Upgrade only already-installed packs; unrelated Scenes are untouched.
    for (const scene of this._project.scenes) {
      for (const marker of [...(scene.appliedShotPacks || [])]) {
        const recipe = getSceneAppendRecipeById(marker.id);
        if (
          recipe?.expansionFromVersion &&
          marker.version > 0 &&
          marker.version <= recipe.expansionFromVersion
        ) {
          this.appendShotPack(scene.id, marker.id, {
            render: false,
            announce: false,
          });
        }
      }
    }
    this._initUI();
    this._visibilityUnsubscribe =
      this.dataManager.subscribeVisibilityRequests?.((change) => {
        if (
          change.enabled !== false ||
          !['user', 'voice', 'tool'].includes(change.origin)
        )
          return;
        const scene = this._getSelectedScene();
        if (!scene?.releaseLayerIds?.includes(change.layerId)) return;
        this.stopScene('Scene layer turned off');
      });
  }

  _trackWork(promise) {
    this._pendingWork ||= new Set();
    this._pendingWork.add(promise);
    const release = () => this._pendingWork.delete(promise);
    promise.then(release, release);
    return promise;
  }

  /** Stop playback and pending loads before releasing their viewer. */
  destroy() {
    if (this._destroyPromise) return this._destroyPromise;
    this._destroyed = true;
    this._sceneSeekGeneration++;
    this._visibilityUnsubscribe?.();
    this._cameraHandoffUnsubscribe?.();
    this._removeCameraInput?.();
    this._cameraMotion?.destroy();
    this._sharing?.destroy();
    this._bundleAssets?.clear();
    this._interactions?.destroy();
    this._dataPacks?.destroy();
    this._controls?.destroy();
    this._state.destroy();
    this._destroyPromise = Promise.resolve().then(async () => {
      this.stopScene('Stopped');
      this._loadAbort?.abort();
      this._loadGeneration++;
      this.viewer.camera.cancelFlight();
      clearTimeout(this._storageToastTimer);
      await Promise.allSettled(this._pendingWork || []);
      this._clock.destroy();
      this._cancelActiveSceneTravel();
    });
    return this._destroyPromise;
  }

  /**
   * Load and normalize the project from localStorage.
   * Returns the default recipe-based project on missing or corrupt data.
   * @returns {Object} Normalized project
   */
  _loadProject() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return createDefaultProject();
      const project = normalizeProject(parseSceneDocument(raw));
      const installed = new Set(project.installedBuiltInSceneIds || []);
      let migrated = false;
      for (const recipe of SCENE_RECIPES) {
        if (
          typeof recipe.installAlongsideSceneId !== 'string' ||
          installed.has(recipe.id)
        ) {
          continue;
        }
        let anchorIndex = project.scenes.findIndex(
          (scene) => scene.id === recipe.installAlongsideSceneId,
        );
        if (anchorIndex < 0 && recipe.installAlongsideFallbackSceneId) {
          anchorIndex = project.scenes.findIndex(
            (scene) => scene.id === recipe.installAlongsideFallbackSceneId,
          );
        }
        if (anchorIndex < 0) continue;
        const alreadyPresent = project.scenes.some(
          (scene) => scene.id === recipe.id || scene.title === recipe.title,
        );
        if (!alreadyPresent) {
          project.scenes.splice(anchorIndex + 1, 0, recipeToScene(recipe));
        }
        installed.add(recipe.id);
        migrated = true;
      }
      if (migrated) {
        project.installedBuiltInSceneIds = [...installed];
        try {
          const payload = JSON.stringify(project);
          parseSceneDocument(payload);
          localStorage.setItem(STORAGE_KEY, payload);
        } catch (e) {
          // Keep the migrated in-memory project usable even if this origin
          // refuses persistence; the normal UI save path will surface errors.
          console.warn(
            '[Scenes] Could not persist built-in scene migration:',
            e,
          );
        }
      }
      return project;
    } catch (error) {
      // Never overwrite an unreadable or newer saved document with defaults.
      this._storageReadError = error;
      return createDefaultProject();
    }
  }

  /** Persist the current project state to localStorage with an updated timestamp. */
  _saveProject() {
    if (this._storageReadError) {
      this._toastStorageError(
        'Scene not saved — existing saved project could not be read. Export edits or import a valid file.',
      );
      return;
    }
    this._project.updatedAt = new Date().toISOString();
    try {
      const payload = JSON.stringify(this._project);
      parseSceneDocument(payload);
      localStorage.setItem(STORAGE_KEY, payload);
    } catch (e) {
      // Private browsing / block-all-cookies / quota-exceeded throws here. The
      // in-memory project stays usable this session, but persistence failed —
      // tell the user instead of crashing the caller (M11).
      console.warn(
        '[Scenes] Could not persist project (storage unavailable):',
        e,
      );
      this._toastStorageError(
        e instanceof SceneDocumentError
          ? `Scene not saved — ${e.message}`
          : undefined,
      );
    }
  }

  /** Surface a "scene not saved" notice via the global toast + scene status line. */
  _toastStorageError(
    message = 'Scene not saved — browser storage unavailable',
  ) {
    this._updateStatus(message);
    try {
      const toast = document.getElementById('toast');
      if (toast) {
        toast.textContent = message;
        toast.classList.add('visible');
        clearTimeout(this._storageToastTimer);
        this._storageToastTimer = setTimeout(() => {
          toast.classList.remove('visible');
        }, 2600);
      }
    } catch {
      /* toast is best-effort */
    }
  }

  /** Immutable playback snapshots and completed editing actions. */
  subscribe(listener, options) {
    return this._state.subscribe(listener, options);
  }

  _publish(change) {
    this._state?.publish(change);
  }

  _shotOutcome(type, scene, shot, index = scene.shots.indexOf(shot)) {
    if (type === 'shot-loaded')
      this._presentation.status = t('setup.scenes.status.loaded', {
        scene: scene.title,
        shot: shot.title,
      });
    this._publish({
      type,
      sceneId: scene.id,
      sceneTitle: scene.title,
      shot,
      index,
    });
  }

  /**
   * Wire up all scene-panel DOM event listeners and render the initial UI state.
   * Exits silently if the scene-select element is missing (headless/test mode).
   */
  _initUI() {
    this._sharing?.mount();
    this._controls = new SceneControls({
      subscribe: (listener) => this.subscribe(listener),
      read: () => ({
        // Scene titles surface in the panel through SceneControls; built-in
        // recipe titles display their localized name until renamed by the user.
        scenes: this._project.scenes.map((scene) => ({
          ...scene,
          title: displaySceneTitle(scene),
        })),
        selectedSceneId: this._selectedSceneId,
        selectedShotId: this._selectedShotId,
        running: this._running,
        hasRun: !!this._lastRunJson,
      }),
      actions: {
        selectScene: (id) => {
          this._selectedSceneId = id;
          this._selectedShotId = this._getSelectedScene()?.shots[0]?.id || null;
          this._renderShotList();
        },
        selectShot: (id) => {
          this._selectedShotId = id;
          this._publish({ type: 'selection-changed' });
        },
        renameShot: (sceneId, shotId, title) => {
          const { scene, shot } = this._getShot(sceneId, shotId);
          if (!shot) return;
          shot.title = title.trim() || shot.title;
          this._saveProject();
          this._shotOutcome('shot-renamed', scene, shot);
        },
        create: (name) => this._createScene(name),
        deleteScene: () => this._deleteSelectedScene(),
        capture: () => this.captureShot(),
        update: () => this.updateSelectedShot(),
        start: (id) => this.startScene(id),
        stop: (reason) => this.stopScene(reason),
        next: () => this.runNextScene(),
        export: () => this.exportProject(),
        import: (file) => this.importProjectFile(file),
        reviewImport: (file) => this._sharing.preview(file),
        download: () => this.downloadLastRunMetadata(),
        load: (sceneId, shotId) => this.loadShot(sceneId, shotId),
        deleteShot: (sceneId, shotId) => this.deleteShot(sceneId, shotId),
      },
    });
  }

  /** Rebuild the scene dropdown options and sync the selected value. */
  _renderSceneSelect() {
    if (
      !this._project.scenes.some((scene) => scene.id === this._selectedSceneId)
    ) {
      this._selectedSceneId = this._project.scenes[0]?.id || null;
    }
    this._publish({ type: 'scene-options-changed' });
  }

  /**
   * Rebuild the shot list DOM for the currently selected scene.
   * Each shot row shows title, style/detection/duration metadata, and
   * LOAD/DEL action buttons. Supports click-to-select and double-click rename.
   */
  _renderShotList() {
    const scene = this._getSelectedScene();
    if (
      scene?.shots.length &&
      !scene.shots.some((shot) => shot.id === this._selectedShotId)
    ) {
      this._selectedShotId = scene.shots[0].id;
    }
    this._publish({ type: 'shots-changed' });
  }

  /**
   * Look up the currently selected scene object.
   * @returns {Object|null} The scene, or null if no valid selection
   */
  _getSelectedScene() {
    return (
      this._project.scenes.find(
        (scene) => scene.id === this._selectedSceneId,
      ) || null
    );
  }

  /**
   * Resolve a scene and shot by their IDs.
   * @param {string} sceneId
   * @param {string} shotId
   * @returns {{ scene: Object|undefined, shot: Object|undefined }}
   */
  _getShot(sceneId, shotId) {
    const scene = this._project.scenes.find((item) => item.id === sceneId);
    const shot = scene?.shots.find((item) => item.id === shotId);
    return { scene, shot };
  }

  /** Append a named empty scene after the controls accept the creation prompt. */
  _createScene(sceneName) {
    if (!sceneName) return;

    const scene = {
      id: uid('scene'),
      title: sceneName.trim() || `Scene ${this._project.scenes.length + 1}`,
      shots: [],
    };

    this._project.scenes.push(scene);
    this._selectedSceneId = scene.id;
    this._selectedShotId = null;
    this._saveProject();
    this._publish({ type: 'scene-created', scene });
  }

  /** Delete the currently selected scene after user confirmation. Resets to defaults if empty. */
  _deleteSelectedScene() {
    const scene = this._getSelectedScene();
    if (!scene) return;

    this._project.scenes = this._project.scenes.filter(
      (item) => item.id !== scene.id,
    );
    // Restore default recipes if the user deleted all scenes
    if (!this._project.scenes.length) {
      this._project = createDefaultProject();
    }

    this._selectedSceneId = this._project.scenes[0]?.id || null;
    this._selectedShotId = this._project.scenes[0]?.shots[0]?.id || null;
    this._saveProject();
    this._publish({ type: 'scene-deleted', scene });
  }

  /**
   * Snapshot the current enabled/params state of every registered data layer.
   * @returns {Object.<string, { enabled: boolean, params?: Object }>}
   */
  _captureLayerStates() {
    const layers = {};
    for (const layer of this.dataManager.getAll()) {
      const params = this.dataManager.getLayerParams(layer.id);
      layers[layer.id] = {
        enabled: !!layer.enabled,
        ...(params ? { params } : {}),
      };
    }
    return layers;
  }

  /**
   * Upgrade an exact legacy, browser-saved scene into the current shot
   * inventory. Recipe matching leaves unrelated user-authored scenes untouched.
   * The original project is checkpointed before the first mutation.
   */
  _bootstrapLegacyShotPacks() {
    for (const recipe of SCENE_APPEND_RECIPES) {
      const bootstrap = recipe.legacySceneBootstrap;
      if (!bootstrap || !Array.isArray(bootstrap.cameraPath)) continue;
      const expectedTitles = Array.isArray(bootstrap.fromShotTitles)
        ? bootstrap.fromShotTitles
        : [];
      const scene = this._project.scenes.find(
        (candidate) =>
          candidate.title === bootstrap.targetSceneTitle &&
          candidate.shots.length === expectedTitles.length &&
          candidate.shots.every(
            (shot, index) => shot.title === expectedTitles[index],
          ),
      );
      if (!scene) continue;

      const originalProject = deepClone(this._project);
      try {
        localStorage.setItem(
          STORAGE_CHECKPOINT_KEY,
          JSON.stringify(originalProject),
        );
      } catch {
        this._toastStorageError();
        continue;
      }

      const canonicalBase = recipeToScene({
        ...recipe,
        id: null,
        cameraPath: bootstrap.cameraPath,
      }).shots;
      for (
        let index = 0;
        index < Math.min(scene.shots.length, canonicalBase.length);
        index++
      ) {
        canonicalBase[index].id = scene.shots[index].id;
        canonicalBase[index].camera = deepClone(scene.shots[index].camera);
      }
      scene.shots = canonicalBase;

      const result = this.appendShotPack(scene.id, recipe.id, {
        writeCheckpoint: false,
        render: false,
        announce: false,
      });
      if (!result.appended) {
        this._project = originalProject;
        continue;
      }
      this._selectedSceneId = scene.id;
      this._selectedShotId = scene.shots[0]?.id || null;
    }
  }

  /**
   * Append a versioned shot pack to one exact persisted
   * Scene. Existing authored shots are never replaced, and the pack marker
   * makes repeat invocations idempotent.
   *
   * @param {string} sceneId Exact target Scene id
   * @param {string} packId Registered append-recipe id
   * @param {Object} [options]
   * @param {boolean} [options.writeCheckpoint=true]
   * @param {boolean} [options.render=true]
   * @param {boolean} [options.announce=true]
   * @returns {{appended: boolean, reason?: string, shotCount?: number, firstShotId?: string}}
   */
  appendShotPack(
    sceneId,
    packId,
    { writeCheckpoint = true, render = true, announce = true } = {},
  ) {
    const scene = this._project.scenes.find(
      (candidate) => candidate.id === sceneId,
    );
    if (!scene) return { appended: false, reason: 'scene-not-found' };
    const recipe = getSceneAppendRecipeById(packId);
    if (!recipe) return { appended: false, reason: 'pack-not-found' };
    scene.appliedShotPacks ||= [];
    const marker = scene.appliedShotPacks.find(
      (entry) => entry.id === recipe.id,
    );
    const targetVersion = Number(recipe.version) || 1;
    if ((Number(marker?.version) || 0) >= targetVersion) {
      return { appended: false, reason: 'already-appended' };
    }

    const pack = recipeToScene(recipe);
    const existingPackShots = scene.shots.filter(
      (shot) => shot.sourcePackId === recipe.id,
    );
    const expanding =
      recipe.expansionFromVersion &&
      marker?.version > 0 &&
      marker.version <= recipe.expansionFromVersion &&
      existingPackShots.length !== recipe.requiredSourcePackBeatIds.length;
    const existingPackBeatIds = existingPackShots.map(
      (shot) => shot.layers?.[recipe.requiredSourcePackLayerId]?.params?.beatId,
    );
    const previousSourcePackVariants = Array.isArray(
      recipe.previousRequiredSourcePackBeatIdVariants,
    )
      ? recipe.previousRequiredSourcePackBeatIdVariants
      : [recipe.previousRequiredSourcePackBeatIds];
    if (
      expanding &&
      !previousSourcePackVariants.some(
        (beatIds) =>
          JSON.stringify(existingPackBeatIds) === JSON.stringify(beatIds),
      )
    ) {
      return {
        appended: false,
        updated: false,
        reason: 'source-pack-mismatch',
      };
    }
    const adoptableTitles = new Set(
      Array.isArray(recipe.adoptExistingShotTitles)
        ? recipe.adoptExistingShotTitles
        : [],
    );
    const adoptedShotIds = new Map();
    if (expanding && adoptableTitles.size) {
      for (const packShot of pack.shots) {
        if (!adoptableTitles.has(packShot.title)) continue;
        const packBeatId =
          packShot.layers?.[recipe.requiredSourcePackLayerId]?.params?.beatId;
        if (
          existingPackShots.some(
            (shot) =>
              shot.layers?.[recipe.requiredSourcePackLayerId]?.params
                ?.beatId === packBeatId,
          )
        )
          continue;
        const candidates = scene.shots.filter(
          (shot) => !shot.sourcePackId && shot.title === packShot.title,
        );
        if (candidates.length === 1)
          adoptedShotIds.set(packShot.id, candidates[0].id);
      }
    }
    const appendedShots = marker
      ? expanding
        ? pack.shots.filter(
            (shot) =>
              !existingPackShots.some(
                (existing) =>
                  existing.layers?.[recipe.requiredSourcePackLayerId]?.params
                    ?.beatId ===
                  shot.layers?.[recipe.requiredSourcePackLayerId]?.params
                    ?.beatId,
              ) && !adoptedShotIds.has(shot.id),
          )
        : []
      : pack.shots;
    const nextShots = deepClone([...scene.shots, ...appendedShots]);
    for (const [packShotId, existingShotId] of adoptedShotIds) {
      const existingShot = nextShots.find((shot) => shot.id === existingShotId);
      const packShot = pack.shots.find((shot) => shot.id === packShotId);
      if (!existingShot || !packShot) continue;
      existingShot.sourcePackId = recipe.id;
      existingShot.sourcePackVersion = targetVersion;
      existingShot.layers = {
        ...deepClone(existingShot.layers || {}),
        ...deepClone(packShot.layers),
      };
    }
    if (expanding) {
      // Insert additions around existing beats, never replace their IDs/cameras.
      for (let i = pack.shots.length - 1; i >= 0; i--) {
        const added = appendedShots.find(
          (shot) => shot.id === pack.shots[i].id,
        );
        if (!added) continue;
        const at = nextShots.findIndex((shot) => shot.id === added.id);
        const [shot] = nextShots.splice(at, 1);
        const nextBeatId =
          pack.shots[i + 1]?.layers?.[recipe.requiredSourcePackLayerId]?.params
            ?.beatId;
        const before = nextShots.findIndex(
          (item) =>
            item.sourcePackId === recipe.id &&
            item.layers?.[recipe.requiredSourcePackLayerId]?.params?.beatId ===
              nextBeatId,
        );
        nextShots.splice(before < 0 ? nextShots.length : before, 0, shot);
      }
    }
    const requiredShotTitles = Array.isArray(recipe.requiredShotTitles)
      ? recipe.requiredShotTitles
      : [];
    const addedBindings = Object.fromEntries([
      ...appendedShots.map((shot) => [shot.title, shot.id]),
      ...[...adoptedShotIds]
        .map(([packShotId, existingShotId]) => [
          pack.shots.find((shot) => shot.id === packShotId)?.title,
          existingShotId,
        ])
        .filter(([title]) => typeof title === 'string'),
    ]);
    const markerBindings = marker?.shotBindings
      ? { ...marker.shotBindings, ...addedBindings }
      : null;
    if (requiredShotTitles.length) {
      const resolvedShots = markerBindings
        ? requiredShotTitles.map(
            (title) =>
              nextShots.find((shot) => shot.id === markerBindings[title]) ||
              null,
          )
        : nextShots;
      const inventoryMatches =
        resolvedShots.length === requiredShotTitles.length &&
        (markerBindings
          ? resolvedShots.every(Boolean) &&
            new Set(resolvedShots.map((shot) => shot.id)).size ===
              requiredShotTitles.length
          : resolvedShots.every(
              (shot, index) => shot.title === requiredShotTitles[index],
            ));
      if (!inventoryMatches) {
        this._updateStatus(
          `Cannot update ${recipe.title}: shot inventory changed`,
        );
        return {
          appended: false,
          updated: false,
          reason: 'shot-inventory-mismatch',
        };
      }
    }
    const requiredSourcePackBeatIds = Array.isArray(
      recipe.requiredSourcePackBeatIds,
    )
      ? recipe.requiredSourcePackBeatIds
      : [];
    const requiredSourcePackLayerId =
      typeof recipe.requiredSourcePackLayerId === 'string'
        ? recipe.requiredSourcePackLayerId
        : null;
    if (requiredSourcePackBeatIds.length && requiredSourcePackLayerId) {
      const sourcePackBeatIds = nextShots
        .filter((shot) => shot.sourcePackId === recipe.id)
        .map(
          (shot) => shot.layers?.[requiredSourcePackLayerId]?.params?.beatId,
        );
      const sourcePackMatches =
        sourcePackBeatIds.length === requiredSourcePackBeatIds.length &&
        sourcePackBeatIds.every(
          (beatId, index) => beatId === requiredSourcePackBeatIds[index],
        );
      if (!sourcePackMatches) {
        this._updateStatus(
          `Cannot update ${recipe.title}: evidence beats changed`,
        );
        return {
          appended: false,
          updated: false,
          reason: 'source-pack-mismatch',
        };
      }
    }

    const resolvePatchedShot = (patch) => {
      const boundShotId = markerBindings?.[patch.title];
      if (boundShotId)
        return nextShots.find((shot) => shot.id === boundShotId) || null;
      const matches = nextShots.filter((shot) => shot.title === patch.title);
      return matches.length === 1 ? matches[0] : null;
    };
    const resolvedPatches = (recipe.shotPatches || []).map((patch) => ({
      patch,
      shot: resolvePatchedShot(patch),
    }));
    if (resolvedPatches.some(({ shot }) => !shot)) {
      this._updateStatus(
        `Cannot update ${recipe.title}: shot bindings are incomplete`,
      );
      return {
        appended: false,
        updated: false,
        reason: 'shot-bindings-incomplete',
      };
    }

    let patchedShotCount = 0;
    for (const { patch, shot } of resolvedPatches) {
      if (patch.camera && !expanding) {
        shot.camera = normalizeShot({ ...shot, camera: patch.camera }).camera;
      }
      if (Number.isFinite(Number(patch.holdSec))) {
        shot.holdSec = Math.max(0, Number(patch.holdSec));
      }
      if (patch.visual) {
        shot.visual = normalizeShot({
          ...shot,
          visual: { ...shot.visual, ...patch.visual },
        }).visual;
      }
      shot.layers ||= {};
      for (const [layerId, target] of Object.entries(patch.layers || {})) {
        shot.layers[layerId] = normalizeLayerEntry(target);
      }
      patchedShotCount++;
    }
    const nextReleaseLayerIds = [
      ...new Set([
        ...(scene.releaseLayerIds || []),
        ...(pack.releaseLayerIds || []),
      ]),
    ];
    const shotBindings = Object.fromEntries(
      requiredShotTitles
        .map((title) => [
          title,
          nextShots.find((shot) => shot.id === markerBindings?.[title])?.id ??
            nextShots.find((shot) => shot.title === title)?.id,
        ])
        .filter(([, shotId]) => typeof shotId === 'string'),
    );

    if (writeCheckpoint) {
      try {
        localStorage.setItem(
          STORAGE_CHECKPOINT_KEY,
          JSON.stringify(this._project),
        );
      } catch {
        this._toastStorageError();
        return { appended: false, reason: 'checkpoint-failed' };
      }
    }

    scene.shots = nextShots;
    scene.releaseLayerIds = nextReleaseLayerIds;
    const nextMarker = {
      id: recipe.id,
      version: targetVersion,
      ...(Object.keys(shotBindings).length ? { shotBindings } : {}),
    };
    if (marker) {
      const markerIndex = scene.appliedShotPacks.indexOf(marker);
      scene.appliedShotPacks[markerIndex] = nextMarker;
    } else {
      scene.appliedShotPacks.push(nextMarker);
    }
    this._selectedSceneId = scene.id;
    this._selectedShotId = appendedShots[0]?.id || this._selectedShotId;
    this._saveProject();
    if (render) {
      this._renderSceneSelect();
      this._renderShotList();
    }
    if (announce) {
      this._updateStatus(
        marker
          ? `Updated ${patchedShotCount} ${patchedShotCount === 1 ? 'shot' : 'shots'}: ${recipe.title}`
          : `Appended ${appendedShots.length} shots: ${recipe.title}`,
      );
    }
    return {
      appended: appendedShots.length > 0,
      updated: Boolean(marker),
      shotCount: appendedShots.length,
      patchedShotCount,
      firstShotId: appendedShots[0]?.id,
    };
  }

  /**
   * Capture the current camera position, visual state, and layer states as a
   * new shot appended to the selected scene. No-op if no scene is selected.
   */
  captureShot() {
    const scene = this._getSelectedScene();
    if (!scene) return;

    const camera = this.styleManager.getCameraState();
    if (!camera) {
      this._updateStatus(t('setup.scenes.status.captureCameraNotReady'));
      return;
    }

    const shot = normalizeShot(
      {
        id: uid('shot'),
        title: t('setup.scenes.status.shotTitleDefault', {
          n: scene.shots.length + 1,
        }),
        durationSec: DEFAULT_SHOT_DURATION_SEC,
        holdSec: DEFAULT_HOLD_SEC,
        camera,
        visual: this.styleManager.getVisualState(),
        layers: this._captureLayerStates(),
      },
      scene.shots.length,
    );

    scene.shots.push(shot);
    this._selectedShotId = shot.id;
    this._saveProject();
    this._shotOutcome('shot-captured', scene, shot);
    this._updateStatus(
      t('setup.scenes.status.captured', {
        scene: scene.title,
        shot: shot.title,
      }),
    );
  }

  /**
   * Overwrite the currently selected shot's camera, visual, and layer states
   * with the live viewport state. Useful for fine-tuning a shot in-place.
   */
  updateSelectedShot() {
    const scene = this._getSelectedScene();
    if (!scene) return;

    const shot = scene.shots.find((item) => item.id === this._selectedShotId);
    if (!shot) {
      this._updateStatus(t('setup.scenes.status.selectShotFirst'));
      return;
    }

    const camera = this.styleManager.getCameraState();
    if (!camera) return;

    shot.camera = shot.move
      ? { ...camera, altitudeReference: 'ellipsoid' }
      : camera;
    shot.visual = this.styleManager.getVisualState();
    shot.layers = this._captureLayerStates();

    this._saveProject();
    this._shotOutcome('shot-updated', scene, shot);
    this._updateStatus(
      t('setup.scenes.status.updated', {
        scene: scene.title,
        shot: shot.title,
      }),
    );
  }

  /**
   * Delete a specific shot from a scene after user confirmation.
   * @param {string} sceneId
   * @param {string} shotId
   */
  deleteShot(sceneId, shotId) {
    const { scene, shot } = this._getShot(sceneId, shotId);
    if (!scene || !shot) return;

    const index = scene.shots.indexOf(shot);
    scene.shots = scene.shots.filter((item) => item.id !== shot.id);
    this._selectedShotId = scene.shots[0]?.id || null;
    this._saveProject();
    this._shotOutcome('shot-deleted', scene, shot, index);
  }

  /**
   * Load a single shot: apply its visual state, enable/disable layers, and fly
   * the camera to the shot's position. Blocked while a scene run is active.
   *
   * The newest LOAD wins. Two shot rows clicked in quick succession (or a
   * voice load landing on top of a click) both suspend on the visual and layer
   * awaits below; without a generation the OLDER request can complete second
   * and overwrite the operator's newer intent — the camera ends on shot A
   * while the panel reads shot B.
   *
   * @param {string} sceneId
   * @param {string} shotId
   * @param {Object} [options]
   * @param {number} [options.flyDuration=2.2] - Camera flight duration in seconds
   * @param {Object|null} [options.fromCamera=null] - Optional authored replay start pose
   * @param {Object|null} [options.sceneSeek=null] - Deterministic authored-clock snapshot
   */
  loadShot(sceneId, shotId, options) {
    if (this._destroyed)
      return Promise.resolve({ started: false, reason: 'destroyed' });
    this._sceneSeekGeneration++;
    this._interactionTransitions = 0;
    const previousGeneration = this._loadGeneration;
    const work = this._loadShot(sceneId, shotId, options);
    const generation = this._loadGeneration;
    const ownsLoad = generation !== previousGeneration;
    return this._trackWork(
      work.then(
        (result) => {
          if (
            ownsLoad &&
            !result?.started &&
            generation === this._loadGeneration
          )
            this._setSceneMediaPlayback();
          return result;
        },
        (error) => {
          if (ownsLoad && generation === this._loadGeneration)
            this._setSceneMediaPlayback();
          throw error;
        },
      ),
    );
  }

  async _loadShot(
    sceneId,
    shotId,
    {
      flyDuration = null,
      fromCamera = null,
      sceneSeek = null,
      playMedia = false,
    } = {},
  ) {
    if (this._running) return { started: false, reason: 'already-running' };
    const { scene, shot } = this._getShot(sceneId, shotId);
    if (!scene || !shot) return { started: false, reason: 'shot-not-found' };
    flyDuration ??= shot.move ? shot.durationSec : 2.2;
    const previousScene =
      this._project.scenes.find((item) => item.id === this._loadedSceneId) ||
      null;

    if (!this._claimCameraOwnership())
      return { started: false, reason: 'camera-unavailable' };
    if (fromCamera) this._setCameraView(fromCamera);

    // Supersede the previous LOAD before reserving this one: aborting first
    // means an in-flight layer transition is cancelled (and rolled back by the
    // manager) rather than merely ignored once it has already committed.
    this._cancelActiveSceneTravel();
    this._usesAuthoredCamera = !!shot.move;
    this._setSceneMediaPlayback();
    this._interactions?.clear();
    this._dataPacks?.clear();
    this._loadAbort?.abort();
    const controller = new AbortController();
    this._loadAbort = controller;
    const token = this._loadToken(++this._loadGeneration, controller.signal);
    this._clock.stopShot();
    this._setProgress(0);

    if (previousScene && previousScene.id !== scene.id) {
      const released = await this._releaseSceneLayers(previousScene, token);
      if (!released || token.cancelled) {
        if (!token.cancelled)
          this._updateStatus(`Could not leave scene: ${previousScene.title}`);
        return;
      }
      this._loadedSceneId = null;
    }

    this._selectedSceneId = scene.id;
    this._selectedShotId = shot.id;
    this._renderSceneSelect();
    this._renderShotList();

    await this.styleManager.applyVisualState(this._visualStateForShot(shot), {
      isCurrent: () => !token.cancelled,
    });
    if (token.cancelled) return;
    const seekState =
      sceneSeek && typeof sceneSeek === 'object' ? sceneSeek : null;
    // Previous-scene disable revokes media ownership. Grant the target only
    // after release and visual setup have succeeded for this live LOAD.
    if (playMedia && !seekState)
      this._setSceneMediaPlayback(scene, shot, token);
    const layerResult = await this._applyLayerStates(
      this._layerStatesForShot(scene, shot, {
        cameraSettled: seekState ? seekState.cameraProgress >= 1 : false,
        sceneSeek: seekState,
      }),
      token,
    );
    if (token.cancelled) return;
    // Layer state is already user-visible before the camera flight settles.
    // Record its owner now so a newer cross-scene LOAD can release it even if
    // it supersedes this request during the flight.
    this._loadedSceneId = scene.id;
    if (layerResult.refused.length) {
      if (this._loadAbort === controller) this._loadAbort = null;
      return { started: false, reason: 'layers-refused' };
    }
    if (!(await this._applyDataPacks(scene, shot, token)))
      return { started: false, reason: 'data-packs-unavailable' };
    if (token.cancelled) return;
    if (seekState) {
      this._setCameraView(
        seekState.camera || resolveCameraPose(scene, shot.camera),
      );
      this._setProgress(seekState.sceneProgress);
      this._publishSceneClock(scene, shot, seekState.sceneElapsedSec, {
        running: false,
        seeking: true,
      });
      if (this._loadAbort === controller) this._loadAbort = null;
      this._updateStatus(`Seeked: ${scene.title} / ${shot.title}`);
      this._activateInteractions(scene, shot);
      return { started: true, shotId };
    }
    const holdSec = this._effectiveShotHoldSec(scene, shot);
    const flightShare = flyDuration / Math.max(0.001, flyDuration + holdSec);
    const sceneTiming = this._sceneTimingForShot(scene, shot);
    this._startShotProgress(
      token,
      flyDuration,
      sceneTiming.startProgress,
      sceneTiming.startProgress + sceneTiming.durationProgress * flightShare,
      {
        scene,
        shot,
        sceneElapsedFrom: sceneTiming.startElapsedSec,
        sceneElapsedTo: sceneTiming.startElapsedSec + flyDuration,
      },
    );
    const cameraTravel = this._beginShotTravel(scene, shot, flyDuration);
    try {
      // Camera motion starts synchronously before yielding. Publish the
      // trail phase immediately afterward so its clock overlaps actual
      // camera motion, never an earlier asynchronous layer-reconcile wait.
      const flight = this._flyShotCamera(scene, shot, flyDuration, token);
      this._publishShotTravel(scene, shot, cameraTravel);
      await flight;
    } catch (error) {
      this._cancelActiveSceneTravel();
      if (!token.cancelled) {
        this._clock.stopShot();
      }
      throw error;
    }
    if (token.cancelled) return;
    this._settleShotLayerStates(scene, shot, token, cameraTravel);
    if (token.cancelled) return;
    this._startShotProgress(
      token,
      holdSec,
      sceneTiming.startProgress + sceneTiming.durationProgress * flightShare,
      sceneTiming.endProgress,
      {
        scene,
        shot,
        sceneElapsedFrom: sceneTiming.startElapsedSec + flyDuration,
        sceneElapsedTo: sceneTiming.endElapsedSec,
      },
    );

    if (this._loadAbort === controller) this._loadAbort = null;
    this._activateInteractions(scene, shot);
    this._shotOutcome('shot-loaded', scene, shot);
    this._updateRuntime('');
    return { started: true, shotId };
  }

  /**
   * Treat a scene-owned release layer as OFF in shots that do not declare it.
   * This keeps an appended event lens from leaking backward into the scene's
   * original authored shots while leaving ordinary sparse layer state intact.
   */
  _layerStatesForShot(scene, shot, options) {
    return layerStatesForShot(scene, shot, this._scenePacks, options);
  }

  /** Give opt-in media layers a transient, cancellable shot owner. */
  _setSceneMediaPlayback(scene = null, shot = null, token = null) {
    for (const module of this._sceneMediaModules || [])
      module.setSceneMediaPlayback();
    this._sceneMediaModules = new Set();
    if (!scene || !shot || !token || token.cancelled || token.signal?.aborted)
      return;
    for (const [id, state] of Object.entries(shot.layers || {})) {
      const module = this.dataManager?.layers?.get(id)?.module;
      if (
        !state?.enabled ||
        typeof module?.setSceneMediaPlayback !== 'function'
      )
        continue;
      module.setSceneMediaPlayback({
        sceneId: scene.id,
        shotId: shot.id,
        token,
      });
      this._sceneMediaModules.add(module);
    }
  }

  /** Keep installed append-pack shots on any surface declared by their source recipe. */
  _visualStateForShot(shot) {
    return visualStateForShot(
      shot,
      this._scenePacks,
      this._isMapStackAvailable,
    );
  }

  /** Keep a shot on its final camera pose until its authored layer reveal finishes. */
  _effectiveShotHoldSec(scene, shot, resolvedStates = null) {
    return effectiveShotHoldSec(scene, shot, this._scenePacks, resolvedStates);
  }

  /** Resolve one shot's authored flight plus any runtime-enforced hold. */
  _shotRuntimeDurationSec(scene, shot) {
    return shotRuntimeDurationSec(scene, shot, this._scenePacks);
  }

  /** Signal camera-dependent layers only after the authored flight completes. */
  _settleShotLayerStates(scene, shot, token = null, cameraTravel = null) {
    if (token?.cancelled) return false;
    const settledTravel = cameraTravel
      ? {
          ...cameraTravel,
          active: false,
          completed: true,
          cancelled: false,
        }
      : null;
    const states = this._layerStatesForShot(scene, shot, {
      cameraSettled: true,
      cameraTravel: settledTravel,
    });
    for (const [layerId, state] of Object.entries(states)) {
      if (
        !state?.enabled ||
        state.params?.sceneControls?.deferEvidenceUntilCameraSettled !== true
      ) {
        continue;
      }
      this.dataManager.setLayerParams(layerId, state.params, {
        origin: 'scene',
      });
    }
    if (this._activeSceneTravel?.id === cameraTravel?.id)
      this._activeSceneTravel = null;
    return !token?.cancelled;
  }

  /** Start one camera-owned travel phase that scene layers may follow. */
  _beginShotTravel(scene, shot, durationSec) {
    const travel = {
      id: ++this._sceneTravelGeneration,
      durationSec: Math.max(
        0.2,
        Number(durationSec) || DEFAULT_SHOT_DURATION_SEC,
      ),
      active: true,
      completed: false,
      cancelled: false,
    };
    this._activeSceneTravel = { ...travel, scene, shot };
    return travel;
  }

  /** Publish a travel phase only after Cesium has accepted the camera flight. */
  _publishShotTravel(scene, shot, cameraTravel) {
    const states = this._layerStatesForShot(scene, shot, { cameraTravel });
    for (const [layerId, state] of Object.entries(states)) {
      if (
        !state?.enabled ||
        state.params?.sceneControls?.evidencePathDuringCamera !== true
      )
        continue;
      this.dataManager.setLayerParams(layerId, state.params, {
        origin: 'scene',
      });
    }
  }

  /** Revoke layer-owned travel motion before a newer load, STOP, or teardown. */
  _cancelActiveSceneTravel() {
    this._cameraMotion?.cancel();
    this._usesAuthoredCamera = false;
    // The opening locator owns an additional delayed approach/orbit even after
    // the director's authored flight has settled. Revoke it before cancelling
    // the camera, whose moveEnd/complete callbacks may already be queued.
    this._scenePacks.cancelMotion(
      (id) => this.dataManager?.layers?.get(id)?.module,
    );
    const active = this._activeSceneTravel;
    if (!active) return false;
    this._activeSceneTravel = null;
    const cancelledTravel = {
      id: active.id,
      durationSec: active.durationSec,
      active: false,
      completed: false,
      cancelled: true,
    };
    const states = this._layerStatesForShot(active.scene, active.shot, {
      cameraSettled: false,
      cameraTravel: cancelledTravel,
    });
    for (const [layerId, state] of Object.entries(states)) {
      if (
        !state?.enabled ||
        state.params?.sceneControls?.evidencePathDuringCamera !== true
      )
        continue;
      let cancelled = false;
      try {
        cancelled =
          this.dataManager.setLayerParams(layerId, state.params, {
            origin: 'scene',
          }) !== false;
      } catch (error) {
        console.warn(
          `[Scenes] Could not cancel camera-led state for ${layerId}:`,
          error,
        );
      }
      if (cancelled) continue;
      // Fail closed: an exceptional manager/module must not leave its previous
      // RAF or deadline clock moving after STOP or a superseding LOAD.
      try {
        Promise.resolve(
          this.dataManager.setEnabled(layerId, false, { origin: 'scene' }),
        ).catch((error) =>
          console.warn(
            `[Scenes] Could not disable stale layer ${layerId}:`,
            error,
          ),
        );
      } catch (error) {
        console.warn(
          `[Scenes] Could not disable stale layer ${layerId}:`,
          error,
        );
      }
    }
    return true;
  }

  /** Replay exactly one authored shot from its preceding pose while keeping panels visible. */
  async replayShot(sceneId, shotId) {
    if (this._destroyed) return { started: false, reason: 'destroyed' };
    if (this._running) return { started: false, reason: 'already-running' };
    const { scene, shot } = this._getShot(sceneId, shotId);
    if (!scene || !shot) return { started: false, reason: 'shot-not-found' };
    const shotIndex = scene.shots.findIndex(({ id }) => id === shot.id);
    const previousShot =
      scene.shots[(shotIndex - 1 + scene.shots.length) % scene.shots.length];
    const result = await this.loadShot(sceneId, shotId, {
      playMedia: true,
      flyDuration: shot.durationSec || DEFAULT_SHOT_DURATION_SEC,
      fromCamera: shot.move
        ? null
        : resolveCameraPose(scene, previousShot?.camera),
    });
    return result || { started: false, reason: 'cancelled' };
  }

  /** Continue through this scene's remaining shots without entering recording preview. */
  async continueScene(sceneId, shotId) {
    const { scene, shot } = this._getShot(sceneId, shotId);
    if (!scene || !shot) return { started: false, reason: 'shot-not-found' };
    return this.startScene(sceneId, {
      single: true,
      afterShotId: shotId,
      preview: false,
    });
  }

  /** Load the adjacent shot inside one scene without wrapping at either end. */
  async loadAdjacentShot(sceneId, shotId, direction) {
    if (this._destroyed) return false;
    if (this._running) return false;
    const scene = this._project.scenes.find(({ id }) => id === sceneId);
    const shotIndex = scene?.shots?.findIndex(({ id }) => id === shotId) ?? -1;
    const targetIndex = shotIndex + (direction < 0 ? -1 : 1);
    const target = scene?.shots?.[targetIndex];
    if (!target) return false;
    const result = await this.loadShot(scene.id, target.id);
    return result?.started === true;
  }

  /** Resolve absolute authored-clock timing for one shot. */
  _sceneTimingForShot(scene, shot) {
    return sceneTimingForShot(scene, shot, (scene, shot) =>
      this._shotRuntimeDurationSec(scene, shot),
    );
  }

  /** Resolve a normalized scene-clock position to a shot, phase, and camera pose. */
  _sceneSeekState(scene, progress) {
    return sceneSeekState(
      scene,
      progress,
      (scene, shot) => this._shotRuntimeDurationSec(scene, shot),
      (scene, shot) => this._effectiveShotHoldSec(scene, shot),
    );
  }

  /** Read timing diagnostics without exposing timer handles or mutable clock state. */
  getPlaybackTimingState() {
    return {
      activeTimers:
        this._clock.activeTimers + (this._cameraMotion?.active ? 1 : 0),
      snapshot: this._clock.snapshot,
    };
  }

  /** Subscribe a scene-owned panel to the authoritative authored clock. */
  subscribeSceneClock(listener) {
    return this._clock.subscribe(listener);
  }

  /** Publish one authoritative scene-clock snapshot to attached panels. */
  _publishSceneClock(scene, shot, sceneElapsedSec, options) {
    return this._clock.publish(scene, shot, sceneElapsedSec, options);
  }

  /** Wait for an interrupted run to release camera and layer ownership. */
  _waitForRunIdle() {
    if (!this._running) return Promise.resolve();
    return new Promise((resolve) => this._runIdleResolvers.add(resolve));
  }

  /** Apply a new time inside the already-loaded shot without rebuilding its stack. */
  _seekLoadedShot(scene, seekState) {
    if (this._destroyed) return false;
    const shot = seekState?.shot;
    if (
      !scene ||
      !shot ||
      shot.dataPackIds?.length ||
      shot.interactions?.length ||
      this._loadedSceneId !== scene.id ||
      this._selectedShotId !== shot.id
    )
      return false;
    if (!this._claimCameraOwnership()) return false;
    this._cancelActiveSceneTravel();
    this._loadAbort?.abort();
    this._loadAbort = null;
    this._loadGeneration += 1;
    this._clock.stopShot();
    const states = this._layerStatesForShot(scene, shot, {
      cameraSettled: seekState.cameraProgress >= 1,
      sceneSeek: seekState,
    });
    let applied = true;
    for (const [layerId, state] of Object.entries(states)) {
      if (!state?.enabled || !state.params) continue;
      if (
        this.dataManager.setLayerParams(layerId, state.params, {
          origin: 'scene',
        }) === false
      ) {
        applied = false;
      }
    }
    if (!applied) return false;
    this._setCameraView(
      seekState.camera || resolveCameraPose(scene, shot.camera),
    );
    this._setProgress(seekState.sceneProgress);
    this._publishSceneClock(scene, shot, seekState.sceneElapsedSec, {
      running: false,
      seeking: true,
    });
    this._updateStatus(`Seeked: ${scene.title} / ${shot.title}`);
    return true;
  }

  /** Seek the complete authored scene state to an exact clock position. */
  seekScene(sceneId, progress) {
    if (this._destroyed) return Promise.resolve(false);
    this.stopScene('Seeking scene clock');
    const generation = ++this._sceneSeekGeneration;
    return this._trackWork(this._seekScene(sceneId, progress, generation));
  }

  async _seekScene(sceneId, progress, generation) {
    const scene = this._project.scenes.find(({ id }) => id === sceneId);
    if (!scene?.shots?.length) return false;
    if (this._running) {
      await this._waitForRunIdle();
    }
    if (this._destroyed || generation !== this._sceneSeekGeneration)
      return false;
    const seekState = this._sceneSeekState(scene, progress);
    if (!seekState) return false;
    if (this._seekLoadedShot(scene, seekState)) return true;
    const result = await this._loadShot(scene.id, seekState.shot.id, {
      sceneSeek: seekState,
    });
    return (
      !this._destroyed &&
      generation === this._sceneSeekGeneration &&
      result?.started === true
    );
  }

  /**
   * Cancellation token for one LOAD, reading "a newer LOAD (or a scene run)
   * has since been requested". Live rather than latched, so a supersession
   * that happens mid-await is seen the moment the await resolves; the signal
   * lets the awaited work itself be cancelled instead of merely disowned.
   * @param {number} generation - The generation this LOAD reserved
   * @param {AbortSignal} [signal] - Abort signal for this LOAD's manager calls
   * @returns {{ cancelled: boolean, signal: AbortSignal|undefined }}
   */
  _loadToken(generation, signal = undefined) {
    const director = this;
    return {
      signal,
      get cancelled() {
        return (
          director._destroyed ||
          signal?.aborted ||
          director._loadGeneration !== generation
        );
      },
    };
  }

  /**
   * Claim camera ownership for a scene flight through the shared navigation
   * policy, releasing any tracked contact, voice orbit, or in-flight tween
   * first. Two writers on the camera is the documented jitter failure mode
   * (see src/data/trackedCamera.js and the orbit refusal in src/cameraVerbs.js),
   * and the policy is also where Cockpit gets to refuse.
   * @returns {boolean} False when the camera is unavailable (Cockpit/disposed).
   */
  _claimCameraOwnership() {
    // Older/headless style managers may predate the facade — proceed then.
    if (typeof this.styleManager?.runImmediateNavigation !== 'function')
      return true;
    let claimed;
    this._claimingCamera = true;
    try {
      claimed = this.styleManager.runImmediateNavigation('scene', () => true);
    } finally {
      this._claimingCamera = false;
    }
    if (claimed === false) {
      this._updateStatus(t('setup.scenes.status.cameraUnavailable'));
      return false;
    }
    return true;
  }

  /** Place the camera at an authored replay start pose without an intermediate flight. */
  _setCameraView(cameraState) {
    if (!cameraState || typeof this.viewer?.camera?.setView !== 'function')
      return false;
    this.styleManager?.clearSearchedLocation?.();
    this.viewer.camera.cancelFlight?.();
    this.viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(
        cameraState.lon,
        cameraState.lat,
        cameraState.alt,
      ),
      orientation: {
        heading: Cesium.Math.toRadians(cameraState.heading || 0),
        pitch: Cesium.Math.toRadians(cameraState.pitch ?? -35),
        roll: Cesium.Math.toRadians(cameraState.roll || 0),
      },
    });
    return true;
  }

  /**
   * Build a flat playback queue of { scene, shot } pairs starting from the
   * given scene and wrapping around through all remaining scenes (round-robin).
   * @param {string} startSceneId - Scene to begin playback from
   * @returns {Array<{ scene: Object, shot: Object }>}
   */
  _buildPlaybackQueue(startSceneId, { single = false } = {}) {
    return buildPlaybackQueue(this._project.scenes, startSceneId, { single });
  }

  /**
   * Lists scenes for voice/scripting consumers.
   * @returns {Array<{id: string, title: string, shots: number}>}
   */
  listScenes() {
    return this._project.scenes.map((scene) => ({
      id: scene.id,
      title: scene.title,
      shots: scene.shots.length,
    }));
  }

  /**
   * Finds a scene by id, exact title, or case-insensitive title substring.
   * @param {string} query - Scene id or (partial) title.
   * @returns {{id: string, title: string, shots: number}|null}
   */
  findSceneByQuery(query) {
    const q = String(query ?? '')
      .trim()
      .toLowerCase();
    if (!q) return null;
    const scene =
      this._project.scenes.find((item) => item.id === query) ||
      this._project.scenes.find((item) => item.title.toLowerCase() === q) ||
      this._project.scenes.find((item) => item.title.toLowerCase().includes(q));
    return scene
      ? { id: scene.id, title: scene.title, shots: scene.shots.length }
      : null;
  }

  /**
   * Playback status snapshot for voice read-back.
   * @returns {{running: boolean, selectedSceneId: string|null, sceneCount: number}}
   */
  getPlaybackStatus() {
    return {
      running: this._running,
      selectedSceneId: this._selectedSceneId,
      selectedShotId: this._selectedShotId,
      elapsedMs: this._activeRun
        ? Math.max(0, Date.now() - Date.parse(this._activeRun.startedAt))
        : null,
      estimatedDurationMs: this._activeRun
        ? Math.round(this._activeRun.estimatedDurationSec * 1000)
        : null,
      sceneCount: this._project.scenes.length,
    };
  }

  /** @returns {boolean} Whether a scene run is currently in progress */
  get running() {
    return this._running;
  }

  /**
   * Start a full scene run beginning at the given scene.
   *
   * Enters recording mode (hides panels, enables safe frame), then iterates
   * through the playback queue applying each shot's visual state, toggling
   * layers, flying the camera, and pausing for the hold duration. Each shot
   * transition is logged as a telemetry event. The run can be cancelled via
   * Escape or the stop button (checked between shots and during sleeps).
   *
   * @param {string} [sceneId] - Scene to start from; defaults to the current selection
   * @param {object} [options]
   * @param {boolean} [options.single=false] - Play only the named scene instead of
   *   round-robining through the whole project (voice playback uses this).
   * @param {string|null} [options.afterShotId=null] - Begin after this shot without wrapping
   * @param {boolean} [options.preview=true] - Enter recording preview and release the scene on exit
   * @returns {Promise<{started: boolean, reason?: string, shots?: number}>}
   */
  startScene(sceneId, options) {
    if (this._destroyed)
      return Promise.resolve({ started: false, reason: 'destroyed' });
    this._sceneSeekGeneration++;
    return this._trackWork(this._startScene(sceneId, options));
  }

  async _startScene(
    sceneId,
    { single = false, afterShotId = null, preview = true } = {},
  ) {
    if (this._running) return { started: false, reason: 'already-running' };

    let queue = this._buildPlaybackQueue(
      sceneId || this._selectedSceneId || this._project.scenes[0]?.id,
      { single },
    );
    if (afterShotId !== null) {
      const index = queue.findIndex(
        ({ scene, shot }) => scene.id === sceneId && shot.id === afterShotId,
      );
      if (index < 0) return { started: false, reason: 'shot-not-found' };
      queue = queue.slice(index + 1);
      if (!queue.length) return { started: false, reason: 'scene-complete' };
    }
    if (!queue.length) {
      this._updateStatus(t('setup.scenes.status.noShotsToRun'));
      return { started: false, reason: 'no-shots' };
    }

    // Playback owns the camera for the whole run, so claim it the way every
    // other camera consumer does. Without this the follow camera keeps writing
    // the tracked contact's frame while each shot flies, and the run ends with
    // trackedEntity still set half a world from where the camera actually is.
    if (!this._claimCameraOwnership()) {
      return { started: false, reason: 'camera-unavailable' };
    }

    // A run supersedes any LOAD still suspended on its own awaits, so that
    // load cannot land a stale shot's layers on top of the run's first shot.
    // Aborting cancels a layer transition already in flight; bumping the
    // generation disowns everything the load has not yet started.
    this._setSceneMediaPlayback();
    this._cancelActiveSceneTravel();
    this._interactions?.clear();
    this._dataPacks?.clear();
    this._loadAbort?.abort();
    this._loadAbort = null;
    this._loadGeneration++;
    this._clock.stopShot();

    this._usesAuthoredCamera = queue.some(({ shot }) => !!shot.move);

    // Transition to running state
    this._running = true;
    this._previewRun = preview;
    if (preview) this._setPlaybackActive(true);
    this._setButtons(true);
    this._setProgress(0);

    // Create a cancellation token shared across async steps. Held in a local
    // as well: _finishRun() clears this._runToken, so the loop must not read
    // cancellation off the instance after cleanup has started. Its signal is
    // what actually stops in-flight manager work when STOP arrives — the
    // boolean alone only stops the NEXT step.
    this._runAbort = new AbortController();
    this._runToken = { cancelled: false, signal: this._runAbort.signal };
    const token = this._runToken;
    if (preview) {
      this.styleManager.setRecordingMode(true, {
        hidePanels: true,
        hudMode: 'full',
        safeFrame: '16:9',
      });
    }

    // Pre-compute total duration for the progress bar
    const estimatedDurationSec = queue.reduce((sum, item) => {
      return (
        sum +
        (item.shot.durationSec || 0) +
        this._effectiveShotHoldSec(item.scene, item.shot)
      );
    }, 0);

    // Initialize telemetry accumulator for this run
    this._activeRun = {
      recipeId: `project-${PROJECT_VERSION}`,
      title: 'Editable Scene Run',
      startedAt: new Date().toISOString(),
      estimatedDurationSec,
      scenesRun: queue.length,
      events: [],
    };

    this._startProgressTicker(estimatedDurationSec || 1);
    this._logEvent('scene_run_start', { count: queue.length });
    this._setPlaybackKeyboardEnabled(true);

    try {
      await playSceneQueue(queue, {
        token,
        adapter: createScenePlaybackAdapter(this, DEFAULT_SHOT_DURATION_SEC),
        previousScene: this._project.scenes.find(
          (scene) => scene.id === this._loadedSceneId,
        ),
        releaseOnFinish: preview,
      });
    } catch (error) {
      this._updateStatus(
        t('setup.scenes.status.runError', {
          message: error.message || 'run failed',
        }),
      );
      this._logEvent('scene_run_error', {
        message: error.message || 'unknown error',
      });
    } finally {
      this._finishRun();
    }
  }

  /**
   * Advance to the next shot in the playback queue (wrapping around) and load
   * it without starting a full run. Used for manual step-through navigation.
   */
  async runNextScene() {
    if (this._destroyed || this._running) return;

    const queue = this._buildPlaybackQueue(
      this._selectedSceneId || this._project.scenes[0]?.id,
    );
    if (!queue.length) return;

    // Find the shot after the current selection, wrapping to the start
    let next = queue[0];
    if (this._selectedShotId) {
      const idx = queue.findIndex(
        (item) => item.shot.id === this._selectedShotId,
      );
      if (idx >= 0) next = queue[(idx + 1) % queue.length];
    }

    await this.loadShot(next.scene.id, next.shot.id);
  }

  /**
   * Cancel the active scene run. Sets the cancellation token, aborts the
   * run's in-flight layer transitions and Cesium camera flight, and logs a
   * stop event.
   *
   * The abort is the part that stops work already under way: a layer
   * transition awaited by _applyLayerStates cannot see a boolean, and without
   * the signal it commits after the operator has stopped — leaving the layer
   * enabled while the post-await check skips its params. The manager rolls an
   * aborted enable back through the module's own disable().
   *
   * @param {string} [reason='Stopped'] - Human-readable cancellation reason
   */
  stopScene(reason = 'Stopped') {
    this._setSceneMediaPlayback();
    this._interactions?.clear();
    this._dataPacks?.clear();
    this._sceneSeekGeneration++;
    this._loadAbort?.abort();
    this._loadAbort = null;
    this._loadGeneration++;
    this._clock.stopShot();
    this._cancelActiveSceneTravel();
    this.viewer.camera.cancelFlight();
    this._clock.stop();
    if (!this._running || !this._runToken) return;
    this._runToken.cancelled = true;
    this._runAbort?.abort();
    this._updateStatus(reason);
    this._logEvent('scene_stopped', { reason });
  }

  /** Apply only the shot's declared packs through registered sources. */
  async _applyDataPacks(scene, shot, token) {
    try {
      return (await this._dataPacks?.apply(scene, shot, token)) ?? true;
    } catch (error) {
      if (!token?.cancelled) this._updateStatus(error.message);
      return false;
    }
  }

  /** Copied resource state for lifecycle checks and diagnostics. */
  getDataPackState() {
    return this._dataPacks?.getState() || { status: 'idle', count: 0 };
  }

  /** Activate only after LOAD/seek settles. Running timelines never branch automatically. */
  _activateInteractions(scene, shot) {
    try {
      this._interactions?.activate(shot, this._dataPacks.getTargets());
    } catch (error) {
      this._updateStatus(error.message);
    }
  }

  /** Execute a validated action through the existing camera and layer admission paths. */
  async _executeInteraction(action, signal) {
    if (signal.aborted || this._running || this._destroyed) return false;
    const { scene, shot } = this._getShot(
      this._selectedSceneId,
      this._selectedShotId,
    );
    if (!scene || !shot) return false;
    if (action.type === 'focus') {
      if (!this._claimCameraOwnership()) return false;
      this._cancelActiveSceneTravel();
      this._clock.stopShot();
      return this._setCameraView(
        resolveCameraPose(scene, { anchorId: action.anchorId, pitch: -90 }),
      );
    }
    if (action.type === 'layer') {
      if (
        !this.dataManager.getAll().some((layer) => layer.id === action.layerId)
      )
        return false;
      return this.dataManager.setEnabled(action.layerId, action.enabled, {
        signal,
        origin: 'scene',
      });
    }
    if (action.type === 'shot') {
      if (this._interactionTransitions >= 64) {
        this._updateStatus(
          'Scene transition limit reached — load a shot to reset',
        );
        return false;
      }
      this._interactionTransitions++;
      // Replacement clears this action's owner; the new LOAD owns its own cancellation.
      const target = scene.shots.find((item) => item.id === action.shotId);
      return this.seekScene(
        scene.id,
        this._sceneTimingForShot(scene, target).startProgress,
      );
    }
    return false;
  }

  /** Copied interaction state for lifecycle diagnostics. */
  getInteractionState() {
    return (
      this._interactions?.getState() || {
        active: false,
        busy: false,
        selected: null,
        count: 0,
      }
    );
  }

  /** Copied authoring and bundled-byte diagnostics for lifecycle checks. */
  getSharingState() {
    return {
      ...this._sharing?.getState(),
      assets: this._bundleAssets?.getState() || { count: 0, bytes: 0 },
    };
  }

  /** Export the entire project as a timestamped JSON file download. */
  exportProject() {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `scene-presets-${stamp}.json`;
    let payload;
    try {
      payload = stringifySceneDocument(this._project);
    } catch (error) {
      this._updateStatus(`Export failed: ${error.message}`);
      return;
    }
    // Trigger a browser download via a temporary anchor element
    const blob = new Blob([payload], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    this._presentation.status = t('setup.scenes.status.projectExported');
    this._publish({ type: 'project-exported', project: this._project });
  }

  /**
   * Import a project from a user-selected JSON file, replacing the current project.
   * The file is normalized/migrated on load; invalid JSON shows an error status.
   * @param {File} file - Browser File object from an <input type="file">
   */
  async importProjectFile(
    file,
    { prepared, expectedProject, selection, signal } = {},
  ) {
    const generation = (this._importGeneration =
      (this._importGeneration || 0) + 1);
    try {
      if (!prepared) this._sharing?.close();
      const input = prepared || (await readSceneShare(file, { signal }));
      if (signal?.aborted) return false;
      if (this._destroyed || generation !== this._importGeneration)
        return false;
      const project = normalizeProject(
        parseSceneDocument(stringifySceneDocument(input.project)),
      );
      if (
        expectedProject &&
        expectedProject !== JSON.stringify(this._project, null, 2)
      )
        return false;
      // Validate before touching playback, selection or the saved project.
      this.stopScene('Importing project');
      await Promise.allSettled([...(this._pendingWork || [])]);
      if (this._destroyed || generation !== this._importGeneration) return;
      if (
        signal?.aborted ||
        (expectedProject &&
          expectedProject !== JSON.stringify(this._project, null, 2))
      )
        return false;
      this._project = project;
      const retainedPaths = new Set(
        project.scenes.flatMap((scene) =>
          (scene.dataPacks || [])
            .filter((pack) => pack.source.adapter === BUNDLE_SOURCE)
            .map((pack) => pack.source.path),
        ),
      );
      this._bundleAssets?.replace(
        new Map(
          [...(input.assets || [])].filter(([path]) => retainedPaths.has(path)),
        ),
      );
      this._storageReadError = null;
      this._selectedSceneId =
        selection?.sceneId || project.scenes[0]?.id || null;
      this._selectedShotId =
        selection?.shotId || project.scenes[0]?.shots[0]?.id || null;
      this._loadedSceneId = null;
      this._saveProject();
      this._publish({ type: 'project-imported', project });
      this._updateStatus(`Imported ${file.name}`);
      return true;
    } catch (error) {
      if (
        signal?.aborted ||
        this._destroyed ||
        generation !== this._importGeneration
      )
        return false;
      this._updateStatus(
        error instanceof SceneDocumentError
          ? `Import failed: ${error.message}`
          : 'Import failed (could not read JSON file)',
      );
    }
  }

  /** Download the telemetry metadata from the most recent completed run as JSON. */
  downloadLastRunMetadata() {
    if (!this._lastRunJson) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `scene-run-${stamp}.json`;
    const blob = new Blob([this._lastRunJson], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  /**
   * Reconcile data layer states to match the shot's target configuration.
   * Only layers the shot declares are touched — see src/scenes/scenePolicy.js
   * for why undeclared layers are left alone.
   *
   * Two things this pass owes the operator:
   *  - An isolating Context mode is left FIRST. Space Missions refuses every
   *    unrelated enable, so a shot applied inside it composes a scene nobody
   *    authored (see _exitIsolatingContextMode).
   *  - A refused layer is reported. setEnabled() answers false when a guard
   *    vetoes the transition; swallowing that answer is how playback came to
   *    claim success over a scene it never assembled.
   *
   * The token's signal is handed to every transition, so a stop or a newer
   * request cancels the layer that is CURRENTLY moving rather than only the
   * ones not started yet. Checking the boolean after the await is a backstop:
   * by then an un-aborted transition has already committed, and the pass would
   * return without its params — the layer left on with stale ones.
   *
   * Cancellation is read BEFORE the refusal branch on purpose: an aborted
   * transition also answers false, and reporting the operator's own stop as a
   * refused layer would be a lie.
   *
   * @param {Object.<string, { enabled: boolean, params?: Object }>} targetStates
   * @param {{ cancelled: boolean, signal?: AbortSignal }|null} [token]
   *   Cancellation token — a stop or a newer request ends the pass and aborts
   *   the transition in flight.
   * @returns {Promise<{ applied: string[], refused: string[], cancelled: boolean }>}
   */
  async _applyLayerStates(targetStates, token = null) {
    const applied = [];
    const refused = [];
    const abort = () => ({ applied, refused, cancelled: true });
    if (token?.cancelled) return abort();

    // Deliberately NOT aborted: leaving an isolating mode IS the restore to
    // the operator's pre-mode state, which is exactly where a stopped scene
    // should come to rest. Tearing that transaction in half would strand
    // Context, so it completes and cancellation is honoured immediately after.
    await this._exitIsolatingContextMode();
    if (token?.cancelled) return abort();

    const signal = token?.signal;
    const registered = new Set(
      this.dataManager.getAll().map((layer) => layer.id),
    );
    for (const { id, enabled, params } of sceneLayerPlan(
      targetStates,
      registered,
    )) {
      let settled;
      if (params && typeof this.dataManager.restoreLayerState === 'function') {
        const outcome = await this.dataManager.restoreLayerState(
          id,
          { enabled, params },
          { ...(signal ? { signal } : {}), origin: 'scene' },
        );
        settled = outcome?.succeeded === true;
      } else {
        settled = await this.dataManager.setEnabled(id, enabled, {
          ...(signal ? { signal } : {}),
          origin: 'scene',
        });
      }
      if (token?.cancelled) return abort();
      if (settled === false) {
        refused.push(id);
        console.warn(
          `[Scenes] Layer refused: ${id} → ${enabled ? 'on' : 'off'}`,
        );
        continue;
      }
      if (params && typeof this.dataManager.restoreLayerState !== 'function') {
        this.dataManager.setLayerParams(id, params, { origin: 'scene' });
      }
      applied.push(id);
    }

    if (refused.length) {
      this._updateStatus(`Layers refused: ${refused.join(', ')}`);
      this._logEvent('shot_layers_refused', { layerIds: [...refused] });
    }
    return { applied, refused, cancelled: false };
  }

  /**
   * Release only the layers a scene explicitly owns beyond its final shot.
   * Normal recipes remain sparse and leave undeclared operator layers alone.
   * Event lenses opt into this hook so their panels, imagery, and map-stack
   * ownership cannot leak into the next recipe or survive a stopped run.
   *
   * @param {Object|null} scene - Scene carrying optional releaseLayerIds
   * @param {{ cancelled?: boolean, signal?: AbortSignal }} [token] - Optional LOAD/run token
   * @returns {Promise<boolean>} True only when every owned layer is released
   */
  async _releaseSceneLayers(scene, token = null) {
    this._interactions?.clear();
    this._dataPacks?.clear();
    const layerIds = Array.isArray(scene?.releaseLayerIds)
      ? scene.releaseLayerIds
      : [];
    let released = true;
    for (const layerId of layerIds) {
      if (token?.cancelled) return false;
      try {
        const settled = await this.dataManager.setEnabled(layerId, false, {
          origin: 'scene',
          signal: token?.signal,
        });
        if (settled === false) {
          released = false;
          console.warn(
            `[Scenes] Scene-owned layer refused release: ${layerId}`,
          );
          this._logEvent('scene_layer_release_refused', {
            sceneId: scene.id,
            layerId,
          });
        }
      } catch (error) {
        released = false;
        console.warn(
          `[Scenes] Scene-owned layer release failed: ${layerId}`,
          error,
        );
        this._logEvent('scene_layer_release_error', {
          sceneId: scene.id,
          layerId,
          message: error?.message || 'unknown error',
        });
      }
    }
    return released && !token?.cancelled;
  }

  /**
   * Leave a Context mode that isolates the globe, before a shot's layers land.
   *
   * Space Missions is the shipped case. It is a destructive-exclusive mode: a
   * guard refuses every enable outside its own replay bundle, so a recipe that
   * declares flights/satellites/earthquakes/traffic gets all four refused —
   * and Orbital Watch, whose satellites the guard does permit, would still
   * play over the mode's rocket-launches replay it never declared. Either way
   * the shot is not the composition it describes.
   *
   * The old full-registry reconcile dismantled the mode by accident, as part
   * of forcing every undeclared layer off. Declaring the exit is the honest
   * version of that: the decision is read off the policy guard itself, so a
   * future isolating mode is covered without being named here.
   *
   * @returns {Promise<boolean>} Whether a mode was exited.
   */
  async _exitIsolatingContextMode() {
    // Older/headless style managers may predate the Context facade.
    if (typeof this.styleManager?.getContextModeState !== 'function')
      return false;
    if (typeof this.styleManager?.setContextMode !== 'function') return false;

    const state = this.styleManager.getContextModeState() || {};
    // A mode still being entered already owns the guard, so it counts.
    const mode = state.entering || state.mode || null;
    if (!sceneRequiresContextModeExit(mode)) return false;

    const result = await this.styleManager.setContextMode('off');
    if (result && result.ok === false) {
      console.warn(
        `[Scenes] Could not exit ${mode}:`,
        result.error || 'unknown reason',
      );
      this._updateStatus(t('setup.scenes.status.contextExitFailed', { mode }));
      this._logEvent('context_mode_exit_failed', {
        mode,
        error: result.error || null,
      });
      return false;
    }
    this._logEvent('context_mode_exited', { mode });
    return true;
  }

  /** Use the authored sampler only for explicit moves; ordinary shots keep their existing flights. */
  async _flyShotCamera(scene, shot, durationSec, token) {
    const move = resolveCameraMove(scene, shot);
    if (!move)
      return this._flyCamera(
        resolveCameraPose(scene, shot.camera),
        durationSec,
        token,
      );
    const completed = await this._cameraMotion.play(
      { ...move, durationSec },
      token,
    );
    if (!completed && !token.cancelled && !this._destroyed)
      this.stopScene('Camera move interrupted');
  }

  /**
   * Fly the Cesium camera to the given position over the specified duration
   * using cubic ease-in-out. Resolves when the flight completes, is cancelled,
   * or a safety timeout fires (duration + 0.6s).
   * @param {Object} cameraState - Target { lat, lon, alt, heading, pitch, roll }
   * @param {number} durationSec - Flight duration in seconds
   * @param {{ cancelled: boolean }} token - Cancellation token checked before starting
   */
  async _flyCamera(cameraState, durationSec, token) {
    if (!cameraState || token.cancelled) return;

    // Scene playback drives the camera itself rather than through the shared
    // navigation seam, so the LOCATION readout would otherwise keep reporting
    // a free-text search the shot has already flown away from.
    this.styleManager?.clearSearchedLocation?.();

    const duration = Math.max(
      0.2,
      Number(durationSec) || DEFAULT_SHOT_DURATION_SEC,
    );
    const destination = Cesium.Cartesian3.fromDegrees(
      cameraState.lon,
      cameraState.lat,
      cameraState.alt,
    );

    await new Promise((resolve) => {
      // Guard against double-resolve from both callback and timeout
      let done = false;
      let timer;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      };

      this.viewer.camera.flyTo({
        destination,
        orientation: {
          heading: Cesium.Math.toRadians(cameraState.heading || 0),
          pitch: Cesium.Math.toRadians(cameraState.pitch ?? -35),
          roll: Cesium.Math.toRadians(cameraState.roll || 0),
        },
        duration,
        easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
        complete: finish,
        cancel: finish,
      });

      // Safety timeout in case Cesium callbacks fail to fire
      if (!done) timer = setTimeout(finish, (duration + 0.6) * 1000);
    });
  }

  /** Let an opt-in media owner finish playback and its fade before the next flight. */
  async _holdShot(scene, shot, token) {
    const readers = Object.entries(
      this._layerStatesForShot(scene, shot),
    ).flatMap(([id, state]) => {
      const module = this.dataManager?.layers?.get(id)?.module;
      if (!state.enabled || typeof module?.getSceneShotMediaHold !== 'function')
        return [];
      const read = () => module.getSceneShotMediaHold(state.params?.beatId);
      const initial = read();
      return initial
        ? [
            {
              read,
              maxWaitMs: Math.min(
                20000,
                Math.max(0, Number(initial.maxWaitMs) || 0),
              ),
            },
          ]
        : [];
    });
    if (!readers.length) {
      await this._sleep(this._effectiveShotHoldSec(scene, shot) * 1000, token);
      return;
    }
    const began = Date.now();
    while (!token.cancelled && !token.signal?.aborted) {
      const pending = readers.filter(({ read }) => read()?.pending === true);
      if (!pending.length) return;
      if (pending.some(({ maxWaitMs }) => Date.now() - began >= maxWaitMs)) {
        this.stopScene('Scene media timed out');
        throw new Error(
          'Scene media did not finish within its bounded playback window',
        );
      }
      await this._sleep(70, token);
    }
  }

  /** Wait through the playback clock so Stop also releases pending holds. */
  async _sleep(ms, token) {
    return this._clock.wait(ms, token);
  }

  /**
   * Start an interval that updates the progress bar based on wall-clock
   * elapsed time relative to the estimated total run duration.
   * @param {number} totalSec - Estimated total duration in seconds
   */
  _startProgressTicker(totalSec) {
    return this._clock.startRunProgress(totalSec);
  }

  /** Track one LOAD/replay flight and hold without pretending a full run is active. */
  _startShotProgress(token, seconds, from, to, sceneClock = null) {
    return this._clock.startShotProgress(token, seconds, from, to, sceneClock);
  }

  /** Drive the public authored clock through one running shot. */
  _startSceneClockTicker(scene, shot, token) {
    return this._clock.startScene(scene, shot, token);
  }

  /**
   * Clean up after a scene run (whether completed, errored, or cancelled).
   * Stops the progress ticker, exits recording mode only when owned, finalizes telemetry,
   * and resets UI buttons to the idle state.
   */
  _finishRun() {
    this._setSceneMediaPlayback();
    this._clock.finish();
    this._setPlaybackKeyboardEnabled(false);
    // Covers the error path too: a run that threw mid-shot must not leave a
    // layer transition running against a director that has stopped watching.
    this._runAbort?.abort();
    this._runAbort = null;
    this._cancelActiveSceneTravel();

    if (this._previewRun) {
      this.styleManager.setRecordingMode(false);
      this._setPlaybackActive(false);
    }
    this._previewRun = false;
    this._updateRuntime('');
    this._running = false;

    // Finalize telemetry and archive it for download
    if (this._activeRun) {
      this._activeRun.endedAt = new Date().toISOString();
      this._activeRun.wasCancelled = this._runToken?.cancelled || false;
      this._lastRun = this._activeRun;
      this._lastRunJson = JSON.stringify(this._activeRun, null, 2);
      this._activeRun = null;
    }

    this._runToken = null;
    this._setButtons(false);
    const clockSnapshot = this._clock.snapshot;
    if (clockSnapshot) {
      const scene = this._project.scenes.find(
        ({ id }) => id === clockSnapshot.sceneId,
      );
      const shot = scene?.shots?.find(({ id }) => id === clockSnapshot.shotId);
      if (scene && shot) {
        this._publishSceneClock(scene, shot, clockSnapshot.sceneElapsedSec, {
          running: false,
          seeking: clockSnapshot.seeking,
        });
      }
    }
    for (const resolve of this._runIdleResolvers) resolve();
    this._runIdleResolvers.clear();
  }

  /**
   * Toggle disabled state on all scene panel buttons based on run state.
   * Editing controls are disabled during a run; stop is disabled when idle.
   * @param {boolean} isRunning
   */
  _setButtons(isRunning) {
    this._publish({ type: 'buttons-changed', running: isRunning });
  }

  _setPlaybackActive(active) {
    this._presentation.playbackActive = active;
    this._publish({ type: 'playback-presentation' });
  }

  _setPlaybackKeyboardEnabled(enabled) {
    this._presentation.keyboardEnabled = enabled;
    this._publish({ type: 'playback-keyboard' });
  }

  /**
   * Update the progress bar fill width and label.
   * @param {number} progress - Value in [0, 1]
   */
  _setProgress(progress) {
    this._presentation.progress = progress;
    this._publish({ type: 'progress-changed' });
  }

  /**
   * Set the status line text in the scene panel.
   * @param {string} text
   */
  _updateStatus(text) {
    this._presentation.status = text;
    this._publish({ type: 'status-changed' });
  }

  /**
   * Set the runtime label (scene/shot name) and toggle its active class.
   * @param {string} text - Empty string hides the label
   */
  _updateRuntime(text) {
    this._presentation.runtime = text;
    this._publish({ type: 'runtime-changed' });
  }

  /**
   * Append a timestamped telemetry event to the active run log.
   * @param {string} type - Event type identifier (e.g. 'shot_start', 'scene_stopped')
   * @param {Object|null} payload - Arbitrary event data
   */
  _logEvent(type, payload) {
    if (!this._activeRun) return;
    this._publish({ type: 'run-event', event: type, detail: payload || null });
    this._activeRun.events.push({
      t: new Date().toISOString(),
      type,
      payload: payload || null,
    });
  }
}

export { createScenePackRegistry } from './packs/registry.js';
