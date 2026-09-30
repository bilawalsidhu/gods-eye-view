import * as Cesium from 'cesium';
import { LIVE_TV_PAGE_SIZE } from './records.js';
import { attachLiveTvStreams } from './playback.js';
export * from './records.js';
export { createLiveTvSource } from './source.js';
export { attachLiveTvStreams, liveTvStreamBlocker } from './playback.js';

const LAYER_ID = 'live-tv';
const ENTITY_PREFIX = `${LAYER_ID}:`;
const PIN_COLOR = '#7cc4ff';
const PIN_SELECTED_COLOR = '#ffffff';
/** Pins grow with a country's channel count, within these bounds. */
const PIN_MIN_PX = 6;
const PIN_MAX_PX = 14;
const PIN_SELECTED_PX = 16;
const LABEL_LIMIT = 12;
/** With no country chosen, the row lists the busiest countries. */
const COUNTRY_LIST_LIMIT = 25;
const FOCUS_HEIGHT_M = 2_500_000;
const PROJECT_PAGE = 'https://github.com/iptv-org/iptv';
const DISCLAIMER =
  'Channels and stream links come from the community-maintained iptv-org database. Streams are third-party broadcasts that are linked, not hosted: playing one connects your browser directly to the broadcaster. Many are geo-blocked, offline or refuse playback in a browser. Pins sit at the country label point, not at the broadcaster.';
const CAVEAT = 'Third-party streams, linked not hosted';
const REASONS = Object.freeze({
  insecure: 'this page is https and the stream is http',
  timeout: 'no picture within 15 s',
  network: 'the stream host refused or did not answer',
  media: 'the stream could not be decoded',
  error: 'the stream could not be played',
  unsupported: 'this browser cannot play HLS',
});

const plural = (count, word, many = `${word}s`) =>
  `${count.toLocaleString('en-US')} ${count === 1 ? word : many}`;
const pinSize = (channels) =>
  Math.round(
    Math.min(PIN_MAX_PX, PIN_MIN_PX + Math.log2(Math.max(1, channels)) * 0.9),
  );

/** A globe label: the country and its channel count. */
export function liveTvLabelTitle(country) {
  return `${country.name} · ${country.channels.toLocaleString('en-US')} TV`;
}

/**
 * Own one live-TV directory display: a pin per country with playable
 * iptv-org channels, a paged channel list for the chosen country, and one
 * player the layer row hosts. Streams load only when the viewer picks a
 * channel, and play straight from the broadcaster.
 */
export function createLiveTvLayer({
  source,
  cesium = Cesium,
  matchMedia = globalThis.matchMedia?.bind(globalThis),
  openExternal = (url) =>
    globalThis.open?.(url, '_blank', 'noopener,noreferrer'),
  attachStreams = attachLiveTvStreams,
  now = () => Date.now(),
  picking = null,
  pointer = null,
  overlayHost = null,
} = {}) {
  if (
    typeof source?.getSnapshot !== 'function' ||
    typeof source?.getCountry !== 'function'
  )
    throw new TypeError('Live TV requires a channel source');
  const C = cesium;
  let _viewer = null;
  let _dataSource = null;
  let _request = null;
  let _countryRequest = null;
  let _enabled = false;
  let _countries = [];
  let _signature = null;
  let _selectedCode = null;
  let _channels = null;
  let _countryError = null;
  let _page = 0;
  let _newsOnly = false;
  let _channelId = null;
  let _playSerial = 0;
  let _status = null;
  let _lastUpdate = null;
  let _lastError = null;
  let _stale = false;
  let _listener = null;
  let _runNavigation = null;
  let _clickHandler = null;
  let _removePreRender = null;
  let _occluder = null;
  let _culledFrom = null;
  let _navigationGeneration = 0;
  let _labelIds = [];
  /** entity id -> country code, for picks and ownership. */
  const _entityCountries = new Map();
  /** country code -> { entity, position, country } */
  const _markers = new Map();

  const notify = () => _listener?.();
  const requestRender = () => {
    if (!_viewer?.isDestroyed?.()) _viewer?.scene?.requestRender?.();
  };
  const selectedCountry = () =>
    (_selectedCode && _markers.get(_selectedCode)?.country) || null;
  const filteredChannels = () =>
    (_channels || []).filter(
      (channel) => !_newsOnly || channel.categories.includes('news'),
    );
  const playingChannel = () =>
    (_channelId && _channels?.find(({ id }) => id === _channelId)) || null;

  // Points are drawn over terrain and 3D tiles, so the far side of the globe
  // has to be hidden by hand; only a moved camera changes the answer.
  function cullHorizon(force = false) {
    const camera = _viewer.camera.positionWC;
    if (!force && _culledFrom && C.Cartesian3.equals(camera, _culledFrom))
      return;
    _culledFrom = C.Cartesian3.clone(camera, _culledFrom || undefined);
    _occluder.cameraPosition = camera;
    let changed = false;
    for (const { entity, position } of _markers.values()) {
      const show = _occluder.isPointVisible(position);
      if (entity.show !== show) {
        entity.show = show;
        changed = true;
      }
    }
    if (changed) requestRender();
  }

  function syncHorizonListener() {
    const scene = _viewer?.scene;
    if (!_enabled || !_markers.size || !scene?.preRender) {
      _removePreRender?.();
      _removePreRender = null;
      return;
    }
    if (_removePreRender) return;
    _occluder ||= new C.EllipsoidalOccluder(
      C.Ellipsoid.WGS84,
      _viewer.camera.positionWC,
    );
    _removePreRender = scene.preRender.addEventListener(() => cullHorizon());
  }

  function styleMarker(country, entity) {
    const active = country.code === _selectedCode;
    entity.point.pixelSize = active
      ? PIN_SELECTED_PX
      : pinSize(country.channels);
    entity.point.color = C.Color.fromCssColorString(
      active ? PIN_SELECTED_COLOR : PIN_COLOR,
    );
    entity.point.outlineColor = active
      ? C.Color.fromCssColorString(PIN_COLOR)
      : C.Color.BLACK;
    entity.point.outlineWidth = active ? 3 : 1;
  }

  /** Name the busiest countries, and the chosen one, on the globe. */
  function publishLabels() {
    if (!overlayHost || !_enabled) return;
    const entries = _countries
      .filter(({ code }) => _markers.has(code))
      .map((country, rank) => ({ country, rank }))
      .filter(
        ({ country, rank }) =>
          rank < LABEL_LIMIT || country.code === _selectedCode,
      )
      .map(({ country, rank }) => {
        const active = country.code === _selectedCode;
        return {
          id: country.code,
          position: _markers.get(country.code).position,
          variant: 'label',
          title: liveTvLabelTitle(country),
          accent: PIN_COLOR,
          priority: (active ? 10_000 : 0) + LABEL_LIMIT - rank,
          protected: active,
          collisionGroup: 'ambient-label',
          paintLane: 'ambient-label',
          interactive: false,
          edgeFade: 'keyhole',
          horizonCull: true,
          terrainOcclusion: false,
          gapPx: 12,
          verticalOnly: true,
          placement: 'above',
        };
      })
      .sort((a, b) => b.priority - a.priority)
      .slice(0, LABEL_LIMIT + 1);
    _labelIds = entries.map(({ id }) => id);
    overlayHost.setEntries(LAYER_ID, entries, {
      cohortLimit: LABEL_LIMIT + 1,
      collisionCapacity: 16,
      moving: false,
    });
  }

  function clearLabels() {
    _labelIds = [];
    overlayHost?.clearSource(LAYER_ID);
    overlayHost?.setVisible(LAYER_ID, false);
  }

  function render() {
    const signature = JSON.stringify(
      _countries.map(({ code, lon, lat, channels }) => [
        code,
        lon,
        lat,
        channels,
      ]),
    );
    if (signature === _signature) return;
    _signature = signature;
    _dataSource.entities.removeAll();
    _entityCountries.clear();
    _markers.clear();
    for (const country of _countries) {
      const id = `${ENTITY_PREFIX}${country.code}`;
      const position = C.Cartesian3.fromDegrees(country.lon, country.lat, 0);
      const entity = _dataSource.entities.add(
        new C.Entity({
          id,
          name: country.name,
          position,
          point: {
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            pixelSize: pinSize(country.channels),
            color: C.Color.fromCssColorString(PIN_COLOR),
            outlineColor: C.Color.BLACK,
            outlineWidth: 1,
          },
        }),
      );
      _entityCountries.set(id, country.code);
      _markers.set(country.code, { entity, position, country });
      if (country.code === _selectedCode) styleMarker(country, entity);
    }
    syncHorizonListener();
    if (_removePreRender) cullHorizon(true);
    publishLabels();
    requestRender();
  }

  function stopPlayback() {
    if (!_channelId) return;
    _channelId = null;
    _status = null;
    ++_playSerial;
  }

  async function loadCountry(code) {
    _countryRequest?.abort();
    const request = new AbortController();
    _countryRequest = request;
    _channels = null;
    _countryError = null;
    notify();
    try {
      const { channels } = await source.getCountry(code, {
        signal: request.signal,
      });
      if (request.signal.aborted || _countryRequest !== request) return;
      _channels = channels;
    } catch (e) {
      if (request.signal.aborted || _countryRequest !== request) return;
      console.warn('[Data:LiveTV] Country fetch error:', e);
      _countryError = e?.message || 'Channel list unavailable';
    } finally {
      if (_countryRequest === request) _countryRequest = null;
      notify();
    }
  }

  function select(code) {
    if (_selectedCode === code) return;
    ++_navigationGeneration;
    const previous = _selectedCode;
    _selectedCode = code;
    _page = 0;
    stopPlayback();
    _countryRequest?.abort();
    _countryRequest = null;
    _channels = null;
    _countryError = null;
    for (const id of [previous, code]) {
      const marker = id && _markers.get(id);
      if (marker) styleMarker(marker.country, marker.entity);
    }
    publishLabels();
    requestRender();
    if (code) void loadCountry(code);
  }

  // Photorealistic 3D Tiles pick as tileset content without an entity id;
  // that is empty map, the same as no pick at all on the globe.
  const isSurfacePick = (picked) =>
    !picked ||
    (picked.id === undefined &&
      (picked.content !== undefined ||
        (typeof C.Cesium3DTileset === 'function' &&
          picked.primitive instanceof C.Cesium3DTileset)));

  function installSelection() {
    const canvas = _viewer?.scene?.canvas;
    if (
      _clickHandler ||
      !picking ||
      !canvas ||
      typeof C.ScreenSpaceEventHandler !== 'function'
    )
      return;
    const owner = new C.ScreenSpaceEventHandler(canvas);
    _clickHandler = owner;
    owner.setInputAction((click) => {
      // Ambient selection yields to draw tools and Director; it never claims
      // the pointer, camera or tracking state.
      if (
        !_enabled ||
        _clickHandler !== owner ||
        (pointer && !pointer.isPointerFree()) ||
        !click?.position
      )
        return;
      const picked = _viewer.scene.pick(click.position);
      const pickedId = picking.resolvePickId(picked);
      const code = pickedId ? _entityCountries.get(pickedId) : null;
      if (code) {
        layer.setParams({ country: code });
        return;
      }
      // A sibling layer's pick (an aircraft, a vessel) is not empty map.
      if (pickedId && picking.isOwnedByOtherLayer(LAYER_ID, pickedId)) return;
      // Clearing the country stops the player, so an empty-map click only
      // clears while nothing is playing.
      if (_selectedCode && !_channelId && isSurfacePick(picked))
        layer.setParams({ clear: true });
    }, C.ScreenSpaceEventType.LEFT_CLICK);
  }

  function removeSelection() {
    const owner = _clickHandler;
    _clickHandler = null;
    if (owner && !owner.isDestroyed?.()) owner.destroy();
  }

  function focusCountry(country) {
    if (!_runNavigation) return;
    const generation = ++_navigationGeneration;
    _runNavigation(() => {
      if (
        !_enabled ||
        generation !== _navigationGeneration ||
        _selectedCode !== country.code
      )
        return;
      return _viewer.camera.flyTo({
        destination: C.Cartesian3.fromDegrees(
          country.lon,
          country.lat,
          FOCUS_HEIGHT_M,
        ),
        duration: matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
          ? 0
          : 1.4,
      });
    });
  }

  function statusLine(channel) {
    if (!_status) return `${channel.name} · starting`;
    const attempt =
      _status.total > 1
        ? ` (stream ${_status.index + 1} of ${_status.total})`
        : '';
    if (_status.state === 'playing') return `▶ ${channel.name}${attempt}`;
    if (_status.state === 'connecting')
      return `${channel.name} · connecting${attempt}`;
    return `${channel.name} · stream unavailable: ${REASONS[_status.reason] || REASONS.error}. Try another channel.`;
  }

  function mediaDescriptor() {
    const channel = playingChannel();
    if (!channel) return null;
    const serial = _playSerial;
    return {
      key: `${channel.id}#${serial}`,
      label: `Live TV: ${channel.name}`,
      attach(video) {
        if (serial !== _playSerial) return () => {};
        const player = attachStreams(video, channel.streams, {
          onStatus(status) {
            if (serial !== _playSerial) return;
            _status = status;
            notify();
          },
        });
        return () => player.dispose();
      },
    };
  }

  function summaryLines() {
    const channels = _countries.reduce(
      (sum, { channels }) => sum + channels,
      0,
    );
    return [
      _countries.length
        ? `${plural(channels, 'channel')} in ${plural(_countries.length, 'country', 'countries')} · select a TV pin`
        : _lastUpdate
          ? 'No playable channels in the directory'
          : _lastError
            ? 'Channel directory unavailable'
            : 'Loading the channel directory…',
      _stale ? 'Directory is a cached copy' : '',
      _lastError && _countries.length
        ? `Last refresh failed: ${_lastError}`
        : '',
      CAVEAT,
    ].filter(Boolean);
  }

  function countryLines(country) {
    const channel = playingChannel();
    const list = filteredChannels();
    const pages = Math.max(1, Math.ceil(list.length / LIVE_TV_PAGE_SIZE));
    return [
      channel ? statusLine(channel) : '',
      `${country.name} · ${plural(country.channels, 'channel')}`,
      _countryError
        ? `Channel list unavailable: ${_countryError}`
        : !_channels
          ? 'Loading channels…'
          : list.length
            ? `Page ${_page + 1} of ${pages} · choose a channel to play it`
            : 'No news channels here',
      CAVEAT,
    ].filter(Boolean);
  }

  const layer = {
    id: LAYER_ID,
    name: 'Live TV',
    icon: '📺',
    source: 'iptv-org',
    updateInterval: 3_600_000,

    init(viewer) {
      if (_viewer) throw new Error('Live TV layer is already initialized');
      _viewer = viewer;
      _dataSource = new C.CustomDataSource(LAYER_ID);
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      overlayHost?.setVisible(LAYER_ID, false);
    },

    attachShellServices(services) {
      _runNavigation =
        typeof services?.runNavigation === 'function'
          ? services.runNavigation
          : null;
    },

    enable() {
      if (_enabled) return;
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      picking?.registerPickOwner(
        LAYER_ID,
        (id) => _enabled && _entityCountries.has(String(id)),
      );
      installSelection();
      syncHorizonListener();
      overlayHost?.setVisible(LAYER_ID, true);
      publishLabels();
    },

    disable() {
      _request?.abort();
      _request = null;
      _enabled = false;
      picking?.unregisterPickOwner(LAYER_ID);
      removeSelection();
      syncHorizonListener();
      _culledFrom = null;
      if (_selectedCode) select(null);
      stopPlayback();
      clearLabels();
      if (_dataSource) _dataSource.show = false;
      notify();
    },

    async update() {
      if (!_enabled || !_dataSource) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const snapshot = await source.getSnapshot({ signal: request.signal });
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        _countries = snapshot.countries;
        render();
        if (_selectedCode && !_markers.has(_selectedCode)) select(null);
        _stale = snapshot.stale === true;
        _lastUpdate = now();
        _lastError = null;
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:LiveTV] Fetch error:', e);
        _lastError = e?.message || 'Channel directory unavailable';
        return false;
      } finally {
        if (_request === request) _request = null;
        notify();
      }
    },

    setParams(params = {}) {
      if (!_enabled) return;
      if (params.clear === true || params.country === null) {
        select(null);
        notify();
        return;
      }
      if (typeof params.country === 'string' && _markers.has(params.country)) {
        select(params.country);
        notify();
        if (params.focus === true) focusCountry(selectedCountry());
        return;
      }
      if (params.stop === true) {
        stopPlayback();
        notify();
        return;
      }
      if (params.newsOnly !== undefined) {
        _newsOnly = params.newsOnly === true;
        _page = 0;
        notify();
        return;
      }
      if (params.page === 'next' || params.page === 'previous') {
        const pages = Math.ceil(filteredChannels().length / LIVE_TV_PAGE_SIZE);
        _page = Math.max(
          0,
          Math.min(pages - 1, _page + (params.page === 'next' ? 1 : -1)),
        );
        notify();
        return;
      }
      if (
        typeof params.channelId === 'string' &&
        _channels?.some(({ id }) => id === params.channelId)
      ) {
        // Picking the channel that is already playing restarts it: the
        // obvious retry after a stream dropped.
        _channelId = params.channelId;
        _status = null;
        ++_playSerial;
        notify();
        return;
      }
      if (params.projectPage === true) openExternal(PROJECT_PAGE);
    },

    getRowControls() {
      const country = selectedCountry();
      if (!country) {
        return {
          chips: [
            {
              id: 'project',
              label: 'iptv-org ↗',
              title:
                'Open the iptv-org project, the source of the channel list, in a new tab',
              params: { projectPage: true },
            },
          ],
          list: {
            ariaLabel: 'Countries with the most channels, most first',
            items: _countries
              .slice(0, COUNTRY_LIST_LIMIT)
              .map((entry, index) => ({
                id: entry.code,
                ordinal: index + 1,
                lead: entry.channels.toLocaleString('en-US'),
                text: entry.name,
                params: { country: entry.code, focus: true },
              })),
          },
          info: summaryLines().join(' · '),
          infoTitle: `Select a TV pin on the globe, or a country in the list, to list its channels. ${DISCLAIMER}`,
        };
      }
      const list = filteredChannels();
      const pages = Math.max(1, Math.ceil(list.length / LIVE_TV_PAGE_SIZE));
      const shown = list.slice(
        _page * LIVE_TV_PAGE_SIZE,
        (_page + 1) * LIVE_TV_PAGE_SIZE,
      );
      return {
        chips: [
          {
            id: 'news',
            label: 'News only',
            title: 'List only channels iptv-org files under news',
            active: _newsOnly,
            params: { newsOnly: !_newsOnly },
          },
          {
            id: 'previous',
            label: '‹ Prev',
            title: 'Previous page of channels',
            disabled: _page === 0,
            params: { page: 'previous' },
          },
          {
            id: 'next',
            label: 'Next ›',
            title: 'Next page of channels',
            disabled: _page >= pages - 1,
            params: { page: 'next' },
          },
          ...(_channelId
            ? [
                {
                  id: 'stop',
                  label: 'Stop',
                  title: 'Stop the stream and close the player',
                  params: { stop: true },
                },
              ]
            : []),
          {
            id: 'countries',
            label: 'All countries',
            title: 'Back to the country list',
            params: { clear: true },
          },
        ],
        list: {
          ariaLabel: `${country.name} channels, page ${_page + 1} of ${pages}`,
          items: shown.map((channel, index) => {
            const stream = channel.streams[0];
            const labels = [
              ...new Set(channel.streams.flatMap(({ labels }) => labels)),
            ];
            return {
              id: channel.id,
              ordinal: _page * LIVE_TV_PAGE_SIZE + index + 1,
              lead: channel.id === _channelId ? '▶' : stream.quality || 'TV',
              text: [
                channel.name,
                channel.categories.join(', '),
                labels.join(', '),
              ]
                .filter(Boolean)
                .join(' · '),
              active: channel.id === _channelId,
              params: { channelId: channel.id },
            };
          }),
        },
        media: mediaDescriptor(),
        info: countryLines(country).join(' · '),
        infoTitle: `Choose a channel to play it here. Nothing loads until you do. ${DISCLAIMER}`,
      };
    },

    setRowControlsListener(value) {
      _listener = typeof value === 'function' ? value : null;
    },

    getStats() {
      return {
        count: _countries.reduce((sum, { channels }) => sum + channels, 0),
        lastUpdate: _lastUpdate,
        error: _lastError,
        stale: _stale,
      };
    },

    getDiagnostics() {
      return {
        enabled: _enabled,
        requestPending: Boolean(_request),
        countryPending: Boolean(_countryRequest),
        selectionActive: _clickHandler !== null,
        horizonCulling: _removePreRender !== null,
        selectedCountry: _selectedCode,
        channelId: _channelId,
        playback: _status ? { ..._status } : null,
        entities: _markers.size,
        labels: [..._labelIds],
      };
    },

    destroy(viewer = _viewer) {
      layer.disable();
      _countries = [];
      _signature = null;
      _entityCountries.clear();
      _markers.clear();
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _viewer = null;
      _occluder = null;
      _culledFrom = null;
      _listener = null;
      _runNavigation = null;
      _lastUpdate = null;
      _lastError = null;
      _stale = false;
    },
  };
  return layer;
}
