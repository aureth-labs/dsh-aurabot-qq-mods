"""通话回路：听 → 识别 → 大模型 → 合成 → 播回通话。

行为：
  - 电话一接通（auto_answer 点了接听会写一个标记文件）就主动打声招呼
  - 你说一句，她回一句；她说话时你插话，她立刻闭嘴（barge-in）
  - 你一直不说话，她会隔一阵催你一句，催三次就安静等你

判断都放在 logic.py（接听闸门、VAD 分段、上下文拼接、静默策略），这里只做 IO：
声卡、识别、模型、合成。
"""
from __future__ import annotations

import ctypes
import json
import os
import sys
import threading
import time
import urllib.request
from ctypes import wintypes
from pathlib import Path

import numpy as np
import soundcard as sc

import asr
import logic
import random
import speak_stream
from call_bridge import PLAY_DEV_HINT, pick_device

LLM_URL = os.environ.get("QQ_CALL_LLM_URL", "http://127.0.0.1:9000/v1/chat/completions")
LLM_MODEL = os.environ.get("QQ_CALL_LLM_MODEL", "deepseek-flash")
SYSTEM_PROMPT = (
    "你在和电话那头的人说话。说话像真人打电话：短句、口语、有停顿感，"
    "一次最多一两句话，不要用书面语、不要列点、不要解释自己在做什么。"
    "语气自然，偶尔带一点情绪。"
)

SAMPLE_RATE = 16000
FRAME_MS = 40
FRAME = SAMPLE_RATE * FRAME_MS // 1000
SILENCE_END_MS = 600
MIN_SPEECH_MS = 300
NOISE_FLOOR_INIT = 0.006

OUT = Path(__file__).parent / "out"
CALL_FLAG = OUT / "call.flag"
GREETING = os.environ.get("QQ_CALL_GREETING") or "喂？是我呀。你怎么突然想起给我打电话了。"
PERSONA_FILE = OUT / "persona.txt"   # Aurabot 启动时写进来的她的人格
# 模型不通时的兜底：随机挑一句，别每次都一模一样
FALLBACK_GREETS = [
    "喂？……怎么想起给我打电话了。",
    "嗯，我在呢。说吧。",
    "喂，是我。你那边怎么这么安静。",
    "接这么快，是不是就等我出声呢。",
    "……喂？你先说话呀。",
]
FALLBACK_COMFORT = [
    "没事，我在呢。你想说的时候再说。",
    "不用急着说话，我就在这儿听着。",
    "……是不是今天不太想说话？我陪你一会儿。",
]
IDLE_PROMPTS = ["还在吗？", "你那边听得见吗？", "……那我先不说话啦，你忙你的。"]
IDLE_AFTER_S = int(os.environ.get("QQ_CALL_IDLE_AFTER", "14") or 14)
IDLE_ON = os.environ.get("QQ_CALL_IDLE", "1") != "0"
SILENT_FIRST = os.environ.get("QQ_CALL_SILENT_FIRST", "1") != "0"   # 接通后允许她先只听不说
SILENT_OPEN_SEC = int(os.environ.get("QQ_CALL_SILENT_OPEN_SEC", "30") or 30)


def build_system() -> str:
    """她的人格（Aurabot 写进来的）+ 打电话的说话方式。"""
    persona = ""
    try:
        persona = PERSONA_FILE.read_text(encoding="utf-8").strip()
    except OSError:
        pass
    if persona:
        return persona + "\n\n【现在的情形】\n" + SYSTEM_PROMPT
    return SYSTEM_PROMPT


# ---------- 通话窗口检测（只在真的通话中才催话） ----------
_user32 = ctypes.windll.user32
_kernel32 = ctypes.windll.kernel32
_user32.SetProcessDPIAware()
_call_cache = {"at": 0.0, "open": False}


def _win_title(hwnd) -> str:
    n = _user32.GetWindowTextLengthW(hwnd)
    buf = ctypes.create_unicode_buffer(n + 1)
    _user32.GetWindowTextW(hwnd, buf, n + 1)
    return buf.value


def _exe_of(pid: int) -> str:
    h = _kernel32.OpenProcess(0x1000, False, pid)
    if not h:
        return ""
    try:
        buf = ctypes.create_unicode_buffer(1024)
        size = wintypes.DWORD(1024)
        if _kernel32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
            return buf.value.split("\\")[-1].lower()
    finally:
        _kernel32.CloseHandle(h)
    return ""


def call_window_open() -> bool:
    """QQ 的通话窗口还在不在。不在就别自言自语。"""
    now = time.time()
    if now - _call_cache["at"] < 2.0:
        return _call_cache["open"]
    found = False

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def cb(hwnd, _lp):
        nonlocal found
        if _user32.IsWindowVisible(hwnd):
            title = _win_title(hwnd)
            if "通话" in title or "语音" in title:
                pid = wintypes.DWORD()
                _user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
                if _exe_of(pid.value) == "qq.exe":
                    found = True
                    return False
        return True

    _user32.EnumWindows(cb, 0)
    _call_cache.update(at=now, open=found)
    return found


class Dialog:
    def __init__(self):
        self.history: list[dict] = []
        self.play_dev = pick_device(PLAY_DEV_HINT, "out")
        self.stop_play = threading.Event()
        self.speaking = threading.Event()
        self.last_spoken_at = time.time()  # 启动时不立刻催话
        self.prompt_idx = 0
        self.last_flag = CALL_FLAG.stat().st_mtime if CALL_FLAG.exists() else 0.0
        self.system = build_system()
        self.seg = logic.VoiceSegmenter(
            sample_rate=SAMPLE_RATE, frame_ms=FRAME_MS,
            silence_end_ms=SILENCE_END_MS, min_speech_ms=MIN_SPEECH_MS,
            noise_floor=NOISE_FLOOR_INIT,
        )
        self.silent_mode = False      # 接通后先只听不说
        self.connected_at = 0.0
        self.user_spoke = False       # 这通电话里对方开过口没有

    # ---------- 大模型 ----------
    def llm(self, text: str, remember: bool = True) -> str:
        messages = logic.build_messages(self.system, self.history, text)
        body = json.dumps({"model": LLM_MODEL, "messages": messages, "max_tokens": 160, "temperature": 0.8}).encode()
        req = urllib.request.Request(LLM_URL, data=body, headers={"content-type": "application/json"}, method="POST")
        t0 = time.time()
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read())
        reply = data["choices"][0]["message"]["content"].strip()
        if remember:
            self.history = logic.append_turn(self.history, text, reply)
        print(f"  [llm] {time.time() - t0:.2f}s -> {reply}")
        return reply

    # ---------- 说话 ----------
    def say(self, text: str) -> None:
        self.speaking.set()
        try:
            speak_stream.speak(text, self.play_dev, stop_cb=lambda: self.stop_play.is_set())
        finally:
            self.speaking.clear()
            self.stop_play.clear()
            self.last_spoken_at = time.time()

    def say_async(self, text: str) -> threading.Thread:
        t = threading.Thread(target=self.say, args=(text,), daemon=True)
        t.start()
        return t

    # ---------- 开场白：她自己现想，或者选择先安静听着 ----------
    def greet_line(self) -> str:
        """接通那一刻让她自己想第一句；她也可以回「安静」表示先只听不说。"""
        try:
            print("  [开场白] 她自己想第一句")
            if SILENT_FIRST:
                kick = (
                    "（电话刚接通，对面是打电话来的人。你可以先开口说一两句；也可以先不吭声、只听他说。"
                    f"想先安静就只回两个字：安静。想说话就直接说那句话，别解释。如果他 {SILENT_OPEN_SEC} 秒都不出声，你会再开口。）"
                )
            else:
                kick = "（电话刚接通，对面是打电话来的人。你先开口，一两句口语，别解释、别问你是谁、别重复问好。）"
            return self.llm(kick, remember=False)
        except Exception as e:
            print(f"  [开场白] 模型不通：{e}")
            return random.choice(FALLBACK_GREETS) if SILENT_FIRST else GREETING

    # ---------- 接通打招呼 ----------
    def maybe_greet(self) -> None:
        try:
            mtime = CALL_FLAG.stat().st_mtime
        except FileNotFoundError:
            return
        if mtime <= self.last_flag:
            return
        self.last_flag = mtime
        self.history.clear()
        self.stop_play.set()
        time.sleep(0.2)
        self.prompt_idx = 0
        self.user_spoke = False
        self.connected_at = time.time()
        line = self.greet_line()
        if logic.greet_is_silent(line) and SILENT_FIRST:
            self.silent_mode = True
            print(f"  [接通] 她决定先听着，{SILENT_OPEN_SEC} 秒没动静再开口")
            return
        self.silent_mode = False
        print(f"  [开场白] 说：{line}")
        self.say_async(line)

    # ---------- 半分钟还没人说话：判断对方要陪伴还是要安慰 ----------
    def open_after_silence(self) -> None:
        self.silent_mode = False
        try:
            print("  [开口] 对面一直没出声，她先说一句")
            prompt = (
                "（电话接通有一会儿了，对面一直没出声。别问他怎么不说话。"
                "先判断他更像是想有人陪着，还是需要被安慰，挑一种，用一两句很轻的话开口。）"
            )
            reply = self.llm(prompt, remember=False)
        except Exception as e:
            print(f"  [开口] 模型不通：{e}")
            reply = random.choice(FALLBACK_COMFORT)
        self.say_async(reply)

    # ---------- 静默时该不该出声 ----------
    def idle_step(self) -> None:
        action = logic.idle_action(
            now=time.time(),
            connected_at=self.connected_at,
            silent_mode=self.silent_mode,
            user_spoke=self.user_spoke,
            speaking=self.speaking.is_set(),
            prompt_idx=self.prompt_idx,
            idle_on=IDLE_ON,
            idle_after_s=IDLE_AFTER_S,
            silent_open_sec=SILENT_OPEN_SEC,
            last_spoken_at=self.last_spoken_at,
            last_flag=self.last_flag,
            call_open=call_window_open(),
            max_prompts=len(IDLE_PROMPTS),
        )
        if action == "open":
            self.open_after_silence()
        elif action == "idle":
            prompt = logic.idle_prompt(IDLE_PROMPTS, self.prompt_idx)
            if not prompt:
                return
            self.prompt_idx += 1
            print(f"\n  [催] {prompt}")
            self.say_async(prompt)

    # ---------- 主循环 ----------
    def run(self) -> None:
        speaker = sc.default_speaker()
        mic = sc.get_microphone(id=str(speaker.name), include_loopback=True)
        print(f"抓音来源: {mic.name}（系统播放的 QQ 通话声音）")
        rec = asr.recognizer()
        stream = rec.create_stream()
        print("开始监听…（Ctrl+C 结束）")
        with mic.recorder(samplerate=SAMPLE_RATE, channels=1, blocksize=FRAME) as recorder:
            while True:
                block = recorder.record(numframes=FRAME).reshape(-1).astype(np.float32)
                rms = float(np.sqrt(np.mean(block ** 2)) + 1e-12)
                event = self.seg.feed(rms, speaking=self.speaking.is_set())

                if event["kind"] == "start":
                    stream = rec.create_stream()
                    self.user_spoke = True   # 对方开口了
                    print("  [听见] ", end="", flush=True)
                if event["kind"] in ("start", "speech"):
                    self.prompt_idx = 0
                    stream.accept_waveform(SAMPLE_RATE, block)
                    while rec.is_ready(stream):
                        rec.decode_stream(stream)
                    partial = rec.get_result(stream).strip()
                    if partial:
                        print(f"\r  [听见] {partial}", end="", flush=True)
                    if event["barge_in"]:
                        self.stop_play.set()   # 她在说话，对方插话 —— 立刻闭嘴
                elif event["kind"] == "silence":
                    if self.seg.active:
                        stream.accept_waveform(SAMPLE_RATE, block)
                    else:
                        self.idle_step()
                elif event["kind"] == "end":
                    stream.accept_waveform(SAMPLE_RATE, block)
                    stream.input_finished()
                    while rec.is_ready(stream):
                        rec.decode_stream(stream)
                    text = rec.get_result(stream).strip()
                    if event["long_enough"] and text:
                        print(f"\n  [你] {text}")
                        self.stop_play.set()
                        time.sleep(0.15)
                        reply = self.llm(text)
                        self.prompt_idx = 0
                        self.say_async(reply)
                self.maybe_greet()


def simulate(text: str) -> None:
    d = Dialog()
    pcm = speak_stream.synth(text)
    pcm16 = speak_stream.resample(pcm, 48000, SAMPLE_RATE).astype(np.float32) / 32768
    t0 = time.time()
    heard = asr.transcribe_pcm(pcm16)
    print(f"[模拟对方] {text}")
    print(f"[识别] {heard}  ({(time.time() - t0) * 1000:.0f} ms)")
    reply = d.llm(heard)
    t1 = time.time()
    d.say(reply)
    print(f"[播完] 回复音频耗时 {time.time() - t1:.2f}s")


if __name__ == "__main__":
    if "--simulate" in sys.argv:
        simulate(sys.argv[sys.argv.index("--simulate") + 1])
    else:
        Dialog().run()
