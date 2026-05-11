#!/usr/bin/env python3
"""
PyInstaller 打包脚本。

生成独立可执行文件（Windows），用户无需安装 Python 即可运行。

用法:
    python scripts/build.py

输出:
    dist/EXIF_GPS_Adder/EXIF_GPS_Adder.exe
"""

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent

# 自动检测 conda 环境路径
CONDA_ENV = Path(sys.executable).parent
LIBRARY_BIN = CONDA_ENV / "Library" / "bin" if (CONDA_ENV / "Library" / "bin").exists() else None

cmd = [
    sys.executable, "-m", "PyInstaller",
    "--onedir",
    "--distpath", str(PROJECT_ROOT / "outputs"),
    "--name", "EXIF_GPS_Adder",
    "--add-data", f"src/static{os.pathsep}src/static",
    "--add-data", f"tools{os.pathsep}tools",
    "--hidden-import", "uvicorn.logging",
    "--hidden-import", "uvicorn.loops.auto",
    "--hidden-import", "uvicorn.protocols.http.auto",
    "--noconfirm",
]

# conda 环境的 Library/bin 有大量 PyInstaller 遗漏的 DLL，批量补齐
if LIBRARY_BIN:
    tmp_dir = tempfile.mkdtemp(prefix="exif_gps_dlls_")
    copied = 0
    for dll in LIBRARY_BIN.glob("*.dll"):
        shutil.copy2(dll, tmp_dir)
        copied += 1
    print(f"[build] 从 {LIBRARY_BIN} 复制了 {copied} 个 DLL 到临时目录")
    cmd.extend(["--add-data", f"{tmp_dir}{os.pathsep}."])

cmd.append(str(PROJECT_ROOT / "src" / "main.py"))

print("[build] 执行命令:")
print(" ".join(cmd))
print()
try:
    subprocess.run(cmd, check=True)
finally:
    if LIBRARY_BIN and 'tmp_dir' in locals():
        shutil.rmtree(tmp_dir, ignore_errors=True)

print()
print("[build] 打包完成。输出目录: dist/EXIF_GPS_Adder/")
