- The read-only query proxies state their method contract. `/api/flights`,
  `/api/military` and `/api/route` answered any verb with the same body
  while ignoring the request; they now answer `405 Method Not Allowed` to
  anything but `GET`, the way `/api/geocode` and the other query proxies
  already did, and declare `Allow: GET` with it the way `/api/radio/stations`
  does. The refusal precedes rate limiting and any upstream call
  (daikaginza, #794).
