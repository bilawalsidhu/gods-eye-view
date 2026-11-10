- Add North Carolina's NCDOT DriveNC traffic cameras as an opt-in keyless
  CCTV pack (`CCTV_DRIVENC_ENABLED=1`; DriveNC states no reuse terms):
  the 400 nearest Raleigh, Charlotte and Greensboro by default, from the
  catalog the drivenc.gov map itself loads plus one tooltip lookup per
  registered camera for its code and still-view id, remembered across
  refreshes. Frames are pinned to `www.drivenc.gov/map/Cctv/`, and the
  camera code's N/S/E/W letter seeds a low-confidence heading. An optional
  `DRIVENC_API_KEY` reads the keyed TravelIQ catalog in one request instead.
  `CCTV_DRIVENC_MAX_SOURCES` sets the cap (martinthiele, #1511).
