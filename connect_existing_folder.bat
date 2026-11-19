@echo off
REM ===========================================================================
REM  Turns a plain copy of this project (files copied by hand, no .git folder)
REM  into a git repository linked to GitHub, on the V3 branch, without touching
REM  venv\, models\ or renders. Afterwards: GitHub Desktop > File > Add local
REM  repository > choose this folder.
REM ===========================================================================
setlocal
cd /d "%~dp0"
set GIT=git
where git >nul 2>nul || set GIT="C:\Program Files\Git\cmd\git.exe"

if exist .git (
  %GIT% remote get-url origin >nul 2>nul && (
    echo This folder is already linked to GitHub - nothing to do.
    goto done
  )
  REM A .git with no remote = a fresh local repo (e.g. GitHub Desktop's "create a repository here"
  REM with an "Initial commit" of these same files). Replace it with the real GitHub history.
  echo == Found an unlinked local repository ^(no GitHub remote^) - replacing it with the GitHub one
  rmdir /s /q .git || goto fail
)

echo == Linking %CD% to GitHub
%GIT% init -q || goto fail
%GIT% remote add origin https://github.com/Ahsan-Mehmood-90757/8-bit-video-gen-pipeline.git || goto fail
%GIT% fetch origin || goto fail
REM point at the V3 branch and adopt the current files as the working copy (nothing is overwritten)
%GIT% symbolic-ref HEAD refs/heads/V3 || goto fail
%GIT% reset -q origin/V3 || goto fail
%GIT% branch -q -u origin/V3 V3 || goto fail

echo.
echo == Linked. Files that differ from GitHub ^(empty list = in sync^):
%GIT% status --short
echo.
echo Next: open GitHub Desktop ^> File ^> Add local repository ^> %CD%
goto done

:fail
echo [!] Something went wrong - see the message above.
:done
pause
endlocal
