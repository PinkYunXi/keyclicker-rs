@echo off
setlocal
cd /d "%~dp0"

echo [1/3] Generating embedded UI assets...
python tools\gen_ui_assets.py
if errorlevel 1 goto fail

echo [2/3] Building release...
cargo build --release
if errorlevel 1 goto fail

echo [3/3] Copying to dist...
if not exist "dist" mkdir "dist"
copy /y "target\release\keyclicker-rs.exe" "dist\keyclicker-rs.exe" >nul
if errorlevel 1 goto fail

echo.
echo [ok] Output: %cd%\dist\keyclicker-rs.exe
exit /b 0

:fail
echo [x] Build failed
exit /b 1
