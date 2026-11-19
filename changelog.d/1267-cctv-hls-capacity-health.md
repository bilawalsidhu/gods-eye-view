- Stop reporting a live HLS camera as degraded when a viewer is refused because
  every lease or session slot is taken; the refusal still answers 503 with
  `Retry-After` (Said Turksever, German Khokhlov, #1267).
