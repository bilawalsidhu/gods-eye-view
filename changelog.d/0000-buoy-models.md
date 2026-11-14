- Draw aids to navigation as buoys instead of ships: a buoy, beacon, RACON,
  light or mark from the vessel feed (or any AIS station numbered 99MIDxxxx)
  is now the fleet set's buoy of its IALA mark (cardinal, port or starboard
  hand, safe water, isolated danger or special mark), standing still with no
  heading, and its icon is a disc rather than a chevron. Its card and readout
  show its kind of mark with no speed or heading. AISStream now subscribes to
  aid-to-navigation reports and names each by its kind of mark and its full
  name; the feed lists every ship ahead of any aid, and `vessels_in_area`
  counts ships only (samehkhamis, #0000).
