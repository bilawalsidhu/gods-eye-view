- OpenSky sign-in matches what OpenSky accepts since 2026-03-18. The server
  now reads `OPENSKY_CREDENTIALS_FILE` (the `credentials.json` OpenSky's
  account page downloads) on every platform, not only through the macOS
  launcher, and no longer sends retired username/password Basic auth:
  `OPENSKY_AUTH_MODE=basic` loads anonymously with one warning saying what to
  set instead (quanticsoul4772, #1229).
- Credential-file warnings omit parser excerpts and filesystem error details;
  the path example also works with the macOS launchers.
