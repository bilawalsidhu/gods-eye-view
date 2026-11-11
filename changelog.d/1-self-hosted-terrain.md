- Let an operator choose the keyless terrain: `GEV_TERRAIN_URL` takes an https
  quantized-mesh URL in place of Re:Earth, or `none` for flat terrain with no
  terrain requests. Once it is set, the `/api/terrain/heights` proxy contacts
  no upstream and the page places objects on its bundled geoid. Unset,
  Re:Earth stays the default (daika, #PR).
