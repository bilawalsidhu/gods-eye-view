- `/api/firms` reuses one serialised response for requests that would get the
  same payload instead of rebuilding the whole fire set each time, and gzips it
  for clients that accept gzip. `gods-eye-view/sources/firms-csv` now exports
  `trailing24hWindow`, the trailing-24-hour filter with the span over which its
  result holds (mazy1998, #1711).
