/** Authored project defaults and legacy migrations; no editor or playback state. */
import { SCENE_DOCUMENT_VERSION } from '../director/document.js';
import { SCENE_RECIPES } from './recipes.js';
import { MAP_STACKS } from '../maps/catalog.js';
import {
  BLOOM_INTENSITY_DEFAULT,
  BLOOM_SCALE_VERSION,
  decodeBloomIntensity,
} from '../bloom.js';

/** @constant {number} Current schema version for project migration */
export const PROJECT_VERSION = SCENE_DOCUMENT_VERSION;
/** @constant {number} Fallback camera flight duration per shot (seconds) */
export const DEFAULT_SHOT_DURATION_SEC = 4;
/** @constant {number} Default hold/pause after a shot completes (seconds) */
export const DEFAULT_HOLD_SEC = 0.9;
const SCENE_MAP_STACK_IDS = new Set(MAP_STACKS.map(({ id }) => id));

/**
 * Generate a short random identifier with the given prefix.
 * @param {string} prefix - e.g. 'shot', 'scene'
 * @returns {string} Identifier like "shot-a1b2c3d4"
 */
export function uid(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Deep-clone a JSON-serializable value via round-trip stringify/parse.
 * @param {*} value
 * @returns {*}
 */
export function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Normalize a raw layer state entry into a canonical { enabled, params? } shape.
 * Accepts both boolean shorthand and full object forms.
 * @param {boolean|Object} entry - Raw layer state (boolean or { enabled, params })
 * @returns {{ enabled: boolean, params?: Object }}
 */
export function normalizeLayerEntry(entry) {
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
  // Older projects (version < 3) used scale version 1.
  const explicitVersion = Number(rawBloom.version);
  const bloomVersion = Number.isFinite(explicitVersion)
    ? explicitVersion
    : projectVersion >= 3
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
export function recipeToScene(recipe) {
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
export function createDefaultProject() {
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
export function normalizeShot(
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
    camera: camera.anchorId
      ? {
          anchorId: camera.anchorId,
          heading: Number(camera.heading) || 0,
          pitch: Number.isFinite(Number(camera.pitch))
            ? Number(camera.pitch)
            : -35,
          roll: Number(camera.roll) || 0,
        }
      : {
          lat: Number(camera.lat) || 0,
          lon: Number(camera.lon) || 0,
          alt: Number.isFinite(Number(camera.alt)) ? Number(camera.alt) : 800,
          heading: Number(camera.heading) || 0,
          pitch: Number.isFinite(Number(camera.pitch))
            ? Number(camera.pitch)
            : -35,
          roll: Number(camera.roll) || 0,
          ...(camera.altitudeReference || rawShot?.move
            ? { altitudeReference: camera.altitudeReference || 'ellipsoid' }
            : {}),
        },
    ...(rawShot?.interactions
      ? { interactions: deepClone(rawShot.interactions) }
      : {}),
    ...(rawShot?.dataPackIds ? { dataPackIds: [...rawShot.dataPackIds] } : {}),
    ...(rawShot?.move ? { move: deepClone(rawShot.move) } : {}),
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
        ...(typeof detection.allocation === 'string'
          ? { allocation: detection.allocation }
          : {}),
        ...(Number.isFinite(Number(detection.fadePct))
          ? { fadePct: Number(detection.fadePct) }
          : {}),
        ...(Number.isFinite(Number(detection.outsideOpacityPct))
          ? { outsideOpacityPct: Number(detection.outsideOpacityPct) }
          : {}),
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
      ...(visual.scope && typeof visual.scope === 'object'
        ? { scope: deepClone(visual.scope) }
        : {}),
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
 * Defaults and migrates validated documents; empty projects remain empty.
 * @param {Object|null} rawProject - Raw project data (potentially from an older schema)
 * @returns {Object} Fully normalized project at the current PROJECT_VERSION
 */
export function normalizeProject(rawProject) {
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
        ...(scene?.dataPacks ? { dataPacks: deepClone(scene.dataPacks) } : {}),
        ...(scene?.anchors ? { anchors: deepClone(scene.anchors) } : {}),
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

  return {
    version: PROJECT_VERSION,
    createdAt: rawProject.createdAt || new Date().toISOString(),
    updatedAt: rawProject.updatedAt || new Date().toISOString(),
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
