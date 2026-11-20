#!/usr/bin/env python3
"""
Doggie speech worker: a long-running process owned by the Node CLI,
talking newline-delimited JSON over stdio (same pattern as the native
overlay's stdin control channel).

Commands (stdin, one JSON object per line):
  {"id": 1, "cmd": "transcribe", "audio_path": "/tmp/clip.wav", "language": null}
  {"id": 2, "cmd": "speak", "text": "...", "lang": "en" | "hi", "out_path": "/tmp/out.wav"}
  {"id": 3, "cmd": "ping"}

Replies (stdout, one JSON object per line):
  {"id": 1, "ok": true, "text": "...", "language": "en", "language_probability": 0.98}
  {"id": 2, "ok": true, "wav_path": "/tmp/out.wav", "duration_sec": 1.5}
  {"type": "ready"}            # printed once at startup
  {"ok": false, "error": "..."} # on failure, "id" included when known

Whisper models are loaded lazily (only on the first "transcribe" call) per
the project's "lazy-load speech models" requirement; Piper subprocess calls
are cheap enough not to need that treatment.
"""
import json
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).parent.resolve()
PIPER_BIN = HERE / "bin" / "piper" / "piper"
VOICES_DIR = HERE / "voices"
MODELS_DIR = HERE / ".models"

VOICE_MAP = {
    # Reverted to en_US-norman-medium after switching to en_US-ryan-high
    # (Piper's "high" quality tier) caused a real regression reported live —
    # whispery/broken-sounding audio during the longer confirm-flow replies.
    # norman-medium had many hours of working playback before that swap, so
    # reverting is the safe known-good default while ryan-high is
    # investigated further. Its files are still on disk at
    # voices/en_US-ryan-high if it's worth revisiting.
    "en": VOICES_DIR / "en_US-norman-medium" / "en_US-norman-medium.onnx",
    "hi": VOICES_DIR / "hi_IN-pratham-medium" / "hi_IN-pratham-medium.onnx",
}

_whisper_model = None
_whisper_size = os.environ.get("DOGGIE_WHISPER_MODEL", "base")


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def get_whisper_model():
    global _whisper_model
    if _whisper_model is None:
        log(f"loading faster-whisper model '{_whisper_size}' (first use)...")
        from faster_whisper import WhisperModel

        _whisper_model = WhisperModel(_whisper_size, device="cpu", compute_type="int8", download_root=str(MODELS_DIR))
        log("whisper model ready")
    return _whisper_model


def handle_transcribe(req):
    audio_path = req["audio_path"]
    if not os.path.exists(audio_path):
        return {"ok": False, "error": f"audio file not found: {audio_path}"}
    model = get_whisper_model()
    language = req.get("language") or None
    # vad_filter=True enables the Silero VAD bundled with faster-whisper, to
    # skip silence instead of transcribing dead air (spec section on VAD).
    segments, info = model.transcribe(audio_path, beam_size=5, language=language, vad_filter=True)
    text = " ".join(seg.text.strip() for seg in segments).strip()
    return {
        "ok": True,
        "text": text,
        "language": info.language,
        "language_probability": round(info.language_probability, 3),
    }


def handle_speak(req):
    text = req["text"]
    lang = req.get("lang", "en")
    voice = VOICE_MAP.get(lang)
    if voice is None or not voice.exists():
        return {"ok": False, "error": f"no installed voice for lang={lang!r} (expected {voice})"}
    out_path = req.get("out_path") or "/tmp/doggie-speech.wav"
    env = dict(os.environ, LD_LIBRARY_PATH=str(PIPER_BIN.parent))
    result = subprocess.run(
        [str(PIPER_BIN), "--model", str(voice), "--output_file", out_path],
        input=text.encode("utf-8"),
        capture_output=True,
        env=env,
    )
    if result.returncode != 0:
        return {"ok": False, "error": result.stderr.decode(errors="replace")[:500]}
    return {"ok": True, "wav_path": out_path}


def main():
    print(json.dumps({"type": "ready"}), flush=True)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as e:
            print(json.dumps({"ok": False, "error": f"bad json: {e}"}), flush=True)
            continue

        cmd = req.get("cmd")
        req_id = req.get("id")
        try:
            if cmd == "ping":
                reply = {"ok": True, "pong": True}
            elif cmd == "transcribe":
                reply = handle_transcribe(req)
            elif cmd == "speak":
                reply = handle_speak(req)
            else:
                reply = {"ok": False, "error": f"unknown cmd {cmd!r}"}
        except Exception as e:  # noqa: BLE001 - this process must never die on a bad request
            reply = {"ok": False, "error": f"{type(e).__name__}: {e}"}

        reply["id"] = req_id
        print(json.dumps(reply), flush=True)


if __name__ == "__main__":
    main()
