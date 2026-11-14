"""stdin → stdout 的 OCR 调用入口，给 aurabot 识图模块用。

一次调用可以带多张图，进程只起一次、模型只加载一次，适合批量。

约定
  stdin : 一个 JSON 对象
          {
            "images": [
              { "id": "任意标识", "data": "<base64>", "mediaType": "image/jpeg" },
              { "id": "b", "path": "D:\\a.png" }
            ],
            "minScore": 0.0,
            "withBoxes": false | true
          }
  stdout: 一行 JSON
          {
            "ok": true,
            "engine": "rapidocr-onnxruntime 1.4.4",
            "results": [
              { "id": "...", "ok": true, "text": "...", "lines": ["..."],
                "items": [{"text","score","box"}],   // withBoxes 时才有
                "elapsedMs": 123 }
            ]
          }

stdout 只输出这一行 JSON，任何调试信息都走 stderr —— 宿主按行读，
多写一个字都会解析失败。
"""
from __future__ import annotations

import base64
import binascii
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import ocr_core  # noqa: E402


def _b64(data: str) -> bytes:
    raw = (data or "").strip()
    if raw.startswith("data:"):
        raw = raw.split(",", 1)[-1]
    return base64.b64decode(raw, validate=False)


def _engine_version() -> str:
    try:
        from importlib.metadata import version

        return "rapidocr-onnxruntime " + version("rapidocr-onnxruntime")
    except Exception:  # noqa: BLE001
        return "rapidocr-onnxruntime (unknown)"


def handle(job: dict) -> dict:
    min_score = float(job.get("minScore") or 0.0)
    with_boxes = bool(job.get("withBoxes"))
    images = job.get("images") or []
    results = []

    for i, img in enumerate(images):
        rid = str(img.get("id") or i)
        started = time.time()
        try:
            if img.get("path"):
                source = img["path"]
            elif img.get("data"):
                source = _b64(img["data"])
            else:
                raise ValueError("这张图既没有 data 也没有 path")
            items = ocr_core.ocr(source, min_score=min_score)
            lines = ocr_core.to_lines(items)
            out = {
                "id": rid,
                "ok": True,
                "text": "\n".join(lines),
                "lines": lines,
                "elapsedMs": int((time.time() - started) * 1000),
            }
            if with_boxes:
                out["items"] = [
                    {"text": x["text"], "score": x["score"], "box": x["box"]} for x in items
                ]
            results.append(out)
        except Exception as exc:  # noqa: BLE001
            results.append(
                {
                    "id": rid,
                    "ok": False,
                    "error": f"{type(exc).__name__}: {exc}",
                    "elapsedMs": int((time.time() - started) * 1000),
                }
            )

    ok = any(r.get("ok") for r in results) if results else True
    return {"ok": ok, "engine": _engine_version(), "results": results}


def main() -> int:
    try:
        raw = sys.stdin.read()
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "fatal": f"读 stdin 失败: {exc}"}, ensure_ascii=False))
        return 2

    try:
        job = json.loads(raw or "{}")
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "fatal": f"stdin 不是合法 JSON: {exc}"}, ensure_ascii=False))
        return 2

    # 预热 / 自检：跑一次空任务也会加载模型，用来量冷启动时间
    if job.get("warmup"):
        started = time.time()
        try:
            ocr_core.get_engine()
            elapsed = int((time.time() - started) * 1000)
            print(
                json.dumps(
                    {"ok": True, "warmup": True, "elapsedMs": elapsed, "engine": _engine_version()},
                    ensure_ascii=False,
                )
            )
            return 0
        except Exception as exc:  # noqa: BLE001
            print(
                json.dumps(
                    {"ok": False, "warmup": True, "fatal": f"{type(exc).__name__}: {exc}"},
                    ensure_ascii=False,
                )
            )
            return 1

    try:
        payload = handle(job)
    except Exception as exc:  # noqa: BLE001
        payload = {"ok": False, "fatal": f"{type(exc).__name__}: {exc}", "results": []}

    try:
        sys.stdout.write(json.dumps(payload, ensure_ascii=False))
        sys.stdout.write("\n")
        sys.stdout.flush()
    except Exception:  # noqa: BLE001
        # 编码炸了也别让宿主拿到半截 JSON
        sys.stdout.write('{"ok":false,"fatal":"stdout 编码失败","results":[]}\n')
        return 3
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
