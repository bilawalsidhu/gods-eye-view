- A failed Esri Satellite or keyless terrain load still shows OSM or flat terrain
  at once, but no longer lasts the whole session: while the fallback is on
  screen, the real provider is retried in the background (30 seconds, doubling
  to a 10-minute cap) and replaces it live once it loads. Map switches never
  wait for a retry (Aditya, @Rohilalala, #1111).
