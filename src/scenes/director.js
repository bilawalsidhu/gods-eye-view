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

import { createStateChannel } from '../app/stateChannel.js';
import { SceneControls } from '../ui/scenes.js';
import * as Cesium from 'cesium';
import {
  SCENE_APPEND_RECIPES,
  SCENE_RECIPES,
  getSceneAppendRecipeById,
} from './recipes.js';
import { sceneLayerPlan, sceneRequiresContextModeExit } from './scenePolicy.js';
import { MAP_STACKS } from '../maps/catalog.js';
import { INCIDENT_OVERVIEW_HOLD_SEC } from '../data/bhoteKoshiIncidentPlaces.js';
import {
  BLOOM_INTENSITY_DEFAULT,
  BLOOM_SCALE_VERSION,
  decodeBloomIntensity,
} from '../bloom.js';

/** @constant {string} localStorage key for the serialized project */
const STORAGE_KEY = 'godsEyeView.sceneProject.v2';
const STORAGE_CHECKPOINT_KEY = 'godsEyeView.sceneProject.checkpoint.v1';
/** @constant {number} Current schema version for project migration */
const PROJECT_VERSION = 3;
/** @constant {number} Fallback camera flight duration per shot (seconds) */
const DEFAULT_SHOT_DURATION_SEC = 4;
/** @constant {number} Default hold/pause after a shot completes (seconds) */
const DEFAULT_HOLD_SEC = 0.9;
const SCENE_MAP_STACK_IDS = new Set(MAP_STACKS.map(({ id }) => id));

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

/**
 * Generate a short random identifier with the given prefix.
 * @param {string} prefix - e.g. 'shot', 'scene'
 * @returns {string} Identifier like "shot-a1b2c3d4"
 */
function uid(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Deep-clone a JSON-serializable value via round-trip stringify/parse.
 * @param {*} value
 * @returns {*}
 */
function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Normalize a raw layer state entry into a canonical { enabled, params? } shape.
 * Accepts both boolean shorthand and full object forms.
 * @param {boolean|Object} entry - Raw layer state (boolean or { enabled, params })
 * @returns {{ enabled: boolean, params?: Object }}
 */
function normalizeLayerEntry(entry) {
  if (entry && typeof entry === 'object') {
    return {
      enabled: !!entry.enabled,
      params:
        entry.params && typeof entry.params === 'object'
          ? deepClone(entry.params)
          : undefined,
    };
  }
  return { enabled: !!entry };
}

/**
 * Normalize a raw bloom post-processing state, migrating intensity values
 * across bloom scale versions so older saved projects render correctly.
 * @param {Object} rawBloom - Raw bloom state from storage or recipe
 * @param {Object} [options]
 * @param {number} [options.projectVersion] - Schema version of the source project
 * @param {number} [options.fallbackIntensity] - Default intensity if not stored
 * @returns {{ enabled: boolean, intensity: number, version: number }}
 */
function normalizeBloomState(
  rawBloom = {},
  { projectVersion = PROJECT_VERSION, fallbackIntensity = 50 } = {},
) {
  // Determine which bloom scale the stored value was encoded under.
  // Older projects (version < PROJECT_VERSION) used scale version 1.
  const explicitVersion = Number(rawBloom.version);
  const bloomVersion = Number.isFinite(explicitVersion)
    ? explicitVersion
    : projectVersion >= PROJECT_VERSION
      ? BLOOM_SCALE_VERSION
      : 1;

  const rawIntensity = Number.isFinite(Number(rawBloom.intensity))
    ? Number(rawBloom.intensity)
    : fallbackIntensity;

  return {
    enabled: !!rawBloom.enabled,
    intensity: decodeBloomIntensity(rawIntensity, bloomVersion),
    version: BLOOM_SCALE_VERSION,
  };
}

/**
 * Convert a static scene recipe (from recipes.js) into a mutable scene object
 * with fully normalized shots. Each keyframe in the recipe's cameraPath becomes
 * one shot, inheriting the recipe's style, post, and layer configuration.
 * @param {Object} recipe - A SCENE_RECIPES entry
 * @returns {{ id: string, title: string, releaseLayerIds: string[], shots: Object[] }}
 */
function recipeToScene(recipe) {
  const post = recipe.post || {};
  const ui = recipe.ui || {};
  const styleParams =
    post.styleParams && typeof post.styleParams === 'object'
      ? deepClone(post.styleParams)
      : {};

  // Normalize layer targets from the recipe into canonical form
  const layers = {};
  for (const [layerId, target] of Object.entries(recipe.layers || {})) {
    layers[layerId] = normalizeLayerEntry(target);
  }

  // Derive HUD visibility/variant from recipe's ui.hudMode string
  const hudMode = ui.hudMode || 'minimal';
  const hudVisible = hudMode !== 'off';
  const hudVariant = hudMode === 'minimal' ? 'minimal' : 'tactical';

  // Convert each cameraPath keyframe into a shot with shared visual state
  const path = recipe.cameraPath || [];
  const shots = path.map((keyframe, idx) => {
    const keyframeLayers = deepClone(layers);
    for (const [layerId, target] of Object.entries(keyframe.layers || {})) {
      keyframeLayers[layerId] = normalizeLayerEntry(target);
    }
    const mapStack = keyframe.mapStack || post.mapStack;
    return {
      id: uid('shot'),
      title: keyframe.title || `Shot ${idx + 1}`,
      durationSec: Math.max(
        0.2,
        keyframe.duration || DEFAULT_SHOT_DURATION_SEC,
      ),
      holdSec: Math.max(0, keyframe.hold || 0),
      camera: {
        lat: keyframe.lat,
        lon: keyframe.lon,
        alt: keyframe.alt,
        heading: keyframe.heading || 0,
        pitch: keyframe.pitch || -40,
        roll: keyframe.roll || 0,
      },
      visual: {
        style: recipe.style || 'normal',
        bloom: {
          enabled:
            typeof post.bloom === 'number' ? post.bloom > 0 : !!post.bloom,
          intensity:
            typeof post.bloom === 'number'
              ? decodeBloomIntensity(post.bloom, 1)
              : BLOOM_INTENSITY_DEFAULT,
          version: BLOOM_SCALE_VERSION,
        },
        sharpen: {
          enabled:
            typeof post.sharpen === 'boolean' ? post.sharpen : !!post.sharpen,
          intensity: 65,
        },
        hud: {
          visible: hudVisible,
          variant: hudVariant,
        },
        detection: {
          mode: post.detectionMode || 'OFF',
          density: 35,
        },
        ...(SCENE_MAP_STACK_IDS.has(mapStack) ? { mapStack } : {}),
        styleParams,
      },
      layers: keyframeLayers,
      ...(recipe.id ? { sourcePackId: recipe.id } : {}),
      ...(recipe.version ? { sourcePackVersion: recipe.version } : {}),
    };
  });

  return {
    id: recipe.id || uid('scene'),
    title: recipe.title || 'Untitled Scene',
    releaseLayerIds: [
      ...new Set(
        (Array.isArray(recipe.releaseLayerIds)
          ? recipe.releaseLayerIds
          : []
        ).filter((layerId) => typeof layerId === 'string' && layerId.trim()),
      ),
    ],
    appliedShotPacks: [],
    shots,
  };
}

/**
 * Create a fresh default project by converting all built-in SCENE_RECIPES.
 * @returns {Object} A new project object with version, timestamps, and scenes
 */
function createDefaultProject() {
  return {
    version: PROJECT_VERSION,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    installedBuiltInSceneIds: SCENE_RECIPES.filter(
      (recipe) => typeof recipe.installAlongsideSceneId === 'string',
    ).map((recipe) => recipe.id),
    scenes: SCENE_RECIPES.map(recipeToScene),
  };
}

/**
 * Normalize a raw shot object from storage or capture into a fully validated
 * shape with safe defaults for every field. Handles version migration for
 * bloom intensity and coerces all numeric fields.
 * @param {Object} rawShot - Raw shot data (may be incomplete or from an older schema)
 * @param {number} [index=0] - Positional index used for fallback title
 * @param {Object} [options]
 * @param {number} [options.projectVersion] - Schema version of the enclosing project
 * @returns {Object} Fully normalized shot
 */
function normalizeShot(
  rawShot,
  index = 0,
  { projectVersion = PROJECT_VERSION } = {},
) {
  const camera = rawShot?.camera || {};
  const visual = rawShot?.visual || {};
  const bloom = visual.bloom || {};
  const sharpen = visual.sharpen || {};
  const hud = visual.hud || {};
  const detection = visual.detection || {};

  return {
    id: rawShot?.id || uid('shot'),
    title: rawShot?.title || `Shot ${index + 1}`,
    durationSec: Math.max(
      0.2,
      Number(rawShot?.durationSec) || DEFAULT_SHOT_DURATION_SEC,
    ),
    holdSec: Math.max(0, Number(rawShot?.holdSec) || 0),
    camera: {
      lat: Number(camera.lat) || 0,
      lon: Number(camera.lon) || 0,
      alt: Math.max(100, Number(camera.alt) || 800),
      heading: Number(camera.heading) || 0,
      pitch: Number(camera.pitch) || -35,
      roll: Number(camera.roll) || 0,
    },
    visual: {
      style: visual.style || 'normal',
      bloom: normalizeBloomState(bloom, {
        projectVersion,
        fallbackIntensity: 50,
      }),
      sharpen: {
        enabled: !!sharpen.enabled,
        intensity: Math.max(
          0,
          Math.min(
            100,
            Number.isFinite(Number(sharpen.intensity))
              ? Number(sharpen.intensity)
              : 65,
          ),
        ),
      },
      hud: {
        visible: typeof hud.visible === 'boolean' ? hud.visible : true,
        variant: typeof hud.variant === 'string' ? hud.variant : 'tactical',
      },
      detection: {
        mode: typeof detection.mode === 'string' ? detection.mode : 'OFF',
        density: Math.max(
          0,
          Math.min(
            100,
            Number.isFinite(Number(detection.density))
              ? Number(detection.density)
              : 35,
          ),
        ),
      },
      ...(SCENE_MAP_STACK_IDS.has(visual.mapStack)
        ? { mapStack: visual.mapStack }
        : {}),
      styleParams:
        visual.styleParams && typeof visual.styleParams === 'object'
          ? deepClone(visual.styleParams)
          : {},
    },
    layers: Object.fromEntries(
      Object.entries(rawShot?.layers || {}).map(([layerId, value]) => [
        layerId,
        normalizeLayerEntry(value),
      ]),
    ),
    ...(typeof rawShot?.sourcePackId === 'string'
      ? { sourcePackId: rawShot.sourcePackId }
      : {}),
    ...(Number.isFinite(Number(rawShot?.sourcePackVersion))
      ? { sourcePackVersion: Number(rawShot.sourcePackVersion) }
      : {}),
  };
}

/**
 * Normalize and migrate an entire project object loaded from storage or import.
 * Falls back to the default recipe-based project when input is invalid or empty.
 * @param {Object|null} rawProject - Raw project data (potentially from an older schema)
 * @returns {Object} Fully normalized project at the current PROJECT_VERSION
 */
function normalizeProject(rawProject) {
  if (!rawProject || typeof rawProject !== 'object')
    return createDefaultProject();
  const projectVersion = Number.isFinite(Number(rawProject.version))
    ? Number(rawProject.version)
    : 1;

  const scenesRaw = Array.isArray(rawProject.scenes) ? rawProject.scenes : [];
  const scenes = scenesRaw
    .map((scene, sceneIdx) => {
      const shotsRaw = Array.isArray(scene?.shots) ? scene.shots : [];
      const shots = shotsRaw.map((shot, shotIdx) =>
        normalizeShot(shot, shotIdx, { projectVersion }),
      );
      return {
        id: scene?.id || uid('scene'),
        title: scene?.title || `Scene ${sceneIdx + 1}`,
        releaseLayerIds: [
          ...new Set(
            (Array.isArray(scene?.releaseLayerIds)
              ? scene.releaseLayerIds
              : []
            ).filter(
              (layerId) => typeof layerId === 'string' && layerId.trim(),
            ),
          ),
        ],
        appliedShotPacks: (Array.isArray(scene?.appliedShotPacks)
          ? scene.appliedShotPacks
          : []
        )
          .filter((entry) => typeof entry?.id === 'string')
          .map((entry) => ({
            id: entry.id,
            version: Number(entry.version) || 1,
            ...(entry.shotBindings && typeof entry.shotBindings === 'object'
              ? {
                  shotBindings: Object.fromEntries(
                    Object.entries(entry.shotBindings).filter(
                      ([title, shotId]) =>
                        typeof title === 'string' && typeof shotId === 'string',
                    ),
                  ),
                }
              : {}),
          })),
        shots,
      };
    })
    // Keep scenes that have shots or at least a title
    .filter((scene) => scene.shots.length > 0 || scene.title);

  if (!scenes.length) {
    return createDefaultProject();
  }

  return {
    version: PROJECT_VERSION,
    createdAt: rawProject.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    installedBuiltInSceneIds: [
      ...new Set(
        (Array.isArray(rawProject.installedBuiltInSceneIds)
          ? rawProject.installedBuiltInSceneIds
          : []
        ).filter((sceneId) => typeof sceneId === 'string' && sceneId.trim()),
      ),
    ],
    scenes,
  };
}

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
    { isMapStackAvailable = () => false } = {},
  ) {
    this._destroyed = false;
    this._pendingWork = new Set();
    this.viewer = viewer;
    this.styleManager = styleManager;
    this.dataManager = dataManager;
    this._isMapStackAvailable = isMapStackAvailable;

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
    /** @type {number|null} setInterval ID for the progress bar ticker */
    this._progressTimer = null;
    this._shotProgressTimer = null;
    this._sceneClockTimer = null;
    this._sceneClockListeners = new Set();
    this._sceneClockSnapshot = null;
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
      status: 'Ready',
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
    this._controls?.destroy();
    this._state.destroy();
    this._destroyPromise = Promise.resolve().then(async () => {
      this.stopScene('Stopped');
      this._loadAbort?.abort();
      this._loadGeneration++;
      this.viewer.camera.cancelFlight();
      clearTimeout(this._storageToastTimer);
      await Promise.allSettled(this._pendingWork || []);
      clearInterval(this._progressTimer);
      clearInterval(this._shotProgressTimer);
      clearInterval(this._sceneClockTimer);
      this._cancelActiveSceneTravel();
      this._sceneClockListeners.clear();
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
      const project = normalizeProject(JSON.parse(raw));
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
          localStorage.setItem(STORAGE_KEY, JSON.stringify(project));
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
    } catch {
      return createDefaultProject();
    }
  }

  /** Persist the current project state to localStorage with an updated timestamp. */
  _saveProject() {
    this._project.updatedAt = new Date().toISOString();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this._project));
    } catch (e) {
      // Private browsing / block-all-cookies / quota-exceeded throws here. The
      // in-memory project stays usable this session, but persistence failed —
      // tell the user instead of crashing the caller (M11).
      console.warn(
        '[Scenes] Could not persist project (storage unavailable):',
        e,
      );
      this._toastStorageError();
    }
  }

  /** Surface a "scene not saved" notice via the global toast + scene status line. */
  _toastStorageError() {
    const message = 'Scene not saved — browser storage unavailable';
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
      this._presentation.status = `Loaded: ${scene.title} / ${shot.title}`;
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
    this._controls = new SceneControls({
      subscribe: (listener) => this.subscribe(listener),
      read: () => ({
        scenes: this._project.scenes,
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
      this._updateStatus('Cannot capture shot: camera not ready');
      return;
    }

    const shot = normalizeShot(
      {
        id: uid('shot'),
        title: `Shot ${scene.shots.length + 1}`,
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
    this._updateStatus(`Captured: ${scene.title} / ${shot.title}`);
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
      this._updateStatus('Select a shot first');
      return;
    }

    const camera = this.styleManager.getCameraState();
    if (!camera) return;

    shot.camera = camera;
    shot.visual = this.styleManager.getVisualState();
    shot.layers = this._captureLayerStates();

    this._saveProject();
    this._shotOutcome('shot-updated', scene, shot);
    this._updateStatus(`Updated: ${scene.title} / ${shot.title}`);
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
    return this._trackWork(this._loadShot(sceneId, shotId, options));
  }

  async _loadShot(
    sceneId,
    shotId,
    { flyDuration = 2.2, fromCamera = null, sceneSeek = null } = {},
  ) {
    if (this._running) return { started: false, reason: 'already-running' };
    const { scene, shot } = this._getShot(sceneId, shotId);
    if (!scene || !shot) return { started: false, reason: 'shot-not-found' };
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
    this._loadAbort?.abort();
    const controller = new AbortController();
    this._loadAbort = controller;
    const token = this._loadToken(++this._loadGeneration, controller.signal);
    clearInterval(this._shotProgressTimer);
    this._shotProgressTimer = null;
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
    if (seekState) {
      this._setCameraView(seekState.camera || shot.camera);
      this._setProgress(seekState.sceneProgress);
      this._publishSceneClock(scene, shot, seekState.sceneElapsedSec, {
        running: false,
        seeking: true,
      });
      if (this._loadAbort === controller) this._loadAbort = null;
      this._updateStatus(`Seeked: ${scene.title} / ${shot.title}`);
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
      // _flyCamera calls Cesium's flyTo synchronously before yielding. Publish
      // the trail phase immediately afterward so its clock overlaps actual
      // camera motion, never an earlier asynchronous layer-reconcile wait.
      const flight = this._flyCamera(shot.camera, flyDuration, token);
      this._publishShotTravel(scene, shot, cameraTravel);
      await flight;
    } catch (error) {
      this._cancelActiveSceneTravel();
      if (!token.cancelled) {
        clearInterval(this._shotProgressTimer);
        this._shotProgressTimer = null;
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
    this._shotOutcome('shot-loaded', scene, shot);
    this._updateRuntime('');
    return { started: true, shotId };
  }

  /**
   * Treat a scene-owned release layer as OFF in shots that do not declare it.
   * This keeps an appended event lens from leaking backward into the scene's
   * original authored shots while leaving ordinary sparse layer state intact.
   */
  _layerStatesForShot(
    scene,
    shot,
    { cameraSettled = false, cameraTravel = null, sceneSeek = null } = {},
  ) {
    const states = deepClone(shot?.layers || {});
    const shotIndex =
      scene?.shots?.findIndex(({ id }) => id === shot?.id) ?? -1;
    const sceneShotDurations =
      scene?.shots?.map((sceneShot) =>
        this._shotRuntimeDurationSec(scene, sceneShot),
      ) || [];
    const sceneDurationSec = sceneShotDurations.reduce(
      (sum, duration) => sum + duration,
      0,
    );
    const authoredSceneElapsedSec = sceneShotDurations
      .slice(0, Math.max(0, shotIndex))
      .reduce((sum, duration) => sum + duration, 0);
    const sceneElapsedSec = sceneSeek
      ? Math.max(
          0,
          Math.min(sceneDurationSec, Number(sceneSeek.sceneElapsedSec) || 0),
        )
      : authoredSceneElapsedSec;
    const sourceRecipe = getSceneAppendRecipeById(shot?.sourcePackId);
    for (const state of Object.values(states)) {
      if (state?.params?.presentation !== 'scene-beat') continue;
      state.params.sceneSurface ||= shot.sourcePackId
        ? 'evidence-beat'
        : 'panel-only';
      const runtimeControls =
        sourceRecipe?.runtimeControlsByBeat?.[state.params.beatId];
      if (runtimeControls) {
        state.params.sceneControls = {
          ...state.params.sceneControls,
          ...runtimeControls,
          ...(runtimeControls.deferEvidenceUntilCameraSettled
            ? { cameraSettled }
            : {}),
          ...(sceneSeek
            ? {
                timelineSeek: {
                  shotElapsedSec: Number(sceneSeek.shotElapsedSec) || 0,
                  flightDurationSec: Number(sceneSeek.flightDurationSec) || 0,
                  holdDurationSec: Number(sceneSeek.holdDurationSec) || 0,
                  holdElapsedSec: Number(sceneSeek.holdElapsedSec) || 0,
                  cameraProgress: clamp01(
                    Number(sceneSeek.cameraProgress) || 0,
                  ),
                  holdProgress: clamp01(Number(sceneSeek.holdProgress) || 0),
                },
              }
            : {}),
        };
        if (runtimeControls.evidencePathDuringCamera && cameraTravel) {
          state.params.sceneControls.cameraTravel = { ...cameraTravel };
        }
      }
      state.params.sceneContext = {
        sceneId: scene.id,
        sceneTitle: scene.title,
        shotId: shot.id,
        shotTitle: shot.title,
        shotIndex,
        shotCount: scene.shots.length,
        durationSec: shot.durationSec || DEFAULT_SHOT_DURATION_SEC,
        holdSec: this._effectiveShotHoldSec(scene, shot, states),
        sceneElapsedSec,
        sceneDurationSec,
        sceneProgress:
          sceneDurationSec > 0 ? sceneElapsedSec / sceneDurationSec : 0,
        ...(sceneSeek
          ? {
              shotElapsedSec: Number(sceneSeek.shotElapsedSec) || 0,
              shotProgress: clamp01(Number(sceneSeek.shotProgress) || 0),
              seeking: true,
            }
          : {}),
      };
    }
    for (const layerId of scene?.releaseLayerIds || []) {
      if (!Object.hasOwn(states, layerId)) states[layerId] = { enabled: false };
    }
    return states;
  }

  /** Keep installed append-pack shots on any surface declared by their source recipe. */
  _visualStateForShot(shot) {
    const sourceRecipe = getSceneAppendRecipeById(shot?.sourcePackId);
    const sceneBeatState = Object.values(shot?.layers || {}).find(
      (state) => state?.params?.presentation === 'scene-beat',
    );
    const controls = {
      ...sceneBeatState?.params?.sceneControls,
      ...sourceRecipe?.runtimeControlsByBeat?.[sceneBeatState?.params?.beatId],
    };
    if (controls.imageryComparison === true) {
      return { ...(shot.visual || {}), mapStack: 'esri-imagery' };
    }
    if (
      sourceRecipe?.standaloneSurfaceBeatIds?.includes(
        sceneBeatState?.params?.beatId,
      )
    ) {
      return { ...(shot.visual || {}), mapStack: 'esri-imagery' };
    }
    const visual = sourceRecipe?.photorealSurfaceBeatIds?.includes(
      sceneBeatState?.params?.beatId,
    )
      ? { ...(shot.visual || {}), mapStack: 'photoreal' }
      : shot?.visual || {};
    const isNepalShot =
      shot?.layers?.['bhote-koshi-2026']?.enabled ||
      shot?.layers?.['bhote-koshi-locator']?.enabled;
    // Check actual loaded capability, not the presence of a credential. A key
    // can exist even when its tileset failed to initialize. Resolve at playback
    // time so saved cameras and provider preferences remain portable.
    if (
      isNepalShot &&
      visual.mapStack === 'photoreal' &&
      !this._isMapStackAvailable('photoreal')
    ) {
      return { ...visual, mapStack: 'esri-imagery' };
    }
    return visual;
  }

  /** Keep a shot on its final camera pose until its authored layer reveal finishes. */
  _effectiveShotHoldSec(scene, shot, resolvedStates = null) {
    const states = resolvedStates || this._layerStatesForShot(scene, shot);
    const recipe = getSceneAppendRecipeById(shot?.sourcePackId);
    const overrides = Object.values(states)
      .filter(
        (state) =>
          state?.enabled && state.params?.presentation === 'scene-beat',
      )
      .map((state) => recipe?.runtimeHoldSecByBeat?.[state.params.beatId])
      .filter((value) => Number.isFinite(value) && value >= 0);
    const authoredHoldSec = overrides.length
      ? Math.max(...overrides)
      : Number(shot?.holdSec) || 0;
    const overview = states['bhote-koshi-locator'];
    const overviewHoldSec =
      overview?.enabled &&
      overview.params?.presentation === 'bhote-koshi-incident-places'
        ? INCIDENT_OVERVIEW_HOLD_SEC
        : 0;
    return Object.values(states).reduce(
      (holdSec, state) => {
        const controls = state?.params?.sceneControls;
        return Math.max(
          holdSec,
          Number(controls?.minimumHoldSec) || 0,
          controls?.evidenceSequence === true
            ? Number(controls.evidenceSequenceDurationSec) || 0
            : 0,
        );
      },
      Math.max(overviewHoldSec, authoredHoldSec),
    );
  }

  /** Resolve one shot's authored flight plus any runtime-enforced hold. */
  _shotRuntimeDurationSec(scene, shot) {
    const states = deepClone(shot?.layers || {});
    const sourceRecipe = getSceneAppendRecipeById(shot?.sourcePackId);
    for (const state of Object.values(states)) {
      if (state?.params?.presentation !== 'scene-beat') continue;
      const runtimeControls =
        sourceRecipe?.runtimeControlsByBeat?.[state.params.beatId];
      if (runtimeControls) {
        state.params.sceneControls = {
          ...state.params.sceneControls,
          ...runtimeControls,
        };
      }
    }
    return (
      (shot?.durationSec || DEFAULT_SHOT_DURATION_SEC) +
      this._effectiveShotHoldSec(scene, shot, states)
    );
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
    // The opening locator owns an additional delayed approach/orbit even after
    // the director's authored flight has settled. Revoke it before cancelling
    // the camera, whose moveEnd/complete callbacks may already be queued.
    this.dataManager?.layers
      ?.get('bhote-koshi-locator')
      ?.module.cancelSceneMotion?.();
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
      flyDuration: shot.durationSec || DEFAULT_SHOT_DURATION_SEC,
      fromCamera: previousShot?.camera || null,
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
    const durations =
      scene?.shots?.map((item) => this._shotRuntimeDurationSec(scene, item)) ||
      [];
    const shotIndex =
      scene?.shots?.findIndex(({ id }) => id === shot?.id) ?? -1;
    const totalSec = durations.reduce((sum, duration) => sum + duration, 0);
    const startElapsedSec = durations
      .slice(0, Math.max(0, shotIndex))
      .reduce((sum, duration) => sum + duration, 0);
    const durationSec = shotIndex >= 0 ? durations[shotIndex] : 0;
    const endElapsedSec = Math.min(totalSec, startElapsedSec + durationSec);
    return {
      shotIndex,
      totalSec,
      durationSec,
      startElapsedSec,
      endElapsedSec,
      startProgress: totalSec > 0 ? startElapsedSec / totalSec : 0,
      endProgress: totalSec > 0 ? endElapsedSec / totalSec : 1,
      durationProgress: totalSec > 0 ? durationSec / totalSec : 0,
    };
  }

  /** Interpolate an authored camera flight at a normalized time. */
  _cameraAtProgress(fromCamera, toCamera, progress) {
    const target = toCamera || fromCamera;
    const source = fromCamera || target;
    if (!source || !target) return target || source || null;
    const t = clamp01(Number(progress) || 0);
    const eased = t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
    const lerp = (from, to) =>
      Number(from) + (Number(to) - Number(from)) * eased;
    const lerpAngle = (from, to) => {
      const start = Number(from) || 0;
      const delta = ((Number(to) - start + 540) % 360) - 180;
      return start + delta * eased;
    };
    return {
      lat: lerp(source.lat, target.lat),
      lon: lerp(source.lon, target.lon),
      alt: lerp(source.alt, target.alt),
      heading: lerpAngle(source.heading, target.heading),
      pitch: lerp(source.pitch, target.pitch),
      roll: lerpAngle(source.roll, target.roll),
    };
  }

  /** Resolve a normalized scene-clock position to a shot, phase, and camera pose. */
  _sceneSeekState(scene, progress) {
    if (!scene?.shots?.length) return null;
    const normalized = clamp01(Number(progress) || 0);
    const durations = scene.shots.map((shot) =>
      this._shotRuntimeDurationSec(scene, shot),
    );
    const totalSec = durations.reduce((sum, duration) => sum + duration, 0);
    const targetSec = normalized * Math.max(0, totalSec);
    let startElapsedSec = 0;
    let shotIndex = scene.shots.length - 1;
    for (let index = 0; index < scene.shots.length; index += 1) {
      const endElapsedSec = startElapsedSec + durations[index];
      if (targetSec < endElapsedSec || index === scene.shots.length - 1) {
        shotIndex = index;
        break;
      }
      startElapsedSec = endElapsedSec;
    }
    const shot = scene.shots[shotIndex];
    const flightDurationSec = shot.durationSec || DEFAULT_SHOT_DURATION_SEC;
    const holdDurationSec = this._effectiveShotHoldSec(scene, shot);
    const shotDurationSec = Math.max(
      0.001,
      flightDurationSec + holdDurationSec,
    );
    const shotElapsedSec = Math.max(
      0,
      Math.min(shotDurationSec, targetSec - startElapsedSec),
    );
    const cameraProgress = clamp01(
      shotElapsedSec / Math.max(0.001, flightDurationSec),
    );
    const holdElapsedSec = Math.max(0, shotElapsedSec - flightDurationSec);
    const holdProgress =
      holdDurationSec > 0 ? clamp01(holdElapsedSec / holdDurationSec) : 1;
    const previousCamera = scene.shots[shotIndex - 1]?.camera || shot.camera;
    return {
      sceneProgress: totalSec > 0 ? targetSec / totalSec : 0,
      sceneElapsedSec: targetSec,
      sceneDurationSec: totalSec,
      shotIndex,
      shot,
      shotElapsedSec,
      shotProgress: clamp01(shotElapsedSec / shotDurationSec),
      flightDurationSec,
      holdDurationSec,
      holdElapsedSec,
      cameraProgress,
      holdProgress,
      camera: this._cameraAtProgress(
        previousCamera,
        shot.camera,
        cameraProgress,
      ),
    };
  }

  /** Subscribe a scene-owned panel to the authoritative authored clock. */
  subscribeSceneClock(listener) {
    if (typeof listener !== 'function') return () => {};
    this._sceneClockListeners.add(listener);
    if (this._sceneClockSnapshot) listener({ ...this._sceneClockSnapshot });
    return () => this._sceneClockListeners.delete(listener);
  }

  /** Publish one authoritative scene-clock snapshot to attached panels. */
  _publishSceneClock(
    scene,
    shot,
    sceneElapsedSec,
    { running = this._running, seeking = false } = {},
  ) {
    if (!scene || !shot) return;
    const timing = this._sceneTimingForShot(scene, shot);
    const elapsedSec = Math.max(
      0,
      Math.min(timing.totalSec, Number(sceneElapsedSec) || 0),
    );
    this._sceneClockSnapshot = {
      sceneId: scene.id,
      shotId: shot.id,
      shotIndex: timing.shotIndex,
      shotCount: scene.shots.length,
      sceneElapsedSec: elapsedSec,
      sceneDurationSec: timing.totalSec,
      sceneProgress: timing.totalSec > 0 ? elapsedSec / timing.totalSec : 0,
      running: Boolean(running),
      seeking: Boolean(seeking),
    };
    for (const listener of this._sceneClockListeners) {
      try {
        listener({ ...this._sceneClockSnapshot });
      } catch (error) {
        console.warn('[Scenes] Scene clock listener failed:', error);
      }
    }
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
      this._loadedSceneId !== scene.id ||
      this._selectedShotId !== shot.id
    )
      return false;
    if (!this._claimCameraOwnership()) return false;
    this._cancelActiveSceneTravel();
    this._loadAbort?.abort();
    this._loadAbort = null;
    this._loadGeneration += 1;
    clearInterval(this._shotProgressTimer);
    this._shotProgressTimer = null;
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
    this._setCameraView(seekState.camera || shot.camera);
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
    const claimed = this.styleManager.runImmediateNavigation(
      'scene',
      () => true,
    );
    if (claimed === false) {
      this._updateStatus('Camera unavailable — exit cockpit first');
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
        pitch: Cesium.Math.toRadians(cameraState.pitch || -35),
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
    if (!this._project.scenes.length) return [];

    // Rotate the scene list so startSceneId comes first
    const startIdx = Math.max(
      0,
      this._project.scenes.findIndex((scene) => scene.id === startSceneId),
    );
    const ordered = single
      ? this._project.scenes.slice(startIdx, startIdx + 1)
      : [
          ...this._project.scenes.slice(startIdx),
          ...this._project.scenes.slice(0, startIdx),
        ];

    // Flatten scenes into a sequential shot queue
    const queue = [];
    for (const scene of ordered) {
      for (const shot of scene.shots) {
        queue.push({ scene, shot });
      }
    }
    return queue;
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
      this._updateStatus('No shots to run');
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
    this._cancelActiveSceneTravel();
    this._loadAbort?.abort();
    this._loadAbort = null;
    this._loadGeneration++;
    clearInterval(this._shotProgressTimer);
    this._shotProgressTimer = null;

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

    let activeScene = null;
    try {
      const loadedScene = this._project.scenes.find(
        (scene) => scene.id === this._loadedSceneId,
      );
      if (loadedScene && loadedScene.id !== queue[0].scene.id) {
        const released = await this._releaseSceneLayers(loadedScene, token);
        if (!released)
          throw new Error(`Could not leave scene: ${loadedScene.title}`);
        this._loadedSceneId = null;
      }

      // Main shot sequencing loop
      for (let idx = 0; idx < queue.length; idx++) {
        if (token.cancelled) break;
        const { scene, shot } = queue[idx];

        if (activeScene && activeScene.id !== scene.id) {
          await this._releaseSceneLayers(activeScene);
          this._loadedSceneId = null;
          activeScene = null;
          if (token.cancelled) break;
        }
        activeScene = scene;

        // Update UI selection to track the active shot
        this._selectedSceneId = scene.id;
        this._selectedShotId = shot.id;
        this._renderSceneSelect();
        this._renderShotList();

        this._updateStatus(
          `Running ${idx + 1}/${queue.length}: ${scene.title} / ${shot.title}`,
        );

        this._logEvent('shot_start', {
          sceneId: scene.id,
          shotId: shot.id,
          title: shot.title,
          index: idx,
        });

        // Apply visual state (style, bloom, sharpen, HUD, detection) then layers, then fly.
        // Awaited: applyVisualState suspends on a map-stack switch, and a shot
        // captured by the operator carries one — un-awaited, its shader uniforms
        // land after the NEXT shot has already been applied.
        //
        // Every await is a place STOP/Esc can arrive. A suspended map-stack
        // switch can hold this shot for seconds; without a re-check the layer
        // pass below still runs and the operator watches layers keep toggling
        // after they hit Stop. Cancellation is re-read after each one.
        await this.styleManager.applyVisualState(
          this._visualStateForShot(shot),
          {
            isCurrent: () => !token.cancelled,
          },
        );
        if (token.cancelled) break;
        const flightDuration = shot.durationSec || DEFAULT_SHOT_DURATION_SEC;
        await this._applyLayerStates(
          this._layerStatesForShot(scene, shot),
          token,
        );
        if (token.cancelled) break;
        this._loadedSceneId = scene.id;
        const sceneTiming = this._startSceneClockTicker(scene, shot, token);
        const cameraTravel = this._beginShotTravel(scene, shot, flightDuration);
        const flight = this._flyCamera(shot.camera, flightDuration, token);
        this._publishShotTravel(scene, shot, cameraTravel);
        await flight;
        if (token.cancelled) break;
        this._settleShotLayerStates(scene, shot, token, cameraTravel);
        if (token.cancelled) break;
        // Hold on the final frame before transitioning to the next shot
        await this._holdShot(scene, shot, token);
        if (token.cancelled) break;
        clearInterval(this._sceneClockTimer);
        this._sceneClockTimer = null;
        this._publishSceneClock(scene, shot, sceneTiming.endElapsedSec, {
          running: true,
        });

        this._logEvent('shot_end', {
          sceneId: scene.id,
          shotId: shot.id,
          index: idx,
        });
      }

      if (!token.cancelled) {
        this._setProgress(1);
        this._updateStatus('Scene run complete');
        this._logEvent('scene_run_complete', {});
      }
    } catch (error) {
      this._updateStatus(`Error: ${error.message || 'run failed'}`);
      this._logEvent('scene_run_error', {
        message: error.message || 'unknown error',
      });
    } finally {
      if (preview) {
        await this._releaseSceneLayers(activeScene);
        if (activeScene?.id === this._loadedSceneId) this._loadedSceneId = null;
      }
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
    this._sceneSeekGeneration++;
    this._loadAbort?.abort();
    this._loadAbort = null;
    this._loadGeneration++;
    clearInterval(this._shotProgressTimer);
    this._shotProgressTimer = null;
    this._cancelActiveSceneTravel();
    this.viewer.camera.cancelFlight();
    if (this._sceneClockSnapshot) {
      this._sceneClockSnapshot = {
        ...this._sceneClockSnapshot,
        running: false,
        stopped: true,
      };
      for (const listener of this._sceneClockListeners) {
        try {
          listener({ ...this._sceneClockSnapshot });
        } catch {
          /* Observer cannot block cancellation. */
        }
      }
    }
    if (!this._running || !this._runToken) return;
    this._runToken.cancelled = true;
    this._runAbort?.abort();
    this._updateStatus(reason);
    this._logEvent('scene_stopped', { reason });
  }

  /** Export the entire project as a timestamped JSON file download. */
  exportProject() {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `scene-presets-${stamp}.json`;
    const payload = JSON.stringify(this._project, null, 2);
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
    this._presentation.status = 'Project exported';
    this._publish({ type: 'project-exported', project: this._project });
  }

  /**
   * Import a project from a user-selected JSON file, replacing the current project.
   * The file is normalized/migrated on load; invalid JSON shows an error status.
   * @param {File} file - Browser File object from an <input type="file">
   */
  async importProjectFile(file) {
    try {
      const text = await file.text();
      if (this._destroyed) return;
      const parsed = JSON.parse(text);
      this._project = normalizeProject(parsed);
      this._selectedSceneId = this._project.scenes[0]?.id || null;
      this._selectedShotId = this._project.scenes[0]?.shots[0]?.id || null;
      this._saveProject();
      this._publish({ type: 'project-imported', project: this._project });
      this._updateStatus(`Imported ${file.name}`);
    } catch {
      this._updateStatus('Import failed (invalid JSON)');
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
      this._updateStatus(
        `Could not exit ${mode} — scene layers may be refused`,
      );
      this._logEvent('context_mode_exit_failed', {
        mode,
        error: result.error || null,
      });
      return false;
    }
    this._logEvent('context_mode_exited', { mode });
    return true;
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
          pitch: Cesium.Math.toRadians(cameraState.pitch || -35),
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

  /** Cancellable sleep, polling every ~70 ms for prompt interruption. */
  async _sleep(ms, token) {
    if (ms <= 0 || token.cancelled) return;
    const endAt = Date.now() + ms;
    while (Date.now() < endAt) {
      if (token.cancelled) return;
      await new Promise((resolve) => setTimeout(resolve, 70));
    }
  }

  /**
   * Start an interval that updates the progress bar based on wall-clock
   * elapsed time relative to the estimated total run duration.
   * @param {number} totalSec - Estimated total duration in seconds
   */
  _startProgressTicker(totalSec) {
    clearInterval(this._progressTimer);
    const startMs = Date.now();
    const totalMs = Math.max(1000, totalSec * 1000);
    this._progressTimer = setInterval(() => {
      if (!this._running) return;
      const elapsedMs = Date.now() - startMs;
      this._setProgress(elapsedMs / totalMs);
    }, 100);
  }

  /** Track one LOAD/replay flight and hold without pretending a full run is active. */
  _startShotProgress(token, seconds, from, to, sceneClock = null) {
    clearInterval(this._shotProgressTimer);
    this._shotProgressTimer = null;
    if (token.cancelled || this._running) return;
    this._setProgress(from);
    if (sceneClock) {
      this._publishSceneClock(
        sceneClock.scene,
        sceneClock.shot,
        sceneClock.sceneElapsedFrom,
        { running: false },
      );
    }
    if (seconds <= 0) {
      this._setProgress(to);
      if (sceneClock) {
        this._publishSceneClock(
          sceneClock.scene,
          sceneClock.shot,
          sceneClock.sceneElapsedTo,
          { running: false },
        );
      }
      return;
    }
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (token.cancelled || this._running) {
        clearInterval(timer);
        if (this._shotProgressTimer === timer) this._shotProgressTimer = null;
        return;
      }
      const fraction = clamp01((Date.now() - startedAt) / (seconds * 1000));
      this._setProgress(from + (to - from) * fraction);
      if (sceneClock) {
        this._publishSceneClock(
          sceneClock.scene,
          sceneClock.shot,
          sceneClock.sceneElapsedFrom +
            (sceneClock.sceneElapsedTo - sceneClock.sceneElapsedFrom) *
              fraction,
          { running: false },
        );
      }
      if (fraction >= 1) {
        clearInterval(timer);
        if (this._shotProgressTimer === timer) this._shotProgressTimer = null;
      }
    }, 100);
    timer.unref?.();
    this._shotProgressTimer = timer;
  }

  /** Drive the public authored clock through one running shot. */
  _startSceneClockTicker(scene, shot, token) {
    clearInterval(this._sceneClockTimer);
    const timing = this._sceneTimingForShot(scene, shot);
    const startedAt = Date.now();
    this._publishSceneClock(scene, shot, timing.startElapsedSec, {
      running: true,
    });
    const timer = setInterval(() => {
      if (token.cancelled || !this._running) {
        clearInterval(timer);
        if (this._sceneClockTimer === timer) this._sceneClockTimer = null;
        return;
      }
      const shotElapsedSec = Math.min(
        timing.durationSec,
        (Date.now() - startedAt) / 1000,
      );
      this._publishSceneClock(
        scene,
        shot,
        timing.startElapsedSec + shotElapsedSec,
        {
          running: true,
        },
      );
    }, 50);
    timer.unref?.();
    this._sceneClockTimer = timer;
    return timing;
  }

  /**
   * Clean up after a scene run (whether completed, errored, or cancelled).
   * Stops the progress ticker, exits recording mode only when owned, finalizes telemetry,
   * and resets UI buttons to the idle state.
   */
  _finishRun() {
    clearInterval(this._progressTimer);
    this._progressTimer = null;
    clearInterval(this._sceneClockTimer);
    this._sceneClockTimer = null;
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
    if (this._sceneClockSnapshot) {
      const scene = this._project.scenes.find(
        ({ id }) => id === this._sceneClockSnapshot.sceneId,
      );
      const shot = scene?.shots?.find(
        ({ id }) => id === this._sceneClockSnapshot.shotId,
      );
      if (scene && shot) {
        this._publishSceneClock(
          scene,
          shot,
          this._sceneClockSnapshot.sceneElapsedSec,
          {
            running: false,
            seeking: this._sceneClockSnapshot.seeking,
          },
        );
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
