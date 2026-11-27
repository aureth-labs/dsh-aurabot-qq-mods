#!/usr/bin/env python
"""
call_bridge —— 把 AI 的声音"假装成麦克风"喂进 QQ 语音通话。

链路：文本 -> Breeze TTS(mp3) -> ffmpeg 解成 48k 单声道 PCM -> 喇叭选 CABLE Input
      QQ 里把「麦克风」设成 CABLE Output，通话对面就能听见。

命令：
  python call_bridge.py devices                 列出可用设备
  python call_bridge.py tone 2                  播放 1kHz 测试音（默认 2 秒）
  python call_bridge.py say "你好，这是一段测试语音"        合成语音并播进虚拟声卡
  python call_bridge.py loopcheck 2             边播边录，验证虚拟声卡回路
  python call_bridge.py rec 5 out.wav           从 CABLE Output 录 5 秒
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request
import wave
from pathlib import Path

import numpy as np
import sounddevice as sd

# ---- Breeze TTS 配置（跟 aurabot 的 voice.http 保持一致）----
# 这三个都由环境变量给：不填就不用 breeze 引擎
BREEZE_VOICE = os.environ.get("CALL_BREEZE_VOICE", "")
TTS_URL = os.environ.get("CALL_BREEZE_URL", "") or (
    f"https://api.breeze.blue/v1/text-to-speech/{BREEZE_VOICE}?output_format=mp3" if BREEZE_VOICE else ""
)
TTS_KEY = os.environ.get("CALL_BREEZE_KEY", "")
TTS_BODY = {"model_id": "breeze-tts-2-multilingual", "language_code": "zh"}

# ---- 引擎选择：piper（本地默认）/ breeze（云端，慢一点但更自然）----
TTS_ENGINE = os.environ.get("CALL_TTS_ENGINE", "piper").lower()
EDGE_VOICE = os.environ.get("CALL_EDGE_VOICE", "zh-CN-XiaoyiNeural")
EDGE_RATE = os.environ.get("CALL_EDGE_RATE", "+8%")

RATE = 48000
PLAY_DEV_HINT = "CABLE Input"
REC_DEV_HINT = "CABLE Output"
OUT_DIR = Path(__file__).parent / "out"


def find_ffmpeg() -> str:
    p = shutil.which("ffmpeg")
    if not p:
        raise SystemExit("找不到 ffmpeg，请确认它在 PATH 里")
    return p


def pick_device(hint: str, kind: str) -> int:
    """按名字挑 WASAPI 端点，优先 2 声道 48k 那个（避免 16ch 版本）。"""
    best = None
    for idx, dev in enumerate(sd.query_devices()):
        name = dev["name"]
        if hint.lower() not in name.lower():
            continue
        host = sd.query_hostapis(dev["hostapi"])["name"]
        if "WASAPI" not in host:
            continue
        ch = dev["max_input_channels" if kind == "in" else "max_output_channels"]
        if ch < 1:
            continue
        if ch == 2:
            return idx
        if best is None:
            best = idx
    if best is None:
        raise SystemExit(f"没找到含 '{hint}' 的设备，先跑 devices 看看")
    return best


def tts_mp3(text: str) -> bytes:
    body = dict(TTS_BODY, text=text)
    req = urllib.request.Request(
        TTS_URL,
        data=json.dumps(body).encode("utf-8"),
        headers={"xi-api-key": TTS_KEY, "content-type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = resp.read()
        if not data or resp.headers.get("content-type", "").startswith("application/json"):
            raise SystemExit(f"TTS 返回异常: {data[:200]!r}")
    return data


def tts_edge(text: str) -> bytes:
    """edge-tts：流式收集 mp3 分片，通常 0.3~0.8 秒就能出第一块。"""
    import asyncio

    import edge_tts

    async def run() -> bytes:
        parts = []
        comm = edge_tts.Communicate(text, EDGE_VOICE, rate=EDGE_RATE)
        async for chunk in comm.stream():
            if chunk["type"] == "audio":
                parts.append(chunk["data"])
        return b"".join(parts)

    data = asyncio.run(run())
    if not data:
        raise SystemExit("edge-tts 没有返回音频")
    return data


def synth(text: str) -> bytes:
    if TTS_ENGINE == "breeze":
        if not TTS_URL or not TTS_KEY:
            raise SystemExit("选了 breeze 引擎，但没配语音 id / key（设置里填 voiceId 和 key，或切回 piper）")
        return tts_mp3(text)
    return tts_edge(text)


def mp3_to_pcm(mp3: bytes) -> np.ndarray:
    ff = find_ffmpeg()
    proc = subprocess.run(
        [ff, "-v", "quiet", "-i", "pipe:0", "-f", "s16le", "-ac", "1", "-ar", str(RATE), "pipe:1"],
        input=mp3,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=True,
    )
    return np.frombuffer(proc.stdout, dtype=np.int16)


def play_pcm(samples: np.ndarray, device: int, blocking: bool = True) -> None:
    """按 10ms 小块写进设备，保证起播延迟最小。

    VB-Cable 是立体声端点：实测单声道流会被当成两倍速播放（音高翻倍、听起来全是噪音），
    所以这里统一开双声道，把单声道样本复制到左右两个通道。
    """
    block = RATE // 100
    out_ch = sd.query_devices(device)["max_output_channels"]
    channels = 2 if out_ch >= 2 else 1
    pos = 0
    stream = sd.OutputStream(
        samplerate=RATE, channels=channels, dtype="int16", device=device, blocksize=block
    )
    stream.start()
    try:
        while pos < len(samples):
            chunk = samples[pos: pos + block].reshape(-1, 1)
            if channels == 2:
                chunk = np.repeat(chunk, 2, axis=1)
            stream.write(chunk)
            pos += block
    finally:
        stream.stop()
        stream.close()


def play_async(samples: np.ndarray, device: int):
    import threading

    t = threading.Thread(target=play_pcm, args=(samples, device), daemon=True)
    t.start()
    return t


def record(seconds: float, device: int) -> np.ndarray:
    frames = int(RATE * seconds)
    buf = sd.rec(frames, samplerate=RATE, channels=1, dtype="int16", device=device)
    sd.wait()
    return buf.reshape(-1)


def level(samples: np.ndarray) -> float:
    if not len(samples):
        return 0.0
    x = samples.astype(np.float32) / 32768.0
    return float(np.sqrt(np.mean(x ** 2)))


def save_wav(path: Path, samples: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(RATE)
        f.writeframes(samples.tobytes())


def cmd_devices() -> None:
    for idx, dev in enumerate(sd.query_devices()):
        host = sd.query_hostapis(dev["hostapi"])["name"]
        print(f"{idx:>3}  {dev['name'][:46]:<48} in={dev['max_input_channels']} out={dev['max_output_channels']} [{host}]")
    print("播放目标:", sd.query_devices(pick_device(PLAY_DEV_HINT, "out"))["name"])
    print("录音来源:", sd.query_devices(pick_device(REC_DEV_HINT, "in"))["name"])


def cmd_tone(sec: float = 2.0) -> None:
    dev = pick_device(PLAY_DEV_HINT, "out")
    t = np.arange(int(RATE * sec)) / RATE
    wave_ = (np.sin(2 * np.pi * 1000 * t) * 0.35 * 32767).astype(np.int16)
    play_pcm(wave_, dev)
    print(f"已播 {sec}s 1kHz 正弦到 {sd.query_devices(dev)['name']}")


def cmd_say(text: str, keep: bool = True) -> None:
    dev = pick_device(PLAY_DEV_HINT, "out")
    t0 = time.time()
    mp3 = synth(text)
    t1 = time.time()
    pcm = mp3_to_pcm(mp3)
    t2 = time.time()
    if keep:
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        stem = time.strftime("%H%M%S")
        (OUT_DIR / f"tts_{stem}.mp3").write_bytes(mp3)
        save_wav(OUT_DIR / f"tts_{stem}.wav", pcm)
    play_pcm(pcm, dev)
    print(f"合成 {t1 - t0:.2f}s / 解码 {t2 - t1:.2f}s / 音频 {len(pcm) / RATE:.2f}s / 播放完成")


def cmd_loopcheck(sec: float = 2.0) -> None:
    """同时播测试音 + 录 CABLE Output，验证回路真的通。"""
    play_dev = pick_device(PLAY_DEV_HINT, "out")
    rec_dev = pick_device(REC_DEV_HINT, "in")
    t = np.arange(int(RATE * sec)) / RATE
    tone = (np.sin(2 * np.pi * 1000 * t) * 0.35 * 32767).astype(np.int16)
    rec = sd.rec(int(RATE * sec), samplerate=RATE, channels=1, dtype="int16", device=rec_dev)
    play_async(tone, play_dev)
    sd.wait()
    got = rec.reshape(-1)
    lv = level(got)
    save_wav(OUT_DIR / "loopcheck.wav", got)
    print(f"回录音量 RMS={lv:.4f}（>0.01 表示回路正常），峰值={int(np.max(np.abs(got)))}")
    print("录音已存:", OUT_DIR / "loopcheck.wav")


def cmd_rec(sec: float, path: str) -> None:
    dev = pick_device(REC_DEV_HINT, "in")
    print(f"录制 {sec}s ...")
    samples = record(sec, dev)
    save_wav(Path(path), samples)
    print(f"已保存 {path}，RMS={level(samples):.4f}")


def cmd_serve(port: int) -> None:
    """常驻服务：外部随时 /say 一句，就能把语音推进通话。"""
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from urllib.parse import parse_qs, urlparse

    play_dev = pick_device(PLAY_DEV_HINT, "out")
    if TTS_ENGINE == "piper":
        import speak_stream
        speak_stream.voice()  # 预热模型，避免第一句冷启动

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def _json(self, obj, code=200):
            data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("content-type", "application/json; charset=utf-8")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            u = urlparse(self.path)
            q = parse_qs(u.query)
            if u.path == "/health":
                return self._json({"ok": True, "device": sd.query_devices(play_dev)["name"]})
            if u.path == "/tone":
                sec = float(q.get("sec", ["1"])[0])
                t = np.arange(int(RATE * sec)) / RATE
                play_pcm((np.sin(2 * np.pi * 1000 * t) * 0.3 * 32767).astype(np.int16), play_dev)
                return self._json({"ok": True, "sec": sec})
            if u.path == "/say":
                text = (q.get("text", [""])[0] or "").strip()
                if not text:
                    return self._json({"ok": False, "error": "no text"}, 400)
                t0 = time.time()
                if TTS_ENGINE == "piper":
                    import speak_stream

                    first = speak_stream.speak(text, play_dev)
                    return self._json({
                        "ok": True,
                        "engine": "piper",
                        "first_audio_s": round(first, 2),
                        "total_s": round(time.time() - t0, 2),
                    })
                mp3 = synth(text)
                pcm = mp3_to_pcm(mp3)
                synth_s = time.time() - t0
                t1 = time.time()
                play_pcm(pcm, play_dev)
                return self._json({
                    "ok": True,
                    "engine": TTS_ENGINE,
                    "synth_s": round(synth_s, 2),
                    "play_s": round(time.time() - t1, 2),
                    "audio_s": round(len(pcm) / RATE, 2),
                })
            return self._json({"ok": False, "error": "unknown path"}, 404)

        def do_POST(self):
            return self.do_GET()

    print(f"call_bridge 服务启动 http://127.0.0.1:{port}  播放设备={sd.query_devices(play_dev)['name']}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()


def main() -> None:
    if len(sys.argv) < 2:
        print(__doc__)
        return
    cmd = sys.argv[1]
    if cmd == "devices":
        cmd_devices()
    elif cmd == "tone":
        cmd_tone(float(sys.argv[2]) if len(sys.argv) > 2 else 2.0)
    elif cmd == "say":
        cmd_say(sys.argv[2])
    elif cmd == "loopcheck":
        cmd_loopcheck(float(sys.argv[2]) if len(sys.argv) > 2 else 2.0)
    elif cmd == "rec":
        cmd_rec(float(sys.argv[2]), sys.argv[3] if len(sys.argv) > 3 else "rec.wav")
    elif cmd == "serve":
        cmd_serve(int(sys.argv[2]) if len(sys.argv) > 2 else 47660)
    else:
        print(__doc__)


if __name__ == "__main__":
    main()


