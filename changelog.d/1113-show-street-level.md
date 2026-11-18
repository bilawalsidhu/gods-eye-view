- "Show me X on Street View" (or on Mapillary, KartaView or Panoramax): a
  `show_street_level` voice and typed action flies to the place, switches to
  Google 3D when the source needs it, lights that source in Street Level,
  turns the layer on and opens the nearest photo, saying which step failed.
  With no place named it looks under the screen centre, as OPEN does. Views
  and share links carry the same request (`street_level`, `sl=`). A plain
  `sl=google` link never loads a billed panorama by itself: it arms Street
  View and leaves the load to OPEN GOOGLE STREET VIEW; embedded views open it,
  and so does the God's Eye View panel for a result issued in the last five
  minutes; a link whose source has no working key says so. A request stops
  when the user navigates, or enters cockpit, clean view, recording or scene
  playback, before its photo loads (collapsing the panel does not stop it: the
  photo reveals it); a new photo replaces the open one in place, so EXPAND
  stays. When nothing is found and a 360°, flat or SINCE filter is on, the
  answer names the filter. Failure cards are in the interface language. An
  unavailable map stack now reports the
  controller's own reason instead of always asking for a Cesium ion token
  (Said Turksever, @asturksever, #1113).
