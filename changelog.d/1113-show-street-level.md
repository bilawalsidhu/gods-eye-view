- "Show me X on Street View" (or on Mapillary, KartaView or Panoramax): a
  `show_street_level` voice and typed action flies to the place, switches to
  Google 3D when the source needs it, lights that source in Street Level,
  turns the layer on and opens the nearest photo, reporting which step failed.
  Views and share links carry the same request (`street_level`, `sl=`), so
  `show_in_gods_eye_view` and a link can open a panorama at a place. Street
  View lookups from a geocoded place search up to 250 m; clicks keep 50 m. A
  plain link with `sl=google` arms Street View and leaves the billed load to a
  press of OPEN GOOGLE STREET VIEW; embedded views open it. The source the
  action lights stays lit like a chip click. An unavailable map stack now
  reports the controller's own reason instead of always asking for a Cesium
  ion token. When nothing is found and a 360°, flat or SINCE filter the source
  honours is on, the answer names the filter (Said Turksever, @asturksever,
  #1113).
