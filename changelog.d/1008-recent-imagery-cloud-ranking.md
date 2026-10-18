- Recent Imagery's START HERE no longer falls back to the newest day when no
  day is clear: it picks the least cloudy day covering the box, preferring a
  newer day within 10 scene-cloud points of it. Cloud is judged only on the
  HLS granules over the box, so a cloudy tile clipping its edge no longer
  condemns a clear day, and the day cards show that same cloud. In Bergen this
  chose a 30% day over the newest at 83% (trygvehhh, #1008).
