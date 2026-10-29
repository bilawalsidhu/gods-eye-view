import * as Cesium from 'cesium';
import { formatNumber, msg, t, tn } from '../../i18n/index.js';
import { MESSAGE_SIGN_THUMBNAIL_STYLE as STYLE } from '../../overlays/worldOverlayTokens.js';
import { createHorizonCull } from '../streetLevel/view.js';
import { buildSignCard } from './cards.js';
import {
  FACE_BUDGET,
  FACE_FADE_END_M,
  FACE_FADE_START_M,
  FACE_SCALE_FULL_M,
  clampFrameDelayMs,
  createFaceSlot,
  drawFaceFrame,
  faceCssSize,
  openGifFrames,
  selectFaceIds,
} from './faces.js';
export { createMessageSignsSource } from './source.js';

export const MESSAGE_SIGNS_LAYER_ID = 'message-signs';
export const MESSAGE_SIGNS_FACE_SOURCE_ID = 'message-signs';
export const MESSAGE_SIGNS_CARD_SOURCE_ID = 'message-signs-card';
const PICK_PREFIX = 'message-sign:';
/** Gantry height above the ground floor; MnDOT gives only lat/lon. */
const SIGN_LIFT_M = 6;
const FACE_HOST_OPTIONS = Object.freeze({
  cohortLimit: FACE_BUDGET + 1,
  collisionCapacity: FACE_BUDGET + 1,
  moving: false,
});
const CARD_HOST_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});
const FACE_ALTITUDE_SCALE = Object.freeze({
  fullEnd: FACE_SCALE_FULL_M,
  midEnd: FACE_FADE_START_M,
  end: FACE_FADE_END_M,
  midValue: 0.8,
  endValue: 0.7,
  smoothToMid: true,
});
const CARD_ACCENT = '#ffb000';

function defaultCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/** An amber sign rectangle, distinct from the CCTV camera icon. */
function markerImage(createCanvas) {
  try {
    const canvas = createCanvas(24, 16);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'rgba(0, 0, 0, 0.9)';
    ctx.fillRect(0, 0, 24, 16);
    ctx.strokeStyle = STYLE.accent;
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, 22, 14);
    ctx.fillStyle = STYLE.accent;
    ctx.fillRect(5, 5, 14, 2);
    ctx.fillRect(5, 9, 10, 2);
    return canvas.toDataURL();
  } catch {
    return undefined;
  }
}

function reducedMotion() {
  try {
    return (
      globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ===
      true
    );
  } catch {
    return false;
  }
}

/**
 * Highway message signs: every lit MnDOT sign as a marker, and MnDOT's own
 * rendering of its message as a face for the signs nearest the camera.
 */
export function createMessageSignsLayer({
  source,
  overlayHost = null,
  picking = null,
  pointer = null,
  screenSpaceEventHandlerFactory = null,
  surface = null,
  requestRender = null,
  createCanvas = defaultCanvas,
  imageEnv = globalThis,
  now = () => Date.now(),
  timers = globalThis,
  documentRef = globalThis.document ?? null,
  prefersReducedMotion = reducedMotion,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Message signs layer requires a sign source');
  const groundFloor = surface?.groundFloor ?? null;
  let _viewer = null;
  let _enabled = false;
  let _request = null;
  let _lifetime = new AbortController();
  let _signs = [];
  let _byId = new Map();
  let _ageMs = null;
  let _receivedAt = null;
  let _stale = false;
  let _status = null;
  let _lastError = null;
  let _selectedId = null;
  let _markers = null;
  let _markerImage;
  let _clickHandler = null;
  let _removeMoveEnd = null;
  let _clockTimer = null;
  let _statusNode = null;
  /** `id|message|stale` last announced, so a poll is not re-read aloud. */
  let _announcedKey = null;
  /** sign id -> billboard */
  const _markerById = new Map();
  /** sign id -> { message, pending, slot, gif, frameIndex, frameCount, nextFlipAt, css } */
  const _faces = new Map();

  const render = () =>
    requestRender ? requestRender() : _viewer?.scene?.requestRender?.();
  const _horizon = createHorizonCull({
    getViewer: () => _viewer,
    items: () => _markerById.values(),
    onChange: render,
  });

  // ---- positions ---------------------------------------------------------
  function floorOf(sign) {
    if (!groundFloor) return 0;
    const floor = groundFloor.cachedGroundFloor?.(sign.lat, sign.lon);
    return Number.isFinite(floor) ? floor : null;
  }

  function positionOf(sign) {
    const floor = floorOf(sign);
    if (floor === null) return null;
    return Cesium.Cartesian3.fromDegrees(
      sign.lon,
      sign.lat,
      floor + SIGN_LIFT_M,
    );
  }

  async function prepareFloors(signs, signal) {
    if (!groundFloor?.resolveGroundFloorCellsBounded) return;
    const cold = signs
      .filter((sign) => floorOf(sign) === null)
      .map(({ lat, lon }) => ({ lat, lon }));
    if (!cold.length) return;
    try {
      await groundFloor.resolveGroundFloorCellsBounded(cold);
    } catch {
      /* signs without a floor wait for the background resolve below */
    }
    if (signal.aborted) return;
    const still = signs.filter((sign) => floorOf(sign) === null);
    if (!still.length || !groundFloor.resolveGroundFloorCells) return;
    const lifetime = _lifetime.signal;
    groundFloor
      .resolveGroundFloorCells(
        still.map(({ lat, lon }) => ({ lat, lon })),
        { signal: lifetime },
      )
      .catch(() => {})
      .then(() => {
        if (lifetime.aborted || !_enabled) return;
        syncMarkers();
        refreshFaces();
        render();
      });
  }

  // ---- markers -----------------------------------------------------------
  function syncMarkers() {
    if (!_viewer) return;
    if (!_markers) {
      _markers = _viewer.scene.primitives.add(new Cesium.BillboardCollection());
      _markerImage ??= markerImage(createCanvas);
    }
    for (const [id, billboard] of _markerById) {
      if (_byId.has(id)) continue;
      _markers.remove(billboard);
      _markerById.delete(id);
    }
    for (const sign of _signs) {
      if (_markerById.has(sign.id)) continue;
      const position = positionOf(sign);
      if (!position) continue;
      _markerById.set(
        sign.id,
        _markers.add({
          id: `${PICK_PREFIX}${sign.id}`,
          position,
          image: _markerImage,
          scaleByDistance: new Cesium.NearFarScalar(2e3, 1, 2e5, 0.75),
          verticalOrigin: Cesium.VerticalOrigin.CENTER,
          // The horizon cull hides far-side markers (see `_horizon`).
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        }),
      );
    }
    _horizon.update(_markerById.values());
  }

  function removeMarkers() {
    _horizon.stop();
    _markerById.clear();
    if (_markers && _viewer && !_viewer.isDestroyed?.())
      _viewer.scene.primitives.remove(_markers);
    _markers = null;
  }

  // ---- faces -------------------------------------------------------------
  function cameraView() {
    const carto = _viewer?.camera?.positionCartographic;
    if (!carto) return null;
    return {
      lat: Cesium.Math.toDegrees(carto.latitude),
      lon: Cesium.Math.toDegrees(carto.longitude),
      heightM: carto.height,
    };
  }

  function releaseFace(id) {
    const face = _faces.get(id);
    if (!face) return;
    face.gif?.close();
    _faces.delete(id);
  }

  function isCurrent(face, message, signal) {
    return (
      !signal.aborted &&
      _enabled &&
      _faces.get(face.id) === face &&
      face.pending === message
    );
  }

  async function loadFace(face, message) {
    const signal = _lifetime.signal;
    let gif = null;
    try {
      const bytes = await source.getFaceImage(message, { signal });
      if (!isCurrent(face, message, signal)) return;
      const css = faceCssSize(bytes);
      if (!css) throw new Error('Malformed MnDOT response');
      gif = await openGifFrames(bytes, imageEnv);
      if (!isCurrent(face, message, signal)) return gif.close();
      const first = await gif.decode(0);
      if (!isCurrent(face, message, signal)) {
        first.close();
        return gif.close();
      }
      face.gif?.close();
      if (face.css?.width !== css.width || face.css?.height !== css.height)
        face.slot = createFaceSlot(css, createCanvas);
      Object.assign(face, {
        css,
        gif,
        message,
        pending: null,
        frameIndex: 0,
        frameCount: gif.frameCount,
      });
      drawFaceFrame(face.slot, first.image, { stale: _stale });
      face.nextFlipAt =
        gif.frameCount > 1 ? now() + clampFrameDelayMs(first.durationMs) : null;
      first.close();
      publishFaces();
      scheduleClock();
      render();
    } catch {
      gif?.close();
      if (signal.aborted || _faces.get(face.id) !== face) return;
      // A newer message superseded this load: that load owns the face.
      if (face.pending !== message) return;
      face.pending = null;
      if (face.message === message) return; // still showing this message
      // Often a message MnDOT has already replaced. The face goes rather than
      // keep an older message under the new card; the sign keeps its marker
      // and card, and the next refresh tries again.
      const shown = Boolean(face.slot);
      releaseFace(face.id);
      if (!shown) return;
      publishFaces();
      scheduleClock();
      render();
    }
  }

  function refreshFaces() {
    if (!_enabled || typeof source.getFaceImage !== 'function') return;
    const located = _signs.filter((sign) => floorOf(sign) !== null);
    const wanted = new Set(selectFaceIds(located, cameraView()));
    if (_selectedId && _byId.has(_selectedId)) wanted.add(_selectedId);
    for (const id of [..._faces.keys()])
      if (!wanted.has(id) || !_byId.has(id)) releaseFace(id);
    for (const id of wanted) {
      const sign = _byId.get(id);
      let face = _faces.get(id);
      // A different pending message is superseded; isCurrent drops its load.
      if (
        face &&
        (face.pending
          ? face.pending === sign.message
          : face.message === sign.message)
      )
        continue;
      if (!face) {
        face = { id, message: null, pending: null, slot: null, gif: null };
        _faces.set(id, face);
      }
      face.pending = sign.message;
      void loadFace(face, sign.message);
    }
    publishFaces();
    scheduleClock();
  }

  async function redrawFace(face) {
    const { gif, frameIndex, message } = face;
    try {
      const frame = await gif.decode(frameIndex);
      if (face.gif === gif && face.message === message && _enabled)
        drawFaceFrame(face.slot, frame.image, { stale: _stale });
      frame.close();
    } catch {
      /* the next message or flip draws it */
    }
  }

  function faceEntry(sign, face, position, rank) {
    const selected = sign.id === _selectedId;
    return {
      id: sign.id,
      position,
      variant: 'thumbnail',
      paintLane: 'thumbnail',
      title: '',
      details: [],
      image: face.slot,
      requireImage: true,
      accent: STYLE.accent,
      priority: selected ? 1_000_000 : 100_000 - rank,
      protected: selected,
      active: selected,
      collisionGroup: 'ambient-card',
      zIndex: 50,
      interactive: true,
      // Location only: a label holding the message would rebuild the
      // host's accessible list, and drop focus, on every message change.
      accessibilityLabel: t('Message sign, {location}', {
        location: sign.location,
      }),
      activate: () => {
        toggleSelection(sign.id);
        return true;
      },
      altitudeScale: FACE_ALTITUDE_SCALE,
      altitudeFadeStart: FACE_FADE_START_M,
      altitudeFadeEnd: FACE_FADE_END_M,
      horizonCull: true,
      terrainOcclusion: false,
      gapPx: 18,
      leaderOffsetPx: 12,
      verticalOnly: true,
      placement: 'above',
      stateless: true,
      thumbnailWidth: face.css.width,
      thumbnailHeight: face.css.height,
      thumbnailPadX: STYLE.padding,
      thumbnailPadTop: STYLE.padding,
      thumbnailPadBottom: STYLE.padding,
      thumbnailTitleGap: 0,
      thumbnailTitleHeight: 0,
      thumbnailBackground: STYLE.background,
      thumbnailLeaderColor: STYLE.leader,
      thumbnailRuleHeight: 0,
    };
  }

  function publishFaces() {
    if (!overlayHost) return;
    const entries = [];
    let rank = 0;
    for (const face of _faces.values()) {
      const sign = _byId.get(face.id);
      if (!sign || !face.slot || face.message === null) continue;
      const position = positionOf(sign);
      if (!position) continue;
      entries.push(faceEntry(sign, face, position, rank++));
    }
    overlayHost.setEntries(
      MESSAGE_SIGNS_FACE_SOURCE_ID,
      entries,
      FACE_HOST_OPTIONS,
    );
  }

  function clearFaces() {
    for (const id of [..._faces.keys()]) releaseFace(id);
    overlayHost?.setEntries(
      MESSAGE_SIGNS_FACE_SOURCE_ID,
      [],
      FACE_HOST_OPTIONS,
    );
  }

  // ---- animation clock ---------------------------------------------------
  function clockAllowed() {
    return (
      _enabled &&
      documentRef?.visibilityState !== 'hidden' &&
      !prefersReducedMotion()
    );
  }

  function stopClock() {
    if (_clockTimer !== null) timers.clearTimeout(_clockTimer);
    _clockTimer = null;
  }

  function scheduleClock() {
    stopClock();
    if (!clockAllowed()) return;
    let next = Infinity;
    for (const face of _faces.values())
      if (face.nextFlipAt != null) next = Math.min(next, face.nextFlipAt);
    if (next === Infinity) return;
    _clockTimer = timers.setTimeout(tick, Math.max(0, next - now()));
  }

  async function tick() {
    _clockTimer = null;
    if (!clockAllowed()) return;
    const due = [..._faces.values()].filter(
      (face) => face.nextFlipAt != null && face.nextFlipAt <= now(),
    );
    await Promise.all(
      due.map(async (face) => {
        const { gif, message } = face;
        const index = (face.frameIndex + 1) % face.frameCount;
        try {
          const frame = await gif.decode(index);
          if (face.gif === gif && face.message === message && _enabled) {
            drawFaceFrame(face.slot, frame.image, { stale: _stale });
            face.frameIndex = index;
            face.nextFlipAt = now() + clampFrameDelayMs(frame.durationMs);
          }
          frame.close();
        } catch {
          // Hold the frame already drawn, unless a new GIF replaced this one.
          if (face.gif === gif) face.nextFlipAt = null;
        }
      }),
    );
    if (due.length && _enabled) render();
    scheduleClock();
  }

  const onVisibility = () => scheduleClock();

  // ---- selection card ----------------------------------------------------
  function announce(text) {
    if (_statusNode) _statusNode.textContent = text;
  }

  function publishCard() {
    if (!overlayHost) return;
    const sign = _selectedId ? _byId.get(_selectedId) : null;
    const position = sign ? positionOf(sign) : null;
    if (!sign || !position) {
      clearSelection();
      return;
    }
    const card = buildSignCard(sign, {
      ageMs: currentAgeMs(),
      stale: _stale,
    });
    overlayHost.setEntries(
      MESSAGE_SIGNS_CARD_SOURCE_ID,
      [
        {
          id: `message-sign-card:${sign.id}`,
          selected: true,
          interactive: false,
          title: card.title,
          details: card.details,
          accent: CARD_ACCENT,
          priority: Number.MAX_SAFE_INTEGER,
          gapPx: 15,
          verticalOnly: true,
          // Below the anchor, so the card never contests its own face.
          placement: 'below',
          stateless: true,
          horizonCull: true,
          position,
        },
      ],
      CARD_HOST_OPTIONS,
    );
    overlayHost.setVisible?.(MESSAGE_SIGNS_CARD_SOURCE_ID, true);
    // The age line changes every poll; only a new sign, message or stale
    // state is worth reading again.
    const key = `${sign.id}|${sign.message}|${_stale}`;
    if (key !== _announcedKey) {
      _announcedKey = key;
      announce(card.spoken);
    }
  }

  function clearSelection() {
    const had = _selectedId !== null;
    _selectedId = null;
    overlayHost?.setEntries(
      MESSAGE_SIGNS_CARD_SOURCE_ID,
      [],
      CARD_HOST_OPTIONS,
    );
    _announcedKey = null;
    announce('');
    if (had) publishFaces();
  }

  function toggleSelection(id) {
    if (_selectedId === id) {
      clearSelection();
    } else if (_byId.has(id)) {
      _selectedId = id;
      publishCard();
      refreshFaces();
    }
    render();
  }

  const onKeyDown = (event) => {
    if (event.key === 'Escape' && _selectedId) {
      clearSelection();
      render();
    }
  };

  function installClickHandler() {
    if (!overlayHost || !screenSpaceEventHandlerFactory || !picking) return;
    if (_clickHandler || !_viewer) return;
    picking.registerPickOwner?.(
      MESSAGE_SIGNS_LAYER_ID,
      (pickedId) =>
        typeof pickedId === 'string' && pickedId.startsWith(PICK_PREFIX),
    );
    _clickHandler = screenSpaceEventHandlerFactory(_viewer);
    _clickHandler.setInputAction((click) => {
      if (!_enabled || (pointer && !pointer.isPointerFree())) return;
      const { x, y } = click.position ?? {};
      // Markers first, then faces: the CCTV and FIRMS order.
      const pickId = picking.resolvePickId(_viewer.scene.pick(click.position));
      if (typeof pickId === 'string' && pickId.startsWith(PICK_PREFIX)) {
        toggleSelection(pickId.slice(PICK_PREFIX.length));
        return;
      }
      // Any other identified scene object owns this click.
      if (pickId !== null) return;
      // The card is not interactive, so a click on it closes it below.
      const face = overlayHost.hitTest?.(x, y, {
        sourceId: MESSAGE_SIGNS_FACE_SOURCE_ID,
      });
      if (face && _byId.has(face.entryId)) {
        toggleSelection(face.entryId);
        return;
      }
      if (_selectedId) {
        clearSelection();
        render();
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function removeClickHandler() {
    _clickHandler?.destroy();
    _clickHandler = null;
    picking?.unregisterPickOwner?.(MESSAGE_SIGNS_LAYER_ID);
  }

  // ---- data --------------------------------------------------------------
  function currentAgeMs() {
    if (_ageMs === null) return null;
    return _ageMs + Math.max(0, now() - _receivedAt);
  }

  function clearSigns() {
    _signs = [];
    _byId = new Map();
    clearSelection();
    clearFaces();
    removeMarkers();
    stopClock();
  }

  function applySnapshot(snapshot) {
    const wasStale = _stale;
    _signs = snapshot.signs;
    _byId = new Map(_signs.map((sign) => [sign.id, sign]));
    _ageMs = snapshot.ageMs;
    _receivedAt = now();
    _stale = snapshot.stale;
    _status = 'ok';
    _lastError = null;
    if (_selectedId && !_byId.has(_selectedId)) clearSelection();
    syncMarkers();
    refreshFaces();
    if (wasStale !== _stale)
      for (const face of _faces.values()) if (face.gif) void redrawFace(face);
    if (_selectedId) publishCard();
    render();
  }

  const layer = {
    id: MESSAGE_SIGNS_LAYER_ID,
    name: 'Highway message signs',
    icon: '🪧',
    // The layer is not global, so its row says where it covers
    // (translated as a whole by ui/layerNames.js).
    source: 'MnDOT · Minnesota only',
    // The proxy caches about 30 s; the feeds regenerate about every 30 s.
    updateInterval: 60000,

    init(viewer) {
      if (_viewer)
        throw new Error('Message signs layer is already initialized');
      _viewer = viewer;
    },

    enable() {
      _enabled = true;
      _lifetime = new AbortController();
      installClickHandler();
      _removeMoveEnd ??=
        _viewer?.camera?.moveEnd?.addEventListener?.(() => {
          refreshFaces();
          render();
        }) ?? null;
      documentRef?.addEventListener?.('visibilitychange', onVisibility);
      documentRef?.addEventListener?.('keydown', onKeyDown);
      if (documentRef?.createElement && !_statusNode) {
        _statusNode = documentRef.createElement('div');
        _statusNode.className = 'world-overlay-accessibility';
        _statusNode.setAttribute('role', 'status');
        _statusNode.setAttribute('aria-live', 'polite');
        documentRef.body?.appendChild(_statusNode);
      }
    },

    disable() {
      _enabled = false;
      _request?.abort();
      _request = null;
      _lifetime.abort();
      removeClickHandler();
      _removeMoveEnd?.();
      _removeMoveEnd = null;
      documentRef?.removeEventListener?.('visibilitychange', onVisibility);
      documentRef?.removeEventListener?.('keydown', onKeyDown);
      clearSigns();
      _statusNode?.remove?.();
      _statusNode = null;
      _ageMs = null;
      _status = null;
      _lastError = null;
      _stale = false;
      render();
    },

    async update(_viewerArg, { signal } = {}) {
      if (!_enabled || signal?.aborted) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      signal?.addEventListener('abort', () => request.abort(), { once: true });
      const superseded = () =>
        request.signal.aborted || _request !== request || !_enabled;
      try {
        const snapshot = await source.getSnapshot({ signal: request.signal });
        if (superseded()) return false;
        await prepareFloors(snapshot.signs, request.signal);
        if (superseded()) return false;
        applySnapshot(snapshot);
        return true;
      } catch (error) {
        if (superseded()) return false;
        // No stale copy here: the proxy already serves the last good list
        // while it is under ten minutes old, so an error means unavailable.
        clearSigns();
        _ageMs = null;
        _stale = false;
        _status = 'unavailable';
        _lastError = error?.message || msg('MnDOT network error');
        render();
        return true; // Stay enabled; the next interval recovers.
      } finally {
        if (_request === request) _request = null;
      }
    },

    destroy() {
      layer.disable();
      _viewer = null;
    },

    getStats() {
      const unavailable = _status === 'unavailable';
      const count = unavailable ? 0 : _signs.length;
      const ageMs = currentAgeMs();
      return {
        count,
        countLabel:
          _status === 'ok'
            ? tn(count, '{count} sign lit', '{count} signs lit', {
                count: formatNumber(count),
              })
            : null,
        lastUpdate: ageMs === null ? null : now() - ageMs,
        stale: _stale,
        status: _status,
        error: _lastError,
        faces: [..._faces.values()].filter((face) => face.slot).length,
      };
    },

    /** Lit signs as plain records, for tools and QA. */
    getAnalystRecords(maxCount = Infinity) {
      if (!_enabled) return [];
      return _signs.slice(0, maxCount).map((sign) => ({
        id: sign.id,
        provider: sign.provider,
        location: sign.location,
        lat: sign.lat,
        lon: sign.lon,
      }));
    },
  };
  return layer;
}
