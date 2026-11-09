import * as Cesium from 'cesium';
import { horizonOccluder } from '../data/iconOrientation.js';
import { t } from '../i18n/index.js';

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
 * shows its details and the play control.
 */
export function createQuebecCctvOverlay(viewer) {
  if (!viewer?.scene || typeof document === 'undefined') return null;

  const controller = new AbortController();
  const { signal } = controller;
  const panel = document.createElement('section');
  panel.className = 'qci-panel';
  panel.hidden = true;
  panel.setAttribute('role', 'region');
  panel.setAttribute('aria-label', t('CCTV camera'));

  const header = document.createElement('header');
  header.className = 'qci-header';
  const title = document.createElement('strong');
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = '×';
  close.setAttribute('aria-label', t('Close camera preview'));
  header.append(title, close);

  const coordinates = document.createElement('p');
  coordinates.className = 'qci-coordinates';
  const credit = document.createElement('p');
  credit.className = 'qci-credit';
  const live = document.createElement('video');
  live.className = 'qci-live';
  live.controls = true;
  live.muted = true;
  live.autoplay = true;
  live.loop = true;
  live.playsInline = true;
  live.setAttribute('aria-label', t('CCTV camera'));

  const actions = document.createElement('div');
  actions.className = 'qci-actions';
  const play = document.createElement('button');
  play.type = 'button';
  play.className = 'qci-play';
  play.textContent = t('Play');
  const refresh = document.createElement('button');
  refresh.type = 'button';
  refresh.textContent = t('Refresh map still');
  actions.append(play, refresh);
  const note = document.createElement('p');
  note.className = 'qci-note';
  const sourceLink = document.createElement('a');
  sourceLink.target = '_blank';
  sourceLink.rel = 'noopener noreferrer';
  sourceLink.textContent = t("Open this image on the provider's site");
  panel.append(header, coordinates, credit, live, actions, note, sourceLink);

  const marker = document.createElement('div');
  marker.className = 'qci-marker';
  marker.hidden = true;
  const still = document.createElement('video');
  still.className = 'qci-marker-still';
  still.muted = true;
  still.playsInline = true;
  still.preload = 'none';
  still.setAttribute('aria-hidden', 'true');
  const markerLabel = document.createElement('span');
  markerLabel.className = 'qci-marker-label';
  marker.append(still, markerLabel);
  document.body.append(panel, marker);

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
    note.textContent = t('Source unavailable');
    note.hidden = false;
  }

  function markStillUnavailable() {
    stillUnavailable = true;
    markerLabel.textContent = t('Source unavailable');
  }

  function startRender() {
    if (!removeRender)
      removeRender = viewer.scene.postRender.addEventListener(updateMarker);
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
    play.hidden = true;
    refresh.hidden = false;
    live.hidden = false;
    still.hidden = false;
    marker.classList.remove('qci-marker-link-only');
    note.textContent = t(
      'The map still uses a separate request and may show a different moment.',
    );
    note.hidden = false;
    markerLabel.textContent = markerLabelText(selected, true);
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
      panel.hidden = true;
      marker.hidden = true;
      setMedia(live, '');
      setMedia(still, '');
      return;
    }

    const changed = selected?.id !== camera.id;
    if (changed || reselected) closedWindowCameraId = null;
    selected = camera;
    startRender();
    selectedPosition = Cesium.Cartesian3.fromDegrees(
      Number(camera.lon),
      Number(camera.lat),
      Number(camera.elevationM) || 10,
    );
    if (closedWindowCameraId === camera.id && !reselected) {
      panel.hidden = true;
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
    title.textContent = camera.name || t('CCTV camera');
    coordinates.textContent = [
      `${Number(camera.lat).toFixed(5)}, ${Number(camera.lon).toFixed(5)}`,
      Number.isFinite(camera.accuracyM) && camera.accuracyM > 0
        ? `±${Math.round(camera.accuracyM)} m`
        : '',
      camera.positionSource || '',
    ]
      .filter(Boolean)
      .join(' · ');
    credit.textContent = camera.credit || camera.provider || '';
    credit.hidden = !credit.textContent;
    live.hidden = !playing;
    play.hidden = !mediaUrl || playing;
    refresh.hidden = !playing;
    actions.hidden = !mediaUrl;
    note.hidden = !mediaUrl;
    note.textContent = mediaUrl
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
    note.hidden = !note.textContent;
    sourceLink.href = sourceUrl || '#';
    sourceLink.hidden = !sourceUrl;
    markerLabel.textContent = stillUnavailable
      ? t('Source unavailable')
      : markerLabelText(camera, playing);
    marker.classList.toggle('qci-marker-link-only', !playing);
    still.hidden = !playing;
    panel.hidden = false;

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
    const canvas = viewer.scene.canvas;
    const point = viewer.scene.cartesianToCanvasCoordinates(selectedPosition);
    const visible =
      point &&
      horizonOccluder(viewer.camera).isPointVisible(selectedPosition) &&
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
    const distance = Cesium.Cartesian3.distance(
      viewer.camera.positionWC,
      selectedPosition,
    );
    marker.style.setProperty(
      '--qci-scale',
      String(Math.min(1, 600 / Math.max(1, distance))),
    );
  }

  still.addEventListener(
    'loadeddata',
    () => {
      stillUnavailable = false;
      if (selected)
        markerLabel.textContent = markerLabelText(
          selected,
          Boolean(selectedMediaUrl),
        );
      still.pause();
    },
    { signal },
  );
  still.addEventListener('error', markStillUnavailable, { signal });
  live.addEventListener('error', markLiveUnavailable, { signal });
  live.addEventListener(
    'loadeddata',
    () => {
      liveUnavailable = false;
      note.textContent = t(
        'The map still uses a separate request and may show a different moment.',
      );
      note.hidden = false;
    },
    { signal },
  );
  refresh.addEventListener('click', refreshStill, { signal });
  play.addEventListener('click', startPlayback, { signal });
  const resetCanvasRect = () => {
    canvasRect = null;
  };
  window.addEventListener('resize', resetCanvasRect, { signal });
  window.addEventListener('scroll', resetCanvasRect, {
    signal,
    capture: true,
    passive: true,
  });
  panel.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Escape') close.click();
    },
    { signal },
  );
  close.addEventListener(
    'click',
    () => {
      closedWindowCameraId = selected?.id || null;
      panel.hidden = true;
      live.pause();
      stopMediaRefresh();
      // The floating player closes independently; keep the paused map still.
      updateMarker();
    },
    { signal },
  );
  header.addEventListener(
    'pointerdown',
    (event) => {
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
    },
    { signal },
  );
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
      panel.remove();
      marker.remove();
      selected = null;
      selectedPosition = null;
    },
  };
}
