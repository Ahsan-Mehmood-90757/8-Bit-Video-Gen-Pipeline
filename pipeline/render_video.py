"""render_video.py — master orchestrator: script.json + simulation.js -> finished 1080x1920 60fps MP4.

    python pipeline/render_video.py --episode channels/<channel>/episodes/<episode>
    python pipeline/render_video.py --episode channels/<channel>/episodes/<episode> --preview-only

Episodes inside channels/<slug>/ automatically use that channel's kit (theme.js, sfx_presets.js,
voice / caption / mix settings from channel.json) and nothing from any other channel.

Two-pass QA workflow (v2):
  --preview-only   fast SILENT pass: estimated timeline (or the real one if already voiced), frames rendered
                   with safe-zone guides, then <episode>/qa/qa_phase1..N.png (one per beat, full 1080x1920 with
                   captions), qa_sheet.png (all phases side by side) and preview.mp4. Inspect, fix, repeat.
  (default)        full render:
     A  narration WAV + beat timeline + .ass captions          (tts_and_captions.py)
     B  headless Chromium (--use-gl=angle) steps window.renderBatch() -> raw RGBA -> FFmpeg (lossless 270x480)
        + sfx_events.json (discrete events + continuous physics-coupled synth states)
     C  sfx.wav from the event log                              (synth_sfx.py)
     D  voice + SFX mix: SFX -14 dB under 0 dB voice, sidechain ducking, loudnorm -14 LUFS
     E  4x nearest-neighbor upscale + CRT scanlines + burnt-in captions -> H.264 yuv420p MP4,
        copied to channels/<slug>/exports/

Useful flags: --steps BCDE, --force, --max-seconds 8, --encoder amf, --sfx-db -14, --no-crt, --no-captions,
              --qa-times 3.5,12.0 (extra QA snapshots), --browser-path <chrome.exe|msedge.exe>
"""
from __future__ import annotations

import argparse
import base64
import math
import re
import shutil
import subprocess
import sys
import time
import urllib.parse
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import (ENGINE_DIR, FPS, LOW_H, LOW_W, OUT_H, OUT_W, ROOT, find_channel, is_stale,  # noqa: E402
                    load_channel, log, read_json, run, which_ffmpeg, write_json)

BATCH = 30  # frames per browser round-trip (~15 MB raw)


class Job:
    """Everything one render needs to know: episode, its channel kit, and where to write."""

    def __init__(self, ep: Path, args):
        self.ep = ep
        self.args = args
        self.build = ep / "build"
        self.channel_dir = find_channel(ep)
        self.channel = load_channel(self.channel_dir)
        self.slug = self.channel.get("slug")
        self.sfx_db = args.sfx_db if args.sfx_db is not None else float(self.channel.get("sfx_db", -14.0))
        self.encoder = args.encoder or self.channel.get("encoder", "x264")
        self.theme = self.channel_dir / "theme.js" if self.channel_dir and (self.channel_dir / "theme.js").exists() else None
        self.sfx = self.channel_dir / "sfx_presets.js" if self.channel_dir and (self.channel_dir / "sfx_presets.js").exists() else None

    def kit_files(self) -> list[Path]:
        return [p for p in (self.theme, self.sfx, self.channel_dir / "channel.json" if self.channel_dir else None) if p]


def check_isolation(job: Job) -> None:
    """A channel's episodes may only reference their own channel's kit — never another channel's files."""
    sim = (job.ep / "simulation.js").read_text(encoding="utf-8", errors="replace")
    for m in re.finditer(r"channels[/\\]+([A-Za-z0-9_\-]+)", sim):
        if m.group(1) != job.slug:
            sys.exit(f"Isolation check failed: {job.ep.name}/simulation.js references channel '{m.group(1)}'. "
                     f"Episodes may only use their own channel kit ('{job.slug}'). Copy what you need instead.")
    if job.channel_dir is None and (ROOT / "channels") in job.ep.parents:
        sys.exit(f"{job.ep} is inside channels/ but its channel has no channel.json")


# ------------------------------------------------------------------ Stage A
def stage_a(job: Job, force: bool) -> dict:
    build = job.build
    outs = [build / "timeline.json", build / "timeline.js", build / "narration.wav"]
    if not force and not is_stale(outs, [job.ep / "script.json"] + job.kit_files()):
        log("A  narration/timeline/captions up to date (cached)", "step")
        return read_json(build / "timeline.json")
    log("A  narration + timeline + captions", "step")
    import tts_and_captions
    return tts_and_captions.run_stage(job.ep, force=force)


# ------------------------------------------------------------------ Stage B
def launch_browser(pw, browser_path: str | None):
    args = ["--use-gl=angle", "--use-angle=default", "--enable-gpu-rasterization", "--ignore-gpu-blocklist",
            "--allow-file-access-from-files", "--disable-background-timer-throttling",
            "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"]
    attempts = ([{"executable_path": browser_path}] if browser_path else []) + [{}, {"channel": "chrome"}, {"channel": "msedge"}]
    errors = []
    for kw in attempts:
        try:
            b = pw.chromium.launch(headless=True, args=args, **kw)
            log(f"browser: {kw or 'playwright chromium'} ({b.version})")
            return b
        except Exception as e:
            errors.append(f"{kw or 'bundled'}: {str(e).splitlines()[0]}")
    raise RuntimeError("Could not launch Chromium. Run `python -m playwright install chromium` "
                       "or pass --browser-path.\n  " + "\n  ".join(errors))


def page_url(job: Job, timeline_js: Path, qa: bool) -> str:
    tpl = (ENGINE_DIR / "sim_template.html").as_uri()

    def rel(p: Path) -> str:
        r = Path(*([".."] + list(p.resolve().relative_to(ROOT).parts))).as_posix()
        return urllib.parse.quote(r, safe="/._-")

    q = f"?render=1&sim={rel(job.ep / 'simulation.js')}&timeline={rel(timeline_js)}"
    if job.theme:
        q += f"&theme={rel(job.theme)}"
    if job.sfx:
        q += f"&sfx={rel(job.sfx)}"
    if qa:
        q += "&qa=1"
    return tpl + q


def stage_b(job: Job, timeline: dict, timeline_js: Path, work: Path, qa: bool = False) -> tuple[int, float]:
    from playwright.sync_api import sync_playwright

    args = job.args
    work.mkdir(parents=True, exist_ok=True)
    frames_out, events_out = work / "frames_lowres.mkv", work / "sfx_events.json"
    sim_js = job.ep / "simulation.js"
    if not sim_js.exists():
        sys.exit(f"Missing {sim_js}")
    inputs = [sim_js, timeline_js] + job.kit_files() + list(ENGINE_DIR.glob("*.js")) + list(ENGINE_DIR.glob("*.html"))
    total = float(timeline["total"])
    if args.max_seconds:
        total = min(total, args.max_seconds)
    n_frames = int(math.ceil(total * FPS))
    if not args.force and not args.max_seconds and not qa and not is_stale([frames_out, events_out], inputs):
        if read_json(events_out).get("total_frames") == n_frames:
            log("B  frames up to date (cached)", "step")
            return n_frames, total

    log(f"B  rendering {n_frames} frames ({total:.2f}s @ {FPS} fps){' with QA guides' if qa else ''}", "step")
    url = page_url(job, timeline_js, qa)
    enc = subprocess.Popen([which_ffmpeg(), "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", f"{LOW_W}x{LOW_H}",
                            "-r", str(FPS), "-i", "-", "-c:v", "libx264rgb", "-preset", "ultrafast", "-qp", "0",
                            "-pix_fmt", "rgb24", str(frames_out)], stdin=subprocess.PIPE, stderr=subprocess.PIPE)
    page_errors: list[str] = []
    t0 = time.time()
    with sync_playwright() as pw:
        browser = launch_browser(pw, args.browser_path)
        page = browser.new_page(viewport={"width": 540, "height": 960})
        page.on("pageerror", lambda e: page_errors.append(str(e)))
        page.on("console", lambda m: m.type in ("error", "warning") and log(f"[browser {m.type}] {m.text}", "warn"))
        page.goto(url)
        page.wait_for_function("window.__simReady === true || !!window.__simError", timeout=30000)
        err = page.evaluate("window.__simError || null")
        if err or page_errors:
            enc.kill()
            sys.exit(f"Simulation failed to load: {err or page_errors[0]}")
        info = page.evaluate("window.__simInfo")
        if not info.get("fromTimeline"):
            log("simulation is using default beats (timeline.js not loaded)", "warn")
        log(f"theme: {info.get('theme') or ('none' if not job.theme else job.theme.parent.name)}")
        done, last_pct = 0, -1
        while done < n_frames:
            k = min(BATCH, n_frames - done)
            b64 = page.evaluate("n => window.renderBatch(n)", k)
            if page_errors:
                enc.kill()
                sys.exit(f"Simulation error at frame ~{done}: {page_errors[0]}")
            enc.stdin.write(base64.b64decode(b64))
            done += k
            pct = done * 100 // n_frames
            if pct // 10 != last_pct // 10:
                log(f"   frame {done}/{n_frames}  ({pct}%, {done / max(time.time() - t0, 1e-6):.0f} fps)")
                last_pct = pct
        events = page.evaluate("window.getSfxEvents()")
        synth = page.evaluate("window.getSynthStates ? window.getSynthStates() : {}")
        browser.close()
    enc.stdin.close()
    if enc.wait() != 0:
        sys.exit("FFmpeg frame encoder failed:\n" + enc.stderr.read().decode("utf-8", "replace")[-2000:])
    events = [e for e in events if e["frame"] < n_frames]
    write_json(events_out, {"fps": FPS, "total_frames": n_frames, "duration": total, "events": events, "synth": synth})
    log(f"frames done in {time.time() - t0:.1f}s, {len(events)} SFX events, {len(synth)} continuous voices", "ok")
    return n_frames, total


# ------------------------------------------------------------------ Stage C
def stage_c(job: Job, total: float, force: bool):
    build = job.build
    out = build / "sfx.wav"
    deps = [build / "sfx_events.json", ENGINE_DIR / "sfx_presets.js"] + ([job.sfx] if job.sfx else [])
    if not force and not is_stale([out], deps):
        log("C  sfx.wav up to date (cached)", "step")
        return
    log("C  synthesizing frame-locked 8-bit SFX + continuous voices", "step")
    import synth_sfx
    data = read_json(build / "sfx_events.json")
    info = synth_sfx.synthesize(data["events"], total, out, fps=data.get("fps", FPS),
                                synth_states=data.get("synth"), channel_dir=job.channel_dir)
    log(f"sfx.wav: {info['events']} events, {info['voices']} continuous voices", "ok")


# ------------------------------------------------------------------ Stage D
def stage_d(job: Job, total: float):
    build, sfx_db = job.build, job.sfx_db
    log(f"D  mixing voice (0 dB) + SFX ({sfx_db:+.0f} dB, sidechain-ducked) -> -14 LUFS", "step")
    fc = ("[0:a]aformat=sample_rates=48000:channel_layouts=stereo,asplit=2[narr][key];"
          f"[1:a]aformat=sample_rates=48000:channel_layouts=stereo,volume={sfx_db}dB[sfx];"
          "[sfx][key]sidechaincompress=threshold=0.02:ratio=5:attack=8:release=280:makeup=1[duck];"
          "[narr][duck]amix=inputs=2:duration=longest:normalize=0,"
          "loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[out]")
    run([which_ffmpeg(), "-y", "-v", "error", "-i", str(build / "narration.wav"), "-i", str(build / "sfx.wav"),
         "-filter_complex", fc, "-map", "[out]", "-t", f"{total:.3f}", "-ar", "48000", str(build / "mix.wav")])
    log("mix.wav written", "ok")


# ------------------------------------------------------------------ Stage E
def make_scanlines(path: Path, alpha: float = 0.22):
    img = np.zeros((OUT_H, OUT_W, 4), dtype=np.uint8)
    img[3::4, :, 3] = int(alpha * 255)  # darken the last row of every 4x4 pixel block
    run([which_ffmpeg(), "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", f"{OUT_W}x{OUT_H}",
         "-i", "-", "-frames:v", "1", str(path)], input_bytes=img.tobytes())


def video_filter(work: Path, crt: bool, captions: bool, size=(OUT_W, OUT_H), scan_input: int = 2) -> str:
    fc = f"[0:v]scale={OUT_W}:{OUT_H}:flags=neighbor,format=rgb24[v0]"
    last = "v0"
    if crt:
        fc += f";[{last}][{scan_input}:v]overlay=0:0:format=auto[v1]"
        last = "v1"
    if captions:
        fc += f";[{last}]ass=captions.ass[v2]"  # relative path: avoids Windows drive-letter escaping in filters
        last = "v2"
    if size != (OUT_W, OUT_H):
        fc += f";[{last}]scale={size[0]}:{size[1]}:flags=area[v3]"
        last = "v3"
    return fc + f";[{last}]scale=out_color_matrix=bt709:out_range=tv,format=yuv420p[vout]"


def stage_e(job: Job, timeline: dict, total: float) -> Path:
    args, build, ep = job.args, job.build, job.ep
    out_dir = ep / "output"
    out_dir.mkdir(exist_ok=True)
    out = out_dir / (f"{ep.name}_preview.mp4" if args.max_seconds else f"{ep.name}.mp4")
    crt = bool(timeline.get("crt", True)) and not args.no_crt
    captions = (build / "captions.ass").exists() and not args.no_captions
    log(f"E  final assembly: 4x upscale{' + CRT' if crt else ''}{' + captions' if captions else ''} -> {job.encoder}", "step")
    cmd = [which_ffmpeg(), "-y", "-v", "error", "-stats", "-i", "frames_lowres.mkv", "-i", "mix.wav"]
    if crt:
        make_scanlines(build / "scanlines.png")
        cmd += ["-i", "scanlines.png"]
    cmd += ["-filter_complex", video_filter(build, crt, captions), "-map", "[vout]", "-map", "1:a",
            "-r", str(FPS), "-t", f"{total:.3f}"]
    if job.encoder == "amf":
        cmd += ["-c:v", "h264_amf", "-quality", "quality", "-rc", "cqp", "-qp_i", "16", "-qp_p", "18", "-qp_b", "20"]
    else:
        cmd += ["-c:v", "libx264", "-preset", "slow", "-crf", "17", "-tune", "animation", "-profile:v", "high"]
    cmd += ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
            "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(out)]
    run(cmd, cwd=build)
    clim = next((b for b in timeline["beats"] if b["id"] in ("climax", "phase3", "failure", "escalation")), None)
    ts = min(total - 0.1, (clim["start"] + 1.5) if clim else total * 0.6)
    run([which_ffmpeg(), "-y", "-v", "error", "-ss", f"{ts:.2f}", "-i", str(out), "-frames:v", "1", str(out_dir / f"{ep.name}_thumb.png")])
    if job.channel_dir and not args.max_seconds:
        exports = job.channel_dir / "exports"
        exports.mkdir(exist_ok=True)
        shutil.copy2(out, exports / out.name)
        log(f"copied to {exports / out.name}")
    return out


# ------------------------------------------------------------------ Preview-only QA pass
def preview_only(job: Job):
    ep, build = job.ep, job.build
    real = build / "timeline.json"
    if real.exists() and not is_stale([real, build / "timeline.js"], [ep / "script.json"] + job.kit_files()):
        tl_dir = build
        log("QA: using the real voiced timeline from build/", "step")
    else:
        tl_dir = build / "preview"
        log("QA: estimating timeline with silent placeholder narration (no TTS, no Whisper)", "step")
        import tts_and_captions
        tts_and_captions.run_stage(ep, force=True, out_dir=tl_dir,
                                   overrides={"tts_engines": ["silent"], "captions": {"use_whisper": False}})
    timeline = read_json(tl_dir / "timeline.json")
    work = build / "preview"
    work.mkdir(parents=True, exist_ok=True)
    if (tl_dir / "captions.ass").exists() and tl_dir != work:
        shutil.copy2(tl_dir / "captions.ass", work / "captions.ass")
    _, total = stage_b(job, timeline, tl_dir / "timeline.js", work, qa=True)

    qa = ep / "qa"
    qa.mkdir(exist_ok=True)
    for old in qa.glob("qa_*.png"):
        old.unlink()
    captions = (work / "captions.ass").exists() and not job.args.no_captions
    shots = []
    for i, b in enumerate(timeline["beats"]):
        t = min(total - 1 / FPS, b["start"] + 0.6 * (b["end"] - b["start"]))
        shots.append((f"qa_phase{i + 1}.png", t, b["id"]))
    for j, t in enumerate(float(x) for x in (job.args.qa_times or "").split(",") if x.strip()):
        shots.append((f"qa_extra{j + 1}.png", min(t, total - 1 / FPS), "extra"))
    vf = f"scale={OUT_W}:{OUT_H}:flags=neighbor" + (",ass=captions.ass" if captions else "")
    for name, t, bid in shots:
        run([which_ffmpeg(), "-y", "-v", "error", "-i", "frames_lowres.mkv", "-ss", f"{t:.3f}", "-frames:v", "1",
             "-vf", vf, str(qa / name)], cwd=work)
        log(f"   {name}  t={t:.2f}s  ({bid})")
    phase_pngs = [qa / n for n, _, b in shots if n.startswith("qa_phase")]
    if len(phase_pngs) >= 2:
        cmd = [which_ffmpeg(), "-y", "-v", "error"]
        for p in phase_pngs:
            cmd += ["-i", str(p)]
        fc = "".join(f"[{i}:v]scale=360:640:flags=area[s{i}];" for i in range(len(phase_pngs)))
        fc += "".join(f"[s{i}]" for i in range(len(phase_pngs))) + f"hstack=inputs={len(phase_pngs)}"
        run(cmd + ["-filter_complex", fc, str(qa / "qa_sheet.png")])
    run([which_ffmpeg(), "-y", "-v", "error", "-i", "frames_lowres.mkv", "-filter_complex",
         video_filter(work, False, captions, size=(540, 960)), "-map", "[vout]", "-c:v", "libx264", "-preset", "veryfast",
         "-crf", "23", "-an", str(qa / "preview.mp4")], cwd=work)
    log(f"QA pass ready: {qa}  (qa_phase*.png, qa_sheet.png, preview.mp4 — silent, with safe-zone guides)", "ok")


# ------------------------------------------------------------------ main
def resolve_episode(p: Path) -> Path:
    for cand in (p if p.is_absolute() else Path.cwd() / p, ROOT / p):
        if (cand / "script.json").exists():
            return cand.resolve()
    sys.exit(f"No script.json found for episode '{p}'")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--episode", required=True, type=Path, help="e.g. channels/gearlogic/episodes/ep001_gearbox")
    ap.add_argument("--preview-only", action="store_true", help="fast silent QA pass with phase snapshots")
    ap.add_argument("--steps", default="ABCDE", help="subset of stages to run, e.g. BCDE")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--max-seconds", type=float, default=None, help="quick render of the first N seconds")
    ap.add_argument("--encoder", choices=["x264", "amf"], default=None, help="default: channel.json 'encoder' or x264")
    ap.add_argument("--sfx-db", type=float, default=None, help="SFX level vs voice (default: channel.json 'sfx_db' or -14)")
    ap.add_argument("--qa-times", default=None, help="extra QA snapshot times, e.g. 3.5,12")
    ap.add_argument("--no-crt", action="store_true")
    ap.add_argument("--no-captions", action="store_true")
    ap.add_argument("--browser-path", default=None)
    args = ap.parse_args()

    ep = resolve_episode(args.episode)
    job = Job(ep, args)
    check_isolation(job)
    job.build.mkdir(exist_ok=True)
    t0 = time.time()
    log(f"Episode: {ep.name}   channel: {job.slug or '(none)'}   {'QA PREVIEW' if args.preview_only else 'stages: ' + args.steps.upper()}", "step")

    if args.preview_only:
        preview_only(job)
        log(f"DONE in {time.time() - t0:.1f}s", "ok")
        return

    steps = args.steps.upper()
    timeline = stage_a(job, args.force) if "A" in steps else read_json(job.build / "timeline.json")
    total = min(float(timeline["total"]), args.max_seconds or 1e9)
    if "B" in steps:
        _, total = stage_b(job, timeline, job.build / "timeline.js", job.build)
    if "C" in steps:
        stage_c(job, total, args.force or bool(args.max_seconds))
    if "D" in steps:
        stage_d(job, total)
    if "E" in steps:
        out = stage_e(job, timeline, total)
        log(f"DONE in {time.time() - t0:.1f}s -> {out}", "ok")


if __name__ == "__main__":
    main()
