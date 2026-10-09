import * as Cesium from 'cesium';
import {
  ALPINE_NETWORKS,
  alpineNetwork,
  networksMeasuring,
} from './networks.js';
import {
  DEFAULT_PARAMETER_ID,
  STATION_PARAMETER_IDS,
  STATION_PARAMETER_VIEWS,
  parameterLegend,
  parameterProminence,
  parameterValue,
  parameterView,
} from './parameters.js';
import {
  isReporting,
  isStale,
  nearestStations,
  stationCardLines,
  summarizeStations,
  utcMinute,
} from './records.js';
import {
  ALPINE_OVERLAY_COHORT_LIMIT,
  ALPINE_OVERLAY_COLLISION_CAPACITY,
  ALPINE_OVERLAY_SOURCE_ID,
  createStationOverlayEntry,
  mapAnalystRecord,
  selectOverlayCohort,
  stationArrow,
  stationLabel,
  stationMarker,
} from './model.js';
import { windArrowImage } from './windArrow.js';
import {
  screenProjectedRotation,
  stabilizeScreenRotation,
} from '../../data/iconOrientation.js';
export * from './model.js';
export * from './networks.js';
export * from './parameters.js';
export { createAlpineStationSource } from './source.js';

export const ALPINE_STATIONS_LAYER_ID = 'alpine-stations';

/** Stations the rail card lists, and how far out it looks for them. */
export const NEAREST_LIST_LIMIT = 6;
export const NEAREST_LIST_MAX_KM = 400;

/**
 * Alpine automatic weather stations — SLF IMIS, SwissMetNet and TAWES as one
 * layer with one adapter per network.
 *
 * Rendering follows the earthquakes layer's rule: geometry is STATIC, written
 * only when a poll brings new data or the selected parameter changes. There is
 * no `CallbackProperty` and no continuous-render hold, so an open map with this
 * layer on costs nothing per frame.
 *
 * A parameter change recolours the existing points in place rather than
 * rebuilding the data source. 650 entities are cheap to tint and expensive to
 * reconstruct, and reconstructing them would drop the scene's picking and
 * labelling work for no reason.
 *
 * The camera is read only on `moveEnd`, and only to recompute the rail card's
 * six-row "nearest" list. Nothing about the geometry depends on where the
 * camera is, so settling it never rebuilds an entity.
 */
export function createAlpineStationsLayer({
  source,
  overlayHost,
  cesium = Cesium,
  now = () => Date.now(),
  // Both need a browser: one a canvas, the other a live Scene. Injected so the
  // layer is drivable under `node --test` without either.
  arrowImage = windArrowImage,
  projectRotation = screenProjectedRotation,
  // CC BY is a condition of using these networks, so the operators are
  // credited on the globe for exactly as long as their data is drawn.
  credit = null,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Alpine stations require a snapshot source');
  if (!overlayHost)
    throw new TypeError('Alpine stations require an overlay host');

  let viewer = null;
  let dataSource = null;
  let request = null;
  let enabled = false;
  let destroyed = false;
  let loading = false;
  let snapshot = null;
  let error = null;
  let lastUpdate = null;
  let parameterId = DEFAULT_PARAMETER_ID;
  let selectedId = null;
  let listener = null;
  let removeMoveEnd = null;
  let nearestIds = '';
  const entities = new Map();
  /** Station id to its wind arrow's world bearing and last drawn rotation. */
  const arrows = new Map();

  const view = () => parameterView(parameterId);
  const stations = () => snapshot?.stations ?? [];
  const notify = () => listener?.();

  const selected = () =>
    stations().find((station) => station.id === selectedId) ?? null;

  /** The camera's ground centre, or null when there is no viewer to ask. */
  function cameraCentre() {
    const carto = viewer?.camera?.positionCartographic;
    if (!carto) return null;
    return {
      lat: cesium.Math.toDegrees(carto.latitude),
      lon: cesium.Math.toDegrees(carto.longitude),
    };
  }

  function nearest() {
    const centre = cameraCentre();
    if (!centre) return [];
    return nearestStations(stations(), {
      ...centre,
      limit: NEAREST_LIST_LIMIT,
      maxKm: NEAREST_LIST_MAX_KM,
    });
  }

  /**
   * Recompute the card's list after the camera settles, and publish only when
   * the membership actually changed. Panning within one valley must not
   * rewrite the rail on every gesture.
   */
  function refreshNearest() {
    if (!enabled || destroyed) return;
    aimArrows();
    const next = nearest()
      .map(({ station }) => station.id)
      .join(',');
    if (next === nearestIds) return;
    nearestIds = next;
    notify();
  }

  /**
   * Point the wind arrows at their real-world bearings.
   *
   * A billboard is a camera-facing quad, so a world bearing has to be resolved
   * in SCREEN space, which means it depends on where the camera is. This is
   * the repo's established way of doing that: `alignedAxis: Cartesian3.ZERO`
   * with a screen-projected `rotation`, as the flight and vessel layers do.
   *
   * It runs on camera settle, never per frame. Nothing is created, destroyed
   * or re-tessellated here — it writes one number per visible arrow — so the
   * layer still builds no geometry in response to the camera and still takes
   * no continuous-render hold.
   */
  function aimArrows() {
    if (!arrows.size || !viewer?.scene) return;
    for (const [id, arrow] of arrows) {
      const entity = entities.get(id);
      if (!entity?.billboard) continue;
      const next = projectRotation(
        viewer.scene,
        // The CARTESIAN, not `entity.position`: that is a PositionProperty,
        // and handing one to the projection silently yields no rotation.
        arrow.position,
        arrow.bearingDeg,
        arrow.rotation,
      );
      // Hold through sub-degree projection noise so a settled camera does not
      // jitter 600 arrows against their own rounding.
      const stable = stabilizeScreenRotation(arrow.rotation, next);
      if (stable === null || stable === arrow.rotation) continue;
      arrow.rotation = stable;
      entity.billboard.rotation = stable;
    }
  }

  /** Write the marker and ambient label for every station. */
  function draw() {
    if (!dataSource || !enabled) return;
    const current = view();
    const clock = now();
    const overlayEntries = [];
    const seen = new Set();
    // Pruned after the pass rather than cleared before it: a redraw must keep
    // each arrow's last drawn rotation, which is what the stabiliser compares
    // against to hold through sub-degree projection noise.
    const aimed = new Set();
    for (const station of stations()) {
      const marker = stationMarker(station, current, { now: clock });
      const color = cesium.Color.fromCssColorString(marker.accent).withAlpha(
        marker.alpha,
      );
      const arrow = stationArrow(station, current, marker);
      let entity = entities.get(station.id);
      const position = cesium.Cartesian3.fromDegrees(station.lon, station.lat);
      if (!entity) {
        entity = dataSource.entities.add(
          new cesium.Entity({
            id: `alpine-station:${station.id}`,
            position,
            point: {
              // Static values: a CallbackProperty here would re-evaluate every
              // frame for data that changes every ten minutes.
              pixelSize: marker.pixelSize,
              color,
              outlineColor: cesium.Color.BLACK.withAlpha(0.65),
              outlineWidth: marker.outlined ? 1 : 0,
              heightReference: cesium.HeightReference.CLAMP_TO_GROUND,
              // Always on top. A depth-tested ground-clamped marker is half
              // buried by the ridge in front of it at oblique pitch, which
              // reads as a smudge of the wrong size and the wrong colour.
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
            properties: { stationId: station.id },
          }),
        );
        entities.set(station.id, entity);
      } else {
        // Recolour in place. The position of a weather station does not change.
        entity.point.pixelSize = marker.pixelSize;
        entity.point.color = color;
        entity.point.outlineWidth = marker.outlined ? 1 : 0;
      }
      // A station carries both graphics and shows one, so switching parameter
      // swaps the symbol without replacing the entity.
      // The dot follows whether an arrow was actually attached, not whether
      // one was wanted: without a canvas there is no arrow image, and a
      // station must never end up with neither symbol.
      const drawnArrow = arrow
        ? addArrow(entity, station, arrow, color, position)
        : false;
      if (drawnArrow) aimed.add(station.id);
      else if (entity.billboard) entity.billboard.show = false;
      entity.point.show = !drawnArrow;
      seen.add(station.id);
      const title = stationLabel(station, current, marker);
      if (title) {
        overlayEntries.push(
          createStationOverlayEntry({
            station,
            position,
            title,
            accent: marker.accent,
            prominence: parameterProminence(marker.value, current),
          }),
        );
      }
    }
    for (const [id, entity] of entities) {
      if (seen.has(id)) continue;
      dataSource.entities.remove(entity);
      entities.delete(id);
    }
    for (const id of arrows.keys()) if (!aimed.has(id)) arrows.delete(id);
    overlayHost.setEntries(
      ALPINE_OVERLAY_SOURCE_ID,
      selectOverlayCohort(overlayEntries),
      {
        cohortLimit: ALPINE_OVERLAY_COHORT_LIMIT,
        collisionCapacity: ALPINE_OVERLAY_COLLISION_CAPACITY,
        moving: false,
      },
    );
    aimArrows();
  }

  /**
   * Attach or update one station's wind arrow, creating it on first use.
   *
   * @returns {boolean} Whether the station now has an arrow to show.
   */
  function addArrow(entity, station, arrow, color, position) {
    const image = arrowImage();
    if (!image) return false;
    const held = arrows.get(station.id);
    arrows.set(station.id, {
      bearingDeg: arrow.bearingDeg,
      position,
      rotation: held?.rotation ?? null,
    });
    if (!entity.billboard) {
      entity.billboard = new cesium.BillboardGraphics({
        // Explicit, though Cesium treats an unset `show` as visible: a
        // freshly created arrow then reports `show === undefined`, so
        // anything inspecting it — including this layer's own browser gate —
        // cannot tell a drawn arrow from a hidden one.
        show: true,
        image,
        width: arrow.pixelSize,
        height: arrow.pixelSize,
        color,
        // The repo orients icons with a screen-projected rotation, never with
        // alignedAxis; see src/data/iconOrientation.js for why.
        alignedAxis: cesium.Cartesian3.ZERO,
        rotation: 0,
        heightReference: cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      });
      return true;
    }
    entity.billboard.show = true;
    entity.billboard.width = arrow.pixelSize;
    entity.billboard.height = arrow.pixelSize;
    entity.billboard.color = color;
    return true;
  }

  /**
   * Networks that publish the selected parameter AND answered this poll.
   *
   * Reading the snapshot rather than the registry alone matters when an
   * operator is down: choose snow while SLF is unreachable and the Swiss half
   * of the snow picture is simply not on screen, so the card must not go on
   * naming SLF as a source for it.
   */
  function supportingNetworks() {
    const measuring = networksMeasuring(parameterId);
    if (!snapshot?.networks) return measuring;
    const reachable = new Set(
      snapshot.networks
        .filter((network) => network.status !== 'unavailable')
        .map((network) => network.id),
    );
    return measuring.filter((network) => reachable.has(network.id));
  }

  function statusLine() {
    if (error) return error;
    if (snapshot?.unavailable)
      return snapshot.reason || 'Station networks unavailable';
    if (loading && !snapshot) return 'Loading stations…';
    // Ahead of the general reason: a visitor who chose a parameter nothing
    // reachable measures needs to know THAT, not a count of networks.
    if (snapshot && !supportingNetworks().length)
      return `No reachable network publishes ${view().label.toLowerCase()}`;
    if (snapshot?.reason) return snapshot.reason;
    return null;
  }

  const layer = {
    id: ALPINE_STATIONS_LAYER_ID,
    name: 'Alpine Stations',
    icon: '⛰',
    source: 'SLF · MeteoSwiss · GeoSphere',
    updateInterval: 300_000,

    init(nextViewer) {
      if (viewer)
        throw new Error('Alpine station layer is already initialized');
      viewer = nextViewer;
      dataSource = new cesium.CustomDataSource(ALPINE_STATIONS_LAYER_ID);
      dataSource.show = false;
      viewer.dataSources.add(dataSource);
      overlayHost.setVisible(ALPINE_OVERLAY_SOURCE_ID, false);
    },

    enable() {
      if (destroyed || enabled) return;
      enabled = true;
      if (dataSource) dataSource.show = true;
      credit?.show?.(viewer);
      overlayHost.setVisible(ALPINE_OVERLAY_SOURCE_ID, true);
      // moveEnd, never preRender: this recomputes a six-row list, not geometry.
      removeMoveEnd =
        viewer?.camera?.moveEnd?.addEventListener?.(refreshNearest) ?? null;
      draw();
      notify();
    },

    disable() {
      enabled = false;
      request?.abort();
      request = null;
      loading = false;
      removeMoveEnd?.();
      removeMoveEnd = null;
      nearestIds = '';
      arrows.clear();
      if (dataSource) dataSource.show = false;
      credit?.hide?.(viewer);
      overlayHost.clearSource(ALPINE_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(ALPINE_OVERLAY_SOURCE_ID, false);
      notify();
    },

    async update() {
      if (!enabled || !dataSource) return false;
      request?.abort();
      const owned = new AbortController();
      request = owned;
      loading = true;
      notify();
      try {
        const next = await source.getSnapshot({ signal: owned.signal });
        if (owned.signal.aborted || request !== owned || !enabled) return false;
        snapshot = next;
        error = null;
        lastUpdate = now();
        draw();
        nearestIds = nearest()
          .map(({ station }) => station.id)
          .join(',');
        return true;
      } catch (failure) {
        if (owned.signal.aborted || request !== owned || !enabled) return false;
        error = failure?.message || 'Alpine station source unavailable';
        return false;
      } finally {
        if (request === owned) {
          request = null;
          loading = false;
          notify();
        }
      }
    },

    getParams() {
      return { parameter: parameterId };
    },

    /**
     * Apply row and card interaction.
     *
     * `parameter` is the chosen value the markers encode. `stationId` selects a
     * station for the card's detail lines, and `clear` drops that selection.
     * An unknown parameter degrades to the default rather than throwing: the
     * value arrives from a chip, and later from a share link and a voice
     * action, so it is ordinary input.
     */
    setParams(params = {}) {
      let changed = false;
      if (typeof params.parameter === 'string') {
        const next = parameterView(params.parameter).id;
        if (next !== parameterId) {
          parameterId = next;
          changed = true;
          draw();
        }
      }
      if (params.clear === true && selectedId !== null) {
        selectedId = null;
        changed = true;
      } else if (typeof params.stationId === 'string') {
        const exists = stations().some(
          (station) => station.id === params.stationId,
        );
        const next = exists ? params.stationId : null;
        if (next !== selectedId) {
          selectedId = next;
          changed = true;
        }
      }
      if (changed) notify();
      return true;
    },

    setRowControlsListener(value) {
      listener = typeof value === 'function' ? value : null;
    },

    /**
     * The WEATHER rail card: the readings, the legend, and the nearest
     * stations in view.
     *
     * `readout: true` keeps the layer's own row to a toggle and a meta line;
     * everything a visitor reads is in the card, which has the room for it.
     */
    getRowControls() {
      const current = view();
      const summary = summarizeStations(stations(), {
        parameterId,
        now: now(),
      });
      const station = selected();
      const inView = nearest();
      const supporting = supportingNetworks();
      const measured = `${summary.measuring} of ${summary.total} stations`;
      const detail = snapshot
        ? summary.total
          ? `${measured} · ${supporting.map((network) => network.label).join(' · ')}`
          : 'No stations loaded'
        : loading
          ? 'Loading stations…'
          : 'Stations unavailable';
      const lines = [
        {
          id: 'reporting',
          text: `${summary.reporting} of ${summary.total} reporting${
            summary.staleStations ? ` · ${summary.staleStations} late` : ''
          }`,
          muted: true,
        },
      ];
      if (summary.min !== null && summary.max !== null) {
        lines.push({
          id: 'range',
          text: `${current.label} across the network: ${summary.min.toFixed(1)} to ${summary.max.toFixed(1)} ${current.unit}`,
        });
      }
      if (summary.newestAt)
        lines.push({
          id: 'newest',
          text: `Newest reading ${utcMinute(summary.newestAt)}`,
          muted: true,
        });
      // A selected station's detail belongs to the result block alone, which
      // carries its name and its clear control. Repeating it here would render
      // the same readings twice in one card.
      const stationLines = station
        ? stationCardLines(station, current, { now: now() })
        : [];
      return {
        readout: true,
        summary: {
          label: 'Alpine Stations',
          coverage: [
            ...new Set(ALPINE_NETWORKS.map((network) => network.country)),
          ].join(' · '),
          compact: station ? `${station.label} selected` : detail,
          detail,
          status: statusLine(),
          units: current.unit,
          lines,
          settings: [
            {
              id: 'parameter',
              label: 'VALUE',
              chips: STATION_PARAMETER_IDS.map((id) => ({
                id,
                label: STATION_PARAMETER_VIEWS[id].chipLabel,
                active: id === parameterId,
                params: { parameter: id },
              })),
            },
          ],
          actions: supporting.map((network) => ({
            id: `source-${network.id}`,
            label: `${network.label} ↗`,
            href: network.homepage,
          })),
          ...(station
            ? {
                result: {
                  id: 'station',
                  label: station.label,
                  lines: stationLines,
                  clear: { params: { clear: true } },
                },
              }
            : {}),
        },
        list: {
          ariaLabel: 'Nearest Alpine weather stations in view',
          items: inView.map(({ station: item, km }, index) => ({
            id: item.id,
            ordinal: index + 1,
            lead: `${Math.round(km)} km`,
            text: `${item.label} · ${
              Number.isFinite(item.elevationM)
                ? `${Math.round(item.elevationM)} m · `
                : ''
            }${readingText(item, current, now())}`,
            active: item.id === selectedId,
            params: { stationId: item.id },
          })),
        },
        chips: [],
        legend: parameterLegend(current),
        info: [
          `${detail}`,
          `${summary.reporting} of ${summary.total} stations reporting${summary.staleStations ? `, ${summary.staleStations} late` : ''}.`,
          snapshot?.attribution || '',
          'Measurements only. Snow depth is not an avalanche danger rating; the operator bulletins are separate products.',
        ]
          .filter(Boolean)
          .join('\n'),
        infoTitle:
          'Automatic Alpine weather stations from three keyless, openly licensed national networks. Choose which measurement the markers encode; marker colour is the band and size is the distance from an ordinary reading. A dim marker is a station that is reporting but does not measure the selected value, or whose newest reading is too old to present. Pick a station in the list for its full readings. Snow depth is a measurement, not an avalanche danger rating.',
      };
    },

    /**
     * Snapshot the loaded stations as plain records for the analyst engine.
     * On demand only, once per query; [] while the layer is off.
     */
    getAnalystRecords(maxCount = Infinity) {
      if (!enabled || destroyed) return [];
      const result = [];
      for (const station of stations()) {
        if (result.length >= maxCount) break;
        result.push(mapAnalystRecord(station));
      }
      return result;
    },

    getStats() {
      const summary = summarizeStations(stations(), {
        parameterId,
        now: now(),
      });
      return {
        count: summary.total,
        countLabel: summary.total
          ? `${summary.reporting}/${summary.total} reporting`
          : undefined,
        lastUpdate,
        error,
        // Feed-level staleness only: the proxy served a cached payload. The
        // count of individually late stations is `staleStations`, because
        // `layerFeedState()` renders the whole row STALE on any truthy value
        // here and a healthy network with four late boxes is not stale.
        stale: Boolean(snapshot?.stale),
        staleStations: summary.staleStations,
        unavailable: Boolean(snapshot?.unavailable),
      };
    },

    destroy(target = viewer) {
      destroyed = true;
      enabled = false;
      request?.abort();
      request = null;
      removeMoveEnd?.();
      removeMoveEnd = null;
      listener = null;
      credit?.hide?.(target ?? viewer);
      overlayHost.clearSource(ALPINE_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(ALPINE_OVERLAY_SOURCE_ID, false);
      entities.clear();
      arrows.clear();
      if (dataSource) {
        target?.dataSources?.remove(dataSource, true);
        dataSource = null;
      }
      viewer = null;
      snapshot = null;
    },
  };
  return layer;
}

/** One station's reading under the selected view, for a list row. */
function readingText(station, current, clock) {
  const marker = stationMarker(station, current, { now: clock });
  if (marker.state === 'offline')
    return isReporting(station) && isStale(station, clock) ? 'late' : 'no data';
  if (marker.state === 'unmeasured') return 'not measured';
  const value = parameterValue(station, current);
  return `${value.toFixed(current.id === 'wind' ? 0 : 1)} ${current.unit}`;
}
