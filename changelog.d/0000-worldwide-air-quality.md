- Air quality now reads every provider together as one station set: worldwide
  OpenAQ observations with South Africa's SAAQIS (khanmjk, #1291) and India's
  CPCB through OGD (m3ayush, #1204), reviewed by kvnloo. The default view is a
  US AQI that GEV computes per station from its readings with the US EPA's
  breakpoints (not an official reading), beside Canada's AQHI and one view per
  pollutant on the European Air Quality Index bands (carbon monoxide on
  WHO-based bands). Stations cluster at far zoom, and the Weather panel gets a
  slim tile card for the index and each pollutant. A host can supply a gridded
  model field with its forecast, drawn under the stations and spanned by the
  timeline, with the field's own credit shown in the data credits; stand-alone
  Core can read one from a local folder (`AIR_QUALITY_FIELD_DIR`) for
  development. Enter the OpenAQ and data.gov.in keys in Provider Settings (or
  set `OPENAQ_API_KEY` and `DATA_GOV_IN_API_KEY`) to use OpenAQ and CPCB.
  South Africa is off by default, since no reuse licence is established for the
  portal's session API: set `SAAQIS_ENABLED=1` to read it. Without keys the
  layer still turns on, says which keys it needs, and keeps Canada's AQHI a
  click away.
- Reject calendar-impossible SAAQIS observation timestamps instead of
  silently rolling them into another day (khanmjk, #1291).
