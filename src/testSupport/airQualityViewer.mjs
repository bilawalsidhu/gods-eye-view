import { bindFakeDraw } from './fakeDrawPort.mjs';
import { horizonFrom } from '../geo/horizon.js';

/** Bind the renderer ports used by observation-layer test fixtures. */
export function initAirQualityTestLayer(layer, fixture = {}) {
  const camera = fixture.camera;
  const horizon = camera?.positionWC ? horizonFrom(camera.positionWC) : null;
  const viewer = {};
  const { draw } = bindFakeDraw(viewer, {
    camera: {
      viewRectangle() {
        const rectangle = camera?.computeViewRectangle?.();
        return rectangle
          ? Object.fromEntries(
              Object.entries(rectangle).map(([key, radians]) => [
                key,
                (radians * 180) / Math.PI,
              ]),
            )
          : null;
      },
      on: (event, listener) =>
        camera?.[event]?.addEventListener(listener) ?? (() => {}),
    },
    query: {
      isOccluded: (position) =>
        horizon ? !horizon.isPointVisible(position) : false,
    },
  });
  layer.init(viewer);
  return draw;
}

/**
 * Resolve once no provider of an air-quality layer is still asking: an
 * update resolves on the first provider's answer, the others land later.
 */
export async function airQualitySettled(layer, { turns = 200 } = {}) {
  for (let turn = 0; turn < turns; turn++) {
    if (!layer.getProviderStates().some((state) => state.status === 'loading'))
      return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('air-quality providers did not settle');
}

/**
 * A fixture's per-pollutant rows, each one hourly mean, as an AQI-view
 * answer the US AQI can rate (`usAqi.js`): PM2.5 and PM10 get the two hours
 * before with the same value (their NowCast is then that value), ozone and
 * CO add an 8-hour average of the same value (the newest, so it rates),
 * NO2 and SO2 stay 1-hour values.
 */
export function onAqiPeriods(rows) {
  if (!Array.isArray(rows)) return rows;
  return rows.flatMap((row) => {
    if (row?.averagingMinutes !== 60 || !Number.isFinite(row.observedMs))
      return [row];
    if (row.parameter === 'PM2.5' || row.parameter === 'PM10')
      return [1, 2]
        .map((ago) => ({ ...row, observedMs: row.observedMs - ago * 3600_000 }))
        .concat(row);
    if (row.parameter === 'O3' || row.parameter === 'CO')
      return [
        { ...row, observedMs: row.observedMs - 1 },
        { ...row, averagingMinutes: 480 },
      ];
    return [row];
  });
}
