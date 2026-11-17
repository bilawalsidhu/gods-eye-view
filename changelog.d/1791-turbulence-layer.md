- Add a Turbulence layer to the Weather group from the keyless NOAA Aviation
  Weather Center Data API: G-AIRMET turbulence forecasts for the contiguous US
  and SIGMETs for turbulence and mountain waves worldwide, drawn as
  translucent volumes from their floor to their top by severity, and pilot
  reports from the last three hours as points at their flight level. The
  keyless `/api/turbulence` proxy asks seven fixed questions at most every ten
  minutes and serves each feed stale for up to six hours when a refresh fails.
  The layer follows the timeline (the nearest forecast snapshot, the SIGMETs in
  force), and a click inside a volume or on a report opens a card that ends
  "Informational only · not for flight planning". Absolute shapes in a set
  made with `pickable: false` no longer take part in picks. Off by default;
  share-link token `03` (jhairgallardo, #1791).
