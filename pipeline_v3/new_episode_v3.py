"""new_episode_v3.py — create a V3 Visual-First episode from templates/episode_v3.

    python pipeline_v3/new_episode_v3.py ep01_ring_buffer_v3 --title "Ring Buffer"              # -> episodes_v3/<name>
    python pipeline_v3/new_episode_v3.py ep004_gearbox --channel gearlogic --title "Gearbox"    # -> channels/<slug>/episodes/<name>
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TEMPLATE = ROOT / "templates" / "episode_v3"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("name")
    ap.add_argument("--channel", default=None, help="put it inside channels/<slug>/episodes (uses that channel's kit)")
    ap.add_argument("--title", default=None)
    args = ap.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_\-]{1,60}", args.name):
        sys.exit("episode name: letters/digits/-/_ only")
    if args.channel:
        ch = ROOT / "channels" / args.channel
        if not (ch / "channel.json").exists():
            sys.exit(f"unknown channel '{args.channel}'")
        dest = ch / "episodes" / args.name
    else:
        dest = ROOT / "episodes_v3" / args.name
    if dest.exists():
        sys.exit(f"{dest} already exists")
    dest.mkdir(parents=True)
    title = args.title or args.name.split("_", 1)[-1].replace("_", " ").title()
    for f in TEMPLATE.iterdir():
        txt = f.read_text(encoding="utf-8").replace("{{TITLE}}", title).replace("{{CHANNEL}}", args.channel or "(none)")
        (dest / f.name).write_text(txt, encoding="utf-8")
    rel = dest.relative_to(ROOT).as_posix()
    print(f"Created {rel}")
    print(f"  QA pass:     python pipeline_v3/render_v3.py --episode {rel} --preview-only")
    print(f"  Full render: python pipeline_v3/render_v3.py --episode {rel}")


if __name__ == "__main__":
    main()
