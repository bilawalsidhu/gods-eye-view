#!/usr/bin/env python3
"""Self-test for the speaker-identity path in scripts/local_audio.py.

Runs without a microphone:

  1. numpy Kaldi fbank: shape, dtype, determinism, CMN, mel peak placement.
  2. Piper voices as stand-in speakers: each voice reads the same phrases, the
     clips go through the exact production path (WAV -> decode_wav -> fbank ->
     ONNX -> L2 norm) and same-voice vs different-voice cosine similarities
     are reported against the threshold.
  3. Optional real speakers: --wav-dir with files named <speaker>-*.wav.

  .venv-local\\Scripts\\python scripts\\speaker_selftest.py
      [--voices ryan-high,alba-medium,lessac-medium] [--voices-dir .local/voices]
      [--wav-dir DIR] [--threshold 0.62] [--skip-piper]

Exit status 1 when a check fails or the threshold does not separate speakers.
"""
import argparse
import base64
import io
import itertools
import os
import struct
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import local_audio as la  # noqa: E402

PHRASES = [
    "Fly to Paris and show me the live flights.",
    "Remember this place as home.",
    "Which airlines are over Texas right now?",
    "Tell me when a ship comes within twenty kilometres of here.",
    "Rewind ten minutes and play at four times speed.",
    "What does that sign say on the left?",
    "Turn on the thermal view and track the nearest aircraft.",
    "Take me back to the office, please.",
]
DEFAULT_VOICES = ["en_US-ryan-high", "en_GB-alba-medium", "en_US-lessac-medium"]

failures = []


def check(condition, message):
    print(("  ok   " if condition else "  FAIL ") + message)
    if not condition:
        failures.append(message)


def wav_bytes(pcm16, sample_rate):
    body = pcm16 if isinstance(pcm16, (bytes, bytearray)) else np.asarray(pcm16, dtype="<i2").tobytes()
    header = b"RIFF" + struct.pack("<I", 36 + len(body)) + b"WAVE"
    header += b"fmt " + struct.pack("<IHHIIHH", 16, 1, 1, sample_rate, sample_rate * 2, 2, 16)
    header += b"data" + struct.pack("<I", len(body))
    return header + body


def embed_wav(raw):
    reply = la.embed({"id": "selftest", "wav": base64.b64encode(raw).decode("ascii")})
    return np.asarray(reply["embedding"], dtype=np.float64), reply


def fbank_checks():
    print("fbank")
    sr = 16000
    t = np.arange(sr) / sr
    tone = (0.3 * np.sin(2 * np.pi * 1000 * t)).astype(np.float32)
    feats = la.kaldi_fbank(tone, sr)
    check(feats.shape == (1 + (sr - 400) // 160, 80), f"shape {feats.shape} for 1 s at 16 kHz (25 ms / 10 ms)")
    check(feats.dtype == np.float32, "float32 output")
    check(np.array_equal(feats, la.kaldi_fbank(tone, sr)), "deterministic")
    check(float(np.abs(feats.mean(axis=0)).max()) < 1e-6, "mean-normalized per bin")
    raw = la.kaldi_fbank(tone, sr, mean_normalize=False)
    mel = lambda f: 1127.0 * np.log1p(f / 700.0)  # noqa: E731
    expected = (mel(1000.0) - mel(20.0)) / ((mel(8000.0) - mel(20.0)) / 81) - 1
    peak = int(raw.mean(axis=0).argmax())
    check(abs(peak - expected) <= 1, f"1 kHz tone peaks in mel bin {peak} (expected ~{expected:.1f})")
    check(la.kaldi_fbank(np.zeros(100, dtype=np.float32), sr).shape == (0, 80), "clips shorter than one frame give 0 frames")
    quiet = la.kaldi_fbank(np.zeros(sr, dtype=np.float32), sr, mean_normalize=False)
    check(np.all(np.isfinite(quiet)), "silence stays finite (epsilon floor)")


def report(groups, threshold, label):
    """groups: {speaker: [embedding, ...]} -> prints separation and checks it."""
    same, diff = [], []
    names = sorted(groups)
    for name in names:
        for a, b in itertools.combinations(groups[name], 2):
            same.append(float(a @ b))
    for x, y in itertools.combinations(names, 2):
        for a in groups[x]:
            for b in groups[y]:
                diff.append(float(a @ b))
    if not same or not diff:
        print(f"  skip {label}: need at least two speakers with two clips each")
        return
    same, diff = np.array(same), np.array(diff)
    print(f"  {label}: {len(names)} speakers, {sum(len(v) for v in groups.values())} clips")
    print(f"    same-speaker     min {same.min():.3f}  mean {same.mean():.3f}  max {same.max():.3f}  (n={len(same)})")
    print(f"    different-speaker min {diff.min():.3f}  mean {diff.mean():.3f}  max {diff.max():.3f}  (n={len(diff)})")
    print(f"    midpoint between max-different and min-same: {(diff.max() + same.min()) / 2:.3f}")
    # Centroid matching is what the server does: hold one clip out per speaker.
    hits = total = 0
    for name in names:
        clips = groups[name]
        for i, probe in enumerate(clips):
            rest = clips[:i] + clips[i + 1:]
            if not rest:
                continue
            best = None
            for other in names:
                pool = rest if other == name else groups[other]
                c = np.mean(pool, axis=0)
                c /= np.linalg.norm(c)
                score = float(probe @ c)
                if best is None or score > best[1]:
                    best = (other, score)
            total += 1
            hits += best[0] == name and best[1] >= threshold
    print(f"    leave-one-out centroid identification at {threshold:.2f}: {hits}/{total}")
    below = int((same < threshold).sum())
    print(f"    same-speaker pairs below {threshold:.2f}: {below}/{len(same)} (single-sample false rejects; the server matches a centroid)")
    # Impostor safety and centroid matching are what the server relies on; a
    # single same-speaker pair under the threshold only means one more
    # enrollment sample is needed, so it is reported, not failed.
    check(diff.max() < threshold, f"{label}: every different-speaker pair < {threshold:.2f} (max {diff.max():.3f})")
    check(same.mean() >= threshold, f"{label}: same-speaker mean {same.mean():.3f} >= {threshold:.2f}")
    check(hits == total, f"{label}: leave-one-out centroid identification {hits}/{total}")


def piper_groups(voices_dir, voices):
    try:
        from piper import PiperVoice
    except Exception as error:
        print(f"  skip piper: {error}")
        return {}
    groups = {}
    for name in voices:
        path = os.path.join(voices_dir, f"{name}.onnx")
        if not os.path.exists(path):
            print(f"  skip voice {name}: {path} not found")
            continue
        voice = PiperVoice.load(path)
        clips = []
        for phrase in PHRASES:
            chunks = list(voice.synthesize(phrase))
            pcm = b"".join(chunk.audio_int16_bytes for chunk in chunks)
            rate = int(chunks[0].sample_rate)
            embedding, reply = embed_wav(wav_bytes(pcm, rate))
            clips.append(embedding)
        groups[name] = clips
        print(f"  voice {name}: {len(clips)} clips, last embed {reply['embedMs']} ms for {reply['durationMs']} ms of audio")
    return groups


def wav_groups(wav_dir):
    groups = {}
    for file in sorted(os.listdir(wav_dir)):
        if not file.lower().endswith(".wav"):
            continue
        speaker = file.split("-")[0]
        with open(os.path.join(wav_dir, file), "rb") as handle:
            embedding, _ = embed_wav(handle.read())
        groups.setdefault(speaker, []).append(embedding)
    return groups


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--voices-dir", default=os.path.join(os.getcwd(), ".local", "voices"))
    parser.add_argument("--voices", default=",".join(DEFAULT_VOICES))
    parser.add_argument("--wav-dir")
    parser.add_argument("--threshold", type=float, default=0.62)
    parser.add_argument("--skip-piper", action="store_true")
    args = parser.parse_args()

    fbank_checks()
    print("speaker model")
    la.load_speaker()
    check(la.speaker_info["loaded"], f"loaded {os.path.basename(la.speaker_info['model'] or '')}: {la.speaker_info['reason'] or 'ok'}")
    if la.speaker_info["loaded"]:
        e, frames = la.speaker_embedding(np.random.default_rng(0).standard_normal(16000 * 2).astype(np.float32) * 0.05)
        check(abs(float(np.linalg.norm(e)) - 1.0) < 1e-5 and e.shape == (512,), f"512-d unit embedding from {frames} frames")
        try:
            la.speaker_embedding(np.zeros(1000, dtype=np.float32))
            check(False, "short clip rejected")
        except ValueError:
            check(True, "clips under 0.5 s are rejected")
        if not args.skip_piper:
            print("piper voices as speakers")
            report(piper_groups(args.voices_dir, [v.strip() for v in args.voices.split(",") if v.strip()]), args.threshold, "piper")
        if args.wav_dir:
            print("real speakers")
            report(wav_groups(args.wav_dir), args.threshold, "wav-dir")
    if failures:
        print(f"\n{len(failures)} check(s) failed")
        return 1
    print("\nall checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
