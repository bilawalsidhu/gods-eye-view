- Space Missions no longer shows an older satellite with a similar name and a
  different known launch year as a new payload's orbit: the launch-year check
  on loaded satellites now runs (Aditya, @Rohilalala, #1453).
- Satellite launch years come from one TLE designator parser for both the
  loaded catalog and the active-TLE fallback; a blank designator is an
  unknown year instead of 2000 (#1453).
