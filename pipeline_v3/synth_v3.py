"""synth_v3.py — frame-locked chiptune & foley mix for the Visual-First (zero-TTS) pipeline.

Input : build/audio_log_v3.json from the browser (window.getAudioLogV3()):
          events  discrete hits            -> v2 preset library + engine_v3/sfx_presets_v3.js (+ channel overrides)
          synth   continuous voices        -> oscillator with per-sample frequency AND low-pass filter modulation
          pulses  rhythmic accents         -> kick / bass / hat / snare on the exact frames of mechanical steps
        optional "groove" block from the timeline (bpm + step patterns) -> frame-quantized background pulse
Output: mix_v3.wav — 48 kHz stereo, no voice, no ducking.

Musical mastering (identical to engine_v3/synth_engine.js, the live preview):
  every voice: voiceGain (max 0.16) -> lowpass 2000 Hz Q 0.8 -> compressor (threshold -18 dB, knee 12, ratio 12,
  attack 3 ms, release 150 ms) -> masterGain 0.75 -> safety lookahead limiter (-1 dBFS ceiling)
  strict 3-voice polyphony per bus (sfx, rhythm): a 4th voice fades the oldest out in 15 ms
  pitched layers snapped to C major pentatonic, folded to <= 880 Hz; square/saw -> triangle (>=200 Hz) or low pulse

Every hit lands on sample round(frame / fps * 48000), the same instant the frame appears on screen.
Groove steps use frame = ceil(T * fps - 1e-9), exactly like R.onBeat() in engine_v3/micro_text.js.

    python pipeline_v3/synth_v3.py episodes_v3/<ep>/build/audio_log_v3.json episodes_v3/<ep>/build/mix_v3.wav --duration 34
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "pipeline"))
from common import SAMPLE_RATE, _read_js_json, load_sfx_presets, log, read_json, write_wav  # noqa: E402  (v2 helpers, read-only)
from synth_sfx import synth_sound  # noqa: E402  (same oscillator/ADSR as the browser preview)

FPS = 60
ENGINE_V3 = ROOT / "engine_v3"


# ------------------------------------------------------------------ presets
def load_presets_v3(channel_dir: Path | None = None) -> dict:
    """v2 library  <  v3 additions  <  channel overrides (this channel only)."""
    presets = load_sfx_presets(None)
    text = (ENGINE_V3 / "sfx_presets_v3.js").read_text(encoding="utf-8")
    body = text[text.index("=") + 1: text.index("\nObject.assign")].strip().rstrip(";")
    v3 = json.loads(body)
    v3.pop("_doc", None)
    presets.update(v3)
    if channel_dir is not None and (channel_dir / "sfx_presets.js").exists():
        presets.update(_read_js_json(channel_dir / "sfx_presets.js"))
    return presets


# ------------------------------------------------------------------ helpers
def _place(bus: np.ndarray, snd: np.ndarray, frame: int, vol: float, pan: float, fps: int = FPS, sr: int = SAMPLE_RATE):
    start = int(round(frame / fps * sr))
    if start >= len(bus) or start < 0:
        return
    end = min(len(bus), start + len(snd))
    ang = (float(np.clip(pan, -1, 1)) + 1) * np.pi / 4
    seg = snd[: end - start] * vol
    bus[start:end, 0] += seg * np.cos(ang) * np.sqrt(2)
    bus[start:end, 1] += seg * np.sin(ang) * np.sqrt(2)


def svf_lowpass(x: np.ndarray, cutoff: np.ndarray, res: np.ndarray, sr: int = SAMPLE_RATE) -> np.ndarray:
    """Chamberlin state-variable low-pass with per-sample cutoff/resonance (stable up to ~sr/6)."""
    f = np.clip(2 * np.sin(np.pi * np.clip(cutoff, 20, sr / 6.5) / sr), 0, 1.0).tolist()
    q = (2.0 * (1.0 - np.clip(res, 0, 0.95))).tolist()
    xs = x.tolist()
    out = [0.0] * len(xs)
    low = band = 0.0
    for i in range(len(xs)):
        fi = f[i]
        low += fi * band
        high = xs[i] - low - q[i] * band
        band += fi * high
        out[i] = low
    return np.asarray(out, dtype=np.float64)


def _hold_fill(arr: np.ndarray, default: float) -> np.ndarray:
    valid = ~np.isnan(arr)
    if not valid.any():
        return np.full_like(arr, default)
    idx = np.where(valid, np.arange(len(arr)), 0)
    np.maximum.accumulate(idx, out=idx)
    out = arr[idx]
    first = np.argmax(valid)
    out[:first] = arr[first]
    return out


def synth_continuous_v3(states: dict, n: int, sr: int = SAMPLE_RATE, fps: int = FPS) -> np.ndarray:
    out = np.zeros((n, 2), dtype=np.float32)
    if not states:
        return out
    n_frames = int(math.ceil(n / sr * fps)) + 2
    t = np.arange(n) / sr
    ft = np.arange(n_frames) / fps
    for vi, (vid, v) in enumerate(sorted(states.items())):
        rows = np.asarray(v.get("frames") or [], dtype=np.float64)
        if rows.size == 0:
            continue
        if rows.shape[1] < 7:   # v2-style rows without filter columns
            rows = np.hstack([rows, np.zeros((len(rows), 7 - rows.shape[1]))])
        rows = rows[(rows[:, 0] >= 0) & (rows[:, 0] < n_frames)]
        if rows.size == 0:
            continue
        idx = rows[:, 0].astype(int)
        cols = {k: np.full(n_frames, np.nan) for k in ("freq", "duty", "noise", "cutoff", "res")}
        gain = np.zeros(n_frames)                      # frames without a log entry fade to silence
        for k, c in (("freq", 1), ("duty", 2), ("noise", 4), ("cutoff", 5), ("res", 6)):
            cols[k][idx] = rows[:, c]
        gain[idx] = rows[:, 3]
        for k, d in (("freq", 110.0), ("duty", 0.5), ("noise", 0.0), ("cutoff", 0.0), ("res", 0.0)):
            cols[k] = _hold_fill(cols[k], d)
        fs = np.clip(np.interp(t, ft, cols["freq"]), 0, MAX_HZ)
        ds = np.clip(np.interp(t, ft, cols["duty"]), 0.02, 0.98)
        gs = np.interp(t, ft, gain)
        ns = np.clip(np.interp(t, ft, cols["noise"]), 0, 1)
        phase = np.cumsum(fs / sr)
        frac = phase - np.floor(phase)
        wave = v.get("wave", "square")
        if wave == "triangle":
            osc = 1 - 4 * np.abs(frac - 0.5)
        elif wave in ("saw", "sawtooth"):
            osc = 2 * frac - 1
        elif wave == "sine":
            osc = np.sin(2 * np.pi * phase)
        else:
            osc = np.where(frac < ds, 1.0, -1.0)
        hiss = np.random.default_rng(3000 + vi).uniform(-1, 1, n)
        sig = osc * (1 - ns) + hiss * ns
        if np.any(cols["cutoff"] > 0):
            cut = np.interp(t, ft, np.where(cols["cutoff"] > 0, cols["cutoff"], sr / 6.5))
            sig = svf_lowpass(sig, cut, np.interp(t, ft, cols["res"]), sr)
        sig = sig * np.clip(gs, 0, 1) * VOICE_GAIN
        ang = (float(np.clip(v.get("pan", 0.0), -1, 1)) + 1) * np.pi / 4
        out[:, 0] += (sig * np.cos(ang) * np.sqrt(2)).astype(np.float32)
        out[:, 1] += (sig * np.sin(ang) * np.sqrt(2)).astype(np.float32)
    return out


NOTE = {"C": 0, "C#": 1, "DB": 1, "D": 2, "D#": 3, "EB": 3, "E": 4, "F": 5, "F#": 6, "GB": 6, "G": 7, "G#": 8, "AB": 8,
        "A": 9, "A#": 10, "BB": 10, "B": 11}


def note_to_semis(n) -> float:
    """Semitones relative to A1 (55 Hz) — mirrors noteToSemisV3() in audio_events_v3.js."""
    if isinstance(n, (int, float)):
        return float(n)
    s = str(n or "A1").strip()
    name, octv = s[:-1].upper(), int(s[-1])
    return float(octv * 12 + NOTE.get(name, 9) - (1 * 12 + 9))


def groove_pulses(groove: dict | None, duration: float, fps: int = FPS) -> list[dict]:
    """Expand {"bpm", "steps_per_beat", "start", "end", "pattern": {kind: "x.o."}, "notes": [...], "gain"} into pulses."""
    if not groove or not groove.get("pattern"):
        return []
    bpm = float(groove.get("bpm", 120))
    spb = 60.0 / bpm
    div = int(groove.get("steps_per_beat", 4))
    start = float(groove.get("start", 0.0))
    end = float(groove.get("end", duration))
    notes = groove.get("notes") or ["A1"]
    out, k, bass_i = [], 0, 0
    while True:
        T = start + k * spb / div
        if T >= min(end, duration):
            break
        frame = math.ceil(T * fps - 1e-9)
        for kind, pat in groove["pattern"].items():
            if not pat:
                continue
            ch = pat[k % len(pat)]
            if ch in "xXo":
                acc = 1.0 if ch == "X" else 0.75 if ch == "x" else 0.45
                semis = 0.0
                if kind == "bass":
                    semis = note_to_semis(notes[bass_i % len(notes)])
                    bass_i += 1
                out.append({"kind": kind, "frame": frame, "semis": semis, "accent": acc, "pan": 0.0, "groove": True})
        k += 1
    return out


def lookahead_limit(x: np.ndarray, sr: int = SAMPLE_RATE, ceiling_db: float = -1.0,
                    look_ms: float = 5.0, release_ms: float = 90.0) -> np.ndarray:
    """Transparent peak limiter: block peak envelope, lookahead min, smooth release, per-sample gain."""
    ceiling = 10 ** (ceiling_db / 20)
    B = 48
    nb = int(math.ceil(len(x) / B))
    pad = np.zeros((nb * B, x.shape[1]), dtype=np.float32)
    pad[: len(x)] = x
    peaks = np.abs(pad).reshape(nb, B, -1).max(axis=(1, 2))
    need = np.minimum(1.0, ceiling / np.maximum(peaks, 1e-9))
    la = max(1, int(look_ms / 1000 * sr / B))
    need_la = np.array([need[i: i + la + 1].min() for i in range(nb)])
    rel = math.exp(-B / (release_ms / 1000 * sr))
    g = np.empty(nb)
    cur = 1.0
    for i in range(nb):
        cur = need_la[i] if need_la[i] < cur else need_la[i] + (cur - need_la[i]) * rel
        g[i] = cur
    gs = np.interp(np.arange(nb * B), np.arange(nb) * B + B / 2, g)[: len(x)]
    return (x * gs[:, None]).astype(np.float32)


# ------------------------------------------------------------------ musical mastering (mirrors synth_engine.js)
VOICE_GAIN, MASTER_GAIN, MAX_HZ, POLYPHONY, STEAL_FADE = 0.16, 0.75, 880.0, 3, 0.015
LOWPASS_HZ, LOWPASS_Q = 2000.0, 0.8
COMP = {"threshold": -18.0, "knee": 12.0, "ratio": 12.0, "attack": 0.003, "release": 0.15}
PENTA = [261.63, 293.66, 329.63, 392.00, 440.00, 523.25, 587.33, 659.25]
_NOTES = sorted(f * 2.0 ** o for o in range(-5, 5) for f in PENTA[:5])


def snap(f: float) -> float:
    """Nearest C-major-pentatonic note in any octave (no folding)."""
    return f if not f > 0 else min(_NOTES, key=lambda n: abs(math.log2(f / n)))


def quantize(f: float) -> float:
    """Nearest C-major-pentatonic note, folded down by octaves to <= 880 Hz."""
    q = snap(f)
    while q > MAX_HZ + 1e-6:
        q /= 2
    return round(q, 4)


def musicalize(layers: list, pitch: float, musical: bool = True) -> list:
    """Bake the semitone pitch into the layers, snap to pentatonic, warm the waveform. Mirrors synth_engine.js."""
    k = 2 ** (float(pitch or 0) / 12)
    out = []
    for L0 in layers:
        L = dict(L0)
        f0 = float(L.get("freq", 440)) * k
        f1 = float(L.get("freqEnd", L.get("freq", 440))) * k
        if L.get("wave") == "noise":
            L["freq"], L["freqEnd"] = f0, f1
        elif not musical:
            L["freq"], L["freqEnd"] = min(f0, MAX_HZ), min(f1, MAX_HZ)
        else:
            q0 = snap(f0)
            q1 = q0 if abs(f1 - f0) < 1e-6 else snap(f1)
            arp_hz = [snap(q0 * 2 ** (a / 12)) for a in (L.get("arp") or [])]
            top = max([q0, q1] + arp_hz)
            fold = 2 ** max(0, math.ceil(math.log2(top / MAX_HZ) - 1e-9))    # shift the whole note down whole octaves
            q0, q1 = round(q0 / fold, 4), round(q1 / fold, 4)
            if arp_hz:
                L["arp"] = [12 * math.log2((h / fold) / q0) for h in arp_hz]
            if L.get("wave", "square") in ("square", "saw"):
                if q0 >= 200:
                    L["wave"] = "triangle"
                else:
                    L["wave"], L["duty"] = "square", 0.5
            L["freq"], L["freqEnd"] = q0, q1
        out.append(L)
    return out


def place_voices(voices: list, n: int, cap: int = POLYPHONY, fade: float = STEAL_FADE, sr: int = SAMPLE_RATE) -> np.ndarray:
    """voices: [(start_sample, mono_snd, gain, pan)]. Strict polyphony: when a voice starts while `cap` are
    sounding, the OLDEST is faded to silence over `fade` seconds (same as the preview)."""
    bus = np.zeros((n, 2), dtype=np.float32)
    voices = sorted(voices, key=lambda v: v[0])
    ends = [v[0] + len(v[1]) for v in voices]
    cut = [None] * len(voices)
    active: list[int] = []
    fs = max(1, int(fade * sr))
    for i, (st, snd, g, pan) in enumerate(voices):
        active = [j for j in active if (cut[j] if cut[j] is not None else ends[j]) > st]
        while len(active) >= cap:
            j = min(active, key=lambda a: voices[a][0])
            cut[j] = st
            active.remove(j)
        active.append(i)
    for i, (st, snd, g, pan) in enumerate(voices):
        if st >= n:
            continue
        seg = snd.astype(np.float32).copy()
        if cut[i] is not None:
            keep = max(0, cut[i] - st)
            seg = seg[: keep + fs]
            if keep < len(seg):
                seg[keep:] *= np.linspace(1, 0, len(seg) - keep, dtype=np.float32)
        end = min(n, st + len(seg))
        seg = seg[: end - st] * min(VOICE_GAIN, VOICE_GAIN * g)
        ang = (float(np.clip(pan, -1, 1)) + 1) * np.pi / 4
        bus[st:end, 0] += seg * np.cos(ang) * np.sqrt(2)
        bus[st:end, 1] += seg * np.sin(ang) * np.sqrt(2)
    return bus


def biquad_lowpass(x: np.ndarray, f0: float = LOWPASS_HZ, q: float = LOWPASS_Q, sr: int = SAMPLE_RATE) -> np.ndarray:
    """RBJ low-pass (same response as Web Audio's BiquadFilterNode 'lowpass'), applied via its impulse response."""
    w0 = 2 * np.pi * f0 / sr
    alpha = np.sin(w0) / (2 * q)
    cw = np.cos(w0)
    b = np.array([(1 - cw) / 2, 1 - cw, (1 - cw) / 2]) / (1 + alpha)
    a1, a2 = -2 * cw / (1 + alpha), (1 - alpha) / (1 + alpha)
    L = 4096
    ir = np.zeros(L)
    x1 = x2 = y1 = y2 = 0.0
    for i in range(L):
        xi = 1.0 if i == 0 else 0.0
        yi = b[0] * xi + b[1] * x1 + b[2] * x2 - a1 * y1 - a2 * y2
        ir[i] = yi
        x2, x1, y2, y1 = x1, xi, y1, yi
    n = x.shape[0] + L - 1
    nfft = 1 << (n - 1).bit_length()
    H = np.fft.rfft(ir, nfft)
    out = np.empty_like(x)
    for ch in range(x.shape[1]):
        out[:, ch] = np.fft.irfft(np.fft.rfft(x[:, ch], nfft) * H, nfft)[: x.shape[0]]
    return out.astype(np.float32)


def compressor(x: np.ndarray, sr: int = SAMPLE_RATE, threshold: float = -18.0, knee: float = 12.0, ratio: float = 12.0,
               attack: float = 0.003, release: float = 0.15) -> np.ndarray:
    """Feed-forward peak compressor with a soft knee (Web Audio DynamicsCompressor parameters, no makeup gain)."""
    B = 48                                                    # 1 ms control blocks
    nb = int(math.ceil(len(x) / B))
    pad = np.zeros((nb * B, x.shape[1]), dtype=np.float32)
    pad[: len(x)] = x
    lvl = 20 * np.log10(np.maximum(np.abs(pad).reshape(nb, B, -1).max(axis=(1, 2)), 1e-9))
    over = lvl - threshold
    out_db = np.where(over <= -knee / 2, lvl,
                      np.where(over >= knee / 2, threshold + over / ratio,
                               lvl + (1 / ratio - 1) * (over + knee / 2) ** 2 / (2 * knee)))
    target = out_db - lvl                                      # gain reduction in dB (<= 0)
    ca, cr = math.exp(-B / (attack * sr)), math.exp(-B / (release * sr))
    g = np.empty(nb)
    cur = 0.0
    for i in range(nb):
        tgt = target[i]
        cur = tgt + (cur - tgt) * (ca if tgt < cur else cr)
        g[i] = cur
    gs = 10 ** (np.interp(np.arange(nb * B), np.arange(nb) * B + B / 2, g)[: len(x)] / 20)
    return (x * gs[:, None]).astype(np.float32)


# ------------------------------------------------------------------ main entry
def synthesize_v3(log_data: dict, duration: float, out_path: Path, groove: dict | None = None,
                  channel_dir: Path | None = None, sr: int = SAMPLE_RATE, mix: dict | None = None,
                  audio: dict | None = None) -> dict:
    fps = int(log_data.get("fps", FPS))
    mix = {"sfx": 1.0, "pulses": 0.8, "groove": 0.45, "synth": 1.0, **(mix or {})}
    audio = audio or {}
    musical = audio.get("musical", True)
    cap = int(audio.get("polyphony", POLYPHONY))
    presets = load_presets_v3(channel_dir)
    n = int(math.ceil(duration * sr))
    cache, unknown = {}, set()

    def sound(kind, semis):
        key = (kind, round(float(semis), 3))
        if key not in cache:
            cache[key] = synth_sound(musicalize(presets[kind], float(semis), musical), 0.0, sr)
        return cache[key]

    start_of = lambda frame: int(round(int(frame) / fps * sr))  # noqa: E731  frame-locked placement
    sfx_voices = []
    for ev in log_data.get("events", []):
        if ev["type"] not in presets:
            unknown.add(ev["type"]); continue
        sfx_voices.append((start_of(ev["frame"]), sound(ev["type"], ev.get("pitch", 0)), float(ev.get("vol", 1)) * mix["sfx"], float(ev.get("pan", 0))))
    pulses = list(log_data.get("pulses", [])) + groove_pulses(groove, duration, fps)
    rhythm_voices, n_groove = [], 0
    for p in pulses:
        if p["kind"] not in presets:
            unknown.add(p["kind"]); continue
        g = (0.35 + 0.65 * float(p.get("accent", 0.7))) * (mix["groove"] if p.get("groove") else mix["pulses"])
        n_groove += bool(p.get("groove"))
        rhythm_voices.append((start_of(p["frame"]), sound(p["kind"], p.get("semis", 0)), g, float(p.get("pan", 0))))

    bus = place_voices(sfx_voices, n, cap, sr=sr) + place_voices(rhythm_voices, n, cap, sr=sr)
    bus += synth_continuous_v3(log_data.get("synth", {}), n, sr, fps) * mix["synth"]
    # master chain: lowpass 2 kHz Q0.8 -> compressor -> master 0.75 -> safety limiter
    bus = biquad_lowpass(bus, audio.get("lowpassHz", LOWPASS_HZ), audio.get("lowpassQ", LOWPASS_Q), sr)
    bus = compressor(bus, sr, **{**COMP, **(audio.get("comp") or {})})
    bus *= float(audio.get("masterGain", MASTER_GAIN))
    bus = lookahead_limit(bus, sr)
    fade = int(0.03 * sr)
    if n > 2 * fade:
        bus[:fade] *= np.linspace(0, 1, fade)[:, None]; bus[-fade:] *= np.linspace(1, 0, fade)[:, None]
    write_wav(out_path, bus, sr)
    if unknown:
        log(f"unknown sound types skipped (add to engine_v3/sfx_presets_v3.js or the channel sfx file): {sorted(unknown)}", "warn")
    peak = float(np.max(np.abs(bus))) if bus.size else 0.0
    max_note = max((L["freq"] for k in cache for L in musicalize(presets[k[0]], k[1], musical) if L.get("wave") != "noise"), default=0)
    return {"events": len(sfx_voices), "pulses": len(pulses) - n_groove, "groove_steps": n_groove,
            "voices": len(log_data.get("synth", {})), "peak_db": 20 * math.log10(peak) if peak > 0 else -120.0,
            "max_note_hz": round(max_note, 2)}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("log", type=Path, help="audio_log_v3.json")
    ap.add_argument("out", type=Path)
    ap.add_argument("--duration", type=float, required=True)
    ap.add_argument("--timeline", type=Path, default=None, help="timeline.json with an optional 'groove' block")
    args = ap.parse_args()
    groove = read_json(args.timeline).get("groove") if args.timeline else None
    info = synthesize_v3(read_json(args.log), args.duration, args.out, groove)
    log(f"mix_v3.wav: {info}", "ok")


if __name__ == "__main__":
    main()
