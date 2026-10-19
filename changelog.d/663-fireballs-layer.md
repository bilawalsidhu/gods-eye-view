- Add a Fireballs layer (Events group) plotting recent NASA/JPL fireball and bolide
  detections, colored and sized by approximate impact energy. CNEOS publishes these with a
  delay and not every fireball is reported, so the layer is not a live feed. Served through a cached
  `/api/fireballs` proxy because the upstream sends no CORS headers; malformed
  responses keep the last good snapshot. Adds the `./layers/fireballs` export,
  share-link token `5` and NASA/JPL attribution (Kaushik2210, #663).
