"""Shared helpers for the retro video factory pipeline (stdlib + NumPy only)."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
import wave
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
ENGINE_DIR = ROOT / "engine"
MODELS_DIR = ROOT / "models"
SAMPLE_RATE = 48000
FPS = 60
LOW_W, LOW_H, SCALE = 270, 480, 4
OUT_W, OUT_H = LOW_W * SCALE, LOW_H * SCALE


# ------------------------------------------------------------------ logging
_T0 = time.time()


def log(msg: str, level: str = "info") -> None:
    tag = {"info": "  ", "step": "==", "warn": "!!", "ok": "OK"}.get(level, "  ")
    print(f"[{time.time() - _T0:6.1f}s] {tag} {msg}", flush=True)


# ------------------------------------------------------------------ processes
def which_ffmpeg() -> str:
    exe = os.environ.get("FFMPEG") or shutil.which("ffmpeg")
    if not exe:
        sys.exit("FFmpeg not found. Install it and make sure `ffmpeg -version` works in this terminal.")
    return exe


def run(cmd: list[str], cwd: Path | None = None, input_bytes: bytes | None = None, quiet: bool = True) -> subprocess.CompletedProcess:
    proc = subprocess.run(cmd, cwd=str(cwd) if cwd else None, input=input_bytes,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if proc.returncode != 0:
        err = proc.stderr.decode("utf-8", "replace")[-3000:]
        raise RuntimeError(f"Command failed ({proc.returncode}): {' '.join(map(str, cmd))}\n{err}")
    if not quiet:
        sys.stdout.write(proc.stdout.decode("utf-8", "replace"))
    return proc


# ------------------------------------------------------------------ audio I/O
def load_audio(path: Path, sr: int = SAMPLE_RATE, channels: int = 1) -> np.ndarray:
    """Decode any audio file with FFmpeg into float32 [-1, 1]. Shape (n,) mono or (n, ch)."""
    ff = which_ffmpeg()
    proc = run([ff, "-v", "error", "-i", str(path), "-f", "f32le", "-acodec", "pcm_f32le",
                "-ac", str(channels), "-ar", str(sr), "-"])
    data = np.frombuffer(proc.stdout, dtype=np.float32).copy()
    return data if channels == 1 else data.reshape(-1, channels)


def write_wav(path: Path, data: np.ndarray, sr: int = SAMPLE_RATE) -> None:
    """Write float audio (n,) or (n, ch) as 16-bit PCM WAV."""
    data = np.asarray(data, dtype=np.float32)
    if data.ndim == 1:
        data = data[:, None]
    pcm = (np.clip(data, -1.0, 1.0) * 32767.0).astype("<i2")
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(pcm.shape[1])
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())


def db_to_gain(db: float) -> float:
    return float(10 ** (db / 20.0))


# ------------------------------------------------------------------ files
def read_json(path: Path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def write_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=2, ensure_ascii=False)


def _read_js_json(path: Path) -> dict:
    """Parse files of the form `window.NAME = {strict JSON};`"""
    text = path.read_text(encoding="utf-8")
    body = text[text.index("=") + 1:].strip().rstrip(";").strip()
    data = json.loads(body) if body else {}
    data.pop("_doc", None)
    return data


def load_sfx_presets(channel_dir: Path | None = None) -> dict:
    """Engine presets (engine/sfx_presets.js) + this channel's overrides only (channels/<slug>/sfx_presets.js)."""
    presets = _read_js_json(ENGINE_DIR / "sfx_presets.js")
    if channel_dir is not None and (channel_dir / "sfx_presets.js").exists():
        presets.update(_read_js_json(channel_dir / "sfx_presets.js"))
    return presets


# ------------------------------------------------------------------ channels
CHANNELS_DIR = ROOT / "channels"


def find_channel(episode: Path) -> Path | None:
    """The channel an episode belongs to = nearest parent folder containing channel.json."""
    for parent in episode.resolve().parents:
        if (parent / "channel.json").exists():
            return parent
        if parent == ROOT:
            break
    return None


def load_channel(channel_dir: Path | None) -> dict:
    if channel_dir is None:
        return {}
    cfg = read_json(channel_dir / "channel.json")
    cfg.setdefault("slug", channel_dir.name)
    return cfg


def deep_merge(base: dict, *layers: dict) -> dict:
    out = json.loads(json.dumps(base))
    for layer in layers:
        for k, v in (layer or {}).items():
            if isinstance(v, dict) and isinstance(out.get(k), dict):
                out[k] = deep_merge(out[k], v)
            else:
                out[k] = v
    return out


def is_stale(outputs: list[Path], inputs: list[Path]) -> bool:
    """True if any output is missing or older than any input."""
    if not all(p.exists() for p in outputs):
        return True
    newest_in = max((p.stat().st_mtime for p in inputs if p.exists()), default=0)
    return min(p.stat().st_mtime for p in outputs) < newest_in
