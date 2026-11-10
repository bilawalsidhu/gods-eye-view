- Flights, Military Flights and AIS Vessels follow the world clock when their
  source declares a timeline, that is, can answer a snapshot at a given time
  (`source.timeline`, read by `readSnapshotTimeline` from
  `gods-eye-view/sources/live`). Away from live they show the snapshot at the
  clock's time and move on with it as it plays; back at live they poll as
  before. A source with no timeline keeps them live, unchanged (Sameh Khamis,
  @samehkhamis, #PR).
