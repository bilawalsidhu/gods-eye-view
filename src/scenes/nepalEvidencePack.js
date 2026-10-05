import { SOURCE_PATH_BEAT_IDS } from '../data/bhoteKoshiShotPaths.js';

/**
 * Nepal evidence expansion. Coordinates and camera framing come from
 * the source event pack; existing authored cameras remain owned by the Scene.
 */
const ADDITIONAL_SHOTS = [
  {
    id: 'second-landslide',
    title: 'Second landslide',
    lat: 28.399234,
    lon: 85.535806,
    alt: 10145,
    heading: 224,
    pitch: -38,
    hold: 11,
  },
  {
    id: 'dhunche',
    title: 'Dhunche',
    lat: 28.161431,
    lon: 85.324278,
    alt: 6212,
    heading: 208,
    pitch: -39,
    hold: 16,
  },
  {
    id: 'mailung-upper-trishuli',
    title: 'Mailung / Upper Trishuli bridge',
    lat: 28.140642,
    lon: 85.265996,
    alt: 6353,
    heading: 211,
    pitch: -40,
    hold: 13,
  },
  {
    id: 'mailung-bazzar',
    title: 'Mailung Bazzar, Dandaguan',
    lat: 28.126526,
    lon: 85.248027,
    alt: 6331,
    heading: 212,
    pitch: -40,
    hold: 15,
  },
  {
    id: 'dandagaun',
    title: 'Dandagaun, Rasuwa',
    lat: 28.124424,
    lon: 85.245154,
    alt: 6311,
    heading: 214,
    pitch: -40,
    hold: 15,
  },
  {
    id: 'dandagaun-viewpoint',
    title: 'Dandagaun viewpoint restaurant',
    lat: 28.086663,
    lon: 85.229914,
    alt: 6740,
    heading: 215,
    pitch: -41,
    hold: 13,
  },
  {
    id: 'betrawati-bazaar',
    title: 'Betrawati Bazaar',
    lat: 28.029827,
    lon: 85.227694,
    alt: 7034,
    heading: 216,
    pitch: -41,
    hold: 12,
  },
  {
    id: 'bhainse',
    title: 'Bhainse',
    lat: 28.023087,
    lon: 85.229449,
    alt: 8051,
    heading: 219,
    pitch: -41,
    hold: 13,
  },
  {
    id: 'devighat-taadi-khola-bridge',
    title: 'Devighat / Taadi Khola Bridge',
    lat: 27.921132,
    lon: 85.177113,
    alt: 9056,
    heading: 224,
    pitch: -42,
    hold: 13,
  },
  {
    id: 'charaudi',
    title: 'Charaudi',
    lat: 27.865095,
    lon: 84.838424,
    alt: 10347,
    heading: 232,
    pitch: -42,
    hold: 11,
  },
  {
    id: 'final-view',
    title: 'Final view',
    lat: 28.0834,
    lon: 85.206,
    alt: 113520,
    heading: 64,
    pitch: -83,
    roll: 174,
    duration: 4,
    hold: 11,
    locatorPresentation: 'bhote-koshi-incident-places',
  },
];
const EVIDENCE_ORDER = [
  'immediate-collapse-viewpoint',
  'debris-dammed-lake',
  'second-landslide',
  'gyirong-border-gate',
  'timure-cluster',
  'syabru-besi',
  'dhunche',
  'mailung-upper-trishuli',
  'mailung-bazzar',
  'dandagaun',
  'dandagaun-viewpoint',
  'betrawati-bazaar',
  'bhainse',
  'bidur-trishuli-bridge',
  'devighat-taadi-khola-bridge',
  'charaudi',
  'final-view',
];

// Per-reach motion timing keeps the schematic front ahead of the fixed 4.2s
// camera flights without pretending short urban reaches and long valley runs
// should advance at one global speed.
const PATH_DURATION_BY_BEAT = Object.freeze({
  'debris-dammed-lake': 4.8,
  'second-landslide': 6.5,
  'timure-cluster': 2.1,
  'syabru-besi': 2.8,
  dhunche: 2.5,
  'mailung-upper-trishuli': 2.9,
  'mailung-bazzar': 2.1,
  dandagaun: 1.2,
  'dandagaun-viewpoint': 2.5,
  'betrawati-bazaar': 2.9,
  bhainse: 1.5,
  'bidur-trishuli-bridge': 2.6,
});

/** Extend the six-beat Nepal pack without replacing existing authored shots. */
export function expandNepalEvidencePack(base) {
  const layerId = base.requiredSourcePackLayerId;
  const extraShots = ADDITIONAL_SHOTS.map(
    ({ id, hold, duration = 4.2, locatorPresentation, ...camera }) => ({
      ...camera,
      roll: Number.isFinite(Number(camera.roll)) ? Number(camera.roll) : 0,
      duration,
      hold,
      mapStack: 'photoreal',
      layers: {
        [layerId]: {
          enabled: true,
          params: {
            presentation: 'scene-beat',
            beatId: id,
            beatReveal: 0.36,
            split: 0.5,
          },
        },
        ...(locatorPresentation
          ? {
              'bhote-koshi-locator': {
                enabled: true,
                params: { presentation: locatorPresentation },
              },
            }
          : {}),
      },
    }),
  );
  const byBeat = new Map(
    [...base.cameraPath, ...extraShots].map((shot) => [
      shot.layers[layerId].params.beatId,
      shot,
    ]),
  );
  const cameraPath = EVIDENCE_ORDER.map((id) => byBeat.get(id));
  const runtimeControlsByBeat = { ...base.runtimeControlsByBeat };
  const cameraLedPathBeats = new Set([
    'timure-cluster',
    'syabru-besi',
    ...SOURCE_PATH_BEAT_IDS.slice(2),
  ]);
  const mediaLedPathBeats = new Set(['debris-dammed-lake', 'second-landslide']);
  const finalSourcedPathBeatId = SOURCE_PATH_BEAT_IDS.at(-1);
  const postSourceHistoryBeats = new Set([
    'devighat-taadi-khola-bridge',
    'charaudi',
    'final-view',
  ]);
  for (const shot of cameraPath) {
    const id = shot.layers[layerId].params.beatId;
    const isFinalView = id === 'final-view';
    const authoredPathDurationSec = PATH_DURATION_BY_BEAT[id];
    runtimeControlsByBeat[id] = {
      ...runtimeControlsByBeat[id],
      evidenceMediaAutoplay: !isFinalView,
      ...(isFinalView
        ? {}
        : {
            mediaPlaybackHoldSec: id === 'mailung-bazzar' ? 7 : 6,
            mediaExitDurationSec: 0.65,
          }),
      deferEvidenceUntilCameraSettled: !isFinalView,
      evidenceRevealDurationSec: 0.9,
      evidencePath: SOURCE_PATH_BEAT_IDS.includes(id)
        ? 'source'
        : ['gyirong-border-gate', 'timure-cluster', 'syabru-besi'].includes(id)
          ? 'comparison'
          : 'none',
      ...(cameraLedPathBeats.has(id)
        ? {
            evidencePathDuringCamera: true,
            evidencePathPersistent: true,
            ...(authoredPathDurationSec
              ? { evidencePathTravelDurationSec: authoredPathDurationSec }
              : {}),
          }
        : {}),
      ...(mediaLedPathBeats.has(id)
        ? {
            evidencePathDuringMedia: true,
            evidencePathPersistent: true,
            evidencePathStartDelaySec: 0,
          }
        : {}),
    };
    if (SOURCE_PATH_BEAT_IDS.includes(id)) {
      runtimeControlsByBeat[id] = {
        ...runtimeControlsByBeat[id],
        evidenceHoldCard: true,
        evidencePathHistory: true,
        evidencePathDurationSec:
          authoredPathDurationSec || Math.max(4, shot.hold),
        minimumHoldSec: Math.max(4, shot.hold),
      };
    }
    if (SOURCE_PATH_BEAT_IDS.slice(2).includes(id)) {
      runtimeControlsByBeat[id] = {
        ...runtimeControlsByBeat[id],
        evidencePathHistory: true,
        evidencePathElevation: 'source',
      };
    }
    if (postSourceHistoryBeats.has(id)) {
      runtimeControlsByBeat[id] = {
        ...runtimeControlsByBeat[id],
        evidencePath: 'history',
        evidencePathHistory: true,
        evidencePathHistoryBeatId: finalSourcedPathBeatId,
        evidencePathPersistent: true,
        evidencePathElevation: 'source',
      };
    }
    const pathDurationSec =
      Number(runtimeControlsByBeat[id].evidencePathDurationSec) ||
      (!cameraLedPathBeats.has(id) &&
      runtimeControlsByBeat[id].evidenceSequence === true
        ? Number(runtimeControlsByBeat[id].evidenceSequenceDurationSec) || 0
        : 0);
    const mediaPresentationSec = isFinalView
      ? 0
      : (id === 'mailung-bazzar' ? 7 : 6) + 0.65;
    const mediaAndPathHoldSec =
      pathDurationSec > 0 && !cameraLedPathBeats.has(id)
        ? mediaLedPathBeats.has(id)
          ? Math.max(mediaPresentationSec, pathDurationSec)
          : mediaPresentationSec + pathDurationSec
        : mediaPresentationSec;
    runtimeControlsByBeat[id] = {
      ...runtimeControlsByBeat[id],
      minimumHoldSec:
        id === 'mailung-bazzar'
          ? mediaAndPathHoldSec
          : Math.max(
              Number(runtimeControlsByBeat[id].minimumHoldSec) || 0,
              mediaAndPathHoldSec,
            ),
    };
  }
  // Keep the downstream sequence on its sourced river profile. Coarse Google
  // mesh samples can contain cliff-height spikes that reverse apparent motion.
  // Preserve each authored readable hold after the media-first timing floor.
  for (const [id, seconds, sequenceSeconds = seconds] of [
    ['immediate-collapse-viewpoint', 10],
    ['gyirong-border-gate', 8, 2.5],
    ['timure-cluster', 12],
    ['syabru-besi', 11],
  ]) {
    runtimeControlsByBeat[id] = {
      ...runtimeControlsByBeat[id],
      evidenceHoldCard: true,
      evidenceSequenceDurationSec: sequenceSeconds,
      minimumHoldSec: Math.max(
        Number(runtimeControlsByBeat[id].minimumHoldSec) || 0,
        seconds,
      ),
    };
  }
  const finalView = byBeat.get('final-view');
  return Object.freeze({
    ...base,
    version: 18,
    cameraPath,
    runtimeControlsByBeat,
    // Clip trims must also replace older saved holds, not just lower a floor.
    runtimeHoldSecByBeat: { 'mailung-bazzar': 7 + 0.65 },
    expansionFromVersion: 17,
    previousRequiredSourcePackBeatIds: EVIDENCE_ORDER.slice(0, -1),
    previousRequiredSourcePackBeatIdVariants: [
      base.requiredSourcePackBeatIds,
      EVIDENCE_ORDER.slice(0, -1),
    ],
    requiredSourcePackBeatIds: EVIDENCE_ORDER,
    requiredShotTitles: [
      ...base.requiredShotTitles.slice(0, -base.cameraPath.length),
      ...cameraPath.map(({ title }) => title),
    ],
    adoptExistingShotTitles: ['Final view'],
    shotPatches: [
      ...(base.shotPatches || []),
      {
        title: 'Final view',
        layers: finalView.layers,
      },
    ],
    photorealSurfaceBeatIds: EVIDENCE_ORDER,
  });
}
