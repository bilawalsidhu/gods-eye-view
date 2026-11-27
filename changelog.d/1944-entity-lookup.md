- An app embedding the viewer can give the search box an optional
  `entityLookup` (`createApplicationControls`): it is asked with the typed
  line once typing pauses, and the aircraft, ships, cameras and satellites it
  answers with are listed as rows, one named exactly by the line first.
  Choosing one switches its layer on if need be and picks it there as a
  Context row does, waiting for the layer's next load when it is not there
  yet; it is never followed. While the timeline is held away from live the
  lookup is asked as of that time (`at`), and an answer it marks
  `placed: false` (no position then) is listed with its detail and, when
  chosen, centred on where it was last seen with that detail under the
  field. The CCTV layer gains `pickById` (samehkhamis, #1944).
