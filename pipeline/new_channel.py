"""new_channel.py — create an isolated channel kit under channels/<slug>/.

    python pipeline/new_channel.py gearlogic --name "Gear Logic" --handle @gearlogic --niche "mechanical engineering" --palette neon
    python pipeline/new_channel.py --list-palettes

Creates:
  channels/<slug>/channel.json     voice, captions, mix, encoder settings (this channel only)
  channels/<slug>/theme.js         palette + background + watermark (this channel only)
  channels/<slug>/sfx_presets.js   SFX overrides (this channel only)
  channels/<slug>/brief.md         niche, style rules, topic backlog, performance log
  channels/<slug>/episodes/        one folder per video
  channels/<slug>/exports/         finished MP4s ready to upload

Kits are copied from templates/, never from another channel, so nothing leaks between channels.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import CHANNELS_DIR, ROOT  # noqa: E402

TEMPLATES = ROOT / "templates" / "channel"

BASE = {"black": "#05070D", "white": "#F8FAFC"}
PALETTES = {
    "neon": {  # default dark navy + neon accents (the @8bitengineering look)
        "bg": "#0B0F19", "panel": "#111827", "panel2": "#162033", "grid": "#1A2438", "dim": "#334155", "mid": "#64748B",
        "text": "#CBD5E1", "cyan": "#38BDF8", "gold": "#FACC15", "coral": "#F43F5E", "emerald": "#4ADE80",
        "violet": "#A78BFA", "orange": "#FB923C", "cyanDk": "#0E4A6B", "goldDk": "#6B5507", "coralDk": "#6B1527",
        "emeraldDk": "#14532D", "_bg": "grid", "_highlight": "#FACC15"},
    "amber": {  # warm amber-terminal: finance, history, economics
        "bg": "#120B05", "panel": "#1E1309", "panel2": "#2A1B0D", "grid": "#2A1A0B", "dim": "#5C3D1E", "mid": "#9A7A55",
        "text": "#F3DFC1", "cyan": "#FDBA74", "gold": "#FCD34D", "coral": "#EF4444", "emerald": "#A3E635",
        "violet": "#F0ABFC", "orange": "#FB923C", "cyanDk": "#7C3A0A", "goldDk": "#713F12", "coralDk": "#7F1D1D",
        "emeraldDk": "#365314", "_bg": "scan", "_highlight": "#FCD34D"},
    "blueprint": {  # engineering blueprint: mechanisms, architecture, inventions
        "bg": "#0A2A5E", "panel": "#0D3473", "panel2": "#114087", "grid": "#164B97", "dim": "#3B6FB8", "mid": "#8FB3E8",
        "text": "#E6F0FF", "cyan": "#7DD3FC", "gold": "#FDE047", "coral": "#FB7185", "emerald": "#86EFAC",
        "violet": "#C4B5FD", "orange": "#FDBA74", "cyanDk": "#0C4A6E", "goldDk": "#713F12", "coralDk": "#881337",
        "emeraldDk": "#14532D", "_bg": "blueprint", "_highlight": "#FDE047"},
    "gameboy": {  # 4-shade green handheld: biology, nature, retro-gaming facts
        "bg": "#0F1F0F", "panel": "#183018", "panel2": "#1E3A1E", "grid": "#1B331B", "dim": "#306230", "mid": "#6E9E4E",
        "text": "#C8E6A0", "cyan": "#8BCF5A", "gold": "#E0F88F", "coral": "#F87171", "emerald": "#9BE564",
        "violet": "#B8E986", "orange": "#D9F99D", "cyanDk": "#2F5A1F", "goldDk": "#4D6B1F", "coralDk": "#6B1D1D",
        "emeraldDk": "#2E5A1E", "_bg": "dots", "_highlight": "#E0F88F"},
    "synth": {  # magenta/teal synthwave: tech, AI, crypto, space
        "bg": "#140A1F", "panel": "#1F1030", "panel2": "#2A1640", "grid": "#26123B", "dim": "#4C2A70", "mid": "#9A7BC0",
        "text": "#EADCFB", "cyan": "#22D3EE", "gold": "#F472B6", "coral": "#FB7185", "emerald": "#34D399",
        "violet": "#C084FC", "orange": "#FDBA74", "cyanDk": "#155E75", "goldDk": "#701A4D", "coralDk": "#881337",
        "emeraldDk": "#065F46", "_bg": "grid", "_highlight": "#22D3EE"},
}
VOICES = {"neon": "am_michael", "amber": "bm_george", "blueprint": "am_adam", "gameboy": "af_heart", "synth": "af_nicole"}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("slug", nargs="?", help="folder name: lowercase letters, digits, - or _")
    ap.add_argument("--name", help="display name")
    ap.add_argument("--handle", default="", help="e.g. @gearlogic (drawn as a small watermark)")
    ap.add_argument("--niche", default="")
    ap.add_argument("--palette", default="neon", choices=sorted(PALETTES))
    ap.add_argument("--voice", default=None, help="Kokoro voice id (default depends on palette)")
    ap.add_argument("--list-palettes", action="store_true")
    args = ap.parse_args()

    if args.list_palettes or not args.slug:
        for k, v in PALETTES.items():
            print(f"  {k:10s} bg {v['bg']}  accents {v['cyan']} {v['gold']} {v['coral']}  background={v['_bg']}")
        if not args.slug:
            ap.print_usage()
        return
    slug = args.slug.strip().lower()
    if not re.fullmatch(r"[a-z0-9][a-z0-9_\-]{1,40}", slug):
        sys.exit("slug must be lowercase letters/digits/-/_ (2-41 chars)")
    dest = CHANNELS_DIR / slug
    if dest.exists():
        sys.exit(f"{dest} already exists — channels are never overwritten.")

    pal = dict(PALETTES[args.palette])
    bg, hl = pal.pop("_bg"), pal.pop("_highlight")
    pal.update(BASE)
    subs = {
        "{{SLUG}}": slug, "{{NAME}}": args.name or slug, "{{HANDLE}}": args.handle, "{{NICHE}}": args.niche,
        "{{PALETTE_NAME}}": args.palette, "{{BG}}": bg, "{{HIGHLIGHT}}": hl,
        "{{VOICE}}": args.voice or VOICES[args.palette],
        "{{PALETTE}}": json.dumps(pal, indent=4).replace("\n", "\n  "),
    }
    (dest / "episodes").mkdir(parents=True)
    (dest / "exports").mkdir()
    for f in TEMPLATES.iterdir():
        text = f.read_text(encoding="utf-8")
        for k, v in subs.items():
            text = text.replace(k, v)
        (dest / f.name).write_text(text, encoding="utf-8")
    print(f"Created channel '{slug}' at {dest}")
    print(f"  palette: {args.palette} ({bg} background) · voice: {subs['{{VOICE}}']}")
    print("Next:")
    print(f"  1. Fill in channels/{slug}/brief.md (niche, style rules, topic backlog)")
    print(f"  2. python pipeline/new_episode.py --channel {slug} ep001_<topic> --title \"...\"")


if __name__ == "__main__":
    main()
