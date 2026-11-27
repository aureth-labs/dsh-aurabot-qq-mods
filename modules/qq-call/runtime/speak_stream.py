"""Piper 小句流水线：边合成边播进虚拟声卡，首字延迟尽量低。

用法：
    python speak_stream.py "要说的整段话"
"""
import queue
import re
import sys
import threading
import time

import numpy as np
import sounddevice as sd

from call_bridge import PLAY_DEV_HINT, RATE, pick_device

PIPER_MODEL = "models/zh_CN-huayan-medium.onnx"
SPLIT_RE = re.compile(r"[，。！？；、…,.!?;:]")

_voice = None


def voice():
    global _voice
    if _voice is None:
        from piper import PiperVoice

        _voice = PiperVoice.load(PIPER_MODEL)
    return _voice


def resample(x: np.ndarray, src_rate: int, dst_rate: int = RATE) -> np.ndarray:
    if src_rate == dst_rate:
        return x
    n_dst = int(len(x) * dst_rate / src_rate)
    src_idx = np.arange(n_dst) * (src_rate / dst_rate)
    return np.interp(src_idx, np.arange(len(x)), x.astype(np.float32)).astype(np.int16)


def split_clauses(text: str) -> list[str]:
    parts = [p.strip() for p in SPLIT_RE.split(text) if p.strip()]
    return parts or [text.strip()]


def synth(text: str) -> np.ndarray:
    v = voice()
    buf = []
    for chunk in v.synthesize(text):
        buf.append(chunk.audio_int16_array)
    pcm = np.concatenate(buf) if buf else np.zeros(0, dtype=np.int16)
    return resample(pcm, v.config.sample_rate)


def speak(text: str, device: int | None = None, first_cb=None, stop_cb=None) -> float:
    """把整段话按小句流水合成并播放，返回首字延迟（秒）。"""
    dev = device or pick_device(PLAY_DEV_HINT, "out")
    clauses = split_clauses(text)
    q: queue.Queue = queue.Queue()
    done = object()

    def producer():
        for c in clauses:
            try:
                q.put(synth(c))
            except Exception as e:  # 单句失败不影响后面
                print("合成失败:", c, e, file=sys.stderr)
        q.put(done)

    threading.Thread(target=producer, daemon=True).start()

    block = RATE // 100
    out_ch = sd.query_devices(dev)["max_output_channels"]
    channels = 2 if out_ch >= 2 else 1
    stream = sd.OutputStream(samplerate=RATE, channels=channels, dtype="int16", device=dev, blocksize=block)
    stream.start()
    t_start = time.time()
    first_at = None
    try:
        while True:
            item = q.get()
            if item is done:
                break
            if not len(item):
                continue
            if first_at is None:
                first_at = time.time() - t_start
                if first_cb:
                    first_cb(first_at)
            for i in range(0, len(item), block):
                if stop_cb and stop_cb():
                    return first_at or 0.0
                chunk = item[i:i + block].reshape(-1, 1)
                if channels == 2:
                    chunk = np.repeat(chunk, 2, axis=1)
                stream.write(chunk)
    finally:
        stream.stop()
        stream.close()
    return first_at or 0.0


if __name__ == "__main__":
    text = sys.argv[1] if len(sys.argv) > 1 else "喂，能听见吗？我在这边呢。"
    t0 = time.time()
    first = speak(text)
    print(f"首字 {first * 1000:.0f} ms，整段播完 {time.time() - t0:.2f}s")
