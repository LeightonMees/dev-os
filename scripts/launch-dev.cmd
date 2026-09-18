@echo off
rem Launch DEV (desktop app + control plane). This is what the "DEV App" desktop shortcut runs.
rem Prefers the release exe built by `npm run desktop:build`; falls back to `dev ui` (dev mode) if it is missing.
setlocal
set "DEV_REPO_ROOT=%~dp0.."
for %%I in ("%DEV_REPO_ROOT%") do set "DEV_REPO_ROOT=%%~fI"
set "DEV_HOME=%DEV_REPO_ROOT%\.dev-home"

set "EXE="
if defined CARGO_TARGET_DIR if exist "%CARGO_TARGET_DIR%\release\dev-desktop.exe" set "EXE=%CARGO_TARGET_DIR%\release\dev-desktop.exe"
if not defined EXE if exist "%DEV_REPO_ROOT%\apps\desktop\src-tauri\target\release\dev-desktop.exe" set "EXE=%DEV_REPO_ROOT%\apps\desktop\src-tauri\target\release\dev-desktop.exe"

if defined EXE (
  start "" /D "%DEV_REPO_ROOT%" "%EXE%"
  exit /b 0
)

rem No release build: open a visible console so the dev-mode compile output and any error can be read.
start "DEV" /D "%DEV_REPO_ROOT%" cmd /k "echo No release build found (run: npm run desktop:build). Starting in development mode... && node apps\cli\bin\dev.mjs ui"
exit /b 0
