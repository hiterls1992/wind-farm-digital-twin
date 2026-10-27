@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================================
echo   凉城 60 MW 陆上风电项目 - 数字孪生（实测机位）
echo ============================================================
echo.
echo 正在启动本地预览服务 http://127.0.0.1:8123
echo 关闭本窗口即停止服务。
echo.
start "" http://127.0.0.1:8123/index.html
where py >nul 2>nul
if %errorlevel%==0 (
    py -3 -m http.server 8123 --bind 127.0.0.1
) else (
    python -m http.server 8123 --bind 127.0.0.1
)
pause
