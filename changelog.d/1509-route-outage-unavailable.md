- A routing service outage (an error status, no answer or a non-JSON body)
  is reported as "routing service unavailable" instead of "no route found",
  so voice route planning and the Directions layer no longer blame the
  request (quanticsoul4772, #1509).
