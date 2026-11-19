import { h, render as renderVue } from 'vue';
import { fromDegrees } from '../geo/ellipsoid.js';
import { horizonFrom } from '../geo/horizon.js';
import { distance } from '../geo/vector.js';
import {
  canvasOf,
  findCamera,
  findFrame,
  findQuery,
} from '../render/rendererOf.js';
import { t } from '../i18n/index.js';
import QuebecCctvOverlay from './views/panels/QuebecCctvOverlay.vue';

function isQuebecCamera(camera) {
  return String(camera?.sourceKind || '').startsWith('quebec-');
}

function safeSourceUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && !url.username && !url.password
      ? url.href
      : '';
  } catch {
    return '';
  }
}

function safeMediaUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'www.quebec511.info' ||
      url.username ||
      url.password ||
      url.pathname !== '/Carte/Fenetres/camera.ashx' ||
      url.searchParams.get('format') !== 'mp4' ||
      !/^\d+$/.test(url.searchParams.get('id') || '')
    )
      return '';
    return url.href;
  } catch {
    return '';
  }
}

function setMedia(video, url) {
  const current = video.currentSrc || video.src;
  if (current === url) return;
  video.pause();
  video.removeAttribute('src');
  if (!url) {
    video.load();
    return;
  }
  video.src = url;
  video.load();
}

/** Treat an interrupted play() (a pause or a new source) as no failure. */
function onPlayFailure(mark) {
  return (error) => {
    if (error?.name !== 'AbortError') mark();
  };
}

/**
 * Québec 511 serves a new clip at the same URL every few minutes, so a refresh
 * adds a timestamp to get past the browser's media cache.
 */
function mediaRefreshUrl(value) {
  const url = new URL(value);
  url.searchParams.set('_', String(Date.now()));
  return url.href;
}

/**
 * Attach the active Québec source to a floating browser player and map
 * preview. The browser contacts Québec 511 only after the viewer presses Play
 * for that camera; selecting it (by click, auto-hop, a scene or voice) only
 * shows its details and the play control. The panel and marker are the
 * `QuebecCctvOverlay` view, rendered synchronously on each change.
 */
export function createQuebecCctvOverlay(viewer) {
  if (!viewer || typeof document === 'undefined') return null;

  const controller = new AbortController();
  const { signal } = controller;
  // What the view renders. The owner writes it where it used to write the
  // elements, then paints; the view never binds the media sources, the
  // panel's dragged position or the marker's per-frame visibility and place.
  const view = {
    panelHidden: true,
    title: '',
    coordinates: '',
    credit: '',
    creditHidden: false,
    liveHidden: false,
    actionsHidden: false,
    playHidden: false,
    refreshHidden: false,
    note: '',
    noteHidden: false,
    sourceHref: null,
    sourceHidden: false,
    markerLinkOnly: false,
    stillHidden: false,
    markerLabel: '',
  };
  const host = document.createElement('div');
  let disposed = false;
  const handlers = {
    onClose: closeWindow,
    onPlay: startPlayback,
    onRefresh: refreshStill,
    onKeydown(event) {
      if (event.key === 'Escape') close.click();
    },
    onHeaderPointerdown: startDrag,
    onLiveError: markLiveUnavailable,
    onLiveLoadeddata() {
      liveUnavailable = false;
      view.note = t(
        'The map still uses a separate request and may show a different moment.',
      );
      view.noteHidden = false;
      paint();
    },
    onStillError: markStillUnavailable,
    onStillLoadeddata() {
      stillUnavailable = false;
      if (selected)
        view.markerLabel = markerLabelText(selected, Boolean(selectedMediaUrl));
      paint();
      still.pause();
    },
  };
  /** Render the view now: the panel and marker go to the end of the body. */
  function paint() {
    if (disposed) return null;
    const vnode = h(QuebecCctvOverlay, { view: { ...view }, ...handlers });
    renderVue(vnode, host);
    return vnode.component.exposed;
  }
  const elements = paint();
  const panel = elements.panel.value;
  const header = elements.header.value;
  const close = elements.close.value.$el;
  const live = elements.live.value;
  const marker = elements.marker.value;
  const still = elements.still.value;

  let selected = null;
  let selectedPosition = null;
  let closedWindowCameraId = null;
  let selectedMediaUrl = '';
  /** Camera id the viewer pressed Play for; media loads only for this one. */
  let playingCameraId = null;
  let mediaRefreshTimer = 0;
  let removeRender = null;
  let canvasRect = null;
  let liveUnavailable = false;
  let stillUnavailable = false;

  function markerLabelText(camera, hasMedia) {
    return hasMedia
      ? `${t('PREVIEW')} · ${camera.positionSource || camera.name}`
      : Number.isFinite(camera.accuracyM) && camera.accuracyM > 0
        ? `${camera.name} · ±${Math.round(camera.accuracyM)} m`
        : camera.name;
  }

  function markLiveUnavailable() {
    liveUnavailable = true;
    view.note = t('Source unavailable');
    view.noteHidden = false;
    paint();
  }

  function markStillUnavailable() {
    stillUnavailable = true;
    view.markerLabel = t('Source unavailable');
    paint();
  }

  function startRender() {
    if (!removeRender)
      removeRender =
        findFrame(viewer)?.on('postRender', () => updateMarker()) ?? null;
  }

  function stopRender() {
    removeRender?.();
    removeRender = null;
  }

  function stopMediaRefresh() {
    window.clearInterval(mediaRefreshTimer);
    mediaRefreshTimer = 0;
  }

  function startMediaRefresh() {
    stopMediaRefresh();
    if (!selectedMediaUrl) return;
    mediaRefreshTimer = window.setInterval(
      () => {
        if (document.hidden || closedWindowCameraId === selected?.id) return;
        setMedia(live, mediaRefreshUrl(selectedMediaUrl));
        void live.play().catch(onPlayFailure(markLiveUnavailable));
        refreshStill();
      },
      2 * 60 * 1000,
    );
  }

  function refreshStill() {
    if (!selectedMediaUrl || playingCameraId !== selected?.id) return;
    setMedia(still, '');
    setMedia(still, mediaRefreshUrl(selectedMediaUrl));
    void still.play().catch(onPlayFailure(markStillUnavailable));
  }

  /** Load and play the selected camera's media: only from a Play click. */
  function startPlayback() {
    if (!selected || !selectedMediaUrl) return;
    playingCameraId = selected.id;
    liveUnavailable = false;
    stillUnavailable = false;
    view.playHidden = true;
    view.refreshHidden = false;
    view.liveHidden = false;
    view.stillHidden = false;
    view.markerLinkOnly = false;
    view.note = t(
      'The map still uses a separate request and may show a different moment.',
    );
    view.noteHidden = false;
    view.markerLabel = markerLabelText(selected, true);
    paint();
    setMedia(live, selectedMediaUrl);
    setMedia(still, selectedMediaUrl);
    void live.play().catch(onPlayFailure(markLiveUnavailable));
    void still.play().catch(onPlayFailure(markStillUnavailable));
    startMediaRefresh();
  }

  function setCamera(camera, { reselected = false } = {}) {
    if (!isQuebecCamera(camera)) {
      selected = null;
      selectedPosition = null;
      closedWindowCameraId = null;
      selectedMediaUrl = '';
      playingCameraId = null;
      liveUnavailable = false;
      stillUnavailable = false;
      stopMediaRefresh();
      stopRender();
      view.panelHidden = true;
      paint();
      marker.hidden = true;
      setMedia(live, '');
      setMedia(still, '');
      return;
    }

    const changed = selected?.id !== camera.id;
    if (changed || reselected) closedWindowCameraId = null;
    selected = camera;
    startRender();
    selectedPosition = fromDegrees(
      Number(camera.lon),
      Number(camera.lat),
      Number(camera.elevationM) || 10,
    );
    if (closedWindowCameraId === camera.id && !reselected) {
      view.panelHidden = true;
      paint();
      updateMarker();
      return;
    }

    const mediaUrl = safeMediaUrl(camera.browserMediaUrl);
    const sourceUrl = safeSourceUrl(camera.sourceUrl);
    if (changed || mediaUrl !== selectedMediaUrl) {
      liveUnavailable = false;
      stillUnavailable = false;
      playingCameraId = null;
    }
    const playing = Boolean(mediaUrl) && playingCameraId === camera.id;
    view.title = camera.name || t('CCTV camera');
    view.coordinates = [
      `${Number(camera.lat).toFixed(5)}, ${Number(camera.lon).toFixed(5)}`,
      Number.isFinite(camera.accuracyM) && camera.accuracyM > 0
        ? `±${Math.round(camera.accuracyM)} m`
        : '',
      camera.positionSource || '',
    ]
      .filter(Boolean)
      .join(' · ');
    view.credit = camera.credit || camera.provider || '';
    view.creditHidden = !view.credit;
    view.liveHidden = !playing;
    view.playHidden = !mediaUrl || playing;
    view.refreshHidden = !playing;
    view.actionsHidden = !mediaUrl;
    view.note = mediaUrl
      ? !playing
        ? t('Video plays from Québec 511, which sees your IP address.')
        : liveUnavailable
          ? t('Source unavailable')
          : t(
              'The map still uses a separate request and may show a different moment.',
            )
      : sourceUrl
        ? ''
        : t('Source unavailable');
    view.noteHidden = !view.note;
    view.sourceHref = sourceUrl || '#';
    view.sourceHidden = !sourceUrl;
    view.markerLabel = stillUnavailable
      ? t('Source unavailable')
      : markerLabelText(camera, playing);
    view.markerLinkOnly = !playing;
    view.stillHidden = !playing;
    view.panelHidden = false;
    paint();

    if (changed || mediaUrl !== selectedMediaUrl) {
      selectedMediaUrl = mediaUrl;
      // A new camera never inherits playback: the browser stays off 511
      // until the viewer presses Play for it.
      stopMediaRefresh();
      setMedia(live, '');
      setMedia(still, '');
    } else if (reselected && playing) {
      if (live.error || live.networkState === 3 || live.readyState < 2) {
        setMedia(live, mediaRefreshUrl(mediaUrl));
      }
      if (live.paused)
        void live.play().catch(onPlayFailure(markLiveUnavailable));
      startMediaRefresh();
      if (still.error || still.networkState === 3 || still.readyState < 2)
        refreshStill();
    }
    updateMarker();
  }

  function updateMarker() {
    if (!selected || !selectedPosition) {
      marker.hidden = true;
      return;
    }
    const canvas = canvasOf(viewer);
    const eye = findCamera(viewer)?.pose().position;
    const point = findQuery(viewer)?.project(selectedPosition) ?? null;
    const visible =
      point &&
      canvas &&
      eye &&
      horizonFrom(eye).isPointVisible(selectedPosition) &&
      point.x >= 0 &&
      point.y >= 0 &&
      point.x <= canvas.clientWidth &&
      point.y <= canvas.clientHeight;
    marker.hidden = !visible;
    if (!visible) return;
    // Measured once per resize or scroll, not every frame, so the per-frame
    // style writes never force a layout.
    canvasRect ||= canvas.getBoundingClientRect();
    const rect = canvasRect;
    marker.style.left = `${rect.left + point.x}px`;
    marker.style.top = `${rect.top + point.y}px`;
    const range = distance(eye, selectedPosition);
    marker.style.setProperty(
      '--qci-scale',
      String(Math.min(1, 600 / Math.max(1, range))),
    );
  }

  const resetCanvasRect = () => {
    canvasRect = null;
  };
  window.addEventListener('resize', resetCanvasRect, { signal });
  window.addEventListener('scroll', resetCanvasRect, {
    signal,
    capture: true,
    passive: true,
  });
  function closeWindow() {
    closedWindowCameraId = selected?.id || null;
    view.panelHidden = true;
    paint();
    live.pause();
    stopMediaRefresh();
    // The floating player closes independently; keep the paused map still.
    updateMarker();
  }
  function startDrag(event) {
    if (event.target.closest('button')) return;
    const rect = panel.getBoundingClientRect();
    const offsetX = event.clientX - rect.left;
    const offsetY = event.clientY - rect.top;
    header.setPointerCapture(event.pointerId);
    const move = (moveEvent) => {
      panel.style.left = `${Math.max(0, Math.min(window.innerWidth - panel.offsetWidth, moveEvent.clientX - offsetX))}px`;
      panel.style.top = `${Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, moveEvent.clientY - offsetY))}px`;
      panel.style.right = 'auto';
    };
    const stop = () => {
      header.removeEventListener('pointermove', move);
      header.removeEventListener('pointerup', stop);
      header.removeEventListener('pointercancel', stop);
    };
    header.addEventListener('pointermove', move, { signal });
    header.addEventListener('pointerup', stop, { once: true, signal });
    header.addEventListener('pointercancel', stop, { once: true, signal });
  }
  document.addEventListener(
    'visibilitychange',
    () => {
      if (!selectedMediaUrl || playingCameraId !== selected?.id) return;
      if (document.hidden) {
        live.pause();
        still.pause();
      } else if (closedWindowCameraId !== selected?.id) {
        void live.play().catch(onPlayFailure(markLiveUnavailable));
        refreshStill();
      }
    },
    { signal },
  );

  return {
    setCamera,
    dispose() {
      controller.abort();
      stopMediaRefresh();
      stopRender();
      setMedia(live, '');
      setMedia(still, '');
      disposed = true;
      renderVue(null, host);
      selected = null;
      selectedPosition = null;
    },
  };
}
