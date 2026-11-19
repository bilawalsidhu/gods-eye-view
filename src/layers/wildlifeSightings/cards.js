import { photoCreator } from './photoText.js';
import { getLocale, t, translateKnown } from '../../i18n/index.js';
import { CCTV_THUMBNAIL_STYLE } from '../../overlays/worldOverlayTokens.js';
import { truncateOverlayTitle } from '../../overlays/worldOverlayDraw.js';
import { isOpenPhoto } from './records.js';
import { compareWildlifeIds, wildlifeIconicGroup } from './model.js';
import {
  ICONIC_TINTS,
  WILDLIFE_CARD_LIMIT,
  WILDLIFE_CARD_MIN_SEP_PX,
  WILDLIFE_CARD_REGION_COLUMNS,
  WILDLIFE_CARD_REGION_ROWS,
  WILDLIFE_CARD_ALTITUDE_SCALE,
  WILDLIFE_CARD_FADE_LOW_METERS,
  WILDLIFE_CARD_FADE_HIGH_METERS,
  WILDLIFE_SELECTED_LABEL_FADE_LOW_METERS,
  WILDLIFE_SELECTED_LABEL_FADE_HIGH_METERS,
  WILDLIFE_SELECTED_LABEL_MAX_CHARS,
  WILDLIFE_CARD_MAX_DISTANCE_METERS,
  WILDLIFE_LABEL_LIMIT,
} from './policy.js';

export const WILDLIFE_OVERLAY_SOURCE_ID = 'wildlife-sightings';
export const WILDLIFE_LABEL_SOURCE_ID = 'wildlife-sightings-labels';
export const WILDLIFE_SELECTED_SOURCE_ID = 'wildlife-sightings-selected';
export const WILDLIFE_LABEL_SOURCE_OPTIONS = Object.freeze({
  cohortLimit: WILDLIFE_LABEL_LIMIT,
  collisionCapacity: WILDLIFE_LABEL_LIMIT,
  moving: false,
});
export const WILDLIFE_OVERLAY_SOURCE_OPTIONS = Object.freeze({
  cohortLimit: WILDLIFE_CARD_LIMIT,
  collisionCapacity: WILDLIFE_CARD_LIMIT,
  moving: false,
});
export const WILDLIFE_SELECTED_SOURCE_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});

/** Match cards and labels to the sighting sprite's taxon tint. */
export function wildlifeAccent(iconic) {
  return ICONIC_TINTS[wildlifeIconicGroup(iconic)];
}

/** Importance score for open, non-sensitive iNaturalist photos. Other rows
 * cannot consume a slot, even if an accidental photo field reaches a caller. */
export function ambientScore(row, nowMs) {
  if (row?.obscured || !isOpenPhoto(row?.photo) || !photoCreator(row.photo))
    return -Infinity;
  const nonnegative = (n) => (Number.isFinite(n) ? Math.max(0, n) : 0);
  const time = Number.isFinite(row.observedAt)
    ? row.observedAt
    : Date.parse(row.observedOn);
  const ageH =
    Number.isFinite(time) && Number.isFinite(nowMs)
      ? Math.max(0, (nowMs - time) / 3_600_000)
      : Infinity;
  return (
    (row.quality === 'research' ? 2 : 0) +
    (row.threatened ? 1 : 0) +
    Math.log1p(nonnegative(row.favesCount)) +
    0.5 * Math.log1p(nonnegative(row.identificationAgreements)) +
    2 * 0.5 ** (ageH / 12)
  );
}

/** Named rows without eligible photos rank below eligible photo rows. */
export function wildlifeLabelScore(row, nowMs) {
  const score = ambientScore(row, nowMs);
  return Number.isFinite(score) ? score : -1;
}

/** Visible incumbents own their slots until they leave the view/window. A new
 * random sample or a higher-scoring challenger can only fill a free slot. */
function rankWildlifeAmbientRows(rows, currentIds, nowMs) {
  const incumbent = new Map(currentIds.map((id, index) => [id, index]));
  const scored = rows
    .map((row) => ({
      row,
      score: ambientScore(row, nowMs),
      current: incumbent.get(row.stableId),
    }))
    .filter((item) => Number.isFinite(item.score));
  scored.sort((a, b) => {
    if (a.current !== undefined || b.current !== undefined) {
      if (a.current === undefined) return 1;
      if (b.current === undefined) return -1;
      return a.current - b.current;
    }
    return (
      b.score - a.score || compareWildlifeIds(a.row.stableId, b.row.stableId)
    );
  });
  return scored.map((item) => item.row);
}

/** Spread newly admitted cards over screen regions. Once shown, a card stays
 * even when a pan moves it into another incumbent's region; region quotas only
 * govern free slots, so a camera movement never replaces a visible photo. */
export function selectWildlifeAmbientRows(
  rows,
  currentIds = [],
  nowMs,
  limit = WILDLIFE_CARD_LIMIT,
  { screens = null, width = 0, height = 0 } = {},
) {
  const incumbent = new Set(currentIds);
  const accepted = [];
  const regions = new Set();
  const regionFor = (screen) =>
    `${Math.min(WILDLIFE_CARD_REGION_COLUMNS - 1, Math.floor((screen.x / width) * WILDLIFE_CARD_REGION_COLUMNS))}:${Math.min(WILDLIFE_CARD_REGION_ROWS - 1, Math.floor((screen.y / height) * WILDLIFE_CARD_REGION_ROWS))}`;
  for (const row of rankWildlifeAmbientRows(rows, currentIds, nowMs)) {
    if (accepted.length >= Math.max(0, limit)) break;
    const screen = screens?.get(row.stableId);
    const region = screen && width > 0 && height > 0 ? regionFor(screen) : null;
    if (!incumbent.has(row.stableId)) {
      if (region !== null && regions.has(region)) continue;
      if (
        screen &&
        accepted.some((other) => {
          const prior = screens.get(other.stableId);
          return (
            prior &&
            Math.hypot(prior.x - screen.x, prior.y - screen.y) <
              WILDLIFE_CARD_MIN_SEP_PX
          );
        })
      )
        continue;
    }
    accepted.push(row);
    if (region !== null) regions.add(region);
  }
  return accepted;
}

function nameFor(row) {
  return translateKnown(row.commonName || row.scientificName) || t('SIGHTING');
}

/** Return a trimmed common name, or null for unnamed observations. */
export function wildlifeCommonName(row) {
  const name = row.commonName;
  return typeof name === 'string' && name.trim() ? name.trim() : null;
}

/** Full translated display name, shared by titles and screen-space deduping. */
export function wildlifeDisplayName(row) {
  const commonName = wildlifeCommonName(row);
  const name = commonName ? translateKnown(commonName).trim() : '';
  return name.replace(/\s+/g, ' ').trim().toLocaleUpperCase(getLocale());
}

function compactName(row) {
  return truncateOverlayTitle(
    wildlifeDisplayName(row),
    WILDLIFE_SELECTED_LABEL_MAX_CHARS,
  );
}

/** One-line common names for identified observations. The caller adds the
 * Cartesian anchor after ranking and front-side/screen-space filtering. */
export function buildWildlifeLabelEntry(
  row,
  { select, hasRow, nowMs = Date.now() } = {},
) {
  if (!wildlifeCommonName(row)) return null;
  return {
    id: `wildlife-sightings-label:${row.stableId}`,
    variant: 'label',
    title: compactName(row),
    accent: wildlifeAccent(row.iconic),
    priority: wildlifeLabelScore(row, nowMs),
    collisionGroup: 'ambient-label',
    // The host checks actual card placements, including sticky/fading cards,
    // before spending the remaining space on labels in score order.
    yieldToCollisionGroup: 'ambient-card',
    stateless: true,
    paintLane: 'ambient-label',
    gapPx: 15,
    verticalOnly: true,
    placement: 'above',
    horizonCull: true,
    edgeFade: 'keyhole',
    interactive: false,
    accessibilityLabel: nameFor(row),
    ...selectionAction(row, { select, hasRow }),
  };
}

function selectionAction(row, { select, hasRow } = {}) {
  if (typeof select !== 'function') return {};
  return {
    interactive: true,
    accessibilityLabel: t('Show {name} sighting', { name: nameFor(row) }),
    activate() {
      if (typeof hasRow === 'function' && !hasRow(row.stableId)) return false;
      return select(row.stableId) !== false;
    },
  };
}

/** Build an attributed ambient photo; the runtime supplies the decoded image. */
export function buildWildlifeThumbnailEntry(
  row,
  nowMs,
  { image = null, select, hasRow, selected = false } = {},
) {
  const score = ambientScore(row, nowMs);
  if (!Number.isFinite(score)) return null;
  return {
    id: `sighting:${row.stableId}`,
    variant: 'thumbnail',
    title: nameFor(row),
    image,
    requireImage: true,
    accent: wildlifeAccent(row.iconic),
    interactive: false,
    accessibilityLabel: t('Show {name} sighting', { name: nameFor(row) }),
    collisionGroup: 'ambient-card',
    horizonCull: true,
    edgeFade: 'keyhole',
    verticalOnly: true,
    gapPx: 15,
    thumbnailPadX: CCTV_THUMBNAIL_STYLE.padding,
    thumbnailPadTop: CCTV_THUMBNAIL_STYLE.padding,
    thumbnailPadBottom: CCTV_THUMBNAIL_STYLE.padding,
    thumbnailTitleGap: 2,
    thumbnailTitleHeight: CCTV_THUMBNAIL_STYLE.titleHeight,
    thumbnailTitleChars: CCTV_THUMBNAIL_STYLE.titleChars,
    thumbnailTitleWordBoundary: true,
    thumbnailBackground: CCTV_THUMBNAIL_STYLE.background,
    thumbnailTitleColor: CCTV_THUMBNAIL_STYLE.titleColor,
    thumbnailTitleFont: CCTV_THUMBNAIL_STYLE.titleFont,
    thumbnailLeaderColor: CCTV_THUMBNAIL_STYLE.leader,
    thumbnailRuleColor: CCTV_THUMBNAIL_STYLE.rule,
    thumbnailRuleHeight: CCTV_THUMBNAIL_STYLE.ruleHeight,
    thumbnailRadius: CCTV_THUMBNAIL_STYLE.radius,
    ...selectionAction(row, { select, hasRow }),
    // i18n-ignore: the creator is verbatim feed attribution with a copyright mark
    details: [`© ${photoCreator(row.photo)}`],
    thumbnailFixedWidth: true,
    thumbnailFit: 'contain',
    thumbnailWidth: 96,
    thumbnailHeight: 72,
    priority: selected ? Number.MAX_SAFE_INTEGER : score,
    minAnchorSeparationPx: WILDLIFE_CARD_MIN_SEP_PX,
    maxDistance: WILDLIFE_CARD_MAX_DISTANCE_METERS,
    altitudeScale: WILDLIFE_CARD_ALTITUDE_SCALE,
    altitudeFadeStart: WILDLIFE_CARD_FADE_LOW_METERS,
    altitudeFadeEnd: WILDLIFE_CARD_FADE_HIGH_METERS,
    ...(selected ? { selected: true, paintLane: 'selected' } : {}),
  };
}

/** A bounded selected name uses the host's shared selected card treatment. */
export function buildWildlifeSelectedLabel(row) {
  if (!wildlifeCommonName(row)) return null;
  return {
    id: `wildlife-sightings-label:${row.stableId}`,
    variant: 'label',
    selected: true,
    protected: true,
    yieldToCollisionGroup: 'ambient-card',
    paintLane: 'selected',
    priority: Number.MAX_SAFE_INTEGER,
    title: compactName(row),
    accent: wildlifeAccent(row.iconic),
    gapPx: 15,
    verticalOnly: true,
    placement: 'above',
    horizonCull: true,
    edgeFade: 'keyhole',
    interactive: false,
    accessibilityLabel: nameFor(row),
    altitudeFadeStart: WILDLIFE_SELECTED_LABEL_FADE_LOW_METERS,
    altitudeFadeEnd: WILDLIFE_SELECTED_LABEL_FADE_HIGH_METERS,
  };
}
