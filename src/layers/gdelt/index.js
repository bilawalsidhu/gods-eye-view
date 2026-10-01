import * as Cesium from 'cesium';
import {
  GDELT_OVERLAY_SOURCE_ID,
  GDELT_OVERLAY_COHORT_LIMIT,
  GDELT_OVERLAY_COLLISION_CAPACITY,
  GDELT_MARKER_COLOR,
  createGdeltOverlayEntry,
  selectGdeltOverlayCohort,
  mapAnalystRecord,
} from './model.js';
export * from './model.js';
export { createGdeltEventsSource } from './source.js';

let _activeCardElement = null;

function ensureStyles() {
  if (document.getElementById('gev-osint-style')) return;
  const style = document.createElement('style');
  style.id = 'gev-osint-style';
  style.textContent = `
    @keyframes gevSlideUp {
      from { opacity: 0; transform: translateY(12px) scale(0.98); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }
    .gev-pill-btn {
      transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .gev-pill-btn:hover {
      transform: translateY(-1px);
      filter: brightness(1.15);
    }
    .gev-pill-btn:active {
      transform: translateY(0);
      filter: brightness(0.95);
    }
  `;
  document.head.appendChild(style);
}

function ensureCardUi() {
  ensureStyles();
  if (_activeCardElement) return _activeCardElement;
  const card = document.createElement('div');
  card.id = 'gev-osint-card';
  card.style.position = 'fixed';
  card.style.bottom = '32px';
  card.style.right = '32px';
  card.style.width = '380px';
  card.style.maxWidth = 'calc(100vw - 48px)';
  card.style.background = 'rgba(10, 14, 22, 0.88)';
  card.style.backdropFilter = 'blur(20px) saturate(180%)';
  card.style.webkitBackdropFilter = 'blur(20px) saturate(180%)';
  card.style.border = '1px solid rgba(0, 229, 255, 0.25)';
  card.style.borderRadius = '16px';
  card.style.padding = '20px';
  card.style.color = '#f1f5f9';
  card.style.fontFamily =
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
  card.style.zIndex = '9999';
  card.style.boxShadow =
    '0 20px 40px rgba(0, 0, 0, 0.6), 0 0 1px 1px rgba(0, 229, 255, 0.15)';
  card.style.display = 'none';
  card.style.animation =
    'gevSlideUp 0.25s cubic-bezier(0.16, 1, 0.3, 1) forwards';
  document.body.appendChild(card);
  _activeCardElement = card;
  return card;
}

function showOsintCard(entity, viewer) {
  const card = ensureCardUi();
  const p = entity.properties;
  const now = Cesium.JulianDate.now();
  const headline =
    p?.headline?.getValue(now) || entity.name || 'Unknown Headline';
  const url = p?.url?.getValue(now) || '';
  const domain = p?.domain?.getValue(now) || '';
  const time = p?.time?.getValue(now) || '';
  const tone = p?.tone?.getValue(now);

  const toneText =
    typeof tone === 'number'
      ? `${tone > 0 ? `+${tone.toFixed(1)}` : tone.toFixed(1)} (${tone < -1.5 ? 'Negative' : tone > 1.5 ? 'Positive' : 'Neutral'})`
      : null;

  card.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
      <div style="display: inline-flex; align-items: center; gap: 6px; background: rgba(0, 229, 255, 0.1); border: 1px solid rgba(0, 229, 255, 0.25); padding: 4px 10px; border-radius: 9999px;">
        <span style="display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: #00e5ff; box-shadow: 0 0 6px #00e5ff;"></span>
        <span style="color: #00e5ff; font-weight: 700; font-size: 10px; letter-spacing: 1.2px; text-transform: uppercase;">HEADLINE (UNVERIFIED)</span>
      </div>
      <button id="osint-close-btn" style="width: 26px; height: 26px; border-radius: 50%; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.12); color: #94a3b8; font-size: 12px; display: flex; align-items: center; justify-content: center; cursor: pointer; transition: all 0.15s;">✕</button>
    </div>

    <div style="font-size: 14px; font-weight: 600; line-height: 1.45; margin-bottom: 14px; color: #ffffff;">
      ${headline}
    </div>

    <div style="background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.07); padding: 10px 12px; border-radius: 12px; margin-bottom: 14px; font-size: 11px;">
      <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
        <span style="color: #64748b;">Source:</span>
        <strong style="color: #00e5ff;">${domain || 'Public Media'}</strong>
      </div>
      ${
        time
          ? `
      <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
        <span style="color: #64748b;">Reported:</span>
        <span style="color: #94a3b8;">${String(time).slice(0, 19).replace('T', ' ')}</span>
      </div>`
          : ''
      }
      ${
        toneText
          ? `
      <div style="display: flex; justify-content: space-between;">
        <span style="color: #64748b;">Reporting Tone:</span>
        <strong style="color: #f1f5f9;">${toneText}</strong>
      </div>`
          : ''
      }
    </div>

    <div style="font-size: 10px; color: #94a3b8; font-style: italic; margin-bottom: 16px; border-left: 2px solid rgba(0, 229, 255, 0.4); padding-left: 8px;">
      Headline report — not a verified incident.
    </div>

    <div style="display: flex; gap: 8px;">
      <button id="osint-fly-btn" class="gev-pill-btn" style="flex: 1.2; background: #00e5ff; border: none; color: #040914; padding: 10px 14px; font-size: 11px; font-weight: 700; letter-spacing: 0.8px; text-transform: uppercase; border-radius: 9999px; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 6px; box-shadow: 0 0 16px rgba(0, 229, 255, 0.35);">
        <span>FLY TO SECTOR</span>
      </button>
      ${
        url
          ? `
        <a href="${url}" target="_blank" rel="noopener noreferrer" class="gev-pill-btn" style="flex: 1; text-align: center; background: rgba(255, 255, 255, 0.08); border: 1px solid rgba(255, 255, 255, 0.15); color: #f1f5f9; padding: 10px 14px; font-size: 11px; font-weight: 600; letter-spacing: 0.5px; border-radius: 9999px; text-decoration: none; display: flex; align-items: center; justify-content: center; gap: 4px;">
          <span>SOURCE</span> ↗
        </a>
      `
          : ''
      }
    </div>
  `;

  card.style.display = 'block';

  document.getElementById('osint-close-btn').onclick = () => {
    card.style.display = 'none';
  };

  document.getElementById('osint-fly-btn').onclick = () => {
    viewer.flyTo(entity, {
      duration: 1.8,
      offset: new Cesium.HeadingPitchRange(
        0,
        Cesium.Math.toRadians(-45),
        450000,
      ),
    });
  };
}

function hideOsintCard() {
  if (_activeCardElement) _activeCardElement.style.display = 'none';
}

/** Unverified Global News & Headlines Layer. */
export function createGdeltLayer({ source, overlayHost } = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('GDELT layer requires a snapshot source');
  if (!overlayHost) throw new TypeError('GDELT layer requires an overlay host');

  let _viewer = null;
  let _request = null;
  let _dataSource = null;
  let _handler = null;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _lastStatus = 'unavailable';
  let _enabled = false;

  const layer = {
    id: 'gdelt-events',
    name: 'Global News (Unverified)',
    icon: '📰',
    source: 'GDELT 15m Cache',
    updateInterval: 15 * 60_000, // 15-minute cadence; does NOT refetch on camera move

    init(viewer) {
      if (_viewer) throw new Error('GDELT layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('gdelt-events');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _lastStatus = 'unavailable';
      _enabled = false;
      overlayHost.setVisible(GDELT_OVERLAY_SOURCE_ID, false);

      _handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);

      _handler.setInputAction((click) => {
        if (!_enabled) return;
        const picked = viewer.scene.pick(click.position);
        if (Cesium.defined(picked) && picked.id?.id?.startsWith('gdelt:')) {
          showOsintCard(picked.id, viewer);
        } else {
          hideOsintCard();
        }
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

      _handler.setInputAction((movement) => {
        if (!_enabled) return;
        const picked = viewer.scene.pick(movement.endPosition);
        if (Cesium.defined(picked) && picked.id?.id?.startsWith('gdelt:')) {
          viewer.canvas.style.cursor = 'pointer';
        } else if (viewer.canvas.style.cursor === 'pointer') {
          viewer.canvas.style.cursor = 'default';
        }
      }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

      console.log('[Data:GDELT] Initialized');
    },

    enable(viewer) {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost.setVisible(GDELT_OVERLAY_SOURCE_ID, true);
    },

    disable(viewer) {
      _request?.abort();
      _request = null;
      _enabled = false;
      hideOsintCard();
      if (_dataSource) _dataSource.show = false;
      overlayHost.clearSource(GDELT_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(GDELT_OVERLAY_SOURCE_ID, false);
      if (viewer?.canvas) viewer.canvas.style.cursor = 'default';
    },

    async update(viewer) {
      if (!_enabled || !_dataSource) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const result = await source.getSnapshot({ signal: request.signal });
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;

        const rows = result.rows || [];
        _lastStatus = result.status || 'ready';

        // Retain existing entities if upstream is rate-limited or fails so the globe never clears
        if (!rows.length && _count > 0) {
          _lastError = 'Rate limited (retaining cached headlines)';
          return true;
        }

        const nextEntities = [];
        let count = 0;
        const overlayEntries = [];

        for (const item of rows) {
          count++;
          const { stableId, lon, lat, name, url, domain, time, tone } = item;
          const position = Cesium.Cartesian3.fromDegrees(lon, lat);

          nextEntities.push(
            new Cesium.Entity({
              id: `gdelt:${stableId}`,
              name: name,
              position,
              ellipse: {
                semiMajorAxis: 35_000,
                semiMinorAxis: 35_000,
                material: new Cesium.ColorMaterialProperty(
                  GDELT_MARKER_COLOR.withAlpha(0.35),
                ),
                outline: true,
                outlineColor: GDELT_MARKER_COLOR.withAlpha(0.9),
                outlineWidth: 2,
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
              },
              properties: {
                stableId,
                headline: name,
                url,
                domain,
                time,
                tone: typeof tone === 'number' ? tone : null,
                verified: false,
              },
            }),
          );

          overlayEntries.push(
            createGdeltOverlayEntry({
              id: String(stableId),
              position,
              name,
            }),
          );
        }

        _dataSource.entities.removeAll();
        for (const entity of nextEntities) _dataSource.entities.add(entity);

        if (_enabled) {
          overlayHost.setEntries(
            GDELT_OVERLAY_SOURCE_ID,
            selectGdeltOverlayCohort(overlayEntries),
            {
              cohortLimit: GDELT_OVERLAY_COHORT_LIMIT,
              collisionCapacity: GDELT_OVERLAY_COLLISION_CAPACITY,
              moving: false,
            },
          );
        }

        _count = count;
        _lastUpdate = Date.now();
        _lastError = result.stale ? 'Serving stale cache (rate limited)' : null;
        console.log(`[Data:GDELT] Updated: ${_count} headlines`);
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:GDELT] Update notice:', e);
        _lastError = e?.message || null;
        _lastStatus = 'unavailable';
        return true;
      } finally {
        if (_request === request) _request = null;
      }
    },

    destroy(viewer = _viewer) {
      _request?.abort();
      _request = null;
      _viewer = null;
      _enabled = false;
      hideOsintCard();
      if (_handler) {
        _handler.destroy();
        _handler = null;
      }
      if (_activeCardElement) {
        _activeCardElement.remove();
        _activeCardElement = null;
      }
      overlayHost.clearSource(GDELT_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(GDELT_OVERLAY_SOURCE_ID, false);
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _lastStatus = 'unavailable';
    },

    getAnalystRecords(maxCount = 200) {
      if (!_dataSource || !_dataSource.show) return [];
      const entities = _dataSource.entities.values;
      if (!entities.length) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 200;
      const now = Cesium.JulianDate.now();
      const result = [];
      for (const entity of entities) {
        if (result.length >= limit) break;
        const cartesian = entity.position
          ? entity.position.getValue(now)
          : null;
        const carto = cartesian
          ? Cesium.Cartographic.fromCartesian(cartesian)
          : null;
        const p = entity.properties;
        result.push(
          mapAnalystRecord(
            {
              id: p?.stableId?.getValue(now) ?? null,
              name: p?.headline?.getValue(now),
              url: p?.url?.getValue(now),
              domain: p?.domain?.getValue(now),
              time: p?.time?.getValue(now),
              tone: p?.tone?.getValue(now),
              verified: false,
              lat: carto ? Cesium.Math.toDegrees(carto.latitude) : null,
              lon: carto ? Cesium.Math.toDegrees(carto.longitude) : null,
            },
            result.length,
          ),
        );
      }
      return result;
    },

    getStats() {
      return {
        count: _count,
        lastUpdate: _lastUpdate,
        status: _lastStatus,
        error: _lastError,
      };
    },
  };
  return layer;
}
