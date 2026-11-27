- `OPENAI_BASE_URL` points API-key voice minting, typed chat and the HUD
  summary at an OpenAI-compatible gateway such as LiteLLM. When it is set, the
  browser's Realtime SDP offer is relayed through `/api/realtime/calls`,
  because a gateway-minted secret is valid only at that gateway; the relay
  caps the gateway's answer at 64 KiB, discards its error bodies unread and
  shares the OpenAI per-IP throttle. ChatGPT OAuth voice always stays on
  api.openai.com; unset, behavior is unchanged (marcobox, kvnloo, #1004).
- `OPENAI_HUD_SUMMARY_REASONING_EFFORT` sets the HUD summary's reasoning effort
  (default `minimal`); `off` omits the field, for a gateway model that does not
  take OpenAI's effort names or would spend its output budget reasoning
  (marcobox, #1004).
