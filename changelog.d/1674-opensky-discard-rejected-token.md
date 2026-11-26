- Recover the flights layer after OpenSky rejects a cached OAuth token. A
  token answered with 401 is now discarded, so the next poll signs in again
  instead of replaying it for up to 29 minutes after a revoked token or a
  rotated client secret (Vishwanathan27, #1674).
