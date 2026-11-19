# Setting up on a new PC (Windows)

About 10 minutes. Everything runs locally: no API keys and no cloud.

## 1. Install the tools (once per PC)

Open **PowerShell** and run:

```powershell
winget install Git.Git
winget install Python.Python.3.12
winget install Gyan.FFmpeg
```

Then **close and reopen PowerShell** so the new tools are on PATH. Check them:

```powershell
git --version; python --version; ffmpeg -version
```

(Without winget: get Python from python.org and tick "Add python.exe to PATH". For FFmpeg, unzip a build from gyan.dev and add its `bin` folder to PATH.)

## 2. Get the code

```powershell
cd C:\
git clone https://github.com/Ahsan-Mehmood-90757/8-bit-video-gen-pipeline.git 8BitVideoo
cd C:\8BitVideoo
git checkout V3
```

- `main` is v2: narration and captions.
- `V3` is the visual-first pipeline: no voice, micro-text, music bed.

## 3. Run the setup script

```powershell
.\setup_v3.bat
```

The script:
- creates `venv\`
- installs NumPy and Playwright
- downloads headless Chromium
- runs a QA preview of the episode template as a smoke test

It ends with **"V3 setup complete"** if everything works.

To also run the **v2** narration pipeline on this PC, run `.\setup_windows.bat` too. It downloads the ~340 MB Kokoro voice model.

## 4. Render something

Call the venv's Python directly. This avoids PowerShell's "running scripts is disabled" error from `activate`.

```powershell
# full render (MP4 lands in episodes_v3\<name>\output\)
.\venv\Scripts\python.exe pipeline_v3\render_v3.py --episode episodes_v3\binary-vs-linear-search

# fast QA only (stills + preview.mp4 + reports in qa\, fails on layout/text/pacing problems)
.\venv\Scripts\python.exe pipeline_v3\render_v3.py --episode episodes_v3\binary-vs-linear-search --preview-only

# start a new episode from the template
.\venv\Scripts\python.exe pipeline_v3\new_episode_v3.py my-topic --title "My Topic"
```

Optional render flags:
- `--encoder amf` uses the AMD GPU encoder.
- `--no-crt` turns off the scanlines.

## Keeping two PCs in sync

On the PC you worked on:

```powershell
git add -A
git commit -m "what changed"
git push
```

On the other PC:

```powershell
git pull
```

Renders, QA images, audio, `venv\` and voice models are git-ignored. Only code, episode scripts and channel kits travel through GitHub, so a fresh PC re-creates everything else by rendering. To move a finished video, copy it from `output\` yourself.

## Troubleshooting

| Problem | Fix |
|---|---|
| `python` opens the Microsoft Store | Settings → Apps → Advanced app settings → App execution aliases: turn off the two `python` aliases, then reopen PowerShell |
| `ffmpeg` not recognized | Reopen PowerShell after installing; check `where.exe ffmpeg` |
| `Could not launch Chromium` | Run `.\venv\Scripts\python.exe -m playwright install chromium`, or pass `--browser-path "C:\Program Files\Google\Chrome\Application\chrome.exe"` |
| `git push` asks for login | Sign in through the browser window Git opens (GitHub account Ahsan-Mehmood-90757) |
| QA FAILED | Read the `!!` lines. The details are in `qa\safe_zone_report.json`, `qa\pacing_report.json` and `qa\audio_report.json` |
