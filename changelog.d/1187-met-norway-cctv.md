- Add MET Norway's weather-station webcams as a CCTV pack: about a dozen
  stills from Haukeliseter, Snåsa, Andøya, Vesterålen, Finnmark, the Hurum
  weather radar, Bjørnøya, Hopen and Jan Mayen, read keylessly from MET's
  public webcam list and shown under the existing "Norway" category. Each
  frame is pinned to the camera's own path on obs-view.met.no, and the
  list's "mot øst"-style facing sets the heading. Mainland cameras get
  their ground height from Kartverket's point-height API (Haukeliseter
  986 m), so they no longer sit below the terrain without 3D tiles.
  `CCTV_MET_ENABLED=0` disables the pack and `CCTV_MET_HEIGHTS=0` the
  height lookup. Data from MET Norway under NLOD 2.0 and CC BY 4.0
  (trygvehhh, #1187).
