- Judge again, once a second and after each catalog update, whether a tracked
  vehicle is docked to a station, so one that undocks gets its own ring back
  and leaves the STATION and LIVE sections, and one that docks hands its ring
  to the station's. A docked object stays so until 15 km apart, so a pair
  whose elements swing about 5 km does not flip (Denis Groshev, @ZloyS,
  #1881).
- Keep a tracked satellite's orbit ring through the 5-minute catalog update,
  which removed it, and build every ring by the Orbits setting; a ring baked
  again keeps whether it shows (Denis Groshev, @ZloyS, #1881).
- Show "Telemetry incomplete · computed values" while the ISS relay has signal
  but lacks an array or radiator joint, keep the last whole pose through a
  relay reconnect, and read a busy relay as connecting. The relay now admits
  240 requests a minute per address and 12,000 in all, so a reverse proxy or
  the Docker bridge, where every browser shares one address, fits about 20
  tabs instead of 5 (Denis Groshev, @ZloyS, #1881).
- Keep a station joint set by hand before the model is drawn, give back every
  dot a station stood in for when its orbit will not propagate, and build the
  STATION section only when something it shows changes (Denis Groshev, @ZloyS,
  #1881).
