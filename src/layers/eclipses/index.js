import { fromDegrees, toLonLatH } from '../../geo/ellipsoid.js';
import { formatNumber, msg, t } from '../../i18n/index.js';
import { inputFor as defaultInputFor } from '../../input/dispatcher.js';
import { hexColor } from '../../render/color.js';
import {
  findCamera,
  findDraw,
  findFrame,
  findQuery,
} from '../../render/rendererOf.js';
import {
  centralPath,
  centralPoint,
  circumstancesAt,
  eclipseAt,
  fromGeodetic,
  nextEclipseIndex,
  penumbralSpan,
  shadowFrame,
  toGeodetic,
} from './besselian.js';
import {
  ECLIPSE_KINDS,
  KIND_COLORS,
  KIND_SHORT_LABELS,
  describeEclipse,
  eclipseDay,
  eclipseDayOfYear,
  KIND_LIST_LABELS,
  greatestLabel,
  utcClock,
} from './cards.js';
import {
  MOON_DISTANCE,
  MOON_RADIUS,
  lunarStateAt,
  moonAltitude,
  moonDirection,
  moonHorizon,
  sublunarPoint,
} from './lunar.js';
import { createSkyPanel } from './skyPanel.js';
import { skyViewAt } from './skyView.js';
import { visibilityLimit } from './visibility.js';
export * from './besselian.js';
export * from './cards.js';
export {
  createLunarEclipse,
  lunarStateAt,
  moonAltitude,
  moonHorizon,
  sublunarPoint,
} from './lunar.js';
export * from './skyView.js';
export * from './visibility.js';
export { createEclipseElementsSource } from './source.js';

export const ECLIPSE_PATHS_LAYER_ID = 'eclipse-paths';
export const ECLIPSE_PATHS_OVERLAY_SOURCE_ID = 'eclipse-paths';
/** World seconds per real second while the layer plays an eclipse. */
export const ECLIPSE_PLAY_RATE = 480;
/** The draw sets and the shadow field the layer owns, by id. */
const SET_IDS = Object.freeze({
  band: 'eclipse-paths:band',
  lines: 'eclipse-paths:lines',
  marks: 'eclipse-paths:marks',
  shadow: 'eclipse-paths:shadow',
});
/**
 * A line draped on the ground breaks into dots seen from far off, so above
 * this camera height each line is drawn just over the ground instead, where
 * the lift cannot be told from the surface.
 */
const LINE_FAR_M = 2_500_000;
const LINE_LIFT_M = 12_000;
/** How high the camera sits to take in the path, in metres. */
const FOCUS_HEIGHT_M = 9_500_000;
/** Eclipses listed in the row: a few before the chosen one, more after. */
const LIST_BEFORE = 2;
const LIST_AFTER = 5;
/** How often the path carries a time label, in ms. */
const MARK_EVERY_MS = 30 * 60_000;
/** While the shadow is on the Earth and the clock is live: repaint this often. */
const LIVE_TICK_MS = 1000;
/** The row's readout follows the shadow no faster than this. */
const ROW_TICK_MS = 500;
const OVERLAY_OPTIONS = Object.freeze({
  cohortLimit: 24,
  collisionCapacity: 24,
  moving: false,
});

/**
 * A round mark for a point on the path, as an SVG data URL: drawn large and
 * shown small, so it stays sharp on dense screens.
 */
export function pathMarkImage(fill, ring) {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 16 16">` +
    `<circle cx="8" cy="8" r="5.5" fill="${fill}" stroke="${ring}" stroke-width="2.4"/>` +
    `</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/**
 * The flag that marks where the sky view looks up from, as an SVG data URL.
 */
export function skyFlagImage(color = '#8fd3ff') {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="120" viewBox="0 0 24 30">` +
    `<path d="M5 2v27" stroke="#ffffff" stroke-width="2.4" stroke-linecap="round"/>` +
    `<path d="M6.4 3h13l-3.6 4.6 3.6 4.6h-13z" fill="${color}" stroke="#0b1420" stroke-width="1"/>` +
    `<circle cx="5" cy="28" r="2" fill="#ffffff" stroke="#0b1420" stroke-width="1"/>` +
    `</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** A palette colour mixed `amount` of the way to white, at `alpha`. */
function towardWhite(hex, amount, alpha) {
  const [r, g, b] = hexColor(hex);
  const mix = (value) => value + (1 - value) * amount;
  return [mix(r), mix(g), mix(b), alpha];
}

/** An `[x, y, z]` as a contract vector. */
const vector = ([x, y, z]) => ({ x, y, z });

/**
 * How dark the sky is for someone on the ground at Earth-fixed `point`, 0 to
 * 1, in step with the shader's shading of the ground itself.
 */
export function skyShadeAt(eclipse, ms, point) {
  const seen = circumstancesAt(eclipse, ms, point);
  if (!seen.sunUp) return 0;
  if (seen.central) return seen.total ? 0.93 : 0.6;
  return 0.6 * Math.min(1, seen.magnitude) ** 1.1;
}

/**
 * Eclipse paths: the Moon's shadow crossing the Earth at the world time, and
 * the path of one chosen solar eclipse, computed in the page from NASA's
 * Besselian elements.
 */
export function createEclipsePathsLayer({
  source,
  clock,
  overlayHost = null,
  // The sky view needs a page to stand in; without one the layer goes without.
  createSky = (viewer, options) =>
    viewer?.container && typeof document !== 'undefined'
      ? createSkyPanel(viewer.container, options)
      : null,
  // The partial eclipse's limit takes a moment to work out: it is drawn a
  // beat after the path, and only for an eclipse that is still the chosen one.
  defer = (work) => globalThis.setTimeout(work, 150),
  // A click on the globe moves the sky view's flag; without these the flag
  // stays where the eclipse peaks.
  inputFor = defaultInputFor,
  pointer = null,
  setInterval = globalThis.setInterval,
  clearInterval = globalThis.clearInterval,
  reducedMotion = () =>
    globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ===
    true,
} = {}) {
  if (typeof source?.getCatalog !== 'function')
    throw new TypeError('Eclipse paths require a catalogue source');
  if (typeof clock?.timeFor !== 'function')
    throw new TypeError('Eclipse paths require a world clock');
  const now = clock.timeFor(ECLIPSE_PATHS_LAYER_ID);
  let _viewer = null;
  let _enabled = false;
  // Every eclipse, solar and lunar, in time order; and the ones the row
  // walks, which a choice of Sun or Moon narrows.
  let _everything = null;
  let _catalog = null;
  let _bodies = 'all';
  let _loadedAt = null;
  let _lastError = null;
  let _index = -1;
  // What the layer draws: the band, its lines, the marks and flag, and the
  // shadow at the world time.
  let _band = null;
  let _lines = null;
  let _marks = null;
  let _shadow = null;
  let _shadowShown = false;
  // The path's lines as worked out; each is drawn draped or lifted.
  let _lineDefs = [];
  let _markItems = [];
  let _sky = null;
  let _skyWanted = true;
  // Where the sky view looks up from when the viewer has moved its flag;
  // null for where the chosen eclipse peaks.
  let _skySpot = null;
  let _clickOff = null;
  // The eclipse whose central line the camera has followed to its end.
  let _followedTo = null;
  // While the layer plays an eclipse, keep the camera over the shadow.
  let _follow = true;
  let _limitFor = null;
  // Whether the camera is high enough for the lifted lines; null before the
  // first frame.
  let _linesFar = null;
  let _active = null;
  let _releaseFollow = null;
  let _unsubscribe = null;
  let _removePreUpdate = null;
  let _timer = null;
  let _rowListener = null;
  let _rowAt = 0;
  let _runNavigation = null;
  let _request = null;
  // The layer started this playback, so the layer stops it at the end.
  let _playingTo = null;
  const _geometry = new Map();

  const render = () =>
    _viewer && findFrame(_viewer)?.requestRender?.(ECLIPSE_PATHS_LAYER_ID);
  const pose = () => (_viewer && findCamera(_viewer)?.pose?.()) || null;
  const notifyRow = () => _rowListener?.();
  const selected = () => _catalog?.[_index] ?? null;

  /** An eclipse's path and the hours its penumbra is on the Earth. */
  function geometryOf(eclipse) {
    let geometry = _geometry.get(eclipse.id);
    if (!geometry) {
      geometry =
        eclipse.body === 'lunar'
          ? {
              path: null,
              span: { startMs: eclipse.startMs, endMs: eclipse.endMs },
            }
          : { path: centralPath(eclipse), span: penumbralSpan(eclipse) };
      _geometry.set(eclipse.id, geometry);
    }
    return geometry;
  }

  /** The eclipse whose shadow is on the Earth at `ms`, if any. */
  function inProgress(ms) {
    const eclipse = _everything ? eclipseAt(_everything, ms) : null;
    if (!eclipse) return null;
    const { span } = geometryOf(eclipse);
    return ms >= span.startMs && ms <= span.endMs ? eclipse : null;
  }

  // ---- the chosen eclipse's path ----------------------------------------
  /**
   * One line, kept as worked out: drawn draped on the ground for a near
   * camera, lifted just over it for a far one (see LINE_FAR_M).
   */
  function addLine(id, points, widthPx, style) {
    _lineDefs.push({ id, points, widthPx, style });
  }

  function lineItem({ id, points, widthPx, style }, far) {
    return far
      ? {
          id,
          positions: points.map(({ lon, lat }) =>
            fromDegrees(lon, lat, LINE_LIFT_M),
          ),
          widthPx,
          mode: 'geodesic',
          style,
        }
      : {
          id,
          positions: points.map(({ lon, lat }) => fromDegrees(lon, lat)),
          widthPx,
          mode: 'draped',
          clampTo: 'both',
          style,
        };
  }

  const drawLines = () =>
    _lines?.set(_lineDefs.map((def) => lineItem(def, _linesFar === true)));

  /** Draw each line draped or lifted, by how high the camera is. */
  function syncLines() {
    const height = pose()?.height;
    if (!Number.isFinite(height) || !_lines) return;
    const far = height > LINE_FAR_M;
    if (far === _linesFar) return;
    _linesFar = far;
    drawLines();
  }

  /** The limit of the partial eclipse, drawn once it has been worked out. */
  function drawLimit(eclipse) {
    // Each request has its own identity: choosing the same eclipse again
    // before this one runs (A, B, A) leaves this one stale.
    const request = {};
    _limitFor = request;
    defer(() => {
      if (!_enabled || !_lines || selected() !== eclipse) return;
      if (_limitFor !== request) return;
      const geometry = geometryOf(eclipse);
      geometry.limit ??= visibilityLimit(eclipse);
      const color = hexColor(KIND_COLORS[eclipse.kind], 0.85);
      geometry.limit.forEach((line, index) => {
        addLine(
          `eclipse-path:limit:${index}`,
          // Not quite to the poles, where every longitude is one point.
          line.map(({ lat, lon }) => ({
            lon,
            lat: Math.max(-89.9, Math.min(89.9, lat)),
          })),
          2,
          { kind: 'dash', color, length: 12 },
        );
      });
      drawLines();
      render();
    });
  }

  /**
   * A lunar eclipse on the globe: the lines where the Moon sits on the horizon
   * as the eclipse begins and ends. Between them the whole eclipse is seen;
   * outside both, none of it.
   */
  function drawLunar(eclipse) {
    const hex = KIND_COLORS[eclipse.kind];
    const lines = [
      ['penumbral', eclipse.contacts.penumbral, true],
      ['umbral', eclipse.contacts.partial, false],
    ];
    for (const [name, contacts, dashed] of lines) {
      if (!contacts) continue;
      contacts.forEach((ms, index) => {
        addLine(
          `eclipse-path:horizon:${name}:${index}`,
          moonHorizon(eclipse, ms),
          2,
          dashed
            ? { kind: 'dash', color: hexColor(hex, 0.8), length: 12 }
            : { kind: 'solid', color: hexColor(hex, 0.85) },
        );
      });
    }
  }

  /** A round mark on the ground; `size` in CSS pixels. */
  const markItem = (id, lon, lat, image, size) => ({
    id,
    pos: { lon, lat },
    height: 'clampGround',
    image,
    size: [size, size],
    disableDepthTest: Number.POSITIVE_INFINITY,
  });

  function drawPath() {
    if (!_lines) return;
    _lineDefs = [];
    _markItems = [];
    _band?.clear();
    _limitFor = null;
    const eclipse = selected();
    const entries = [];
    if (eclipse && _enabled) {
      const hex = KIND_COLORS[eclipse.kind];
      const lunar = eclipse.body === 'lunar';
      const { path } = geometryOf(eclipse);
      if (lunar) drawLunar(eclipse);
      if (path) {
        _band?.set([
          {
            id: 'eclipse-path:band',
            geometry: {
              kind: 'polygon',
              rings: [
                path.outline.slice(0, -1).map(({ lon, lat }) => ({ lon, lat })),
              ],
            },
            fill: hexColor(hex, 0.26),
            height: 'clampGround',
            clampTo: 'both',
          },
        ]);
        // One closed line round the band: both edges and its rounded ends.
        addLine('eclipse-path:edge', path.outline, 2, {
          kind: 'solid',
          color: hexColor(hex, 0.75),
        });
        addLine('eclipse-path:center', path.center, 3, {
          kind: 'solid',
          color: towardWhite(hex, 0.45, 1),
        });
        // A time label each half hour of the clock along the central line.
        let next = Math.ceil(path.startMs / MARK_EVERY_MS) * MARK_EVERY_MS;
        for (const point of path.center) {
          if (point.ms < next) continue;
          next += MARK_EVERY_MS;
          _markItems.push(
            markItem(
              `eclipse-path:mark:${point.ms}`,
              point.lon,
              point.lat,
              pathMarkImage('#ffffff', hex),
              10,
            ),
          );
          entries.push({
            id: `eclipse-mark:${point.ms}`,
            position: fromDegrees(point.lon, point.lat),
            variant: 'label',
            title: utcClock(point.ms),
            accent: hex,
            priority: 1,
            collisionGroup: 'ambient-label',
            paintLane: 'ambient-label',
            interactive: false,
            edgeFade: 'keyhole',
            horizonCull: true,
            terrainOcclusion: false,
            gapPx: 12,
            verticalOnly: true,
            placement: 'above',
          });
        }
      }
      if (!lunar) drawLimit(eclipse);
      const { lon, lat } = eclipse.greatest;
      _markItems.push(
        markItem(
          'eclipse-path:greatest',
          lon,
          lat,
          pathMarkImage(hex, '#ffffff'),
          15,
        ),
      );
      // A small label at the peak; the facts are in the layer's row, so the
      // shadow's core stays in view.
      entries.push({
        id: `eclipse-greatest:${eclipse.id}`,
        position: fromDegrees(lon, lat),
        variant: 'label',
        title: greatestLabel(eclipse),
        accent: hex,
        priority: 1000,
        collisionGroup: 'ambient-label',
        paintLane: 'ambient-label',
        interactive: false,
        edgeFade: 'keyhole',
        horizonCull: true,
        terrainOcclusion: false,
        gapPx: 16,
        verticalOnly: true,
        placement: 'below',
      });
    }
    drawLines();
    overlayHost?.setEntries(
      ECLIPSE_PATHS_OVERLAY_SOURCE_ID,
      entries,
      OVERLAY_OPTIONS,
    );
    drawFlag();
    render();
  }

  function select(index, { focus = false } = {}) {
    if (!_catalog?.length) return;
    const next = Math.min(_catalog.length - 1, Math.max(0, index));
    const changed = next !== _index;
    _index = next;
    if (changed) {
      // Another eclipse: the flag goes to where this one peaks.
      _skySpot = null;
      drawPath();
      clock.coverageChanged?.();
      notifyRow();
    }
    if (focus) flyToSelected();
  }

  /**
   * The ground under the eclipse at `ms`: where the shadow's axis falls, or
   * for a lunar eclipse where the Moon is overhead. Null while the axis
   * misses the Earth.
   */
  function underPoint(eclipse, ms) {
    if (eclipse.body === 'lunar') return sublunarPoint(eclipse, ms);
    const point = centralPoint(eclipse, ms);
    return point ? toGeodetic(point) : null;
  }

  function flyToSelected() {
    const eclipse = selected();
    const viewer = _viewer;
    const camera = viewer && findCamera(viewer);
    if (!eclipse || !camera) return;
    // The shadow if it is on the ground now, else where the eclipse peaks.
    const ms = now();
    const { lat, lon } =
      (_active === eclipse ? underPoint(eclipse, ms) : null) ??
      eclipse.greatest;
    const fly = () =>
      camera.flyTo(
        { lon, lat, height: FOCUS_HEIGHT_M },
        { durationS: reducedMotion() ? 0 : 1.6 },
      );
    if (_runNavigation) _runNavigation(fly);
    else fly();
  }

  // ---- the shadow at the world time ---------------------------------------
  function skyShade(eclipse, ms) {
    const eye = pose();
    if (!eye || !(eye.height < 200_000)) return 0;
    const point = fromGeodetic(eye.lat, eye.lon);
    // Full on the ground, gone by the edge of space.
    const low = 1 - Math.min(1, Math.max(0, (eye.height - 20_000) / 180_000));
    return skyShadeAt(eclipse, ms, point) * low;
  }

  /**
   * Where the sky view looks up from: the flag, which stands where the
   * eclipse peaks until the viewer moves it.
   */
  function skySpot(eclipse) {
    if (_skySpot) return _skySpot;
    const { lat, lon } = eclipse.greatest;
    return { lat, lon, point: fromGeodetic(lat, lon) };
  }

  /** Stand the flag at the sky view's place, or take it away. */
  function drawFlag() {
    if (!_marks) return;
    const eclipse = selected();
    const items = [..._markItems];
    if (eclipse && _enabled && _skyWanted) {
      const { lat, lon } = skySpot(eclipse);
      items.push({
        id: 'eclipse-sky:flag',
        pos: { lon, lat },
        height: 'clampGround',
        image: skyFlagImage(),
        size: [24, 30],
        // The foot of the pole stands on the spot.
        anchor: 'bottom',
        pixelOffset: { x: 7, y: 0 },
        disableDepthTest: Number.POSITIVE_INFINITY,
      });
    }
    _marks.set(items);
    render();
  }

  /** A click on the globe moves the flag there. */
  function installClickHandler() {
    if (_clickOff || !inputFor || !_viewer) return;
    _clickOff = inputFor(_viewer).onClick((event) => {
      const at = event?.screenPosition;
      console.debug(at, event?.topHit, pointer?.isPointerFree());
      if (!_enabled || !_skyWanted || !selected() || !at) return;
      if (pointer && !pointer.isPointerFree()) return;
      // A click on another layer's object is that layer's.
      const hit = event.topHit;
      if (hit && !hit.surface && !String(hit.id).startsWith('eclipse-')) return;
      const ground = findQuery(_viewer)?.pickEllipsoid(at.x, at.y);
      const where = ground ? toLonLatH(ground) : null;
      if (!where) return;
      const { lat, lon } = where;
      _skySpot = { lat, lon, point: fromGeodetic(lat, lon) };
      drawFlag();
      syncShadow();
    });
  }

  /** The sky view: the Sun as seen from the centre of the screen. */
  function syncSky(active, ms) {
    if (!_sky) return;
    const spot = active && _skyWanted ? skySpot(active) : null;
    if (!spot) {
      _sky.hide();
      return;
    }
    const place = t('Seen from {lat}°, {lon}°', {
      lat: formatNumber(spot.lat, { maximumFractionDigits: 1 }),
      lon: formatNumber(spot.lon, { maximumFractionDigits: 1 }),
    });
    if (active.body === 'lunar') {
      const state = lunarStateAt(active, ms);
      const up = moonAltitude(active, ms, spot.lat, spot.lon) > 0;
      _sky.show({
        view: {
          lunar: true,
          phase: state.phase,
          // In Moon radii: where the Moon stands from the shadow, and the
          // shadow's two radii.
          x: state.x / MOON_RADIUS,
          y: state.y / MOON_RADIUS,
          umbraRadius: active.umbraRadius / MOON_RADIUS,
          penumbraRadius: active.penumbraRadius / MOON_RADIUS,
          below: !up,
        },
        title: t('Sky view'),
        close: t('Close the sky view'),
        lines: [
          place,
          !up
            ? t('The Moon is below the horizon here')
            : state.phase === 'total'
              ? t('Totality')
              : state.phase === 'partial'
                ? t('{percent}% of the Moon in the umbra', {
                    percent: formatNumber(
                      Math.min(99, Math.round(state.umbral * 100)),
                    ),
                  })
                : t('The Moon is in the penumbra'),
        ],
      });
      return;
    }
    const view = skyViewAt(active, ms, spot.point);
    const night = view.sunAltitude < -0.6;
    const seen = night
      ? t('The Sun is below the horizon here')
      : view.phase === 'total'
        ? t('Totality')
        : view.phase === 'annular'
          ? t('Annularity')
          : view.phase === 'partial'
            ? t('{percent}% of the Sun covered', {
                // Short of totality there is always a sliver left.
                percent: formatNumber(
                  Math.min(99, Math.round(view.covered * 100)),
                ),
              })
            : t('No eclipse at this spot');
    _sky.show({
      view: { ...view, night },
      title: t('Sky view'),
      close: t('Close the sky view'),
      lines: [place, seen],
    });
  }

  /** Bring the shadow, and which eclipse it belongs to, up to the world time. */
  function syncShadow() {
    if (!_enabled) return;
    const ms = now();
    const active = inProgress(ms);
    syncLines();
    if (
      _follow &&
      active?.body === 'solar' &&
      _playingTo !== null &&
      clock.isPlaying()
    )
      followShadow(active, ms);
    if (active?.body === 'lunar') {
      const state = lunarStateAt(active, ms);
      const moon = moonDirection(active, ms);
      _shadow?.update({
        solar: null,
        lunar: {
          moon: [...moon.map((value) => value * MOON_DISTANCE), MOON_RADIUS],
          depth: Math.max(0, Math.min(1, state.umbral)),
        },
      });
    } else if (active) {
      const frame = shadowFrame(active, ms);
      _shadow?.update({
        lunar: null,
        solar: {
          origin: vector(frame.origin),
          axis: vector(frame.k),
          cones: [frame.l1, frame.l2, frame.tanF1, frame.tanF2],
          skyShade: skyShade(active, ms),
        },
      });
    } else if (_shadowShown) _shadow?.update({ solar: null, lunar: null });
    _shadowShown = Boolean(active && _shadow);
    syncSky(active, ms);
    if (active !== _active) {
      _active = active;
      // The clock reached another eclipse: its path is the one to show.
      // (One the row is not showing keeps its shadow, but not the choice.)
      const index = active ? _catalog.indexOf(active) : -1;
      if (index >= 0 && active !== selected()) select(index);
      syncTimer();
      notifyRow();
    } else if (active && ms - _rowAt >= ROW_TICK_MS) {
      _rowAt = ms;
      notifyRow();
    }
    if (_playingTo !== null && ms >= _playingTo) {
      const end = _playingTo;
      _playingTo = null;
      // Hold on the last moment of the eclipse rather than run on past it.
      clock.pause();
      clock.seek(end);
    }
  }

  // Live, nothing tells the layer the time moved: while the shadow is on the
  // Earth, repaint each second so it keeps pace.
  function syncTimer() {
    const wanted = _enabled && Boolean(_active);
    if (wanted && _timer === null) _timer = setInterval(render, LIVE_TICK_MS);
    else if (!wanted && _timer !== null) {
      clearInterval(_timer);
      _timer = null;
    }
  }

  function play() {
    const eclipse = selected();
    if (!eclipse) return;
    const { span } = geometryOf(eclipse);
    const ms = now();
    // From where the clock stands if that is inside the eclipse, else from
    // the start.
    const from =
      !clock.isLive() && ms >= span.startMs && ms < span.endMs - 1000
        ? ms
        : span.startMs;
    clock.pause();
    clock.seek(from);
    _playingTo = span.endMs;
    clock.play({ rate: ECLIPSE_PLAY_RATE, continuous: true });
    // Following, the camera goes with the shadow from its first frame.
    if (!_follow || eclipse.body !== 'solar') flyToSelected();
  }

  /** Keep the camera over the shadow, at the height and tilt it has. */
  function followShadow(eclipse, ms) {
    const camera = _viewer && findCamera(_viewer);
    const eye = camera?.pose?.();
    if (!Number.isFinite(eye?.height)) return;
    // The camera rides the central line and no farther: it waits at the
    // line's start until the umbra lands there, and stays at its end once the
    // umbra has left, though the penumbra is still crossing the Earth.
    const { path } = geometryOf(eclipse);
    if (path && ms > path.endMs) {
      if (_followedTo === eclipse.id) return;
      _followedTo = eclipse.id;
    } else _followedTo = null;
    const along = path
      ? ms <= path.startMs
        ? path.center[0]
        : ms >= path.endMs
          ? path.center.at(-1)
          : null
      : null;
    // Where the axis meets the ground; with no central line (a partial
    // eclipse), the ground nearest the axis.
    const { lat, lon } =
      along ??
      underPoint(eclipse, ms) ??
      toGeodetic(shadowFrame(eclipse, ms).origin);
    camera.setView({
      destination: { lon, lat, height: eye.height },
      orientation: { heading: eye.heading, pitch: eye.pitch, roll: eye.roll },
    });
  }

  const isPlaying = () => _playingTo !== null && clock.isPlaying();

  const unregister = clock.register?.({
    id: ECLIPSE_PATHS_LAYER_ID,
    // The timeline runs over the chosen eclipse, with its peak marked.
    coverage: () => {
      const eclipse = _enabled ? selected() : null;
      if (!eclipse) return null;
      const { span } = geometryOf(eclipse);
      return {
        start: span.startMs,
        end: span.endMs,
        marks: [eclipse.greatestMs],
      };
    },
  });

  /** The eclipses the row walks for a choice of `all`, `solar` or `lunar`. */
  const listed = (bodies) =>
    bodies === 'all'
      ? _everything
      : _everything.filter(({ body }) => body === bodies);

  /** Narrow the row to the Sun's eclipses, the Moon's, or both. */
  function showBodies(bodies) {
    if (bodies === _bodies || !_everything) return;
    const before = selected();
    _bodies = bodies;
    _catalog = listed(bodies);
    // Keep the chosen eclipse if it is still listed, else the next to come.
    const kept = before ? _catalog.indexOf(before) : -1;
    _index = -1;
    select(
      kept >= 0
        ? kept
        : nextEclipseIndex(_catalog, before?.greatestMs ?? now()),
    );
    notifyRow();
  }

  function listItems() {
    if (!_catalog || _index < 0) return [];
    const first = Math.max(
      0,
      Math.min(
        _index - LIST_BEFORE,
        _catalog.length - LIST_BEFORE - LIST_AFTER - 1,
      ),
    );
    return _catalog
      .slice(first, first + LIST_BEFORE + LIST_AFTER + 1)
      .map((eclipse) => ({
        id: eclipse.id,
        lead: String(eclipse.year),
        // A Sun or a Moon in front tells the two kinds of eclipse apart.
        // The year stands in front already; the Sun or Moon says which kind.
        text: `${eclipse.body === 'lunar' ? '🌙' : '☀️'} ${eclipseDayOfYear(eclipse)} · ${t(KIND_LIST_LABELS[eclipse.kind])}`,
        active: eclipse === selected(),
        params: { eclipse: eclipse.id, focus: true },
      }));
  }

  function infoText() {
    const eclipse = selected();
    if (!eclipse) return '';
    const { title, details } = describeEclipse(eclipse);
    const lines = [title, ...details.slice(0, -2)];
    if (_active === eclipse)
      lines.push(
        eclipse.body === 'lunar'
          ? t('The Moon is in the Earth’s shadow: {time}', {
              time: utcClock(now()),
            })
          : t('The shadow is on the Earth: {time}', { time: utcClock(now()) }),
      );
    return lines.join(' · ');
  }

  const layer = {
    id: ECLIPSE_PATHS_LAYER_ID,
    name: 'Eclipse Paths',
    icon: '🌘',
    source: 'NASA GSFC',
    // The catalogue ships with the app: nothing to refresh.
    updateInterval: 24 * 60 * 60 * 1000,

    init(viewer, services = {}) {
      if (_viewer)
        throw new Error('Eclipse paths layer is already initialized');
      _viewer = viewer;
      _runNavigation =
        typeof services?.runNavigation === 'function'
          ? services.runNavigation
          : null;
      const draw = findDraw(viewer);
      if (draw) {
        _band = draw.shapes({ id: SET_IDS.band, show: false });
        _lines = draw.lines({ id: SET_IDS.lines, show: false });
        // Drawn over the ground they stand on, and hidden past the horizon.
        _marks = draw.icons({
          id: SET_IDS.marks,
          show: false,
          horizonCull: true,
        });
        _shadow =
          draw.field?.({
            kind: 'eclipseShadow',
            id: SET_IDS.shadow,
            solar: null,
            lunar: null,
            show: false,
          }) ?? null;
      }
      // The sky view's own close button does what its row chip does.
      _sky = createSky(viewer, {
        onClose: () => layer.setParams({ sky: false }),
      });
      overlayHost?.setVisible?.(ECLIPSE_PATHS_OVERLAY_SOURCE_ID, false);
    },

    enable() {
      if (_enabled) return;
      _enabled = true;
      for (const part of [_band, _lines, _marks, _shadow])
        if (part) part.show = true;
      overlayHost?.setVisible?.(ECLIPSE_PATHS_OVERLAY_SOURCE_ID, true);
      _releaseFollow = clock.hold?.(ECLIPSE_PATHS_LAYER_ID) ?? null;
      _unsubscribe = clock.subscribe?.(render) ?? null;
      installClickHandler();
      _removePreUpdate =
        (_viewer && findFrame(_viewer)?.on('preUpdate', syncShadow)) ?? null;
      drawPath();
      clock.coverageChanged?.();
      syncShadow();
      render();
    },

    disable() {
      if (!_enabled) return;
      _enabled = false;
      _request?.abort();
      _request = null;
      if (_playingTo !== null) {
        _playingTo = null;
        clock.pause();
      }
      _clickOff?.();
      _clickOff = null;
      _removePreUpdate?.();
      _removePreUpdate = null;
      _unsubscribe?.();
      _unsubscribe = null;
      _releaseFollow?.();
      _releaseFollow = null;
      _active = null;
      syncTimer();
      _shadow?.update({ solar: null, lunar: null });
      _shadowShown = false;
      _sky?.hide();
      for (const part of [_band, _lines, _marks, _shadow])
        if (part) part.show = false;
      overlayHost?.setEntries(
        ECLIPSE_PATHS_OVERLAY_SOURCE_ID,
        [],
        OVERLAY_OPTIONS,
      );
      overlayHost?.setVisible?.(ECLIPSE_PATHS_OVERLAY_SOURCE_ID, false);
      clock.coverageChanged?.();
      render();
    },

    async update() {
      if (!_enabled) return false;
      if (_catalog) return true;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const [solar, lunar] = await Promise.all([
          source.getCatalog({ signal: request.signal }),
          // A source without the Moon's catalogue still shows the Sun's.
          source.getLunarCatalog?.({ signal: request.signal }) ?? [],
        ]);
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        _everything = [...solar, ...lunar].sort(
          (a, b) => a.greatestMs - b.greatestMs,
        );
        const catalog = listed(_bodies);
        _catalog = catalog;
        _loadedAt = Date.now();
        _lastError = null;
        // The eclipse under way, or the next one to come.
        if (_index < 0) select(nextEclipseIndex(catalog, now()));
        syncShadow();
        notifyRow();
        return true;
      } catch (error) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:Eclipses] Load error:', error);
        _lastError = msg('Eclipse elements unavailable');
        notifyRow();
        return false;
      } finally {
        if (_request === request) _request = null;
      }
    },

    destroy() {
      layer.disable();
      unregister?.();
      for (const part of [_band, _lines, _marks, _shadow]) part?.dispose();
      _band = _lines = _marks = _shadow = null;
      _shadowShown = false;
      _sky?.destroy();
      _sky = null;
      overlayHost?.clearSource?.(ECLIPSE_PATHS_OVERLAY_SOURCE_ID);
      _viewer = null;
      _rowListener = null;
      _runNavigation = null;
      _geometry.clear();
    },

    /** The chosen eclipse, by the day of its peak (`YYYY-MM-DD`, UTC). */
    getParams() {
      return {
        eclipse: selected()?.id ?? null,
        sky: _skyWanted,
        follow: _follow,
        bodies: _bodies,
      };
    },

    /**
     * `eclipse` chooses one by its day, `year` the first of that year (or
     * the next after it), `step` moves that many along the
     * catalogue, `focus` flies to it, `follow` keeps the camera over the shadow while it plays, and `play` runs the world clock through
     * it (or pauses).
     */
    setParams(params = {}) {
      if (!_catalog) return false;
      if (typeof params.eclipse === 'string') {
        const index = _catalog.findIndex(({ id }) => id === params.eclipse);
        if (index < 0) return false;
        select(index, { focus: params.focus === true });
      } else if (Number.isFinite(params.year)) {
        // The first eclipse of that year, or the next one after it.
        const index = _catalog.findIndex(({ year }) => year >= params.year);
        select(index < 0 ? _catalog.length - 1 : index, {
          focus: params.focus === true,
        });
      } else if (Number.isInteger(params.step) && params.step !== 0)
        select(_index + params.step, { focus: params.focus === true });
      else if (params.focus === true) flyToSelected();
      if (['all', 'solar', 'lunar'].includes(params.bodies))
        showBodies(params.bodies);
      if (typeof params.sky === 'boolean' && params.sky !== _skyWanted) {
        _skyWanted = params.sky;
        drawFlag();
        render();
      }
      if (typeof params.follow === 'boolean' && params.follow !== _follow) {
        _follow = params.follow;
        render();
      }
      if (params.play === true) play();
      else if (params.play === false && _playingTo !== null) {
        _playingTo = null;
        clock.pause();
      }
      notifyRow();
      return true;
    },

    setRowControlsListener(listener) {
      _rowListener = typeof listener === 'function' ? listener : null;
    },

    getRowControls() {
      const eclipse = selected();
      if (!eclipse) return { chips: [] };
      const playing = isPlaying();
      return {
        chips: [
          {
            id: 'previous',
            label: t('‹ Earlier'),
            title: t('The eclipse before this one'),
            disabled: _index <= 0,
            params: { step: -1, focus: true },
          },
          {
            id: 'next',
            label: t('Later ›'),
            title: t('The eclipse after this one'),
            disabled: _index >= _catalog.length - 1,
            params: { step: 1, focus: true },
          },
          // Each group of chips starts its own line, sized to fit the row in
          // the longer languages: step by eclipse, step by century, watch it,
          // and the camera.
          {
            id: 'century-back',
            label: t('−100 years'),
            title: t('A century earlier'),
            disabled: eclipse.year - 100 < _catalog[0].year,
            params: { year: eclipse.year - 100 },
            breakBefore: true,
          },
          {
            id: 'century-forward',
            label: t('+100 years'),
            title: t('A century later'),
            disabled: eclipse.year + 100 > _catalog.at(-1).year,
            params: { year: eclipse.year + 100 },
          },
          {
            id: 'play',
            label: playing ? t('❚❚ Pause') : t('▶ Play'),
            title: t(
              'Run the world clock through this eclipse and watch the shadow cross the Earth',
            ),
            active: playing,
            params: { play: !playing },
            breakBefore: true,
          },
          {
            id: 'sky',
            label: t('Sky view'),
            title: t(
              'Show the eclipse as seen from the flag on the globe: it stands where the eclipse peaks, and a click on the globe moves it',
            ),
            active: _skyWanted,
            params: { sky: !_skyWanted },
          },
          // The camera follows the Moon's shadow; a lunar eclipse has none
          // on the Earth to follow.
          ...(eclipse.body === 'solar'
            ? [
                {
                  id: 'follow',
                  label: t('Follow shadow'),
                  title: t(
                    'While the eclipse plays, keep the camera over the shadow',
                  ),
                  active: _follow,
                  params: { follow: !_follow },
                  breakBefore: true,
                },
              ]
            : []),
        ],
        segmented: {
          id: 'bodies',
          ariaLabel: t('Which eclipses to list'),
          options: [
            ['all', t('All', { context: 'eclipse filter' })],
            ['solar', t('Solar')],
            ['lunar', t('Lunar')],
          ].map(([bodies, label]) => ({
            id: `bodies-${bodies}`,
            label,
            active: bodies === _bodies,
            params: { bodies },
          })),
        },
        slider: (() => {
          // One century on the slider, so a year is easy to land on; the
          // chips above step a century at a time.
          const century = Math.floor(eclipse.year / 100) * 100;
          const from = Math.max(_catalog[0].year, century);
          const to = Math.min(_catalog.at(-1).year, century + 99);
          return {
            id: 'year',
            label: t('Year · {from}–{to}', { from, to }),
            ariaLabel: t('Year of the eclipse to show'),
            valueText: String(eclipse.year),
            min: from,
            max: to,
            step: 1,
            value: eclipse.year,
            params: (value) => ({ year: Number(value) }),
          };
        })(),
        list: {
          ariaLabel: t('Solar eclipses around the chosen one'),
          items: listItems(),
        },
        legendCategorical: true,
        legend: ECLIPSE_KINDS.map((kind) => ({
          label: t(KIND_SHORT_LABELS[kind]),
          color: KIND_COLORS[kind],
        })),
        info: infoText(),
        infoTitle: t(
          'The band is where the eclipse is total or annular; the line down its middle is where it lasts longest. The shaded disc is the Moon’s shadow at the world time: the nearer its dark core, the more of the Sun is covered. Move the world clock, or press Play, to watch it cross. Predictions by Fred Espenak and Jean Meeus (NASA’s GSFC).',
        ),
      };
    },

    getStats() {
      return {
        count: _everything?.length ?? 0,
        lastUpdate: _loadedAt,
        error: _lastError,
      };
    },

    /** The catalogue as plain JSON-safe records, for tools and QA. */
    getAnalystRecords(maxCount = 2000) {
      if (!_enabled || !_catalog) return [];
      return _catalog.slice(0, maxCount).map((eclipse) => ({
        id: eclipse.id,
        body: eclipse.body,
        kind: eclipse.kind,
        greatestMs: eclipse.greatestMs,
        lat: eclipse.greatest.lat,
        lon: eclipse.greatest.lon,
        magnitude: eclipse.magnitude,
        pathWidthKm: eclipse.pathWidthKm,
        centralDurationSeconds: eclipse.centralDurationSeconds,
        saros: eclipse.saros,
      }));
    },

    /** What the layer is showing now, for QA. */
    getDiagnostics() {
      return {
        selected: selected()?.id ?? null,
        inProgress: _active?.id ?? null,
        shadowShown: _shadowShown,
        skyShown: _sky?.isShown() ?? false,
        playing: isPlaying(),
      };
    },
  };
  return layer;
}
