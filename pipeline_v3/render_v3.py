"""render_v3.py — Visual-First (zero-TTS) orchestrator: script.json + simulation.js -> 1080x1920 60fps MP4.

    python pipeline_v3/render_v3.py --episode episodes_v3/<ep> --preview-only     # QA pass (silent)
    python pipeline_v3/render_v3.py --episode episodes_v3/<ep>                    # full render

No TTS, no Whisper, no .ass captions. Stages:
  T  timeline.js / timeline.json straight from script.json beat times (+ optional groove block)
  B  headless Chromium (--use-gl=angle) steps engine_v3/sim_base_v3.html frame by frame -> raw RGBA ->
     FFmpeg lossless 270x480 intermediate; exports build/audio_log_v3.json (events, synth, pulses)
  C  pipeline_v3/synth_v3.py -> build/mix_v3.wav (frame-locked chiptune + foley, limiter, no ducking)
  E  4x nearest-neighbor upscale + CRT scanlines, two-pass loudnorm (-14 LUFS, -1 dBTP) -> H.264 yuv420p MP4

--preview-only writes <episode>/qa/qa_hook.png, qa_mid1.png, qa_mid2.png, qa_payoff.png (+ qa_sheet.png and a silent
preview.mp4) with safe-zone guides, for visual inspection before the full render.

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
          "groove": script.get("groove"), "mix": script.get("mix"), "beats": beats, "words": []}
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
    if not args.force and not args.max_seconds and not is_stale([frames_out, log_out], deps):
        if read_json(log_out).get("total_frames") == n_frames:
            log("B  frames up to date (cached)", "step")
            return n_frames, total
    log(f"B  rendering {n_frames} frames ({total:.2f}s @ {FPS} fps){' with QA guides' if qa else ''}", "step")
    enc = subprocess.Popen([which_ffmpeg(), "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", f"{LOW_W}x{LOW_H}",
                            "-r", str(FPS), "-i", "-", "-c:v", "libx264rgb", "-preset", "ultrafast", "-qp", "0",
                            "-pix_fmt", "rgb24", str(frames_out)], stdin=subprocess.PIPE, stderr=subprocess.PIPE)
    errors: list[str] = []
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
            enc.stdin.write(base64.b64decode(b64))
            done += k
            pct = done * 100 // n_frames
            if pct // 10 != last // 10:
                log(f"   frame {done}/{n_frames}  ({pct}%, {done / max(time.time() - t0, 1e-6):.0f} fps)")
                last = pct
        audio = page.evaluate("window.getAudioLogV3()")
        browser.close()
    enc.stdin.close()
    if enc.wait() != 0:
        sys.exit("FFmpeg frame encoder failed:\n" + enc.stderr.read().decode("utf-8", "replace")[-2000:])
    audio["events"] = [e for e in audio["events"] if e["frame"] < n_frames]
    audio["pulses"] = [p for p in audio["pulses"] if p["frame"] < n_frames]
    audio.update({"total_frames": n_frames, "duration": total})
    write_json(log_out, audio)
    log(f"frames done in {time.time() - t0:.1f}s · {len(audio['events'])} hits, {len(audio['pulses'])} pulses, "
        f"{len(audio['synth'])} continuous voices", "ok")
    return n_frames, total


# ------------------------------------------------------------------ C: audio
def stage_c(job: Job, tl: dict, total: float):
    import synth_v3
    log("C  synthesizing mix_v3.wav (frame-locked chiptune + foley, no voice)", "step")
    data = read_json(job.build / "audio_log_v3.json")
    info = synth_v3.synthesize_v3(data, total, job.build / "mix_v3.wav", groove=tl.get("groove"),
                                  channel_dir=job.channel_dir, mix=tl.get("mix"))
    log(f"mix_v3.wav: {info['events']} hits, {info['pulses']} pulses, {info['groove_steps']} groove steps, "
        f"{info['voices']} voices, peak {info['peak_db']:.1f} dBFS", "ok")


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


def loudnorm_filter(wav: Path) -> str:
    """Two-pass loudnorm: measure, then apply a linear (transparent) gain to -14 LUFS / -1 dBTP."""
    p = subprocess.run([which_ffmpeg(), "-hide_banner", "-nostats", "-i", str(wav), "-af",
                        "loudnorm=I=-14:TP=-1.0:LRA=11:print_format=json", "-f", "null", "-"],
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    txt = p.stderr.decode("utf-8", "replace")
    try:
        m = json.loads(txt[txt.rindex("{"): txt.rindex("}") + 1])
        log(f"loudness: measured {m['input_i']} LUFS, true peak {m['input_tp']} dBTP -> -14 LUFS")
        return ("loudnorm=I=-14:TP=-1.0:LRA=11:linear=true:"
                f"measured_I={m['input_i']}:measured_TP={m['input_tp']}:measured_LRA={m['input_lra']}:"
                f"measured_thresh={m['input_thresh']}:offset={m['target_offset']}")
    except Exception:
        log("loudness measurement failed — using single-pass loudnorm", "warn")
        return "loudnorm=I=-14:TP=-1.0:LRA=11"


def stage_e(job: Job, tl: dict, total: float) -> Path:
    args, b, ep = job.args, job.build, job.ep
    out_dir = ep / "output"
    out_dir.mkdir(exist_ok=True)
    out = out_dir / (f"{ep.name}_preview.mp4" if args.max_seconds else f"{ep.name}.mp4")
    crt = bool(tl.get("crt", True)) and not args.no_crt
    log(f"E  encode: 4x upscale{' + CRT' if crt else ''} + mix_v3.wav -> {job.encoder}", "step")
    af = loudnorm_filter(b / "mix_v3.wav") + ",aresample=48000"
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
    return [("qa_hook.png", clamp(hook)), ("qa_mid1.png", clamp(mid1)), ("qa_mid2.png", clamp(mid2)), ("qa_payoff.png", clamp(payoff))]


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
    run([which_ffmpeg(), "-y", "-v", "error", "-i", "frames_lowres.mkv", "-filter_complex", video_chain(False, (540, 960)),
         "-map", "[vout]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-an", str(qa / "preview.mp4")], cwd=work)
    log(f"QA ready: {qa}  (qa_hook / qa_mid1 / qa_mid2 / qa_payoff .png, qa_sheet.png, silent preview.mp4)", "ok")


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
    if "C" in args.steps.upper():
        stage_c(job, tl, total)
    if "E" in args.steps.upper():
        out = stage_e(job, tl, total)
        log(f"DONE in {time.time() - t0:.1f}s -> {out}", "ok")


if __name__ == "__main__":
    main()
