@echo off
REM One-time setup for the Retro Video Factory (run from this folder).
setlocal
cd /d "%~dp0"

where python >nul 2>nul || (echo [!] Python 3.11+ not found on PATH. Install it from python.org first. & exit /b 1)
where ffmpeg >nul 2>nul || (echo [!] FFmpeg not found on PATH. Install it ^(e.g. winget install Gyan.FFmpeg^) and reopen this terminal. & exit /b 1)

if not exist venv (
  echo == Creating virtual environment
  python -m venv venv || exit /b 1
)
call venv\Scripts\activate.bat

echo == Installing Python packages
python -m pip install --upgrade pip
python -m pip install -r requirements.txt || exit /b 1

echo == Installing Playwright Chromium (headless renderer)
python -m playwright install chromium

if not exist models mkdir models
if not exist models\kokoro-v1.0.onnx (
  echo == Downloading Kokoro-82M voice model ^(~310 MB^)
  curl -L -o models\kokoro-v1.0.onnx https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx
)
if not exist models\voices-v1.0.bin (
  echo == Downloading Kokoro voices ^(~27 MB^)
  curl -L -o models\voices-v1.0.bin https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin
)

echo.
echo == Setup complete. Render the demo episode with:
echo    venv\Scripts\activate
echo    python pipeline\render_video.py --episode channels\examples\episodes\ep02_engine
endlocal
