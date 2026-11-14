"""共享 OCR 核心：懒加载 RapidOCR 引擎，提供图片识别与行合并。

引擎常驻内存（首次加载约 1.5s），之后单张 1~3 秒。全程本地 ONNXRuntime，
不联网、不消耗云端 token。
"""
from __future__ import annotations

import os
import threading

_engine = None
_lock = threading.Lock()


def ready():
    """引擎是否已加载（不含加载动作）。"""
    return _engine is not None


def get_engine():
    global _engine
    with _lock:
        if _engine is None:
            from rapidocr_onnxruntime import RapidOCR

            _engine = RapidOCR()
        return _engine


def _to_array(img):
    """PIL 图像 → RGB numpy 数组，同时校正 EXIF 方向。"""
    import numpy as np
    from PIL import ImageOps

    img = ImageOps.exif_transpose(img)
    if img.mode != "RGB":
        img = img.convert("RGB")
    return np.array(img)


def _load(image):
    """接受路径 / bytes / PIL.Image，统一返回 numpy 数组。

    统一走 PIL 解码：避免 cv2.imread 在中文路径下返回 None，
    同时处理 EXIF 旋转方向和带 alpha 通道的 PNG。
    """
    import io

    from PIL import Image

    if isinstance(image, (str, os.PathLike)):
        with Image.open(str(image)) as img:
            return _to_array(img)
    if isinstance(image, (bytes, bytearray)):
        with Image.open(io.BytesIO(bytes(image))) as img:
            return _to_array(img)
    return _to_array(image)


def ocr(image, min_score: float = 0.0):
    """返回 [{'text','score','box','cx','cy','h'}]，按阅读顺序（行 → 列）排序。"""
    engine = get_engine()
    result, _elapse = engine(_load(image))
    items = []
    for box, text, score in result or []:
        score = float(score)
        if score < min_score:
            continue
        xs = [p[0] for p in box]
        ys = [p[1] for p in box]
        items.append(
            {
                "text": text,
                "score": round(score, 4),
                "box": [[float(x), float(y)] for x, y in box],
                "cx": sum(xs) / len(xs),
                "cy": sum(ys) / len(ys),
                "h": max(ys) - min(ys),
            }
        )
    return _reading_order(items)


def _reading_order(items):
    """把同一水平带的框聚成行，行内按 x 排序，行间按 y 排序。"""
    if not items:
        return []
    heights = sorted(i["h"] for i in items)
    tol = max(heights[len(heights) // 2] * 0.6, 8.0)

    rows = []
    for it in sorted(items, key=lambda i: i["cy"]):
        placed = False
        for row in rows:
            if abs(row["cy"] - it["cy"]) <= tol:
                row["items"].append(it)
                row["cy"] = sum(x["cy"] for x in row["items"]) / len(row["items"])
                placed = True
                break
        if not placed:
            rows.append({"cy": it["cy"], "items": [it]})

    rows.sort(key=lambda r: r["cy"])
    ordered = []
    for row in rows:
        ordered.extend(sorted(row["items"], key=lambda i: i["cx"]))
    return ordered


def to_lines(items, joiner: str = " "):
    """按行输出纯文本：同一行内相邻框水平间距小时直接拼接，否则插入分隔符。"""
    if not items:
        return []
    heights = sorted(i["h"] for i in items)
    tol = max(heights[len(heights) // 2] * 0.6, 8.0)

    # 先按 y 聚成行（items 已按阅读顺序排列，这里只做切分）
    rows = []
    for it in items:
        if rows and abs(it["cy"] - rows[-1][-1]["cy"]) <= tol:
            rows[-1].append(it)
        else:
            rows.append([it])

    out = []
    for row in rows:
        row = sorted(row, key=lambda i: i["cx"])
        text = row[0]["text"]
        for prev, it in zip(row, row[1:]):
            gap = it["box"][0][0] - prev["box"][1][0]
            text += ("" if gap < prev["h"] * 0.55 else joiner) + it["text"]
        text = text.strip()
        if text:
            out.append(text)
    return out


def plain_text(items):
    return "\n".join(to_lines(items))
