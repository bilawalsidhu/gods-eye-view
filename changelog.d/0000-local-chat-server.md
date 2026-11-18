- Typed chat can run on a model server of your own: `OPENAI_CHAT_BASE_URL`
  sends it to any Chat Completions server with tool calls (Ollama, LM Studio,
  vLLM, llama.cpp), with `OPENAI_CHAT_MODEL` naming its model. The OpenAI key
  is never sent there, requests wait two minutes, and a leading `<think>`
  block is dropped from replies. Voice and the HUD summary are unchanged
  (docs/LOCAL-CHAT.md) (CaliMiller, #0000).
