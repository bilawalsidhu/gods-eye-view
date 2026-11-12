import { t } from '../../i18n/index.js';
import { ISS_LIVE_VIDEO_ID, ISS_NORAD } from './policy.js';

/**
 * The player address for a YouTube video: the privacy-enhanced host the
 * page's frame-src allows, muted so the browser lets it start on its own.
 * @param {string} videoId
 * @returns {string}
 */
export function issLiveEmbedUrl(videoId) {
  const params = new URLSearchParams({
    autoplay: '1',
    mute: '1',
    playsinline: '1',
    rel: '0',
  });
  return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}?${params}`;
}

/** The video's own page, for the "Open on YouTube" link. */
export function issLiveWatchUrl(videoId) {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
}

/**
 * Whether the live panel shows: the ISS selected (tracked), the layer on, the
 * Cockpit not riding it, and the viewer not having closed it for this pick.
 * @param {{enabled: boolean, trackedNorad: number|null, cockpitHeld: boolean,
 *   dismissed: boolean}} input
 * @returns {boolean}
 */
export function issLiveShouldShow({
  enabled,
  trackedNorad,
  cockpitHeld,
  dismissed,
}) {
  return (
    Boolean(enabled) && trackedNorad === ISS_NORAD && !cockpitHeld && !dismissed
  );
}

/**
 * NASA's live view from the ISS, in a panel beside the existing tracked card
 * while the ISS is selected. The player is created on show and removed on
 * hide, so nothing streams while the panel is closed.
 */
export function createIssLive({ state: layerState, parts }) {
  let panel = null;
  let dismissed = false;
  let lastTracked = null;

  function _build(documentRef) {
    const root = documentRef.createElement('section');
    root.className = 'iss-live-panel';
    root.setAttribute('role', 'region');
    root.setAttribute('aria-label', t('ISS live video'));

    const header = documentRef.createElement('header');
    header.className = 'iss-live-header';
    const title = documentRef.createElement('span');
    title.className = 'iss-live-title';
    const dotMark = documentRef.createElement('span');
    dotMark.className = 'iss-live-dot';
    dotMark.setAttribute('aria-hidden', 'true');
    title.append(dotMark, documentRef.createTextNode(t('ISS LIVE · NASA')));
    const link = documentRef.createElement('a');
    link.className = 'iss-live-link';
    link.href = issLiveWatchUrl(ISS_LIVE_VIDEO_ID);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = t('Open on YouTube');
    const close = documentRef.createElement('button');
    close.type = 'button';
    close.className = 'iss-live-close';
    close.textContent = '×';
    close.title = t('Close ISS live video');
    close.setAttribute('aria-label', t('Close ISS live video'));
    close.addEventListener('click', () => {
      dismissed = true;
      _syncIssLive();
    });
    header.append(title, link, close);

    const frame = documentRef.createElement('div');
    frame.className = 'iss-live-frame';
    const iframe = documentRef.createElement('iframe');
    iframe.src = issLiveEmbedUrl(ISS_LIVE_VIDEO_ID);
    iframe.title = t('Live views from the International Space Station (NASA)');
    iframe.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
    iframe.allowFullscreen = true;
    iframe.referrerPolicy = 'strict-origin-when-cross-origin';
    iframe.loading = 'eager';
    frame.append(iframe);

    root.append(header, frame);
    return root;
  }

  /**
   * Show or hide the panel for the current selection. Cheap when nothing
   * changed, so the tracking and Cockpit paths can call it freely.
   * @returns {void}
   */
  function _syncIssLive() {
    const tracked = layerState._trackedNorad;
    // A new pick of the ISS brings back a panel closed on an earlier one.
    if (tracked !== lastTracked) {
      dismissed = false;
      lastTracked = tracked;
    }
    const show = issLiveShouldShow({
      enabled: layerState._enabled,
      trackedNorad: tracked,
      cockpitHeld: Boolean(parts.cockpit?._cockpitHeld()),
      dismissed,
    });
    if (!show) {
      _removePanel();
      return;
    }
    if (panel) return;
    const documentRef = globalThis.document;
    if (!documentRef?.body) return;
    panel = _build(documentRef);
    documentRef.body.append(panel);
  }

  function _removePanel() {
    if (!panel) return;
    panel.remove(); // the player goes with it, so the stream stops
    panel = null;
  }

  /** Drop the panel and forget the selection (layer destroy). */
  function _destroyIssLive() {
    _removePanel();
    dismissed = false;
    lastTracked = null;
  }

  return { _syncIssLive, _destroyIssLive };
}
