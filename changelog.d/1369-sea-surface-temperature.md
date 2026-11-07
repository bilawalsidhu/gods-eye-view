- Add a keyless **Sea surface temperature** weather layer: the newest day of
  NOAA Coral Reef Watch CoralTemp v3.1, a daily night-time satellite
  analysis, read from the NOAA CoastWatch ERDDAP at every tenth 0.05° cell
  and shaded on a continuous -2 to 32 °C ramp under the other ocean fields.
  The new `/api/sea-surface-temperature` route refreshes every three hours
  and serves the last day for up to 72 h with `X-Data-Stale` before
  answering `502 sea_surface_temperature_unavailable`. The cached grid route
  shared with Sea state and Ocean currents is now source-neutral
  (`server/providers/globalFieldRoute.js`) (daikaginza, #1369).
