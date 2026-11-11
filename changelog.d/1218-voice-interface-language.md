- Speak the interface language in cloud voice sessions, OpenAI Realtime and
  Gemini Live. With a shipped non-English locale, the token request sends
  `?lang=` and the session instructions end with a LANGUAGE line; OpenAI
  captions are transcribed in that language, tool follow-ups keep the line,
  and spoken progress lines are translated. English sessions are unchanged
  (daikaginza, #1218).
