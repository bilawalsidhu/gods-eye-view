import { findDraw, findFrame } from '../../render/rendererOf.js';
import { formatNumber, msg, t } from '../../i18n/index.js';
import { translateFeedError } from '../../ui/statusText.js';
import {
  AURORA_BANDS,
  AURORA_BAND_COLORS,
  AURORA_PROVENANCE,
  auroraBandCounts,
  auroraPixels,
  auroraReach,
} from './records.js';
export * from './records.js';
export { createAuroraSource } from './source.js';

/** Metres above the ellipsoid: the green oxygen line glows near 100–150 km. */
export const AURORA_SHELL_HEIGHT = 110_000;
const WORLD = Object.freeze({ west: -180, south: -90, east: 180, north: 90 });
let instances = 0;

const utcTime = (ms) => new Date(ms).toISOString().slice(11, 16);
const signed = (value) =>
  `${value > 0 ? '+' : value < 0 ? '−' : ''}${formatNumber(Math.abs(value))}`;

/**
 * Own one aurora display: NOAA SWPC's OVATION aurora forecast drawn as a
 * glowing shell above the globe, with the planetary Kp index, the NOAA
 * space-weather scales and the solar wind in its row. Share links use
 * token 03.
 */
export function createAuroraLayer({
  source,
  now = () => Date.now(),
  drawOf = findDraw,
  frameOf = findFrame,
  createCanvas = () => document.createElement('canvas'),
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Aurora layer requires a snapshot source');
  let _viewer = null;
  let _field = null;
  let _canvas = null;
  let _enabled = false;
  let _request = null;
  let _snapshot = null;
  let _counts = null;
  let _reach = null;
  let _lastUpdate = null;
  let _lastError = null;
  let _frame = 0;

  function draw(snapshot) {
    const { width, height, data } = auroraPixels(snapshot.grid);
    _canvas ??= createCanvas();
    _canvas.width = width;
    _canvas.height = height;
    const context = _canvas.getContext('2d');
    const image = context.createImageData(width, height);
    image.data.set(data);
    context.putImageData(image, 0, 0);
    // A new key each time: the renderer reads a canvas once per key.
    const ref = { canvas: _canvas, key: `aurora:${(_frame += 1)}` };
    if (_field) _field.update({ image: ref });
    else {
      const draws = drawOf(_viewer);
      if (typeof draws?.field !== 'function')
        throw new Error(msg('This renderer cannot draw the aurora'));
      _field = draws.field({
        kind: 'rasterShell',
        id: `aurora:${++instances}`,
        image: ref,
        rectangle: WORLD,
        heightM: AURORA_SHELL_HEIGHT,
        alpha: 1,
        detail: null,
        shows: 'aurora',
      });
      _field.show = _enabled;
    }
    frameOf(_viewer)?.requestRender?.('aurora');
  }

  const layer = {
    id: 'aurora',
    name: 'Aurora',
    icon: '🌌',
    source: 'NOAA SWPC',
    provenance: AURORA_PROVENANCE,
    // OVATION is rerun about every five minutes.
    updateInterval: 300000,

    init(viewer) {
      if (_viewer) throw new Error('Aurora layer is already initialized');
      _viewer = viewer;
    },

    enable() {
      _enabled = true;
      if (_field) _field.show = true;
    },

    disable() {
      _enabled = false;
      _request?.abort();
      _request = null;
      if (_field) _field.show = false;
    },

    async update(_viewerArg, { signal } = {}) {
      if (!_enabled || !_viewer || signal?.aborted) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      const onAbort = () => request.abort(signal.reason);
      signal?.addEventListener('abort', onAbort, { once: true });
      let snapshot;
      try {
        snapshot = await source.getSnapshot({ signal: request.signal });
      } catch (error) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:Aurora] Fetch error:', error);
        _lastError = error?.message || String(error);
        // The last forecast stays drawn; the next interval tries again. With
        // nothing drawn yet, a refusal that will not change fails the enable.
        return error?.retryable !== false || _snapshot !== null;
      } finally {
        signal?.removeEventListener('abort', onAbort);
        if (_request === request) _request = null;
      }
      if (request.signal.aborted || !_enabled) return false;
      // A renderer failure here is a real lifecycle failure, not a feed one.
      draw(snapshot);
      _snapshot = snapshot;
      _counts = auroraBandCounts(snapshot.grid);
      _reach = auroraReach(snapshot.grid, 10);
      _lastUpdate = snapshot.observedAt ?? now();
      _lastError = null;
      return true;
    },

    destroy() {
      layer.disable();
      _field?.dispose();
      _field = null;
      _canvas = null;
      _viewer = null;
      _snapshot = null;
      _counts = null;
      _reach = null;
      _lastUpdate = null;
      _lastError = null;
    },

    getRowControls() {
      const parts = [];
      const kp = _snapshot?.kp;
      if (kp)
        parts.push(
          t('Kp {kp}', { kp: formatNumber(Math.round(kp.value * 10) / 10) }),
        );
      const scales = _snapshot?.scales;
      if (scales)
        parts.push(
          ['g', 'r', 's']
            .filter((key) => scales[key] !== null)
            .map((key) => `${key.toUpperCase()}${scales[key]}`)
            .join(' '),
        );
      const wind = _snapshot?.solarWind;
      if (wind?.speedKms !== null && wind?.speedKms !== undefined)
        parts.push(
          t('Solar wind {speed} km/s', {
            speed: formatNumber(Math.round(wind.speedKms)),
          }),
        );
      if (wind?.bzNt !== null && wind?.bzNt !== undefined)
        parts.push(`Bz ${signed(wind.bzNt)} nT`);
      if (_reach?.north !== null && _reach?.north !== undefined)
        parts.push(
          t('Overhead to {lat}°N', { lat: formatNumber(_reach.north) }),
        );
      if (_snapshot?.forecastAt)
        parts.push(
          t('Forecast for {time} UTC', { time: utcTime(_snapshot.forecastAt) }),
        );
      if (_lastError) parts.push(translateFeedError(_lastError));
      return {
        chips: [],
        info: parts.join(' · '),
        infoTitle: t(
          'NOAA OVATION forecast of the chance of seeing aurora overhead, about 30 to 90 minutes ahead, drawn 110 km up. Kp is the planetary geomagnetic index (0 to 9); G, R and S are NOAA’s storm, radio blackout and radiation scales (0 to 5). A southward (negative) Bz feeds stronger aurora. Aurora is only visible from the ground at night under clear skies.',
        ),
        legend: [...AURORA_BANDS].reverse().map((band) => ({
          label: t('Chance of aurora ≥ {percent}%', {
            percent: formatNumber(band),
          }),
          color: AURORA_BAND_COLORS[band],
          count: _counts?.[band] ?? 0,
        })),
      };
    },

    getStats() {
      return {
        count: _counts?.[10] ?? 0,
        bands: _counts ? { ..._counts } : null,
        kp: _snapshot?.kp?.value ?? null,
        scales: _snapshot?.scales ? { ..._snapshot.scales } : null,
        solarWind: _snapshot?.solarWind ? { ..._snapshot.solarWind } : null,
        reach: _reach ? { ..._reach } : null,
        forecastAt: _snapshot?.forecastAt ?? null,
        lastUpdate: _lastUpdate,
        error: _lastError,
        provenance: AURORA_PROVENANCE,
        // OVATION reruns every few minutes; half an hour without one is stale.
        stale: _lastUpdate !== null && now() - _lastUpdate > 30 * 60000,
        // Load-bearing: without an explicit boolean, layerFeedState reads the
        // source name as a fallback (src/data/feedState.js).
        fallback: false,
      };
    },
  };
  return layer;
}
