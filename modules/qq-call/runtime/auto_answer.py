"""自动接听 QQ 语音通话：盯着 QQ 的来电窗口，识别绿色接听键，再决定接不接。

做法：
  - 枚举 QQ.exe 的所有可见窗口（来电窗口一般是独立的小窗）
  - 截窗、找"绿色圆形按钮"（接听键），面积落在合理区间才认为命中
  - 点不点分两层：
      logic.CallGate     这个窗口是不是来电、刚点过就别重复点、开关关着就只看着
      logic.AnswerDecider 这通电话她要不要接 —— 默认把来电人、时间、她的人格丢给模型问一句，
                         一通电话只问一次；模型不回 / 回得看不懂就走兜底（默认先接上）
   她可以选择「不接」，也可以「等几秒再决定」（最多等 5 秒，电话还在响才接）

用法：
    python auto_answer.py --dry     # 只识别并截图，不点击也不问她
    python auto_answer.py           # 真接（策略看 QQ_CALL_ANSWER_POLICY）
"""
from __future__ import annotations

import ctypes
import json
import os
import sys
import time
import urllib.request
from ctypes import wintypes
from pathlib import Path

import numpy as np
import pyautogui
from PIL import ImageGrab

from logic import AnswerDecider, CallGate, caller_from_title, parse_verdict

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
# 接不接：always 总是接 / never 一律不接 / decide 让她自己决定（默认）
POLICY = (os.environ.get("QQ_CALL_ANSWER_POLICY") or "decide").strip().lower()
# 她没给出判断时：answer 先接上 / skip 先不接
ON_ERROR = (os.environ.get("QQ_CALL_ANSWER_ON_ERROR") or "answer").strip().lower()
ANSWER_TIMEOUT = float(os.environ.get("QQ_CALL_ANSWER_TIMEOUT") or 3)
WAIT_MAX = float(os.environ.get("QQ_CALL_ANSWER_WAIT_MAX") or 5)

gate = CallGate(cooldown=COOLDOWN, auto=AUTO_ANSWER)
decider = AnswerDecider(policy=POLICY, on_error=ON_ERROR, wait_max=WAIT_MAX)
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


def read_persona() -> str:
    """她的人格（index.mjs 启动时同步到 out/persona.txt）。读不到就用一句中性设定。"""
    try:
        return (OUT / "persona.txt").read_text(encoding="utf-8").strip()[:2000]
    except Exception:
        return ""


def moment_name(hour: int) -> str:
    if hour < 5:
        return "凌晨"
    if hour < 9:
        return "早上"
    if hour < 12:
        return "上午"
    if hour < 14:
        return "中午"
    if hour < 18:
        return "下午"
    if hour < 23:
        return "晚上"
    return "深夜"


def recent_calls(caller: str, limit: int = 3) -> str:
    """同一个人最近几次来电她接没接 —— 让她有个前后印象，不是一个每次都很陌生的电话。"""
    try:
        lines = (OUT / "calls.jsonl").read_text(encoding="utf-8").strip().splitlines()[-30:]
    except Exception:
        return ""
    items = []
    for ln in reversed(lines):
        try:
            rec = json.loads(ln)
        except Exception:
            continue
        if not caller or rec.get("caller") != caller:
            continue
        act = {"answer": "接了", "decline": "没接", "wait": "让它多响了一会儿"}.get(rec.get("action"), str(rec.get("action")))
        items.append(f"{rec.get('time', '')} {act}")
        if len(items) >= limit:
            break
    return "；".join(items)


def log_call(caller: str, action: str, why: str, now: float) -> None:
    rec = {"at": round(float(now), 1), "time": time.strftime("%H:%M:%S", time.localtime(now)),
           "caller": caller, "action": action, "why": why}
    try:
        with open(OUT / "calls.jsonl", "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except Exception:
        pass
    # 面板只读这一条，别为了看最近一次去翻 jsonl
    try:
        (OUT / "last_decision.json").write_text(json.dumps(rec, ensure_ascii=False), encoding="utf-8")
    except Exception:
        pass


def ask_model(caller: str, now: float) -> dict | None:
    """问她要不要接这通电话。

    给她：来电人、现在几点、她自己的人格、同一个人最近几次接没接。
    要她答：接 / 不接 / 等N，后面可以用「｜」接一句理由。
    接口不通、超时、答得看不懂 —— 一律返回 None，由 decide_answer 按兜底处理。
    """
    url = (os.environ.get("QQ_CALL_LLM_URL") or "").strip()
    model = (os.environ.get("QQ_CALL_LLM_MODEL") or "").strip()
    if not url or not model:
        return None

    persona = read_persona() or "你是一个说话很自然的女生。"
    sys_text = (
        f"{persona}\n\n"
        "现在 QQ 里有人给你打语音电话，接不接你自己定，不用客气，也不用解释太多。\n"
        "只回一行：接 / 不接 / 等N（N 是秒数，最多 5）。\n"
        "想留一句理由就在后面用「｜」接上，不超过 12 个字。"
    )
    parts = [f"来电：{caller}",
             f"现在：{time.strftime('%H:%M', time.localtime(now))}（{moment_name(time.localtime(now).tm_hour)}）"]
    hist = recent_calls(caller)
    if hist:
        parts.append(f"这个人的来电记录：{hist}")
    user_text = "\n".join(parts)

    body = {
        "model": model,
        "messages": [{"role": "system", "content": sys_text}, {"role": "user", "content": user_text}],
        "temperature": 0.5,
        "max_tokens": 64,
        "stream": False,
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=ANSWER_TIMEOUT) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
        choice = (payload.get("choices") or [{}])[0]
        content = (choice.get("message") or {}).get("content") or choice.get("text") or ""
    except Exception as e:
        print(f"  问她要不要接时模型没通（{e}），按兜底处理")
        return None
    print(f"  她回：{content.strip().splitlines()[0] if content.strip() else '（空）'}")
    return parse_verdict(content, WAIT_MAX)


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
            decider.clear(hwnd)   # 这窗口不像来电，别把之前的判断留着
            print(f"窗口「{title}」{r - l}x{b - t} 绿色面积={area}，不像来电")
            continue
        if action == "disabled":
            print(f"命中「{title}」{r - l}x{b - t} 绿钮面积={area}，但自动接听关着，只识别不点")
            continue
        if action == "cooldown":
            continue

        caller = caller_from_title(title)
        cx, cy = l + center[0], t + center[1]

        # 她要不要接这通电话：一通电话只问一次，答案按窗口记着
        state = decider.begin(hwnd, caller, now)
        if state == AnswerDecider.DECLINE:
            continue
        if state == AnswerDecider.PENDING:
            if not decider.tick(hwnd, now):   # 她说再响一会儿，这帧先不动
                continue
            print(f"  等够了，接（来电：{caller}）")
        elif state == AnswerDecider.ASK:
            stamp = time.strftime("%H%M%S")
            shot = OUT / f"autocall_{stamp}.png"
            print(f"命中「{title}」{r - l}x{b - t} 绿钮面积={area} 坐标=({cx},{cy}) 来电者={caller} 截图={shot.name}")
            try:
                ImageGrab.grab(bbox=(l, t, r, b), all_screens=True).save(shot)
            except Exception:
                pass
            if dry:
                continue
            verdict = ask_model(caller, now) if POLICY == "decide" else None
            decision = decider.resolve(hwnd, verdict, now)
            word = {"answer": "接", "decline": "不接", "wait": "先等一会儿"}.get(decision["action"], decision["action"])
            print(f"  她决定「{word}」：{decision['why']}（来电：{caller}）")
            log_call(caller, decision["action"], decision["why"], now)
            if decision["action"] != "answer":
                continue

        gate.mark_clicked(hwnd, now)
        pyautogui.moveTo(cx, cy, duration=0.15)
        pyautogui.click()
        (OUT / "call.flag").write_text(str(now), encoding="utf-8")
        print(f"  已点击接听 -> ({cx},{cy})，已通知对话回路打招呼")

    # 窗口消失：接过的这通就算结束（面板/日志能看出状态），没接过的当没来过
    for hwnd in list(_seen - current):
        event = gate.on_window_gone(hwnd)
        decider.clear(hwnd)
        if event == "ended":
            print(f"  通话结束（窗口 {hwnd} 已关闭）")
    _seen.clear()
    _seen.update(current)


if __name__ == "__main__":
    dry = "--dry" in sys.argv
    policy_word = {"always": "总是接", "never": "一律不接"}.get(
        POLICY, "她自己决定（模型不通就" + ("不接" if ON_ERROR == "skip" else "接上") + "）")
    print(f"自动接听启动（{'只识别不点击' if dry else '会真的点'}，"
          f"自动接听{'开' if AUTO_ANSWER else '关'}，接不接：{policy_word}），Ctrl+C 结束")
    while True:
        try:
            scan(dry)
        except Exception as e:
            print("扫描异常:", e)
        time.sleep(1.0)
