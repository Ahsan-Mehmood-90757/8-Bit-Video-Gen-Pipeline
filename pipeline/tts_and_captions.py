"""tts_and_captions.py — narration, beat timeline and word-synced .ass captions.

Reads  episodes/<ep>/script.json
Writes episodes/<ep>/build/
         narration.wav    48 kHz mono voiceover (all beats, with gaps)
         timeline.json    beat start/end times + word timings (drives the simulation's pacing)
         timeline.js      same data as window.EPISODE_TIMELINE for the browser
         captions.ass     bold, high-contrast, word-highlighted captions in the lower-middle safe zone

TTS engines are tried in order (script.json "tts_engines"):
  kokoro  -> local kokoro-onnx  (models/kokoro-v1.0.onnx + models/voices-v1.0.bin)
  piper   -> local piper CLI    (voice.piper_model, e.g. models/piper/en_US-ryan-high.onnx)
  sapi    -> Windows built-in System.Speech voice (no install, robotic but local)
  edge    -> edge-tts (needs internet)
  silent  -> timed silence so the rest of the pipeline can still be tested

Captions: faster-whisper (small.en, int8, CPU) word timestamps, aligned back onto the
script text so spelling is always exactly what you wrote. Falls back to estimated timing
if faster-whisper is not installed.

Usage:
    python pipeline/tts_and_captions.py --episode episodes/ep01 [--force]
"""
from __future__ import annotations

import argparse
import difflib
import gc
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

from common import (OUT_H, OUT_W, ROOT, SAMPLE_RATE, db_to_gain, deep_merge, find_channel, load_audio,
                    load_channel, log, read_json, write_json, write_wav)

DEFAULTS = {
    "tts_engines": ["kokoro", "piper", "sapi", "edge", "silent"],
    "voice": {
        "kokoro_voice": "am_michael", "kokoro_lang": "en-us", "speed": 1.0,
        "kokoro_model": "models/kokoro-v1.0.onnx", "kokoro_voices": "models/voices-v1.0.bin",
        "piper_model": "models/piper/en_US-ryan-high.onnx",
        "edge_voice": "en-US-GuyNeural", "sapi_rate": 1,
    },
    "timing": {"lead_in": 0.35, "gap": 0.3, "tail": 1.6},
    "captions": {
        "enabled": True, "font": "Arial Black", "size": 74, "uppercase": True,
        "max_words": 3, "max_chars": 16, "color": "#F8FAFC", "highlight": "#FACC15",
        "outline": "#0B0F19", "outline_px": 7, "shadow_px": 3, "margin_v": 440,
        "whisper_model": "small.en", "use_whisper": True,
    },
    "crt": True,
}


CHANNEL_KEYS = ("tts_engines", "voice", "timing", "captions", "crt")


def merged_config(script: dict, channel: dict | None = None, overrides: dict | None = None) -> dict:
    """engine DEFAULTS  <  channels/<slug>/channel.json  <  episode script.json  <  CLI overrides"""
    ch = {k: v for k, v in (channel or {}).items() if k in CHANNEL_KEYS}
    return deep_merge(DEFAULTS, ch, script, overrides or {})


def resolve(p: str) -> Path:
    path = Path(p)
    return path if path.is_absolute() else ROOT / path


# =================================================================== TTS engines
class TTS:
    def __init__(self, cfg: dict, tmp: Path):
        self.cfg, self.voice, self.tmp = cfg, cfg["voice"], tmp
        self._kokoro_model = None
        self.engine_used: set[str] = set()

    def synth(self, text: str, out_wav: Path) -> str:
        errors = []
        for eng in self.cfg["tts_engines"]:
            try:
                fn = getattr(self, "_" + eng)
                if fn(text, out_wav):
                    self.engine_used.add(eng)
                    return eng
            except Exception as e:  # try the next engine
                errors.append(f"{eng}: {e}")
        raise RuntimeError("All TTS engines failed:\n  " + "\n  ".join(errors))

    def _kokoro(self, text, out):
        model, voices = resolve(self.voice["kokoro_model"]), resolve(self.voice["kokoro_voices"])
        if not model.exists() or not voices.exists():
            raise FileNotFoundError(f"missing {model.name}/{voices.name} in models/ (run setup_windows.bat)")
        if self._kokoro_model is None:
            from kokoro_onnx import Kokoro  # noqa: import here so other engines work without it
            self._kokoro_model = Kokoro(str(model), str(voices))
        samples, sr = self._kokoro_model.create(text, voice=self.voice["kokoro_voice"],
                                          speed=float(self.voice.get("speed", 1.0)),
                                          lang=self.voice.get("kokoro_lang", "en-us"))
        write_wav(out, np.asarray(samples, dtype=np.float32), sr)
        return True

    def _piper(self, text, out):
        model = resolve(self.voice["piper_model"])
        if not model.exists():
            raise FileNotFoundError(f"piper model not found: {model}")
        exe = shutil.which("piper")
        cmd = [exe] if exe else [sys.executable, "-m", "piper"]
        speed = float(self.voice.get("speed", 1.0))
        cmd += ["--model", str(model), "--output_file", str(out), "--length_scale", f"{1.0 / speed:.3f}"]
        p = subprocess.run(cmd, input=text.encode("utf-8"), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if p.returncode != 0 or not out.exists():
            raise RuntimeError(p.stderr.decode("utf-8", "replace")[-400:])
        return True

    def _sapi(self, text, out):
        if os.name != "nt":
            raise RuntimeError("SAPI is Windows-only")
        txt = self.tmp / "sapi.txt"
        txt.write_text(text, encoding="utf-8")
        q = lambda p: str(p).replace("'", "''")  # PowerShell single-quote escaping
        ps = ("Add-Type -AssemblyName System.Speech; "
              "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; "
              f"$s.Rate = {int(self.voice.get('sapi_rate', 1))}; "
              f"$s.SetOutputToWaveFile('{q(out)}'); "
              f"$s.Speak([IO.File]::ReadAllText('{q(txt)}')); $s.Dispose()")
        p = subprocess.run(["powershell", "-NoProfile", "-Command", ps], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if p.returncode != 0 or not out.exists():
            raise RuntimeError(p.stderr.decode("utf-8", "replace")[-400:])
        return True

    def _edge(self, text, out):
        mp3 = out.with_suffix(".mp3")
        p = subprocess.run([sys.executable, "-m", "edge_tts", "--voice", self.voice["edge_voice"],
                            "--text", text, "--write-media", str(mp3)], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if p.returncode != 0 or not mp3.exists():
            raise RuntimeError(p.stderr.decode("utf-8", "replace")[-400:])
        write_wav(out, load_audio(mp3), SAMPLE_RATE)
        mp3.unlink(missing_ok=True)
        return True

    def _silent(self, text, out):
        words = len(text.split())
        dur = words / 2.6 / float(self.voice.get("speed", 1.0)) + 0.2
        write_wav(out, np.zeros(int(dur * SAMPLE_RATE), dtype=np.float32), SAMPLE_RATE)
        if not getattr(self, "_warned_silent", False):
            log("Using SILENT placeholder narration (no TTS engine available) — timings are estimates. "
                "Install kokoro-onnx + models (setup_windows.bat) for a real voice.", "warn")
            self._warned_silent = True
        return True

    def close(self):
        self._kokoro_model = None
        gc.collect()


def trim_silence(x: np.ndarray, sr: int, thresh_db: float = -42.0, pad: float = 0.04) -> np.ndarray:
    if x.size == 0 or np.max(np.abs(x)) == 0:
        return x
    thr = db_to_gain(thresh_db) * np.max(np.abs(x))
    idx = np.nonzero(np.abs(x) > thr)[0]
    a = max(0, idx[0] - int(pad * sr))
    b = min(len(x), idx[-1] + int(pad * sr))
    return x[a:b]


# =================================================================== words & alignment
WORD_RE = re.compile(r"\S+")


def norm(w: str) -> str:
    return re.sub(r"[^a-z0-9]", "", w.lower())


def script_words(beats: list) -> list[dict]:
    out = []
    for bi, b in enumerate(beats):
        for m in WORD_RE.finditer(b["text"]):
            out.append({"w": m.group(0), "key": norm(m.group(0)), "beat": bi, "start": None, "end": None})
    return out


def estimate_word_times(words: list[dict], beats: list) -> None:
    """Spread each beat's words over its speech span, weighting long words and punctuation pauses."""
    for bi, b in enumerate(beats):
        ws = [w for w in words if w["beat"] == bi]
        if not ws:
            continue
        units = []
        for w in ws:
            dur_u = len(w["key"]) + 1.5
            pause_u = 4.0 if w["w"][-1] in ".!?" else 2.5 if w["w"][-1] in ",;:—-" else 0.0
            units.append((dur_u, pause_u))
        total_u = sum(d + p for d, p in units) - units[-1][1]
        span = b["speech_end"] - b["speech_start"]
        t = b["speech_start"]
        for w, (d, p) in zip(ws, units):
            w["start"] = t
            t += span * d / total_u
            w["end"] = t
            t += span * p / total_u


def whisper_word_times(wav: Path, model_size: str, prompt: str) -> list[tuple[str, float, float]]:
    from faster_whisper import WhisperModel  # CTranslate2 is CUDA-only, so CPU int8 on AMD systems
    model = WhisperModel(model_size, device="cpu", compute_type="int8")
    segments, _ = model.transcribe(str(wav), language="en", word_timestamps=True, beam_size=5,
                                   vad_filter=False, initial_prompt=prompt[:800])
    words = [(w.word.strip(), float(w.start), float(w.end)) for s in segments for w in (s.words or [])]
    del model
    gc.collect()
    return words


def align_to_script(words: list[dict], heard: list[tuple[str, float, float]], beats: list) -> int:
    """Copy whisper timings onto script words via sequence alignment; interpolate the rest."""
    a = [w["key"] for w in words]
    b = [norm(h[0]) for h in heard]
    sm = difflib.SequenceMatcher(None, a, b, autojunk=False)
    matched = 0
    for blk in sm.get_matching_blocks():
        for k in range(blk.size):
            w, h = words[blk.a + k], heard[blk.b + k]
            bt = beats[w["beat"]]
            if bt["speech_start"] - 0.5 <= h[1] <= bt["speech_end"] + 0.5:
                w["start"], w["end"] = h[1], max(h[2], h[1] + 0.05)
                matched += 1
    # interpolate unmatched runs between anchors (clamped to the beat's speech span)
    i = 0
    while i < len(words):
        if words[i]["start"] is not None:
            i += 1
            continue
        j = i
        while j < len(words) and words[j]["start"] is None:
            j += 1
        run = words[i:j]
        left = beats[run[0]["beat"]]["speech_start"]
        if i > 0 and words[i - 1]["beat"] == run[0]["beat"]:
            left = max(left, words[i - 1]["end"])
        right = beats[run[-1]["beat"]]["speech_end"]
        if j < len(words) and words[j]["beat"] == run[-1]["beat"]:
            right = min(right, words[j]["start"])
        if right <= left + 0.05 * len(run):
            right = left + 0.22 * len(run)
        wts = [len(w["key"]) + 1.5 for w in run]
        t, tot = left, sum(wts)
        for w, wt in zip(run, wts):
            w["start"] = t
            t += (right - left) * wt / tot
            w["end"] = t
        i = j
    return matched


# =================================================================== ASS captions
def ass_color(hex_rgb: str, alpha: int = 0) -> str:
    h = hex_rgb.lstrip("#")
    r, g, b = h[0:2], h[2:4], h[4:6]
    return f"&H{alpha:02X}{b}{g}{r}".upper()


def ass_time(t: float) -> str:
    t = max(0.0, t)
    cs = int(round(t * 100))
    h, cs = divmod(cs, 360000)
    m, cs = divmod(cs, 6000)
    s, cs = divmod(cs, 100)
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


def ass_escape(s: str) -> str:
    return s.replace("\\", "\\\\").replace("{", "(").replace("}", ")")


def build_chunks(words: list[dict], cap: dict) -> list[list[dict]]:
    chunks, cur = [], []
    for w in words:
        if cur:
            chars = sum(len(x["w"]) + 1 for x in cur) + len(w["w"])
            prev = cur[-1]
            if (len(cur) >= cap["max_words"] or chars > cap["max_chars"] or w["beat"] != prev["beat"]
                    or prev["w"][-1] in ".!?,;:" or w["start"] - prev["end"] > 0.4):
                chunks.append(cur)
                cur = []
        cur.append(w)
    if cur:
        chunks.append(cur)
    return chunks


def write_ass(path: Path, words: list[dict], cap: dict, total: float) -> int:
    upper = cap.get("uppercase", True)
    style = (f"Style: Caption,{cap['font']},{cap['size']},{ass_color(cap['color'])},{ass_color(cap['highlight'])},"
             f"{ass_color(cap['outline'])},{ass_color('#000000', 0x40)},-1,0,0,0,100,100,1,0,1,"
             f"{cap['outline_px']},{cap['shadow_px']},2,90,90,{cap['margin_v']},1")
    lines = [
        "[Script Info]", "ScriptType: v4.00+", f"PlayResX: {OUT_W}", f"PlayResY: {OUT_H}",
        "WrapStyle: 0", "ScaledBorderAndShadow: yes", "YCbCr Matrix: TV.709", "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, "
        "Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, "
        "MarginR, MarginV, Encoding",
        style, "", "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]
    hi = ass_color(cap["highlight"])[4:]  # &HBBGGRR form for inline \c
    chunks = build_chunks(words, cap)
    n_events = 0
    for ci, ch in enumerate(chunks):
        c_start = ch[0]["start"]
        nxt = chunks[ci + 1][0]["start"] if ci + 1 < len(chunks) else total
        c_end = nxt if nxt - ch[-1]["end"] < 0.35 else ch[-1]["end"] + 0.2
        c_end = min(c_end, total)
        for wi, w in enumerate(ch):
            s = c_start if wi == 0 else w["start"]
            e = c_end if wi == len(ch) - 1 else ch[wi + 1]["start"]
            if e - s < 0.02:
                continue
            parts = []
            for k, x in enumerate(ch):
                txt = ass_escape(x["w"].upper() if upper else x["w"])
                parts.append(f"{{\\c&H{hi}&}}{txt}{{\\r}}" if k == wi else txt)
            pop = "{\\fscx112\\fscy112\\t(0,90,\\fscx100\\fscy100)}" if wi == 0 else ""
            lines.append(f"Dialogue: 0,{ass_time(s)},{ass_time(e)},Caption,,0,0,0,,{pop}{' '.join(parts)}")
            n_events += 1
    path.write_text("\n".join(lines) + "\n", encoding="utf-8-sig")
    return n_events


# =================================================================== main stage
def run_stage(episode: Path, force: bool = False, out_dir: Path | None = None, overrides: dict | None = None) -> dict:
    """out_dir/overrides are used by --preview-only to write an estimated (silent) timeline elsewhere."""
    episode = episode.resolve()
    script_path = episode / "script.json"
    script = read_json(script_path)
    channel = load_channel(find_channel(episode))
    cfg = merged_config(script, channel, overrides)
    if channel:
        log(f"channel: {channel.get('name', channel['slug'])}  voice: {cfg['voice'].get('kokoro_voice')}")
    build = out_dir or (episode / "build")
    cache_dir = build / "tts_cache"
    cache_dir.mkdir(parents=True, exist_ok=True)
    beats_in = script["beats"]
    timing = cfg["timing"]

    # ---- 1. narration per beat (cached by text + voice settings)
    tts = TTS(cfg, Path(tempfile.mkdtemp()))
    clips = []
    for b in beats_in:
        key = hashlib.sha1(json.dumps([b["text"], cfg["voice"], cfg["tts_engines"]], sort_keys=True).encode()).hexdigest()[:16]
        wav = cache_dir / f"{b['id']}_{key}.wav"
        meta = wav.with_suffix(".json")
        if force or not wav.exists() or not meta.exists():
            raw = cache_dir / f"_raw_{b['id']}.wav"
            eng = tts.synth(b["text"], raw)
            audio = trim_silence(load_audio(raw), SAMPLE_RATE)
            write_wav(wav, audio)
            write_json(meta, {"engine": eng})
            raw.unlink(missing_ok=True)
        else:
            eng = read_json(meta)["engine"]
            tts.engine_used.add(eng)
        audio = load_audio(wav)
        clips.append((b, audio, eng))
        log(f"beat '{b['id']}': {len(audio) / SAMPLE_RATE:.2f}s via {eng}")
    tts.close()

    # ---- 2. timeline: the simulation paces itself to these numbers
    beats, t = [], 0.0
    speech_t = float(timing["lead_in"])
    for i, (b, audio, eng) in enumerate(clips):
        dur = len(audio) / SAMPLE_RATE
        start = 0.0 if i == 0 else t
        s_start = speech_t if i == 0 else t
        s_end = s_start + dur
        end = max(s_end + float(b.get("pause_after", timing["gap"])), start + float(b.get("min_duration", 0)))
        beats.append({"id": b["id"], "cue": b.get("cue", ""), "text": b["text"], "start": round(start, 4),
                      "end": round(end, 4), "speech_start": round(s_start, 4), "speech_end": round(s_end, 4)})
        t = end
    total = round(beats[-1]["speech_end"] + float(timing["tail"]), 4)
    beats[-1]["end"] = total

    # ---- 3. assemble narration.wav (48 kHz mono, peak-normalized to -1 dBFS)
    narr = np.zeros(int(np.ceil(total * SAMPLE_RATE)), dtype=np.float32)
    for (b, audio, eng), bt in zip(clips, beats):
        i0 = int(round(bt["speech_start"] * SAMPLE_RATE))
        narr[i0:i0 + len(audio)] += audio[: max(0, len(narr) - i0)]
    peak = float(np.max(np.abs(narr))) if narr.size else 0
    if peak > 0:
        narr *= db_to_gain(-1.0) / peak
    write_wav(build / "narration.wav", narr)

    # ---- 4. word timings -> captions
    cap = cfg["captions"]
    words = script_words(beats)
    method = "estimated"
    silent = tts.engine_used == {"silent"}
    if cap.get("use_whisper", True) and not silent:
        try:
            log(f"faster-whisper ({cap['whisper_model']}, int8, CPU) transcribing narration...")
            heard = whisper_word_times(build / "narration.wav", cap["whisper_model"], " ".join(b["text"] for b in beats))
            matched = align_to_script(words, heard, beats)
            method = f"whisper ({matched}/{len(words)} words matched)"
        except ImportError:
            log("faster-whisper not installed — using estimated word timings", "warn")
        except Exception as e:
            log(f"faster-whisper failed ({e}) — using estimated word timings", "warn")
    if method == "estimated" or any(w["start"] is None for w in words):
        for w in words:
            w["start"] = w["end"] = None
        estimate_word_times(words, beats)
        method = "estimated"
    n_ev = write_ass(build / "captions.ass", words, cap, total) if cap.get("enabled", True) else 0

    # ---- 5. timeline files
    timeline = {
        "title": script.get("title", episode.name), "channel": channel.get("slug") if channel else None, "fps": 60, "total": total, "crt": bool(cfg.get("crt", True)),
        "tts_engines_used": sorted(tts.engine_used), "caption_timing": method,
        "beats": beats,
        "words": [{"w": w["w"], "beat": beats[w["beat"]]["id"], "start": round(w["start"], 3), "end": round(w["end"], 3)} for w in words],
    }
    write_json(build / "timeline.json", timeline)
    (build / "timeline.js").write_text("window.EPISODE_TIMELINE = " + json.dumps(timeline, ensure_ascii=False) + ";\n", encoding="utf-8")

    n_words = len(words)
    log(f"timeline: {total:.2f}s, {len(beats)} beats, {n_words} words, captions {method}, {n_ev} caption events", "ok")
    if not 30 <= total <= 55:
        log(f"Episode runs {total:.1f}s — the target is 30–55s. Adjust narration length or min_duration.", "warn")
    if not 90 <= n_words <= 130:
        log(f"Narration is {n_words} words — the blueprint recommends 90–130.", "warn")
    return timeline


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--episode", required=True, type=Path)
    ap.add_argument("--force", action="store_true", help="re-synthesize all narration (ignore cache)")
    args = ap.parse_args()
    run_stage(args.episode, args.force)


if __name__ == "__main__":
    main()
