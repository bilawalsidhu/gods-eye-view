- Flights, military flights and vessels move back as smoothly as they move on.
  A source whose snapshots at a time carry each contact's own fixes either
  side of it (`timeline.spanMs`, record `fixes`) lets a seek or a drag back
  within those fixes move every contact along its track, with no blank and no
  wait; the step there then loads in place of every contact. A contact is not
  drawn more than a minute before its first fix.
