- Add Swedish road cameras from Trafikverket as a CCTV pack: traffic-flow
  cameras and VViS road-condition cameras from the Trafikverket open API
  (CC0 1.0). The camera list needs a free Trafikverket API key
  (`CCTV_TRAFIKVERKET_API_KEY`); without one the pack is skipped with a single
  log line. The keyed request refuses redirects, its body read is capped, and
  every frame URL is pinned to the official `/v2/Images/` directory, which
  serves stills without a key. Cameras whose last photo is over a week old are
  dropped. `CCTV_TRAFIKVERKET_MAX_SOURCES` sets the cap (default 450, 8–1000)
  and `CCTV_TRAFIKVERKET_ENABLED=0` turns the pack off (EmpyreanMist, #646).
