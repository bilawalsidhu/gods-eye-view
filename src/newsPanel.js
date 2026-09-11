/**
 * News dock — a floating panel with a tab strip of broadcast channels and one
 * embedded YouTube live player.
 *
 * Streams use YouTube's `embed/live_stream?channel=` form, which resolves to
 * whatever that channel is broadcasting at view time, so no video ids are
 * pinned here. Channels without a 24/7 feed are marked `eventOnly` and
 * surface as such in the tab title — when they are off-air YouTube shows its
 * own "not available" card inside the frame.
 *
 * Driven by the top-center NEWS button and the `N` hotkey; `window.__gevNews`
 * exposes open/close/toggle for tooling.
 */

export const NEWS_CHANNELS = Object.freeze([
  { id: 'aje', label: 'Al Jazeera', channel: 'UCNye-wNBqNL5ZzHSJj3l8Bg' },
  { id: 'sky', label: 'Sky News', channel: 'UCoMdktPbSTixAyNGwb-UYkQ' },
  { id: 'dw', label: 'DW', channel: 'UCknLrEdhRCp1aegoMqRaCZg' },
  { id: 'f24', label: 'France 24', channel: 'UCQfwfsi5VrQ8yKZ-UWmAEFg' },
  { id: 'trt', label: 'TRT World', channel: 'UC7fWeaHhqgM4Ry-RMpM2YYw' },
  { id: 'euronews', label: 'Euronews', channel: 'UCSrZ3UV4jOidv8ppoVuvW9Q' },
  { id: 'abc', label: 'ABC News', channel: 'UCBi2mrWuNuyYy4gbM6fU18Q' },
  { id: 'cbs', label: 'CBS News', channel: 'UC8p1vwvWtl6T73JiExfWs1g' },
  { id: 'nbc', label: 'NBC News', channel: 'UCeY0bbntWzzVIaj2z3QigXg' },
  { id: 'bloomberg', label: 'Bloomberg', channel: 'UCIALMKvObZNtJ6AmdCLP7Lg' },
  { id: 'livenow', label: 'LiveNOW FOX', channel: 'UCJg9wBPyKMNA5sRDnvzmkdg' },
  { id: 'fox', label: 'Fox News', channel: 'UCXIJgqnII2ZOINSWNOGFThA', eventOnly: true },
  { id: 'cnn', label: 'CNN', channel: 'UCupvZG-5ko_eiXAupbDfxWw' },
  { id: 'reuters', label: 'Reuters', channel: 'UChqUTb7kYRX8-EiaN3XFrSQ', eventOnly: true },
  { id: 'wion', label: 'WION', channel: 'UC_gUM8rL-Lrg6O3adPW9K1g' },
  { id: 'aja', label: 'الجزيرة', channel: 'UCfiwzLy-8yKzIbsmZTzxDgw' },
  { id: 'nasa', label: 'NASA ISS', channel: 'UCLA_DiR1FfKNvjuUpBHmylQ' },
]);

const STORAGE_KEY = 'gev.news.channel';

/** Resolve a channel by id or by a loose name match ("al jazeera", "fox"). */
export function findNewsChannel(query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return null;
  return NEWS_CHANNELS.find((c) => c.id === q)
    || NEWS_CHANNELS.find((c) => c.label.toLowerCase() === q)
    || NEWS_CHANNELS.find((c) => c.label.toLowerCase().includes(q) || q.includes(c.label.toLowerCase()))
    || null;
}

export function embedUrlFor(channel, { autoplay = true, videoId = null } = {}) {
  const common = { autoplay: autoplay ? '1' : '0', mute: '0', rel: '0' };
  if (videoId) return `https://www.youtube.com/embed/${videoId}?${new URLSearchParams(common)}`;
  return `https://www.youtube.com/embed/live_stream?${new URLSearchParams({ channel: channel.channel, ...common })}`;
}

/**
 * Ask the dev server for the channel's current live video id. Multi-stream
 * channels (NBC, ABC, LiveNOW, Fox, CNN) show "Video unavailable" through the
 * channel-form embed; a direct video embed plays. Null on any failure — the
 * caller falls back to the channel form.
 */
async function resolveLiveVideoId(channel) {
  try {
    const res = await fetch(`/api/news/live?channel=${encodeURIComponent(channel.channel)}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.isLive && data.videoId ? data.videoId : null;
  } catch {
    return null;
  }
}

export function initNewsPanel({ root = document.getElementById('news-dock'), toggleButton = document.getElementById('news-toggle') } = {}) {
  if (!root) return null;
  const tabs = root.querySelector('.news-tabs');
  const frame = root.querySelector('iframe');
  const closeBtn = root.querySelector('.news-close');
  const popBtn = root.querySelector('.news-popout');
  let activeId = null;

  for (const c of NEWS_CHANNELS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'news-tab';
    b.dataset.channel = c.id;
    b.textContent = c.label;
    b.title = c.eventOnly ? `${c.label} — event streams only, not 24/7` : `${c.label} live`;
    if (c.eventOnly) b.classList.add('event-only');
    tabs.appendChild(b);
  }

  const render = () => {
    const isOpen = !root.hidden;
    toggleButton?.setAttribute('aria-pressed', isOpen ? 'true' : 'false');
    for (const b of tabs.children) b.classList.toggle('active', b.dataset.channel === activeId);
  };

  let openGeneration = 0;
  async function open(id) {
    const channel = findNewsChannel(id) || findNewsChannel(readStored()) || NEWS_CHANNELS[0];
    const generation = ++openGeneration;
    activeId = channel.id;
    try { localStorage.setItem(STORAGE_KEY, activeId); } catch { /* private mode */ }
    root.hidden = false;
    render();
    tabs.querySelector(`[data-channel="${activeId}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const videoId = await resolveLiveVideoId(channel);
    if (generation !== openGeneration) return { ok: true, channel: channel.id, superseded: true };
    const url = embedUrlFor(channel, { videoId });
    if (frame.src !== url) frame.src = url;
    return { ok: true, channel: channel.id, label: channel.label, videoId, eventOnly: Boolean(channel.eventOnly) };
  }

  function close() {
    root.hidden = true;
    frame.src = 'about:blank'; // stop audio
    render();
    return { ok: true };
  }

  function toggle() {
    return root.hidden ? open(activeId) : close();
  }
  // Tab clicks are fire-and-forget; open() resolves the live id asynchronously.
  for (const b of tabs.children) b.addEventListener('click', () => { void open(b.dataset.channel); });

  closeBtn?.addEventListener('click', close);
  popBtn?.addEventListener('click', () => {
    const c = findNewsChannel(activeId);
    if (c) window.open(`https://www.youtube.com/channel/${c.channel}/live`, '_blank', 'noopener');
  });
  toggleButton?.addEventListener('click', toggle);
  render();

  return { open, close, toggle, isOpen: () => !root.hidden, activeChannel: () => activeId, channels: NEWS_CHANNELS };
}

function readStored() {
  try { return localStorage.getItem(STORAGE_KEY) || ''; } catch { return ''; }
}
