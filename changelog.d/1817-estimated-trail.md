- An aircraft feed can mark estimated positions (`estimatedByIcao` beside state
  vectors, `estimated: true` on a readsb-style row). Such a position still
  places the aircraft, but stands in on the tracked trail only until the next
  received one, so oceanic trails no longer zigzag (samehkhamis, #1817).
