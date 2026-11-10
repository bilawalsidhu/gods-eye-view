/** Only a root-relative path on this page may replace the photoreal source. */
export function localTilesetPath(value, location = globalThis.location) {
  if (!value) return null;
  if (
    typeof value !== 'string' ||
    !/^\/(?!\/)/.test(value) ||
    /[\\\s\u0000-\u001f\u007f]/.test(value) ||
    !location?.origin
  )
    throw new TypeError('tilesetUrl must be a path on the page origin');
  const url = new URL(value, location.origin);
  if (url.origin !== location.origin || url.search || url.hash)
    throw new TypeError('tilesetUrl must be a path on the page origin');
  return url.pathname;
}

// Like parkedMs, this explicit QA parameter is inert on an ordinary page.
export function qaTilesetUrl() {
  return localTilesetPath(
    new URLSearchParams(globalThis.location?.search).get('qaTileset'),
  );
}
