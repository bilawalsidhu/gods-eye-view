/**
 * Share-link addresses: a share code travels in the path, `<app>/share/<code>`,
 * where `<app>` is wherever the app is served (the origin's root, or a base
 * path). The same code opens on any copy of the app.
 *
 * Pure: no DOM. Callers pass the addresses they have.
 */

/** The path segment that introduces a share code. */
export const SHARE_PATH_SEGMENT = 'share';

// Any last segment counts as a code here, so a mangled one is refused by the
// decoder (and said so) rather than opening the app at a wrong address.
const SHARE_PATH = new RegExp(`^(.*/)${SHARE_PATH_SEGMENT}/([^/]+)/?$`);

/**
 * The share code and the app's base path for a share-link pathname, or null
 * when the pathname is not a share link. `/share/AQc` gives
 * `{ code: 'AQc', basePath: '/' }`; `/gev/share/AQc` gives basePath `/gev/`.
 */
export function parseSharePath(pathname) {
  if (typeof pathname !== 'string') return null;
  const match = SHARE_PATH.exec(pathname);
  if (!match) return null;
  let code = match[2];
  try {
    code = decodeURIComponent(code);
  } catch {
    // Left as written; the decoder refuses it.
  }
  return { code, basePath: match[1] };
}

/**
 * The app's root address for `href`: the base path of a share link, or the
 * directory of any other page, with no hash. The query is kept.
 */
export function appRootUrl(href) {
  const url = new URL(href);
  url.hash = '';
  const share = parseSharePath(url.pathname);
  url.pathname = share ? share.basePath : new URL('./', url).pathname;
  return url;
}

/**
 * The share link for `code` on the app at `href`. The sender's `?lang` stays
 * behind: the recipient keeps their own language.
 */
export function shareLinkUrl(code, href) {
  const root = appRootUrl(href);
  const url = new URL(`${SHARE_PATH_SEGMENT}/${code}`, root);
  url.search = root.search;
  url.searchParams.delete('lang');
  return url.href;
}
