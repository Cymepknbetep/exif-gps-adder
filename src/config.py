"""
项目配置集中管理模块。
所有可调参数统一在此维护，支持从环境变量覆盖。
"""

import os
from pathlib import Path

# 项目根目录（本文件位于 src/ 下，向上退一级即为根目录）
PROJECT_ROOT = Path(__file__).resolve().parent.parent

# 服务器监听配置
HOST: str = os.getenv("EXIF_GPS_HOST", "127.0.0.1")
PORT: int = int(os.getenv("EXIF_GPS_PORT", "5000"))

# 文件上传限制：最大 50MB
MAX_UPLOAD_SIZE: int = int(os.getenv("EXIF_GPS_MAX_UPLOAD_SIZE", "52428800"))

# 静态文件目录（解析为绝对路径）
STATIC_DIR: str = str(PROJECT_ROOT / os.getenv("EXIF_GPS_STATIC_DIR", "src/static"))

# ExifTool 可执行文件路径
EXIFTOOL_PATH: str = str(PROJECT_ROOT / os.getenv("EXIF_GPS_EXIFTOOL_PATH", "tools/exiftool.exe"))

# 日志级别
LOG_LEVEL: str = os.getenv("EXIF_GPS_LOG_LEVEL", "info")
