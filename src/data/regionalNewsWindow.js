/** The regional-news freshness window, shared by the servers and the Cockpit. */

/** At most this many articles answer a regional brief. */
export const REGIONAL_NEWS_ROWS = 5;

/**
 * The regional-news freshness window, in hours. The servers ask upstream for
 * this window, drop anything older and report it as `newsWindowHours`; the
 * Cockpit labels its list with it.
 */
export const REGIONAL_NEWS_WINDOW_HOURS = 24;

// A publish time this far ahead of the clock is skew, not a future story.
const REGIONAL_NEWS_CLOCK_SKEW_MS = 15 * 60_000;

/**
 * A served window in hours, or the default when it is missing or out of range.
 * @param {unknown} value
 * @returns {number}
 */
export function regionalNewsWindowHours(value) {
  const hours = Number(value);
  return Number.isInteger(hours) && hours >= 1 && hours <= 168
    ? hours
    : REGIONAL_NEWS_WINDOW_HOURS;
}

/**
 * The Google News search operator asking for the window: `when:1d` for 24 h.
 * @param {number} [hours]
 * @returns {string}
 */
export function googleNewsWindowOperator(hours = REGIONAL_NEWS_WINDOW_HOURS) {
  const span = regionalNewsWindowHours(hours);
  return span % 24 === 0 ? `when:${span / 24}d` : `when:${span}h`;
}

/**
 * The articles published inside the window, newest first, at most `limit`.
 * An article without a parseable publish time is dropped: nothing shows it is
 * recent. One dated more than 15 minutes ahead of `now` is dropped too.
 * @param {Array<{publishedAt?: string|null}>} articles
 * @param {{now?: number, windowHours?: number, limit?: number}} [options]
 * @returns {Array<object>}
 */
export function recentRegionalArticles(
  articles,
  {
    now = Date.now(),
    windowHours = REGIONAL_NEWS_WINDOW_HOURS,
    limit = REGIONAL_NEWS_ROWS,
  } = {},
) {
  const oldest = now - regionalNewsWindowHours(windowHours) * 3_600_000;
  return (Array.isArray(articles) ? articles : [])
    .map((article) => ({ article, at: Date.parse(article?.publishedAt) }))
    .filter(
      ({ at }) =>
        Number.isFinite(at) &&
        at >= oldest &&
        at <= now + REGIONAL_NEWS_CLOCK_SKEW_MS,
    )
    .sort((a, b) => b.at - a.at)
    .slice(0, Math.max(0, limit))
    .map(({ article }) => article);
}
