- Let a Gemini API key drive the AI HUD summary when no OpenAI key is set. The
  summary uses one stateless Interactions API call (`gemini-3.5-flash-lite`,
  minimal thinking, `store: false`) and shares the route's throttle and fixed
  error text. `GEV_HUD_SUMMARY_PROVIDER=openai|gemini` pins one provider, and
  the POWER UP panel gains a GEMINI row (daikaginza, #1212).
