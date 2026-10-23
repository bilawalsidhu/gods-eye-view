- Add MET Norway's weather-station webcams as an opt-in CCTV pack
  (`CCTV_MET_ENABLED=1`): stills from MET's observation sites, from the Hurum
  weather radar and Finnmark to Bjørnøya, Hopen and Jan Mayen, read keylessly
  from MET's public webcam list and shown under the existing "Norway"
  category. It stays off by default until MET confirms its webcam images may
  be reused, and cameras MET lists as still in test are skipped. Each frame is
  pinned to the camera's own path on obs-view.met.no, and the list's "mot
  øst"-style facing sets the heading. Mainland cameras get their ground height
  from Kartverket's point-height API through the lookup the Statens vegvesen
  cameras use, so the two packs share one cache and one backoff;
  `CCTV_MET_HEIGHTS=0` skips it. Data from MET Norway under NLOD 2.0 and CC
  BY 4.0 (trygvehhh, #1187).
