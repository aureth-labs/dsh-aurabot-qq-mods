"""自动接听 QQ 语音通话：盯着 QQ 的来电窗口，识别绿色接听键并点下去。

做法：
  - 枚举 QQ.exe 的所有可见窗口（来电窗口一般是独立的小窗）
  - 截窗、找"绿色圆形按钮"（接听键），面积落在合理区间才认为命中
  - 点不点交给 logic.CallGate：自动接听关着就只看着，点过之后 10 秒内不重复点

用法：
    python auto_answer.py --dry     # 只识别并截图，不点击
    python auto_answer.py           # 真点
"""
from __future__ import annotations

import ctypes
import os
import sys
import time
from ctypes import wintypes
from pathlib import Path

import numpy as np
import pyautogui
from PIL import ImageGrab

from logic import CallGate

OUT = Path(__file__).parent / "out"
OUT.mkdir(parents=True, exist_ok=True)

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32
user32.SetProcessDPIAware()

MAX_W, MAX_H = 900, 800          # 来电窗不会太大
GREEN_MIN_AREA = 250             # 接听键的最小绿色面积（像素）
GREEN_MAX_AREA = 20000
COOLDOWN = 10.0
# index.mjs 在「自动接听」关掉时根本不会拉起这个进程；这个开关是给手动跑的人用的
AUTO_ANSWER = os.environ.get("QQ_CALL_AUTO_ANSWER", "1") != "0"

gate = CallGate(cooldown=COOLDOWN, auto=AUTO_ANSWER)
_seen: set[int] = set()
pid_name_cache: dict[int, str] = {}


def win_title(hwnd: int) -> str:
    n = user32.GetWindowTextLengthW(hwnd)
    buf = ctypes.create_unicode_buffer(n + 1)
    user32.GetWindowTextW(hwnd, buf, n + 1)
    return buf.value


def win_rect(hwnd: int):
    r = wintypes.RECT()
    if not user32.GetWindowRect(hwnd, ctypes.byref(r)):
        return None
    return r.left, r.top, r.right, r.bottom


def win_pid(hwnd: int) -> int:
    pid = wintypes.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    return pid.value


def exe_name(pid: int) -> str:
    if pid in pid_name_cache:
        return pid_name_cache[pid]
    h = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
    name = ""
    if h:
        buf = ctypes.create_unicode_buffer(1024)
        size = wintypes.DWORD(1024)
        if kernel32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
            name = buf.value.rsplit("\\", 1)[-1].lower()
        kernel32.CloseHandle(h)
    pid_name_cache[pid] = name
    return name


def find_green_button(img: np.ndarray):
    """返回绿色按钮中心（相对窗口坐标）与面积。"""
    r = img[:, :, 0].astype(np.int16)
    g = img[:, :, 1].astype(np.int16)
    b = img[:, :, 2].astype(np.int16)
    mask = (g > 150) & (g > r + 55) & (g > b + 35) & (r < 150)
    area = int(mask.sum())
    if area < GREEN_MIN_AREA or area > GREEN_MAX_AREA:
        return None, area
    ys, xs = np.nonzero(mask)
    return (int(xs.mean()), int(ys.mean())), area


def scan(dry: bool) -> None:
    found: list[tuple] = []

    def cb(hwnd, _):
        if not user32.IsWindowVisible(hwnd):
            return True
        rect = win_rect(hwnd)
        if not rect:
            return True
        l, t, r, b = rect
        w, h = r - l, b - t
        if w < 120 or h < 120 or w > MAX_W or h > MAX_H:
            return True
        title = win_title(hwnd)  # 来电窗可能没有标题，不按标题筛
        if exe_name(win_pid(hwnd)) != "qq.exe":
            return True
        found.append((hwnd, title) + rect)
        return True

    CALLBACK = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)
    user32.EnumWindows(CALLBACK(cb), 0)

    current: set[int] = set()
    for hwnd, title, l, t, r, b in found:
        current.add(hwnd)
        try:
            img = np.array(ImageGrab.grab(bbox=(l, t, r, b), all_screens=True))
        except Exception:
            continue
        center, area = find_green_button(img)
        now = time.time()
        action = gate.observe(hwnd, bool(center), now)
        if action == "no-button":
            print(f"窗口「{title}」{r - l}x{b - t} 绿色面积={area}，不像来电")
            continue
        stamp = time.strftime("%H%M%S")
        shot = OUT / f"autocall_{stamp}.png"
        cx, cy = l + center[0], t + center[1]
        print(f"命中「{title}」{r - l}x{b - t} 绿钮面积={area} 坐标=({cx},{cy}) 截图={shot.name}")
        try:
            ImageGrab.grab(bbox=(l, t, r, b), all_screens=True).save(shot)
        except Exception:
            pass
        if dry:
            continue
        if action == "disabled":
            print("  自动接听关着，只识别不点（要接就把设置里的开关打开）")
            continue
        if action == "cooldown":
            continue
        gate.mark_clicked(hwnd, now)
        pyautogui.moveTo(cx, cy, duration=0.15)
        pyautogui.click()
        (OUT / "call.flag").write_text(str(now), encoding="utf-8")
        print(f"  已点击接听 -> ({cx},{cy})，已通知对话回路打招呼")

    # 窗口消失：接过的这通就算结束（面板/日志能看出状态），没接过的当没来过
    for hwnd in list(_seen - current):
        event = gate.on_window_gone(hwnd)
        if event == "ended":
            print(f"  通话结束（窗口 {hwnd} 已关闭）")
    _seen.clear()
    _seen.update(current)


if __name__ == "__main__":
    dry = "--dry" in sys.argv
    print(f"自动接听启动（{'只识别不点击' if dry else '会真的点'}，"
          f"自动接听{'开' if AUTO_ANSWER else '关'}），Ctrl+C 结束")
    while True:
        try:
            scan(dry)
        except Exception as e:
            print("扫描异常:", e)
        time.sleep(1.0)
