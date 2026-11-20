- Stop the Satellites layer row reading `DEGRADED` with "1 CelesTrak group
  unavailable" on every update: the core catalog asked CelesTrak for a `sar`
  group that does not exist, so that read always failed (asturksever, #1883).
