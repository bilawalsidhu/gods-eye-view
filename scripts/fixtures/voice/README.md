# Voice QA fixture

`full-globe-turn-on-radio.wav` is an owner-generated fake-microphone fixture for the credentialed AI-to-Radio acceptance test. Its embedded WAV metadata is the provenance record for the generator, model, voice, spoken text, usage terms, and audio settings; inspect it with `ffprobe -show_entries format_tags -of json scripts/fixtures/voice/full-globe-turn-on-radio.wav`.

- Provided and approved for repository QA use by the user on 2026-08-05.
- SHA-256: `b57af70db1922b72fec2c6c58348ccd3309e10aa1e8edec2890277dff26cc7bb`
- Run: `node scripts/qa-voice-wav.mjs http://localhost:4189`

## Local voice fixtures (AI_PROVIDER=ollama)

Synthetic, owner-generated with Windows speech synthesis (System.Speech,
default voice) on 2026-09-16; 16 kHz mono 16-bit PCM WAV. No third-party
usage terms apply. Regenerate `local-fly-to-paris.wav` with
`scripts/make-voice-fixture.ps1` and update the hash here.

| File | Spoken text | SHA-256 |
| --- | --- | --- |
| `local-fly-to-paris.wav` | "Fly to Paris." | `90f0c1ad631ff5656466bd5fb81172d859880c1311103fc85ab2336ce8a65c77` |
| `cmd-tokyo.wav` | "Fly to Tokyo" | `5cc35f800f854db38bf7694c42ae1268b3a556c471f3b27cc70f07e3c6abc005` |
| `cmd-flights.wav` | "Show me live flights near Austin" | `e065de677b25a19bf2ff312c13d81e4d9013cae7458b558484c0a1f87dcba0ec` |

- Run: `npm run qa:local-voice` against a dev server started with `scripts/dev-local.ps1`.
- STT benchmark: `.venv-local\Scripts\python scriptsench_stt.py`.
