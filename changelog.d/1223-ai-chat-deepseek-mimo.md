- Add GEV AI, an opt-in text chat that drives the app through the voice action
  tools using DeepSeek or Xiaomi MiMo (`DEEPSEEK_API_KEY`, `MIMO_API_KEY`;
  `MIMO_API_BASE` for Token Plan keys). The panel stays hidden without a key and
  offers a provider picker when both are set. `/api/ai/chat` refuses cross-site
  requests, is rate-limited by default (`GEV_RATELIMIT_AI_CHAT_PER_MIN`, 60 per
  minute) and never relays provider error bodies. With no `OPENAI_API_KEY`, the
  HUD summary uses the chat provider (`AI_CHAT_PROVIDER`) (NukeThemAII, #1223).
