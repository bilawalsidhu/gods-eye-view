- Stop reporting a live HLS camera as degraded when a viewer is refused because
  every viewer or session slot is taken: the refusal answers 503 with
  `Retry-After`, the frame shown in its place leaves the camera's health
  as it was, and that viewer's panel labels the frame `FALLBACK · DEGRADED`
  rather than live (asturksever, gekh, #1267).
