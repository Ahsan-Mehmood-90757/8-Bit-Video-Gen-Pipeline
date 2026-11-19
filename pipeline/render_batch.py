"""render_batch.py — render every episode that needs it, one after another (overnight batches).

    python pipeline/render_batch.py --channel gearlogic          # one channel
    python pipeline/render_batch.py --all                        # every channel
    python pipeline/render_batch.py --all --dry-run              # just list what would render
    python pipeline/render_batch.py --channel gearlogic --preview-only

An episode "needs rendering" when its output MP4 is missing or older than its script.json,
simulation.js, or its channel kit (theme.js / sfx_presets.js / channel.json).
Episodes run sequentially in separate processes, so RAM never stacks up.
"""
from __future__ import annotations

import argparse
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import CHANNELS_DIR, ROOT, is_stale  # noqa: E402


def episodes_of(ch: Path) -> list[Path]:
    eps = ch / "episodes"
    if not eps.exists():
        return []
    return sorted(p for p in eps.iterdir() if (p / "script.json").exists() and (p / "simulation.js").exists())


def needs_render(ep: Path, ch: Path) -> bool:
    out = ep / "output" / f"{ep.name}.mp4"
    deps = [ep / "script.json", ep / "simulation.js"] + [ch / f for f in ("theme.js", "sfx_presets.js", "channel.json")]
    return is_stale([out], deps)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--channel")
    g.add_argument("--all", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--force", action="store_true", help="render even if up to date")
    ap.add_argument("--preview-only", action="store_true")
    ap.add_argument("--encoder", choices=["x264", "amf"], default=None)
    args = ap.parse_args()

    chans = sorted(p for p in CHANNELS_DIR.iterdir() if (p / "channel.json").exists()) if args.all else [CHANNELS_DIR / args.channel]
    todo = []
    for ch in chans:
        if not (ch / "channel.json").exists():
            sys.exit(f"Unknown channel: {ch.name}")
        for ep in episodes_of(ch):
            if args.force or args.preview_only or needs_render(ep, ch):
                todo.append(ep)
    if not todo:
        print("Everything is up to date.")
        return
    print(f"{len(todo)} episode(s) to {'preview' if args.preview_only else 'render'}:")
    for ep in todo:
        print("  -", ep.relative_to(ROOT).as_posix())
    if args.dry_run:
        return
    failed = []
    t0 = time.time()
    for i, ep in enumerate(todo, 1):
        print(f"\n===== [{i}/{len(todo)}] {ep.relative_to(ROOT).as_posix()} =====", flush=True)
        cmd = [sys.executable, str(ROOT / "pipeline" / "render_video.py"), "--episode", str(ep)]
        if args.preview_only:
            cmd.append("--preview-only")
        if args.encoder:
            cmd += ["--encoder", args.encoder]
        if subprocess.run(cmd).returncode != 0:
            failed.append(ep)
    print(f"\nBatch finished in {(time.time() - t0) / 60:.1f} min. {len(todo) - len(failed)} ok, {len(failed)} failed.")
    for ep in failed:
        print("  FAILED:", ep.relative_to(ROOT).as_posix())
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
