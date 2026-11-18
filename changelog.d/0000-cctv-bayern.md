- Add an opt-in BayernInfo (VIZ-BY) CCTV pack: 432 Bavarian road webcams from
  the public `map.bayerninfo.de` camera list, each with its real viewing
  bearing, projected into the 3D scene like other camera packs. The list's
  Austrian ASFINAG cameras are excluded and only the `cam/bi/` frame directory
  is registered. BayernInfo publishes no reuse licence for the images and
  documents the feed only through the Mobilithek, so the pack is off by default
  and loads only when an operator confirms the terms and sets
  `CCTV_BAYERN_ENABLED=1` (Herr-Enklo, #0000).
