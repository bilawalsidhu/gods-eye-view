- Renderer contract: a timed imagery source can be `decoded` (the
  `imageryDecoded` capability), tiles the application makes itself and hands
  over as finished images, slot by slot; the Cesium renderer draws each slot
  as an imagery layer of its own, and the check `globe.imagery.decoded` covers
  it (Sameh Khamis, #1834).
