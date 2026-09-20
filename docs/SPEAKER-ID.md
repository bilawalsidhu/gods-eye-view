# Speaker identity (local voice)

The local voice assistant (`AI_PROVIDER=ollama`) can learn whose voice it is
hearing. Everything runs on this machine: a small speaker-embedding model turns
each utterance into a 512-number "voice print", named prints are kept in a JSON
file, and every transcript is tagged with the enrolled name it matches.

```
utterance WAV ──▶ faster-whisper ──▶ transcript text
      │
      └──▶ numpy fbank (80 mel) ──▶ WeSpeaker CAM++ (onnxruntime CPU) ──▶ 512-d print
                                                                            │
                        .gev-cache/voice-profiles.json  ◀── enroll ─────────┤
                        (name -> prints)                ── cosine to ───────┘
                                                            centroid ≥ 0.62 ─▶ {name, score}
```

## Setup

```
node scripts/fetch-speaker-model.mjs
```

downloads `wespeaker_en_voxceleb_CAM++.onnx` (29 MB) into `.local/models/`
(gitignored) and verifies its SHA-256. The audio worker picks it up on its next
start and reports `speaker: true` in its ready line; without the file the
worker logs `speaker model not found` and everything else keeps working
(transcripts simply carry `speaker: null`). `SPEAKER_MODEL=<path>` points at a
different file; `SPEAKER_THREADS` (default 2) caps the onnxruntime threads.

Model and licence: WeSpeaker CAM++ trained on VoxCeleb, exported to ONNX by
sherpa-onnx. Both projects are Apache-2.0; the weights are redistributed under
that licence. VoxCeleb is CC BY 4.0 research data. The model is
English-trained but language-agnostic in practice (the self-test separates
Mandarin speakers cleanly).

## Talking to it

| Say | Tool | What happens |
| --- | --- | --- |
| "This is Anthony" / "Remember my voice as Anthony" | `enroll_voice {name}` | The last three things this session heard (including that sentence) become prints under the name. Say it again later to add more samples; up to 24 are kept per name. |
| "Who am I?" / "Who is speaking?" | `who_is_speaking` | Scores the last utterance against every profile; answers with the name and score or says the voice is unknown. |
| "Whose voices do you know?" | `list_voices` | Names only. |
| "Forget Anthony's voice" | `forget_voice {name}` | Deletes the profile. |

Once at least one profile exists, every spoken turn is tagged automatically:
the `transcript` frame gains `speaker: { name, score } | null`, the mic panel
caption reads `HEARD (Anthony): ...`, and the remote companion mirrors the same
frame. A stranger's voice (best score below the threshold) is `null`. Until a
profile exists no embedding is computed at all, so the feature costs nothing
when unused; with profiles it adds roughly 30-60 ms of CPU per utterance
before the transcript is sent.

Enrollment quality: three clear sentences of 2-5 s in a quiet room are enough.
Enroll again from the spot you usually speak from if the first attempt was far
from the mic. Two people who both enroll are told apart reliably; identical
twins and deliberate impersonation are not a goal.

## Storage and privacy

- `.gev-cache/voice-profiles.json` (gitignored):
  `{ version: 1, profiles: [{ name, embeddings: [[512 floats], ...], createdAt, updatedAt, model }] }`.
  Only embeddings are stored. The utterance audio lives in memory for the
  current session (last three WAVs, for enrollment) and is never written to
  disk or sent anywhere.
- Delete a person with "forget <name>'s voice" or by removing their entry from
  the file; delete the file to reset everything.
- Embeddings are not reversible to speech, but they are biometric data: treat
  the file like a password store if the machine is shared.

## HTTP route

`POST /api/voice/speaker` with a JSON body (used by the tool pack, handy for
scripts):

| Body | Reply |
| --- | --- |
| `{ "op": "enroll", "name": "Anthony" }` | `{ ok, name, added, samples, enrolled }` from the most recent session's last utterances; add `"wav": <base64 16 kHz WAV>` to enroll a file instead. 409 when nothing was heard yet. |
| `{ "op": "identify" }` (optional `wav`) | `{ ok, speaker: {name, score} \| null, candidates: [{name, score}], enrolled, threshold }` |
| `{ "op": "list" }` or `GET` | `{ ok, count, profiles: [{name, samples, createdAt, updatedAt, model}], threshold, available }` |
| `{ "op": "forget", "name": "Anthony" }` | `{ ok, name, forgotten }` |

503 means the worker has no speaker model loaded.

## Tuning and checking

- Threshold: `SPEAKER_THRESHOLD` in `server/providers/ollama/speaker.js`
  (0.62). Measured with the self-test: three Piper voices reading eight
  phrases each score 0.56-0.88 (mean 0.78) against themselves and at most
  0.25 against each other; three real speakers (sherpa-onnx's test clips)
  score 0.59-0.86 (mean 0.77) same-speaker and at most 0.57 cross-speaker.
  Leave-one-out identification against a centroid is 100% in both sets at
  0.62. Lowering the threshold trades false rejects for false accepts; the
  worst real impostor pair sits at 0.57, so stay above 0.60.
- Self-test without a microphone (uses Piper voices as stand-in speakers, plus
  any directory of `<speaker>-*.wav` files):
  `.venv-local\Scripts\python scripts\speaker_selftest.py --wav-dir <dir>`.
  It checks the numpy fbank (shape, determinism, mel placement), the model
  load, and that the threshold separates every same/different pair.
- Unit tests: `src/tooling/ollamaSpeaker.test.mjs` (matching, persistence,
  route), `src/voice/tools/speaker.test.mjs` (tool pack), and the worker
  `embed` op in `src/tooling/ollamaWorker.test.mjs`.

## Worker protocol

`scripts/local_audio.py` gained one op; the others are unchanged:

```
{"op": "embed", "id": ..., "wav": <base64 WAV>}
  -> {"type": "embedding", "id", "embedding": [512 floats, unit length],
      "dim": 512, "frames", "durationMs", "embedMs", "model"}
  -> {"type": "error", "id", "error"}   (no model, or clip under 0.5 s)
```

Features are computed in numpy to match WeSpeaker training: int16-scale
waveform, DC removal, 0.97 pre-emphasis, 25 ms Hamming window every 10 ms,
512-point power spectrum, 80 mel bins 20 Hz-8 kHz, log with float32-epsilon
floor, no dither, then per-utterance mean subtraction. Clips longer than 20 s
are truncated.
