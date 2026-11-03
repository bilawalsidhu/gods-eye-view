- Add Houston traffic cameras from Houston TranStar as a CCTV pack. The camera
  list is one keyless JSON request to
  `traffic.houstontranstar.org/data/layers/cctvSnapshots_json.js`; frames are
  stills synthesized from each numeric camera id on `www.houstontranstar.org`,
  so a catalog field cannot steer the proxy off-host. Cameras without a
  snapshot id, and cameras outside Greater Houston, are dropped. TranStar's
  `dir` field (the side of the freeway the camera sits on) seeds a
  low-confidence heading along the nearest lanes' travel direction. TranStar's
  Content Usage terms (traffic.houstontranstar.org/disclaimer.aspx) prohibit
  copying, distribution and external framing of its images without TxDOT's
  written permission, so the pack is off by default; operators should set
  `CCTV_HOUSTON_ENABLED=1` only if they hold that permission. Frames are
  relayed on demand with `no-store` and not archived. Once enabled, it loads
  the 250 cameras nearest downtown, Uptown, the Medical Center, IAH and
  Galveston; `CCTV_HOUSTON_MAX_SOURCES` changes that cap.
  Snapshots update about every 3 minutes. The catalog-wide ceiling is
  unchanged; extra cameras share it round-robin with the other packs
  (mvanhorn, #1125).
