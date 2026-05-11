@echo off
chcp 65001 >nul
setlocal

:: ====== 自动寻找可用的 Python ======
set "PYTHON_CMD="

:: 优先尝试 conda 环境（多个常见安装路径）
for %%p in (
    "%USERPROFILE%\.conda\envs\exif_gps\python.exe"
    "%USERPROFILE%\anaconda3\envs\exif_gps\python.exe"
    "%USERPROFILE%\miniconda3\envs\exif_gps\python.exe"
) do (
    if exist "%%~p" (
        set "PYTHON_CMD=%%~p"
        goto :found_python
    )
)

:: 回退到系统 PATH 中的 python
where python >nul 2>nul
if %ERRORLEVEL% equ 0 (
    set "PYTHON_CMD=python"
    goto :found_python
)

echo [错误] 未找到可用的 Python。
echo 请确保 Python 3.11+ 已安装且加入 PATH，或创建名为 exif_gps 的 conda 环境。
pause
exit /b 1

:found_python
echo [使用 Python] %PYTHON_CMD%

:: 保持在项目根目录运行
cd /d "%~dp0"
set PYTHONIOENCODING=utf-8
set PYTHONUTF8=1

echo.
echo 正在启动服务: http://127.0.0.1:5000
echo 请在浏览器中设置源文件夹和输出文件夹
echo.

:: 自动打开浏览器（不阻塞）
start http://127.0.0.1:5000

:: 启动服务
"%PYTHON_CMD%" src/main.py

pause
