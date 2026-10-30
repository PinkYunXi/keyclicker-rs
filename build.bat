@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
echo [1/2] 编译 release...
cargo build --release || goto :fail
echo [2/2] 部署到 D:\AITest\KeyClicker-RS\dist ...
if not exist "D:\AITest\KeyClicker-RS\dist" mkdir "D:\AITest\KeyClicker-RS\dist"
copy /y "target\release\keyclicker-rs.exe" "D:\AITest\KeyClicker-RS\dist\keyclicker-rs.exe" >nul || goto :fail
echo.
echo [ok] 已部署：D:\AITest\KeyClicker-RS\dist\keyclicker-rs.exe
exit /b 0
:fail
echo [x] 构建失败
exit /b 1
