- Add Auckland traffic cameras from Waka Kotahi NZTA as an opt-in CCTV pack
  (`CCTV_AUCKLAND_ENABLED=1`). The camera list is one keyless GeoJSON request
  to `journeys.nzta.govt.nz/assets/map-data-cache/cameras.json`, the Journeys
  site's own asset rather than the documented Traffic and Travel API, and the
  site terms leave the licence for the catalog and the stills unconfirmed, so
  the pack is off by default like NYC and Lithuania. Once enabled, only
  Auckland (RegionID 7) cameras that are online stay. Frames are stills
  synthesized from each camera's `ExternalId` on `www.trafficnz.info`, so a
  catalog field cannot steer the proxy off-host. The 120 cameras nearest
  downtown, Albany, Manukau, the airport and Henderson load, and
  `CCTV_AUCKLAND_MAX_SOURCES` changes the cap. The catalog-wide ceiling is
  unchanged; extra cameras share it round-robin with the other packs
  (mvanhorn, #1126).
