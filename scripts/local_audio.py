#!/usr/bin/env python3
"""Persistent local audio worker for the Ollama voice path (AI_PROVIDER=ollama).

Protocol: newline-delimited JSON on stdin/stdout. Every request carries an
``id`` that every response echoes.

  {"op": "transcribe", "id", "wav": <base64 16 kHz mono 16-bit WAV>, "language"?}
      -> {"type": "transcript", "id", "text", "noSpeech", "durationMs", "language"}
  {"op": "tts", "id", "text"}
      -> 0..n {"type": "audio_chunk", "id", "seq", "sampleRate", "pcm16": <base64>}
         then {"type": "tts_done", "id", "chunks"}
  {"op": "ping", "id"}  -> {"type": "pong", "id"}
  {"op": "cancel"}      -> {"type": "cancelled"}  (best effort, queue is serial)
  {"op": "embed", "id", "wav": <base64 WAV>}
      -> {"type": "embedding", "id", "embedding": [512 floats, L2-normalized],
          "dim", "frames", "durationMs", "embedMs", "model"}
         (speaker-identity voice print; {"type": "error"} when the speaker
          model is absent or the clip is shorter than 0.5 s)

On start the worker loads faster-whisper once (GPU when available), loads the
Piper voice once, loads the optional speaker-embedding ONNX model
(.local/models, see scripts/fetch-speaker-model.mjs), warms up and prints one
``{"type": "ready", ...}`` line with its health. It never exits on a request error; failures come back as
``{"type": "error", "id", "error"}``. The Node side (server/providers/ollama/
worker.js) keeps one worker alive across voice sessions.
"""
import base64
import glob
import io
import json
import os
import subprocess
import sys
import time
import traceback

import numpy as np

STDOUT = sys.stdout


def emit(value):
    STDOUT.write(json.dumps(value, ensure_ascii=False) + "\n")
    STDOUT.flush()


def log(message):
    sys.stderr.write(f"[local_audio] {message}\n")
    sys.stderr.flush()


# ---------------------------------------------------------------- CUDA DLLs
def expose_cuda_dlls():
    """Make pip-installed CUDA runtime DLLs (nvidia-*-cu12 wheels) loadable.

    CTranslate2 resolves cublas64_12.dll / cudnn64_9.dll through the plain
    PATH, so both PATH and add_dll_directory are needed on Windows.
    """
    roots = []
    for site in sys.path:
        if not site or not os.path.isdir(site):
            continue
        roots.extend(glob.glob(os.path.join(site, "nvidia", "*", "bin")))
        roots.extend(glob.glob(os.path.join(site, "nvidia", "*", "lib")))
    if not roots:
        return 0
    os.environ["PATH"] = os.pathsep.join(roots + [os.environ.get("PATH", "")])
    if hasattr(os, "add_dll_directory"):
        for root in roots:
            try:
                os.add_dll_directory(root)
            except OSError:
                pass
    return len(roots)


def free_vram_mb():
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.free", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=5,
        )
        if out.returncode == 0 and out.stdout.strip():
            return int(float(out.stdout.strip().splitlines()[0]))
    except Exception:
        pass
    return None


# ------------------------------------------------------------------ Whisper
WHISPER_MODEL = os.getenv("WHISPER_MODEL", "small")
WHISPER_LANGUAGE = os.getenv("WHISPER_LANGUAGE", "auto")
WHISPER_DEVICE = os.getenv("WHISPER_DEVICE", "auto").lower()
WHISPER_COMPUTE = os.getenv("WHISPER_COMPUTE_TYPE", "")
WHISPER_MIN_FREE_VRAM_MB = int(os.getenv("WHISPER_MIN_FREE_VRAM_MB", "3000"))
WHISPER_PROMPT = os.getenv(
    "WHISPER_INITIAL_PROMPT",
    "Globe navigation command: fly to Paris, London, Tokyo, Austin, New York, "
    "San Francisco, Dubai, or Washington DC. Show flights, ships, satellites, "
    "earthquakes, cameras, thermal view, track it, stop tracking.",
)

whisper = None
whisper_info = {"loaded": False, "device": None, "computeType": None, "model": WHISPER_MODEL, "reason": None}


def load_whisper():
    global whisper
    try:
        import ctranslate2
        from faster_whisper import WhisperModel
    except Exception as error:  # pragma: no cover - environment specific
        whisper_info["reason"] = f"faster-whisper import failed: {error}"
        log(whisper_info["reason"])
        return
    want_cuda = WHISPER_DEVICE in ("auto", "cuda")
    if want_cuda:
        dll_dirs = expose_cuda_dlls()
        try:
            cuda_count = ctranslate2.get_cuda_device_count()
        except Exception:
            cuda_count = 0
        free_mb = free_vram_mb()
        if cuda_count < 1:
            reason = "no CUDA device visible to ctranslate2"
        elif WHISPER_DEVICE == "auto" and free_mb is not None and free_mb < WHISPER_MIN_FREE_VRAM_MB:
            reason = f"only {free_mb} MiB VRAM free (< {WHISPER_MIN_FREE_VRAM_MB})"
        else:
            reason = None
        if reason is None:
            compute = WHISPER_COMPUTE or "float16"
            try:
                candidate = WhisperModel(WHISPER_MODEL, device="cuda", compute_type=compute)
                # CTranslate2 binds CUDA libraries lazily; prove the GPU path
                # works before committing to it (missing cublas surfaces here).
                probe_started = time.perf_counter()
                list(candidate.transcribe(np.zeros(8000, dtype=np.float32), beam_size=1, vad_filter=False)[0])
                whisper = candidate
                whisper_info.update(loaded=True, device="cuda", computeType=compute, reason=None)
                log(f"whisper {WHISPER_MODEL} on cuda/{compute} (dll dirs: {dll_dirs}, free VRAM: {free_mb} MiB, probe {int((time.perf_counter() - probe_started) * 1000)} ms)")
                return
            except Exception as error:
                reason = f"cuda unusable: {str(error).splitlines()[0][:200]}"
        if WHISPER_DEVICE == "cuda":
            whisper_info["reason"] = reason
            log(f"WHISPER_DEVICE=cuda requested but {reason}; no CPU fallback")
            return
        log(f"whisper falling back to cpu: {reason}")
        whisper_info["reason"] = reason
    compute = WHISPER_COMPUTE if (WHISPER_COMPUTE and WHISPER_DEVICE == "cpu") else "int8"
    try:
        whisper = WhisperModel(WHISPER_MODEL, device="cpu", compute_type=compute)
        whisper_info.update(loaded=True, device="cpu", computeType=compute)
        log(f"whisper {WHISPER_MODEL} on cpu/{compute}")
    except Exception as error:
        whisper_info["reason"] = f"cpu load failed: {error}"
        log(whisper_info["reason"])


def parse_wav(raw):
    """Minimal RIFF/WAVE reader: PCM 8/16/24/32-bit and IEEE float 32/64.

    The stdlib ``wave`` module rejects float WAVs (format 3), which is what
    browser encoders emit by default, so parse the chunks directly.
    """
    if len(raw) < 12 or raw[:4] != b"RIFF" or raw[8:12] != b"WAVE":
        raise ValueError("expected a RIFF/WAV utterance")
    pos = 12
    fmt = None
    data = None
    while pos + 8 <= len(raw):
        chunk_id = raw[pos:pos + 4]
        size = int.from_bytes(raw[pos + 4:pos + 8], "little")
        body = raw[pos + 8:pos + 8 + size]
        if chunk_id == b"fmt ":
            audio_format = int.from_bytes(body[0:2], "little")
            channels = int.from_bytes(body[2:4], "little")
            rate = int.from_bytes(body[4:8], "little")
            bits = int.from_bytes(body[14:16], "little")
            if audio_format == 0xFFFE and len(body) >= 26:  # WAVE_FORMAT_EXTENSIBLE
                audio_format = int.from_bytes(body[24:26], "little")
            fmt = (audio_format, channels, rate, bits)
        elif chunk_id == b"data":
            data = body
        pos += 8 + size + (size & 1)
    if fmt is None or data is None:
        raise ValueError("WAV is missing fmt or data chunk")
    audio_format, channels, rate, bits = fmt
    if audio_format == 1 and bits == 16:
        samples = np.frombuffer(data[: len(data) // 2 * 2], dtype="<i2").astype(np.float32) / 32768.0
    elif audio_format == 1 and bits == 32:
        samples = np.frombuffer(data[: len(data) // 4 * 4], dtype="<i4").astype(np.float32) / 2147483648.0
    elif audio_format == 1 and bits == 24:
        b = np.frombuffer(data[: len(data) // 3 * 3], dtype=np.uint8).reshape(-1, 3)
        ints = (b[:, 0].astype(np.int32) | (b[:, 1].astype(np.int32) << 8) | (b[:, 2].astype(np.int32) << 16))
        ints = np.where(ints & 0x800000, ints - 0x1000000, ints)
        samples = ints.astype(np.float32) / 8388608.0
    elif audio_format == 1 and bits == 8:
        samples = (np.frombuffer(data, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    elif audio_format == 3 and bits == 32:
        samples = np.frombuffer(data[: len(data) // 4 * 4], dtype="<f4").astype(np.float32)
    elif audio_format == 3 and bits == 64:
        samples = np.frombuffer(data[: len(data) // 8 * 8], dtype="<f8").astype(np.float32)
    else:
        raise ValueError(f"unsupported WAV encoding (format {audio_format}, {bits}-bit)")
    return samples, channels, rate


def decode_wav(raw):
    """Return (float32 mono 16 kHz samples, source sample rate, duration ms)."""
    samples, channels, rate = parse_wav(raw)
    if channels > 1:
        samples = samples[: len(samples) // channels * channels].reshape(-1, channels).mean(axis=1)
    duration_ms = int(len(samples) * 1000 / max(rate, 1))
    if rate != 16000 and len(samples):
        target = int(round(len(samples) * 16000 / rate))
        positions = np.linspace(0, len(samples) - 1, num=target, dtype=np.float64)
        samples = np.interp(positions, np.arange(len(samples)), samples).astype(np.float32)
    return np.ascontiguousarray(samples, dtype=np.float32), rate, duration_ms


def transcribe(request):
    if whisper is None:
        raise RuntimeError(whisper_info["reason"] or "speech recognition is not loaded")
    raw = base64.b64decode(request.get("wav") or "")
    samples, rate, duration_ms = decode_wav(raw)
    language = request.get("language") or WHISPER_LANGUAGE
    started = time.perf_counter()
    segments, info = whisper.transcribe(
        samples,
        language=None if language in ("", "auto") else language,
        beam_size=int(os.getenv("WHISPER_BEAM_SIZE", "5")),
        vad_filter=True,
        condition_on_previous_text=False,
        initial_prompt=request.get("prompt") or WHISPER_PROMPT,
    )
    text = " ".join(segment.text.strip() for segment in segments).strip()
    return {
        "type": "transcript",
        "id": request.get("id"),
        "text": text,
        "noSpeech": not text,
        "durationMs": duration_ms,
        "sourceRate": rate,
        "language": getattr(info, "language", language),
        "languageProbability": round(float(getattr(info, "language_probability", 0) or 0), 3),
        "sttMs": int((time.perf_counter() - started) * 1000),
    }


# -------------------------------------------------------------------- Piper
piper_voice = None
piper_info = {"loaded": False, "model": None, "reason": None}

# Language code -> Piper voice under .local/voices. TTS_VOICE_<LANG> overrides
# (e.g. TTS_VOICE_ES=es_MX-claude-high); the default English voice is TTS_VOICE.
DEFAULT_LANGUAGE_VOICES = {
    "es": "es_ES-davefx-medium",
    "fr": "fr_FR-siwis-medium",
    "de": "de_DE-thorsten-medium",
    "it": "it_IT-riccardo-x_low",
    "pt": "pt_BR-faber-medium",
}
language_voices = {}


def voice_path(name):
    return os.path.join(os.getcwd(), ".local", "voices", f"{name}.onnx")


def resolve_piper_model():
    explicit = os.getenv("PIPER_MODEL", "").strip()
    if explicit:
        return explicit
    name = os.getenv("TTS_VOICE", "en_US-lessac-medium").strip()
    if not name:
        return ""
    return voice_path(name)


def voice_for_language(language):
    """Return a loaded PiperVoice for a language code, or the default voice."""
    code = str(language or "").lower().split("-")[0]
    if not code or code == "en":
        return piper_voice
    if code in language_voices:
        return language_voices[code] or piper_voice
    name = os.getenv(f"TTS_VOICE_{code.upper()}", DEFAULT_LANGUAGE_VOICES.get(code, ""))
    path = voice_path(name) if name else ""
    if not path or not os.path.exists(path):
        language_voices[code] = None
        log(f"no Piper voice for language {code!r}; using the default voice")
        return piper_voice
    try:
        from piper import PiperVoice
        language_voices[code] = PiperVoice.load(path)
        log(f"piper voice for {code}: {name}")
    except Exception as error:
        language_voices[code] = None
        log(f"piper voice {name} failed to load: {error}")
    return language_voices[code] or piper_voice


def load_piper():
    global piper_voice
    model = resolve_piper_model()
    piper_info["model"] = model
    if not model or not os.path.exists(model):
        piper_info["reason"] = f"Piper model not found: {model or '(unset)'}"
        log(piper_info["reason"])
        return
    try:
        from piper import PiperVoice
        piper_voice = PiperVoice.load(model)
        piper_info.update(loaded=True, reason=None)
        log(f"piper voice {os.path.basename(model)}")
    except Exception as error:
        piper_info["reason"] = f"piper load failed: {error}"
        log(piper_info["reason"])


def synthesis_config():
    try:
        from piper.config import SynthesisConfig
    except Exception:
        return None
    scale = os.getenv("TTS_LENGTH_SCALE", "").strip()
    volume = os.getenv("TTS_VOLUME", "").strip()
    return SynthesisConfig(
        length_scale=float(scale) if scale else None,
        volume=float(volume) if volume else 1.0,
    )


def synthesize(request):
    if piper_voice is None:
        raise RuntimeError(piper_info["reason"] or "text-to-speech is not loaded")
    text = str(request.get("text") or "").strip()
    voice = voice_for_language(request.get("language"))
    seq = 0
    if text:
        for chunk in voice.synthesize(text, synthesis_config()):
            data = chunk.audio_int16_bytes
            if not data:
                continue
            emit({
                "type": "audio_chunk",
                "id": request.get("id"),
                "seq": seq,
                "sampleRate": int(chunk.sample_rate),
                "pcm16": base64.b64encode(data).decode("ascii"),
            })
            seq += 1
    return {"type": "tts_done", "id": request.get("id"), "chunks": seq}


# --------------------------------------------------------- speaker identity
# WeSpeaker CAM++ (VoxCeleb, Apache-2.0) exported for ONNX by sherpa-onnx:
# input "feats" [1, T, 80] Kaldi log-mel fbank, output "embs" [1, 512].
SPEAKER_MODEL_NAME = "wespeaker_en_voxceleb_CAM++"
SPEAKER_SAMPLE_RATE = 16000
SPEAKER_MIN_SECONDS = 0.5
SPEAKER_MAX_SECONDS = 20.0

speaker_session = None
speaker_input_name = "feats"
speaker_info = {"loaded": False, "model": None, "dim": None, "reason": None}


def resolve_speaker_model():
    explicit = os.getenv("SPEAKER_MODEL", "").strip()
    if explicit:
        return explicit
    return os.path.join(os.getcwd(), ".local", "models", f"{SPEAKER_MODEL_NAME}.onnx")


def mel_scale(freq):
    return 1127.0 * np.log1p(np.asarray(freq, dtype=np.float64) / 700.0)


def kaldi_mel_banks(num_bins=80, sample_rate=16000, padded_window=512, low_freq=20.0, high_freq=0.0):
    """Kaldi MelBanks: triangular filters over FFT bins 0..padded_window/2-1."""
    num_fft_bins = padded_window // 2
    nyquist = sample_rate / 2.0
    high = high_freq if high_freq > 0 else nyquist + high_freq
    mel_low, mel_high = float(mel_scale(low_freq)), float(mel_scale(high))
    delta = (mel_high - mel_low) / (num_bins + 1)
    fft_bin_mel = mel_scale(np.arange(num_fft_bins) * (sample_rate / padded_window))
    banks = np.zeros((num_bins, num_fft_bins + 1), dtype=np.float64)
    for b in range(num_bins):
        left = mel_low + b * delta
        center = left + delta
        right = center + delta
        up = (fft_bin_mel - left) / (center - left)
        down = (right - fft_bin_mel) / (right - center)
        weight = np.where(fft_bin_mel <= center, up, down)
        banks[b, :num_fft_bins] = np.where((fft_bin_mel > left) & (fft_bin_mel < right), weight, 0.0)
    return banks.astype(np.float32)


_mel_banks = None


def kaldi_fbank(samples, sample_rate=16000, num_bins=80, frame_ms=25.0, shift_ms=10.0, preemphasis=0.97, mean_normalize=True):
    """80-dim Kaldi-style log-mel fbank in numpy, matching what WeSpeaker was
    trained on: int16-scale waveform, DC removal, 0.97 pre-emphasis, Hamming
    window, 512-point power spectrum, 80 mel bins from 20 Hz to Nyquist, log
    with float32-epsilon floor, no dither, snip_edges, then per-utterance mean
    subtraction (CMN). Returns float32 [frames, num_bins]."""
    global _mel_banks
    frame_len = int(round(sample_rate * frame_ms / 1000.0))
    shift = int(round(sample_rate * shift_ms / 1000.0))
    padded = 1
    while padded < frame_len:
        padded *= 2
    x = np.asarray(samples, dtype=np.float32).astype(np.float64) * 32768.0
    if len(x) < frame_len:
        return np.zeros((0, num_bins), dtype=np.float32)
    num_frames = 1 + (len(x) - frame_len) // shift
    index = np.arange(frame_len)[None, :] + shift * np.arange(num_frames)[:, None]
    frames = x[index]
    frames = frames - frames.mean(axis=1, keepdims=True)
    emphasized = frames.copy()
    emphasized[:, 1:] -= preemphasis * frames[:, :-1]
    emphasized[:, 0] -= preemphasis * frames[:, 0]
    window = 0.54 - 0.46 * np.cos(2.0 * np.pi * np.arange(frame_len) / (frame_len - 1))
    emphasized *= window
    spectrum = np.fft.rfft(emphasized, n=padded)
    power = spectrum.real ** 2 + spectrum.imag ** 2
    if _mel_banks is None or _mel_banks.shape != (num_bins, padded // 2 + 1):
        _mel_banks = kaldi_mel_banks(num_bins, sample_rate, padded)
    mel = power @ _mel_banks.astype(np.float64).T
    features = np.log(np.maximum(mel, float(np.finfo(np.float32).eps)))
    if mean_normalize:
        features = features - features.mean(axis=0, keepdims=True)
    return np.ascontiguousarray(features, dtype=np.float32)


def load_speaker():
    global speaker_session, speaker_input_name
    model = resolve_speaker_model()
    speaker_info["model"] = model
    if not os.path.exists(model):
        speaker_info["reason"] = f"speaker model not found: {model} (run: node scripts/fetch-speaker-model.mjs)"
        log(speaker_info["reason"])
        return
    try:
        import onnxruntime as ort
        options = ort.SessionOptions()
        options.log_severity_level = 3
        options.intra_op_num_threads = int(os.getenv("SPEAKER_THREADS", "2"))
        session = ort.InferenceSession(model, options, providers=["CPUExecutionProvider"])
        inputs = session.get_inputs()
        if len(inputs) != 1 or len(inputs[0].shape) != 3 or inputs[0].shape[-1] != 80:
            raise RuntimeError(f"unexpected speaker model input {[(i.name, i.shape) for i in inputs]}; need [B, T, 80]")
        speaker_input_name = inputs[0].name
        speaker_session = session
        speaker_info.update(loaded=True, reason=None, dim=session.get_outputs()[0].shape[-1])
        log(f"speaker model {os.path.basename(model)} ({speaker_input_name} -> {speaker_info['dim']}-d)")
    except Exception as error:
        speaker_info["reason"] = f"speaker model load failed: {error}"
        log(speaker_info["reason"])


def speaker_embedding(samples):
    """L2-normalized voice print for float32 16 kHz mono samples."""
    if speaker_session is None:
        raise RuntimeError(speaker_info["reason"] or "speaker model is not loaded")
    samples = np.asarray(samples, dtype=np.float32)[: int(SPEAKER_MAX_SECONDS * SPEAKER_SAMPLE_RATE)]
    if len(samples) < SPEAKER_MIN_SECONDS * SPEAKER_SAMPLE_RATE:
        raise ValueError(f"utterance shorter than {SPEAKER_MIN_SECONDS:g} s; too short for a voice print")
    features = kaldi_fbank(samples, SPEAKER_SAMPLE_RATE)
    outputs = speaker_session.run(None, {speaker_input_name: features[None, :, :]})
    embedding = np.asarray(outputs[0], dtype=np.float64).reshape(-1)
    norm = float(np.linalg.norm(embedding))
    if not np.isfinite(norm) or norm == 0.0:
        raise RuntimeError("speaker model returned a degenerate embedding")
    return (embedding / norm).astype(np.float32), features.shape[0]


def embed(request):
    raw = base64.b64decode(request.get("wav") or "")
    samples, _rate, duration_ms = decode_wav(raw)
    started = time.perf_counter()
    embedding, frames = speaker_embedding(samples)
    return {
        "type": "embedding",
        "id": request.get("id"),
        "embedding": [round(float(v), 6) for v in embedding],
        "dim": int(embedding.shape[0]),
        "frames": int(frames),
        "durationMs": duration_ms,
        "embedMs": int((time.perf_counter() - started) * 1000),
        "model": os.path.splitext(os.path.basename(speaker_info["model"] or ""))[0] or None,
    }


# ------------------------------------------------------------------- main
def warm_up():
    started = time.perf_counter()
    if whisper is not None:
        try:
            list(whisper.transcribe(np.zeros(8000, dtype=np.float32), beam_size=1, vad_filter=False)[0])
        except Exception as error:
            log(f"whisper warm-up failed: {error}")
    if piper_voice is not None:
        try:
            for _ in piper_voice.synthesize("Ready."):
                pass
        except Exception as error:
            log(f"piper warm-up failed: {error}")
    if speaker_session is not None:
        try:
            speaker_embedding(np.zeros(SPEAKER_SAMPLE_RATE, dtype=np.float32))
        except Exception as error:
            log(f"speaker warm-up failed: {error}")
    return int((time.perf_counter() - started) * 1000)


def main():
    load_whisper()
    load_piper()
    load_speaker()
    warmup_ms = warm_up()
    emit({
        "type": "ready",
        "engine": "whisper",
        "whisper": whisper_info["loaded"],
        "whisperModel": WHISPER_MODEL,
        "device": whisper_info["device"],
        "computeType": whisper_info["computeType"],
        "whisperReason": whisper_info["reason"],
        "language": WHISPER_LANGUAGE,
        "piper": piper_info["loaded"],
        "piperModel": os.path.basename(piper_info["model"] or "") or None,
        "piperReason": piper_info["reason"],
        "tts": "piper" if piper_info["loaded"] else os.getenv("LOCAL_TTS_FALLBACK", "none"),
        "speaker": speaker_info["loaded"],
        "speakerModel": os.path.basename(speaker_info["model"] or "") or None,
        "speakerReason": speaker_info["reason"],
        "warmupMs": warmup_ms,
        "python": sys.version.split()[0],
        "pid": os.getpid(),
    })
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request_id = None
        try:
            request = json.loads(line)
            request_id = request.get("id")
            op = request.get("op")
            if op == "transcribe":
                emit(transcribe(request))
            elif op == "tts":
                emit(synthesize(request))
            elif op == "embed":
                emit(embed(request))
            elif op == "ping":
                emit({"type": "pong", "id": request_id})
            elif op == "cancel":
                emit({"type": "cancelled", "id": request_id})
            else:
                emit({"type": "error", "id": request_id, "error": f"unknown op {op!r}"})
        except Exception as error:
            emit({
                "type": "error",
                "id": request_id,
                "error": str(error) or error.__class__.__name__,
                "trace": traceback.format_exc()[-1500:],
            })


if __name__ == "__main__":
    main()
