/** The tags a scene saved to Stories can carry, and their limits. */

// Marks each English key for translation without loading the i18n runtime
// into the scene document validator; the panel shows them through t().
const msg = (text) => text;

/** Tag keys in display order; stored in English on `scene.storyTags`. */
export const STORY_TAGS = Object.freeze([
  msg('Floods'),
  msg('Wildfires'),
  msg('Storms'),
  msg('Earthquakes'),
  msg('Flights'),
  msg('Maritime'),
  msg('Space'),
  msg('Conflict'),
  msg('Infrastructure'),
  msg('Climate'),
]);

/** At most this many tags per scene. */
export const STORY_TAG_LIMIT = 5;

/**
 * Whether `tags` is a valid `storyTags` value: unique keys from STORY_TAGS,
 * at most STORY_TAG_LIMIT of them.
 * @param {unknown} tags
 * @returns {boolean}
 */
export function isStoryTagList(tags) {
  return (
    Array.isArray(tags) &&
    tags.length <= STORY_TAG_LIMIT &&
    new Set(tags).size === tags.length &&
    tags.every((tag) => STORY_TAGS.includes(tag))
  );
}
