import * as Cesium from 'cesium';
import { msg, t } from '../../i18n/index.js';
import { isPointerFree } from '../../data/inputOwnership.js';

const TRAIL_LIMIT = 240;
/**
 * A live Starship telemetry layer driven by SpaceX's public webcast feed.
 * The feed currently reports the ship; a booster key will render automatically
 * if SpaceX publishes one in a later flight.
 */
export function createStarshipLiveLayer({ source, services = {} }) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Starship Live requires a snapshot source');

  let viewer = null;
  let dataSource = null;
  let enabled = false;
  let destroyed = false;
  let loading = false;
  let error = null;
  let snapshot = null;
  let request = null;
  let listener = null;
  let selectedId = null;
  let clickHandler = null;
  const entities = new Map();
  const contextServices = services.context || {};
  const pickingServices = services.picking || {};
  const positions = new Map();
  const lastSpeedMps = new Map();
  const trails = new Map();
  const iconCache = new Map();

  const notify = () => listener?.();
  const selected = () =>
    snapshot?.vehicles.find((vehicle) => vehicle.id === selectedId) || null;

  function registerVehicleContext(vehicle, entity) {
    if (
      !vehicle ||
      !entity ||
      typeof contextServices.registerEntityContext !== 'function'
    )
      return null;
    try {
      return contextServices.registerEntityContext(entity, {
        id: `starship-live:${vehicle.id}`,
        layerId: 'starship-live',
        layerName: 'Starship Live',
        source: 'SpaceX public telemetry',
        label: vehicle.name,
        latitude: vehicle.lat,
        longitude: vehicle.lon,
        properties: {
          vehicleId: vehicle.id,
          name: vehicle.name,
          altitudeM: vehicle.alt,
          altitudeDisplay: formatAltitude(vehicle.alt),
          speedKph: vehicle.speed * 3.6,
          headingDeg: vehicle.heading,
          positionAt: vehicle.positionAt,
          source: 'SpaceX public telemetry',
        },
      });
    } catch {
      return null;
    }
  }

  function selectVehicle(id, { focus = true } = {}) {
    if (!entities.has(id)) return false;
    selectedId = id;
    const entity = entities.get(id);
    if (focus && viewer?.trackedEntity !== entity)
      viewer.trackedEntity = entity;
    const vehicle = selected();
    if (
      vehicle &&
      entity &&
      typeof contextServices.selectEntityContext === 'function'
    ) {
      try {
        contextServices.selectEntityContext(entity);
      } catch {
        /* inspection still reads the layer’s live record */
      }
    }
    notify();
    return true;
  }

  function installClickHandler() {
    if (clickHandler || !viewer?.scene?.canvas) return;
    clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    clickHandler.setInputAction((click) => {
      if (!enabled || destroyed || !isPointerFree() || !click?.position) return;
      const picked = pickingServices.pickContact
        ? pickingServices.pickContact(viewer.scene, click.position)
        : viewer.scene.pick(click.position);
      const pickedId = pickingServices.resolvePickId
        ? pickingServices.resolvePickId(picked)
        : String(picked?.id?.id ?? picked?.primitive?.id ?? '');
      if (!pickedId?.startsWith('starship-live:')) return;
      const vehicleId = pickedId.slice('starship-live:'.length);
      selectVehicle(vehicleId);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function removeClickHandler() {
    if (!clickHandler) return;
    clickHandler.destroy();
    clickHandler = null;
  }

  function ensureDataSource() {
    if (dataSource || !viewer) return;
    dataSource = new Cesium.CustomDataSource('starship-live');
    dataSource.show = enabled;
    viewer.dataSources.add(dataSource);
  }

  function vehicleColor(id) {
    return /booster/i.test(id) ? Cesium.Color.ORANGE : Cesium.Color.CYAN;
  }

  function vehicleIcon(id) {
    const color = /booster/i.test(id) ? '#ff9f43' : '#00ffff';
    const key = `starship:${color}`;
    if (iconCache.has(key)) return iconCache.get(key);
    const height = /booster/i.test(id) ? 22 : 32;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><g transform="translate(16,16)"><path d="M0,-${height / 2} L4,-4 L4,6 L8,10 L4,8 L4,12 L-4,12 L-4,8 L-8,10 L-4,6 L-4,-4 Z" fill="${color}" fill-opacity="0.86" stroke="#ffffff" stroke-width="1" stroke-linejoin="round"/></g></svg>`;
    const icon = 'data:image/svg+xml;base64,' + btoa(svg);
    iconCache.set(key, icon);
    return icon;
  }

  function ensureEntity(vehicle) {
    const id = vehicle.id;
    if (entities.has(id)) return entities.get(id);
    const color = vehicleColor(id);
    trails.set(id, []);
    positions.set(
      id,
      Cesium.Cartesian3.fromDegrees(vehicle.lon, vehicle.lat, vehicle.alt),
    );
    const entity = dataSource.entities.add({
      id: `starship-live:${id}`,
      position: new Cesium.CallbackProperty(() => positions.get(id), false),
      point: {
        pixelSize: 7,
        color,
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 1,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      billboard: {
        image: vehicleIcon(id),
        scale: 1,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      polyline: {
        positions: new Cesium.CallbackProperty(() => trails.get(id), false),
        width: 2,
        material: color.withAlpha(0.65),
        clampToGround: false,
        arcType: Cesium.ArcType.NONE,
      },
    });
    entities.set(id, entity);
    return entity;
  }

  function removeEntity(id) {
    const entity = entities.get(id);
    if (!entity) return;
    dataSource.entities.remove(entity);
    entities.delete(id);
    positions.delete(id);
    lastSpeedMps.delete(id);
    trails.delete(id);
    if (viewer?.trackedEntity === entity) viewer.trackedEntity = undefined;
    if (selectedId === id) selectedId = null;
  }

  function reconcile(nextSnapshot) {
    if (!enabled || destroyed || !dataSource) return;
    if (!nextSnapshot.vehicles.length) clearScene();

    const nextIds = new Set(nextSnapshot.vehicles.map((vehicle) => vehicle.id));
    for (const id of [...entities.keys()])
      if (!nextIds.has(id)) removeEntity(id);

    for (const vehicle of nextSnapshot.vehicles) {
      const entity = ensureEntity(vehicle);
      const position = Cesium.Cartesian3.fromDegrees(
        vehicle.lon,
        vehicle.lat,
        vehicle.alt,
      );
      if (Number.isFinite(vehicle.speed) && vehicle.speed > 0) {
        lastSpeedMps.set(vehicle.id, vehicle.speed);
      } else if (lastSpeedMps.has(vehicle.id)) {
        vehicle.speed = lastSpeedMps.get(vehicle.id);
      }
      positions.set(vehicle.id, position);
      const trail = trails.get(vehicle.id);
      const previous = trail.at(-1);
      if (!previous || !Cesium.Cartesian3.equals(previous, position)) {
        trail.push(position);
        if (trail.length > TRAIL_LIMIT) trail.shift();
      }
      entity.billboard.image = vehicleIcon(vehicle.id);
      registerVehicleContext(vehicle, entity);
    }

    snapshot = nextSnapshot;
  }

  function clearScene() {
    if (!dataSource) return;
    for (const id of [...entities.keys()]) removeEntity(id);
    if (viewer?.trackedEntity?.id?.startsWith('starship-live:'))
      viewer.trackedEntity = undefined;
  }

  function formatAltitude(altitudeM) {
    if (!Number.isFinite(altitudeM)) return t('Unavailable');
    return altitudeM >= 1000
      ? `${(altitudeM / 1000).toFixed(altitudeM >= 10000 ? 0 : 1)} km`
      : `${altitudeM.toFixed(0)} m`;
  }

  function formatSpeedKph(speedMps) {
    if (!Number.isFinite(speedMps)) return t('Unavailable');
    return `${(speedMps * 3.6).toFixed(0)} km/h`;
  }

  const layer = {
    id: 'starship-live',
    name: 'Starship Live',
    icon: '⇧',
    source: 'SpaceX public telemetry',
    updateInterval: 1000,

    init(nextViewer) {
      viewer = nextViewer;
      ensureDataSource();
      if (typeof pickingServices.registerPickOwner === 'function')
        pickingServices.registerPickOwner('starship-live', (id) =>
          String(id).startsWith('starship-live:'),
        );
      installClickHandler();
    },

    enable() {
      if (destroyed || enabled) return;
      enabled = true;
      if (dataSource) dataSource.show = true;
      ensureDataSource();
      installClickHandler();
      loading = true;
      notify();
    },

    disable() {
      enabled = false;
      request?.abort();
      request = null;
      loading = false;
      error = null;
      snapshot = null;
      selectedId = null;
      clearScene();
      if (
        typeof contextServices.clearSelectedEntityContextForLayer === 'function'
      ) {
        try {
          contextServices.clearSelectedEntityContextForLayer('starship-live');
        } catch {
          /* inspection teardown is best-effort */
        }
      }
      if (typeof contextServices.removeEntityContextsForLayer === 'function') {
        try {
          contextServices.removeEntityContextsForLayer('starship-live');
        } catch {
          /* inspection teardown is best-effort */
        }
      }
      removeClickHandler();
      if (dataSource) dataSource.show = false;
      notify();
    },

    async update(_viewer, { signal } = {}) {
      if (!enabled || destroyed) return false;
      request?.abort();
      const controller = new AbortController();
      if (signal?.aborted) controller.abort(signal.reason);
      request = controller;
      const abort = () => controller.abort(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      loading = true;
      notify();
      try {
        signal?.throwIfAborted();
        const nextSnapshot = await source.getSnapshot({
          signal: controller.signal,
        });
        if (!enabled || controller.signal.aborted || request !== controller)
          return false;
        error = null;
        reconcile(nextSnapshot);
        viewer?.scene?.requestRender?.();
        return true;
      } catch (cause) {
        if (controller.signal.aborted || request !== controller) return false;
        error = cause?.message || msg('Starship telemetry unavailable');
        return true;
      } finally {
        signal?.removeEventListener('abort', abort);
        if (request === controller) {
          request = null;
          loading = false;
          notify();
        }
      }
    },

    setParams(params = {}) {
      if (!enabled || destroyed) return;
      const id = typeof params.vehicleId === 'string' ? params.vehicleId : null;
      if (params.clear === true || id === null) {
        selectedId = null;
        if (viewer?.trackedEntity?.id?.startsWith('starship-live:'))
          viewer.trackedEntity = undefined;
        if (
          typeof contextServices.clearSelectedEntityContextForLayer ===
          'function'
        ) {
          try {
            contextServices.clearSelectedEntityContextForLayer('starship-live');
          } catch {
            /* clearing inspection is best-effort */
          }
        }
      } else {
        selectVehicle(id, { focus: params.focus !== false });
      }
      notify();
    },

    getInspectionInfo() {
      const vehicle = selected();
      if (!vehicle) return null;
      return {
        id: vehicle.id,
        label: vehicle.name,
        latitude: vehicle.lat,
        longitude: vehicle.lon,
        altitudeM: vehicle.alt,
        altitude: vehicle.alt,
        altitudeDisplay: formatAltitude(vehicle.alt),
        speed: vehicle.speed * 3.6,
        heading: vehicle.heading,
        source: 'SpaceX public telemetry',
        properties: {
          vehicleId: vehicle.id,
          name: vehicle.name,
          altitudeM: vehicle.alt,
          altitudeDisplay: formatAltitude(vehicle.alt),
          speedMps: vehicle.speed,
          speedKph: vehicle.speed * 3.6,
          headingDeg: vehicle.heading,
          positionAt: vehicle.positionAt,
          source: 'SpaceX public telemetry',
        },
      };
    },

    getSelectedInfo() {
      return layer.getInspectionInfo();
    },

    getRowControls() {
      const vehicle = selected();
      const count = snapshot?.vehicles.length || 0;
      const status = error
        ? t('Unavailable')
        : loading
          ? t('Loading...')
          : count
            ? t('LIVE')
            : t(msg('No active Starship telemetry'));

      const detail = vehicle
        ? t(
            msg(
              '{name} · Altitude {altitude} · Speed {speed} · Heading {heading}°',
            ),
            {
              name: vehicle.name,
              altitude: formatAltitude(vehicle.alt),
              speed: formatSpeedKph(vehicle.speed),
              heading: vehicle.heading.toFixed(0),
            },
          )
        : count
          ? t(msg('{count} vehicles'), { count })
          : t(msg('No active Starship telemetry'));

      return {
        readout: true,
        summary: {
          label: t(msg('Starship Live')),
          coverage: t(msg('SpaceX public telemetry')),
          compact: vehicle ? detail : status,
          actions: [],
          settings: [],
          lines: vehicle
            ? [
                { id: 'position', text: t('LIVE'), muted: true },
                {
                  id: 'telemetry',
                  text: t(
                    msg(
                      'Altitude {altitude} · Speed {speed} · Heading {heading}°',
                    ),
                    {
                      altitude: formatAltitude(vehicle.alt),
                      speed: formatSpeedKph(vehicle.speed),
                      heading: vehicle.heading.toFixed(0),
                    },
                  ),
                },
              ]
            : [],
          detail,
          status,
          units: 'km/h',
        },
        list: {
          ariaLabel: t(msg('Starship Live vehicles')),
          items: (snapshot?.vehicles || []).map((item) => ({
            id: item.id,
            ordinal: 0,
            lead: /booster/i.test(item.id) ? t(msg('Booster')) : t(msg('Ship')),
            text: item.name,
            active: item.id === selectedId,
            params: { vehicleId: item.id },
          })),
        },
        chips: [],
        legendCategorical: true,
        legend: [
          { label: t(msg('Ship')), color: '#00ffff' },
          { label: t(msg('Booster')), color: '#ff9f43' },
        ],
        info: `\n${status}\n${detail}\n${t(msg('SpaceX public telemetry'))}`,
        infoTitle: t(
          msg(
            'Live Starship telemetry from the public SpaceX webcast feed. Select a vehicle to follow it. A booster marker appears only if SpaceX publishes booster telemetry.',
          ),
        ),
      };
    },

    setRowControlsListener(value) {
      listener = typeof value === 'function' ? value : null;
    },

    getStats() {
      return {
        count: snapshot?.vehicles.length || 0,
        countLabel: snapshot?.active
          ? undefined
          : t(msg('No active Starship telemetry')),
        lastUpdate: snapshot?.fetchedAt || null,
        loading,
        error,
        stale: false,
        source: 'SpaceX public telemetry',
        empty: !snapshot?.active,
      };
    },

    getDiagnostics() {
      return {
        enabled,
        loading,
        selectedId,
        entityCount: entities.size,
        tracked: viewer?.trackedEntity?.id || null,
      };
    },

    destroy() {
      if (destroyed) return;
      layer.disable();
      destroyed = true;
      removeClickHandler();
      if (typeof pickingServices.unregisterPickOwner === 'function')
        pickingServices.unregisterPickOwner('starship-live');
      if (dataSource && viewer) viewer.dataSources.remove(dataSource, true);
      dataSource = null;
      viewer = null;
      listener = null;
    },
  };

  return layer;
}

export const STARSHIP_LAYER_NAME = msg('Starship Live');
