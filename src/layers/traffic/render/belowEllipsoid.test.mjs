// Traffic on roads below the WGS84 ellipsoid (negative ellipsoidal heights:
// southern India and Sri Lanka, Florida, the Dead Sea) stays drawn while the
// camera is low above the road, as Cesium's PointPrimitiveCollection did on main.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as geo from '../../../geo/index.js';
import { GROUND_HARNESSES } from '../../../testSupport/groundDisplayEngines.mjs';
import { nearFarScale } from '../../shared/color.js';
import { SIM_DOT_COLOR } from '../policy.js';
import { TRAFFIC_SET_IDS as IDS, createTrafficDisplay } from './display.js';

// Colombo: the ground stands about 93 m below the ellipsoid.
const LON = 79.85;
const LAT = 6.93;
const GROUND_M = -93;

for (const makeHarness of GROUND_HARNESSES) {
  test(`a car on a road below the ellipsoid stays drawn under a low camera (${makeHarness().name})`, (t) => {
    const h = makeHarness();
    t.after(() => h.destroy());
    // Camera 50 m above the road, looking at a car 500 m ahead.
    h.engine.camera.setView({
      destination: geo.cartesian3.fromDegrees(LON, LAT, GROUND_M + 50),
    });
    const display = createTrafficDisplay(h.engine);
    t.after(() => display.destroy());
    display.drawDots([
      {
        point: {
          position: geo.cartesian3.fromDegrees(
            LON,
            LAT + 0.0045,
            GROUND_M + 1.5,
          ),
          pixelSize: 5,
          color: SIM_DOT_COLOR,
          show: true,
          scaleByDistance: nearFarScale(100, 1.5, 8000, 0.3),
          translucencyByDistance: nearFarScale(100, 1, 10000, 0),
          outlineColor: null,
          outlineWidth: 0,
        },
      },
    ]);
    const { store } = h.engine.fake.moverSet(IDS.fill);
    assert.equal(store.count, 1, 'the car is drawn');
  });
}
