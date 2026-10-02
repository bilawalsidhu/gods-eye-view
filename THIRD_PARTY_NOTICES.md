# Third-party software notices

The project depends on third-party npm packages whose own licenses apply. This
file records the packages added for the browser-local SDR and on-device voice
features; the complete resolved dependency inventory remains in
`package-lock.json`.

## Web RTL-SDR

- Package: `@jtarrio/webrtlsdr` 3.0.6
- Author: Jacobo Tarrio Barreiro; portions copyright Google Inc.
- Source: <https://github.com/jtarrio/webrtlsdr>
- License: Apache License 2.0
- License text: <https://www.apache.org/licenses/LICENSE-2.0>

## Signals

- Package: `@jtarrio/signals` 0.10.1
- Author: Jacobo Tarrio Barreiro
- Source: <https://github.com/jtarrio/signals>
- License: Apache License 2.0
- License text: <https://www.apache.org/licenses/LICENSE-2.0>

## On-device voice

Loaded only when voice runs on this device.

| Package | Version | Source | License |
| --- | --- | --- | --- |
| `@litert-lm/core` (runtime and wasm served from the build) | 0.17.1 | <https://github.com/google-ai-edge/LiteRT-LM> | Apache-2.0 |
| `@huggingface/transformers` (speech recognition) | 4.3.0 | <https://github.com/huggingface/transformers.js> | Apache-2.0 |
| `onnxruntime-web` (with transformers.js 4.3.0) | 1.31.0-dev.20260914 | <https://github.com/microsoft/onnxruntime> | MIT |
| `kokoro-js` (natural voice) | 1.2.1 | <https://github.com/hexgrad/kokoro> | Apache-2.0 |
| `@huggingface/transformers` (used by kokoro-js) | 3.8.1 | <https://github.com/huggingface/transformers.js> | Apache-2.0 |
| `onnxruntime-web` (used by kokoro-js) | 1.22.0-dev.20250409 | <https://github.com/microsoft/onnxruntime> | MIT |

Natural voice also uses `phonemizer` 1.2.1 (<https://github.com/xenova/phonemizer.js>),
which embeds eSpeak NG (<https://github.com/espeak-ng/espeak-ng>, GPL-3.0-or-later).
It is not part of this repository or its build: when natural voice first
starts, the user's browser downloads the pinned file from
`cdn.jsdelivr.net/npm/phonemizer@1.2.1` and checks its SHA-256 before use.
`GEV_NATURAL_VOICE=off` turns natural voice off.
