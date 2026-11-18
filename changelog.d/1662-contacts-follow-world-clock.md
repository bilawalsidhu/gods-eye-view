- Flights, Military Flights and AIS Vessels follow the world clock when their
  source declares a timeline, that is, can answer a snapshot at a given time
  (`source.timeline`, read by `readSnapshotTimeline` from
  `gods-eye-view/sources/live`). Away from live they show the snapshot at the
  clock's time and move on with it as it plays; back at live they poll as
  before. A source's `timeline.subscribe` may also tell of a better answer
  for a time it has answered; paused, the layer loads the time shown again.
  A source with no timeline keeps them live, unchanged (Sameh Khamis,
  @samehkhamis, #1662).
- AIS Vessels are keyed by the stable id their live source gives (`id` on a
  vessel record), not by MMSI: vessels can share an MMSI, through spoofing,
  reused numbers or defaults such as 0, and a number can move to another
  hull. Two vessels sharing an MMSI are now two vessels, each selected,
  followed and carded on its own. The MMSI is an attribute (`mmsi`), shown
  when known and `--` otherwise, up to ten digits; looking a vessel up or
  selecting it by MMSI (an older link, say) still finds a vessel with it, and
  a vessel with no name is no longer named by its id. `vesselSnapshot` takes
  `idFor(row)` for a source whose rows carry an id of their own. Tool and voice results carry the vessel's id beside its MMSI
  (`id`, or `vesselId` where `id` is a display label), and `get_vessel_track`
  also takes an `id`. AISStream has only MMSIs, so its vessels are keyed by
  MMSI and nothing changes there (Sameh Khamis, @samehkhamis, #1662).
- A share link made while a vessel is selected (and the camera follows
  nothing) now opens that vessel: the link names it, opens with the camera
  where it was, looking at the vessel, and selects the vessel once the feed
  has it, at the link's world time when it has one. A vessel id that is a
  source's stable id, such as a UUID, travels as its 16 bytes in a new thing
  field (13), so the link stays short (62 characters where a followed
  aircraft's is 44). MMSI and other ids, and links already shared, are
  unchanged; an app that predates the field opens such a link at the same
  camera, without selecting the vessel. A camera that no follow offset can
  carry (below the vessel's horizon, say) still makes a place view.
  A shared flight, military flight, vessel or satellite that is not reporting
  now says so in a sentence ("The shared vessel isn't reporting now — showing
  where it was at 14:05"), with its id on a second line under it (ICAO,
  NORAD, MMSI or vessel UUID) instead of at the head of the sentence (Sameh
  Khamis, @samehkhamis, #1662).
