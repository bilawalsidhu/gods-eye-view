- Local ADS-B filters implausible altitude changes and holds the accepted
  value consistently for markers, cards and models. A corrupt frame can still
  pass CRC, and one reached the globe as a DC-9 at 108,800 ft. Browser
  refusals count actual altitude frames rather than unrelated aircraft
  messages. Decoder feeds use a conservative five-second recovery with three
  advancing snapshots and aircraft message activity, explicitly marked as
  inferred. Held values retain their altitude source and measurement time
  through context and analyst results; feeds report an unknown measurement
  time. Cached snapshots and transport jitter cannot recount refusals. Ground
  reports reset the airborne reference. The layer stats count refusals as
  `rejectedAltitudes` (Pedro Lobato and Mazeyar Moeini Feizabadi, #801, #1290).
