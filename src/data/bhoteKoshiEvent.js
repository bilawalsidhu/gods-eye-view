import * as Cesium from 'cesium';
import { isPointerFree } from './inputOwnership.js';
import {
  clearOverlaySource,
  hitTestWorldOverlay,
  setOverlayEntries,
  setOverlaySourceVisible,
} from '../overlays/worldOverlay.js';
import { WORLD_OVERLAY_STYLE } from '../overlays/worldOverlayTokens.js';
import {
  governorRequestRender,
  holdContinuousRender,
  releaseContinuousRender,
} from '../renderGovernor.js';
import { announceNavigationAuthority } from '../navigationPolicy.js';
import { BHOTE_KOSHI_CREDIT, registerDynamicCredit } from './dataCredits.js';
import {
  buildSourceShotPaths,
  SOURCE_PATH_BEAT_IDS,
} from './bhoteKoshiShotPaths.js';
import {
  createBhoteKoshiEmbeddedMedia,
  resolveEmbeddedMediaSource,
} from './bhoteKoshiEmbeddedMedia.js';
import { acquireImageryComparison } from '../maps/imageryComparison.js';
import { createImagerySplit } from '../ui/imagerySplit.js';

export const BHOTE_KOSHI_LAYER_ID = 'bhote-koshi-2026';
export const BHOTE_KOSHI_OVERLAY_SOURCE_ID = 'bhote-koshi-witnesses';
export const BHOTE_KOSHI_PLAYBACK_SECONDS = 90;
export const BHOTE_KOSHI_PROLOGUE_END = 0.22;
export const BHOTE_KOSHI_CORRIDOR_END = 0.84;
export const BHOTE_KOSHI_CAMERA_HOLD_RATIO = 0.62;
export const BHOTE_KOSHI_SCENE_PRESENTATION = 'scene-beat';
const BHOTE_KOSHI_SCENE_PANEL_ONLY = 'panel-only';
const BHOTE_KOSHI_SCENE_EVIDENCE_BEAT = 'evidence-beat';

const EVENT_ASSET_ROOT = `${import.meta.env?.BASE_URL || '/'}events/bhote-koshi-2026/`;
const FLOOD_RENDER_HOLD = 'bhote-koshi-playback';
const SCENE_REVEAL_RENDER_HOLD = 'bhote-koshi-scene-beat-reveal';
const SCENE_PATH_RENDER_HOLD = 'bhote-koshi-scene-path-travel';
const SCENE_MEDIA_MIN_PLAYBACK_SECONDS = 6;
const SCENE_MEDIA_EXIT_SECONDS = 0.65;
const BHOTE_EVENT_ACCENT = WORLD_OVERLAY_STYLE.accent;
const FLOOD_COLOR = Cesium.Color.fromCssColorString('#d8954e').withAlpha(0.68);
const SURGE_COLOR = Cesium.Color.fromCssColorString('#e8b47c');
const CINEMATIC_INPUT_EVENTS = Object.freeze(['pointerdown', 'wheel']);
const CINEMATIC_VIEW_SPECS = Object.freeze([
  {
    id: 'immediate-collapse-viewpoint',
    headingDeg: 224,
    pitchDeg: -38,
    rangeM: 15000,
  },
  { id: 'debris-dammed-lake', headingDeg: 232, pitchDeg: -37, rangeM: 13200 },
  { id: 'second-landslide', headingDeg: 224, pitchDeg: -38, rangeM: 12000 },
  { id: 'gyirong-border-gate', headingDeg: 208, pitchDeg: -42, rangeM: 6100 },
  { id: 'timure-cluster', headingDeg: 198, pitchDeg: -40, rangeM: 5200 },
  { id: 'syabru-besi', headingDeg: 205, pitchDeg: -38, rangeM: 7200 },
  { id: 'dhunche', headingDeg: 208, pitchDeg: -39, rangeM: 7800 },
  {
    id: 'mailung-upper-trishuli',
    headingDeg: 211,
    pitchDeg: -40,
    rangeM: 8400,
  },
  { id: 'mailung-bazzar', headingDeg: 212, pitchDeg: -40, rangeM: 8600 },
  { id: 'dandagaun', headingDeg: 214, pitchDeg: -40, rangeM: 8600 },
  { id: 'dandagaun-viewpoint', headingDeg: 215, pitchDeg: -41, rangeM: 9200 },
  { id: 'betrawati-bazaar', headingDeg: 216, pitchDeg: -41, rangeM: 9800 },
  { id: 'bhainse', headingDeg: 219, pitchDeg: -41, rangeM: 11500 },
  {
    id: 'bidur-trishuli-bridge',
    headingDeg: 248,
    pitchDeg: -46,
    rangeM: 15500,
  },
  {
    id: 'devighat-taadi-khola-bridge',
    headingDeg: 224,
    pitchDeg: -42,
    rangeM: 13000,
  },
  { id: 'charaudi', headingDeg: 232, pitchDeg: -42, rangeM: 15000 },
  {
    id: 'charaudi',
    progress: 1,
    headingDeg: 232,
    pitchDeg: -42,
    rangeM: 15000,
  },
]);
const PASSIVE_ENABLE_ORIGINS = new Set([
  'scene',
  'share-restore',
  'local-restore',
  'context-restore',
  'dependency-restore',
]);

const DEFAULT_OVERLAY_HOST = Object.freeze({
  setEntries: setOverlayEntries,
  setVisible: setOverlaySourceVisible,
  clearSource: clearOverlaySource,
  hitTest: hitTestWorldOverlay,
});
const DEFAULT_RENDER_HOST = Object.freeze({
  request: governorRequestRender,
  hold: holdContinuousRender,
  release: releaseContinuousRender,
});
const DEFAULT_EVENT_LOADER = async () => {
  const response = await fetch(eventAsset('event.json'), { cache: 'no-store' });
  if (!response.ok)
    throw new Error(`Bhote Koshi event pack unavailable (${response.status})`);
  return response.json();
};
const DEFAULT_IMAGERY_PROVIDER_FACTORY = (url, options) =>
  Cesium.SingleTileImageryProvider.fromUrl(url, options);
const DEFAULT_TERRAIN_SAMPLER = async (viewer, observations) => {
  if (
    !viewer?.terrainProvider ||
    !viewer.terrainProvider.availability ||
    typeof Cesium.sampleTerrainMostDetailed !== 'function'
  ) {
    return null;
  }
  const cartographics = observations.map((observation) =>
    Cesium.Cartographic.fromDegrees(observation.lon, observation.lat),
  );
  return Cesium.sampleTerrainMostDetailed(
    viewer.terrainProvider,
    cartographics,
  );
};
const DEFAULT_MEDIA_LOADER = async (url, { signal } = {}) => {
  if (typeof createImageBitmap !== 'function') {
    throw new Error('Evidence poster decoding is unavailable');
  }
  const response = await fetch(url, {
    cache: 'force-cache',
    credentials: 'omit',
    mode: 'cors',
    signal,
  });
  if (!response.ok)
    throw new Error(`Evidence poster unavailable (${response.status})`);
  return createImageBitmap(await response.blob());
};
const DEFAULT_VIDEO_FACTORY = () => {
  const video = globalThis.document?.createElement?.('video');
  if (
    !video ||
    typeof video.play !== 'function' ||
    typeof video.pause !== 'function'
  )
    return null;
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  return video;
};

export function clampUnit(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

export function elapsedLabel(progress, totalSeconds) {
  const elapsed = Math.round(
    clampUnit(progress) * Math.max(0, Number(totalSeconds) || 0),
  );
  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function visibleSegmentCount(progress, segmentCount) {
  const count = Math.max(0, Math.floor(Number(segmentCount) || 0));
  const normalizedProgress = clampUnit(progress);
  if (count === 0 || normalizedProgress <= 0) return 0;
  return Math.min(count, Math.max(1, Math.ceil(normalizedProgress * count)));
}

/**
 * Build a corridor whose final vertex is the exact animated surge position.
 * Returns true only when the Cesium polyline assignments need refreshing.
 */
export function updateCorridorPositionCache(progress, terrainPositions, cache) {
  const positions = Array.isArray(terrainPositions) ? terrainPositions : [];
  const normalizedProgress = clampUnit(progress);
  const segmentCount = Math.max(0, positions.length - 1);
  const visibleCount = visibleSegmentCount(normalizedProgress, segmentCount);
  if (cache.progress === normalizedProgress && cache.source === positions)
    return false;

  cache.progress = normalizedProgress;
  cache.source = positions;
  cache.visibleCount = visibleCount;
  if (segmentCount === 0 || normalizedProgress <= 0) {
    cache.positions = [];
    cache.headPosition = null;
    return true;
  }

  const scaledProgress = normalizedProgress * segmentCount;
  const startIndex = Math.min(segmentCount - 1, Math.floor(scaledProgress));
  const segmentProgress =
    normalizedProgress >= 1 ? 1 : scaledProgress - startIndex;
  cache.headPosition = Cesium.Cartesian3.lerp(
    positions[startIndex],
    positions[startIndex + 1],
    segmentProgress,
    cache.headPosition || new Cesium.Cartesian3(),
  );
  cache.positions = positions.slice(0, startIndex + 1);
  if (segmentProgress > 0) {
    cache.positions.push(Cesium.Cartesian3.clone(cache.headPosition));
  }
  return true;
}

/** Map the editorial story clock onto the existing flood-front corridor clock. */
export function floodProgressForStoryProgress(progress, window = null) {
  const storyProgress = clampUnit(progress);
  const start = window?.start ?? BHOTE_KOSHI_PROLOGUE_END;
  const end = window?.end ?? BHOTE_KOSHI_CORRIDOR_END;
  if (storyProgress <= start) return 0;
  if (storyProgress >= end) return 1;
  return (storyProgress - start) / (end - start);
}

/**
 * Resolve curated evidence triggers onto the one event clock. Manual-phase
 * beats are explicit editorial ordering; corridor beats inherit chainage.
 */
export function buildEvidenceTimeline(observations, corridor) {
  const beats = Array.isArray(observations) ? observations : [];
  const points = Array.isArray(corridor) ? corridor : [];
  const firstChainage = Number(points[0]?.chainageM);
  const lastChainage = Number(points[points.length - 1]?.chainageM);
  const span = Math.max(1, lastChainage - firstChainage);
  const timeline = beats
    .map((observation, sourceIndex) => {
      const trigger = observation?.trigger || {};
      let activationProgress;
      if (
        trigger.mode === 'corridor' &&
        Number.isFinite(Number(trigger.chainageM))
      ) {
        const corridorProgress = clampUnit(
          (Number(trigger.chainageM) - firstChainage) / span,
        );
        activationProgress =
          BHOTE_KOSHI_PROLOGUE_END +
          corridorProgress *
            (BHOTE_KOSHI_CORRIDOR_END - BHOTE_KOSHI_PROLOGUE_END);
      } else {
        activationProgress = clampUnit(trigger.storyProgress);
      }
      return { observation, sourceIndex, activationProgress };
    })
    .sort(
      (a, b) =>
        a.activationProgress - b.activationProgress ||
        a.sourceIndex - b.sourceIndex,
    );

  for (let index = 0; index < timeline.length; index += 1) {
    timeline[index].deactivationProgress =
      timeline[index + 1]?.activationProgress ?? 1.000001;
  }
  return timeline;
}

/** Return the one active evidence beat for deterministic replay and scrubbing. */
export function activeEvidenceIndex(progress, timeline) {
  const normalized = clampUnit(progress);
  let activeIndex = -1;
  for (let index = 0; index < timeline.length; index += 1) {
    if (normalized < timeline[index].activationProgress) break;
    if (
      normalized < timeline[index].deactivationProgress ||
      index === timeline.length - 1
    ) {
      activeIndex = index;
    }
  }
  return activeIndex;
}

/** Resolve a stable evidence id to a visible point inside that beat's window. */
export function evidenceBeatProgress(beatId, timeline, reveal = 0.36) {
  const beat = (Array.isArray(timeline) ? timeline : []).find(
    ({ observation }) => observation?.id === beatId,
  );
  if (!beat) return null;
  const start = clampUnit(beat.activationProgress);
  const end = Math.max(start, Math.min(1, beat.deactivationProgress));
  return clampUnit(start + (end - start) * clampUnit(reveal));
}

/** Resolve the exact standalone story-clock span owned by one embedded shot. */
export function evidenceSequenceWindow(beatId, timeline) {
  const beats = Array.isArray(timeline) ? timeline : [];
  const beatIndex = beats.findIndex(
    ({ observation }) => observation?.id === beatId,
  );
  if (beatIndex < 0) return null;
  const beat = beats[beatIndex];
  const startProgress = clampUnit(beat.activationProgress);
  const targetProgress = clampUnit(beat.deactivationProgress);
  return {
    startProgress: Math.min(startProgress, targetProgress),
    targetProgress,
  };
}

function smoothstep(from, to, value) {
  if (to <= from) return value >= to ? 1 : 0;
  const amount = clampUnit((value - from) / (to - from));
  return amount * amount * (3 - 2 * amount);
}

/**
 * Resolve a card's reveal and recession from the one normalized story clock.
 * The stable hold matches the camera hold; no wall-clock TTL can drift from it.
 */
export function evidenceBeatPresentation(progress, beat) {
  if (!beat) {
    return {
      alpha: 0,
      scale: 0.96,
      leaderProgress: 0,
      contentAlpha: 0,
      localProgress: 0,
    };
  }
  const start = clampUnit(beat.activationProgress);
  const end = Math.max(
    start + 0.000001,
    Math.min(1.000001, beat.deactivationProgress),
  );
  const localProgress = clampUnit(
    (clampUnit(progress) - start) / (end - start),
  );
  const beatDurationSeconds = Math.max(
    0.25,
    (end - start) * BHOTE_KOSHI_PLAYBACK_SECONDS,
  );
  const dotEnd = Math.min(0.12, 0.25 / beatDurationSeconds);
  const leaderStart = dotEnd * 0.35;
  const leaderEnd = Math.min(0.24, leaderStart + 0.35 / beatDurationSeconds);
  const contentStart = Math.min(
    leaderEnd,
    leaderStart + 0.12 / beatDurationSeconds,
  );
  const contentEnd = Math.min(0.34, contentStart + 0.6 / beatDurationSeconds);
  const dotReveal = smoothstep(0, dotEnd, localProgress);
  const leaderReveal = smoothstep(leaderStart, leaderEnd, localProgress);
  const contentReveal = smoothstep(contentStart, contentEnd, localProgress);
  const contentHold =
    1 - smoothstep(BHOTE_KOSHI_CAMERA_HOLD_RATIO, 0.78, localProgress);
  const leaderHold = 1 - smoothstep(0.74, 0.9, localProgress);
  const dotHold = 1 - smoothstep(0.86, 1, localProgress);
  const alpha = Math.min(dotReveal, dotHold);
  const leaderProgress = Math.min(leaderReveal, leaderHold);
  const revealScale = 0.96 + contentReveal * 0.04;
  const recedeScale = 1 - (1 - contentHold) * 0.03;
  return {
    alpha,
    scale: revealScale * recedeScale,
    leaderProgress,
    contentAlpha: Math.min(contentReveal, contentHold),
    localProgress,
  };
}

/** Resolve a deterministic previous/next beat without creating another clock. */
export function adjacentEvidenceIndex(progress, timeline, direction) {
  const beats = Array.isArray(timeline) ? timeline : [];
  if (beats.length === 0) return -1;
  const current = Math.max(0, activeEvidenceIndex(progress, beats));
  const delta = Number(direction) < 0 ? -1 : Number(direction) > 0 ? 1 : 0;
  return Math.max(0, Math.min(beats.length - 1, current + delta));
}

/** Compact, source-bounded disclosure for multi-source geolocation beats. */
export function evidenceCorroborationLabel(observation) {
  const count = Math.max(
    0,
    Math.floor(Number(observation?.corroboration?.sourceCount) || 0),
  );
  return count > 1 ? `${count} GEOLOCATED SOURCE-MAP PLACEMENTS` : '';
}

/** Interpolate headings across north using the shortest angular path. */
export function interpolateHeadingDegrees(start, end, amount) {
  const from = Number(start) || 0;
  const to = Number(end) || 0;
  const delta = ((to - from + 540) % 360) - 180;
  return (((from + delta * clampUnit(amount)) % 360) + 360) % 360;
}

/** Resolve the editorial camera beats against the terrain-sampled evidence anchors. */
export function buildCinematicKeyframes(timeline, anchors) {
  const beats = Array.isArray(timeline) ? timeline : [];
  const positions = Array.isArray(anchors) ? anchors : [];
  const resolved = new Map();
  for (let index = 0; index < beats.length; index += 1) {
    const id = beats[index]?.observation?.id;
    if (id && positions[index])
      resolved.set(id, { beat: beats[index], target: positions[index] });
  }
  return CINEMATIC_VIEW_SPECS.flatMap((spec) => {
    const entry = resolved.get(spec.id);
    if (!entry) return [];
    return [
      {
        ...spec,
        progress: Number.isFinite(spec.progress)
          ? spec.progress
          : entry.beat.activationProgress,
        target: entry.target,
      },
    ];
  }).sort((a, b) => a.progress - b.progress);
}

/** Sample a camera pose directly from the event clock. */
export function sampleCinematicPose(progress, keyframes, result = {}) {
  const frames = Array.isArray(keyframes) ? keyframes : [];
  if (frames.length === 0) return null;
  const normalized = clampUnit(progress);
  let from = frames[0];
  let to = frames[frames.length - 1];
  for (let index = 1; index < frames.length; index += 1) {
    if (normalized <= frames[index].progress) {
      to = frames[index];
      from = frames[index - 1];
      break;
    }
  }
  if (normalized <= frames[0].progress) from = to = frames[0];
  if (normalized >= frames[frames.length - 1].progress)
    from = to = frames[frames.length - 1];
  const span = Math.max(0.000001, to.progress - from.progress);
  const linearAmount =
    from === to ? 0 : clampUnit((normalized - from.progress) / span);
  const travelAmount =
    linearAmount <= BHOTE_KOSHI_CAMERA_HOLD_RATIO
      ? 0
      : (linearAmount - BHOTE_KOSHI_CAMERA_HOLD_RATIO) /
        (1 - BHOTE_KOSHI_CAMERA_HOLD_RATIO);
  const amount = travelAmount * travelAmount * (3 - 2 * travelAmount);
  result.target = Cesium.Cartesian3.lerp(
    from.target,
    to.target,
    amount,
    result.target || new Cesium.Cartesian3(),
  );
  result.headingDeg = interpolateHeadingDegrees(
    from.headingDeg,
    to.headingDeg,
    amount,
  );
  result.pitchDeg = Cesium.Math.lerp(from.pitchDeg, to.pitchDeg, amount);
  result.rangeM = Cesium.Math.lerp(from.rangeM, to.rangeM, amount);
  result.fromId = from.id;
  result.toId = to.id;
  return result;
}

/** Wrap a compact card summary without clipping a word at the canvas edge. */
export function evidenceSummaryLines(value, maxChars = 52, maxLines = 2) {
  const words = String(value || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const limit = Math.max(8, Math.floor(Number(maxChars) || 52));
  const lineLimit = Math.max(1, Math.floor(Number(maxLines) || 2));
  const lines = [];
  let current = '';
  let consumed = 0;

  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= limit) {
      current = candidate;
      consumed = index + 1;
      continue;
    }
    if (current) {
      lines.push(current);
      if (lines.length >= lineLimit) break;
    }
    current = word;
    consumed = index + 1;
  }
  if (current && lines.length < lineLimit) lines.push(current);
  if (consumed < words.length && lines.length > 0) {
    let tail = lines.at(-1);
    while (tail.length > limit - 1) tail = tail.slice(0, -1);
    lines[lines.length - 1] = `${tail}…`;
  }
  return lines;
}

function closeFrame(frame) {
  try {
    frame?.close?.();
  } catch {
    // A browser may already have released a decoded frame during teardown.
  }
}

const EVIDENCE_CARD_LAYOUTS = Object.freeze({
  landscape: Object.freeze({
    kind: 'landscape',
    canvasWidth: 472,
    canvasHeight: 352,
    mediaHeight: 284,
    thumbnailWidth: 236,
    thumbnailHeight: 176,
    titleChars: 28,
  }),
  portrait: Object.freeze({
    kind: 'portrait',
    canvasWidth: 336,
    canvasHeight: 520,
    mediaHeight: 450,
    thumbnailWidth: 168,
    thumbnailHeight: 260,
    titleChars: 20,
  }),
  link: Object.freeze({
    kind: 'link',
    canvasWidth: 440,
    canvasHeight: 184,
    mediaHeight: 116,
    thumbnailWidth: 220,
    thumbnailHeight: 92,
    titleChars: 28,
  }),
});

/** Resolve one stable card footprint before the entry enters the shared host. */
export function evidenceCardLayout(observation) {
  const media = observation?.media || {};
  if (!media.videoPath && !media.posterPath && !media.posterUrl)
    return EVIDENCE_CARD_LAYOUTS.link;
  const width = Number(media.width);
  const height = Number(media.height);
  const orientation = String(media.orientation || '').toLowerCase();
  if (orientation === 'portrait' || (width > 0 && height > width * 1.12)) {
    return EVIDENCE_CARD_LAYOUTS.portrait;
  }
  return EVIDENCE_CARD_LAYOUTS.landscape;
}

/** Prefer official YouTube/Facebook players while retaining local clips as fallback media. */
export function usesProviderEmbeddedEvidence(observation) {
  const source = resolveEmbeddedMediaSource(observation?.media?.sourceUrl);
  if (!source) return false;
  return (
    source.provider === 'youtube' ||
    source.provider === 'facebook' ||
    !observation?.media?.videoPath
  );
}

function evidenceFrameCanvas(observation) {
  const canvas = globalThis.document?.createElement?.('canvas');
  if (!canvas || typeof canvas.getContext !== 'function') return null;
  const layout = evidenceCardLayout(observation);
  canvas.width = layout.canvasWidth;
  canvas.height = layout.canvasHeight;
  canvas._bhoteEvidenceLayout = layout;
  return canvas;
}

function drawCover(ctx, image, x, y, width, height) {
  const sourceWidth =
    Number(image?.videoWidth || image?.width || image?.naturalWidth) || width;
  const sourceHeight =
    Number(image?.videoHeight || image?.height || image?.naturalHeight) ||
    height;
  const scale = Math.max(width / sourceWidth, height / sourceHeight);
  const cropWidth = width / scale;
  const cropHeight = height / scale;
  const sourceX = Math.max(0, (sourceWidth - cropWidth) / 2);
  const sourceY = Math.max(0, (sourceHeight - cropHeight) / 2);
  ctx.drawImage(
    image,
    sourceX,
    sourceY,
    cropWidth,
    cropHeight,
    x,
    y,
    width,
    height,
  );
}

function drawContain(ctx, image, x, y, width, height) {
  const sourceWidth =
    Number(image?.videoWidth || image?.width || image?.naturalWidth) || width;
  const sourceHeight =
    Number(image?.videoHeight || image?.height || image?.naturalHeight) ||
    height;
  const scale = Math.min(width / sourceWidth, height / sourceHeight);
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  ctx.drawImage(
    image,
    x + (width - drawWidth) / 2,
    y + (height - drawHeight) / 2,
    drawWidth,
    drawHeight,
  );
}

function scaledOverlayFont(font, scale = 2) {
  return String(font).replace(
    /(\d+(?:\.\d+)?)px/,
    (_, size) => `${Number(size) * scale}px`,
  );
}

function drawEvidenceFallback(ctx, observation, width, height) {
  ctx.fillStyle = WORLD_OVERLAY_STYLE.background;
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = WORLD_OVERLAY_STYLE.leader;
  ctx.lineWidth = 2;
  for (let offset = -240; offset < width + 120; offset += 48) {
    ctx.beginPath();
    ctx.moveTo(offset, height);
    ctx.lineTo(offset + 240, 0);
    ctx.stroke();
  }
  ctx.fillStyle = WORLD_OVERLAY_STYLE.accent;
  ctx.font = scaledOverlayFont(WORLD_OVERLAY_STYLE.fontLabel, 1.4);
  ctx.fillText('NO PREVIEW', 20, 30);
}

function ellipsizeEvidenceText(value, limit) {
  const text = String(value || '').trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(1, limit - 3)).trimEnd()}...`;
}

/** Repaint one stable frame with a poster or the current source-video frame. */
export function updateEvidenceFrame(
  canvas,
  observation,
  media = null,
  options = {},
) {
  if (!canvas || typeof canvas.getContext !== 'function') return false;
  const ctx = canvas.getContext('2d');
  if (!ctx) return false;
  const layout = canvas._bhoteEvidenceLayout || evidenceCardLayout(observation);
  const accent = BHOTE_EVENT_ACCENT;
  const mediaHeight = layout.mediaHeight;
  const infoY = mediaHeight;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = WORLD_OVERLAY_STYLE.background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  let mediaRendered = false;
  if (media) {
    try {
      const fit = String(
        observation.media?.fit ||
          (layout.kind === 'portrait' ? 'contain' : 'cover'),
      );
      if (fit === 'contain')
        drawContain(ctx, media, 0, 0, canvas.width, mediaHeight);
      else drawCover(ctx, media, 0, 0, canvas.width, mediaHeight);
      mediaRendered = true;
    } catch {
      // The deterministic local fallback below remains the visual source.
    }
  }
  if (!mediaRendered)
    drawEvidenceFallback(ctx, observation, canvas.width, mediaHeight);

  if (options.videoActive && mediaRendered) {
    const mediaProgress = clampUnit(options.mediaProgress);
    ctx.fillStyle = WORLD_OVERLAY_STYLE.selectedBackground;
    ctx.fillRect(0, mediaHeight - 4, canvas.width, 4);
    ctx.fillStyle = accent;
    ctx.fillRect(0, mediaHeight - 4, canvas.width * mediaProgress, 4);
  }

  ctx.fillStyle = WORLD_OVERLAY_STYLE.selectedBackground;
  ctx.fillRect(0, infoY, canvas.width, canvas.height - infoY);
  ctx.fillStyle = accent;
  ctx.fillRect(0, 0, canvas.width, 4);
  ctx.fillStyle = WORLD_OVERLAY_STYLE.title;
  ctx.font = scaledOverlayFont(WORLD_OVERLAY_STYLE.fontTitle);
  ctx.fillText(
    ellipsizeEvidenceText(
      observation.shortTitle || observation.title,
      layout.titleChars,
    ).toUpperCase(),
    16,
    infoY + 27,
  );
  ctx.fillStyle = WORLD_OVERLAY_STYLE.detail;
  ctx.font = scaledOverlayFont(WORLD_OVERLAY_STYLE.fontDetail);
  const publisher = String(
    observation.media?.publisher || 'SOURCE LINK',
  ).toUpperCase();
  ctx.fillText(
    `${ellipsizeEvidenceText(publisher, 24)} / OPEN`,
    16,
    infoY + 53,
  );
  return true;
}

/** Compose source imagery and caveats into one stable renderer-owned frame. */
export function createEvidenceFrame(observation, poster = null, options = {}) {
  const canvas = evidenceFrameCanvas(observation);
  if (!canvas) return null;
  updateEvidenceFrame(canvas, observation, poster, options);
  return canvas;
}

function eventAsset(path) {
  return `${EVENT_ASSET_ROOT}${String(path || '').replace(/^\/+/, '')}`;
}

function cancellationError() {
  const error = new Error('Bhote Koshi event enable cancelled');
  error.name = 'AbortError';
  return error;
}

function throwIfEnableCancelled(signal, enabled) {
  if (signal?.aborted || !enabled) throw cancellationError();
}

function openExternal(url) {
  const target = window.open(url, '_blank', 'noopener,noreferrer');
  if (target) target.opener = null;
}

function focusView(viewer, viewpoint) {
  announceNavigationAuthority('bhote-koshi-event-focus');
  const target = Cesium.Cartesian3.fromDegrees(
    viewpoint.lon,
    viewpoint.lat,
    viewpoint.targetElevationM,
  );
  const offset = new Cesium.HeadingPitchRange(
    Cesium.Math.toRadians(viewpoint.headingDeg),
    Cesium.Math.toRadians(viewpoint.pitchDeg),
    viewpoint.rangeM,
  );
  viewer.camera.cancelFlight?.();
  viewer.camera.flyToBoundingSphere(new Cesium.BoundingSphere(target, 80), {
    offset,
    duration: 2.2,
    complete: () => {
      viewer.camera.lookAt(target, offset);
      viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    },
  });
}

function setElementProperty(element, property, value) {
  if (!element || element[property] === value) return false;
  element[property] = value;
  return true;
}

function setElementAttribute(element, attribute, value) {
  if (!element || element.getAttribute?.(attribute) === value) return false;
  element.setAttribute(attribute, value);
  return true;
}

function collectPanelReferences(panel) {
  return Object.freeze({
    imagerySection: panel.querySelector('[data-role="imagery-comparison"]'),
    observedStatus: panel.querySelector('.bhote-event-status.observed'),
    beforeDate: panel.querySelector('[data-role="before-date"]'),
    afterDate: panel.querySelector('[data-role="after-date"]'),
    time: panel.querySelector('[data-role="time"]'),
    caveat: panel.querySelector('[data-role="caveat"]'),
    imageryCloudNote: panel.querySelector('[data-role="imagery-cloud-note"]'),
    reportList: panel.querySelector('.bhote-event-report-list'),
    playButton: panel.querySelector('[data-action="play"]'),
    playSceneButton: panel.querySelector('[data-action="play-scene"]'),
    cinematicButton: panel.querySelector('[data-action="cinematic"]'),
    storyReplayButton: panel.querySelector('[data-action="story-replay"]'),
    corridorButton: panel.querySelector('[data-action="corridor"]'),
    previousButton: panel.querySelector('[data-action="previous-beat"]'),
    nextButton: panel.querySelector('[data-action="next-beat"]'),
    openSourceButton: panel.querySelector('[data-action="open-source"]'),
    progressInput: panel.querySelector('[data-role="progress"]'),
    splitInput: panel.querySelector('[data-role="split"]'),
    splitReadout: panel.querySelector('[data-role="split-readout"]'),
    timelineLabel: panel.querySelector('[data-role="timeline-label"]'),
    beatIndex: panel.querySelector('[data-role="beat-index"]'),
    beatTitle: panel.querySelector('[data-role="beat-title"]'),
    beatMeta: panel.querySelector('[data-role="beat-meta"]'),
  });
}

function createPanel(event, handlers) {
  const panel = document.createElement('aside');
  panel.id = 'bhote-koshi-event-panel';
  panel.setAttribute('aria-label', 'Bhote Koshi flood reconstruction controls');
  panel.innerHTML = `
    <div class="bhote-event-header">
      <div>
        <div class="bhote-event-kicker">EVENT RECONSTRUCTION · 26 AUG 2026</div>
        <div class="bhote-event-title">BHOTE KOSHI OUTBURST FLOOD</div>
      </div>
      <button class="bhote-event-icon-btn" type="button" data-action="close" title="Close event layer" aria-label="Close event layer">×</button>
    </div>
    <div class="bhote-event-status-row">
      <span class="bhote-event-status observed">OBSERVED IMAGERY</span>
      <span class="bhote-event-status reconstructed">SCHEMATIC CORRIDOR</span>
    </div>
    <section class="bhote-event-section" data-role="imagery-comparison">
      <div class="bhote-event-section-head">
        <span>2021 HISTORICAL REFERENCE / 2026 POST-EVENT</span>
        <span data-role="split-readout">50 / 50</span>
      </div>
      <input class="bhote-event-range" data-role="split" type="range" min="0" max="100" value="50" aria-label="Historical reference and post-event image split" />
      <div class="bhote-event-dates">
        <span data-role="before-date"></span>
        <span data-role="after-date"></span>
      </div>
    </section>
    <section class="bhote-event-section">
      <div class="bhote-event-section-head">
        <span data-role="timeline-label">RECONSTRUCTION CLOCK</span>
        <span data-role="time"></span>
      </div>
      <input class="bhote-event-range flood" data-role="progress" type="range" min="0" max="1000" value="0" aria-label="Schematic downstream progression" />
      <div class="bhote-event-story-nav" aria-label="Story beat navigation">
        <button type="button" data-action="previous-beat" title="Previous story beat" aria-label="Previous story beat">‹</button>
        <div class="bhote-event-story-current">
          <span data-role="beat-index">01 / 06</span>
          <strong data-role="beat-title" aria-live="polite">CAUSE</strong>
          <small data-role="beat-meta">CAPTURE TIME UNVERIFIED</small>
        </div>
        <button type="button" data-action="next-beat" title="Next story beat" aria-label="Next story beat">›</button>
      </div>
      <div class="bhote-event-actions">
        <button type="button" data-action="play">▶ PLAY</button>
        <button type="button" data-action="play-scene" hidden title="Play the next shot and continue through this scene">▶ PLAY SCENE</button>
        <button type="button" data-action="cinematic" aria-pressed="false">◉ CINEMATIC</button>
        <button type="button" data-action="story-replay">↺ FULL STORY</button>
        <button type="button" data-action="open-source">↗ OPEN ORIGINAL</button>
        <button type="button" data-action="corridor">⌖ LOWER GORGE</button>
      </div>
    </section>
    <details class="bhote-event-evidence">
      <summary>FIELD REPORTS · ${event.fieldReports.length}</summary>
      <div class="bhote-event-report-list"></div>
    </details>
    <div class="bhote-event-credit">
      <span>GEOLOCATIONS · GEO GEORGE SHADRACH</span>
      <button type="button" data-action="geolocation-map">↗ OPEN PUBLIC MAP</button>
    </div>
    <p class="bhote-event-caveat"><span data-role="caveat"></span><span data-role="imagery-cloud-note"> Clouds are preserved from the source imagery.</span></p>
  `;

  const refs = collectPanelReferences(panel);
  refs.beforeDate.textContent = event.imagery.before.label;
  refs.afterDate.textContent = event.imagery.after.label;
  refs.time.textContent = `~0:00 / ${elapsedLabel(1, event.reconstruction.elapsedSeconds)}`;
  refs.caveat.textContent = event.reconstruction.caveat;

  for (const report of event.fieldReports) {
    const button = document.createElement('button');
    const label = document.createElement('span');
    const status = document.createElement('small');
    button.type = 'button';
    button.className = 'bhote-event-report';
    label.textContent = report.label;
    status.textContent = report.status;
    button.append(label, status);
    button.addEventListener('click', () => openExternal(report.url));
    refs.reportList.appendChild(button);
  }

  panel
    .querySelector('[data-action="close"]')
    .addEventListener('click', handlers.close);
  panel
    .querySelector('[data-action="play"]')
    .addEventListener('click', handlers.play);
  panel
    .querySelector('[data-action="play-scene"]')
    .addEventListener('click', handlers.playScene);
  panel
    .querySelector('[data-action="cinematic"]')
    .addEventListener('click', handlers.toggleCinematic);
  panel
    .querySelector('[data-action="previous-beat"]')
    .addEventListener('click', handlers.previousBeat);
  panel
    .querySelector('[data-action="next-beat"]')
    .addEventListener('click', handlers.nextBeat);
  panel
    .querySelector('[data-action="story-replay"]')
    .addEventListener('click', handlers.replayCinematic);
  panel
    .querySelector('[data-action="open-source"]')
    .addEventListener('click', handlers.openActiveSource);
  panel
    .querySelector('[data-action="geolocation-map"]')
    .addEventListener('click', handlers.openGeolocationMap);
  panel
    .querySelector('[data-action="corridor"]')
    .addEventListener('click', handlers.focusCorridor);
  panel
    .querySelector('[data-role="split"]')
    .addEventListener('input', (inputEvent) => {
      handlers.setSplit(Number(inputEvent.target.value) / 100);
    });
  panel
    .querySelector('[data-role="progress"]')
    .addEventListener('input', (inputEvent) => {
      handlers.previewProgress(Number(inputEvent.target.value) / 1000);
    });
  panel
    .querySelector('[data-role="progress"]')
    .addEventListener('change', (inputEvent) => {
      handlers.commitProgress(Number(inputEvent.target.value) / 1000, {
        final: true,
      });
    });
  const rightRail = document.getElementById?.('right-context-rail');
  rightRail?.classList.add('bhote-event-active');
  (rightRail || document.body).appendChild(panel);
  return { panel, refs };
}

export function createBhoteKoshiEventLayer({
  overlayHost = DEFAULT_OVERLAY_HOST,
  renderHost = DEFAULT_RENDER_HOST,
  eventLoader = DEFAULT_EVENT_LOADER,
  imageryProviderFactory = DEFAULT_IMAGERY_PROVIDER_FACTORY,
  terrainSampler = DEFAULT_TERRAIN_SAMPLER,
  mediaLoader = DEFAULT_MEDIA_LOADER,
  evidenceFrameFactory = createEvidenceFrame,
  evidenceFrameUpdater = updateEvidenceFrame,
  videoFactory = DEFAULT_VIDEO_FACTORY,
  embeddedMediaFactory = createBhoteKoshiEmbeddedMedia,
} = {}) {
  let _viewer = null;
  let _dataManager = null;
  let _mapStackController = null;
  let _event = null;
  let _enabled = false;
  let _panel = null;
  let _panelRefs = null;
  let _splitControl = null;
  let _beforeLayer = null;
  let _afterLayer = null;
  let _imageryLayerCollection = null;
  let _floodDataSource = null;
  let _floodSurfaceMode = null;
  let _floodHalo = null;
  let _floodCore = null;
  let _surgePoint = null;
  let _terrainPositions = [];
  let _sourceShotPaths = new Map();
  let _scenePathPositionCache = new Map();
  let _scenePathPositions = [];
  let _scenePathBeatId = null;
  let _scenePathStartProgress = 0;
  let _scenePathRevealProgress = 0;
  let _scenePathAnimationFrame = null;
  let _scenePathDeadlineTimer = null;
  let _scenePathHoldActive = false;
  let _corridorPositionCache = { visibleCount: -1, positions: [] };
  let _evidenceTimeline = [];
  let _evidenceAnchors = [];
  let _evidenceFrameSlots = [];
  let _evidenceVideo = null;
  let _evidenceVideoIndex = -1;
  let _evidenceVideoReady = false;
  let _evidenceVideoGeneration = 0;
  let _evidenceVideoFrameHandle = null;
  let _embeddedMedia = null;
  let _embeddedEvidenceIndex = -1;
  let _sceneMediaPlaybackBeatId = null;
  let _sceneMediaPlaybackCompletedBeatId = null;
  let _sceneMediaPlaybackTimer = null;
  let _sceneMediaOwner = null;
  let _removeSceneMediaAbort = null;
  let _witnessEmbedActive = false;
  let _sceneRevealAnimationFrame = null;
  let _sceneRevealHoldActive = false;
  let _sceneRevealProgress = 1;
  let _cinematicKeyframes = [];
  let _cinematicActive = false;
  let _cinematicReplayArmed = false;
  let _cinematicPose = { target: new Cesium.Cartesian3() };
  let _cinematicOffset = new Cesium.HeadingPitchRange();
  let _lastCinematicProgress = null;
  let _cameraInputTarget = null;
  let _evidenceClickTarget = null;
  let _mediaAbortController = null;
  let _mediaGeneration = 0;
  let _progress = 0;
  let _split = 0.5;
  let _playing = false;
  let _playStartedAt = 0;
  let _playStartProgress = 0;
  let _animationFrame = null;
  let _comparisonLease = null;
  let _introTimer = null;
  let _introGeneration = 0;
  let _lastSurgePosition = null;
  let _lastSurgeVisible = null;
  let _presentation = 'standalone';
  let _sceneBeatId = null;
  let _sceneBeatReveal = 0.36;
  let _sceneContext = null;
  let _sceneSurface = BHOTE_KOSHI_SCENE_PANEL_ONLY;
  let _sceneControls = {};
  let _sceneController = null;
  let _sceneClockUnsubscribe = null;
  let _sceneScrubProgress = null;
  let _sceneSeekGeneration = 0;
  let _sceneSeekFrame = null;
  let _sceneActionPending = false;
  let _comparisonSurfaceGeneration = 0;

  function wantsTerrainComparison() {
    return (
      _presentation === BHOTE_KOSHI_SCENE_PRESENTATION &&
      _sceneControls.imageryComparison === true
    );
  }

  function usesPhotorealFloodSurface() {
    return (
      _mapStackController?.getActiveId?.() === 'photoreal' &&
      !wantsTerrainComparison()
    );
  }

  async function syncTerrainComparison() {
    const generation = ++_comparisonSurfaceGeneration;
    if (!_mapStackController?.setTerrainComparison) return;
    if (!_enabled || !wantsTerrainComparison()) {
      _mapStackController.clearTerrainComparison();
      return;
    }
    await _mapStackController.setTerrainComparison(_event.imagery.rectangle);
    if (!_enabled || generation !== _comparisonSurfaceGeneration) return;
    syncFloodSurfaceMode();
    updateProgress(_progress);
    renderHost.request('bhote-koshi-comparison-ready');
  }

  function attachDataManager(dataManager) {
    _dataManager = dataManager;
  }

  function attachMapStackController(controller) {
    _mapStackController = controller;
  }

  function attachSceneController(controller) {
    _sceneClockUnsubscribe?.();
    _sceneClockUnsubscribe = null;
    _sceneController = controller;
    if (typeof controller?.subscribeSceneClock === 'function') {
      _sceneClockUnsubscribe = controller.subscribeSceneClock((snapshot) => {
        if (
          _presentation !== BHOTE_KOSHI_SCENE_PRESENTATION ||
          !_sceneContext?.sceneId ||
          snapshot?.sceneId !== _sceneContext.sceneId
        )
          return;
        const playbackStopped =
          _sceneContext.running === true && snapshot.running === false;
        _sceneContext = { ..._sceneContext, ...snapshot };
        if (playbackStopped || snapshot.stopped === true) {
          _sceneMediaPlaybackCompletedBeatId = _sceneBeatId;
          stopSceneEvidenceReveal();
          stopSceneMediaPlayback();
          releaseEvidenceVideo({ restorePoster: false });
        }
        syncPanel();
      });
    }
    syncPanel();
  }

  async function loadEvent() {
    if (_event) return _event;
    _event = await eventLoader();
    return _event;
  }

  async function createImagery(event) {
    const rectangle = Cesium.Rectangle.fromDegrees(
      event.imagery.rectangle.west,
      event.imagery.rectangle.south,
      event.imagery.rectangle.east,
      event.imagery.rectangle.north,
    );
    const [beforeProvider, afterProvider] = await Promise.all([
      imageryProviderFactory(eventAsset(event.imagery.before.path), {
        rectangle,
        credit: 'Vantor WorldView Open Data · CC BY-NC 4.0',
      }),
      imageryProviderFactory(eventAsset(event.imagery.after.path), {
        rectangle,
        credit: 'Vantor WorldView Open Data · CC BY-NC 4.0',
      }),
    ]);
    if (!_enabled) return;
    _imageryLayerCollection = _viewer.imageryLayers;
    _beforeLayer = _imageryLayerCollection.addImageryProvider(beforeProvider);
    _afterLayer = _imageryLayerCollection.addImageryProvider(afterProvider);
    _beforeLayer.splitDirection = Cesium.SplitDirection.LEFT;
    _afterLayer.splitDirection = Cesium.SplitDirection.RIGHT;
    _beforeLayer.alpha = 0.96;
    _afterLayer.alpha = 0.96;
    setSplit(_split);
  }

  async function resolveEvidenceAnchors(event, signal) {
    const observations = Array.isArray(event.evidenceSpine)
      ? event.evidenceSpine
      : [];
    let sampled = null;
    try {
      sampled = await terrainSampler(_viewer, observations, { signal });
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      console.warn(
        '[Data:BhoteKoshi] Evidence terrain sampling fell back:',
        error,
      );
    }
    throwIfEnableCancelled(signal, _enabled);
    return observations.map((observation, index) => {
      const sampledHeight = Number(sampled?.[index]?.height);
      const fallbackHeight = Number(observation.fallbackElevationM) || 0;
      return Cesium.Cartesian3.fromDegrees(
        observation.lon,
        observation.lat,
        (Number.isFinite(sampledHeight) ? sampledHeight : fallbackHeight) + 18,
      );
    });
  }

  function evidencePositionGetter(index, breadcrumb = false) {
    return () => {
      if (!_enabled) return null;
      if (_witnessEmbedActive && !breadcrumb) return null;
      if (_presentation === BHOTE_KOSHI_SCENE_PRESENTATION) {
        if (_sceneSurface !== BHOTE_KOSHI_SCENE_EVIDENCE_BEAT || breadcrumb)
          return null;
        if (_evidenceTimeline[index]?.observation?.id !== _sceneBeatId)
          return null;
        if (
          sceneEvidenceDefersUntilCameraSettles() &&
          !sceneEvidenceCameraSettled()
        )
          return null;
        if (index === _embeddedEvidenceIndex) return null;
        if (
          _evidenceTimeline[index]?.observation?.id ===
          _sceneMediaPlaybackCompletedBeatId
        )
          return null;
        return _evidenceAnchors[index] || null;
      }
      const activeIndex = activeEvidenceIndex(_progress, _evidenceTimeline);
      if (breadcrumb ? index >= activeIndex : index !== activeIndex)
        return null;
      if (!breadcrumb && index === _embeddedEvidenceIndex) return null;
      return _evidenceAnchors[index] || null;
    };
  }

  function showWitnessEmbed() {
    const witness = _event?.witnessAnchors?.[0];
    if (!witness?.sourceUrl) return false;
    const anchor = Cesium.Cartesian3.fromDegrees(
      witness.lon,
      witness.lat,
      (Number(witness.elevationM) || 0) + 18,
    );
    const shown =
      _embeddedMedia?.show?.({
        observation: {
          title: witness.title,
          shortTitle: 'Rasuwagadhi witness',
          media: { sourceUrl: witness.sourceUrl },
        },
        anchor,
        sourceUrl: witness.sourceUrl,
        autoplay: false,
      }) === true;
    if (shown) _embeddedEvidenceIndex = -1;
    return shown;
  }

  function syncEmbeddedEvidence(index) {
    if (_witnessEmbedActive) {
      const shown = showWitnessEmbed();
      if (!shown) _embeddedMedia?.hide?.();
      return shown;
    }
    const observation = _evidenceTimeline[index]?.observation;
    if (observation?.id === _sceneMediaPlaybackCompletedBeatId) {
      _embeddedEvidenceIndex = index;
      _embeddedMedia?.hide?.();
      return true;
    }
    if (!usesProviderEmbeddedEvidence(observation)) {
      _embeddedEvidenceIndex = -1;
      _embeddedMedia?.hide?.();
      return false;
    }
    const shown =
      _embeddedMedia?.show?.({
        observation,
        anchor: _evidenceAnchors[index],
        autoplay: sceneEvidenceMediaAutoplays() || _playing,
      }) === true;
    _embeddedEvidenceIndex = shown ? index : -1;
    if (shown && sceneEvidenceMediaAutoplays()) startSceneMediaPlayback(index);
    return shown;
  }

  function redrawEvidenceSlot(index, media = null, options = {}) {
    const slot = _evidenceFrameSlots[index];
    const observation = _evidenceTimeline[index]?.observation;
    if (!slot || !observation) return false;
    const rendered = evidenceFrameUpdater(
      slot.frame,
      observation,
      media || slot.poster,
      options,
    );
    if (!rendered) return false;
    slot.stamp += 1;
    return true;
  }

  // Playback authority is supplied by the Director, never restored from params.
  function setSceneMediaPlayback(owner = null) {
    _removeSceneMediaAbort?.();
    _removeSceneMediaAbort = null;
    _sceneMediaOwner = owner;
    stopSceneMediaPlayback();
    releaseEvidenceVideo({ restorePoster: false });
    _embeddedMedia?.hide?.({ immediate: true });
    _embeddedEvidenceIndex = -1;
    _sceneMediaPlaybackCompletedBeatId = null;
    if (owner?.token?.signal) {
      const signal = owner.token.signal;
      const cancel = () => setSceneMediaPlayback();
      if (signal.aborted) cancel();
      else {
        signal.addEventListener('abort', cancel, { once: true });
        _removeSceneMediaAbort = () =>
          signal.removeEventListener('abort', cancel);
      }
    }
  }

  function sceneMediaPlaybackActive() {
    return (
      _sceneMediaOwner != null &&
      !_sceneMediaOwner.token.cancelled &&
      !_sceneMediaOwner.token.signal?.aborted &&
      _sceneMediaOwner.sceneId === _sceneContext?.sceneId &&
      _sceneMediaOwner.shotId === _sceneContext?.shotId
    );
  }

  function sceneEvidenceMediaAutoplays() {
    return (
      sceneMediaPlaybackActive() &&
      _presentation === BHOTE_KOSHI_SCENE_PRESENTATION &&
      _sceneSurface === BHOTE_KOSHI_SCENE_EVIDENCE_BEAT &&
      _sceneControls.evidenceMediaAutoplay === true &&
      !_sceneControls.timelineSeek
    );
  }

  function sceneTimelineSeek() {
    return _presentation === BHOTE_KOSHI_SCENE_PRESENTATION &&
      _sceneControls.timelineSeek &&
      typeof _sceneControls.timelineSeek === 'object'
      ? _sceneControls.timelineSeek
      : null;
  }

  function sceneTimelineMediaVisible() {
    const seek = sceneTimelineSeek();
    if (!seek || _sceneControls.evidenceMediaAutoplay !== true) return true;
    if (!sceneEvidenceCameraSettled()) return false;
    const holdElapsedSec = Math.max(0, Number(seek.holdElapsedSec) || 0);
    const mediaDurationSec = Math.max(
      SCENE_MEDIA_MIN_PLAYBACK_SECONDS,
      Number(_sceneControls.mediaPlaybackHoldSec) || 0,
    );
    return holdElapsedSec < mediaDurationSec;
  }

  function stopSceneMediaPlayback({ pauseMedia = true } = {}) {
    const hadPlayback =
      _sceneMediaPlaybackTimer != null || _sceneMediaPlaybackBeatId != null;
    if (_sceneMediaPlaybackTimer != null) {
      globalThis.window?.clearTimeout?.(_sceneMediaPlaybackTimer);
      _sceneMediaPlaybackTimer = null;
    }
    _sceneMediaPlaybackBeatId = null;
    if (pauseMedia) _embeddedMedia?.pause?.();
    if (hadPlayback) renderHost.request('bhote-koshi-scene-media-hold');
  }

  function completeSceneMediaPlayback() {
    const beatId = _sceneMediaPlaybackBeatId;
    if (!beatId) return;
    _sceneMediaPlaybackCompletedBeatId = beatId;
    _embeddedMedia?.hide?.();
    releaseEvidenceVideo({ restorePoster: false });
    const exitDurationSec = Math.max(
      SCENE_MEDIA_EXIT_SECONDS,
      Number(_sceneControls.mediaExitDurationSec) || 0,
    );
    _sceneMediaPlaybackTimer =
      globalThis.window?.setTimeout?.(() => {
        if (_sceneMediaPlaybackBeatId !== beatId) return;
        _sceneMediaPlaybackTimer = null;
        _sceneMediaPlaybackBeatId = null;
        renderHost.request('bhote-koshi-scene-media-exit');
      }, exitDurationSec * 1000) ?? null;
  }

  function startSceneMediaPlayback(index) {
    if (!sceneEvidenceMediaAutoplays()) return;
    const beatId = _evidenceTimeline[index]?.observation?.id;
    if (
      !beatId ||
      beatId === _sceneMediaPlaybackCompletedBeatId ||
      beatId === _sceneMediaPlaybackBeatId
    )
      return;
    stopSceneMediaPlayback({ pauseMedia: false });
    _sceneMediaPlaybackBeatId = beatId;
    _embeddedMedia?.play?.();
    if (sceneUsesTrimmedMedia(beatId) && _embeddedEvidenceIndex === index) {
      const deadline = Date.now() + 18000;
      const check = () => {
        if (
          !_enabled ||
          _sceneBeatId !== beatId ||
          _sceneMediaPlaybackBeatId !== beatId
        )
          return;
        const state = _embeddedMedia?.getPlaybackState?.();
        if (
          [
            'completed',
            'blocked',
            'unavailable',
            'timeout',
            'cancelled',
          ].includes(state?.phase) ||
          Date.now() >= deadline
        ) {
          _sceneMediaPlaybackTimer = null;
          completeSceneMediaPlayback();
          return;
        }
        _sceneMediaPlaybackTimer =
          globalThis.window?.setTimeout?.(check, 100) ?? null;
      };
      check();
      return;
    }
    const exitDurationSec = Math.max(
      SCENE_MEDIA_EXIT_SECONDS,
      Number(_sceneControls.mediaExitDurationSec) || 0,
    );
    const postMediaPathDurationSec = scenePathMovesDuringCamera()
      ? 0
      : sceneUsesSourcePath()
        ? Number(_sceneControls.evidencePathDurationSec) || 0
        : sceneEvidenceSequenceAnimates() &&
            _sceneControls.evidencePath !== 'none'
          ? Number(_sceneControls.evidenceSequenceDurationSec) || 0
          : 0;
    const availableMediaSec =
      (Number(_sceneContext?.holdSec) || 0) -
      exitDurationSec -
      postMediaPathDurationSec;
    const durationSec = Math.max(
      SCENE_MEDIA_MIN_PLAYBACK_SECONDS,
      Number(_sceneControls.mediaPlaybackHoldSec) || 0,
      availableMediaSec,
    );
    _sceneMediaPlaybackTimer =
      globalThis.window?.setTimeout?.(() => {
        if (
          !_enabled ||
          _sceneBeatId !== beatId ||
          _sceneMediaPlaybackBeatId !== beatId
        )
          return;
        _sceneMediaPlaybackTimer = null;
        completeSceneMediaPlayback();
      }, durationSec * 1000) ?? null;
  }

  function sceneUsesTrimmedMedia(beatId) {
    const media = _evidenceTimeline.find(
      (item) => item.observation?.id === beatId,
    )?.observation?.media;
    return (
      Number(media?.embedEndAtSec) > Number(media?.embedStartAtSec || 0) &&
      resolveEmbeddedMediaSource(media?.sourceUrl)?.provider === 'youtube'
    );
  }

  function getSceneShotMediaHold(beatId) {
    if (
      !_enabled ||
      _sceneBeatId !== beatId ||
      !sceneEvidenceMediaAutoplays() ||
      !sceneUsesTrimmedMedia(beatId)
    )
      return null;
    const media = _evidenceTimeline.find(
      (item) => item.observation?.id === beatId,
    )?.observation?.media;
    // Deliberate provider suppression is a source card, not a player waiting
    // to load. Returning no gate selects the Director's authored card dwell.
    // A local clip still owns playback; a starting supported provider still waits.
    if (_embeddedMedia?.supportsPlayback === false && !media?.videoPath)
      return null;
    return {
      pending:
        _sceneMediaPlaybackCompletedBeatId !== beatId ||
        _sceneMediaPlaybackBeatId === beatId,
      maxWaitMs: 20000,
    };
  }

  function sceneMediaPlaybackBlocksPath() {
    return (
      _sceneMediaPlaybackBeatId === _sceneBeatId &&
      _sceneControls.evidencePathDuringMedia !== true
    );
  }

  function sceneUsesSourcePath() {
    return (
      _presentation === BHOTE_KOSHI_SCENE_PRESENTATION &&
      _sceneControls.evidencePath === 'source'
    );
  }

  function sceneUsesPathHistory() {
    return (
      _presentation === BHOTE_KOSHI_SCENE_PRESENTATION &&
      _sceneControls.evidencePath === 'history'
    );
  }

  function sceneUsesCumulativePath() {
    return (
      (sceneUsesSourcePath() || sceneUsesPathHistory()) &&
      _sceneControls.evidencePathHistory === true
    );
  }

  function scenePathMovesDuringCamera() {
    return (
      _presentation === BHOTE_KOSHI_SCENE_PRESENTATION &&
      _sceneSurface === BHOTE_KOSHI_SCENE_EVIDENCE_BEAT &&
      _sceneControls.evidencePathDuringCamera === true
    );
  }

  function sceneKeepsFloodVisible() {
    return (
      _presentation === BHOTE_KOSHI_SCENE_PRESENTATION &&
      _sceneControls.evidencePathPersistent === true
    );
  }

  function scenePathCanPrepare() {
    return (
      !sceneEvidenceDefersUntilCameraSettles() ||
      sceneEvidenceCameraSettled() ||
      scenePathMovesDuringCamera() ||
      // Media-led shots defer the new segment, not the completed upstream
      // prefix. Reconstruct that prefix for travel, direct loads and replay.
      (sceneKeepsFloodVisible() && sceneUsesCumulativePath()) ||
      sceneUsesPathHistory()
    );
  }

  function sourcePathPositions(beatId) {
    const cacheKey = `${beatId}:${_sceneControls.evidencePathElevation === 'source' ? 'source' : 'surface'}`;
    const cached = _scenePathPositionCache.get(cacheKey);
    if (cached) return cached;
    const positions = (_sourceShotPaths.get(beatId) || []).map((point) => {
      const position = Cesium.Cartographic.fromDegrees(point.lon, point.lat);
      let height;
      // Some schematic reaches have a source elevation profile. Do not replace
      // it with coarse mesh heights on entry/exit from the comparison surface:
      // a single high sample can make the front dive backward in screen space.
      if (_sceneControls.evidencePathElevation !== 'source') {
        // Sample once while preparing the shot, never from an animation frame.
        try {
          height = _viewer?.scene?.sampleHeight?.(
            position,
            [_floodCore, _floodHalo, _surgePoint].filter(Boolean),
          );
        } catch {}
        if (!Number.isFinite(height))
          height = _viewer?.scene?.globe?.getHeight?.(position);
      }
      if (!Number.isFinite(height)) height = point.fallbackElevationM;
      return Cesium.Cartesian3.fromDegrees(point.lon, point.lat, height + 8);
    });
    _scenePathPositionCache.set(cacheKey, positions);
    return positions;
  }

  function appendPathSegment(target, segment, { replaceJoin = false } = {}) {
    if (!segment.length) return;
    if (!target.length) {
      target.push(...segment);
      return;
    }
    if (replaceJoin) target[target.length - 1] = segment[0];
    target.push(...segment.slice(1));
  }

  function prepareScenePath() {
    if (
      (!sceneUsesSourcePath() && !sceneUsesPathHistory()) ||
      !scenePathCanPrepare()
    ) {
      _scenePathBeatId = null;
      _scenePathPositions = [];
      _scenePathStartProgress = 0;
      return;
    }
    const targetBeatId = sceneUsesPathHistory()
      ? _sceneControls.evidencePathHistoryBeatId
      : _sceneBeatId;
    const pathKey = `${_sceneBeatId}:${targetBeatId}:${sceneUsesCumulativePath() ? 'history' : 'segment'}:${_sceneControls.evidencePathElevation || 'surface'}`;
    if (_scenePathBeatId === pathKey) return;
    _scenePathBeatId = pathKey;

    if (!sceneUsesCumulativePath()) {
      _scenePathPositions = [...sourcePathPositions(targetBeatId)];
      _scenePathStartProgress = 0;
      return;
    }

    // Reconstruct the supported prefix from source data on every direct load.
    // Playback history is never trusted: backwards navigation therefore trims
    // downstream geometry, while a direct downstream load still has its full
    // upstream context.
    const targetIndex = SOURCE_PATH_BEAT_IDS.indexOf(targetBeatId);
    const upperValleyPath = targetIndex >= 0 && targetIndex < 2;
    const pathBeatIds = upperValleyPath
      ? SOURCE_PATH_BEAT_IDS.slice(0, 2)
      : SOURCE_PATH_BEAT_IDS.slice(2);
    const cumulative = upperValleyPath ? [] : [..._terrainPositions];
    let activeStartIndex = Math.max(0, cumulative.length - 1);
    for (const beatId of pathBeatIds) {
      if (beatId === targetBeatId && !sceneUsesPathHistory()) {
        activeStartIndex = Math.max(0, cumulative.length - 1);
      }
      appendPathSegment(cumulative, sourcePathPositions(beatId), {
        replaceJoin: !upperValleyPath && beatId === SOURCE_PATH_BEAT_IDS[2],
      });
      if (beatId === targetBeatId) break;
    }
    _scenePathPositions = cumulative;
    _scenePathStartProgress = sceneUsesPathHistory()
      ? 1
      : activeStartIndex / Math.max(1, cumulative.length - 1);
  }

  function activeFloodPositions() {
    return sceneUsesSourcePath() || sceneUsesPathHistory()
      ? _scenePathPositions
      : _terrainPositions;
  }

  function sceneEvidenceDefersUntilCameraSettles() {
    return (
      _presentation === BHOTE_KOSHI_SCENE_PRESENTATION &&
      _sceneSurface === BHOTE_KOSHI_SCENE_EVIDENCE_BEAT &&
      _sceneControls.deferEvidenceUntilCameraSettled === true
    );
  }

  function sceneEvidenceSequenceAnimates() {
    return (
      _presentation === BHOTE_KOSHI_SCENE_PRESENTATION &&
      _sceneSurface === BHOTE_KOSHI_SCENE_EVIDENCE_BEAT &&
      _sceneControls.evidenceSequence === true
    );
  }

  function sceneEvidenceCameraSettled() {
    return (
      !sceneEvidenceDefersUntilCameraSettles() ||
      _sceneControls.cameraSettled === true
    );
  }

  function sceneEvidencePresentation(index) {
    const beat = _evidenceTimeline[index];
    if (
      beat &&
      _presentation === BHOTE_KOSHI_SCENE_PRESENTATION &&
      _sceneControls.evidenceHoldCard === true
    ) {
      const span =
        Math.min(1, beat.deactivationProgress) - beat.activationProgress;
      const reveal = Math.min(1, _sceneRevealProgress * 6);
      return evidenceBeatPresentation(
        beat.activationProgress + span * _sceneBeatReveal * reveal,
        beat,
      );
    }
    if (
      !beat ||
      sceneEvidenceSequenceAnimates() ||
      !sceneEvidenceDefersUntilCameraSettles()
    ) {
      return evidenceBeatPresentation(_progress, beat);
    }
    const start = clampUnit(beat.activationProgress);
    const end = Math.max(start, Math.min(1, beat.deactivationProgress));
    const revealProgress =
      start +
      (end - start) * _sceneBeatReveal * clampUnit(_sceneRevealProgress);
    return evidenceBeatPresentation(revealProgress, beat);
  }

  function stopSceneEvidenceReveal() {
    if (_sceneRevealAnimationFrame != null)
      cancelAnimationFrame(_sceneRevealAnimationFrame);
    _sceneRevealAnimationFrame = null;
    if (_sceneRevealHoldActive) renderHost.release(SCENE_REVEAL_RENDER_HOLD);
    _sceneRevealHoldActive = false;
  }

  function stopScenePathReveal() {
    if (_scenePathAnimationFrame != null)
      cancelAnimationFrame(_scenePathAnimationFrame);
    _scenePathAnimationFrame = null;
    if (_scenePathDeadlineTimer != null)
      globalThis.window?.clearTimeout?.(_scenePathDeadlineTimer);
    _scenePathDeadlineTimer = null;
    if (_scenePathHoldActive) renderHost.release(SCENE_PATH_RENDER_HOLD);
    _scenePathHoldActive = false;
  }

  function finishScenePathReveal(targetProgress, requestReason) {
    if (_scenePathAnimationFrame != null)
      cancelAnimationFrame(_scenePathAnimationFrame);
    _scenePathAnimationFrame = null;
    if (_scenePathDeadlineTimer != null)
      globalThis.window?.clearTimeout?.(_scenePathDeadlineTimer);
    _scenePathDeadlineTimer = null;
    _scenePathRevealProgress = targetProgress;
    updateFloodTrace(_scenePathRevealProgress);
    updateSurgeFront(_scenePathRevealProgress);
    renderHost.request(requestReason);
    if (_scenePathHoldActive) renderHost.release(SCENE_PATH_RENDER_HOLD);
    _scenePathHoldActive = false;
  }

  function scenePathProgressWindow() {
    if (sceneUsesPathHistory()) return { start: 1, target: 1 };
    if (sceneUsesSourcePath())
      return { start: _scenePathStartProgress, target: 1 };
    const sequenceWindow = evidenceSequenceWindow(
      _sceneBeatId,
      _evidenceTimeline,
    );
    if (!sequenceWindow) return null;
    return {
      start: floodProgressForStoryProgress(
        sequenceWindow.startProgress,
        _event?.reconstruction?.storyFloodWindow,
      ),
      target: floodProgressForStoryProgress(
        sequenceWindow.targetProgress,
        _event?.reconstruction?.storyFloodWindow,
      ),
    };
  }

  /** Rebuild the flood front and callout reveal from an authored clock seek. */
  function applySceneTimelineSeek() {
    const seek = sceneTimelineSeek();
    if (!seek) return false;
    stopScenePathReveal();
    stopSceneEvidenceReveal();
    stopSceneMediaPlayback();
    _sceneMediaPlaybackCompletedBeatId = null;

    const progressWindow = scenePathProgressWindow();
    const startProgress = clampUnit(progressWindow?.start ?? 0);
    const targetProgress = Math.max(
      startProgress,
      clampUnit(progressWindow?.target ?? startProgress),
    );
    const cameraProgress = clampUnit(Number(seek.cameraProgress) || 0);
    const holdElapsedSec = Math.max(0, Number(seek.holdElapsedSec) || 0);
    const flightDurationSec = Math.max(
      0.2,
      Number(seek.flightDurationSec) || 0.2,
    );

    if (sceneUsesPathHistory()) {
      _scenePathRevealProgress = 1;
      _sceneRevealProgress = 1;
      return true;
    }

    if (scenePathMovesDuringCamera()) {
      const authoredDurationSec = Number(
        _sceneControls.evidencePathTravelDurationSec,
      );
      const pathDurationSec = Math.max(
        0.12,
        Number.isFinite(authoredDurationSec) && authoredDurationSec > 0
          ? Math.min(authoredDurationSec, flightDurationSec * 0.9)
          : Math.min(2.5, flightDurationSec * 0.6),
      );
      const cameraElapsedSec = cameraProgress * flightDurationSec;
      const linear = clampUnit(cameraElapsedSec / pathDurationSec);
      const eased = 1 - (1 - linear) ** 2;
      _scenePathRevealProgress =
        startProgress + (targetProgress - startProgress) * eased;
      _sceneRevealProgress =
        cameraProgress >= 1
          ? 1
          : clampUnit(
              cameraElapsedSec /
                Math.max(
                  0.25,
                  Number(_sceneControls.evidenceRevealDurationSec) || 0.9,
                ),
            );
      return true;
    }

    const mediaDurationSec =
      _sceneControls.evidenceMediaAutoplay === true
        ? Math.max(
            SCENE_MEDIA_MIN_PLAYBACK_SECONDS,
            Number(_sceneControls.mediaPlaybackHoldSec) || 0,
          )
        : 0;
    const exitDurationSec =
      _sceneControls.evidenceMediaAutoplay === true
        ? Math.max(
            SCENE_MEDIA_EXIT_SECONDS,
            Number(_sceneControls.mediaExitDurationSec) || 0,
          )
        : 0;
    const pathDurationSec = Math.max(
      0.25,
      Number(
        sceneUsesSourcePath()
          ? _sceneControls.evidencePathDurationSec
          : sceneEvidenceSequenceAnimates()
            ? _sceneControls.evidenceSequenceDurationSec
            : _sceneControls.evidenceRevealDurationSec,
      ) || 0.9,
    );
    const pathStartSec = Math.max(
      0,
      Number(_sceneControls.evidencePathStartDelaySec) || 0,
      _sceneControls.evidencePathDuringMedia === true
        ? 0
        : mediaDurationSec + exitDurationSec,
    );
    const linear = clampUnit((holdElapsedSec - pathStartSec) / pathDurationSec);
    _sceneRevealProgress = smoothstep(0, 1, linear);
    _scenePathRevealProgress =
      startProgress + (targetProgress - startProgress) * _sceneRevealProgress;
    const sequenceWindow = sceneEvidenceSequenceAnimates()
      ? evidenceSequenceWindow(_sceneBeatId, _evidenceTimeline)
      : null;
    if (sequenceWindow) {
      _progress =
        sequenceWindow.startProgress +
        (sequenceWindow.targetProgress - sequenceWindow.startProgress) *
          _sceneRevealProgress;
    }
    return true;
  }

  function startScenePathReveal() {
    stopScenePathReveal();
    if (!scenePathMovesDuringCamera()) return;
    const travel = _sceneControls.cameraTravel;
    if (!travel?.active || travel.cancelled) return;
    const progressWindow = scenePathProgressWindow();
    if (!progressWindow) return;
    const startProgress = clampUnit(progressWindow.start);
    const targetProgress = Math.max(
      startProgress,
      clampUnit(progressWindow.target),
    );
    _scenePathRevealProgress = startProgress;
    updateFloodTrace(_scenePathRevealProgress);
    updateSurgeFront(_scenePathRevealProgress);
    if (targetProgress <= startProgress) return;

    // Finish before the camera so the flood front leads the move instead of
    // arriving after the viewpoint. The director supplies the actual duration
    // for LOAD, replay, and scene-run routes.
    const travelDurationSec = Math.max(0.2, Number(travel.durationSec) || 0.2);
    // Each Nepal reach has different length and framing. Use its authored
    // travel timing when supplied, bounded by the actual flight so the amber
    // head always finishes ahead of the camera rather than sharing one global
    // speed across every segment.
    const authoredDurationSec = Number(
      _sceneControls.evidencePathTravelDurationSec,
    );
    const durationSec =
      Number.isFinite(authoredDurationSec) && authoredDurationSec > 0
        ? Math.min(authoredDurationSec, travelDurationSec * 0.9)
        : Math.min(2.5, travelDurationSec * 0.6);
    const durationMs = Math.max(120, durationSec * 1000);
    const travelId = travel.id;
    let lastTickAt = performance.now();
    let activeElapsedMs = 0;
    const accrueActiveTime = (now) => {
      const tickAt = Math.max(lastTickAt, Number(now) || lastTickAt);
      if (!sceneMediaPlaybackBlocksPath())
        activeElapsedMs += tickAt - lastTickAt;
      lastTickAt = tickAt;
      return activeElapsedMs;
    };
    renderHost.hold(SCENE_PATH_RENDER_HOLD);
    _scenePathHoldActive = true;
    // RAF normally paints every intermediate frame. This independent deadline
    // is registered before Cesium starts the flight, so a throttled or briefly
    // blocked render loop still establishes the complete tail before arrival.
    const finishAtDeadline = () => {
      const currentTravel = _sceneControls.cameraTravel;
      if (
        !_enabled ||
        !scenePathMovesDuringCamera() ||
        !currentTravel?.active ||
        currentTravel.cancelled ||
        currentTravel.id !== travelId
      )
        return;
      const remainingMs = durationMs - accrueActiveTime(performance.now());
      if (remainingMs > 0) {
        _scenePathDeadlineTimer =
          globalThis.window?.setTimeout?.(
            finishAtDeadline,
            Math.max(32, remainingMs),
          ) ?? null;
        return;
      }
      finishScenePathReveal(targetProgress, 'bhote-koshi-scene-path-deadline');
    };
    _scenePathDeadlineTimer =
      globalThis.window?.setTimeout?.(finishAtDeadline, durationMs) ?? null;
    const step = (now) => {
      const currentTravel = _sceneControls.cameraTravel;
      if (
        !_enabled ||
        !scenePathMovesDuringCamera() ||
        !currentTravel?.active ||
        currentTravel.cancelled ||
        currentTravel.id !== travelId
      ) {
        stopScenePathReveal();
        return;
      }
      const linear = clampUnit(accrueActiveTime(now) / durationMs);
      // Ease out so the schematic head establishes the downstream route before
      // the camera reaches it. Combined with the shorter travel window, this
      // keeps the front alongside or ahead of a normally eased Cesium flight.
      const eased = 1 - (1 - linear) ** 2;
      _scenePathRevealProgress =
        startProgress + (targetProgress - startProgress) * eased;
      updateFloodTrace(_scenePathRevealProgress);
      updateSurgeFront(_scenePathRevealProgress);
      renderHost.request('bhote-koshi-scene-path-travel');
      if (linear < 1) {
        _scenePathAnimationFrame = requestAnimationFrame(step);
      } else {
        finishScenePathReveal(
          targetProgress,
          'bhote-koshi-scene-path-complete',
        );
      }
    };
    _scenePathAnimationFrame = requestAnimationFrame(step);
  }

  function startSceneEvidenceReveal() {
    stopSceneEvidenceReveal();
    const sequenceAnimates = sceneEvidenceSequenceAnimates();
    if (
      (!sequenceAnimates && !sceneEvidenceDefersUntilCameraSettles()) ||
      !sceneEvidenceCameraSettled()
    )
      return;
    const sequenceWindow = sequenceAnimates
      ? evidenceSequenceWindow(_sceneBeatId, _evidenceTimeline)
      : null;
    if (sequenceAnimates && !sequenceWindow) return;
    _sceneRevealProgress = 0;
    const sourceWindow =
      sceneUsesSourcePath() || sceneUsesPathHistory()
        ? scenePathProgressWindow()
        : null;
    // The independent travel clock owns persistent path motion. Older beats
    // retain the arrival-gated reveal behavior for both card and path.
    if (!scenePathMovesDuringCamera()) {
      const initialFloodProgress = clampUnit(sourceWindow?.start ?? 0);
      updateFloodTrace(initialFloodProgress);
      updateSurgeFront(initialFloodProgress);
    }
    const durationMs = Math.max(
      250,
      (Number(
        sceneUsesSourcePath()
          ? _sceneControls.evidencePathDurationSec
          : sequenceAnimates
            ? _sceneControls.evidenceSequenceDurationSec
            : _sceneControls.evidenceRevealDurationSec,
      ) || 0.9) * 1000,
    );
    const targetFloodProgress = sourceWindow
      ? sourceWindow.target
      : _sceneControls.evidencePath === 'none'
        ? 0
        : floodProgressForStoryProgress(
            _progress,
            _event?.reconstruction?.storyFloodWindow,
          );
    if (sequenceWindow) updateProgress(sequenceWindow.startProgress);
    let lastTickAt = performance.now();
    let activeElapsedMs = 0;
    renderHost.hold(SCENE_REVEAL_RENDER_HOLD);
    _sceneRevealHoldActive = true;
    const step = (now) => {
      if (
        !_enabled ||
        !sceneEvidenceCameraSettled() ||
        (sequenceAnimates && !sceneEvidenceSequenceAnimates())
      ) {
        stopSceneEvidenceReveal();
        return;
      }
      const tickAt = Math.max(lastTickAt, Number(now) || lastTickAt);
      if (!sceneMediaPlaybackBlocksPath())
        activeElapsedMs += tickAt - lastTickAt;
      lastTickAt = tickAt;
      const linear = clampUnit(activeElapsedMs / durationMs);
      _sceneRevealProgress = smoothstep(0, 1, linear);
      if (sequenceWindow) {
        updateProgress(
          sequenceWindow.startProgress +
            (sequenceWindow.targetProgress - sequenceWindow.startProgress) *
              _sceneRevealProgress,
        );
      } else if (!scenePathMovesDuringCamera()) {
        const floodProgress = sourceWindow
          ? sourceWindow.start +
            (sourceWindow.target - sourceWindow.start) * _sceneRevealProgress
          : targetFloodProgress * _sceneRevealProgress;
        updateFloodTrace(floodProgress);
        updateSurgeFront(floodProgress);
      }
      renderHost.request('bhote-koshi-scene-beat-reveal');
      if (linear < 1) {
        _sceneRevealAnimationFrame = requestAnimationFrame(step);
      } else {
        _sceneRevealAnimationFrame = null;
        renderHost.release(SCENE_REVEAL_RENDER_HOLD);
        _sceneRevealHoldActive = false;
      }
    };
    _sceneRevealAnimationFrame = requestAnimationFrame(step);
  }

  function stopEvidenceVideoFrameLoop(video = _evidenceVideo) {
    if (_evidenceVideoFrameHandle == null) return;
    try {
      video?.cancelVideoFrameCallback?.(_evidenceVideoFrameHandle);
    } catch {}
    _evidenceVideoFrameHandle = null;
  }

  function startEvidenceVideoFrameLoop(
    video,
    index,
    generation,
    clipIn,
    clipDuration,
  ) {
    if (
      !sceneEvidenceMediaAutoplays() ||
      typeof video?.requestVideoFrameCallback !== 'function' ||
      _evidenceVideoFrameHandle != null
    )
      return;
    const drawFrame = () => {
      _evidenceVideoFrameHandle = null;
      if (
        !_enabled ||
        generation !== _evidenceVideoGeneration ||
        video !== _evidenceVideo ||
        !sceneEvidenceMediaAutoplays()
      )
        return;
      if (
        redrawEvidenceSlot(index, video, {
          videoActive: true,
          mediaProgress: clampUnit(
            ((Number(video.currentTime) || 0) - clipIn) / clipDuration,
          ),
        })
      ) {
        renderHost.request('bhote-koshi-evidence-video-frame');
      }
      _evidenceVideoFrameHandle = video.requestVideoFrameCallback(drawFrame);
    };
    _evidenceVideoFrameHandle = video.requestVideoFrameCallback(drawFrame);
  }

  function releaseEvidenceVideo({ restorePoster = true } = {}) {
    const previousIndex = _evidenceVideoIndex;
    const video = _evidenceVideo;
    stopEvidenceVideoFrameLoop(video);
    _evidenceVideoGeneration += 1;
    _evidenceVideo = null;
    _evidenceVideoIndex = -1;
    _evidenceVideoReady = false;
    if (video) {
      try {
        video.pause();
      } catch {}
      try {
        video.removeAttribute?.('src');
        video.load?.();
      } catch {}
    }
    if (
      restorePoster &&
      previousIndex >= 0 &&
      redrawEvidenceSlot(previousIndex)
    ) {
      renderHost.request('bhote-koshi-evidence-poster-restore');
    }
  }

  function activateEvidenceVideo(index) {
    if (_evidenceVideoIndex === index) return;
    releaseEvidenceVideo();
    const observation = _evidenceTimeline[index]?.observation;
    const videoPath = observation?.media?.videoPath;
    if (!videoPath) return;
    const video = videoFactory();
    if (!video) return;
    const generation = ++_evidenceVideoGeneration;
    _evidenceVideo = video;
    _evidenceVideoIndex = index;
    _evidenceVideoReady = false;
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.loop = true;
    const markReady = () => {
      if (
        !_enabled ||
        generation !== _evidenceVideoGeneration ||
        video !== _evidenceVideo
      )
        return;
      _evidenceVideoReady = true;
      renderHost.request('bhote-koshi-evidence-video-ready');
      syncEvidenceMedia();
    };
    video.addEventListener?.('loadeddata', markReady, { once: true });
    video.addEventListener?.('seeked', () => {
      if (
        !_enabled ||
        generation !== _evidenceVideoGeneration ||
        video !== _evidenceVideo
      )
        return;
      renderHost.request('bhote-koshi-evidence-video-seek');
    });
    video.src = eventAsset(videoPath);
    video.load?.();
  }

  function syncEvidenceMedia() {
    if (
      _presentation === BHOTE_KOSHI_SCENE_PRESENTATION &&
      !_evidenceTimeline.some(
        ({ observation }) => observation.id === _sceneBeatId,
      )
    ) {
      releaseEvidenceVideo();
      _embeddedEvidenceIndex = -1;
      _embeddedMedia?.hide?.({ immediate: true });
      return;
    }
    if (!sceneEvidenceCameraSettled()) {
      releaseEvidenceVideo();
      _embeddedEvidenceIndex = -1;
      const warmingEvidence =
        sceneMediaPlaybackActive() &&
        _presentation === BHOTE_KOSHI_SCENE_PRESENTATION &&
        _sceneSurface === BHOTE_KOSHI_SCENE_EVIDENCE_BEAT;
      // Keep the same preload across camera frames; stop/disable still cancels it.
      _embeddedMedia?.hide?.({ preserveWarm: warmingEvidence });
      if (warmingEvidence) {
        const upcoming = _evidenceTimeline.find(
          ({ observation }) => observation.id === _sceneBeatId,
        )?.observation;
        if (usesProviderEmbeddedEvidence(upcoming)) {
          _embeddedMedia?.warm?.({ observation: upcoming });
        } else {
          _embeddedMedia?.warm?.();
        }
      }
      return;
    }
    if (
      _presentation === BHOTE_KOSHI_SCENE_PRESENTATION &&
      _sceneSurface !== BHOTE_KOSHI_SCENE_EVIDENCE_BEAT
    ) {
      releaseEvidenceVideo();
      _embeddedEvidenceIndex = -1;
      _embeddedMedia?.hide?.();
      return;
    }
    const index =
      _presentation === BHOTE_KOSHI_SCENE_PRESENTATION &&
      _sceneControls.evidenceHoldCard
        ? _evidenceTimeline.findIndex(
            ({ observation }) => observation.id === _sceneBeatId,
          )
        : activeEvidenceIndex(_progress, _evidenceTimeline);
    if (index < 0) {
      releaseEvidenceVideo();
      _embeddedEvidenceIndex = -1;
      _embeddedMedia?.hide?.();
      return;
    }
    if (sceneTimelineSeek() && !sceneTimelineMediaVisible()) {
      releaseEvidenceVideo({ restorePoster: false });
      _embeddedEvidenceIndex = index;
      _embeddedMedia?.hide?.({ immediate: true });
      return;
    }
    if (
      _evidenceTimeline[index]?.observation?.id ===
      _sceneMediaPlaybackCompletedBeatId
    ) {
      if (_evidenceVideo || _evidenceVideoIndex >= 0) {
        releaseEvidenceVideo({ restorePoster: false });
      }
      _embeddedEvidenceIndex = index;
      _embeddedMedia?.hide?.();
      return;
    }
    if (syncEmbeddedEvidence(index)) {
      releaseEvidenceVideo();
      return;
    }
    activateEvidenceVideo(index);
    const video = _evidenceVideo;
    const beat = _evidenceTimeline[index];
    if (!video || !_evidenceVideoReady || !beat) return;
    const presentation = evidenceBeatPresentation(_progress, beat);
    const clipIn = Math.max(0, Number(beat.observation.media?.clipInSec) || 0);
    const declaredOut = Number(beat.observation.media?.clipOutSec);
    const mediaDuration = Number(video.duration);
    const clipOut = Number.isFinite(declaredOut)
      ? Math.max(clipIn + 0.1, declaredOut)
      : Number.isFinite(mediaDuration)
        ? Math.max(clipIn + 0.1, mediaDuration)
        : clipIn + 4;
    const clipDuration = clipOut - clipIn;
    const targetTime = clipIn + presentation.localProgress * clipDuration;
    const beatDuration = Math.max(
      0.1,
      (Math.min(1, beat.deactivationProgress) - beat.activationProgress) *
        BHOTE_KOSHI_PLAYBACK_SECONDS,
    );
    const sceneAutoplay = sceneEvidenceMediaAutoplays();
    video.playbackRate = sceneAutoplay
      ? 1
      : Math.max(0.5, Math.min(2, clipDuration / beatDuration));
    if (!_playing && !sceneAutoplay) {
      stopEvidenceVideoFrameLoop(video);
      try {
        video.pause();
      } catch {}
      if (Math.abs((Number(video.currentTime) || 0) - targetTime) > 0.04) {
        try {
          video.currentTime = targetTime;
        } catch {}
      }
    } else {
      if (
        _playing &&
        Math.abs((Number(video.currentTime) || 0) - targetTime) > 0.42
      ) {
        try {
          video.currentTime = targetTime;
        } catch {}
      }
      if (video.paused) {
        try {
          const playback = video.play();
          startSceneMediaPlayback(index);
          void playback?.catch?.(() => {});
        } catch {}
      }
      if (sceneAutoplay) {
        startEvidenceVideoFrameLoop(
          video,
          index,
          _evidenceVideoGeneration,
          clipIn,
          clipDuration,
        );
      }
    }
    if (
      redrawEvidenceSlot(index, video, {
        videoActive: true,
        mediaProgress: presentation.localProgress,
      })
    ) {
      renderHost.request('bhote-koshi-evidence-video-frame');
    }
  }

  function publishEvidenceEntries(event) {
    const observations = _evidenceTimeline.map((beat) => beat.observation);
    _evidenceFrameSlots = observations.map((observation) => ({
      frame: evidenceFrameFactory(observation),
      layout: evidenceCardLayout(observation),
      poster: null,
      stamp: 1,
    }));
    const entries = [];
    for (let index = 0; index < observations.length; index += 1) {
      const observation = observations[index];
      const anchor = _evidenceAnchors[index];
      const frameSlot = _evidenceFrameSlots[index];
      entries.push({
        id: `evidence-card-${observation.id}`,
        position: evidencePositionGetter(index),
        cullPosition: anchor,
        variant: 'thumbnail',
        paintLane: 'thumbnail',
        title: '',
        image: frameSlot,
        sourceAlpha: () => sceneEvidencePresentation(index).alpha,
        presentationScale: () => sceneEvidencePresentation(index).scale,
        leaderProgress: () => sceneEvidencePresentation(index).leaderProgress,
        contentAlpha: () => sceneEvidencePresentation(index).contentAlpha,
        anchorDot: true,
        requireImage: true,
        thumbnailWidth: frameSlot.layout.thumbnailWidth,
        thumbnailHeight: frameSlot.layout.thumbnailHeight,
        thumbnailPadX: 6,
        thumbnailPadTop: 6,
        thumbnailPadBottom: 7,
        thumbnailTitleGap: 0,
        thumbnailTitleHeight: 0,
        thumbnailTitleChars: 0,
        thumbnailRuleHeight: 3,
        thumbnailRuleColor: BHOTE_EVENT_ACCENT,
        thumbnailLeaderColor: WORLD_OVERLAY_STYLE.leader,
        thumbnailBackground: WORLD_OVERLAY_STYLE.background,
        thumbnailTitleColor: WORLD_OVERLAY_STYLE.title,
        thumbnailTitleFont: WORLD_OVERLAY_STYLE.fontTitle,
        accent: BHOTE_EVENT_ACCENT,
        priority: 1_000_000 - index,
        protected: true,
        active: true,
        collisionGroup: 'ambient-card',
        zIndex: 60,
        interactive: true,
        accessibilityLabel: `Open original source for ${observation.title}; capture time unverified`,
        activate: () => openExternal(observation.media.sourceUrl),
        minDistance: 0,
        maxDistance: 220000,
        distanceFadeStartRatio: 0.82,
        distanceScale: {
          near: 1200,
          nearValue: 1,
          far: 180000,
          farValue: 0.72,
        },
        edgeFade: 'keyhole',
        horizonCull: true,
        terrainOcclusion: true,
        gapPx: 24,
        anchorRadiusPx: 4,
        anchorGapPaddingPx: 26,
        // This short upstream reach sits immediately above its witness pin.
        // Keep the landscape card below it rather than hiding the whole path.
        placement:
          _presentation === BHOTE_KOSHI_SCENE_PRESENTATION &&
          observation.id === 'debris-dammed-lake'
            ? 'below'
            : 'right',
        verticalOnly: false,
        leaderStyle: 'elbow',
        viewportMargin: 18,
      });
      entries.push({
        id: `evidence-breadcrumb-${observation.id}`,
        position: evidencePositionGetter(index, true),
        cullPosition: anchor,
        variant: 'label',
        title: `${String(observation.sequence).padStart(2, '0')} · ${observation.shortTitle || observation.title}`,
        details: [],
        accent: WORLD_OVERLAY_STYLE.accent,
        priority: 80_000 - index,
        collisionGroup: 'ambient-label',
        zIndex: 35,
        minDistance: 0,
        maxDistance: 260000,
        distanceFadeStartRatio: 0.7,
        distanceScale: {
          near: 1800,
          nearValue: 1,
          far: 220000,
          farValue: 0.66,
        },
        edgeFade: 'keyhole',
        horizonCull: true,
        terrainOcclusion: true,
        gapPx: 9,
        placement: 'above',
      });
    }
    overlayHost.setEntries(BHOTE_KOSHI_OVERLAY_SOURCE_ID, entries, {
      cohortLimit: 16,
      collisionCapacity: 12,
      moving: false,
    });
    overlayHost.setVisible(
      BHOTE_KOSHI_OVERLAY_SOURCE_ID,
      _presentation !== BHOTE_KOSHI_SCENE_PRESENTATION ||
        _sceneSurface === BHOTE_KOSHI_SCENE_EVIDENCE_BEAT,
    );
  }

  async function loadEvidencePosters(event, signal, generation) {
    const observations = _evidenceTimeline.map((beat) => beat.observation);
    await Promise.allSettled(
      observations.map(async (observation, index) => {
        const posterUrl = observation.media?.posterPath
          ? eventAsset(observation.media.posterPath)
          : observation.media?.posterUrl;
        if (!posterUrl) return;
        let poster = null;
        try {
          poster = await mediaLoader(posterUrl, { signal });
          if (signal.aborted || !_enabled || generation !== _mediaGeneration) {
            closeFrame(poster);
            return;
          }
          const slot = _evidenceFrameSlots[index];
          if (!slot) {
            closeFrame(poster);
            return;
          }
          closeFrame(slot.poster);
          slot.poster = poster;
          poster = null;
          if (!redrawEvidenceSlot(index)) return;
          renderHost.request('bhote-koshi-evidence-poster');
        } catch (error) {
          closeFrame(poster);
          if (
            error?.name !== 'AbortError' &&
            error?.message !== 'Evidence poster decoding is unavailable'
          ) {
            console.warn(
              `[Data:BhoteKoshi] Evidence poster failed for ${observation.id}:`,
              error,
            );
          }
        }
      }),
    );
  }

  async function prepareEventTerrain(event, signal) {
    _sourceShotPaths = buildSourceShotPaths(event);
    const elevationOffsetM =
      _presentation === BHOTE_KOSHI_SCENE_PRESENTATION ? 55 : 8;
    _terrainPositions = event.reconstruction.corridor.map((point) =>
      Cesium.Cartesian3.fromDegrees(
        point.lon,
        point.lat,
        point.elevationM + elevationOffsetM,
      ),
    );
    prepareScenePath();
    _evidenceTimeline = buildEvidenceTimeline(
      event.evidenceSpine,
      event.reconstruction.corridor,
    );
    const timelineEvent = {
      ...event,
      evidenceSpine: _evidenceTimeline.map((beat) => beat.observation),
    };
    _evidenceAnchors = await resolveEvidenceAnchors(timelineEvent, signal);
    throwIfEnableCancelled(signal, _enabled);
    _cinematicKeyframes = buildCinematicKeyframes(
      _evidenceTimeline,
      _evidenceAnchors,
    );
    const requestedBeatProgress = evidenceBeatProgress(
      _sceneBeatId,
      _evidenceTimeline,
      _sceneBeatReveal,
    );
    const sequenceWindow = sceneEvidenceSequenceAnimates()
      ? evidenceSequenceWindow(_sceneBeatId, _evidenceTimeline)
      : null;
    if (sequenceWindow) _progress = sequenceWindow.startProgress;
    else if (requestedBeatProgress != null) _progress = requestedBeatProgress;
    publishEvidenceEntries(timelineEvent);
    _mediaAbortController = new AbortController();
    const mediaController = _mediaAbortController;
    const generation = ++_mediaGeneration;
    signal?.addEventListener('abort', () => mediaController.abort(), {
      once: true,
    });
    void loadEvidencePosters(timelineEvent, mediaController.signal, generation);
    updateProgress(_progress);
  }

  function createFloodDataSource() {
    const tileSafe = usesPhotorealFloodSurface();
    _floodSurfaceMode = tileSafe ? 'tiles' : 'terrain';
    const haloMaterial = new Cesium.PolylineDashMaterialProperty({
      color: FLOOD_COLOR.withAlpha(0.38),
      dashLength: 18,
    });
    const coreMaterial = new Cesium.PolylineGlowMaterialProperty({
      color: FLOOD_COLOR.withAlpha(0.96),
      glowPower: 0.24,
      taperPower: 0.7,
    });
    _floodDataSource = new Cesium.CustomDataSource('bhote-koshi-flood');
    _floodHalo = _floodDataSource.entities.add({
      id: 'bhote-koshi-flood-halo',
      show: false,
      polyline: {
        positions: new Cesium.CallbackProperty(
          () => _corridorPositionCache.positions,
          false,
        ),
        width: 18,
        // Dynamic non-ground Cesium lines do not support depthFailMaterial.
        // Classify the active surface so later-refined mesh tiles cannot bury it.
        clampToGround: true,
        material: haloMaterial,
        classificationType: tileSafe
          ? Cesium.ClassificationType.BOTH
          : Cesium.ClassificationType.TERRAIN,
      },
    });
    _floodCore = _floodDataSource.entities.add({
      id: 'bhote-koshi-flood-core',
      show: false,
      polyline: {
        positions: new Cesium.CallbackProperty(
          () => _corridorPositionCache.positions,
          false,
        ),
        width: 5,
        clampToGround: true,
        material: coreMaterial,
        classificationType: tileSafe
          ? Cesium.ClassificationType.BOTH
          : Cesium.ClassificationType.TERRAIN,
      },
    });
    _surgePoint = _floodDataSource.entities.add({
      id: 'bhote-koshi-surge-front',
      show: false,
      position: Cesium.Cartesian3.ZERO,
      point: {
        pixelSize: 11,
        color: SURGE_COLOR,
        outlineColor: Cesium.Color.BLACK.withAlpha(0.85),
        outlineWidth: 3,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: tileSafe ? Number.POSITIVE_INFINITY : 0,
      },
    });
    _viewer.dataSources.add(_floodDataSource);
  }

  function syncFloodSurfaceMode() {
    const nextMode = usesPhotorealFloodSurface() ? 'tiles' : 'terrain';
    if (!_viewer || !_floodDataSource || _floodSurfaceMode === nextMode) return;
    _viewer.dataSources.remove(_floodDataSource, true);
    _floodDataSource = null;
    _floodHalo = null;
    _floodCore = null;
    _surgePoint = null;
    _lastSurgePosition = null;
    _lastSurgeVisible = null;
    _corridorPositionCache = { visibleCount: -1, positions: [] };
    createFloodDataSource();
  }

  function createSplitControl(event) {
    _splitControl = createImagerySplit({
      scene: _viewer.scene,
      initialValue: _split,
      id: 'bhote-koshi-split-line',
      handleClass: 'bhote-koshi-split-handle',
      cssProperty: '--bhote-koshi-split',
      beforeTitle: event.imagery.before.label,
      afterTitle: event.imagery.after.label,
      ariaLabel: 'Historical reference and post-event image divider',
      formatValueText: (beforePercent, afterPercent) =>
        `A historical reference ${beforePercent} percent, B post-event ${afterPercent} percent`,
      onChange: setSplit,
    });
  }

  function applyCinematicCamera() {
    if (
      !_cinematicActive ||
      !_viewer?.camera ||
      _cinematicKeyframes.length === 0
    )
      return;
    if (_lastCinematicProgress === _progress) return;
    const pose = sampleCinematicPose(
      _progress,
      _cinematicKeyframes,
      _cinematicPose,
    );
    if (!pose) return;
    _cinematicOffset.heading = Cesium.Math.toRadians(pose.headingDeg);
    _cinematicOffset.pitch = Cesium.Math.toRadians(pose.pitchDeg);
    _cinematicOffset.range = pose.rangeM;
    _viewer.camera.lookAt(pose.target, _cinematicOffset);
    _lastCinematicProgress = _progress;
  }

  function syncCinematicButton() {
    const button = _panelRefs?.cinematicButton;
    if (!button) return;
    setElementProperty(
      button,
      'textContent',
      _cinematicActive ? '■ RELEASE CAMERA' : '◉ CINEMATIC',
    );
    setElementAttribute(button, 'aria-pressed', String(_cinematicActive));
  }

  function claimCinematicCamera() {
    if (!_enabled || _cinematicKeyframes.length === 0) return false;
    _cinematicReplayArmed = true;
    if (!_cinematicActive) {
      _cinematicActive = true;
      _lastCinematicProgress = null;
      announceNavigationAuthority('bhote-koshi-cinematic');
      _viewer?.camera?.cancelFlight?.();
    }
    syncCinematicButton();
    return true;
  }

  function stopCinematic({
    releaseCamera = true,
    preserveReplay = false,
  } = {}) {
    if (!preserveReplay) _cinematicReplayArmed = false;
    if (!_cinematicActive) {
      syncPanel();
      return;
    }
    _cinematicActive = false;
    _lastCinematicProgress = null;
    if (releaseCamera)
      _viewer?.camera?.lookAtTransform?.(Cesium.Matrix4.IDENTITY);
    syncCinematicButton();
    renderHost.request('bhote-koshi-cinematic-stop');
  }

  function startCinematic({ play = true } = {}) {
    if (_progress >= 1) updateProgress(0);
    if (!claimCinematicCamera()) return false;
    applyCinematicCamera();
    if (play && !_playing) startPlayback();
    return true;
  }

  function toggleCinematic() {
    invalidateIntroAutostart();
    if (_cinematicActive) {
      stopCinematic();
      return;
    }
    startCinematic();
  }

  function handleManualCameraInput() {
    invalidateIntroAutostart();
    if (_cinematicActive) stopCinematic();
  }

  function invalidateIntroAutostart() {
    _introGeneration += 1;
    if (_introTimer != null) window.clearTimeout(_introTimer);
    _introTimer = null;
  }

  function attachCameraInputRelease() {
    _cameraInputTarget = _viewer?.scene?.canvas || null;
    for (const type of CINEMATIC_INPUT_EVENTS) {
      _cameraInputTarget?.addEventListener?.(type, handleManualCameraInput);
    }
  }

  function detachCameraInputRelease() {
    for (const type of CINEMATIC_INPUT_EVENTS) {
      _cameraInputTarget?.removeEventListener?.(type, handleManualCameraInput);
    }
    _cameraInputTarget = null;
  }

  function handleEvidenceCardClick(event) {
    if (
      !isPointerFree() ||
      !_enabled ||
      _presentation !== BHOTE_KOSHI_SCENE_PRESENTATION ||
      _sceneSurface !== BHOTE_KOSHI_SCENE_EVIDENCE_BEAT
    )
      return;
    const target = _evidenceClickTarget;
    const bounds = target?.getBoundingClientRect?.();
    const offsetX = Number(event?.offsetX);
    const offsetY = Number(event?.offsetY);
    const clientX = Number(event?.clientX);
    const clientY = Number(event?.clientY);
    const x = Number.isFinite(offsetX)
      ? offsetX
      : Number.isFinite(clientX) && bounds
        ? clientX - bounds.left
        : Number.NaN;
    const y = Number.isFinite(offsetY)
      ? offsetY
      : Number.isFinite(clientY) && bounds
        ? clientY - bounds.top
        : Number.NaN;
    const hit = overlayHost.hitTest?.(x, y, {
      sourceId: BHOTE_KOSHI_OVERLAY_SOURCE_ID,
      filter: (entry) => String(entry?.id || '').startsWith('evidence-card-'),
    });
    if (typeof hit?.entry?.activate !== 'function') return;
    hit.entry.activate();
  }

  function attachEvidenceCardActivation() {
    _evidenceClickTarget = _viewer?.scene?.canvas || null;
    _evidenceClickTarget?.addEventListener?.('click', handleEvidenceCardClick);
  }

  function detachEvidenceCardActivation() {
    _evidenceClickTarget?.removeEventListener?.(
      'click',
      handleEvidenceCardClick,
    );
    _evidenceClickTarget = null;
  }

  function currentEvidenceIndex() {
    return Math.max(0, activeEvidenceIndex(_progress, _evidenceTimeline));
  }

  function jumpToEvidenceBeat(direction) {
    if (!_enabled || _evidenceTimeline.length === 0) return false;
    invalidateIntroAutostart();
    stopPlayback();
    const targetIndex = adjacentEvidenceIndex(
      _progress,
      _evidenceTimeline,
      direction,
    );
    if (targetIndex < 0) return false;
    if (
      _presentation !== BHOTE_KOSHI_SCENE_PRESENTATION &&
      !claimCinematicCamera()
    )
      return false;
    updateProgress(_evidenceTimeline[targetIndex].activationProgress);
    return true;
  }

  async function navigateSceneShot(direction) {
    if (
      !_sceneController?.loadAdjacentShot ||
      !_sceneContext ||
      _sceneActionPending
    )
      return false;
    _sceneActionPending = true;
    syncPanel();
    try {
      return await _sceneController.loadAdjacentShot(
        _sceneContext.sceneId,
        _sceneContext.shotId,
        direction,
      );
    } finally {
      _sceneActionPending = false;
      syncPanel();
    }
  }

  async function playSceneShot() {
    if (!_sceneController?.replayShot || !_sceneContext || _sceneActionPending)
      return false;
    _sceneActionPending = true;
    syncPanel();
    try {
      return await _sceneController.replayShot(
        _sceneContext.sceneId,
        _sceneContext.shotId,
      );
    } finally {
      _sceneActionPending = false;
      syncPanel();
    }
  }

  async function playWholeScene() {
    if (
      !_enabled ||
      _presentation !== BHOTE_KOSHI_SCENE_PRESENTATION ||
      !_sceneController?.continueScene ||
      !_sceneContext?.sceneId ||
      !_sceneContext?.shotId ||
      _sceneActionPending
    )
      return false;
    const action = { type: 'scene' };
    _sceneActionPending = action;
    syncPanel();
    try {
      return await _sceneController.continueScene(
        _sceneContext.sceneId,
        _sceneContext.shotId,
      );
    } catch (error) {
      console.warn('[Bhote Koshi] Scene playback failed:', error);
      return false;
    } finally {
      // A disable/re-enable may have handed the panel to a newer action.
      if (_sceneActionPending === action) {
        _sceneActionPending = false;
        syncPanel();
      }
    }
  }

  function handlePlay() {
    if (_presentation === BHOTE_KOSHI_SCENE_PRESENTATION) {
      void playSceneShot();
      return;
    }
    togglePlayback();
  }

  function handlePrevious() {
    if (_presentation === BHOTE_KOSHI_SCENE_PRESENTATION) {
      void navigateSceneShot(-1);
      return;
    }
    jumpToEvidenceBeat(-1);
  }

  function handleNext() {
    if (_presentation === BHOTE_KOSHI_SCENE_PRESENTATION) {
      void navigateSceneShot(1);
      return;
    }
    jumpToEvidenceBeat(1);
  }

  function replayCinematic() {
    if (!_enabled) return false;
    invalidateIntroAutostart();
    stopPlayback();
    updateProgress(0);
    return startCinematic();
  }

  function handleStoryReplay() {
    replayCinematic();
  }

  function previewProgress(progress) {
    if (_presentation !== BHOTE_KOSHI_SCENE_PRESENTATION) {
      invalidateIntroAutostart();
      stopPlayback();
      updateProgress(progress);
      return;
    }
    _sceneScrubProgress = clampUnit(progress);
    const sceneDurationSec = Number(_sceneContext?.sceneDurationSec) || 0;
    setElementProperty(
      _panelRefs?.progressInput,
      'value',
      String(Math.round(_sceneScrubProgress * 1000)),
    );
    setElementProperty(
      _panelRefs?.time,
      'textContent',
      `~${elapsedLabel(_sceneScrubProgress, sceneDurationSec)} / ${elapsedLabel(1, sceneDurationSec)}`,
    );
    if (_sceneSeekFrame != null) return;
    const schedule =
      globalThis.requestAnimationFrame ||
      ((callback) => globalThis.setTimeout(callback, 16));
    _sceneSeekFrame = schedule(() => {
      _sceneSeekFrame = null;
      void commitProgress(_sceneScrubProgress, { final: false });
    });
  }

  async function commitProgress(progress, { final = false } = {}) {
    if (_presentation !== BHOTE_KOSHI_SCENE_PRESENTATION) return;
    if (
      !_sceneController?.seekScene ||
      !_sceneContext?.sceneId ||
      (_sceneActionPending &&
        !['scene', 'scene-seek'].includes(_sceneActionPending.type))
    ) {
      syncPanel();
      return;
    }
    if (final && _sceneSeekFrame != null) {
      const cancel = globalThis.cancelAnimationFrame || globalThis.clearTimeout;
      cancel?.(_sceneSeekFrame);
      _sceneSeekFrame = null;
    }
    const requestedProgress = clampUnit(progress);
    _sceneScrubProgress = requestedProgress;
    const generation = ++_sceneSeekGeneration;
    const action = { type: 'scene-seek', generation };
    _sceneActionPending = action;
    syncPanel();
    try {
      await _sceneController.seekScene(
        _sceneContext.sceneId,
        requestedProgress,
      );
    } catch (error) {
      console.warn('[Bhote Koshi] Scene clock seek failed:', error);
    } finally {
      if (generation === _sceneSeekGeneration && final)
        _sceneScrubProgress = null;
      if (
        _sceneActionPending === action &&
        generation === _sceneSeekGeneration
      ) {
        _sceneActionPending = false;
        syncPanel();
      }
    }
  }

  function openActiveEvidenceSource() {
    const beatIndex = currentEvidenceIndex();
    const sourceUrl =
      _evidenceTimeline[beatIndex]?.observation?.media?.sourceUrl;
    if (!sourceUrl) return false;
    openExternal(sourceUrl);
    return true;
  }

  function openGeolocationMap() {
    const sourceUrl = _event?.geolocationMap?.sourceUrl;
    if (!sourceUrl) return false;
    openExternal(sourceUrl);
    return true;
  }

  function syncPanel() {
    if (!_panelRefs || !_event) return;
    const sceneDirected = _presentation === BHOTE_KOSHI_SCENE_PRESENTATION;
    const sceneClockProgress = clampUnit(
      Number(_sceneContext?.sceneProgress) || 0,
    );
    const visibleSceneProgress =
      _sceneScrubProgress == null
        ? sceneClockProgress
        : clampUnit(_sceneScrubProgress);
    const displayProgress = sceneDirected ? visibleSceneProgress : _progress;
    setElementProperty(
      _panelRefs.progressInput,
      'value',
      String(Math.round(displayProgress * 1000)),
    );
    setElementProperty(
      _panelRefs.progressInput,
      'disabled',
      sceneDirected &&
        (!_sceneController?.seekScene ||
          !_sceneContext?.sceneId ||
          Boolean(
            _sceneActionPending &&
            !['scene', 'scene-seek'].includes(_sceneActionPending.type),
          )),
    );
    setElementAttribute(
      _panelRefs.progressInput,
      'aria-label',
      sceneDirected
        ? 'Seek Nepal scene clock'
        : 'Schematic downstream progression',
    );
    setElementProperty(
      _panelRefs.timelineLabel,
      'textContent',
      sceneDirected ? 'NEPAL SCENE CLOCK' : 'RECONSTRUCTION CLOCK',
    );
    const sceneDuration = Number(_sceneContext?.sceneDurationSec) || 0;
    setElementProperty(
      _panelRefs.time,
      'textContent',
      sceneDirected
        ? `~${elapsedLabel(visibleSceneProgress, sceneDuration)} / ${elapsedLabel(1, sceneDuration)}`
        : `~${elapsedLabel(_progress, _event.reconstruction.elapsedSeconds)} / ` +
            elapsedLabel(1, _event.reconstruction.elapsedSeconds),
    );
    const playLabel = sceneDirected
      ? _sceneActionPending && _sceneActionPending.type !== 'scene'
        ? '… PLAYING SHOT'
        : '▶ PLAY SHOT'
      : _playing
        ? 'Ⅱ PAUSE'
        : _progress >= 1
          ? _cinematicReplayArmed
            ? '↺ REPLAY CINEMATIC'
            : '↺ REPLAY'
          : '▶ PLAY';
    setElementProperty(_panelRefs.playButton, 'textContent', playLabel);
    setElementProperty(
      _panelRefs.playSceneButton,
      'textContent',
      _sceneActionPending?.type === 'scene'
        ? '… PLAYING SCENE'
        : '▶ PLAY SCENE',
    );
    setElementProperty(
      _panelRefs.playSceneButton,
      'disabled',
      !sceneDirected ||
        !_sceneController?.continueScene ||
        !_sceneContext?.sceneId ||
        !_sceneContext?.shotId ||
        Number(_sceneContext.shotIndex) >=
          Number(_sceneContext.shotCount) - 1 ||
        Boolean(_sceneActionPending),
    );
    setElementAttribute(
      _panelRefs.playSceneButton,
      'aria-label',
      `Continue ${_sceneContext?.sceneTitle || 'current scene'} from next shot`,
    );
    setElementProperty(
      _panelRefs.storyReplayButton,
      'textContent',
      '↺ FULL STORY',
    );
    if (!sceneDirected) {
      setElementProperty(_panelRefs.storyReplayButton, 'disabled', false);
      setElementAttribute(
        _panelRefs.storyReplayButton,
        'aria-label',
        'Replay the full reconstruction',
      );
    }
    const beatIndex = currentEvidenceIndex();
    const sceneBeatIndex = sceneDirected
      ? _evidenceTimeline.findIndex(
          ({ observation: item }) => item.id === _sceneBeatId,
        )
      : beatIndex;
    const observation = _evidenceTimeline[sceneBeatIndex]?.observation || null;
    const sceneShotIndex = Math.max(0, Number(_sceneContext?.shotIndex) || 0);
    const beatCount = sceneDirected
      ? Math.max(0, Number(_sceneContext?.shotCount) || 0)
      : _evidenceTimeline.length;
    const displayIndex = sceneDirected ? sceneShotIndex : beatIndex;
    setElementProperty(
      _panelRefs.beatIndex,
      'textContent',
      `${String(displayIndex + 1).padStart(2, '0')} / ${String(beatCount).padStart(2, '0')}`,
    );
    setElementProperty(
      _panelRefs.beatTitle,
      'textContent',
      sceneDirected
        ? _sceneContext?.shotTitle || 'SCENE SHOT'
        : observation?.shortTitle || observation?.title || 'EVIDENCE',
    );
    const sourceCount = Math.max(
      0,
      Math.floor(Number(observation?.corroboration?.sourceCount) || 0),
    );
    const beatMeta = [
      String(observation?.phase || 'EVIDENCE').toUpperCase(),
      'TIME UNVERIFIED',
      sourceCount > 1 ? `${sourceCount} SOURCES` : '',
      observation?.imageryCoverage === 'outside' ? 'OUTSIDE IMAGERY SWIPE' : '',
    ]
      .filter(Boolean)
      .join(' / ');
    setElementProperty(
      _panelRefs.beatMeta,
      'textContent',
      sceneDirected
        ? `${String(_sceneContext?.sceneTitle || 'NEPAL FLOOD INCIDENT').toUpperCase()} / AUTHORED SHOT`
        : beatMeta,
    );
    setElementProperty(
      _panelRefs.previousButton,
      'disabled',
      Boolean(_sceneActionPending) || displayIndex <= 0,
    );
    setElementProperty(
      _panelRefs.nextButton,
      'disabled',
      Boolean(_sceneActionPending) ||
        beatCount === 0 ||
        displayIndex >= beatCount - 1,
    );
    setElementProperty(
      _panelRefs.playButton,
      'disabled',
      sceneDirected &&
        (!_sceneController?.replayShot ||
          !_sceneContext ||
          Boolean(_sceneActionPending)),
    );
    setElementAttribute(
      _panelRefs.playButton,
      'aria-label',
      sceneDirected
        ? `Play ${_sceneContext?.shotTitle || 'current scene shot'}`
        : 'Play reconstruction',
    );
    setElementAttribute(
      _panelRefs.previousButton,
      'aria-label',
      sceneDirected ? 'Load previous scene shot' : 'Previous story beat',
    );
    setElementAttribute(
      _panelRefs.nextButton,
      'aria-label',
      sceneDirected ? 'Load next scene shot' : 'Next story beat',
    );
    setElementProperty(
      _panelRefs.openSourceButton,
      'disabled',
      !observation?.media?.sourceUrl,
    );
    syncCinematicButton();
    setElementProperty(
      _panelRefs.splitInput,
      'value',
      String(Math.round(_split * 100)),
    );
    const beforePercent = Math.round(_split * 100);
    setElementProperty(
      _panelRefs.splitReadout,
      'textContent',
      `${beforePercent} / ${100 - beforePercent}`,
    );
  }

  function syncPresentationMode() {
    const sceneDirected = _presentation === BHOTE_KOSHI_SCENE_PRESENTATION;
    const imageryAvailable =
      !sceneDirected || _sceneControls.imageryComparison === true;
    const scrubberAvailable =
      !sceneDirected || Boolean(_sceneController?.seekScene);
    const knownSceneBeat =
      !sceneDirected ||
      _evidenceTimeline.some(
        ({ observation }) => observation.id === _sceneBeatId,
      );
    const evidenceAvailable =
      !sceneDirected ||
      (_sceneSurface === BHOTE_KOSHI_SCENE_EVIDENCE_BEAT && knownSceneBeat);
    _panel?.classList?.toggle('bhote-event-scene-beat', sceneDirected);
    if (_panelRefs?.playSceneButton)
      _panelRefs.playSceneButton.hidden = !sceneDirected;
    if (_panelRefs?.imagerySection)
      _panelRefs.imagerySection.hidden = !imageryAvailable;
    if (_panelRefs?.observedStatus)
      _panelRefs.observedStatus.hidden = !imageryAvailable;
    if (_panelRefs?.progressInput)
      _panelRefs.progressInput.hidden = !scrubberAvailable;
    _splitControl?.setVisible(imageryAvailable);
    if (_beforeLayer) _beforeLayer.show = imageryAvailable;
    if (_afterLayer) _afterLayer.show = imageryAvailable;
    if (_panelRefs?.caveat) {
      _panelRefs.caveat.textContent = imageryAvailable
        ? _event?.reconstruction?.caveat || ''
        : 'SCHEMATIC CORRIDOR, NOT MODELED ARRIVAL TIME.';
    }
    if (_panelRefs?.imageryCloudNote)
      _panelRefs.imageryCloudNote.hidden = !imageryAvailable;
    for (const [button, control, sceneDefault] of [
      [_panelRefs?.cinematicButton, 'cinematic'],
      [_panelRefs?.storyReplayButton, 'storyReplay'],
      [_panelRefs?.corridorButton, 'corridor', true],
    ]) {
      if (!button) continue;
      const available =
        !sceneDirected ||
        sceneDefault === true ||
        _sceneControls[control] === true;
      button.hidden = !available;
      if (!available) button.disabled = true;
    }
    if (_panelRefs?.openSourceButton)
      _panelRefs.openSourceButton.hidden = !evidenceAvailable;
    overlayHost.setVisible(BHOTE_KOSHI_OVERLAY_SOURCE_ID, evidenceAvailable);
  }

  function updateFloodTrace(progress) {
    if (!_floodHalo || !_floodCore) return;
    if (
      _presentation === BHOTE_KOSHI_SCENE_PRESENTATION &&
      _sceneSurface !== BHOTE_KOSHI_SCENE_EVIDENCE_BEAT
    ) {
      _floodHalo.show = false;
      _floodCore.show = false;
      return;
    }
    if (
      !updateCorridorPositionCache(
        progress,
        activeFloodPositions(),
        _corridorPositionCache,
      )
    )
      return;
    const positions = _corridorPositionCache.positions;
    _floodHalo.show = positions.length > 1;
    _floodCore.show = positions.length > 1;
  }

  function updateSurgeFront(progress) {
    if (!_surgePoint) return;
    if (
      _presentation === BHOTE_KOSHI_SCENE_PRESENTATION &&
      _sceneSurface !== BHOTE_KOSHI_SCENE_EVIDENCE_BEAT
    ) {
      _surgePoint.show = false;
      return;
    }
    const headPosition = _corridorPositionCache.headPosition;
    if (
      headPosition &&
      !Cesium.Cartesian3.equals(_lastSurgePosition, headPosition)
    ) {
      _surgePoint.position = headPosition;
      _lastSurgePosition = Cesium.Cartesian3.clone(
        headPosition,
        _lastSurgePosition || new Cesium.Cartesian3(),
      );
    }
    const visible =
      Boolean(headPosition) &&
      progress > 0 &&
      (sceneUsesSourcePath() ||
        sceneUsesPathHistory() ||
        sceneKeepsFloodVisible() ||
        progress < 1);
    if (_lastSurgeVisible !== visible) {
      _surgePoint.show = visible;
      _lastSurgeVisible = visible;
    }
  }

  function updateProgress(progress) {
    _witnessEmbedActive = false;
    _progress = clampUnit(progress);
    const sourceWindow = sceneUsesSourcePath()
      ? scenePathProgressWindow()
      : null;
    const floodProgress =
      scenePathMovesDuringCamera() || sceneUsesPathHistory()
        ? _scenePathRevealProgress
        : sourceWindow
          ? sourceWindow.start +
            (sourceWindow.target - sourceWindow.start) * _sceneRevealProgress
          : _presentation === BHOTE_KOSHI_SCENE_PRESENTATION &&
              _sceneControls.evidencePath === 'none'
            ? 0
            : floodProgressForStoryProgress(
                _progress,
                _event?.reconstruction?.storyFloodWindow,
              ) *
              (sceneEvidenceDefersUntilCameraSettles() &&
              !sceneEvidenceSequenceAnimates()
                ? _sceneRevealProgress
                : 1);
    updateFloodTrace(floodProgress);
    updateSurgeFront(floodProgress);
    applyCinematicCamera();
    syncEvidenceMedia();
    syncPanel();
    renderHost.request('bhote-koshi-progress');
  }

  function setSplit(split) {
    _split = clampUnit(split);
    _splitControl?.setValue(_split);
    syncPanel();
    renderHost.request('bhote-koshi-split');
  }

  function stopPlayback() {
    if (!_playing) return;
    _playing = false;
    if (_animationFrame != null) cancelAnimationFrame(_animationFrame);
    _animationFrame = null;
    renderHost.release(FLOOD_RENDER_HOLD);
    syncEvidenceMedia();
    syncPanel();
  }

  function animationTick(timestamp) {
    if (!_playing) return;
    const elapsed = (timestamp - _playStartedAt) / 1000;
    const next = _playStartProgress + elapsed / BHOTE_KOSHI_PLAYBACK_SECONDS;
    updateProgress(next);
    if (next >= 1) {
      stopPlayback();
      stopCinematic({ preserveReplay: true });
      return;
    }
    _animationFrame = requestAnimationFrame(animationTick);
  }

  function startPlayback() {
    if (_playing) return;
    if (_progress >= 1) updateProgress(0);
    _playing = true;
    _playStartProgress = _progress;
    _playStartedAt = performance.now();
    renderHost.hold(FLOOD_RENDER_HOLD);
    syncEvidenceMedia();
    syncPanel();
    _animationFrame = requestAnimationFrame(animationTick);
  }

  function togglePlayback() {
    invalidateIntroAutostart();
    if (_playing) {
      stopPlayback();
      return;
    }
    if (_progress >= 1 && _cinematicReplayArmed) {
      startCinematic();
      return;
    }
    startPlayback();
  }

  function focusCorridor() {
    if (!_event) return;
    invalidateIntroAutostart();
    stopCinematic();
    _witnessEmbedActive = false;
    _embeddedEvidenceIndex = -1;
    _embeddedMedia?.hide?.();
    setSplit(0.5);
    focusView(_viewer, _event.viewpoints.corridor);
  }

  function removeImagery() {
    if (_beforeLayer) _imageryLayerCollection?.remove(_beforeLayer, true);
    if (_afterLayer) _imageryLayerCollection?.remove(_afterLayer, true);
    _beforeLayer = null;
    _afterLayer = null;
    _imageryLayerCollection = null;
  }

  async function init(viewer) {
    _viewer = viewer;
    _embeddedMedia = embeddedMediaFactory({ viewer });
    await loadEvent();
    console.log('[Data:BhoteKoshi] Event pack ready');
    return true;
  }

  async function enable(viewer, { origin = 'local-restore', signal } = {}) {
    _viewer = viewer;
    _enabled = true;
    // Public lifecycle passes signal, not intent origin, to enable. Its atomic
    // restore has already applied the scene parameters; those own presentation.
    // A missing origin is passive, never authority to focus or start playback.
    const sceneDirected = _presentation === BHOTE_KOSHI_SCENE_PRESENTATION;
    try {
      const event = await loadEvent();
      throwIfEnableCancelled(signal, _enabled);
      registerDynamicCredit(viewer, BHOTE_KOSHI_CREDIT);
      if (_mapStackController) {
        _comparisonLease = acquireImageryComparison(_mapStackController, {
          owner: BHOTE_KOSHI_LAYER_ID,
          switchPolicy: sceneDirected ? 'preserve' : 'esri',
        });
        await _comparisonLease.ready;
      }
      throwIfEnableCancelled(signal, _enabled);
      await createImagery(event);
      throwIfEnableCancelled(signal, _enabled);
      await syncTerrainComparison();
      throwIfEnableCancelled(signal, _enabled);
      createFloodDataSource();
      createSplitControl(event);
      const panelView = createPanel(event, {
        close: () =>
          _dataManager?.setEnabled(BHOTE_KOSHI_LAYER_ID, false, {
            origin: 'user',
          }),
        play: handlePlay,
        playScene: playWholeScene,
        toggleCinematic,
        previousBeat: handlePrevious,
        nextBeat: handleNext,
        replayCinematic: handleStoryReplay,
        openActiveSource: openActiveEvidenceSource,
        openGeolocationMap,
        previewProgress,
        commitProgress,
        setSplit,
        focusCorridor,
      });
      _panel = panelView.panel;
      _panelRefs = panelView.refs;
      syncPresentationMode();
      overlayHost.setVisible(
        BHOTE_KOSHI_OVERLAY_SOURCE_ID,
        !sceneDirected || _sceneSurface === BHOTE_KOSHI_SCENE_EVIDENCE_BEAT,
      );
      await prepareEventTerrain(event, signal);
      throwIfEnableCancelled(signal, _enabled);
      attachCameraInputRelease();
      attachEvidenceCardActivation();
      updateProgress(_progress);
      setSplit(_split);
      if (scenePathMovesDuringCamera()) startScenePathReveal();
      if (sceneEvidenceSequenceAnimates() && sceneEvidenceCameraSettled()) {
        startSceneEvidenceReveal();
      }
      if (!sceneDirected && !PASSIVE_ENABLE_ORIGINS.has(origin))
        focusCorridor();
      if (
        !sceneDirected &&
        (origin === 'scene' || !PASSIVE_ENABLE_ORIGINS.has(origin))
      ) {
        const introGeneration = ++_introGeneration;
        _introTimer = window.setTimeout(() => {
          if (introGeneration !== _introGeneration) return;
          _introTimer = null;
          if (!_enabled || _playing || _progress !== 0) return;
          if (origin === 'scene') startCinematic();
          else startPlayback();
        }, 2400);
      }
      return true;
    } catch (error) {
      try {
        await disable();
      } catch (cleanupError) {
        console.warn(
          '[Data:BhoteKoshi] Failed-enable cleanup error:',
          cleanupError,
        );
      }
      throw error;
    }
  }

  async function disable() {
    setSceneMediaPlayback();
    _enabled = false;
    ++_comparisonSurfaceGeneration;
    _mapStackController?.clearTerrainComparison?.();
    invalidateIntroAutostart();
    stopPlayback();
    stopCinematic();
    stopSceneEvidenceReveal();
    stopScenePathReveal();
    stopSceneMediaPlayback();
    detachCameraInputRelease();
    detachEvidenceCardActivation();
    _mediaAbortController?.abort();
    _mediaAbortController = null;
    _mediaGeneration += 1;
    releaseEvidenceVideo({ restorePoster: false });
    _embeddedMedia?.hide?.();
    _embeddedEvidenceIndex = -1;
    _sceneMediaPlaybackCompletedBeatId = null;
    _witnessEmbedActive = false;
    overlayHost.clearSource(BHOTE_KOSHI_OVERLAY_SOURCE_ID);
    overlayHost.setVisible(BHOTE_KOSHI_OVERLAY_SOURCE_ID, false);
    removeImagery();
    _terrainPositions = [];
    _sourceShotPaths.clear();
    _scenePathPositionCache.clear();
    _scenePathPositions = [];
    _scenePathBeatId = null;
    _scenePathStartProgress = 0;
    _scenePathRevealProgress = 0;
    _corridorPositionCache = { visibleCount: -1, positions: [] };
    _evidenceTimeline = [];
    _evidenceAnchors = [];
    _cinematicKeyframes = [];
    for (const slot of _evidenceFrameSlots) {
      closeFrame(slot.frame);
      closeFrame(slot.poster);
    }
    _evidenceFrameSlots = [];
    if (_floodDataSource) _viewer.dataSources.remove(_floodDataSource, true);
    _floodDataSource = null;
    _floodSurfaceMode = null;
    _floodHalo = null;
    _floodCore = null;
    _surgePoint = null;
    _lastSurgePosition = null;
    _lastSurgeVisible = null;
    _panel?.remove();
    document
      .getElementById?.('right-context-rail')
      ?.classList.remove('bhote-event-active');
    _panel = null;
    _panelRefs = null;
    _splitControl?.destroy();
    _splitControl = null;
    _progress = 0;
    _split = 0.5;
    _presentation = 'standalone';
    _sceneBeatId = null;
    _sceneBeatReveal = 0.36;
    _sceneContext = null;
    _sceneSurface = BHOTE_KOSHI_SCENE_PANEL_ONLY;
    _sceneControls = {};
    _sceneRevealProgress = 1;
    _sceneActionPending = false;
    _sceneScrubProgress = null;
    _sceneSeekGeneration += 1;
    if (_sceneSeekFrame != null) {
      const cancel = globalThis.cancelAnimationFrame || globalThis.clearTimeout;
      cancel?.(_sceneSeekFrame);
      _sceneSeekFrame = null;
    }
    const comparisonLease = _comparisonLease;
    _comparisonLease = null;
    try {
      await comparisonLease?.release();
    } finally {
      renderHost.request('bhote-koshi-disable');
    }
    return true;
  }

  async function destroy() {
    await disable();
    _sceneClockUnsubscribe?.();
    _sceneClockUnsubscribe = null;
    _embeddedMedia?.destroy?.();
    _embeddedMedia = null;
    _event = null;
    _viewer = null;
  }

  /**
   * Apply a deterministic event beat without taking camera ownership from a
   * Scene shot. SceneDirector remains the sole camera writer while this layer
   * updates only the panel and event surfaces explicitly owned by that shot.
   */
  function setParams(params = {}, { origin = 'programmatic' } = {}) {
    const previousBeatId = _sceneBeatId;
    const previouslyDeferred = sceneEvidenceDefersUntilCameraSettles();
    const cameraWasSettled = sceneEvidenceCameraSettled();
    const previousPathDuringCamera = scenePathMovesDuringCamera();
    const previousTravelId = _sceneControls.cameraTravel?.id;
    const previousTravelActive = _sceneControls.cameraTravel?.active === true;
    const previousTravelCompleted =
      _sceneControls.cameraTravel?.completed === true;
    const previousTravelCancelled =
      _sceneControls.cameraTravel?.cancelled === true;
    if (params.presentation === BHOTE_KOSHI_SCENE_PRESENTATION) {
      _presentation = BHOTE_KOSHI_SCENE_PRESENTATION;
      _sceneSurface =
        params.sceneSurface === BHOTE_KOSHI_SCENE_EVIDENCE_BEAT
          ? BHOTE_KOSHI_SCENE_EVIDENCE_BEAT
          : BHOTE_KOSHI_SCENE_PANEL_ONLY;
      _sceneControls =
        params.sceneControls && typeof params.sceneControls === 'object'
          ? { ...params.sceneControls }
          : {};
    } else if (params.presentation === 'standalone') {
      _presentation = 'standalone';
      _sceneContext = null;
      _sceneSurface = BHOTE_KOSHI_SCENE_PANEL_ONLY;
      _sceneControls = {};
    }
    if (params.sceneContext && typeof params.sceneContext === 'object') {
      _sceneContext = { ...params.sceneContext };
      if (params.sceneContext.seeking !== true && !_sceneActionPending) {
        _sceneScrubProgress = null;
      }
    }
    if (typeof params.beatId === 'string' && params.beatId.trim()) {
      _sceneBeatId = params.beatId.trim();
      _sceneBeatReveal = Number.isFinite(Number(params.beatReveal))
        ? clampUnit(params.beatReveal)
        : 0.36;
    } else if (Object.hasOwn(params, 'progress')) {
      _sceneBeatId = null;
    }
    const sceneDirected = _presentation === BHOTE_KOSHI_SCENE_PRESENTATION;
    if (sceneDirected) {
      _presentation = BHOTE_KOSHI_SCENE_PRESENTATION;
      invalidateIntroAutostart();
      stopPlayback();
      stopCinematic();
    }

    const nowDeferred = sceneEvidenceDefersUntilCameraSettles();
    const cameraIsSettled = sceneEvidenceCameraSettled();
    const beatChanged = previousBeatId !== _sceneBeatId;
    const travelId = _sceneControls.cameraTravel?.id;
    const travelActive = _sceneControls.cameraTravel?.active === true;
    const travelChanged =
      previousTravelId !== travelId ||
      previousTravelActive !== travelActive ||
      previousTravelCompleted !==
        (_sceneControls.cameraTravel?.completed === true) ||
      previousTravelCancelled !==
        (_sceneControls.cameraTravel?.cancelled === true);
    if (beatChanged || !cameraIsSettled || !sceneEvidenceMediaAutoplays()) {
      stopSceneMediaPlayback();
      _sceneMediaPlaybackCompletedBeatId = null;
    }
    if (!nowDeferred) {
      stopSceneEvidenceReveal();
      _sceneRevealProgress = 1;
    } else if (!cameraIsSettled || beatChanged || !previouslyDeferred) {
      stopSceneEvidenceReveal();
      _sceneRevealProgress = 0;
    }

    const sequenceWindow = sceneEvidenceSequenceAnimates()
      ? evidenceSequenceWindow(_sceneBeatId, _evidenceTimeline)
      : null;
    const beatProgress =
      sequenceWindow?.startProgress ??
      evidenceBeatProgress(_sceneBeatId, _evidenceTimeline, _sceneBeatReveal);
    const hasProgress =
      beatProgress != null || Number.isFinite(Number(params.progress));
    const hasSplit = Number.isFinite(Number(params.split));
    if (hasProgress) _progress = beatProgress ?? clampUnit(params.progress);
    if (hasSplit) _split = clampUnit(params.split);

    if (_enabled) {
      if (beatChanged || travelChanged || !scenePathMovesDuringCamera()) {
        stopScenePathReveal();
      }
      void syncTerrainComparison().catch((error) => {
        console.warn(
          '[Data:BhoteKoshi] Comparison surface unavailable:',
          error,
        );
      });
      syncFloodSurfaceMode();
      syncPresentationMode();
      prepareScenePath();
      const timelineSeekActive = applySceneTimelineSeek();
      const pathWindow =
        scenePathMovesDuringCamera() || sceneUsesPathHistory()
          ? scenePathProgressWindow()
          : null;
      if (timelineSeekActive) {
        // applySceneTimelineSeek reconstructed the exact authored phase.
      } else if (sceneUsesPathHistory()) {
        _scenePathRevealProgress = 1;
      } else if (
        pathWindow &&
        (beatChanged || travelChanged || !previousPathDuringCamera)
      ) {
        if (_sceneControls.cameraTravel?.completed) {
          _scenePathRevealProgress = pathWindow.target;
        } else if (!_sceneControls.cameraTravel?.cancelled) {
          _scenePathRevealProgress = pathWindow.start;
        }
      }
      if (hasProgress) updateProgress(_progress);
      if (hasSplit) setSplit(_split);
      if (
        !timelineSeekActive &&
        scenePathMovesDuringCamera() &&
        travelActive &&
        (beatChanged || travelChanged || !previousPathDuringCamera)
      ) {
        startScenePathReveal();
      }
      if (
        !timelineSeekActive &&
        cameraIsSettled &&
        (nowDeferred || sceneEvidenceSequenceAnimates()) &&
        (beatChanged || !previouslyDeferred || !cameraWasSettled)
      ) {
        startSceneEvidenceReveal();
      }
      if (!sceneDirected && params.cinematic === true)
        startCinematic({ play: params.autoPlay !== false });
      else if (!sceneDirected && params.autoPlay === true) startPlayback();
    }
    return true;
  }

  function getParams() {
    return {
      presentation: _presentation,
      ...(_presentation === BHOTE_KOSHI_SCENE_PRESENTATION
        ? {
            sceneSurface: _sceneSurface,
            ...(Object.keys(_sceneControls).length
              ? { sceneControls: { ..._sceneControls } }
              : {}),
          }
        : {}),
      ...(_sceneBeatId
        ? { beatId: _sceneBeatId, beatReveal: _sceneBeatReveal }
        : { progress: _progress }),
      split: _split,
    };
  }

  return {
    id: BHOTE_KOSHI_LAYER_ID,
    name: 'Bhote Koshi Flood',
    // Scene-owned component; retain registration without a standalone menu row.
    showInTogglePanel: false,
    icon: '🌊',
    source: 'Vantor + GeoPera',
    updateInterval: 0,
    init,
    enable,
    disable,
    update: async () => true,
    destroy,
    attachDataManager,
    attachMapStackController,
    attachSceneController,
    setParams,
    getParams,
    getSceneShotMediaHold,
    setSceneMediaPlayback,
    getStats() {
      return {
        count: _enabled ? 1 : 0,
        status: _enabled ? 'nominal' : 'idle',
        source: 'Vantor + GeoPera',
        coverage: _enabled ? 'Rasuwa · 26 Aug 2026' : 'Event reconstruction',
      };
    },
    getPlaybackState() {
      return {
        enabled: _enabled,
        playing: _playing,
        progress: _progress,
        split: _split,
      };
    },
    getCinematicState() {
      const activeIndex = activeEvidenceIndex(_progress, _evidenceTimeline);
      return {
        active: _cinematicActive,
        progress: _progress,
        evidenceId: _evidenceTimeline[activeIndex]?.observation?.id || null,
        mediaReady: _evidenceVideoReady,
        mediaEvidenceId:
          _evidenceTimeline[_evidenceVideoIndex]?.observation?.id || null,
      };
    },
  };
}

const bhoteKoshiEventLayer = createBhoteKoshiEventLayer();
export default bhoteKoshiEventLayer;
