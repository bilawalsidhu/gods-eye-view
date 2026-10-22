- Prevent malformed Overpass filters from blocking the local server, and reject
  cross-site or excessive query requests before reading their bodies
  (asturksever, #1264; fixes #1248).
- Release unread responses from the optional Google-token probe so keyless
  browser validation can settle; the Overpass gate recognizes only that probe's
  expected 404 as an unavailable capability (asturksever, #1264).
- Make tracking arrival checks respect the aircraft update cadence while checking
  orientation on the first reveal, avoiding false failures at faster render
  rates (asturksever, #1264).
