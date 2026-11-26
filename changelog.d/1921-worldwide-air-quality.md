- Air quality now reads every provider together as one station set: worldwide
  OpenAQ observations with India's CPCB through OGD (m3ayush, #1204), reviewed
  by kvnloo. Every station is rated
  from its concentrations: the default view is a US AQI that GEV computes per
  station with the US EPA's breakpoints (not an official reading), and one view
  per pollutant uses the European Air Quality Index bands (carbon monoxide on
  WHO-based bands). The computed US AQI is the one index worldwide: Canada's
  AQHI is retired, as it covered Canada only, Canadian stations come through
  OpenAQ like every other country's, and no network's own index is requested
  or shown. Stations cluster at far zoom, and the
  Weather panel gets a slim tile card for the index and each pollutant. A host
  can supply a gridded model field with its forecast, drawn under the stations
  and spanned by the timeline, with the field's own credit shown in the data
  credits; stand-alone Core can read one from a local folder
  (`AIR_QUALITY_FIELD_DIR`) for development. Enter the OpenAQ and data.gov.in
  keys in Provider Settings (or set `OPENAQ_API_KEY` and `DATA_GOV_IN_API_KEY`)
  to use OpenAQ and CPCB. A stand-alone install without keys therefore shows no stations:
  the layer still turns on, its Layers row says KEY REQUIRED and names the keys
  it needs instead of reading unavailable, and its card says which keys to add,
  OpenAQ's first. Installs with keys are unaffected. A host's own provider
  returns pollutant concentrations, one row per station and pollutant. For example:

  ```js
  const row = {
    id, provider, stationId, name, lat, lon, observedMs,
    parameter: 'PM2.5', units: 'µg/m³', value: 9,
    kind: 'observation', averagingMinutes: 60,
  };
  ```

  Rows of the previous index contract (`scale`, `value` and `band` without
  `parameter`) draw no stations. A host using the reference source needs the
  `/api/air-quality` routes or its own providers, or should withhold the layer.
  `createEcccAirQualitySource` is removed from `./layers/air-quality` and
  `./layers/air-quality/source`, as are the AQHI helpers `./layers/air-quality`
  exported (`AIR_QUALITY_BANDS`, `AIR_QUALITY_PROVIDERS`, `airQualityBandById`,
  `airQualityColor`, `aqhiDisplayValue`, `bandForValue`, `bandRiskText`,
  `valueLabel`, `normalizeAqhiStations`, `normalizeAqhiObservations`). A layer
  source without provider definitions is read as one station network, and an
  empty list of them is refused. A layer's `requiresKeyId` may now be a string
  or an array of key ids, all of which the Layers row names.
