# Running multiple channels

Each channel covers one niche and has its own style kit. Nothing is shared between channels except the engine and the pipeline code.

## How isolation works

| Layer | Shared by all channels | Private to one channel |
|---|---|---|
| Engine code (`engine/`) and pipeline (`pipeline/`) | ✅ | |
| Palette, background, watermark, header style | | `channels/<slug>/theme.js` |
| Voice, speed, caption font/colour, SFX level, encoder | | `channels/<slug>/channel.json` |
| Signature sounds (custom jingles) | | `channels/<slug>/sfx_presets.js` |
| Style rules, hook formula, topic backlog, stats | | `channels/<slug>/brief.md` |
| Episodes and exports | | `channels/<slug>/episodes`, `exports` |

How the separation is enforced:
- The renderer loads only the theme, SFX and settings of the channel folder the episode is in.
- New channels and episodes are created from `templates/`, never by copying another channel.
- A render stops if a `simulation.js` mentions another channel's folder.
- Episodes use palette *roles* (`R.PAL.cyan`, `R.PAL.gold`) instead of hex codes. The same simulation code therefore takes on whichever channel's colours it belongs to, but each episode lives in exactly one channel.

**Improving the engine** (a better camera, a new primitive) helps every channel at once. That's intended: improvements are shared, but styles are not.

## Setting up a new channel (about 15 minutes)

1. **Create it.** Pick a palette preset (`--list-palettes` shows them):
   - `neon`: tech and engineering
   - `blueprint`: mechanisms and inventions
   - `amber`: finance and history
   - `gameboy`: biology and nature
   - `synth`: AI, space and crypto

   ```powershell
   .\venv\Scripts\python.exe pipeline\new_channel.py moneymachines --name "Money Machines" --handle @moneymachines --niche "how financial systems work" --palette amber
   ```
2. **Fill in `brief.md`.** Write who the viewer is, the one-sentence promise, the hook formula, the sign-off line and 20+ topics. This file goes at the top of every Gemini prompt for the channel.
3. **Give it its own voice.** Change `voice.kokoro_voice` in `channel.json`, for example to `am_michael`, `am_adam`, `bm_george`, `af_heart` or `af_nicole`. Use a different voice per channel so they never sound alike.
4. **Optional signature sounds.** Ask me for a custom `success` or `level` jingle in this channel's `sfx_presets.js`.
5. **Optional custom look.** Ask me to give `theme.js` its own background motif, header style or intro frame.

## Making each video

1. **Gemini (spec writer):** paste `brief.md` and Master Prompt 2 (v2), plus a topic from the backlog. Gemini returns the spec: parts list, 4-phase choreography, audio formula and narration.
2. **Read the narration aloud.** Check it's 105–130 words with a strong first sentence. Edit it now, because this is where watch time is won.
3. **Claude (builder):** paste the spec into a chat with me and name the channel. I create `channels/<slug>/episodes/<ep>/`, write `script.json` and `simulation.js`, run `--preview-only`, inspect the 4 phase snapshots, fix any overlaps or bad zooms, and copy the episode to your PC.
4. **Full render on your PC:**
   `.\venv\Scripts\python.exe pipeline\render_video.py --episode channels\<slug>\episodes\<ep>`
5. **Watch it once on your phone,** then upload from `channels\<slug>\exports\`.
6. **After about 48 hours,** log views, average watch % and 3-second hold % in that channel's `brief.md`.

## Weekly rhythm (multi-channel)

- **Planning day:** write 3–5 specs per channel in Gemini.
- **Build day:** send me the specs. I build and QA every episode.
- **Overnight:** `.\venv\Scripts\python.exe pipeline\render_batch.py --all` renders everything that changed, one video at a time, which keeps RAM use low.
- **Review:** compare stats across channels. Copy what works *within* a channel into its `brief.md`. Only an idea that works everywhere is worth a shared engine feature.

## Naming conventions

- Channel slugs: lowercase, e.g. `gearlogic`, `moneymachines`.
- Episodes: `ep001_topic`, `ep002_topic`, ... (zero-padded so they sort in order).
- Don't edit `build/`, `qa/` or `output/` by hand. They're regenerated on every render and can be deleted anytime.
