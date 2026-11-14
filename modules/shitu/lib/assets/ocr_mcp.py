"""本地 OCR 的 MCP server（stdio）。

工具：
  ocr_image   识别单张图片，返回按行整理的文本
  ocr_json    识别单张图片，返回带坐标与置信度的 JSON

全程本地 ONNXRuntime 推理，不联网、不消耗云端 token。
"""
from __future__ import annotations

import base64
import binascii
import importlib
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from mcp.server.mcpserver import MCPServer  # noqa: E402

import ocr_core  # noqa: E402

mcp = MCPServer(
    name="ocr",
    instructions="本地 OCR 工具。传入图片的绝对路径，返回图片中的文字。",
)


def _core():
    """每轮重新加载 ocr_core，让改代码后无需重启 MCP 进程即可生效。"""
    importlib.reload(ocr_core)
    return ocr_core


def _resolve(path: str) -> str:
    path = os.path.expanduser(path.strip().strip('"').strip("'"))
    if not os.path.isabs(path):
        path = os.path.abspath(path)
    if not os.path.exists(path):
        raise FileNotFoundError(f"图片不存在: {path}")
    return path


@mcp.tool(
    name="ocr_image",
    description="识别图片中的文字，返回按阅读顺序整理的纯文本。支持 png/jpg/jpeg/bmp/webp/tiff。",
)
def ocr_image(path: str, min_score: float = 0.0) -> str:
    """path: 图片绝对路径；min_score: 置信度阈值 0~1，低于该值的结果丢弃。"""
    try:
        core = _core()
        items = core.ocr(_resolve(path), min_score=min_score)
        text = core.plain_text(items)
    except Exception as exc:  # noqa: BLE001
        return f"OCR 失败: {type(exc).__name__}: {exc}"
    return text or "（未识别到文字）"


@mcp.tool(
    name="ocr_json",
    description="识别图片中的文字，返回 JSON：每段文字含 text、score 置信度和 box 四角坐标。",
)
def ocr_json(path: str, min_score: float = 0.0) -> str:
    try:
        items = _core().ocr(_resolve(path), min_score=min_score)
    except Exception as exc:  # noqa: BLE001
        return json.dumps({"error": f"{type(exc).__name__}: {exc}"}, ensure_ascii=False)
    return json.dumps(
        [{"text": i["text"], "score": i["score"], "box": i["box"]} for i in items],
        ensure_ascii=False,
        indent=1,
    )


@mcp.tool(
    name="ocr_base64",
    description="识别 base64 编码的图片（可带 data:image/...;base64, 前缀），返回纯文本。",
)
def ocr_base64(data: str, min_score: float = 0.0) -> str:
    raw = data.strip()
    if raw.startswith("data:"):
        raw = raw.split(",", 1)[-1]
    try:
        blob = base64.b64decode(raw, validate=False)
    except (binascii.Error, ValueError) as exc:
        return f"base64 解码失败: {exc}"
    try:
        core = _core()
        items = core.ocr(blob, min_score=min_score)
        return core.plain_text(items) or "（未识别到文字）"
    except Exception as exc:  # noqa: BLE001
        return f"OCR 失败: {type(exc).__name__}: {exc}"


if __name__ == "__main__":
    mcp.run(transport="stdio")
