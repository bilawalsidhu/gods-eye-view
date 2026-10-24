export const manifest = {
  schemaVersion: 1,
  model: 'gfs',
  units: '°C',
  level: '2 m above ground',
  unavailable: false,
  stale: false,
  reason: null,
  grid: { nx: 2, ny: 2, lo1: 0, la1: 90, dx: 180, dy: 180, scale: 0.01 },
  cycle: {
    date: '20261022',
    hour: 6,
    forecastHour: 3,
    runIso: '2026-10-22T06:00:00Z',
    validIso: '2026-10-22T09:00:00Z',
  },
  gridUrl: '/api/air-temperature/grid/gfs-test.bin',
};
export const field = (values = [-20, 0, 20, 40]) => ({
  ...manifest,
  scalar: {
    kind: 'temperature',
    units: '°C',
    level: manifest.level,
    values: Float32Array.from(values),
  },
});
