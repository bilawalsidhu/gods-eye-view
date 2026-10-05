/** Existing embedded and shared views keep their console entry point. */
export function isConsoleRoute(search = '', hash = '') {
  const params = new URLSearchParams(search);
  return (
    params.get('view') === 'console' ||
    params.get('embed') === '1' ||
    Boolean(hash)
  );
}

export function viewUrl(href, view) {
  const url = new URL(href);
  url.searchParams.delete('embed');
  if (view === 'console') url.searchParams.set('view', 'console');
  else {
    url.searchParams.delete('view');
    url.hash = '';
  }
  return url.href;
}
