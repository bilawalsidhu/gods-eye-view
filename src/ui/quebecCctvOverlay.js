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

import { QUEBEC_CAMERA_HOST_EVENT } from './cctvEvents.js';

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
 * Attach the active Québec source to its selected card player and map
 * preview. The browser contacts Québec 511 only after the viewer presses Play
 * for that camera; selecting it (by click, auto-hop, a scene or voice) only
 * shows its details and the play control. The panel and marker are the
 * `QuebecCctvOverlay` view, rendered synchronously on each change.
 */
export function createQuebecCctvOverlay(viewer) {
  if (!viewer || typeof document === 'undefined') return null;

  const controller = new AbortController();
  const { signal } = controller;
  // The owner updates this state and paints. It binds the media sources
  // and updates the marker's visibility and position each frame.
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
  const parked = document.createElement('div');
  let playerHost = parked;
  let disposed = false;
  const handlers = {
    onPlay: startPlayback,
    onRefresh: refreshStill,
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
    const vnode = h(QuebecCctvOverlay, {
      view: { ...view },
      playerHost,
      ...handlers,
    });
    renderVue(vnode, host);
    return vnode.component.exposed;
  }
  const elements = paint();
  const live = elements.live.value;
  const marker = elements.marker.value;
  const still = elements.still.value;

  let selected = null;
  let selectedPosition = null;
  let selectedMediaUrl = '';
  /** Camera id the viewer pressed Play for; media loads only for this one. */
  let playingCameraId = null;
  let resumeOnShow = false;
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
        if (document.hidden) return;
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
    if (
      !selected ||
      !selectedMediaUrl ||
      playerHost === parked ||
      document.hidden
    )
      return;
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
      playerHost = parked;
      selectedMediaUrl = '';
      playingCameraId = null;
      resumeOnShow = false;
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
    selected = camera;
    if (changed) syncPlayerHost();
    startRender();
    selectedPosition = fromDegrees(
      Number(camera.lon),
      Number(camera.lat),
      Number(camera.elevationM) || 10,
    );
    const mediaUrl = safeMediaUrl(camera.browserMediaUrl);
    const sourceUrl = safeSourceUrl(camera.sourceUrl);
    if (changed || mediaUrl !== selectedMediaUrl) {
      liveUnavailable = false;
      stillUnavailable = false;
      playingCameraId = null;
      resumeOnShow = false;
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
  function syncPlayerHost() {
    const next =
      Array.from(document.querySelectorAll('[data-quebec-camera]')).find(
        (element) => element.dataset.quebecCamera === selected?.id,
      ) || parked;
    if (next === playerHost) return;
    playerHost = next;
    if (next === parked) resumeOnShow = false;
    if (next === parked && playingCameraId) {
      playingCameraId = null;
      stopMediaRefresh();
      setMedia(live, '');
      setMedia(still, '');
      setCamera(selected);
    } else {
      paint();
    }
  }
  document.addEventListener(QUEBEC_CAMERA_HOST_EVENT, syncPlayerHost, {
    signal,
  });
  document.addEventListener(
    'visibilitychange',
    () => {
      if (document.hidden) {
        if (!selected || playingCameraId !== selected.id) return;
        resumeOnShow = !live.paused;
        playingCameraId = null;
        stopMediaRefresh();
        setMedia(live, '');
        setMedia(still, '');
        setCamera(selected);
      } else if (resumeOnShow) {
        resumeOnShow = false;
        startPlayback();
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
