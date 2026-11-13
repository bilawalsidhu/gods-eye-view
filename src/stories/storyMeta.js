import { msg, t, translateKnown } from '../i18n/index.js';
import { STORY_TAGS } from '../scenes/storyTags.js';

/**
 * What Explore and the Story page show around a story beyond the catalog:
 * topics and region for the feed's chips and filters, the clock and chapter
 * stamps, the legend and the "right now" facts.
 */

export const fmtDur = (ms) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/**
 * Topics, region and searchable places per shipped story. Topics use the
 * AUTHORING tag names (src/scenes/storyTags.js) and follow the layers each
 * scene turns on.
 */
export const META = {
  'gev:bhote-koshi-nepal-scene': {
    topics: ['Floods'],
    region: 'South Asia',
    place: 'Nepal Bhote Koshi river',
  },
  'gev:flights-radar': {
    topics: ['Flights'],
    region: 'Global',
    place: 'Atlantic Europe Japan San Francisco',
  },
  'gev:orbital-watch': {
    topics: ['Space'],
    region: 'Global',
    place: 'Florida Africa Tokyo Paris Atlantic',
  },
  'gev:thermal-threats': {
    topics: ['Earthquakes'],
    region: 'Global',
    place: 'California Japan New Zealand Portugal',
  },
  'gev:city-overload': {
    topics: ['Flights', 'Space', 'Infrastructure'],
    region: 'Global',
    place: 'New York Los Angeles London',
  },
  'gev:omniscience-pullback': {
    topics: ['Flights', 'Space', 'Earthquakes', 'Infrastructure'],
    region: 'Global',
    place: 'Tokyo Japan East Asia South China Sea',
  },
};

export const FILTERS = [
  [
    'region',
    msg('Region'),
    [
      ['Europe', msg('Europe')],
      ['Middle East', msg('Middle East')],
      ['South Asia', msg('South Asia')],
      ['North America', msg('North America')],
      ['East Asia', msg('East Asia')],
      ['Global', msg('Global')],
    ],
  ],
  [
    'length',
    msg('Length'),
    [
      ['short', msg('Under 1 min')],
      ['long', msg('1 min or more')],
    ],
  ],
];

/**
 * A story's topics, region and place: the topics the person picked for it,
 * then the shipped META.
 */
export function metaFor(s) {
  const m = META[s.id] ?? { topics: [], region: 'Global', place: '' };
  const topics = [...new Set([...(s.topics ?? []), ...m.topics])];
  return { ...m, topics };
}

/** The topics the stories carry, in AUTHORING's tag order. */
export function topicsOf(stories) {
  const order = (topic) => {
    const i = STORY_TAGS.indexOf(topic);
    return i < 0 ? STORY_TAGS.length : i;
  };
  return [...new Set(stories.flatMap((s) => metaFor(s).topics))].sort(
    (a, b) => order(a) - order(b),
  );
}

/** The clock overlay: big line and small line. */
export function clockText(s, wallMs, worldMs, chapterIndex) {
  return {
    big: t('Shot {n} of {total}', {
      n: chapterIndex + 1,
      total: s.chapters.length,
    }),
    small: t('GEV scene'),
  };
}

/**
 * A story's own text (title, caption, label, source…) in the page's
 * language. Shipped stories carry English marked with msg(); a scene the
 * person named shows as they named it.
 */
export const storyText = (text) => (text ? translateKnown(text) : '');

/**
 * A chapter's title in the page's language: a scene's shot titles come from
 * the director already in it.
 */
export function chapterTitle(story, c) {
  return c.title ?? t('Shot {n}', { n: c.shot });
}

/** The story's time window as the feed shows it. */
export function windowText() {
  return t('GEV scene');
}

/** Stamp for a chapter or key moment: its place on the scene's clock. */
export function anchorStamp(s, wallMs) {
  return fmtDur(wallMs);
}

/** Legend entries [shape, colour, label]. */
export function layersFor(s) {
  if (s.mock?.legend?.length) return s.mock.legend;
  return (s.tags ?? []).map((tag) => ['dot', '#e8eaed', tag]);
}

/** "Right now" facts per story (prototype nowFacts): [value, label, warn]. */
export function nowFacts(s, worldMs, wallMs = 0) {
  const out = [[String(s.chapters.length), msg('Shots')]];
  if (s.tags?.length) out.push([String(s.tags.length), msg('Layers on')]);
  return out;
}

/** A chapter's stamp in lists: its place on the scene's clock. */
export function chapterStamp(s, c) {
  return fmtDur(c.wallMs);
}
