- When the routing service is down (an error status, no answer or a non-JSON
  body), voice route planning hears "Routing service unavailable" and the
  Directions layer shows "Routing unavailable" instead of "no route found",
  so neither blames the request (quanticsoul4772, #1509).
