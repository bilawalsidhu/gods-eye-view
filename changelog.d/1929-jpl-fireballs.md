- Add a default-off Fireballs layer in Events: every located bright meteor and
  bolide in NASA/JPL CNEOS's Fireball Data API since 1988, drawn where each was
  brightest (at that altitude when known), sized by estimated impact energy and
  coloured by age, with a card and Context facts per event. A local
  `/api/fireballs/events` proxy caches JPL for an hour; share token `03`
  (thejaywollin, #1929).
