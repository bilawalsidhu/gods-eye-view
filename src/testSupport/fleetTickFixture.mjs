// A layer's real fleet tick and horizon culling (flights or military
// rendering.js) over one contact, with motion and presentation injected: no
// WebGL scene. The camera is 100 m over (0°, 0°); the contact, on the ground
// at (1°, 0°), is 111 km away: beyond the camera's horizon, but inside the
// model keep radius.

import * as Cesium from 'cesium';
import { horizonVisible } from '../globe/cameraMath.js';
import { FLEET_DR_INTERVAL_MS } from '../layers/flights/policy.js';

/**
 * @param {{ createFlightState: Function, createRendering: Function }} layer
 *   The layer's state.js and rendering.js factories.
 */
export function fleetTickFixture({ createFlightState, createRendering }) {
  let now = 1000;
  let reckonings = 0;
  const services = {
    groundSnap: { createGroundSnap: () => ({ clear() {} }) },
    militaryRegistry: { isMilitaryIcao: () => false },
    aircraftPresentation: { isTr3b: () => false },
    camera: {},
    focus: {
      focusNowMs: () => now,
      getFocusTarget: () => null,
      nearFarScalarValueAtDistance: () => 1,
      advanceProjectedSpriteFocus: () => ({ factor: 1 }),
    },
    recession: {
      applyAircraftBillboardTreatment: () => ({
        factors: { scale: 1 },
        alpha: 1,
      }),
    },
  };
  const flightState = createFlightState({ services });
  const camera = {
    positionWC: Cesium.Cartesian3.fromDegrees(0, 0, 100),
    positionCartographic: { height: 100 },
    heading: 0,
    pitch: 0,
    roll: 0,
    frustum: {
      computeCullingVolume: () => ({
        computeVisibility: () => Cesium.Intersect.INSIDE,
      }),
    },
  };
  const id = 'abc123';
  const billboard = {
    show: false,
    position: Cesium.Cartesian3.fromDegrees(1, 0, 0),
  };
  const removed = [];
  // The renderer's fleet, models and view, as the Cesium renderer gives
  // them; no model loads.
  flightState._renderer = {
    fleet: { visible: () => true },
    models: {
      live: () => true,
      loadFleet: () => Promise.reject(new Error('no models here')),
      remove: (model) => removed.push(model),
    },
    view: {
      camera,
      scene: {},
      horizon: () => ({
        isPointVisible: (position) =>
          horizonVisible(camera.positionWC, position),
      }),
      frustumTester: () => () => true,
    },
  };
  flightState._billboards.set(id, billboard);
  flightState.records.data.set(id, {});
  flightState._models3dEnabled = false;
  // Far cockpit contacts avoid glyph rasterization, keeping the fixture DOM-free.
  flightState._cockpitContactMode = true;
  const parts = {
    tracking: { _refreshCockpitNearContacts() {} },
    enrichment: { _requestTypeEnrichment() {} },
    motion: {
      _deadReckon() {
        reckonings++;
        return billboard.position;
      },
      _floorGroundedDisplayPosition(id, info, position) {
        return position;
      },
    },
  };
  const rendering = createRendering({ flightState, services, parts });
  return {
    flightState,
    camera,
    billboard,
    id,
    /** Fleet models the tick released. */
    removed,
    reckonings: () => reckonings,
    tick() {
      now += FLEET_DR_INTERVAL_MS;
      rendering._fleetTick();
    },
  };
}
