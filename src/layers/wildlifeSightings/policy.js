import { msg } from '../../i18n/marker.js';

export const WILDLIFE_UNKNOWN_COLOR = '#9aa7b3';
export const WILDLIFE_ACCENT = '#7bd88f';
export const ICONIC_TINTS = Object.freeze({
  Aves: '#9fa8ff',
  Mammalia: '#e0a96d',
  Reptilia: '#c5d86d',
  Amphibia: '#5fd3bc',
  Actinopterygii: '#6fa8dc',
  Insecta: '#f0b35a',
  Arachnida: '#d98c6a',
  Plantae: WILDLIFE_ACCENT,
  Fungi: '#e8a0a8',
  Animalia: '#b0bec5',
  Unknown: WILDLIFE_UNKNOWN_COLOR,
});

export const ICONIC_LEGEND_ORDER = Object.freeze([
  'Aves',
  'Mammalia',
  'Reptilia',
  'Amphibia',
  'Actinopterygii',
  'Insecta',
  'Arachnida',
  'Plantae',
  'Fungi',
  'Animalia',
  'Unknown',
]);

// Keep badges compact among dense anchors, labels and photo cards.
export const WILDLIFE_SCALE_BY_DISTANCE = Object.freeze([
  1_000, 1.1, 8_000_000, 0.6,
]);
export const WILDLIFE_SPRITE_PX = 20;
export const WILDLIFE_BADGE_MAX_PX =
  WILDLIFE_SPRITE_PX * WILDLIFE_SCALE_BY_DISTANCE[1];

export const WILDLIFE_GRID_HEIGHT_METERS = 400_000;
// Bound billboard population after screen bucketing.
export const WILDLIFE_RENDER_LIMIT = 5_000;
// Bound candidates before the overlay host's final declutter.
export const WILDLIFE_LABEL_LIMIT = 150;
export const WILDLIFE_LABEL_NAME_SEPARATION_PX = 80;
// Hidden ground batches may need several render passes to compile. Retire a
// failed staging batch after a bounded number instead of holding rendering.
export const WILDLIFE_GROUND_READY_MAX_CHECKS = 16;

// Camera-height thresholds use +/-10% hysteresis to keep representations still
// while a camera settles near a boundary.
export const WILDLIFE_HEIGHT_HYSTERESIS = 0.1;
export const WILDLIFE_HEIGHT_BANDS = Object.freeze({
  global: 3_000_000,
  cells: 1_500_000,
  cards: 400_000,
});
export const WILDLIFE_MAX_ROWS = 2_000;
export const WILDLIFE_CARD_LIMIT = 24;
export const WILDLIFE_CARD_MIN_SEP_PX = 112;
export const WILDLIFE_CARD_REGION_COLUMNS = 4;
export const WILDLIFE_CARD_REGION_ROWS = 3;
export const WILDLIFE_PHOTO_CACHE_MAX = 96;

// Static S3 thumbnails do not spend the API quota.
export const WILDLIFE_PHOTO_FETCH = Object.freeze({
  burst: 8,
  intervalMs: 250,
});

export const WILDLIFE_DEBOUNCE_MS = 600;
export { WILDLIFE_MAX_VIEW_DEGREES } from './bounds.js';
export const WILDLIFE_VIEW_PADDING = 0.3;
export const WILDLIFE_RETRY_MIN_MS = 30_000;
export const WILDLIFE_RETRY_MAX_MS = 240_000;
// Cap a Retry-After so one reply can never stall refresh forever. The proxy's
// daily-budget reply waits until the next UTC midnight, so allow one day.
export const WILDLIFE_RETRY_AFTER_MAX_SEC = 86_400;

// Faster polling would reread the proxy's five-minute cache.
export const WILDLIFE_UPDATE_INTERVAL_MS = 5 * 60_000;

export const WILDLIFE_CARD_SCALE_FULL_METERS = 20_000;
export const WILDLIFE_CARD_SCALE_MID_METERS = 120_000;
export const WILDLIFE_CARD_SCALE_END_METERS = 125_000;
// Separate entry and exit thresholds prevent churn during small zooms.
export const WILDLIFE_CARD_SHOW_MAX_METERS = 110_000;
export const WILDLIFE_CARD_HIDE_MAX_METERS = 125_000;
export const WILDLIFE_CARD_FADE_LOW_METERS = 70_000;
export const WILDLIFE_CARD_FADE_HIGH_METERS = 125_000;
export const WILDLIFE_SELECTED_LABEL_MAX_CHARS = 40;
export const WILDLIFE_SELECTED_LABEL_FADE_LOW_METERS = 250_000;
export const WILDLIFE_SELECTED_LABEL_FADE_HIGH_METERS = 400_000;
export const WILDLIFE_CARD_MAX_DISTANCE_METERS = 600_000;
export const WILDLIFE_CARD_ALTITUDE_SCALE = Object.freeze({
  fullEnd: WILDLIFE_CARD_SCALE_FULL_METERS,
  midEnd: WILDLIFE_CARD_SCALE_MID_METERS,
  end: WILDLIFE_CARD_SCALE_END_METERS,
  midValue: 0.9,
  endValue: 0.85,
  smoothToMid: true,
});

export { ACARTIA_GUARD_BOX } from './acartiaTaxa.js';
export const WILDLIFE_CONFIRMED_CHIP_ID = 'quality-confirmed';

export const TAXA_PRESETS = Object.freeze([
  Object.freeze({
    value: 'all',
    id: 'taxa-all',
    label: msg('ALL'),
    title: msg('Show all taxa'),
  }),
  Object.freeze({
    value: 'Aves',
    id: 'taxa-birds',
    label: msg('BIRDS'),
    title: msg('Show only birds'),
  }),
  Object.freeze({
    value: 'Mammalia',
    id: 'taxa-mammals',
    label: msg('MAMMALS'),
    title: msg('Show only mammals'),
  }),
  Object.freeze({
    value: 'whales',
    id: 'taxa-whales',
    label: msg('WHALES'),
    title: msg('Show only whales and dolphins (7 days)'),
  }),
  Object.freeze({
    value: 'Insecta',
    id: 'taxa-insects',
    label: msg('INSECTS'),
    title: msg('Show only insects'),
  }),
  Object.freeze({
    value: 'Plantae',
    id: 'taxa-plants',
    label: msg('PLANTS'),
    title: msg('Show only plants'),
  }),
]);
