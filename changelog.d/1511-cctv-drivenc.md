- Add North Carolina's NCDOT DriveNC traffic cameras as a keyless CCTV pack:
  the 400 nearest Raleigh, Charlotte and Greensboro by default, from the
  catalog the drivenc.gov map itself loads plus one tooltip lookup per
  registered camera for its code and still-view id, remembered across
  refreshes. Frames are pinned to `www.drivenc.gov/map/Cctv/`, and the
  camera code's N/S/E/W letter seeds a low-confidence heading. An optional
  `DRIVENC_API_KEY` reads the keyed TravelIQ catalog in one request instead.
  `CCTV_DRIVENC_MAX_SOURCES` sets the cap and `CCTV_DRIVENC_ENABLED=0` turns
  the pack off (martinthiele, #1511).
