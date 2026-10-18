# Local AI in the browser

Open **POWER UP → AI ASSISTANT → Local**, choose **low / balance / max** and a voice language. Click **DOWNLOAD** on the AI model, speech recognition and voice cards. Wait for **DOWNLOADED**, then **SAVE SETTINGS**. Activate the microphone or hold Space to speak.

No API key, Python installation, llama-server or separate speech service is required.

| Profile | AI model            | Download | Speech recognition | Download |
| ------- | ------------------- | -------- | ------------------ | -------- |
| low     | Ternary Bonsai 1.7B | 480 MB   | Whisper tiny       | 46 MB    |
| balance | Ternary Bonsai 4B   | 1.10 GB  | Whisper base       | 82 MB    |
| max     | Ternary Bonsai 8B   | 2.22 GB  | Whisper small      | 254 MB   |

Piper Irina (Russian) or Lessac (English) adds about 64 MB. The app also serves the WASM runtime and phonemizer assets locally. Download sizes are not GPU memory requirements: model initialization, context and the globe need additional memory. Start with **low** on smaller GPUs.

Use a current Chrome or Edge browser with hardware acceleration and WebGPU with shader-f16. The app must run on localhost or HTTPS. Separate workers own Bonsai (WebGPU), Whisper (WASM) and Piper (WASM), so they do not share one WebAssembly heap. Microphone audio and generated speech remain in the browser. Local mode has no cloud fallback and no image input.

Voice startup loads only Whisper. Zoom, named destinations, layer toggles and aircraft tracking use the application's map actions directly; Bonsai loads only when a request needs language-model interpretation. Piper loads on the first spoken reply and synthesizes short chunks. Bonsai is released after two idle minutes; turning voice off releases all three workers. A failed worker is terminated, including after OOM. The downloaded files remain in the browser cache.

Try **«Приблизь немного»**, **«Приблизь Красную площадь»**, **«Следи за самолётом BAW42»**, **«Покажи ближайший самолёт над London»**, **«Следи за этим самолётом»**, or **«Останови слежение»**. English equivalents work too. Tracking enables the relevant layer and uses its available live records; an absent callsign is reported as missing. Compound commands execute in order and stop on failure. The assistant can discover all application action groups for other requests.

A new text command or holding Space interrupts the current calculation/playback. Context limits are 2,048 / 3,072 / 4,096 tokens for low / balance / max, including the response budget. Old complete turns are pruned to fit. Generated camera coordinates/distances cannot override named-place framing. The app confirms completed navigation and tracking from action results, without asking the model to invent a confirmation.

The max profile still needs more inference time than low: cached weights do not make an 8B model instantaneous. On the tested RTX 3080, short Whisper-small recognition took about 7 seconds and model-interpreted 8B requests took 20–30 seconds; ordinary text map commands bypass that model latency. See [verification notes](LOCAL_AI_QA.md).

Downloads are saved in **Cache Storage** for this site's origin. Large files are downloaded in 16 MiB parts, with automatic retries for temporary network failures. Closing settings does not stop a download. **CANCEL** stops the current request; completed parts remain saved. After cancellation, an error or a page reload, click **DOWNLOAD / RETRY DOWNLOAD** to fetch only the missing parts. Previously downloaded whole files remain usable. **REMOVE FROM CACHE** deletes the selected model's files and partial downloads. The app checks actual cached data before displaying readiness. It requests persistent storage, but browsers can decline; clearing site data also removes models. localhost and 127.0.0.1, different ports and browser profiles have separate caches.

The application and map still need their normal local web server and map/data sources. With the application served locally, cached AI models do not require internet for inference. Missing models must be explicitly downloaded using the settings buttons.

## Optional web search

Leave **Search MCP URL** empty to use local AI without search. To enable search, enter a local Streamable HTTP MCP endpoint such as http://127.0.0.1:8000/mcp. Search sends only the search query through this bridge. The default tool name is google_search; advanced integrations can set LOCAL_AI_MCP_TOOL in the app environment. A search MCP server is optional and is not an inference runtime.

## Model sources

- [Ternary Bonsai ONNX models](https://huggingface.co/onnx-community/Ternary-Bonsai-1.7B-ONNX): true ternary weights packed as two-bit ONNX q2f16, using Transformers.js 4.3.
- [Whisper](https://huggingface.co/Xenova/whisper-tiny): multilingual quantized ONNX models.
- [Piper voices](https://huggingface.co/rhasspy/piper-voices), with the [Piper WASM phonemizer](https://github.com/diffusionstudio/piper-wasm).

Exact model revisions, file URLs and byte sizes are pinned in src/voice/localModels.json. Updating a revision creates new cache entries; it does not silently replace a downloaded model.
