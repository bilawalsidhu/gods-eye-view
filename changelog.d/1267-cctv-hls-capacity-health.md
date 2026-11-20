- Stop reporting a live HLS camera as degraded when a viewer is refused because
  every viewer or session slot is taken: the refusal answers 503 with
  `Retry-After`, and the frame shown in its place leaves the camera's health
  as it was (asturksever, gekh, #1267).
