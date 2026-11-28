- Air quality now reads every provider together as one station set, reviewed
  by kvnloo. OpenAQ is the bundled station source, worldwide (khanmjk, #1291).
  m3ayush's CPCB feed (#1204) was dropped because OpenAQ carries those
  stations: it republishes national networks such as India's CPCB and South
  Africa's SAAQIS, so they are not read separately. Every station is rated
  from its concentrations: the default view is a US AQI that GEV computes per
  station with the US EPA's breakpoints (not an official reading), and one
  view per pollutant uses the
  European Air Quality Index bands (carbon monoxide on WHO-based bands). The
  computed US AQI is the one index worldwide: Canada's AQHI is retired, as it
  covered Canada only, Canadian stations come through OpenAQ like every other
  country's, and no network's own index is requested or shown. Stations
  cluster at far zoom, and the Weather panel gets a slim tile card for the
  index and each pollutant. A host can supply a gridded model field with its
  forecast, drawn under the stations and spanned by the timeline, with the
  field's own credit shown in the data credits; a stand-alone install can read
  one from a local folder (`AIR_QUALITY_FIELD_DIR`) for development. Enter the
  OpenAQ key in Provider Settings (or set `OPENAQ_API_KEY`) to use OpenAQ. A
  stand-alone install without it therefore shows no stations: the layer still
  turns on, its Layers row says KEY REQUIRED and names the key it needs instead
  of reading unavailable, and its card says which key to add. Installs with
  the key are unaffected. A host can replace the provider list with its own
  station networks (`createAirQualitySource({ providers })`); a host's
  provider returns pollutant concentrations, one row per station and
  pollutant. For example:

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

  The US AQI rates each pollutant on the EPA's averaging period: PM2.5 and
  PM10 on the NowCast of their last 12 hourly means (two of the last three
  needed), ozone on the EPA's ozone NowCast over two weeks of hours (its
  surrogate when they are too few) and on the 1-hour rows from 0.125 ppm, CO
  on its 8-hour mean (six of eight hours), NO2 and SO2 on their 1-hour
  values, with SO2's 24-hour value above 304 ppb; a 24-hour SO2 rates on its
  own where no 1-hour value of its time is usable. Ozone's 1-hour mean and
  SO2's 24-hour value count only within three hours of the value they go
  with, and an hour above its fault ceiling counts as missing. A pollutant without its
  period gets no sub-index, and the station's details say why. A host's rows
  change meaning accordingly: one hourly PM row alone no longer gives an
  index (send the last hours for a NowCast), rows stating `averagingMinutes`
  1440 for PM or 480 for ozone and CO are rated as they are, and a PM, ozone
  or CO value without a stated period is not rated. Low-cost sensors (OpenAQ's
  `isMonitor` false, `monitor: false` on a host's rows) get no US AQI; the
  pollutant views keep them, their rows and details marked as sensors. Where
  two networks report one site, the AQI view pools their pollutants, each the
  freshest value, and names the network a pooled value came from; matching
  sites works across the antimeridian and near the poles. OpenAQ asks each
  sensor's hourly means at most once an hour, one view spends at most a
  quarter of the hourly request budget and asks less often while nothing new
  arrives in it, re-checking the stations it shows before their readings age
  out so a wide view holds a stable set, and only a refusal naming the key (a 401, or a 403 that
  says so) stops the key being sent.
