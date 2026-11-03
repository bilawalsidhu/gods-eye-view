- Add an opt-in statewide PennDOT / 511PA camera catalog with published map
  coordinates, county filters, snapshots and live fragmented MP4 HLS playback.
  Keep video authorization server-side with rate-limit backoff and bounded
  initialization/segment caches. Expand the shared camera catalog budget to
  12,000 by default (20,000 maximum) so the statewide feed can coexist with
  the other source packs; visible-card and live-session limits stay bounded
  (Dylan Maniatakes, @dylanmaniatakes, #1530).
