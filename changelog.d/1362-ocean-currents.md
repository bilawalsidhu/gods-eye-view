- Add a keyless **Ocean currents** weather layer: global surface sea water
  velocity from the ocean model coupled to ECMWF IFS (open data, CC BY 4.0),
  masked jointly over land and served as one 0.5° u/v float32 grid by the new
  `/api/ocean-currents` route, which shares its cycle fallback, hourly cache
  and 24 h stale policy with Sea state. Speed is shaded between 0.1 and
  1.5 m/s and the wind streamline renderer draws animated flow lines with a
  slower ocean profile that reaches the coast and pauses for reduced motion
  (daikaginza, #1362).
