- Aircraft on the map are shaded sprites that show the view of the aircraft
  from where the camera is, instead of flat top-down silhouettes: each class
  (and each helicopter rotor frame) is drawn from a sheet rendered from a
  sphere of camera angles, laid flat along its course, so a plane seen at an
  oblique angle looks solid. Flights, Military Flights (fleet and tracked
  contact) and Local ADS-B use it; the TR-3B, airport vehicles, ground
  stations and Cockpit's far pips stay flat, and a renderer without view
  sheets draws the flat glyphs as before (Mazeyar Moeini Feizabadi, #0000).
