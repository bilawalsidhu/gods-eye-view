# LocalAI reference profile

This directory contains configuration and compatibility source only. Model
weights and backend binaries are downloaded by LocalAI into its own data
directory and are not committed to this repository.

Upstream sources:

- MiniCPM5-2B MLX: <https://huggingface.co/openbmb/MiniCPM5-2B-MLX>
- Parakeet Realtime EOU 120M: <https://huggingface.co/mudler/parakeet-cpp-gguf>
- Silero VAD: <https://github.com/snakers4/silero-vad>
- Kokoro: <https://github.com/hexgrad/kokoro>
- LocalAI: <https://github.com/mudler/LocalAI>
- MLX-LM: <https://github.com/ml-explore/mlx-lm>

Each downloaded artifact remains subject to its upstream license. See
[`docs/local-voice.md`](../../docs/local-voice.md) for installation and the
scope of the two version-pinned compatibility fixes.
