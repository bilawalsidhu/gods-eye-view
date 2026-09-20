#!/usr/bin/env python3
"""Benchmark faster-whisper configurations on the committed voice fixtures.

    .venv-local\\Scripts\\python scripts\\bench_stt.py [--runs 5] [--configs small:cpu:int8,small:cuda:float16,...]

Reports load time, first-call (JIT/warm-up) time, median latency over --runs,
and whether the transcript matches the expected phrase. Models download to the
Hugging Face cache on first use (large-v3-turbo ~1.6 GB).
"""
import argparse
import os
import statistics
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import local_audio  # noqa: E402  (reuses the CUDA DLL shim and WAV decoder)

FIXTURES = [
    ("scripts/fixtures/voice/local-fly-to-paris.wav", "fly to paris"),
    ("scripts/fixtures/voice/cmd-tokyo.wav", "fly to tokyo"),
    ("scripts/fixtures/voice/cmd-flights.wav", "show me live flights near austin"),
]
DEFAULT_CONFIGS = "small:cpu:int8,small:cuda:float16,large-v3-turbo:cuda:float16,distil-large-v3.5:cuda:float16"


def normalize(text):
    return "".join(ch for ch in text.lower() if ch.isalnum() or ch == " ").strip()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--runs", type=int, default=5)
    parser.add_argument("--configs", default=DEFAULT_CONFIGS)
    args = parser.parse_args()
    from faster_whisper import WhisperModel

    local_audio.expose_cuda_dlls()
    clips = []
    for path, expected in FIXTURES:
        if not os.path.exists(path):
            print(f"skip missing fixture {path}")
            continue
        samples, _, duration = local_audio.decode_wav(open(path, "rb").read())
        clips.append((os.path.basename(path), samples, expected, duration))
    if not clips:
        sys.exit("no fixtures found; run scripts/make-voice-fixture.ps1")

    rows = []
    for spec in args.configs.split(","):
        name, device, compute = spec.split(":")
        print(f"\n=== {name} on {device}/{compute} ===")
        started = time.perf_counter()
        try:
            model = WhisperModel(name, device=device, compute_type=compute)
            list(model.transcribe(clips[0][1], beam_size=1, vad_filter=False)[0])
        except Exception as error:
            print(f"  unavailable: {str(error).splitlines()[0][:160]}")
            rows.append((spec, None, None, None, "unavailable"))
            continue
        first_ms = int((time.perf_counter() - started) * 1000)
        latencies = []
        exact = 0
        for clip_name, samples, expected, duration in clips:
            text = ""
            per_clip = []
            for _ in range(args.runs):
                t0 = time.perf_counter()
                segments, _ = model.transcribe(
                    samples, language="en", beam_size=5, vad_filter=True,
                    condition_on_previous_text=False, initial_prompt=local_audio.WHISPER_PROMPT,
                )
                text = " ".join(s.text.strip() for s in segments).strip()
                per_clip.append((time.perf_counter() - t0) * 1000)
            latencies.extend(per_clip)
            match = normalize(text) == normalize(expected)
            exact += match
            print(f"  {clip_name:32s} {duration:5d} ms audio  median {statistics.median(per_clip):7.0f} ms  {'OK ' if match else 'MISS'}  \"{text}\"")
        med = statistics.median(latencies)
        rows.append((spec, first_ms, med, f"{exact}/{len(clips)}", "ok"))
        print(f"  load+first call {first_ms} ms, median {med:.0f} ms, exact {exact}/{len(clips)}")
        del model

    print("\nconfig                                  load+first   median   exact")
    for spec, first, med, exact, status in rows:
        if status != "ok":
            print(f"{spec:40s} {status}")
        else:
            print(f"{spec:40s} {first:8d} ms {med:7.0f} ms   {exact}")
    print("\nRule: largest GPU config with median <= 600 ms and all clips exact; prefer large-v3-turbo.")


if __name__ == "__main__":
    main()
