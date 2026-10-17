- Add NASA JPL CNEOS Fireballs (bolide impact events) space data provider.
  Fetches global atmospheric fireball detections (optical total radiated energy,
  calculated impact energy, velocity, altitude, and geographical coordinates)
  from JPL's open Center for Near Earth Object Studies API via `/api/fireballs`.
  The provider features a 6-hour memory and disk cache with single-flight request
  coalescing and serve-stale-on-failure resilience (djabhi31, #1179).
