import * as Cesium from 'cesium';
import { validMeteor, validateMeteorSnapshot } from './records.js';
import { createMeteorPanel } from './panel.js';

// Keep the pickable paths in the opaque pass for consistent selection picking.
const COLOR = Cesium.Color.fromCssColorString('#8fc7c4');
const DIM = Cesium.Color.fromCssColorString('#405d6a');
const SELECTED = Cesium.Color.fromCssColorString('#ffcb86');
const BEGIN = Cesium.Color.fromCssColorString('#8fe5df');
const position = (p) =>
  Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.heightKm * 1000);
const ground = (p) => Cesium.Cartesian3.fromDegrees(p.lon, p.lat, 0);
const label = (
  text,
  color,
  offset,
  horizontalOrigin = Cesium.HorizontalOrigin.CENTER,
) => ({
  text,
  font: '12px sans-serif',
  fillColor: color,
  showBackground: true,
  backgroundColor: Cesium.Color.fromCssColorString('#0b1924').withAlpha(0.92),
  backgroundPadding: new Cesium.Cartesian2(10, 7),
  pixelOffset: offset,
  horizontalOrigin,
  distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 3000000),
});

/** Own the observation guide, fitted atmospheric geometry and illustrative playback. */
export function createMeteorsLayer({ source, services } = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Meteors require a source');
  let viewer, dataSource, handler, panel, request, snapshot;
  let enabled = false;
  let error = null;
  let selected = null;
  let showContext = false;
  let replayRemove = null;
  let replayFraction = 0;
  const rows = new Map();
  const annotations = [];
  const requestRender = () => services.render.governorRequestRender('meteors');
  function pauseReplay() {
    replayRemove?.();
    replayRemove = null;
    services.render.releaseContinuousRender('meteor-replay');
    panel?.setProgress(replayFraction, false);
    requestRender();
  }
  function clearReplay() {
    pauseReplay();
    dataSource?.entities.removeById('meteor-replay-dot');
    dataSource?.entities.removeById('meteor-replay-tail');
    replayFraction = 0;
    panel?.setProgress(0, false);
  }
  function updateVisibility() {
    for (const id of rows.keys()) {
      const entity = dataSource.entities.getById(`meteor:${id}`);
      const active = id === selected;
      entity.show = !selected || active || showContext;
      entity.polyline.material = active ? SELECTED : selected ? DIM : COLOR;
      entity.polyline.width = active ? 5 : 1.5;
      entity.point.pixelSize = active ? 8 : 3;
      entity.point.color = active ? BEGIN : selected ? DIM : COLOR;
    }
    requestRender();
  }
  function resetSelection() {
    clearReplay();
    for (const id of annotations) dataSource.entities.removeById(id);
    annotations.length = 0;
    selected = null;
    updateVisibility();
  }
  function close() {
    resetSelection();
    if (enabled) panel.showOverview(snapshot);
  }
  function focus() {
    const row = rows.get(selected);
    if (!row || viewer.trackedEntity) return;
    const sphere = Cesium.BoundingSphere.fromPoints([
      position(row.begin),
      position(row.end),
      ground(row.begin),
      ground(row.end),
    ]);
    const lat1 = Cesium.Math.toRadians(row.begin.lat),
      lat2 = Cesium.Math.toRadians(row.end.lat);
    const deltaLon = Cesium.Math.toRadians(row.end.lon - row.begin.lon);
    const bearing = Math.atan2(
      Math.sin(deltaLon) * Math.cos(lat2),
      Math.cos(lat1) * Math.sin(lat2) -
        Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLon),
    );
    viewer.camera.flyToBoundingSphere(sphere, {
      duration: 1.6,
      offset: new Cesium.HeadingPitchRange(
        bearing + Math.PI / 2,
        -0.32,
        Math.max(260000, sphere.radius * 4.5),
      ),
    });
  }
  function annotate(row) {
    const begin = position(row.begin),
      end = position(row.end);
    const add = (entity) => {
      dataSource.entities.add(entity);
      annotations.push(entity.id);
    };
    // These vertical guides stop at the reference ellipsoid; they are not trajectory extensions.
    for (const [name, endpoint, color, caption, offset] of [
      ['begin', row.begin, BEGIN, 'FIRST SEEN', new Cesium.Cartesian2(0, -28)],
      ['end', row.end, SELECTED, 'LAST SEEN', new Cesium.Cartesian2(14, 30)],
    ]) {
      add({
        id: `meteor-detail-${name}`,
        position: position(endpoint),
        point: {
          pixelSize: 7,
          color,
          outlineColor: Cesium.Color.fromCssColorString('#07131c'),
          outlineWidth: 2,
        },
        label: label(
          `${caption}  ${endpoint.heightKm.toFixed(1)} km`,
          color,
          offset,
          name === 'end'
            ? Cesium.HorizontalOrigin.LEFT
            : Cesium.HorizontalOrigin.CENTER,
        ),
      });
      add({
        id: `meteor-guide-${name}`,
        polyline: {
          positions: [position(endpoint), ground(endpoint)],
          arcType: Cesium.ArcType.NONE,
          width: 1,
          material: new Cesium.PolylineDashMaterialProperty({
            color: color.withAlpha(0.48),
            dashLength: 10,
          }),
        },
      });
    }
    add({
      id: 'meteor-direction',
      polyline: {
        positions: [
          Cesium.Cartesian3.lerp(begin, end, 0.7, new Cesium.Cartesian3()),
          end,
        ],
        arcType: Cesium.ArcType.NONE,
        width: 12,
        material: new Cesium.PolylineArrowMaterialProperty(SELECTED),
      },
    });
    add({
      id: 'meteor-altitude-plane',
      wall: {
        positions: [begin, end],
        minimumHeights: [0, 0],
        maximumHeights: [row.begin.heightKm * 1000, row.end.heightKm * 1000],
        material: BEGIN.withAlpha(0.045),
      },
    });
  }
  function select(id, fly = false) {
    const row = rows.get(id);
    if (!enabled || !row) return false;
    resetSelection();
    selected = id;
    updateVisibility();
    annotate(row);
    panel.show(row, snapshot, {
      pathLengthKm:
        Cesium.Cartesian3.distance(position(row.begin), position(row.end)) /
        1000,
      showContext,
    });
    if (fly) focus();
    requestRender();
    return true;
  }
  function next() {
    const ids = [...rows.keys()];
    if (ids.length) select(ids[(ids.indexOf(selected) + 1) % ids.length], true);
  }
  function drawReplay(fraction) {
    const row = rows.get(selected);
    if (!row) return;
    replayFraction = fraction;
    const begin = position(row.begin),
      end = position(row.end);
    const head = Cesium.Cartesian3.lerp(
      begin,
      end,
      fraction,
      new Cesium.Cartesian3(),
    );
    const tail = Cesium.Cartesian3.lerp(
      begin,
      end,
      Math.max(0, fraction - 0.16),
      new Cesium.Cartesian3(),
    );
    let dot = dataSource.entities.getById('meteor-replay-dot');
    if (!dot)
      dot = dataSource.entities.add({
        id: 'meteor-replay-dot',
        position: head,
        point: {
          pixelSize: 13,
          color: Cesium.Color.WHITE,
          outlineColor: SELECTED,
          outlineWidth: 4,
        },
      });
    dot.position = head;
    let trail = dataSource.entities.getById('meteor-replay-tail');
    if (!trail)
      trail = dataSource.entities.add({
        id: 'meteor-replay-tail',
        polyline: {
          positions: [tail, head],
          width: 15,
          arcType: Cesium.ArcType.NONE,
          material: new Cesium.PolylineGlowMaterialProperty({
            color: SELECTED,
            glowPower: 0.3,
            taperPower: 0.8,
          }),
        },
      });
    trail.polyline.positions = [tail, head];
    panel.setProgress(fraction, Boolean(replayRemove));
  }
  function scrub(fraction) {
    if (!selected) return;
    pauseReplay();
    drawReplay(Math.max(0, Math.min(1, fraction)));
    requestRender();
  }
  function replay() {
    if (!rows.has(selected)) return;
    if (replayRemove) {
      pauseReplay();
      return;
    }
    if (replayFraction >= 1) replayFraction = 0;
    const start = performance.now() - replayFraction * 6000;
    services.render.holdContinuousRender('meteor-replay');
    replayRemove = viewer.scene.preRender.addEventListener(() => {
      const t = Math.min(1, (performance.now() - start) / 6000);
      drawReplay(t);
      if (t >= 1) pauseReplay();
    });
    drawReplay(replayFraction);
    requestRender();
  }
  return {
    id: 'meteors',
    name: 'Meteors · latest batch',
    icon: '☄',
    source: 'Global Meteor Network · reconstructed observations',
    updateInterval: 6 * 60 * 60 * 1000,
    init(v) {
      if (viewer) throw new Error('Meteor layer already initialized');
      viewer = v;
      dataSource = new Cesium.CustomDataSource('meteors');
      dataSource.show = false;
      viewer.dataSources.add(dataSource);
      panel = createMeteorPanel({
        parent: viewer.container,
        onClose: close,
        onNext: next,
        onFocus: focus,
        onReplay: replay,
        onScrub: scrub,
        onSelect: (id) => select(id, true),
        onContext: (value) => {
          showContext = value;
          updateVisibility();
        },
      });
      handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
      handler.setInputAction((event) => {
        if (!enabled || !services.isPointerFree()) return;
        const id = services.picking.resolvePickId(
          viewer.scene.pick(event.position, 9, 9),
        );
        if (id?.startsWith('meteor:')) select(id.slice(7));
        else if (id?.startsWith('meteor-detail-') || id === 'meteor-direction')
          select(selected);
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    },
    enable() {
      enabled = true;
      dataSource.show = true;
      panel.showOverview(snapshot);
      services.picking.registerPickOwner(
        'meteors',
        (id) => id.startsWith('meteor:') || id.startsWith('meteor-'),
      );
      requestRender();
    },
    disable() {
      enabled = false;
      request?.abort();
      request = null;
      resetSelection();
      panel?.hide();
      if (dataSource) dataSource.show = false;
      services.picking.unregisterPickOwner('meteors');
      requestRender();
    },
    async update(_viewer, { signal } = {}) {
      if (!enabled) return false;
      request?.abort();
      const current = new AbortController();
      request = current;
      const combined = signal
        ? AbortSignal.any([signal, current.signal])
        : current.signal;
      try {
        const fresh = validateMeteorSnapshot(
          await source.getSnapshot({ signal: combined }),
        );
        if (combined.aborted || request !== current || !enabled) return false;
        const entities = fresh.records.map(
          (row) =>
            new Cesium.Entity({
              id: `meteor:${row.id}`,
              position: position(row.begin),
              point: { pixelSize: 3, color: COLOR },
              polyline: {
                positions: [position(row.begin), position(row.end)],
                width: 1.5,
                arcType: Cesium.ArcType.NONE,
                material: COLOR,
                clampToGround: false,
              },
            }),
        );
        const priorSelection = selected;
        resetSelection();
        rows.clear();
        dataSource.entities.removeAll();
        for (let i = 0; i < entities.length; i++) {
          dataSource.entities.add(entities[i]);
          rows.set(fresh.records[i].id, fresh.records[i]);
        }
        snapshot = fresh;
        error = null;
        if (!priorSelection || !select(priorSelection))
          panel.showOverview(snapshot);
        requestRender();
        return true;
      } catch {
        if (!combined.aborted && request === current && enabled) {
          error = 'Meteor refresh failed';
          if (snapshot) {
            snapshot = { ...snapshot, stale: true };
            panel.setStatus(snapshot);
          } else
            panel.showOverview(
              null,
              'The camera network data is temporarily unavailable. Toggle this layer to try again.',
            );
        }
        return false;
      } finally {
        if (request === current) request = null;
      }
    },
    getRowControls() {
      return {
        chips: [
          {
            id: 'meteor-brightest',
            label: 'EXPLORE',
            title: 'Explore the brightest meteor in the latest GMN batch',
            disabled: !enabled || !rows.size || Boolean(viewer?.trackedEntity),
            onClick: () => select(rows.keys().next().value, true),
          },
          {
            id: 'meteor-next',
            label: 'OVERVIEW',
            title: 'Show the meteor observation guide',
            disabled: !enabled,
            onClick: close,
          },
        ],
        legend: [
          {
            label: snapshot?.timeFrom
              ? `${new Date(snapshot.timeFrom).toISOString().slice(0, 10)} · reconstructed`
              : 'Reconstructed paths',
            color: '#8fc7c4',
            count: rows.size,
            blurb:
              'Latest published GMN processing batch, not live. Open the observatory to explore camera observations, altitude and the direction of passage.',
          },
        ],
      };
    },
    getStats() {
      return {
        count: rows.size,
        countLabel: snapshot?.limited
          ? `${rows.size}/${snapshot.totalCount}`
          : String(rows.size),
        lastUpdate: snapshot?.fetchedAt ?? null,
        error,
        stale: Boolean(snapshot?.stale),
        degraded: Boolean(snapshot?.rejectedCount),
        source: 'GMN · reconstructed observations',
        generatedAt: snapshot?.generatedAt,
        coverage: 'Latest published batch · incomplete geographic coverage',
      };
    },
    getAnalystRecords(maxCount = 2000) {
      if (!enabled) return [];
      return [...rows.values()]
        .slice(0, Math.max(0, Math.min(2000, Math.floor(maxCount) || 0)))
        .filter(validMeteor)
        .map((row) => ({
          ...row,
          kind: 'meteor',
          layerId: 'meteors',
          lat: row.begin.lat,
          lon: row.begin.lon,
          observedAt: row.utc,
          determination: 'reconstructed',
          source: 'Global Meteor Network',
          stale: Boolean(snapshot?.stale),
        }));
    },
    destroy() {
      this.disable();
      handler?.destroy();
      panel?.destroy();
      if (dataSource) viewer.dataSources.remove(dataSource, true);
      dataSource = null;
      viewer = null;
      rows.clear();
      snapshot = null;
      error = null;
    },
  };
}
