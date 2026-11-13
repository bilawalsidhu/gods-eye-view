/** Parse the provider's v1 contract before following any grid URL. */
export function parseAirTemperatureManifest(value) {
  const invalid = () => {
    throw new Error('Malformed air temperature manifest');
  };
  if (
    value?.schemaVersion !== 1 ||
    value.model !== 'gfs' ||
    value.units !== '°C' ||
    value.level !== '2 m above ground' ||
    typeof value.unavailable !== 'boolean' ||
    typeof value.stale !== 'boolean'
  )
    invalid();
  if (value.unavailable) {
    if (value.reason !== 'Air temperature upstream unavailable') invalid();
    return value;
  }
  const { grid, cycle } = value;
  if (
    !grid ||
    !Number.isInteger(grid.nx) ||
    !Number.isInteger(grid.ny) ||
    grid.nx < 2 ||
    grid.ny < 2 ||
    grid.nx * grid.ny > 1_000_000 ||
    ![grid.lo1, grid.la1, grid.dx, grid.dy].every(Number.isFinite) ||
    grid.dx <= 0 ||
    grid.dy <= 0 ||
    grid.scale !== 0.01 ||
    Math.abs(grid.nx * grid.dx - 360) > 0.01 ||
    Math.abs(grid.la1 - 90) > 0.01 ||
    Math.abs((grid.ny - 1) * grid.dy - 180) > 0.01 ||
    !/^\/api\/air-temperature\/grid\/gfs-[\w.-]+\.bin$/.test(value.gridUrl) ||
    !cycle ||
    !Number.isInteger(cycle.forecastHour) ||
    cycle.forecastHour < 0 ||
    !Number.isFinite(Date.parse(cycle.runIso)) ||
    !Number.isFinite(Date.parse(cycle.validIso)) ||
    Date.parse(cycle.validIso) - Date.parse(cycle.runIso) !==
      cycle.forecastHour * 3600_000
  )
    invalid();
  return value;
}

export const temperatureInUnits = (celsius, units) =>
  units === '°F' ? (celsius * 9) / 5 + 32 : celsius;
