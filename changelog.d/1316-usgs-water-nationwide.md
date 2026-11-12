- Add nationwide USGS water levels: Rivers & Streams, Lakes & Reservoirs and
  Springs in a new Water group. The server refreshes the newest gauge readings
  from the USGS Water Data OGC API hourly (under 40 requests an hour keyless;
  optional `USGS_WATER_API_KEY` stays on the server) and streams load by
  viewport tile. The gauge cards show their readings, numbers and times in
  the active language and follow a language switch (Byrd-IT, #1316).
