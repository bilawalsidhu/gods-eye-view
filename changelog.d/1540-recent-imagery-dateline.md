- Recent Imagery takes a box dragged across the dateline as the short box across
  ±180° instead of refusing it as about 360° wide. A day counts when either side
  has imagery. A side confirmed empty is not draped, and the VIIRS overview
  drapes only a side confirmed to have data. Voice accepts named areas across
  the dateline. EXPORT and `get_recent_imagery` refuse such a box, since
  Worldview Snapshots cannot draw one (Byrd-IT, #1540).
