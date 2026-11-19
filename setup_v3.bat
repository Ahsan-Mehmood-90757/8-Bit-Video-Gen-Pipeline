@echo off
REM ===========================================================================
REM  One-time setup for the V3 pipeline on a new Windows PC.
REM  Run it from the repo folder after cloning (see SETUP_NEW_PC.md).
REM  V3 needs only Python + NumPy + Playwright Chromium + FFmpeg.
REM  It needs no voice models (those are for v2 narration; use setup_windows.bat).
REM ===========================================================================
setlocal
cd /d "%~dp0"

echo == Checking tools
where git >nul 2>nul || echo [i] Git not found ^(only needed to pull updates^): winget install Git.Git
where python >nul 2>nul || (
  echo [!] Python 3.11+ not found on PATH.
  echo     Install:  winget install Python.Python.3.12
  echo     ^(or python.org - tick "Add python.exe to PATH"^), then reopen this terminal.
  exit /b 1
)
python -c "import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)" || (echo [!] Python 3.11 or newer is required. & exit /b 1)
where ffmpeg >nul 2>nul || (
  echo [!] FFmpeg not found on PATH.
  echo     Install:  winget install Gyan.FFmpeg   then reopen this terminal.
  exit /b 1
)

if not exist venv (
  echo == Creating virtual environment
  python -m venv venv || exit /b 1
)

echo == Installing Python packages ^(V3: numpy + playwright^)
venv\Scripts\python.exe -m pip install --upgrade pip
venv\Scripts\python.exe -m pip install "numpy>=1.26" "playwright>=1.44" || exit /b 1

echo == Installing Playwright Chromium ^(headless renderer^)
venv\Scripts\python.exe -m playwright install chromium || exit /b 1

echo == Smoke test: QA preview of the episode template
if exist episodes_v3\zz_setup_check rmdir /s /q episodes_v3\zz_setup_check
venv\Scripts\python.exe pipeline_v3\new_episode_v3.py zz_setup_check --title "Setup Check" >nul || exit /b 1
venv\Scripts\python.exe pipeline_v3\render_v3.py --episode episodes_v3\zz_setup_check --preview-only
set RC=%ERRORLEVEL%
rmdir /s /q episodes_v3\zz_setup_check
if not "%RC%"=="0" (echo [!] Smoke test failed ^(exit %RC%^) - see the log above. & exit /b %RC%)

echo.
echo == V3 setup complete. Render an episode with:
echo    .\venv\Scripts\python.exe pipeline_v3\render_v3.py --episode episodes_v3\binary-vs-linear-search
endlocal
