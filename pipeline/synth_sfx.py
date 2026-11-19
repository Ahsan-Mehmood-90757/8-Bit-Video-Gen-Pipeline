"""synth_sfx.py — sample-accurate 8-bit SFX track from sfx_events.json.

Each event logged by the simulation (window.logSfx(type, frame, pitch)) is synthesized
with NumPy square / triangle / saw / LFSR-noise oscillators + ADSR envelopes, using the
presets in engine/sfx_presets.js (the same file the browser preview uses), and placed at
exactly frame / fps seconds -> perfectly locked to the rendered video frames.

Usage:
    python pipeline/synth_sfx.py episodes/ep01/build/sfx_events.json episodes/ep01/build/sfx.wav --duration 42.5
"""
from __future__ import annotations

import argparse
import math
from pathlib import Path

import numpy as np

from common import FPS, SAMPLE_RATE, load_sfx_presets, log, read_json, write_wav

_LFSR_CACHE: np.ndarray | None = None


def _lfsr_table(n: int) -> np.ndarray:
    """Output of the NES 15-bit LFSR after k+1 steps, for k in [0, n). Matches retro_audio.js."""
    global _LFSR_CACHE
    if _LFSR_CACHE is not None and len(_LFSR_CACHE) >= n:
        return _LFSR_CACHE[:n]
    n2 = max(n, 65536)
    out = np.empty(n2, dtype=np.float32)
    reg = 1
    for k in range(n2):
        fb = (reg & 1) ^ ((reg >> 1) & 1)
        reg = (reg >> 1) | (fb << 14)
        out[k] = -1.0 if (reg & 1) else 1.0
    _LFSR_CACHE = out
    return out[:n]


def synth_layer(L: dict, pitch: float, sr: int = SAMPLE_RATE) -> np.ndarray:
    delay = float(L.get("delay", 0.0))
    dur = max(float(L.get("dur", 0.05)), 1e-4)
    r = float(L.get("r", 0.0))
    a, d = float(L.get("a", 0.0)), float(L.get("d", 0.0))
    s = float(L.get("s", 1.0))
    n = math.ceil((delay + dur + r) * sr) + 1
    out = np.zeros(n, dtype=np.float64)
    tt_all = np.arange(n) / sr - delay
    valid = tt_all >= 0
    tt = tt_all[valid]

    def level(t):
        lv = np.full_like(t, s)
        if a > 0:
            m = t < a
            lv[m] = t[m] / a
        else:
            lv[t < 0] = 1.0
        if d > 0:
            m = (t >= a) & (t < a + d)
            lv[m] = 1 - (1 - s) * (t[m] - a) / d
        return lv

    rel_level = level(np.array([dur]))[0]
    env = np.where(tt < dur, level(np.minimum(tt, dur)),
                   rel_level * np.clip(1 - (tt - dur) / r, 0, None) if r > 0 else 0.0)

    f0 = float(L.get("freq", 440.0))
    f1 = float(L.get("freqEnd", f0))
    prog = np.clip(tt / dur, 0, 1)
    f = f0 * np.power(f1 / f0, prog)
    semis = np.full_like(tt, float(pitch))
    arp = L.get("arp")
    if arp:
        step = float(L.get("arpStep", 0.06))
        idx = np.minimum(np.floor(tt / step).astype(int), len(arp) - 1)
        semis = semis + np.asarray(arp, dtype=np.float64)[idx]
    f = f * np.power(2.0, semis / 12.0)
    vib = L.get("vib")
    if vib:
        f = f * (1 + vib[1] * np.sin(2 * np.pi * vib[0] * tt))
    f = np.minimum(f, sr * 0.45)
    phase = np.cumsum(f / sr)
    frac = phase - np.floor(phase)

    wave = L.get("wave", "square")
    if wave == "triangle":
        v = 1 - 4 * np.abs(frac - 0.5)
    elif wave == "saw":
        v = 2 * frac - 1
    elif wave == "sine":
        v = np.sin(2 * np.pi * phase)
    elif wave == "noise":
        k = np.floor(phase).astype(int)
        v = _lfsr_table(int(k.max()) + 1)[k].astype(np.float64)
    else:
        v = np.where(frac < float(L.get("duty", 0.5)), 1.0, -1.0)

    v = v * env * float(L.get("vol", 0.5))
    crush = int(L.get("crush", 0) or 0)
    if crush:
        lv = 2 ** (crush - 1)
        v = np.round(v * lv) / lv
    out[valid] = v
    return out.astype(np.float32)


def synth_sound(layers: list, pitch: float, sr: int = SAMPLE_RATE) -> np.ndarray:
    parts = [synth_layer(L, pitch, sr) for L in layers]
    n = max(len(p) for p in parts)
    out = np.zeros(n, dtype=np.float32)
    for p in parts:
        out[:len(p)] += p
    return out


def synth_continuous(states: dict, n_samples: int, sr: int = SAMPLE_RATE, fps: int = FPS) -> np.ndarray:
    """Continuous physics-coupled voices from window.logSynthState(): one row per frame with
    [frame, freqHz, duty, gain, noise]. Parameters are interpolated per sample (no zipper noise);
    frames where a voice wasn't logged fade it to silence."""
    out = np.zeros((n_samples, 2), dtype=np.float32)
    if not states:
        return out
    n_frames = int(math.ceil(n_samples / sr * fps)) + 2
    t = np.arange(n_samples) / sr
    ft = np.arange(n_frames) / fps
    for vi, (vid, v) in enumerate(sorted(states.items())):
        rows = np.asarray(v.get("frames") or [], dtype=np.float64)
        if rows.size == 0:
            continue
        rows = rows[(rows[:, 0] >= 0) & (rows[:, 0] < n_frames)]
        if rows.size == 0:
            continue
        idx = rows[:, 0].astype(int)
        freq = np.full(n_frames, np.nan); duty = np.full(n_frames, np.nan); noise = np.full(n_frames, np.nan)
        gain = np.zeros(n_frames)
        freq[idx], duty[idx], gain[idx], noise[idx] = rows[:, 1], rows[:, 2], rows[:, 3], rows[:, 4]
        for arr, dflt in ((freq, rows[0, 1]), (duty, rows[0, 2]), (noise, rows[0, 4])):   # hold last value
            valid = ~np.isnan(arr)
            fill = np.maximum.accumulate(np.where(valid, np.arange(n_frames), 0))
            arr[:] = np.where(valid.any(), arr[fill], dflt)
            arr[np.isnan(arr)] = dflt
        fs = np.clip(np.interp(t, ft, freq), 0, sr * 0.45)
        ds = np.clip(np.interp(t, ft, duty), 0.02, 0.98)
        gs = np.interp(t, ft, gain)
        ns = np.clip(np.interp(t, ft, noise), 0, 1)
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
        rng = np.random.default_rng(1000 + vi)
        hiss = rng.uniform(-1, 1, n_samples)
        sig = (osc * (1 - ns) + hiss * ns) * gs * 0.6
        pan = float(np.clip(v.get("pan", 0.0), -1, 1))
        ang = (pan + 1) * np.pi / 4
        out[:, 0] += (sig * np.cos(ang) * np.sqrt(2)).astype(np.float32)
        out[:, 1] += (sig * np.sin(ang) * np.sqrt(2)).astype(np.float32)
    return out


def synthesize(events: list, duration: float, out_path: Path, sr: int = SAMPLE_RATE,
               fps: int = FPS, master: float = 0.6, synth_states: dict | None = None,
               channel_dir: Path | None = None) -> dict:
    presets = load_sfx_presets(channel_dir)
    n_total = int(math.ceil(duration * sr)) + sr  # +1s headroom for tails, trimmed below
    bus = np.zeros((n_total, 2), dtype=np.float32)
    if synth_states:
        bus += synth_continuous(synth_states, n_total, sr, fps)
    cache: dict = {}
    unknown, placed = set(), 0
    for ev in events:
        typ = ev.get("type")
        if typ not in presets:
            unknown.add(typ)
            continue
        pitch = float(ev.get("pitch", 0))
        key = (typ, round(pitch, 3))
        if key not in cache:
            cache[key] = synth_sound(presets[typ], pitch, sr)
        snd = cache[key] * float(ev.get("vol", 1.0))
        start = int(round(int(ev.get("frame", 0)) / fps * sr))  # frame-locked placement
        if start >= n_total:
            continue
        end = min(n_total, start + len(snd))
        pan = float(np.clip(ev.get("pan", 0.0), -1, 1))
        ang = (pan + 1) * np.pi / 4
        gl, gr = np.cos(ang) * np.sqrt(2), np.sin(ang) * np.sqrt(2)
        seg = snd[: end - start]
        bus[start:end, 0] += seg * gl
        bus[start:end, 1] += seg * gr
        placed += 1
    bus = bus[: int(math.ceil(duration * sr))] * master
    bus = np.tanh(bus * 1.2) / np.tanh(1.2)  # soft limiter so dense bursts never clip
    write_wav(out_path, bus, sr)
    if unknown:
        log(f"Unknown SFX types skipped (add them to engine/sfx_presets.js): {sorted(unknown)}", "warn")
    peak = float(np.max(np.abs(bus))) if bus.size else 0.0
    return {"events": placed, "voices": len(synth_states or {}), "unique_sounds": len(cache), "peak_dbfs": 20 * math.log10(peak) if peak > 0 else -120}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("events", type=Path)
    ap.add_argument("out", type=Path)
    ap.add_argument("--duration", type=float, default=None, help="seconds (default: last event + 2s)")
    ap.add_argument("--fps", type=int, default=FPS)
    args = ap.parse_args()
    data = read_json(args.events)
    events = data["events"] if isinstance(data, dict) else data
    dur = args.duration or (max((e["frame"] for e in events), default=0) / args.fps + 2.0)
    states = data.get("synth", {}) if isinstance(data, dict) else {}
    info = synthesize(events, dur, args.out, fps=args.fps, synth_states=states)
    log(f"sfx.wav: {info['events']} events, {info['unique_sounds']} unique sounds, peak {info['peak_dbfs']:.1f} dBFS", "ok")


if __name__ == "__main__":
    main()
