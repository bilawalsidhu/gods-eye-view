/**
 * Scene recipes optimized for short social clips.
 * Each recipe is deterministic so repeated runs produce similar footage.
 */

import { expandNepalEvidencePack } from './nepalEvidencePack.js';

const BHOTE_KOSHI_NEPAL_BASE_RECIPE = Object.freeze({
  id: 'bhote-koshi-nepal-evidence-pack',
  version: 12,
  title: 'Bhote Koshi Evidence Sequence',
  style: 'normal',
  ui: { hidePanels: false, hudMode: 'full', safeFrame: '16:9' },
  layers: {
    'bhote-koshi-locator': false,
  },
  releaseLayerIds: ['bhote-koshi-2026', 'bhote-koshi-locator'],
  post: {
    bloom: 0,
    sharpen: true,
    detectionMode: 'OFF',
    mapStack: 'photoreal',
  },
  legacySceneBootstrap: {
    targetSceneTitle: 'Nepal Flood Incident',
    fromShotTitles: ['Shot 1', 'Shot 2', 'Shot 3'],
    cameraPath: [
      {
        title: 'Global Incident Context',
        lat: 27.5962,
        lon: 78.5718,
        alt: 15628002,
        heading: 0,
        pitch: -90,
        roll: 0,
        duration: 4,
        hold: 0.9,
        layers: {
          'bhote-koshi-locator': {
            enabled: true,
            params: { presentation: 'nepal-context' },
          },
        },
      },
      {
        title: 'Nepal-Focused Globe Rotation',
        lat: 28.7248,
        lon: 81.3226,
        alt: 2068966,
        heading: 0,
        pitch: -90,
        roll: 0,
        duration: 4,
        hold: 0.9,
        layers: {
          'bhote-koshi-locator': {
            enabled: true,
            params: { presentation: 'nepal-context' },
          },
        },
      },
      {
        title: 'Bhote Koshi Regional Approach',
        lat: 27.0354,
        lon: 84.6287,
        alt: 809543,
        heading: 0,
        pitch: -90,
        roll: 0,
        duration: 4,
        hold: 0.9,
        layers: {
          'bhote-koshi-locator': {
            enabled: true,
            params: { presentation: 'bhote-koshi-regional' },
          },
        },
      },
      {
        title: 'Bhote Koshi Nearby Cities',
        lat: 27.891,
        lon: 85.428,
        alt: 225734,
        heading: 0,
        pitch: -90,
        roll: 0,
        duration: 4,
        hold: 0.9,
        layers: {
          'bhote-koshi-locator': {
            enabled: true,
            params: { presentation: 'bhote-koshi-city-context' },
          },
        },
      },
      {
        title: 'Bhote Koshi Incident Corridor',
        lat: 28.0529,
        lon: 85.2189,
        alt: 126931,
        heading: 0,
        pitch: -90,
        roll: 0,
        duration: 4,
        hold: 11,
        layers: {
          'bhote-koshi-locator': {
            enabled: true,
            params: { presentation: 'bhote-koshi-incident-places' },
          },
        },
      },
      {
        title: 'Bhote Koshi Flood Path',
        lat: 28.1691,
        lon: 85.352,
        alt: 60328,
        heading: 0,
        pitch: -90,
        roll: 0,
        duration: 4,
        hold: 0.9,
        layers: {
          'bhote-koshi-locator': {
            enabled: true,
            params: { presentation: 'bhote-koshi-flood-path' },
          },
        },
      },
      {
        title: 'Bhote Koshi Corridor Overview',
        lat: 27.8986,
        lon: 84.8723,
        alt: 53247,
        heading: 60,
        pitch: -48,
        roll: 0,
        duration: 4,
        hold: 0.9,
        layers: {
          'bhote-koshi-locator': {
            enabled: true,
            params: { presentation: 'bhote-koshi-path-overview' },
          },
        },
      },
      {
        title: 'Bhote Koshi Upper Valley',
        lat: 28.4187,
        lon: 85.4341,
        alt: 7977,
        heading: 155,
        pitch: -28,
        roll: 0,
        duration: 4,
        hold: 8,
        layers: {
          'bhote-koshi-locator': {
            enabled: true,
            params: { presentation: 'bhote-koshi-trigger-record' },
          },
        },
      },
    ],
  },
  requiredShotTitles: [
    'Global Incident Context',
    'Nepal-Focused Globe Rotation',
    'Bhote Koshi Regional Approach',
    'Bhote Koshi Nearby Cities',
    'Bhote Koshi Incident Corridor',
    'Bhote Koshi Flood Path',
    'Bhote Koshi Corridor Overview',
    'Bhote Koshi Upper Valley',
    'Upper Valley Collapse',
    'Debris-Dammed Lake',
    'Nepal-China Border Gate',
    'Timure Evidence Cluster',
    'Syabru Besi Passage',
    'Bidur / Trishuli Consequence',
  ],
  requiredSourcePackBeatIds: [
    'immediate-collapse-viewpoint',
    'debris-dammed-lake',
    'gyirong-border-gate',
    'timure-cluster',
    'syabru-besi',
    'bidur-trishuli-bridge',
  ],
  requiredSourcePackLayerId: 'bhote-koshi-2026',
  photorealSurfaceBeatIds: [
    'gyirong-border-gate',
    'timure-cluster',
    'syabru-besi',
    'bidur-trishuli-bridge',
  ],
  runtimeControlsByBeat: {
    'immediate-collapse-viewpoint': { evidenceMediaAutoplay: true },
    'debris-dammed-lake': { evidenceMediaAutoplay: true },
    'gyirong-border-gate': {
      imageryComparison: true,
      evidenceSequence: true,
      evidenceSequenceDurationSec: 2.5,
      deferEvidenceUntilCameraSettled: true,
      evidenceRevealDurationSec: 2.5,
    },
    'timure-cluster': {
      imageryComparison: true,
      evidenceSequence: true,
      evidenceSequenceDurationSec: 4,
    },
    'syabru-besi': {
      imageryComparison: true,
      evidenceSequence: true,
      evidenceSequenceDurationSec: 4,
    },
    'bidur-trishuli-bridge': {
      evidenceSequence: true,
      evidenceSequenceDurationSec: 4,
    },
  },
  shotPatches: [
    {
      title: 'Global Incident Context',
      visual: { mapStack: 'photoreal' },
      layers: {
        'bhote-koshi-2026': {
          enabled: true,
          params: {
            presentation: 'scene-beat',
            beatId: 'immediate-collapse-viewpoint',
            beatReveal: 0.36,
            split: 0.5,
          },
        },
      },
    },
    {
      title: 'Nepal-Focused Globe Rotation',
      visual: { mapStack: 'photoreal' },
      layers: {
        'bhote-koshi-2026': {
          enabled: true,
          params: {
            presentation: 'scene-beat',
            beatId: 'debris-dammed-lake',
            beatReveal: 0.36,
            split: 0.5,
          },
        },
      },
    },
    {
      title: 'Bhote Koshi Regional Approach',
      visual: { mapStack: 'photoreal' },
      layers: {
        'bhote-koshi-2026': {
          enabled: true,
          params: {
            presentation: 'scene-beat',
            beatId: 'gyirong-border-gate',
            beatReveal: 0.36,
            split: 0.5,
          },
        },
      },
    },
    {
      title: 'Bhote Koshi Nearby Cities',
      visual: { mapStack: 'photoreal' },
      layers: {
        'bhote-koshi-2026': {
          enabled: true,
          params: {
            presentation: 'scene-beat',
            beatId: 'timure-cluster',
            beatReveal: 0.36,
            split: 0.5,
          },
        },
      },
    },
    {
      title: 'Bhote Koshi Incident Corridor',
      camera: {
        lat: 28.0529,
        lon: 85.2189,
        alt: 126931,
        heading: 0,
        pitch: -90,
        roll: 0,
      },
      holdSec: 11,
      visual: { mapStack: 'photoreal' },
      layers: {
        'bhote-koshi-2026': {
          enabled: true,
          params: {
            presentation: 'scene-beat',
            beatId: 'syabru-besi',
            beatReveal: 0.36,
            split: 0.5,
          },
        },
      },
    },
    {
      title: 'Bhote Koshi Flood Path',
      visual: { mapStack: 'photoreal' },
      layers: {
        'bhote-koshi-2026': {
          enabled: true,
          params: {
            presentation: 'scene-beat',
            beatId: 'bidur-trishuli-bridge',
            beatReveal: 0.36,
            split: 0.5,
          },
        },
      },
    },
    {
      title: 'Bhote Koshi Corridor Overview',
      visual: { mapStack: 'photoreal' },
      layers: {
        'bhote-koshi-2026': {
          enabled: true,
          params: {
            presentation: 'scene-beat',
            beatId: 'gyirong-border-gate',
            beatReveal: 0.36,
            split: 0.5,
          },
        },
      },
    },
    {
      title: 'Bhote Koshi Upper Valley',
      holdSec: 8,
      visual: { mapStack: 'photoreal' },
      layers: {
        'bhote-koshi-2026': {
          enabled: true,
          params: {
            presentation: 'scene-beat',
            beatId: 'immediate-collapse-viewpoint',
            beatReveal: 0.36,
            split: 0.5,
          },
        },
        'bhote-koshi-locator': {
          enabled: true,
          params: {
            presentation: 'bhote-koshi-trigger-record',
          },
        },
      },
    },
    {
      title: 'Upper Valley Collapse',
      camera: {
        lat: 28.417,
        lon: 85.3937,
        alt: 9850,
        heading: 146,
        pitch: -34,
        roll: 0,
      },
      layers: {
        'bhote-koshi-2026': {
          enabled: true,
          params: {
            presentation: 'scene-beat',
            beatId: 'immediate-collapse-viewpoint',
            beatReveal: 0.36,
            split: 0.5,
            sceneControls: { evidenceMediaAutoplay: true },
          },
        },
      },
    },
    {
      title: 'Nepal-China Border Gate',
      visual: { mapStack: 'photoreal' },
    },
    {
      title: 'Timure Evidence Cluster',
      visual: { mapStack: 'photoreal' },
    },
    {
      title: 'Syabru Besi Passage',
      visual: { mapStack: 'photoreal' },
    },
    {
      title: 'Bidur / Trishuli Consequence',
      visual: { mapStack: 'photoreal' },
    },
  ],
  cameraPath: [
    {
      title: 'Upper Valley Collapse',
      lat: 28.417,
      lon: 85.3937,
      alt: 9850,
      heading: 146,
      pitch: -34,
      roll: 0,
      duration: 4.2,
      hold: 1.4,
      layers: {
        'bhote-koshi-2026': {
          enabled: true,
          params: {
            presentation: 'scene-beat',
            beatId: 'immediate-collapse-viewpoint',
            beatReveal: 0.36,
            split: 0.5,
            sceneControls: { evidenceMediaAutoplay: true },
          },
        },
      },
    },
    {
      title: 'Debris-Dammed Lake',
      lat: 28.392914,
      lon: 85.570921,
      alt: 10744,
      heading: 232,
      pitch: -37,
      roll: 0,
      duration: 4.2,
      hold: 1.4,
      layers: {
        'bhote-koshi-2026': {
          enabled: true,
          params: {
            presentation: 'scene-beat',
            beatId: 'debris-dammed-lake',
            beatReveal: 0.36,
            split: 0.5,
            sceneControls: { evidenceMediaAutoplay: true },
          },
        },
      },
    },
    {
      title: 'Nepal-China Border Gate',
      mapStack: 'photoreal',
      lat: 28.316789,
      lon: 85.399734,
      alt: 5900,
      heading: 208,
      pitch: -42,
      roll: 0,
      duration: 4.2,
      hold: 2.5,
      layers: {
        'bhote-koshi-2026': {
          enabled: true,
          params: {
            presentation: 'scene-beat',
            beatId: 'gyirong-border-gate',
            beatReveal: 0.36,
            split: 0.5,
            sceneControls: {
              imageryComparison: true,
              evidenceSequence: true,
              evidenceSequenceDurationSec: 2.5,
              deferEvidenceUntilCameraSettled: true,
              evidenceRevealDurationSec: 2.5,
            },
          },
        },
      },
    },
    {
      title: 'Timure Evidence Cluster',
      mapStack: 'photoreal',
      lat: 28.285968,
      lon: 85.379136,
      alt: 5032,
      heading: 198,
      pitch: -40,
      roll: 0,
      duration: 4.2,
      hold: 4,
      layers: {
        'bhote-koshi-2026': {
          enabled: true,
          params: {
            presentation: 'scene-beat',
            beatId: 'timure-cluster',
            beatReveal: 0.36,
            split: 0.5,
            sceneControls: {
              imageryComparison: true,
              evidenceSequence: true,
              evidenceSequenceDurationSec: 4,
            },
          },
        },
      },
    },
    {
      title: 'Syabru Besi Passage',
      mapStack: 'photoreal',
      lat: 28.210306,
      lon: 85.361527,
      alt: 5893,
      heading: 205,
      pitch: -38,
      roll: 0,
      duration: 4.2,
      hold: 4,
      layers: {
        'bhote-koshi-2026': {
          enabled: true,
          params: {
            presentation: 'scene-beat',
            beatId: 'syabru-besi',
            beatReveal: 0.36,
            split: 0.5,
            sceneControls: {
              imageryComparison: true,
              evidenceSequence: true,
              evidenceSequenceDurationSec: 4,
            },
          },
        },
      },
    },
    {
      title: 'Bidur / Trishuli Consequence',
      mapStack: 'photoreal',
      lat: 27.981737,
      lon: 85.196273,
      alt: 7422,
      heading: 215,
      pitch: -40,
      roll: 0,
      duration: 4.2,
      hold: 4,
      layers: {
        'bhote-koshi-2026': {
          enabled: true,
          params: {
            presentation: 'scene-beat',
            beatId: 'bidur-trishuli-bridge',
            beatReveal: 0.36,
            split: 0.5,
            sceneControls: {
              evidenceSequence: true,
              evidenceSequenceDurationSec: 4,
            },
          },
        },
      },
    },
  ],
});

const BHOTE_KOSHI_NEPAL_APPEND_RECIPE = BHOTE_KOSHI_NEPAL_BASE_RECIPE
  ? expandNepalEvidencePack(BHOTE_KOSHI_NEPAL_BASE_RECIPE)
  : null;

// Fresh browser origins have no legacy three-shot Nepal project for the
// append recipe to upgrade. Seed that exact legacy shape so SceneDirector can
// run the same idempotent bootstrap used by existing browser-saved projects.
const BHOTE_KOSHI_NEPAL_BOOTSTRAP_RECIPE = BHOTE_KOSHI_NEPAL_APPEND_RECIPE
  ? Object.freeze({
      id: 'bhote-koshi-nepal-scene',
      title: 'Nepal Flood Incident',
      durationSec: 15,
      style: BHOTE_KOSHI_NEPAL_APPEND_RECIPE.style,
      ui: BHOTE_KOSHI_NEPAL_APPEND_RECIPE.ui,
      layers: BHOTE_KOSHI_NEPAL_APPEND_RECIPE.layers,
      releaseLayerIds: BHOTE_KOSHI_NEPAL_APPEND_RECIPE.releaseLayerIds,
      post: BHOTE_KOSHI_NEPAL_APPEND_RECIPE.post,
      installAlongsideSceneId: 'bhote-koshi-flood',
      installAlongsideFallbackSceneId: 'flights-radar',
      cameraPath:
        BHOTE_KOSHI_NEPAL_APPEND_RECIPE.legacySceneBootstrap.cameraPath
          .slice(0, 3)
          .map((keyframe, index) => ({
            ...keyframe,
            title: `Shot ${index + 1}`,
          })),
    })
  : null;

const EVENT_RECIPES = [BHOTE_KOSHI_NEPAL_BOOTSTRAP_RECIPE].filter(Boolean);

const PUBLIC_SCENE_RECIPES = [
  {
    id: 'flights-radar',
    title: 'Global Flights Radar',
    durationSec: 30,
    style: 'retro',
    ui: { hidePanels: true, hudMode: 'minimal', safeFrame: '16:9' },
    layers: {
      flights: true,
      satellites: false,
      earthquakes: false,
      traffic: false,
    },
    post: {
      bloom: 62,
      sharpen: true,
      detectionMode: 'OFF',
    },
    cameraPath: [
      {
        lat: 20.0,
        lon: -30.0,
        alt: 19000000,
        heading: 25,
        pitch: -65,
        roll: 0,
        duration: 6,
        hold: 1,
      },
      {
        lat: 46.0,
        lon: 2.0,
        alt: 8000000,
        heading: 40,
        pitch: -52,
        roll: 0,
        duration: 5,
        hold: 1,
      },
      {
        lat: 35.0,
        lon: 139.0,
        alt: 4200000,
        heading: 22,
        pitch: -46,
        roll: 0,
        duration: 5,
        hold: 1,
      },
      {
        lat: 37.6,
        lon: -122.4,
        alt: 1700000,
        heading: 8,
        pitch: -40,
        roll: 0,
        duration: 5,
        hold: 1,
      },
      {
        lat: 0.0,
        lon: -20.0,
        alt: 12000000,
        heading: -10,
        pitch: -70,
        roll: 0,
        duration: 4,
        hold: 0,
      },
    ],
  },
  {
    id: 'orbital-watch',
    title: 'Orbital Watch',
    durationSec: 32,
    style: 'surveillance',
    ui: { hidePanels: true, hudMode: 'full', safeFrame: '16:9' },
    layers: {
      flights: false,
      satellites: true,
      earthquakes: false,
      traffic: false,
    },
    post: {
      bloom: 58,
      sharpen: false,
      detectionMode: 'SPARSE',
      styleParams: {
        surveillance: {
          gain: 0.62,
          bloom: 0.38,
          scanlineStr: 0.9,
          pixelation: 2.1,
        },
      },
    },
    cameraPath: [
      {
        lat: 28.0,
        lon: -82.0,
        alt: 22000000,
        heading: 0,
        pitch: -82,
        roll: 0,
        duration: 7,
        hold: 1,
      },
      {
        lat: 10.0,
        lon: 20.0,
        alt: 12000000,
        heading: 18,
        pitch: -74,
        roll: 0,
        duration: 5,
        hold: 1,
      },
      {
        lat: 35.7,
        lon: 139.7,
        alt: 6500000,
        heading: 24,
        pitch: -64,
        roll: 0,
        duration: 5,
        hold: 1,
      },
      {
        lat: 48.8,
        lon: 2.3,
        alt: 3000000,
        heading: 32,
        pitch: -58,
        roll: 0,
        duration: 5,
        hold: 1,
      },
      {
        lat: 30.0,
        lon: -25.0,
        alt: 15000000,
        heading: -20,
        pitch: -78,
        roll: 0,
        duration: 4,
        hold: 0,
      },
    ],
  },
  {
    id: 'thermal-threats',
    title: 'Thermal Threat Board',
    durationSec: 26,
    style: 'thermal',
    ui: { hidePanels: true, hudMode: 'full', safeFrame: '16:9' },
    layers: {
      flights: false,
      satellites: false,
      earthquakes: true,
      traffic: false,
    },
    post: {
      bloom: 72,
      sharpen: true,
      detectionMode: 'OFF',
      styleParams: {
        thermal: {
          sensitivity: 0.84,
          bloom: 0.78,
          mode: 0.0,
          pixelation: 1.9,
        },
      },
    },
    cameraPath: [
      {
        lat: 37.0,
        lon: -121.0,
        alt: 5200000,
        heading: 20,
        pitch: -62,
        roll: 0,
        duration: 5,
        hold: 1,
      },
      {
        lat: 35.7,
        lon: 140.0,
        alt: 3100000,
        heading: 5,
        pitch: -55,
        roll: 0,
        duration: 5,
        hold: 1,
      },
      {
        lat: -36.8,
        lon: 174.7,
        alt: 2600000,
        heading: -12,
        pitch: -50,
        roll: 0,
        duration: 5,
        hold: 1,
      },
      {
        lat: 38.0,
        lon: -10.0,
        alt: 9000000,
        heading: 12,
        pitch: -70,
        roll: 0,
        duration: 4,
        hold: 0,
      },
    ],
  },
  {
    id: 'city-overload',
    title: 'City Overload',
    durationSec: 30,
    style: 'surveillance',
    ui: { hidePanels: true, hudMode: 'minimal', safeFrame: '9:16' },
    layers: {
      flights: true,
      satellites: true,
      earthquakes: false,
      traffic: true,
    },
    post: {
      bloom: 65,
      sharpen: true,
      detectionMode: 'PANOPTIC',
      styleParams: {
        surveillance: {
          gain: 0.68,
          bloom: 0.42,
          scanlineStr: 1.0,
          pixelation: 2.4,
        },
      },
    },
    cameraPath: [
      {
        lat: 40.73,
        lon: -74.0,
        alt: 1500000,
        heading: 25,
        pitch: -44,
        roll: 0,
        duration: 5,
        hold: 1,
      },
      {
        lat: 40.73,
        lon: -74.0,
        alt: 550000,
        heading: 58,
        pitch: -36,
        roll: 0,
        duration: 4,
        hold: 1,
      },
      {
        lat: 40.73,
        lon: -74.0,
        alt: 260000,
        heading: 102,
        pitch: -33,
        roll: 0,
        duration: 4,
        hold: 1,
      },
      {
        lat: 34.05,
        lon: -118.24,
        alt: 1200000,
        heading: 45,
        pitch: -42,
        roll: 0,
        duration: 5,
        hold: 1,
      },
      {
        lat: 51.5,
        lon: -0.12,
        alt: 1200000,
        heading: 22,
        pitch: -44,
        roll: 0,
        duration: 5,
        hold: 0,
      },
    ],
  },
  {
    id: 'omniscience-pullback',
    title: 'Omniscience Pullback',
    durationSec: 36,
    style: 'retro',
    ui: { hidePanels: true, hudMode: 'full', safeFrame: '16:9' },
    layers: {
      flights: true,
      satellites: true,
      earthquakes: true,
      traffic: true,
    },
    post: {
      bloom: 68,
      sharpen: true,
      detectionMode: 'SPARSE',
      styleParams: {
        retro: {
          pixelation: 4.4,
          distortion: 0.42,
          instability: 0.58,
        },
      },
    },
    cameraPath: [
      {
        lat: 35.68,
        lon: 139.76,
        alt: 280000,
        heading: 30,
        pitch: -26,
        roll: 0,
        duration: 5,
        hold: 1,
      },
      {
        lat: 35.68,
        lon: 139.76,
        alt: 900000,
        heading: 26,
        pitch: -38,
        roll: 0,
        duration: 4,
        hold: 1,
      },
      {
        lat: 35.68,
        lon: 139.76,
        alt: 3800000,
        heading: 18,
        pitch: -52,
        roll: 0,
        duration: 5,
        hold: 1,
      },
      {
        lat: 20.0,
        lon: 110.0,
        alt: 9500000,
        heading: 8,
        pitch: -66,
        roll: 0,
        duration: 5,
        hold: 1,
      },
      {
        lat: 5.0,
        lon: 30.0,
        alt: 18000000,
        heading: -8,
        pitch: -78,
        roll: 0,
        duration: 6,
        hold: 0,
      },
    ],
  },
];

/** Build the recipe list without mutating stored user-authored projects. */
export function createSceneRecipes({ localDemoRecipes = EVENT_RECIPES } = {}) {
  return [...localDemoRecipes, ...PUBLIC_SCENE_RECIPES];
}

export const SCENE_RECIPES = createSceneRecipes();

export const SCENE_APPEND_RECIPES = BHOTE_KOSHI_NEPAL_APPEND_RECIPE
  ? [BHOTE_KOSHI_NEPAL_APPEND_RECIPE]
  : [];

export function getSceneRecipeById(id) {
  return SCENE_RECIPES.find((recipe) => recipe.id === id) || null;
}

export function getSceneAppendRecipeById(id) {
  return SCENE_APPEND_RECIPES.find((recipe) => recipe.id === id) || null;
}
