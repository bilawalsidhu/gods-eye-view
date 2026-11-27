# Typed chat on your own model server

Typed chat (**CHAT** beside the mic) can run on a model you host yourself
instead of OpenAI: Ollama, LM Studio, vLLM, llama.cpp's server, or anything
else that answers OpenAI's Chat Completions API with tool calls. The globe
sends the same instructions and the same map actions it sends OpenAI.

Only typed chat moves. Voice needs a realtime speech-to-speech service (OpenAI
Realtime or Gemini Live) that these servers do not offer, and the HUD summary
line keeps using OpenAI, or its built-in summary when there is no OpenAI key.

## Settings

In `.env`, or the environment the server starts with:

```dotenv
OPENAI_CHAT_BASE_URL=http://ollama.lan:11434/v1
OPENAI_CHAT_MODEL=qwen3:14b
# Only if your server checks a key:
# OPENAI_CHAT_API_KEY=
```

Restart the server, choose **OpenAI** as the **AI Provider**, and open
**CHAT**. The provider is still called OpenAI in the menu: the setting changes
where its typed chat goes.

- `OPENAI_CHAT_BASE_URL` is the server's OpenAI-compatible base, ending where
  `/chat/completions` would follow (`/v1` for Ollama and LM Studio). It must
  be a plain `http://` or `https://` address, without a user name, password,
  query or fragment. Anything else is refused and chat answers unavailable.
- `OPENAI_API_KEY` is never sent to it. Without `OPENAI_CHAT_API_KEY` the
  request carries a placeholder key, which Ollama ignores.
- `GEV_PREFER_CODEX_OAUTH` does not turn this chat off: it bills nothing.
- Each request may take two minutes instead of one.
- Provider Settings (POWER UP) cannot set either value: only whoever runs the
  server decides where chat goes.

## Choosing a model

Every message carries the instructions and about 36 tool descriptions, around
10,000 tokens. The model has to call tools reliably and see the whole prompt:

- **Use a model with tool calling.** In Ollama that is a model whose page
  lists **tools**, such as `qwen3`, `gpt-oss` or `llama3.1`. Models without it
  (`gemma3`, for one) answer in words but never move the map. Small models
  (7–8B) pick wrong tools more often; 14B and up does noticeably better.
- **Raise the context length.** Ollama's default window is shorter than the
  prompt and cuts it without saying so, which shows up as a model that ignores
  tools. Start Ollama with `OLLAMA_CONTEXT_LENGTH=32768` (or at least 16384).
  The OpenAI-compatible API cannot change it per request.
- **Keep it on the GPU.** A model that spills into system memory can miss the
  two-minute limit. With 16 GB of video memory, `qwen3:14b` and `gpt-oss:20b`
  fit with a 32K window.
- **Thinking models are fine.** A reply that starts with a `<think>` block has
  it removed before it is shown.

## Ollama on another machine

Ollama listens only on its own machine by default. Where the globe runs
elsewhere (a container, a NAS), start Ollama with `OLLAMA_HOST=0.0.0.0` and
allow port 11434 from the globe's address. Ollama has no authentication of
its own, so do not expose that port beyond your network.

For an Ollama service on Linux:

```bash
sudo systemctl edit ollama
# add:
# [Service]
# Environment="OLLAMA_HOST=0.0.0.0"
# Environment="OLLAMA_CONTEXT_LENGTH=32768"
sudo systemctl restart ollama
```

Check from the globe's machine:

```bash
curl http://ollama.lan:11434/v1/models
```

## When it does not answer

- **"Chat unavailable" at once:** check `OPENAI_CHAT_BASE_URL` is a plain
  http(s) address and the server was restarted after setting it.
- **A pause, then a failure:** the model server is off, unreachable, or slower
  than two minutes. Run the `curl` check above from the globe's machine, and
  watch the model server's own log while you send a message.
- **Replies but never moves the map:** the model lacks tool calling, or the
  context window cut off the tool list.
