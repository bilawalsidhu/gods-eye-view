- Recent Imagery's START HERE no longer falls back to the newest day when no
  day is clear: it picks the least cloudy day covering the box, preferring a
  newer day within 10 scene-cloud points of it. A day's cloud is weighted by
  the share of the box each HLS granule covers, so a cloudy tile overlapping
  the box by a sliver no longer condemns a clear day, and the day cards show
  the cloud range of the granules over the box. In Bergen this chose a 30%
  day over the newest at 83% (trygvehhh, #1008).
