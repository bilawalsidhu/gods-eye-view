import { onLocaleChange, t } from '../../i18n/index.js';
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
 * Drag a floating panel by its header, kept inside the window (as the Québec
 * player).
 * @param {HTMLElement} root
 * @param {HTMLElement} header
 */
export function makePanelDraggable(root, header) {
  header.addEventListener('pointerdown', (event) => {
    if (event.target.closest('button')) return;
    const rect = root.getBoundingClientRect();
    const offsetX = event.clientX - rect.left;
    const offsetY = event.clientY - rect.top;
    header.setPointerCapture?.(event.pointerId);
    const view = root.ownerDocument.defaultView;
    const move = (moveEvent) => {
      root.style.left = `${Math.max(0, Math.min(view.innerWidth - root.offsetWidth, moveEvent.clientX - offsetX))}px`;
      root.style.top = `${Math.max(0, Math.min(view.innerHeight - root.offsetHeight, moveEvent.clientY - offsetY))}px`;
      root.style.right = 'auto';
      root.style.bottom = 'auto';
    };
    const stop = () => {
      header.removeEventListener('pointermove', move);
      header.removeEventListener('pointerup', stop);
      header.removeEventListener('pointercancel', stop);
    };
    header.addEventListener('pointermove', move);
    header.addEventListener('pointerup', stop, { once: true });
    header.addEventListener('pointercancel', stop, { once: true });
  });
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
  /** Rewrites the open panel's text in the current language. */
  let reword = null;
  /** Stops listening for language changes; set while the panel is open. */
  let stopLocale = null;

  /**
   * The project's floating video window (the Québec CCTV player,
   * src/ui/quebecCctvOverlay.js): its `qci-` classes, a header that drags it,
   * × and Escape to close, the source's credit, the privacy note and a link
   * to the provider's page.
   */
  function _build(documentRef) {
    const root = documentRef.createElement('section');
    root.className = 'qci-panel iss-live-panel';
    root.setAttribute('role', 'region');
    // Worded again on a language change, without restarting the player.
    const word = [];
    const worded = (apply) => {
      word.push(apply);
      apply();
    };
    worded(() => root.setAttribute('aria-label', t('ISS live video')));

    const header = documentRef.createElement('header');
    header.className = 'qci-header';
    const title = documentRef.createElement('strong');
    title.className = 'iss-live-title';
    const dotMark = documentRef.createElement('span');
    dotMark.className = 'iss-live-dot';
    dotMark.setAttribute('aria-hidden', 'true');
    const titleText = documentRef.createTextNode('');
    worded(() => (titleText.data = t('ISS LIVE · NASA')));
    title.append(dotMark, titleText);
    const close = documentRef.createElement('button');
    close.type = 'button';
    close.textContent = '×';
    worded(() => close.setAttribute('aria-label', t('Close ISS live video')));
    close.addEventListener('click', () => {
      dismissed = true;
      _syncIssLive();
    });
    header.append(title, close);

    const iframe = documentRef.createElement('iframe');
    iframe.className = 'qci-live';
    iframe.src = issLiveEmbedUrl(ISS_LIVE_VIDEO_ID);
    worded(
      () =>
        (iframe.title = t(
          'Live views from the International Space Station (NASA)',
        )),
    );
    iframe.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
    iframe.allowFullscreen = true;
    iframe.referrerPolicy = 'strict-origin-when-cross-origin';
    iframe.loading = 'eager';

    const credit = documentRef.createElement('p');
    credit.className = 'qci-credit';
    credit.textContent = 'NASA · YouTube'; // i18n-ignore: provider names
    const note = documentRef.createElement('p');
    note.className = 'qci-note';
    worded(
      () =>
        (note.textContent = t(
          'Video plays from YouTube, which sees your IP address.',
        )),
    );
    const link = documentRef.createElement('a');
    link.href = issLiveWatchUrl(ISS_LIVE_VIDEO_ID);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    worded(() => (link.textContent = t('Open on YouTube')));
    reword = () => word.forEach((apply) => apply());

    root.append(header, iframe, credit, note, link);
    root.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') close.click();
    });
    makePanelDraggable(root, header);
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
    stopLocale = onLocaleChange(() => reword?.());
  }

  function _removePanel() {
    if (!panel) return;
    panel.remove(); // the player goes with it, so the stream stops
    panel = null;
    reword = null;
    stopLocale?.();
    stopLocale = null;
  }

  /** Drop the panel and forget the selection (layer destroy). */
  function _destroyIssLive() {
    _removePanel();
    dismissed = false;
    lastTracked = null;
  }

  return { _syncIssLive, _destroyIssLive };
}
