- Add a global NOAA SWPC OVATION aurora probability layer covering both
  hemispheres. The 1° forecast grid is drawn as a stack of raised shells between
  95 km and 320 km, where auroral emission occurs, on every map source. It polls
  on NOAA's roughly five-minute cadence through a shared bounded proxy and is
  labelled throughout as a variable 30–90 minute FORECAST, with separate valid
  and issue times and explicit visibility uncertainty. Between generations the
  older field is rotated about the geomagnetic dipole axis to a shared magnetic
  local time before blending, so the oval slides into place instead of
  dissolving in one spot and appearing in another (KnottyDyes, #885).
