"""
EXIF GPS 写入核心模块。

职责：
- 十进制坐标 ↔ 度分秒（DMS）格式转换
- 组装 EXIF GPS IFD
- 调用 piexif 写入 JPEG/PNG/TIFF
- 调用 ExifTool 写入 RAW 等格式
"""

import io
import math
import base64
import subprocess
import tempfile
import os
from typing import Optional, Tuple
from pathlib import Path

import piexif

import sys
from pathlib import Path as _Path
_PROJECT_ROOT = _Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(_PROJECT_ROOT / "src"))
import config

# RAW / 非标准格式的扩展名集合（需用 ExifTool）
RAW_EXTENSIONS = {
    ".nef", ".cr2", ".cr3", ".arw", ".raf", ".orf", ".rw2", ".pef", ".dng",
    ".srw", ".x3f", ".erf", ".mos", ".iiq", ".3fr", ".mef", ".nrw",
    ".hif", ".heif", ".heic",
}


def decimal_to_dms(decimal: float) -> Tuple[Tuple[int, int], Tuple[int, int], Tuple[int, int]]:
    """
    将十进制度数转换为 EXIF GPS 所需的度分秒有理数元组。

    返回格式: ((度, 1), (分, 1), (秒分子, 秒分母))
    秒保留两位小数，以有理数形式存储。

    Args:
        decimal: 十进制度数，如 39.9042

    Returns:
        DMS 元组，供 piexif 使用
    """
    abs_val = abs(decimal)
    degrees = int(abs_val)
    minutes_float = (abs_val - degrees) * 60.0
    minutes = int(minutes_float)
    seconds = (minutes_float - minutes) * 60.0

    # 保留两位小数，避免浮点精度问题
    seconds_num = int(round(seconds * 100))
    seconds_den = 100

    # 处理进位（如 59.999 秒应进位为 60 秒 = 1 分）
    if seconds_num >= 6000:
        seconds_num = 0
        minutes += 1
    if minutes >= 60:
        minutes = 0
        degrees += 1

    return ((degrees, 1), (minutes, 1), (seconds_num, seconds_den))


def _write_gps_piexif(image_bytes: bytes, lat: float, lng: float, altitude: Optional[float]) -> bytes:
    """使用 piexif 写入 GPS（JPEG/PNG/TIFF）。"""
    exif_dict = piexif.load(image_bytes)

    gps_ifd = {
        piexif.GPSIFD.GPSLatitudeRef: "N" if lat >= 0 else "S",
        piexif.GPSIFD.GPSLatitude: decimal_to_dms(lat),
        piexif.GPSIFD.GPSLongitudeRef: "E" if lng >= 0 else "W",
        piexif.GPSIFD.GPSLongitude: decimal_to_dms(lng),
    }

    if altitude is not None:
        gps_ifd[piexif.GPSIFD.GPSAltitudeRef] = 0 if altitude >= 0 else 1
        alt_abs = abs(altitude)
        gps_ifd[piexif.GPSIFD.GPSAltitude] = (int(round(alt_abs * 100)), 100)

    exif_dict["GPS"] = gps_ifd

    exif_bytes = piexif.dump(exif_dict)
    output = io.BytesIO()
    piexif.insert(exif_bytes, image_bytes, output)
    return output.getvalue()


def _write_gps_exiftool(image_bytes: bytes, lat: float, lng: float, altitude: Optional[float]) -> bytes:
    """使用 ExifTool 写入 GPS（RAW 及其他格式）。"""
    exiftool_path = config.EXIFTOOL_PATH
    if not os.path.isfile(exiftool_path):
        raise RuntimeError(f"ExifTool 未找到: {exiftool_path}")

    with tempfile.NamedTemporaryFile(suffix=".tmp", delete=False) as fin:
        fin.write(image_bytes)
        input_path = fin.name

    output_path = input_path + ".out"

    try:
        cmd = [
            exiftool_path,
            f"-GPSLatitude={lat}",
            f"-GPSLatitudeRef={'N' if lat >= 0 else 'S'}",
            f"-GPSLongitude={lng}",
            f"-GPSLongitudeRef={'E' if lng >= 0 else 'W'}",
            "-overwrite_original",
            "-o", output_path,
            input_path,
        ]
        if altitude is not None:
            cmd.insert(-3, f"-GPSAltitude={abs(altitude)}")
            cmd.insert(-3, f"-GPSAltitudeRef={'Above Sea Level' if altitude >= 0 else 'Below Sea Level'}")

        result = subprocess.run(cmd, capture_output=True, check=False)
        if result.returncode != 0:
            stderr = result.stderr.decode('utf-8', errors='replace') if result.stderr else ''
            raise RuntimeError(f"ExifTool 错误 (code={result.returncode}): {stderr}")

        with open(output_path, "rb") as f:
            return f.read()
    finally:
        for p in (input_path, output_path, input_path + "_original"):
            if os.path.exists(p):
                os.remove(p)


def write_gps(
    image_bytes: bytes,
    lat: float,
    lng: float,
    altitude: Optional[float] = None,
    filename: Optional[str] = None,
) -> bytes:
    """
    将 GPS 坐标写入图片的 EXIF 元数据中。

    保留图片原有的其他 EXIF 标签，仅新增或覆盖 GPS 相关标签。
    JPEG/PNG/TIFF 使用 piexif（纯 Python），RAW 等格式自动回退到 ExifTool。

    Args:
        image_bytes: 原始图片的二进制数据
        lat: 纬度，十进制度数，范围 [-90, 90]
        lng: 经度，十进制度数，范围 [-180, 180]
        altitude: 海拔高度（米），可选
        filename: 原始文件名（用于判断是否为 RAW 格式）

    Returns:
        写入 GPS 后的图片二进制数据

    Raises:
        ValueError: 坐标超出有效范围
        RuntimeError: EXIF 写入失败
    """
    if not (-90.0 <= lat <= 90.0):
        raise ValueError(f"纬度必须在 [-90, 90] 范围内，当前: {lat}")
    if not (-180.0 <= lng <= 180.0):
        raise ValueError(f"经度必须在 [-180, 180] 范围内，当前: {lng}")

    ext = Path(filename).suffix.lower() if filename else ""
    use_exiftool = ext in RAW_EXTENSIONS

    if not use_exiftool:
        try:
            return _write_gps_piexif(image_bytes, lat, lng, altitude)
        except Exception as exc:
            # piexif 失败且文件可能是 RAW，回退到 ExifTool
            if ext in RAW_EXTENSIONS or "Wrong JPEG data" in str(exc):
                pass
            else:
                raise RuntimeError(f"写入 EXIF GPS 失败: {exc}") from exc

    try:
        return _write_gps_exiftool(image_bytes, lat, lng, altitude)
    except Exception as exc:
        raise RuntimeError(f"写入 EXIF GPS 失败: {exc}") from exc


# =============================================================================
# 内联单元测试
# =============================================================================

_TEST_IMAGE_PATH = r"d:\file\local_tools\exif_gps_adder\test_data\DSC_2997.JPG"


def _load_test_image() -> bytes:
    """加载测试用真实图片。"""
    with open(_TEST_IMAGE_PATH, "rb") as f:
        return f.read()


def _assert_float_eq(a: float, b: float, eps: float = 1e-4) -> None:
    """断言两个浮点数近似相等。"""
    assert abs(a - b) < eps, f"{a} != {b} (eps={eps})"


def _dms_to_decimal(dms: Tuple, ref: str) -> float:
    """将 DMS 元组转回十进制度数，用于验证。"""
    degrees = dms[0][0] / dms[0][1]
    minutes = dms[1][0] / dms[1][1]
    seconds = dms[2][0] / dms[2][1]
    decimal = degrees + minutes / 60.0 + seconds / 3600.0
    if ref in ("S", "W"):
        decimal = -decimal
    return decimal


if __name__ == "__main__":
    print("[测试] 开始运行 writer 模块内联测试...")

    # --- 测试 1: decimal_to_dms 正确性 ---
    print("[测试] decimal_to_dms ...")
    # 39.9042°N -> 39°54'15.12"
    dms = decimal_to_dms(39.9042)
    assert dms[0] == (39, 1)
    assert dms[1] == (54, 1)
    assert dms[2][0] / dms[2][1] == 15.12

    # 116.4074°E -> 116°24'26.64"
    dms = decimal_to_dms(116.4074)
    assert dms[0] == (116, 1)
    assert dms[1] == (24, 1)
    _assert_float_eq(dms[2][0] / dms[2][1], 26.64)

    # 负数应取绝对值（符号由 Ref 处理）
    dms = decimal_to_dms(-39.9042)
    assert dms[0] == (39, 1)
    assert dms[1] == (54, 1)

    # 边界：0°
    dms = decimal_to_dms(0.0)
    assert dms == ((0, 1), (0, 1), (0, 100))

    print("[测试] decimal_to_dms 通过 ✓")

    # --- 测试 2: write_gps 参数校验 ---
    print("[测试] 参数校验 ...")
    img = _load_test_image()
    try:
        write_gps(img, lat=91.0, lng=0.0)
        assert False, "应抛出 ValueError"
    except ValueError:
        pass

    try:
        write_gps(img, lat=0.0, lng=181.0)
        assert False, "应抛出 ValueError"
    except ValueError:
        pass

    print("[测试] 参数校验通过 ✓")

    # --- 测试 3: write_gps 成功写入并回读 ---
    print("[测试] EXIF GPS 写入与回读 ...")
    img = _load_test_image()
    result = write_gps(img, lat=39.9042, lng=116.4074, altitude=35.5)
    assert isinstance(result, bytes)
    assert len(result) > 0

    # 用 piexif 回读验证
    exif_dict = piexif.load(result)
    gps = exif_dict["GPS"]
    assert gps[piexif.GPSIFD.GPSLatitudeRef] == b"N"
    assert gps[piexif.GPSIFD.GPSLongitudeRef] == b"E"

    lat_back = _dms_to_decimal(gps[piexif.GPSIFD.GPSLatitude], "N")
    lng_back = _dms_to_decimal(gps[piexif.GPSIFD.GPSLongitude], "E")
    _assert_float_eq(lat_back, 39.9042)
    _assert_float_eq(lng_back, 116.4074)

    # 海拔
    alt_val = gps[piexif.GPSIFD.GPSAltitude]
    alt_back = alt_val[0] / alt_val[1]
    _assert_float_eq(alt_back, 35.5)
    assert gps[piexif.GPSIFD.GPSAltitudeRef] == 0

    print("[测试] EXIF GPS 写入与回读通过 ✓")

    # --- 测试 4: 南纬、西经、负海拔 ---
    print("[测试] 南纬西经负海拔 ...")
    img = _load_test_image()
    result = write_gps(img, lat=-33.8688, lng=151.2093, altitude=-10.0)
    exif_dict = piexif.load(result)
    gps = exif_dict["GPS"]
    assert gps[piexif.GPSIFD.GPSLatitudeRef] == b"S"
    assert gps[piexif.GPSIFD.GPSLongitudeRef] == b"E"
    assert gps[piexif.GPSIFD.GPSAltitudeRef] == 1  # 负海拔
    alt_back = gps[piexif.GPSIFD.GPSAltitude][0] / gps[piexif.GPSIFD.GPSAltitude][1]
    _assert_float_eq(alt_back, 10.0)

    print("[测试] 南纬西经负海拔通过 ✓")

    # --- 测试 5: 无海拔参数时不写入海拔标签 ---
    print("[测试] 无海拔参数 ...")
    img = _load_test_image()
    result = write_gps(img, lat=0.0, lng=0.0)
    exif_dict = piexif.load(result)
    gps = exif_dict["GPS"]
    assert piexif.GPSIFD.GPSAltitude not in gps
    assert piexif.GPSIFD.GPSAltitudeRef not in gps

    print("[测试] 无海拔参数通过 ✓")

    print("\n[测试] 全部通过！writer 模块内联测试完成。")
