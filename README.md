# Retro Video Factory v2

Deterministic retro pixel-art simulations → 1080×1920 60 fps vertical videos with frame-locked 8-bit SFX, continuous physics-coupled engine/motor tones, local TTS narration, and word-highlighted captions. It supports **multiple channels**, each with its own isolated style kit. For the multi-channel workflow, see **CHANNELS.md**.

## Commands (run from `C:\8BitVideoo`)

PowerShell blocks `activate`, so these commands call the project's Python directly:

```powershell
# create a channel (once per niche)
.\venv\Scripts\python.exe pipeline\new_channel.py gearlogic --name "Gear Logic" --handle @gearlogic --niche "mechanical engineering" --palette blueprint

# create an episode inside it
.\venv\Scripts\python.exe pipeline\new_episode.py --channel gearlogic ep001_gearbox --title "How a Gearbox Works"

# pass 1: fast silent QA preview -> episode\qa\qa_phase1..4.png, qa_sheet.png, preview.mp4
.\venv\Scripts\python.exe pipeline\render_video.py --episode channels\gearlogic\episodes\ep001_gearbox --preview-only

# pass 2: full render -> episode\output\*.mp4, plus a copy in channels\gearlogic\exports\
.\venv\Scripts\python.exe pipeline\render_video.py --episode channels\gearlogic\episodes\ep001_gearbox

# overnight: render every episode whose files changed since its last render
.\venv\Scripts\python.exe pipeline\render_batch.py --all
```

Demo episodes are in `channels\examples\`:
- `ep02_engine` is the v2 feature demo: camera zoom, cutaway, labels, knock failure mode and engine tone.
- `ep01_search` is the v1 demo.

**Flags:**

| Flag | Effect |
|---|---|
| `--preview-only` | Silent QA pass with safe-zone guides and phase snapshots |
| `--steps BCDE` | Reuse the existing narration |
| `--force` | Ignore caches |
| `--max-seconds 8` | Render only the first 8 seconds |
| `--encoder amf` | Encode on the RX 6700 XT |
| `--sfx-db -14` | SFX level relative to the voice |
| `--qa-times 3.5,12` | Extra QA snapshots at these times |
| `--no-crt` / `--no-captions` | Turn off scanlines / captions |
| `--browser-path` | Use a specific browser for rendering |

## Folder layout

```
engine/                 SHARED engine (no channel styling lives here)
  sim_template.html     host page; loads engine + the channel theme + the episode
  retro_engine.js       270x480→4x pixel engine, camera-aware primitives, polygons, 5x7 font, HUD widgets
  camera_ui.js          v2: Camera, cutaway peel, arrows/flows, leader-line labels, telemetry/gauge/scope, gears/springs, R.hum
  retro_audio.js        logSfx (discrete) + logSynthState (continuous) + live preview synth
  sfx_presets.js        base SFX library
pipeline/               SHARED Python stages + tools (render_video, render_batch, new_channel, new_episode, ...)
templates/              blank channel kit + blank episode (copied by the scaffolders)
channels/<slug>/        ONE folder per channel — its whole kit:
  channel.json          voice, captions, mix level, encoder
  theme.js              palette, background, watermark, header style
  sfx_presets.js        SFX overrides for this channel only
  brief.md              niche, style rules, topic backlog, performance log
  episodes/<ep>/        script.json + simulation.js (+ build/, qa/, output/ generated)
  exports/              finished MP4s ready to upload
models/                 Kokoro voice model files
```

Settings are applied in this order, each overriding the previous: **engine defaults → channel.json / theme.js → episode script.json → command-line flags**. `render_video.py` refuses to render an episode whose `simulation.js` references another channel's folder.

## v2 episode toolkit (`R` inside simulation.js)

**Timing and sync**
- `R.beat(id)`
- `R.wordAt('word', 'beat', fallback, nth)`: the time a specific narration word is spoken
- `R.crossed(t)`, `R.once`, `R.every`, `R.tween`

**Camera**
- `Camera.setView(x, y, w, h)`
- `Camera.track([{t, x, y, zoom}])`
- `Camera.focusOn(x, y, zoom, dur)`
- `R.world(() => ...)`: draws in world coordinates, so the camera zoom adds detail instead of blurring pixels

**Shapes** (world-aware)
- `R.rect`, `R.line(.., thick)`, `R.circle(.., {outline, shadow})`, `R.ring`
- `R.poly(pts, c, {outline, outlineW, shadow})`, `R.rotRect`, `R.link`
- `R.gear`, `R.spring`, `R.hatch`

**Cutaways**
- `R.peel(p, drawFn, {mode: 'wipe'|'split'|'alpha'|'lift', bbox, dir})`

**Annotations**
- `R.label(text, x, y, {sub, color, side, at, appear})`: leader-line labels, laid out automatically inside the safe zone without overlapping
- `R.reserve(rect)`: keeps labels off a HUD element
- `R.force(x, y, angle, len, c, {label, pulse})`, `R.arrow`, `R.flow(points, c)`

**HUD**
- `R.telemetry(x, y, w, rows)`, `R.gauge`, `R.scope`, `R.counter`, `R.bar`, `R.split`, `R.callout`, `R.tag`

**Audio**
- `R.sfx(type, semitones, {vol, pan})`: one-off sound effects
- `R.hum('voice', {freq, duty, gain, noise, wave})`: a continuous tone. Call it every frame and drive its frequency from the simulation's own numbers.

**Theme**
- `R.PAL.<role>`: the channel palette
- `R.theme.header(R, text)`

**Determinism:** never use `Date` or `performance.now()` in a simulation. `Math.random` is seeded automatically.

## Live preview while developing

Open this in Chrome or Edge:

`engine/sim_template.html?theme=../channels/examples/theme.js&sim=../channels/examples/episodes/ep02_engine/simulation.js&timeline=../channels/examples/episodes/ep02_engine/build/timeline.js`

Keys: Space = pause, R = restart, C = CRT toggle, ←/→ = seek 5 s.
