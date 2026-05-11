@echo off
chcp 65001 >nul
setlocal

:: 设置 conda 环境路径（根据你的安装位置调整）
set CONDA_PATH=C:\Users\%USERNAME%\.conda\envs\exif_gps

:: 检查 conda 环境是否存在
if not exist "%CONDA_PATH%\python.exe" (
    echo [错误] 未找到 conda 环境: %CONDA_PATH%
    echo 请确认 exif_gps 环境已创建，或修改本脚本中的 CONDA_PATH。
    pause
    exit /b 1
)

:: 弹出文件夹选择框选源文件夹
powershell -NoProfile -Command "
Add-Type -AssemblyName System.Windows.Forms
$dlg = New-Object System.Windows.Forms.FolderBrowserDialog
$dlg.Description = '请选择源文件夹（包含原始照片）'
$dlg.ShowNewFolderButton = $false
if ($dlg.ShowDialog() -eq 'OK') {
    $dlg.SelectedPath | Set-Content -Path '%TEMP%\exif_gps_source.txt' -Encoding UTF8
} else {
    exit 1
}
"
if %ERRORLEVEL% neq 0 (
    echo 已取消选择
    exit /b 0
)
set /p SOURCE_DIR=<%TEMP%\exif_gps_source.txt

:: 弹出文件夹选择框选输出文件夹
powershell -NoProfile -Command "
Add-Type -AssemblyName System.Windows.Forms
$dlg = New-Object System.Windows.Forms.FolderBrowserDialog
$dlg.Description = '请选择输出文件夹（GPS 写入后的照片保存位置）'
$dlg.ShowNewFolderButton = $true
$dlg.RootFolder = 'MyComputer'
$defaultPath = [Environment]::GetFolderPath('UserProfile') + '\Downloads'
$dlg.SelectedPath = $defaultPath
if ($dlg.ShowDialog() -eq 'OK') {
    $dlg.SelectedPath | Set-Content -Path '%TEMP%\exif_gps_output.txt' -Encoding UTF8
} else {
    exit 1
}
"
if %ERRORLEVEL% neq 0 (
    echo 已取消选择
    exit /b 0
)
set /p OUTPUT_DIR=<%TEMP%\exif_gps_output.txt

echo.
echo [源文件夹] %SOURCE_DIR%
echo [输出文件夹] %OUTPUT_DIR%
echo.

:: 启动服务
cd /d "%~dp0\src"
set PYTHONIOENCODING=utf-8
set PYTHONUTF8=1
"%CONDA_PATH%\python.exe" -c "
import main
main._workspace['source'] = r'%SOURCE_DIR%'
main._workspace['output'] = r'%OUTPUT_DIR%'
print(f'[配置] 源文件夹: %SOURCE_DIR%')
print(f'[配置] 输出文件夹: %OUTPUT_DIR%')
"

echo 正在启动服务...
"%CONDA_PATH%\python.exe" main.py

pause
