"""
FastAPI 主入口模块（本地处理模式）。

职责：
- 创建 FastAPI 应用实例
- 提供本地文件扫描、缩略图生成、本地文件 GPS 写入
- 挂载前端静态文件
- 启动 uvicorn 服务
"""

import asyncio
import io
import os
import sys
import time
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_PROJECT_ROOT))

from fastapi import FastAPI, File, Form, Request, UploadFile, HTTPException
from fastapi.responses import FileResponse, StreamingResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from typing import List

import config
from src.exif_gps.writer import write_gps

_executor = ThreadPoolExecutor(max_workers=min(32, (os.cpu_count() or 4) * 2))

# ============ 本地工作区配置 ============
_workspace = {
    "source": "",
    "output": str(Path.home() / "Downloads"),
}

THUMBS_DIR = _PROJECT_ROOT / "outputs" / "thumbs"
THUMBS_DIR.mkdir(parents=True, exist_ok=True)

_IMAGE_EXTS = {
    ".jpg", ".jpeg", ".png", ".tiff", ".tif",
    ".nef", ".cr2", ".cr3", ".arw", ".raf", ".orf", ".rw2", ".pef", ".dng",
    ".srw", ".x3f", ".erf", ".mos", ".iiq", ".3fr", ".mef", ".nrw",
    ".hif", ".heif", ".heic",
}


def _is_image(name: str) -> bool:
    return Path(name).suffix.lower() in _IMAGE_EXTS


def _get_source_files() -> List[Path]:
    src = _workspace["source"]
    if not src or not os.path.isdir(src):
        return []
    return sorted([f for f in Path(src).iterdir() if f.is_file() and _is_image(f.name)])


# ============ FastAPI 应用 ============
app = FastAPI(title="EXIF GPS Adder", version="2.0.0")


@app.middleware("http")
async def log_request_time(request: Request, call_next):
    start = time.time()
    response = await call_next(request)
    elapsed = time.time() - start
    if request.url.path.startswith("/api/"):
        print(f"[TIMING] {request.method} {request.url.path} | {elapsed*1000:.1f}ms | status={response.status_code}")
    return response


# 静态文件（前端 + 缩略图）
app.mount("/static", StaticFiles(directory=config.STATIC_DIR), name="static")
app.mount("/thumbs", StaticFiles(directory=str(THUMBS_DIR)), name="thumbs")


@app.get("/")
async def root():
    return FileResponse(Path(config.STATIC_DIR) / "index.html")


# ============ 工作区配置 API ============

@app.post("/api/config")
async def set_config(source: str = Form(""), output: str = Form("")):
    """设置源文件夹和输出文件夹路径。"""
    if source:
        _workspace["source"] = source
    if output:
        _workspace["output"] = output
    return {"source": _workspace["source"], "output": _workspace["output"]}


@app.get("/api/config")
async def get_config():
    return {"source": _workspace["source"], "output": _workspace["output"]}


# ============ 文件夹选择对话框（Windows）============

@app.get("/api/pick-folder")
async def api_pick_folder():
    """弹出系统文件夹选择对话框，返回绝对路径（仅 Windows）。"""
    import subprocess

    def run_dialog():
        import threading, time
        # 使用 FolderBrowserDialog 更稳定，且支持 ShowDialog 前置窗口
        ps = (
            'Add-Type -AssemblyName System.Windows.Forms; '
            '$owner = New-Object System.Windows.Forms.Form; '
            '$owner.TopMost = $true; '
            '$owner.StartPosition = "CenterScreen"; '
            '$owner.Size = New-Object System.Drawing.Size(1,1); '
            '$owner.ShowInTaskbar = $false; '
            '$owner.Show(); '
            '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog; '
            '$dialog.Description = "选择文件夹"; '
            '$result = $dialog.ShowDialog($owner); '
            '$owner.Close(); '
            'if ($result -eq [System.Windows.Forms.DialogResult]::OK) { $dialog.SelectedPath } else { "CANCELLED" }'
        )
        proc = subprocess.Popen(
            ["powershell", "-Command", ps],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
        )

        # 强制 30 秒超时（subprocess.run 的 timeout 对 GUI 弹框进程不可靠）
        def _killer():
            time.sleep(30)
            try:
                proc.kill()
            except Exception:
                pass
        threading.Thread(target=_killer, daemon=True).start()

        stdout, _ = proc.communicate()
        return stdout.strip()

    loop = asyncio.get_event_loop()
    try:
        path = await loop.run_in_executor(None, run_dialog)
        if path == "CANCELLED" or not path:
            return {"cancelled": True}
        return {"path": path}
    except subprocess.TimeoutExpired:
        return {"timeout": True}
    except Exception as e:
        return {"error": str(e)}


# ============ 文件列表与缩略图 ============

@app.get("/api/files")
async def list_files():
    """扫描源文件夹，返回图片文件列表（含缩略图信息）。"""
    files = _get_source_files()
    result = []
    for f in files:
        thumb_name = f.stem + ".jpg"
        thumb_path = THUMBS_DIR / thumb_name
        has_thumb = thumb_path.exists()
        result.append({
            "name": f.name,
            "size": f.stat().st_size,
            "hasThumb": has_thumb,
            "thumbUrl": f"/thumbs/{thumb_name}" if has_thumb else None,
        })
    return {"files": result, "count": len(result)}


@app.post("/api/thumbs/generate")
async def generate_thumbs():
    """为源文件夹中所有图片生成缩略图。"""
    files = _get_source_files()
    generated = 0
    failed = 0

    for f in files:
        thumb_path = THUMBS_DIR / (f.stem + ".jpg")
        if thumb_path.exists():
            continue
        try:
            _generate_thumb(f, thumb_path)
            generated += 1
        except Exception as e:
            print(f"[thumb] 失败: {f.name} - {e}")
            failed += 1

    return {"generated": generated, "failed": failed}


def _generate_thumb(src: Path, dst: Path):
    """生成缩略图，支持 JPG/PNG/TIFF 和 RAW（通过 Pillow + rawpy 或 ExifTool 预览）。"""
    ext = src.suffix.lower()

    # 优先用 Pillow 处理标准格式
    if ext in (".jpg", ".jpeg", ".png", ".tiff", ".tif", ".bmp", ".gif", ".webp"):
        from PIL import Image
        img = Image.open(src)
        img.thumbnail((200, 200))
        # 转换为 RGB 避免保存错误
        if img.mode in ("RGBA", "P"):
            img = img.convert("RGB")
        img.save(dst, "JPEG", quality=85)
        return

    # RAW 格式：尝试用 ExifTool 提取预览图
    exiftool_path = config.EXIFTOOL_PATH
    if os.path.isfile(exiftool_path):
        import subprocess
        preview_path = dst.with_suffix(".preview.tmp")
        try:
            subprocess.run(
                [exiftool_path, "-b", "-PreviewImage", str(src)],
                stdout=open(preview_path, "wb"),
                stderr=subprocess.DEVNULL,
                check=False,
                timeout=10,
            )
            if preview_path.exists() and preview_path.stat().st_size > 1000:
                from PIL import Image
                img = Image.open(preview_path)
                img.thumbnail((200, 200))
                if img.mode in ("RGBA", "P"):
                    img = img.convert("RGB")
                img.save(dst, "JPEG", quality=85)
                preview_path.unlink(missing_ok=True)
                return
            preview_path.unlink(missing_ok=True)
        except Exception:
            preview_path.unlink(missing_ok=True)

    # RAW 无预览图：生成纯色占位缩略图
    from PIL import Image
    img = Image.new("RGB", (200, 150), color="#333")
    img.save(dst, "JPEG", quality=85)


# ============ GPS 写入（本地文件模式） ============

@app.post("/api/gps/write_local")
async def api_gps_write_local(
    indices: List[int] = Form(...),
    lat: float = Form(...),
    lng: float = Form(...),
    altitude: float = Form(None),
):
    """
    直接读写本地文件写入 GPS。
    indices: 文件在源文件夹排序后的索引列表。
    """
    source_dir = _workspace["source"]
    output_dir = _workspace["output"]

    if not source_dir or not os.path.isdir(source_dir):
        raise HTTPException(status_code=400, detail="未设置源文件夹")
    if not output_dir:
        raise HTTPException(status_code=400, detail="未设置输出文件夹")

    files = _get_source_files()
    out_path = Path(output_dir)
    out_path.mkdir(parents=True, exist_ok=True)

    processed = 0
    failed = 0

    _sem = asyncio.Semaphore(8)

    async def _process_one(idx: int):
        nonlocal processed, failed
        if idx < 0 or idx >= len(files):
            failed += 1
            return
        src = files[idx]
        try:
            with open(src, "rb") as f:
                data = f.read()

            async with _sem:
                result = await asyncio.get_event_loop().run_in_executor(
                    _executor,
                    write_gps,
                    data, lat, lng, altitude, src.name,
                )

            dst = out_path / src.name
            with open(dst, "wb") as f:
                f.write(result)
            processed += 1
        except Exception as e:
            print(f"[write_local] 失败: {src.name} - {e}")
            failed += 1

    await asyncio.gather(*[_process_one(i) for i in indices])

    return {
        "processed": processed,
        "failed": failed,
        "output_dir": str(out_path),
    }


@app.post("/api/gps/write_local_batch")
async def api_gps_write_local_batch(
    indices: List[int] = Form(...),
    lat: float = Form(...),
    lng: float = Form(...),
    altitude: float = Form(None),
):
    """
    与 write_local 相同，但返回 ZIP（兼容旧前端逻辑，实际不推荐用）。
    """
    source_dir = _workspace["source"]
    output_dir = _workspace["output"]

    if not source_dir or not os.path.isdir(source_dir):
        raise HTTPException(status_code=400, detail="未设置源文件夹")

    files = _get_source_files()
    out_path = Path(output_dir)
    out_path.mkdir(parents=True, exist_ok=True)

    processed = 0
    _sem = asyncio.Semaphore(8)

    async def _process_one(idx: int):
        nonlocal processed
        if idx < 0 or idx >= len(files):
            return None
        src = files[idx]
        with open(src, "rb") as f:
            data = f.read()

        async with _sem:
            result = await asyncio.get_event_loop().run_in_executor(
                _executor,
                write_gps,
                data, lat, lng, altitude, src.name,
            )

        # 直接写入输出目录，不返回 bytes
        dst = out_path / src.name
        with open(dst, "wb") as f:
            f.write(result)
        processed += 1
        return src.name

    await asyncio.gather(*[_process_one(i) for i in indices])

    return {"processed": processed, "output_dir": str(out_path)}


# ============ 启动 ============
if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host=config.HOST, port=config.PORT, reload=False, log_level=config.LOG_LEVEL)
