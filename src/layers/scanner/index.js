import * as Cesium from 'cesium';
import {
  SCANNER_CALL_POLL_MS,
  SCANNER_LAYER_ID,
  SCANNER_REFRESH_MS,
  scannerEntityId,
  scannerFeedIdFromEntityId,
  takeNewCalls,
} from './model.js';

export * from './model.js';
export { createScannerSource } from './source.js';

const IDLE_COLOR = '#4da3ff';
const ACTIVE_COLOR = '#ffb020';

function el(tag, styles = {}, text = '') {
  const node = document.createElement(tag);
  Object.assign(node.style, styles);
  if (text) node.textContent = text;
  return node;
}

/** Own the police-scanner markers, player panel and audio for one viewer. */
export function createScannerLayer({ source } = {}) {
  if (typeof source?.getFeeds !== 'function')
    throw new TypeError('Scanner requires a feed source');
  let _viewer = null;
  let _dataSource = null;
  let _handler = null;
  let _panel = null;
  let _enabled = false;
  let _request = null;
  let _feeds = [];
  let _activeId = null;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _volume = 0.8;
  let _playToken = 0;
  let _pollTimer = null;
  let _played = new Set();
  let _queue = [];
  let _audio = null;
  let _ui = null;

  const feedById = (id) => _feeds.find((feed) => feed.id === id) || null;
  const render = () => _viewer?.scene?.requestRender?.();

  function setStatus(text) {
    if (_ui) _ui.status.textContent = text;
  }

  function paintEntities() {
    if (!_dataSource) return;
    for (const entity of _dataSource.entities.values) {
      const active = scannerFeedIdFromEntityId(entity.id) === _activeId;
      const color = Cesium.Color.fromCssColorString(
        active ? ACTIVE_COLOR : IDLE_COLOR,
      );
      entity.point.color = color;
      entity.point.pixelSize = active ? 14 : 10;
    }
    render();
  }

  function stopAudio() {
    _playToken++;
    clearTimeout(_pollTimer);
    _pollTimer = null;
    _queue = [];
    if (_audio) {
      _audio.pause();
      _audio.removeAttribute('src');
      _audio.load();
    }
    _activeId = null;
    paintEntities();
    renderList();
    setStatus(_feeds.length ? 'Select a feed' : 'No feeds configured');
  }

  function playNextClip(token) {
    if (token !== _playToken || !_audio) return;
    const next = _queue.shift();
    if (!next) return;
    _audio.src = next.url;
    _audio.play().catch(() => {
      if (token === _playToken) setStatus('Playback blocked — press play');
    });
  }

  async function pollCalls(feed, token) {
    try {
      const calls = await source.getCalls(feed.id);
      if (token !== _playToken) return;
      const fresh = takeNewCalls(calls, _played);
      const idle = !_queue.length && (!_audio || _audio.paused || _audio.ended);
      _queue.push(...fresh);
      if (fresh.length || _queue.length)
        setStatus(`${feed.name} — recent calls`);
      else setStatus(`${feed.name} — waiting for traffic`);
      if (idle) playNextClip(token);
    } catch (error) {
      if (token === _playToken) setStatus('Calls unavailable');
    }
    if (token === _playToken)
      _pollTimer = setTimeout(
        () => pollCalls(feed, token),
        SCANNER_CALL_POLL_MS,
      );
  }

  function play(feed) {
    stopAudio();
    _activeId = feed.id;
    const token = _playToken;
    _played = new Set();
    paintEntities();
    renderList();
    setStatus(`Connecting to ${feed.name}…`);
    if (!_audio) return;
    _audio.volume = _volume;
    if (feed.type === 'stream') {
      _audio.src = source.getStreamUrl(feed.id);
      _audio.play().catch(() => {
        if (token === _playToken) setStatus('Playback blocked — press play');
      });
    } else {
      pollCalls(feed, token);
    }
  }

  function select(feedId, { fly = true } = {}) {
    const feed = feedById(feedId);
    if (!feed) return;
    if (fly && _viewer) {
      _viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(feed.lon, feed.lat, 25000),
        duration: 1.6,
      });
    }
    play(feed);
  }

  function renderList() {
    if (!_ui) return;
    _ui.list.replaceChildren();
    if (!_feeds.length) {
      _ui.list.append(
        el(
          'div',
          { opacity: '0.7', padding: '6px 0' },
          'Add feeds to config/scanner-feeds.json (see scanner-feeds.example.json).',
        ),
      );
      return;
    }
    for (const feed of _feeds) {
      const active = feed.id === _activeId;
      const row = el('button', {
        display: 'block',
        width: '100%',
        textAlign: 'left',
        margin: '2px 0',
        padding: '5px 7px',
        background: active ? 'rgba(255,176,32,0.18)' : 'rgba(255,255,255,0.05)',
        border: `1px solid ${active ? ACTIVE_COLOR : 'rgba(255,255,255,0.12)'}`,
        color: 'inherit',
        font: 'inherit',
        cursor: 'pointer',
      });
      row.type = 'button';
      row.append(
        el('div', { fontWeight: '600' }, `${active ? '▶ ' : ''}${feed.name}`),
        el(
          'div',
          { opacity: '0.65', fontSize: '10px' },
          [feed.agency, feed.type === 'openmhz' ? 'recent calls' : 'live']
            .filter(Boolean)
            .join(' · '),
        ),
      );
      row.addEventListener('click', () => select(feed.id));
      _ui.list.append(row);
    }
  }

  function buildPanel() {
    _panel = el('div', {
      position: 'absolute',
      left: '12px',
      bottom: '120px',
      width: '250px',
      maxHeight: '45vh',
      overflowY: 'auto',
      zIndex: '30',
      padding: '10px',
      background: 'rgba(8,12,18,0.82)',
      border: '1px solid rgba(77,163,255,0.5)',
      color: '#d7e6f5',
      font: '11px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace',
      letterSpacing: '0.02em',
    });
    _panel.setAttribute('data-gev-scanner-panel', '');
    const header = el(
      'div',
      { fontWeight: '700', letterSpacing: '0.12em', marginBottom: '4px' },
      '📡 POLICE SCANNER',
    );
    const status = el('div', { opacity: '0.8', marginBottom: '6px' }, '');
    const controls = el('div', {
      display: 'flex',
      gap: '6px',
      alignItems: 'center',
      marginBottom: '6px',
    });
    const stop = el('button', { font: 'inherit', cursor: 'pointer' }, '■ Stop');
    stop.type = 'button';
    stop.addEventListener('click', stopAudio);
    const volume = el('input', { flex: '1' });
    volume.type = 'range';
    volume.min = '0';
    volume.max = '1';
    volume.step = '0.05';
    volume.value = String(_volume);
    volume.setAttribute('aria-label', 'Scanner volume');
    volume.addEventListener('input', () => {
      _volume = Number(volume.value);
      if (_audio) _audio.volume = _volume;
    });
    controls.append(stop, volume);
    const list = el('div');
    const credit = el(
      'div',
      { opacity: '0.5', fontSize: '9px', marginTop: '6px' },
      'Public-safety audio comes from the feeds you register. Many agencies encrypt.',
    );
    _panel.append(header, status, controls, list, credit);
    _panel.addEventListener('pointerdown', (event) => event.stopPropagation());
    _panel.addEventListener('wheel', (event) => event.stopPropagation());
    _ui = { status, list };
    (_viewer.container || document.body).append(_panel);
    setStatus(_feeds.length ? 'Select a feed' : 'No feeds configured');
    renderList();
  }

  function buildAudio() {
    _audio = new Audio();
    _audio.preload = 'none';
    _audio.volume = _volume;
    _audio.addEventListener('playing', () => {
      const feed = feedById(_activeId);
      if (feed)
        setStatus(
          `● ${feed.type === 'stream' ? 'LIVE' : 'CALL'} — ${feed.name}`,
        );
    });
    _audio.addEventListener('ended', () => {
      const feed = feedById(_activeId);
      if (feed?.type === 'openmhz') playNextClip(_playToken);
    });
    _audio.addEventListener('error', () => {
      if (!_activeId || !_audio.getAttribute('src')) return;
      const feed = feedById(_activeId);
      if (feed?.type === 'openmhz') playNextClip(_playToken);
      else setStatus('Stream unavailable');
    });
  }

  function rebuildEntities() {
    _dataSource.entities.removeAll();
    for (const feed of _feeds) {
      _dataSource.entities.add(
        new Cesium.Entity({
          id: scannerEntityId(feed.id),
          name: feed.name,
          position: Cesium.Cartesian3.fromDegrees(feed.lon, feed.lat),
          point: {
            pixelSize: 10,
            color: Cesium.Color.fromCssColorString(IDLE_COLOR),
            outlineColor: Cesium.Color.WHITE,
            outlineWidth: 2,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        }),
      );
    }
    paintEntities();
  }

  return {
    id: SCANNER_LAYER_ID,
    name: 'Police Scanner',
    icon: '📡',
    source: 'Registered scanner feeds',
    updateInterval: SCANNER_REFRESH_MS,

    init(viewer) {
      if (_viewer) throw new Error('Scanner layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('police-scanner');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _enabled = false;
      _feeds = [];
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
    },

    enable(viewer) {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      if (!_audio) buildAudio();
      if (!_panel) buildPanel();
      if (!_handler && _viewer) {
        _handler = new Cesium.ScreenSpaceEventHandler(_viewer.scene.canvas);
        _handler.setInputAction((click) => {
          const picked = _viewer.scene.pick(click.position);
          const feedId = scannerFeedIdFromEntityId(picked?.id?.id);
          if (feedId) select(feedId, { fly: false });
        }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
      }
      render();
    },

    disable() {
      _request?.abort();
      _request = null;
      _enabled = false;
      stopAudio();
      _handler?.destroy();
      _handler = null;
      _panel?.remove();
      _panel = null;
      _ui = null;
      if (_dataSource) _dataSource.show = false;
      render();
    },

    async update() {
      if (!_enabled || !_dataSource) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const feeds = await source.getFeeds({ signal: request.signal });
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        _feeds = feeds;
        if (_activeId && !feedById(_activeId)) stopAudio();
        rebuildEntities();
        renderList();
        if (!_activeId)
          setStatus(_feeds.length ? 'Select a feed' : 'No feeds configured');
        _count = feeds.length;
        _lastUpdate = Date.now();
        _lastError = null;
        return true;
      } catch (error) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        _lastError = error?.message || 'Scanner feeds unavailable';
        setStatus('Feed list unavailable');
        return false;
      } finally {
        if (_request === request) _request = null;
      }
    },

    destroy(viewer = _viewer) {
      _request?.abort();
      _request = null;
      _enabled = false;
      stopAudio();
      _handler?.destroy();
      _handler = null;
      _panel?.remove();
      _panel = null;
      _ui = null;
      _audio = null;
      if (_dataSource && viewer) {
        viewer.dataSources.remove(_dataSource, true);
      }
      _dataSource = null;
      _viewer = null;
      _feeds = [];
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
    },

    getStats() {
      return {
        count: _count,
        lastUpdate: _lastUpdate,
        error: _lastError,
        playing: _activeId,
      };
    },
  };
}
