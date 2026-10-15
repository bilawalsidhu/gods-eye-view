import {
  normalizeCctvEmbedUrl,
  normalizeCctvSourcePageUrl,
} from '../sources/cctvTypes.js';

/**
 * Own one provider player. Create it only while selected and visible; removing
 * the iframe stops playback on collapse, backgrounding, deselection or teardown.
 * A cross-origin iframe load cannot prove that the camera is live, so the UI
 * never promotes this player to a verified stream-health state.
 */
export function createCctvEmbed(container, { documentImpl = document } = {}) {
  let player = null;
  let link = null;
  let currentUrl = '';

  function clear() {
    player?.remove();
    link?.remove();
    player = null;
    link = null;
    currentUrl = '';
  }

  return {
    update(camera, visible) {
      const url =
        camera?.feedType === 'embed'
          ? normalizeCctvEmbedUrl(camera.embedUrl)
          : '';
      if (!visible || !url) {
        clear();
        return;
      }
      if (url !== currentUrl) {
        clear();
        player = documentImpl.createElement('iframe');
        player.className = 'cctv-embed';
        player.title = `${camera.name || 'CCTV'} — public player`;
        player.setAttribute(
          'allow',
          'autoplay; fullscreen; picture-in-picture',
        );
        player.setAttribute('allowfullscreen', '');
        player.setAttribute(
          'sandbox',
          'allow-scripts allow-same-origin allow-presentation allow-popups',
        );
        player.referrerPolicy = 'strict-origin-when-cross-origin';
        player.src = url;
        container.appendChild(player);
        currentUrl = url;
      }
      const sourceUrl = normalizeCctvSourcePageUrl(camera.sourcePageUrl);
      if (sourceUrl) {
        if (!link) {
          link = documentImpl.createElement('a');
          link.className = 'cctv-embed-source';
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          container.appendChild(link);
        }
        link.href = sourceUrl;
        link.textContent = 'Open official camera page ↗';
      } else {
        link?.remove();
        link = null;
      }
    },
    destroy: clear,
  };
}
