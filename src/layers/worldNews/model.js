import * as Cesium from 'cesium';
import {
  HEADLINE_LABEL_CHARS,
  OVERLAY_COHORT_LIMIT,
  TONE_COLORS,
} from './policy.js';
import { formatAge, toneBand, truncateHeadline } from './records.js';
export * from './records.js';

/**
 * Cesium color for one tone band.
 * @param {string} band 'negative' | 'neutral' | 'positive' | 'unknown'.
 * @returns {Cesium.Color}
 */
export function toneColor(band) {
  return Cesium.Color.fromCssColorString(
    TONE_COLORS[band] || TONE_COLORS.unknown,
  );
}

/**
 * Build the source-owned presentation for one ambient place label.
 * Mirrors createEarthquakeOverlayEntry: busier and fresher places win the
 * collision budget; the story count is part of the title so a single pin
 * never hides how much is happening there.
 * @param {object} input
 * @param {string} input.id Place key shared with the point entity.
 * @param {Cesium.Cartesian3} input.position Ground anchor shared with the point.
 * @param {string} input.place Place named in the headlines.
 * @param {number} input.count Stories at the place.
 * @param {string} input.band Tone band of the place.
 * @param {number|null} input.newestMs Newest publication time, epoch ms.
 * @returns {object}
 */
export function createPlaceOverlayEntry({
  id,
  position,
  place,
  count,
  band,
  newestMs,
}) {
  const stories = Math.max(1, Math.floor(Number(count) || 1));
  const name = truncateHeadline(place || 'Unnamed place', HEADLINE_LABEL_CHARS);
  return {
    id: String(id),
    position,
    variant: 'label',
    title: stories > 1 ? `${name} · ${stories}` : name,
    accent: TONE_COLORS[band] || TONE_COLORS.unknown,
    priority:
      stories * 1000 + (Math.floor((Number(newestMs) || 0) / 60000) % 1000),
    collisionGroup: 'ambient-label',
    paintLane: 'ambient-label',
    interactive: false,
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
    gapPx: 12,
    verticalOnly: true,
    placement: 'above',
  };
}

/** Keep the busiest, freshest places, with stable identity as the tie-break. */
export function selectOverlayCohort(entries, limit = OVERLAY_COHORT_LIMIT) {
  const cap = Math.max(
    0,
    Math.min(OVERLAY_COHORT_LIMIT, Math.floor(Number(limit) || 0)),
  );
  if (!Array.isArray(entries) || cap === 0) return [];
  return entries
    .slice()
    .sort(
      (a, b) =>
        b.priority - a.priority || String(a.id).localeCompare(String(b.id)),
    )
    .slice(0, cap);
}

/**
 * Readout-card model for one story at a place. The card follows the story
 * the operator has paged to, so its tone is the ARTICLE's, not the place's.
 * @param {object} group Place group from aggregatePlaces.
 * @param {number} [storyIndex=0] Story to show; wraps within the group.
 * @param {number} [nowMs=Date.now()] Reference time for the age line.
 * @returns {{title: string, details: string[], accent: string}}
 */
export function buildLabelModel(group, storyIndex = 0, nowMs = Date.now()) {
  const articles = Array.isArray(group?.articles) ? group.articles : [];
  const count = articles.length;
  const index = count
    ? ((Math.floor(Number(storyIndex) || 0) % count) + count) % count
    : 0;
  const article = articles[index] || null;
  const band = toneBand(article?.sentiment);
  const age = Number.isFinite(article?.publishedMs)
    ? formatAge(nowMs - article.publishedMs)
    : '';
  const domain = article?.domain || 'unknown source';
  const place = String(group?.place || 'Unnamed place');
  const url = typeof article?.url === 'string' ? article.url : null;
  return {
    title: String(article?.title || place),
    details: [
      age ? `${domain} · ${age} ago` : domain,
      // The counter invites paging, so it has to say where the control is:
      // clicking the pin again is the nearest one, and the only one visible
      // without the layer panel open.
      count > 1
        ? `${place} · ${index + 1}/${count} stories here · click the pin for the next`
        : place,
      `TONE ${band.toUpperCase()}` +
        (Number.isFinite(article?.sentiment)
          ? ` (${article.sentiment.toFixed(2)})`
          : ''),
      // "Click to open" was unambiguous when the card was the only thing worth
      // clicking; now that the pin pages, each line names its own target.
      url
        ? 'Click this card to open · World News API'
        : 'Source: World News API',
    ],
    accent: TONE_COLORS[band] || TONE_COLORS.unknown,
    // The card is the natural place to click through to the story, but it
    // only accepts clicks when there IS a story to open — otherwise it would
    // swallow a click the globe should have received.
    interactive: Boolean(url),
    url,
    image: typeof article?.image === 'string' ? article.image : null,
  };
}
