- Add a typed AI chat beside the voice mic in the command dock. Replies are
  silent and never use the microphone; messages run the same map actions as
  voice through OpenAI Chat Completions (`OPENAI_CHAT_MODEL`) or Gemini
  `generateContent` (`GEMINI_CHAT_MODEL`). Chat is throttled per IP by
  `GEV_RATELIMIT_OPENAI_CHAT_PER_MIN` or `GEV_RATELIMIT_GEMINI_CHAT_PER_MIN`,
  which default to that provider's voice throttle, and `GEV_PREFER_CODEX_OAUTH`
  turns OpenAI chat off. The chat and voice panels minimize to a bar or dock
  beside the right rail, and step aside for the Location and Visual Presets
  trays (Manjunath, @manjunath22466, with Darren Dignam, @darrendignam, #1507).
