# Third-party software notices

The project depends on third-party npm packages whose own licenses apply. This
file records the packages added for the browser-local SDR feature and the
Street Level viewer and browser local AI; the complete resolved dependency inventory remains in
`package-lock.json`.

## Browser local AI

- `@huggingface/transformers` 4.3.0: Apache License 2.0.
  Source and license: <https://github.com/huggingface/transformers.js>.
- `onnxruntime-web` 1.31.0-dev.20260914-8d85527a0: MIT.
  Source and license: <https://github.com/microsoft/onnxruntime>.
- `@diffusionstudio/piper-wasm` 1.0.0: npm package metadata declares MIT.
  Its phonemizer build includes eSpeak NG, which retains GPL v3 terms.
  The npm package's MIT metadata does not relicense that component.
  Source, build instructions and generated assets:
  <https://github.com/diffusionstudio/piper-wasm>;
  phonemizer sources: <https://github.com/wide-video/piper-phonemize>;
  eSpeak NG sources and license: <https://github.com/rhasspy/espeak-ng>.
  The shipped license and source directions are in `public/licenses/`.

Model weights are downloaded by the user from their pinned Hugging Face
repositories, rather than redistributed in this repository. Bonsai, Whisper
and individual Piper voices keep their own model-card licenses and attribution;
the exact sources are recorded in `src/voice/localModels.json`.

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

## MapillaryJS

- Package: `mapillary-js` 4.1.2 (loaded on demand by the Street Level viewer,
  with its stylesheet `dist/mapillary.css`)
- Author: Copyright (c) Facebook, Inc. and its affiliates
- Source: <https://github.com/mapillary/mapillary-js>
- License: MIT
- License text: <https://github.com/mapillary/mapillary-js/blob/main/LICENSE>

## RxJS (MapillaryJS dependency)

- Package: `rxjs` 7.8.2
- Author: Google, Inc., Netflix, Inc., Microsoft Corp. and contributors
- Source: <https://github.com/ReactiveX/rxjs>
- License: Apache License 2.0
- License text: <https://www.apache.org/licenses/LICENSE-2.0>

## three.js (MapillaryJS dependency)

- Package: `three` 0.134.0
- Author: Copyright © 2010-2021 three.js authors
- Source: <https://github.com/mrdoob/three.js>
- License: MIT
- License text: <https://github.com/mrdoob/three.js/blob/dev/LICENSE>
