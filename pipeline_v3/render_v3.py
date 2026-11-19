"""render_v3.py — Visual-First (zero-TTS) orchestrator: script.json + simulation.js -> 1080x1920 60fps MP4.

    python pipeline_v3/render_v3.py --episode episodes_v3/<ep> --preview-only     # QA pass
    python pipeline_v3/render_v3.py --episode episodes_v3/<ep>                    # full render

No TTS, no Whisper, no .ass captions. Stages:
  T  timeline.js / timeline.json straight from script.json beat times (+ optional groove / audio / sfx_presets)
  B  headless Chromium (--use-gl=angle) steps engine_v3/sim_base_v3.html frame by frame -> raw RGBA ->
     FFmpeg lossless 270x480 intermediate; exports build/audio_log_v3.json + safe_zone_report.json
  C  pipeline_v3/synth_v3.py -> build/mix_v3.wav (clean-envelope chiptune + foley through the master chain),
     then mastering: one clean gain to the target loudness (script audio.lufs, default -14) + -1 dBFS limiter;
     audio_report.json: per-phase peak/RMS, clipped samples, silent-gap noise floor (must be <= -60 dBFS)
  E  4x nearest-neighbor upscale + CRT scanlines -> H.264 yuv420p MP4 (+ silent-gap check on the MP4 audio)

--preview-only writes <episode>/qa/: qa_phase1..4.png (aliases qa_hook/mid1/mid2/payoff.png), qa_sheet.png,
preview.mp4 (540x960 with audio), audio_report.json and safe_zone_report.json. QA FAILS (exit code 2) if any text
box, box, tag, micro-text or R.node() leaves the UI-safe box (x 90..920, y 260..1480 on 1080x1920), if any text has
more than 4 words, if bright text sits unchanged for more than 5 s, or if the pacing analyser finds dead air
(> 1.2 s without a visual micro-event) or an empty void (> 1.2 s with < 8% of the safe box showing content). Offenders are outlined in magenta on the QA
images; the faint magenta safe-zone border appears only in QA renders.

Episodes may live in episodes_v3/ or inside a channel (channels/<slug>/episodes/<ep>) — then that channel's
theme.js / sfx_presets.js / channel.json (crt, encoder) apply, and nothing from any other channel.
Flags: --steps TBCE, --force, --max-seconds N, --encoder x264|amf, --no-crt, --qa-times 3.5,12, --browser-path
"""
from __future__ import annotations

import argparse
import base64
import json
import math
import re
import shutil
import subprocess
import sys
import time
import urllib.parse
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "pipeline"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import (LOW_H, LOW_W, OUT_H, OUT_W, find_channel, is_stale, load_channel, log, read_json,  # noqa: E402
                    run, which_ffmpeg, write_json)

FPS = 60
BATCH = 30
ENGINE_V2, ENGINE_V3 = ROOT / "engine", ROOT / "engine_v3"


class Job:
    def __init__(self, ep: Path, args):
        self.ep, self.args = ep, args
        self.build = ep / "build"
        self.channel_dir = find_channel(ep)
        self.channel = load_channel(self.channel_dir)
        self.slug = self.channel.get("slug")
        self.encoder = args.encoder or self.channel.get("encoder", "x264")
        cd = self.channel_dir
        self.theme = cd / "theme.js" if cd and (cd / "theme.js").exists() else None
        self.sfx = cd / "sfx_presets.js" if cd and (cd / "sfx_presets.js").exists() else None

    def kit_files(self) -> list[Path]:
        return [p for p in (self.theme, self.sfx, self.channel_dir / "channel.json" if self.channel_dir else None) if p]

    def engine_files(self) -> list[Path]:
        return [p for d in (ENGINE_V2, ENGINE_V3) for p in d.glob("*") if p.suffix in (".js", ".html")]


def check_isolation(job: Job):
    sim = (job.ep / "simulation.js").read_text(encoding="utf-8", errors="replace")
    for m in re.finditer(r"channels[/\\]+([A-Za-z0-9_\-]+)", sim):
        if m.group(1) != job.slug:
            sys.exit(f"Isolation check failed: simulation.js references channel '{m.group(1)}'.")


# ------------------------------------------------------------------ T: timeline from script.json
def stage_t(job: Job) -> dict:
    script = read_json(job.ep / "script.json")
    beats, t = [], 0.0
    for b in script["beats"]:
        start = float(b.get("start", t))
        end = float(b["end"]) if "end" in b else start + float(b["dur"])
        if end <= start:
            sys.exit(f"beat '{b['id']}' has end <= start")
        beats.append({"id": b["id"], "start": start, "end": end, "cue": b.get("cue", ""), "text": b.get("micro", "")})
        t = end
    total = float(script.get("duration", beats[-1]["end"]))
    beats[-1]["end"] = max(beats[-1]["end"], total)
    crt = script.get("crt", job.channel.get("crt", True))
    tl = {"version": 3, "title": script.get("title", job.ep.name), "channel": job.slug, "fps": FPS, "total": total,
          "crt": bool(crt), "bpm": (script.get("groove") or {}).get("bpm", script.get("bpm", 120)),
          "groove": script.get("groove"), "mix": script.get("mix"), "audio": script.get("audio"),
          "sfx_presets": script.get("sfx_presets"), "text_rules": script.get("text_rules"), "music": (None if script.get("music") is False or (isinstance(script.get("music"), dict) and script["music"].get("enabled") is False)
                    else (script.get("music") or {})),
          "beats": beats, "words": []}
    job.build.mkdir(parents=True, exist_ok=True)
    tl_json = job.build / "timeline.json"
    if not tl_json.exists() or read_json(tl_json) != tl:      # rewrite only on change, so frame caching works
        write_json(tl_json, tl)
        (job.build / "timeline.js").write_text("window.EPISODE_TIMELINE = " + json.dumps(tl) + ";\n", encoding="utf-8")
    log(f"T  timeline: {total:.2f}s, {len(beats)} beats ({', '.join(b['id'] for b in beats)}), groove "
        f"{'on @ %s bpm' % tl['bpm'] if tl['groove'] else 'off'}", "step")
    if not 25 <= total <= 45:
        log(f"v3 videos work best at 28–38 s (this one is {total:.1f}s)", "warn")
    return tl


# ------------------------------------------------------------------ pacing analyser (anti-dead-air rule)
class Pacing:
    """Per-frame visual activity inside the UI-safe box (low-res x 23..230, y 65..370):
       changed = pixels that changed vs the previous frame (a micro-event: step, burst, tick, pop ...)
       content = share of pixels that are not one of the frame's two dominant colours (background + grid)
    Dead air = > MAX_S seconds with fewer than MIN_CHANGED changed pixels per frame.
    Void     = > MAX_S seconds with less than MIN_CONTENT of the safe box showing anything."""
    MAX_S, MIN_CHANGED, MIN_CONTENT = 1.2, 40, 0.08

    def __init__(self):
        self.prev = None
        self.changed: list[int] = []
        self.content: list[float] = []

    def add(self, raw: bytes, k: int):
        fr = np.frombuffer(raw, dtype=np.uint8).reshape(k, LOW_H, LOW_W, 4)[:, 65:370, 23:230, :3]
        for f in fr:
            f16 = f.astype(np.int16)
            self.changed.append(0 if self.prev is None else int((np.abs(f16 - self.prev).max(axis=-1) > 10).sum()))
            self.prev = f16
            sub = f[::2, ::2].reshape(-1, 3).astype(np.uint32)
            packed = (sub[:, 0] << 16) | (sub[:, 1] << 8) | sub[:, 2]
            _, counts = np.unique(packed, return_counts=True)
            top2 = np.sort(counts)[-2:].sum()
            self.content.append(float(1 - top2 / len(packed)))

    @staticmethod
    def _runs(mask: list[bool], min_len: int) -> list[tuple[int, int]]:
        runs, start = [], None
        for i, m in enumerate(mask + [False]):
            if m and start is None:
                start = i
            elif not m and start is not None:
                if i - start > min_len:
                    runs.append((start, i))
                start = None
        return runs

    def report(self) -> dict:
        lim = int(self.MAX_S * FPS)
        dead = self._runs([c < self.MIN_CHANGED for c in self.changed[1:]], lim)
        void = self._runs([c < self.MIN_CONTENT for c in self.content], lim)
        sec = lambda a, b: {"start": round(a / FPS, 2), "end": round(b / FPS, 2), "seconds": round((b - a) / FPS, 2)}  # noqa: E731
        return {"rule": f"no more than {self.MAX_S}s without a visual micro-event or with an empty safe box",
                "dead_air": [sec(a + 1, b + 1) for a, b in dead], "voids": [sec(a, b) for a, b in void],
                "mean_changed_px": round(float(np.mean(self.changed)) if self.changed else 0, 1),
                "mean_content": round(float(np.mean(self.content)) if self.content else 0, 3)}


def pacing_check(work: Path, dest: Path | None = None) -> list:
    rp = work / "pacing_report.json"
    if not rp.exists():
        return []
    rep = read_json(rp)
    if dest:
        write_json(dest, rep)
    bad = [("dead air", d) for d in rep["dead_air"]] + [("empty void", d) for d in rep["voids"]]
    if not bad:
        log(f"pacing OK — no dead air or empty voids > 1.2 s (avg {rep['mean_changed_px']} changed px/frame, "
            f"{100 * rep['mean_content']:.0f}% of the safe box has content)", "ok")
    for kind, d in bad:
        log(f"   {kind}: {d['start']:.2f}s - {d['end']:.2f}s ({d['seconds']:.2f}s) — add a micro-event or tighten the timing", "warn")
    return bad


# ------------------------------------------------------------------ B: frames
def launch_browser(pw, browser_path):
    args = ["--use-gl=angle", "--use-angle=default", "--enable-gpu-rasterization", "--ignore-gpu-blocklist",
            "--allow-file-access-from-files", "--disable-background-timer-throttling",
            "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"]
    attempts = ([{"executable_path": browser_path}] if browser_path else []) + [{}, {"channel": "chrome"}, {"channel": "msedge"}]
    errs = []
    for kw in attempts:
        try:
            b = pw.chromium.launch(headless=True, args=args, **kw)
            log(f"browser: {kw or 'playwright chromium'} ({b.version})")
            return b
        except Exception as e:
            errs.append(f"{kw or 'bundled'}: {str(e).splitlines()[0]}")
    raise RuntimeError("Could not launch Chromium (python -m playwright install chromium, or --browser-path).\n  " + "\n  ".join(errs))


def page_url(job: Job, timeline_js: Path, qa: bool) -> str:
    def rel(p: Path) -> str:
        r = Path(*([".."] + list(p.resolve().relative_to(ROOT).parts))).as_posix()
        return urllib.parse.quote(r, safe="/._-")
    q = f"?render=1&sim={rel(job.ep / 'simulation.js')}&timeline={rel(timeline_js)}"
    if job.theme:
        q += f"&theme={rel(job.theme)}"
    if job.sfx:
        q += f"&sfx={rel(job.sfx)}"
    if qa:
        q += "&qa=3"
    return (ENGINE_V3 / "sim_base_v3.html").as_uri() + q


def stage_b(job: Job, tl: dict, work: Path, qa: bool = False) -> tuple[int, float]:
    from playwright.sync_api import sync_playwright
    args = job.args
    work.mkdir(parents=True, exist_ok=True)
    frames_out, log_out = work / "frames_lowres.mkv", work / "audio_log_v3.json"
    total = min(float(tl["total"]), args.max_seconds or 1e9)
    n_frames = int(math.ceil(total * FPS))
    deps = [job.ep / "simulation.js", job.build / "timeline.json"] + job.kit_files() + job.engine_files()
    if not args.force and not args.max_seconds and not qa and not is_stale([frames_out, log_out, work / "safe_zone_report.json", work / "pacing_report.json"], deps):
        if read_json(log_out).get("total_frames") == n_frames:
            log("B  frames up to date (cached)", "step")
            return n_frames, total
    log(f"B  rendering {n_frames} frames ({total:.2f}s @ {FPS} fps){' with QA guides' if qa else ''}", "step")
    enc = subprocess.Popen([which_ffmpeg(), "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", f"{LOW_W}x{LOW_H}",
                            "-r", str(FPS), "-i", "-", "-c:v", "libx264rgb", "-preset", "ultrafast", "-qp", "0",
                            "-pix_fmt", "rgb24", str(frames_out)], stdin=subprocess.PIPE, stderr=subprocess.PIPE)
    errors: list[str] = []
    pacing = Pacing()
    t0 = time.time()
    with sync_playwright() as pw:
        browser = launch_browser(pw, args.browser_path)
        page = browser.new_page(viewport={"width": 540, "height": 960})
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: m.type in ("error", "warning") and log(f"[browser {m.type}] {m.text}", "warn"))
        page.goto(page_url(job, job.build / "timeline.js", qa))
        page.wait_for_function("window.__simReady === true || !!window.__simError", timeout=30000)
        err = page.evaluate("window.__simError || null")
        if err or errors:
            enc.kill(); sys.exit(f"Simulation failed to load: {err or errors[0]}")
        if not page.evaluate("typeof window.getAudioLogV3 === 'function'"):
            enc.kill(); sys.exit("engine_v3 audio logger not loaded")
        done, last = 0, -1
        while done < n_frames:
            k = min(BATCH, n_frames - done)
            b64 = page.evaluate("n => window.renderBatch(n)", k)
            if errors:
                enc.kill(); sys.exit(f"Simulation error at frame ~{done}: {errors[0]}")
            raw = base64.b64decode(b64)
            enc.stdin.write(raw)
            pacing.add(raw, k)
            done += k
            pct = done * 100 // n_frames
            if pct // 10 != last // 10:
                log(f"   frame {done}/{n_frames}  ({pct}%, {done / max(time.time() - t0, 1e-6):.0f} fps)")
                last = pct
        audio = page.evaluate("window.getAudioLogV3()")
        safety = page.evaluate("window.getSafeZoneReportV3 ? window.getSafeZoneReportV3() : null")
        browser.close()
    enc.stdin.close()
    if enc.wait() != 0:
        sys.exit("FFmpeg frame encoder failed:\n" + enc.stderr.read().decode("utf-8", "replace")[-2000:])
    audio["events"] = [e for e in audio["events"] if e["frame"] < n_frames]
    audio["pulses"] = [p for p in audio["pulses"] if p["frame"] < n_frames]
    audio.update({"total_frames": n_frames, "duration": total})
    write_json(log_out, audio)
    if safety is not None:
        write_json(work / "safe_zone_report.json", safety)
    write_json(work / "pacing_report.json", pacing.report())
    log(f"frames done in {time.time() - t0:.1f}s · {len(audio['events'])} hits, {len(audio['pulses'])} pulses, "
        f"{len(audio['synth'])} continuous voices", "ok")
    return n_frames, total


# ------------------------------------------------------------------ C: audio
def stage_c(job: Job, tl: dict, total: float, work: Path | None = None):
    import synth_v3
    work = work or job.build
    log("C  synthesizing mix_v3.wav (frame-locked chiptune + foley, no voice)", "step")
    data = read_json(work / "audio_log_v3.json")
    info = synth_v3.synthesize_v3(data, total, work / "mix_v3.wav", groove=tl.get("groove"),
                                  channel_dir=job.channel_dir, mix=tl.get("mix"), audio=tl.get("audio"),
                                  episode_presets=tl.get("sfx_presets"), music=tl.get("music"))
    log(f"mix_v3.wav: {info['events']} hits, {info['pulses']} pulses, {info['groove_steps']} groove steps, "
        f"{info['voices']} voices, highest note {info['max_note_hz']} Hz, peak {info['peak_db']:.1f} dBFS"
        + (f", music bed {info['music_notes']} notes @ {info.get('bpm')} bpm (slow-mo {100 * info.get('slowmo_share', 0):.0f}% of the time)"
           if info.get("music_notes") else ", no music bed"), "ok")
    master_loudness(work / "mix_v3.wav", target=float((tl.get("audio") or {}).get("lufs", -14.0)))


def gap_floor(x: np.ndarray, act_path: Path, sr: int = 48000, guard: float = 0.03, win: float = 0.02) -> dict:
    """Noise floor in the silent gaps between sounds: max RMS over 20 ms windows that lie entirely outside every
    sound's audible span (+30 ms guard). Must be <= -60 dBFS."""
    if not act_path.exists():
        return {"gap_floor_dbfs": None}
    act = read_json(act_path)
    busy = np.zeros(len(x) + 1, dtype=np.int32)
    for a, b in act["intervals"]:
        a = max(0, a - int(0.002 * sr)); b = min(len(x), b + int(guard * sr))
        busy[a] += 1; busy[b] -= 1
    busy = np.cumsum(busy)[: len(x)] > 0
    w = int(win * sr)
    nwin = len(x) // w
    xs = x[: nwin * w].reshape(nwin, w, -1).astype(np.float64)
    bw = busy[: nwin * w].reshape(nwin, w).any(axis=1)
    quiet = ~bw
    if not quiet.any():
        return {"gap_floor_dbfs": None, "gap_seconds": 0.0}
    rms = np.sqrt((xs[quiet] ** 2).mean(axis=(1, 2)))
    worst = float(rms.max())
    return {"gap_floor_dbfs": round(20 * math.log10(max(worst, 1e-12)), 1), "gap_seconds": round(quiet.sum() * win, 2),
            "dropped_triggers": act.get("dropped_triggers", 0)}


def audio_report(wav: Path, tl: dict, dest: Path, mp4: Path | None = None) -> dict:
    """Per-phase peak / RMS, clipped samples, and the noise floor in silent gaps (wav and, if given, the final MP4)."""
    from common import load_audio
    x = load_audio(wav, channels=2)
    sr = 48000
    rows, clipped_total = [], 0
    for b in tl["beats"]:
        seg = x[int(b["start"] * sr): int(b["end"] * sr)]
        if not len(seg):
            continue
        peak = float(np.max(np.abs(seg)))
        rms = float(np.sqrt(np.mean(seg.astype(np.float64) ** 2)))
        clipped = int(np.sum(np.abs(seg) >= 0.999))
        clipped_total += clipped
        rows.append({"beat": b["id"], "start": b["start"], "end": b["end"],
                     "peak_dbfs": round(20 * math.log10(max(peak, 1e-9)), 2),
                     "rms_dbfs": round(20 * math.log10(max(rms, 1e-9)), 2), "clipped_samples": clipped})
    rms_vals = [r["rms_dbfs"] for r in rows if r["rms_dbfs"] > -80]
    rep = {"phases": rows, "clipped_samples": clipped_total,
           "rms_spread_db": round(max(rms_vals) - min(rms_vals), 2) if rms_vals else None}
    stem = wav.with_name(wav.stem + "_sfxstem.wav")
    music_on = tl.get("music") is not None
    if music_on and stem.exists():
        # with a music bed there are no silent gaps by design: check the SFX stem for crackle/hiss between hits
        rep["sfx_stem_gaps"] = gap_floor(load_audio(stem, channels=2), wav.with_suffix(".activity.json"))
        rep["music_bed"] = True
    else:
        rep["wav_gaps"] = gap_floor(x, wav.with_suffix(".activity.json"))
        if mp4 is not None and mp4.exists():
            rep["mp4_gaps"] = gap_floor(load_audio(mp4, channels=2), wav.with_suffix(".activity.json"))
    write_json(dest, rep)
    log("audio per phase:            peak dBFS   RMS dBFS   clipped")
    for r in rows:
        log(f"   {r['beat']:20s}  {r['peak_dbfs']:8.1f}  {r['rms_dbfs']:9.1f}   {r['clipped_samples']}")
    log(f"audio: {'NO clipping' if clipped_total == 0 else str(clipped_total) + ' CLIPPED samples'}, "
        f"RMS spread across phases {rep['rms_spread_db']} dB", "ok" if clipped_total == 0 else "warn")
    for k in ("wav_gaps", "mp4_gaps", "sfx_stem_gaps"):
        g = rep.get(k)
        if g and g.get("gap_floor_dbfs") is not None:
            ok = g["gap_floor_dbfs"] <= -60
            log(f"{k[:-5].upper().replace('_', ' ')} silent gaps: noise floor {g['gap_floor_dbfs']} dBFS over {g['gap_seconds']} s of gaps "
                f"({'OK <= -60 dBFS' if ok else 'TOO NOISY'}), {g.get('dropped_triggers', 0)} triggers dropped by 75 ms spacing",
                "ok" if ok else "warn")
    return rep


def measure_lufs(wav: Path) -> float | None:
    p = subprocess.run([which_ffmpeg(), "-hide_banner", "-nostats", "-i", str(wav), "-af", "loudnorm=print_format=json",
                        "-f", "null", "-"], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    txt = p.stderr.decode("utf-8", "replace")
    try:
        return float(json.loads(txt[txt.rindex("{"): txt.rindex("}") + 1])["input_i"])
    except Exception:
        return None


def master_loudness(wav: Path, target: float = -14.0):
    """Mastering: one clean gain to the target loudness, then the lookahead limiter holds peaks at -1 dBFS.
    (The 0.16 voice / 0.75 master chain is intentionally quiet; this restores platform loudness without
    FFmpeg's dynamic loudnorm mode, which can pump.)"""
    import synth_v3
    from common import load_audio, write_wav
    for _ in range(3):                                   # extra passes correct the small drop caused by limiting
        lufs = measure_lufs(wav)
        if lufs is None or lufs < -70:
            log("loudness measurement failed / silent mix — skipping mastering", "warn")
            return
        gain_db = max(-20.0, min(30.0, target - lufs))
        if abs(gain_db) < 0.3:
            break
        x = load_audio(wav, channels=2) * (10 ** (gain_db / 20))
        write_wav(wav, synth_v3.lookahead_limit(x.astype(np.float32), ceiling_db=-1.0))
        log(f"mastering: {lufs:.1f} LUFS {gain_db:+.1f} dB -> limiter (-1 dBFS ceiling)")
    log(f"mastered to {measure_lufs(wav):.1f} LUFS (target {target:.0f})", "ok")


# ------------------------------------------------------------------ E: encode
def make_scanlines(path: Path, alpha: float = 0.22):
    img = np.zeros((OUT_H, OUT_W, 4), dtype=np.uint8)
    img[3::4, :, 3] = int(alpha * 255)
    run([which_ffmpeg(), "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", f"{OUT_W}x{OUT_H}",
         "-i", "-", "-frames:v", "1", str(path)], input_bytes=img.tobytes())


def video_chain(crt: bool, size=(OUT_W, OUT_H)) -> str:
    fc = f"[0:v]scale={OUT_W}:{OUT_H}:flags=neighbor,format=rgb24[v0]"
    last = "v0"
    if crt:
        fc += f";[{last}][2:v]overlay=0:0:format=auto[v1]"
        last = "v1"
    if size != (OUT_W, OUT_H):
        fc += f";[{last}]scale={size[0]}:{size[1]}:flags=area[v2]"
        last = "v2"
    return fc + f";[{last}]scale=out_color_matrix=bt709:out_range=tv,format=yuv420p[vout]"


def stage_e(job: Job, tl: dict, total: float) -> Path:
    args, b, ep = job.args, job.build, job.ep
    out_dir = ep / "output"
    out_dir.mkdir(exist_ok=True)
    out = out_dir / (f"{ep.name}_preview.mp4" if args.max_seconds else f"{ep.name}.mp4")
    crt = bool(tl.get("crt", True)) and not args.no_crt
    log(f"E  encode: 4x upscale{' + CRT' if crt else ''} + mix_v3.wav -> {job.encoder}", "step")
    af = "aresample=48000"                     # mix_v3.wav is already mastered to -14 LUFS / -1 dBFS in stage C
    cmd = [which_ffmpeg(), "-y", "-v", "error", "-stats", "-i", "frames_lowres.mkv", "-i", "mix_v3.wav"]
    if crt:
        make_scanlines(b / "scanlines.png")
        cmd += ["-i", "scanlines.png"]
    cmd += ["-filter_complex", video_chain(crt) + f";[1:a]{af}[aout]", "-map", "[vout]", "-map", "[aout]",
            "-r", str(FPS), "-t", f"{total:.3f}"]
    if job.encoder == "amf":
        cmd += ["-c:v", "h264_amf", "-quality", "quality", "-rc", "cqp", "-qp_i", "16", "-qp_p", "18", "-qp_b", "20"]
    else:
        cmd += ["-c:v", "libx264", "-preset", "slow", "-crf", "17", "-tune", "animation", "-profile:v", "high"]
    cmd += ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
            "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", str(out)]
    run(cmd, cwd=b)
    run([which_ffmpeg(), "-y", "-v", "error", "-ss", f"{min(1.5, total / 2):.2f}", "-i", str(out), "-frames:v", "1",
         str(out_dir / f"{ep.name}_thumb.png")])
    if job.channel_dir and not args.max_seconds:
        ex = job.channel_dir / "exports"
        ex.mkdir(exist_ok=True)
        shutil.copy2(out, ex / out.name)
        log(f"copied to {ex / out.name}")
    return out


# ------------------------------------------------------------------ safe-zone check
def safe_zone_check(work: Path, dest: Path | None = None) -> list[dict]:
    """Read the per-render safe-zone report; print violations. Returns the violation list."""
    rp = work / "safe_zone_report.json"
    if not rp.exists():
        return []
    rep = read_json(rp)
    if dest:
        write_json(dest, rep)
    v = rep.get("violations", [])
    sp = rep.get("safe_px", {})
    if not v:
        log(f"safe zone OK — every text box / node stayed inside x {sp.get('left')}..{sp.get('right')}, "
            f"y {sp.get('top')}..{sp.get('bottom')}", "ok")
    else:
        log(f"{len(v)} layout/text rule violation(s) (safe box x {sp.get('left')}..{sp.get('right')}, y {sp.get('top')}..{sp.get('bottom')}; "
            f"text <= 4 words, no bright static text > 5 s):", "warn")
        for e in v[:14]:
            a = e.get("at") or {}
            if e["kind"] in ("words", "static"):
                log(f"   {e['kind']:6s} '{e['label']}'  rule: {e.get('rule')} (first at t={a.get('t')}s)", "warn")
            else:
                log(f"   {e['kind']:6s} '{e['label']}'  over by {e['maxOverflowPx']}px at t={a.get('t')}s "
                    f"(box x={a.get('x')} y={a.get('y')} w={a.get('w')} h={a.get('h')}), {e['frames']} frames", "warn")
    return v


# ------------------------------------------------------------------ preview-only QA
def qa_times(tl: dict, total: float) -> list[tuple[str, float]]:
    beats = tl["beats"]
    at = lambda b, k: b["start"] + k * (b["end"] - b["start"])  # noqa: E731
    hook = min(at(beats[0], 0.6), beats[0]["start"] + 2.5)
    if len(beats) >= 4:
        mid1, mid2 = at(beats[1], 0.6), at(beats[2], 0.6)
    elif len(beats) == 3:
        mid1, mid2 = at(beats[1], 0.35), at(beats[1], 0.75)
    else:
        mid1, mid2 = total * 0.35, total * 0.65
    payoff = max(at(beats[-1], 0.5), total - 0.9)
    clamp = lambda t: max(0.0, min(t, total - 1 / FPS))  # noqa: E731
    return [("qa_phase1.png", clamp(hook)), ("qa_phase2.png", clamp(mid1)), ("qa_phase3.png", clamp(mid2)), ("qa_phase4.png", clamp(payoff))]


def preview_only(job: Job, tl: dict):
    work = job.build / "preview"
    _, total = stage_b(job, tl, work, qa=True)
    qa = job.ep / "qa"
    qa.mkdir(exist_ok=True)
    for old in qa.glob("qa_*.png"):
        old.unlink()
    shots = qa_times(tl, total)
    for j, t in enumerate(float(x) for x in (job.args.qa_times or "").split(",") if x.strip()):
        shots.append((f"qa_extra{j + 1}.png", min(t, total - 1 / FPS)))
    for old in qa.glob("qa_*.png"):
        old.unlink()
    for name, t in shots:
        run([which_ffmpeg(), "-y", "-v", "error", "-i", "frames_lowres.mkv", "-ss", f"{t:.3f}", "-frames:v", "1",
             "-vf", f"scale={OUT_W}:{OUT_H}:flags=neighbor", str(qa / name)], cwd=work)
        log(f"   {name:16s} t={t:.2f}s")
    main4 = [qa / n for n, _ in shots[:4]]
    cmd = [which_ffmpeg(), "-y", "-v", "error"]
    for p in main4:
        cmd += ["-i", str(p)]
    fc = "".join(f"[{i}:v]scale=360:640:flags=area[s{i}];" for i in range(4)) + "[s0][s1][s2][s3]hstack=inputs=4"
    run(cmd + ["-filter_complex", fc, str(qa / "qa_sheet.png")])
    for src, alias in (("qa_phase1.png", "qa_hook.png"), ("qa_phase2.png", "qa_mid1.png"), ("qa_phase3.png", "qa_mid2.png"), ("qa_phase4.png", "qa_payoff.png")):
        shutil.copy2(qa / src, qa / alias)          # blueprint names kept as aliases
    # QA audio: synthesize + master the preview mix, report per-phase levels, mux into preview.mp4
    stage_c(job, tl, total, work)
    audio_report(work / "mix_v3.wav", tl, qa / "audio_report.json")
    run([which_ffmpeg(), "-y", "-v", "error", "-i", "frames_lowres.mkv", "-i", "mix_v3.wav", "-filter_complex", video_chain(False, (540, 960)),
         "-map", "[vout]", "-map", "1:a", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-c:a", "aac", "-b:a", "160k",
         "-shortest", str(qa / "preview.mp4")], cwd=work)
    log(f"QA ready: {qa}  (qa_phase1..4.png, qa_sheet.png, audio_report.json, preview.mp4 with audio)", "ok")
    bad = safe_zone_check(work, qa / "safe_zone_report.json")
    bad = bad + pacing_check(work, qa / "pacing_report.json")
    if bad:
        log("QA FAILED — fix the elements above (magenta outlines in the QA PNGs), e.g. with "
            "Camera.track({fit:[x,y,w,h]}) / fitBoundsToSafeZone(), then re-run --preview-only.", "warn")
        sys.exit(2)
    log("QA PASSED", "ok")


# ------------------------------------------------------------------ main
def resolve_episode(p: Path) -> Path:
    for cand in (p if p.is_absolute() else Path.cwd() / p, ROOT / p):
        if (cand / "script.json").exists() and (cand / "simulation.js").exists():
            return cand.resolve()
    sys.exit(f"No script.json + simulation.js found for episode '{p}'")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--episode", required=True, type=Path)
    ap.add_argument("--preview-only", action="store_true")
    ap.add_argument("--steps", default="TBCE")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--max-seconds", type=float, default=None)
    ap.add_argument("--encoder", choices=["x264", "amf"], default=None)
    ap.add_argument("--no-crt", action="store_true")
    ap.add_argument("--qa-times", default=None)
    ap.add_argument("--browser-path", default=None)
    args = ap.parse_args()

    job = Job(resolve_episode(args.episode), args)
    check_isolation(job)
    t0 = time.time()
    log(f"V3 Visual-First · episode: {job.ep.name} · channel: {job.slug or '(none)'} · "
        f"{'QA PREVIEW' if args.preview_only else 'stages ' + args.steps.upper()}", "step")
    tl = stage_t(job) if ("T" in args.steps.upper() or args.preview_only) else read_json(job.build / "timeline.json")
    if args.preview_only:
        preview_only(job, tl)
        log(f"DONE in {time.time() - t0:.1f}s", "ok")
        return
    total = min(float(tl["total"]), args.max_seconds or 1e9)
    if "B" in args.steps.upper():
        _, total = stage_b(job, tl, job.build)
    if "B" in args.steps.upper() and (safe_zone_check(job.build) + pacing_check(job.build)):
        log("layout / pacing violations found in the full render (see above) — run --preview-only to inspect", "warn")
    if "C" in args.steps.upper():
        stage_c(job, tl, total)
        audio_report(job.build / "mix_v3.wav", tl, job.build / "audio_report.json")
    if "E" in args.steps.upper():
        out = stage_e(job, tl, total)
        audio_report(job.build / "mix_v3.wav", tl, job.build / "audio_report.json", mp4=out)
        log(f"DONE in {time.time() - t0:.1f}s -> {out}", "ok")


if __name__ == "__main__":
    main()
