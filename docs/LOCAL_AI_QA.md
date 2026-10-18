# Browser local AI verification

Test environment: Windows, Chromium, NVIDIA RTX 3080 (10 GiB), locally served application at 127.0.0.1:4173. Models were already downloaded into that browser's cache. Measurements are observations on this machine, not performance guarantees.

## Performance checks

- Before the change, `prepare` loaded Bonsai 8B, Whisper small and Piper before any command. Preparation plus a generated “Приблизь камеру немного” tool call took 51.3 seconds.
- After lazy loading, max-profile voice preparation loaded only Whisper small and took 1.74 seconds. Dispatching the same zoom through the real application runner took 2.3 ms, without allocating a Bonsai worker. This excludes speech recognition, playback and camera animation.
- Three synthesized Russian commands were recognized by the real cached Whisper small and executed by the real map: zoom in, zoom out, whole Earth. Recognition took 7.1–7.6 seconds. Piper took 1.80 seconds on first use and 0.21–0.35 seconds afterwards. No LLM worker was created.
- Three successive real Bonsai 8B requests returned a Moscow navigation tool call, an exact-callsign tracking tool call and the answer “четыре”. Timings were 20.6 seconds (including lazy model load), 30.4 seconds and 23.5 seconds. No OOM occurred in this run.
- Total GPU memory sampled during these 8B checks was approximately 4.5–4.9 GiB. This includes the globe and other GPU consumers; it is neither an isolated model measurement nor a measured peak. With speech recognition only, a sample was 1.48 GiB.
- Cached Whisper q8 was also compared on WebGPU: it used additional GPU memory and was slower in this run (8.2–9.4 seconds), so the production recognition path remains WASM.

## Automated coverage

The local command/runtime/session tests cover Russian and English zoom, named close framing, specific aircraft and other entity families, nearest aircraft, selected contacts, layer enable order, compound requests, missing contacts, failed arrival, negative/ambiguous requests, invalid tool arguments, cancellation, repeated requests, stale responses, OOM worker cleanup/retry, idle model release and bounded Piper chunks. Shared application action tests cover the actual navigation, tracking, cockpit and layer behavior used by both providers.

The existing download/cache tests also cover resumable large-file downloads, truncated transfers, cancellation, invalid ranges, quota errors and compatibility with previously cached whole files.

For a repeatable browser gate, start the development server and run
`node scripts/qa-local-ai.mjs`. Its synthetic aircraft exercise the real map
runner for navigation, zoom, exact-callsign tracking from a disabled layer,
nearest airborne selection at the viewed ground point, selected-contact
tracking, missing contacts, military tracking, stop and compound commands.
The gate does not download models or capture a private microphone.

After integration with upstream `93ea088f`, the settings UI correctly showed
all three cached max/Russian models and switched between Local and the cloud
authentication controls. An actual Local session with a synthetic microphone
started cached Whisper small, executed zoom-in, zoom-out and stop-tracking
through the shared session, synthesized and played its replies, then stopped
cleanly. The three commands returned success without loading Bonsai.

## Limits

The original screenshot's OOM was not reproduced in the short browser run. Separate heaps, bounded context/speech, tensor disposal and worker termination address concrete memory hazards; tests also inject OOM to verify cleanup. This does not guarantee that every model fits every browser/GPU or that live data always contains a requested aircraft. Free-form model interpretation remains slower and less reliable than the direct command paths.
