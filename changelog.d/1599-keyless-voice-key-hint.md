- Without `OPENAI_API_KEY`, the mic now says the key is missing and to add it in
  Provider Settings, instead of showing the raw server error with a hint to
  check microphone permissions. `/api/realtime/token` returns
  `code: "API_KEY_MISSING"` with its 503 (asturksever, #1599).
