# EXIF GPS Adder —— 批量照片地理标记工具

> 解决尼康（及大多数单反/微单）**没有机内GPS**的难题。在浏览器里批量给 NEF、JPG、HEIF 等照片写入 GPS 坐标，无需覆盖原图。

---

## 🎯 为什么做这个项目

尼康（Nikon）绝大多数机身（包括 Z6/Z7/Z8/Zf 系列、D850、D7500 等）**没有内置 GPS 模块**。拍完照片后，如果要记录拍摄地点，只能依赖手机 SnapBridge 的弱鸡同步，或者事后在 Lightroom 里一张张手动标记。

这个工具让你：**在电脑上打开浏览器 → 选择文件夹 → 地图选点 → 批量写入 GPS**。一次可以处理几百张，支持 NEF 原片直接写坐标，不用先转 JPG。

---

## ✨ 核心功能

| 功能 | 说明 |
|------|------|
| 📁 **文件夹级批量处理** | 扫描整个文件夹，一次性处理成百上千张照片 |
| 🗂️ **任务队列（多组坐标）** | 一趟旅行在不同地点拍了多组照片？添加多个任务，每组照片设置不同坐标，一次性全部处理 |
| 📷 **RAW 直出支持** | **NEF** (尼康)、CR2/CR3 (佳能)、ARW (索尼)、RAF (富士)、ORF (奥林巴斯)、DNG、HIF/HEIF 等，直接写 GPS，不转格式 |
| 🗺️ **地图选点 + 坐标切换** | 内置高德地图，支持 **GCJ-02（国内地图兼容）/ WGS-84（国际通用）** 一键切换 |
| 🛡️ **安全不覆盖原图** | 读取源文件夹 → 输出到新目录，原始照片永远不动 |
| ⚡ **并发处理** | 自动按文件大小和数量拆分批次，后台并行写入，几百张也是秒级 |

---

## 📷 支持的格式

### 标准格式
- JPG / JPEG / PNG / TIFF / BMP / GIF / WebP

### RAW 原片（重点）
- **NEF** — 尼康 (Nikon) ✅
- CR2 / CR3 — 佳能 (Canon)
- ARW — 索尼 (Sony)
- RAF — 富士 (Fujifilm)
- ORF — 奥林巴斯 (Olympus)
- RW2 — 松下 (Panasonic)
- PEF — 宾得 (Pentax)
- DNG — Adobe 通用
- 以及 SRW、X3F、ERF、MOS、IIQ、3FR、MEF、NRW 等

### 其他
- HIF / HEIF / HEIC — 苹果/尼康高效图像格式

> RAW 格式写入依赖 [ExifTool](https://exiftool.org/)，标准格式（JPG/PNG 等）使用纯 Python 的 piexif，无需额外依赖。

---

## 🚀 快速开始

### 环境要求
- Python 3.11+
- Windows（文件夹选择对话框目前仅支持 Windows，其他系统可手动输入路径）

### 1. 克隆项目
```bash
git clone https://github.com/yourname/exif-gps-adder.git
cd exif-gps-adder
```

### 2. 安装 Python 依赖
```bash
conda activate exif_gps   # 或你的虚拟环境
pip install -r requirements.txt
```

### 3. 安装 ExifTool（处理 RAW 必需）
- 下载 ExifTool Windows 可执行版：[https://exiftool.org/](https://exiftool.org/)
- 将 `exiftool(-k).exe` **重命名**为 `exiftool.exe`
- 放到项目根目录的 `tools/` 文件夹下（即 `tools/exiftool.exe`）

> 如果 ExifTool 路径不同，可通过环境变量 `EXIF_GPS_EXIFTOOL_PATH` 指定。

### 4. 启动
```bash
python src/main.py
```
浏览器自动打开（或手动访问）：http://127.0.0.1:5000

---

## 🗺️ 使用流程

1. **设置源文件夹** → 选择你存放 NEF/JPG 的目录 → 点击「扫描文件」
2. **生成缩略图**（可选）→ 方便在列表中辨认照片
3. **勾选照片** → 支持 Ctrl 点选、全选、范围选中（选首尾自动选中中间全部）
4. **地图上选点** → 点击「在地图上选点」→ 在地图上点击目标位置 → 坐标自动填充
5. **添加到任务队列** → 可以给不同批次的照片设置不同坐标
6. **开始处理** → 输出到新文件夹，原图不受影响

---

## 🛠 技术栈

| 层级 | 技术 |
|------|------|
| 后端 | Python 3.11 + FastAPI |
| EXIF 写入 | piexif（JPG/PNG）+ ExifTool（RAW/HEIF） |
| 地图 | Leaflet.js + 高德地图 / CartoDB |
| 前端 | 原生 HTML5 / CSS3 / JavaScript（无前端框架依赖） |
| 坐标转换 | 内置 GCJ-02 ↔ WGS-84 算法 |

---

## ⚠️ 注意事项

- **备份习惯**：虽然工具默认不覆盖原图（输出到独立目录），但处理重要照片前仍建议备份。
- **RAW 写入速度**：NEF 等 RAW 文件体积较大（20~50MB/张），批量处理时受磁盘 I/O 限制，几百张可能需要几分钟，请耐心等待。
- **坐标系选择**：国内用户如果照片要配合高德/百度/腾讯地图展示，建议勾选「GCJ-02」；如果上传到 Flickr/Google Photos/Apple Photos，建议不勾选（使用 WGS-84）。

---

## 📄 License

MIT License

---

> **尼康用户说**：Z6III 还是没有 GPS，但有了这个工具，拍完回家 5 分钟就能给整趟旅行的 NEF 标上地点。
