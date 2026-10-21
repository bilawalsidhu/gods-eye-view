const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
  'youtu.be',
]);

/** Extract a video ID from a public HTTPS YouTube URL, never a channel or playlist. */
export function youtubeVideoId(url) {
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    /^\/embed\/live_stream\/?$/.test(url.pathname) ||
    !YOUTUBE_HOSTS.has(url.hostname)
  )
    return null;
  let id;
  if (url.hostname === 'youtu.be') {
    id = /^\/([\w-]{11})\/?$/.exec(url.pathname)?.[1];
  } else if (url.pathname === '/watch') {
    if (url.searchParams.getAll('v').length !== 1) return null;
    id = url.searchParams.get('v');
  } else {
    id = /^\/(?:embed|live|shorts)\/([\w-]{11})\/?$/.exec(url.pathname)?.[1];
  }
  return /^[\w-]{11}$/.test(id || '') ? id : null;
}
