- Add an opt-in statewide PennDOT / 511PA camera catalog with published map
  coordinates, a separate PennDOT Traffic Cams data-list toggle, road/intersection
  map labels, county filters, snapshots and live
  fragmented MP4 HLS playback.
  Keep video authorization server-side with rate-limit backoff and bounded
  initialization/segment caches. Expand the shared camera catalog budget to
  12,000 by default (20,000 maximum) so the statewide feed can coexist with
  the other source packs. Reduce marker density and ambient thumbnails as the
  map zooms out, restoring detail on zoom in while keeping the selected feed
  available. Camera name labels use a separate, stricter city-scale budget
  and hide above 30 km while icons remain visible; live-session limits stay bounded
  (Dylan Maniatakes, @dylanmaniatakes, #1530).
  Preserve valid multi-county selections beyond 32 one-page results with
  a bounded 100-page catalog request budget.
