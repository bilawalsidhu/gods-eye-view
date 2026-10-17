- Add an SA Fire Incidents layer for South Australian CFS and MFS current
  incidents and CFS public warnings. Markers are ground-clamped and coloured by
  status and sized by level; warning areas draw on the globe and on 3D tiles.
  The row shows the feed's last-updated time in Adelaide time, status counts and
  CFS/MFS filter chips. The retired feed's HTML "File Unavailable" reply counts
  as a failure and serves the last good data, and unavailable warnings are
  reported as unavailable rather than as none. The feed is CC BY-NC-ND, so
  commercial deployments must check its terms (see `DATA_SOURCES.md`)
  (bennypixel, #1089).
