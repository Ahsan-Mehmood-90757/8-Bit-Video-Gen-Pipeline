"""new_episode.py — create a new episode folder inside ONE channel.

    python pipeline/new_episode.py --channel gearlogic ep001_gearbox --title "How a Gearbox Works"

Creates channels/<channel>/episodes/<name>/ with script.json (4-phase beats) and a starter
simulation.js. Voice/captions/look come from the channel automatically.
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import CHANNELS_DIR, ROOT  # noqa: E402

TEMPLATES = ROOT / "templates" / "episode"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("name", help="episode folder, e.g. ep001_gearbox")
    ap.add_argument("--channel", required=True)
    ap.add_argument("--title", default=None)
    ap.add_argument("--topic", default="")
    args = ap.parse_args()

    ch = CHANNELS_DIR / args.channel
    if not (ch / "channel.json").exists():
        avail = ", ".join(sorted(p.name for p in CHANNELS_DIR.iterdir() if (p / "channel.json").exists())) if CHANNELS_DIR.exists() else ""
        sys.exit(f"Unknown channel '{args.channel}'. Available: {avail or '(none — run new_channel.py first)'}")
    name = args.name.strip()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_\-]{1,60}", name):
        sys.exit("episode name: letters/digits/-/_ only")
    dest = ch / "episodes" / name
    if dest.exists():
        sys.exit(f"{dest} already exists")
    dest.mkdir(parents=True)
    title = args.title or name.split("_", 1)[-1].replace("_", " ").replace("-", " ").title()
    for f in TEMPLATES.iterdir():
        text = f.read_text(encoding="utf-8")
        text = text.replace("{{TITLE}}", title).replace("{{TOPIC}}", args.topic).replace("{{CHANNEL}}", args.channel)
        (dest / f.name).write_text(text, encoding="utf-8")
    rel = dest.relative_to(ROOT).as_posix()
    print(f"Created {rel}")
    print(f"  QA pass:     python pipeline/render_video.py --episode {rel} --preview-only")
    print(f"  Full render: python pipeline/render_video.py --episode {rel}")


if __name__ == "__main__":
    main()
