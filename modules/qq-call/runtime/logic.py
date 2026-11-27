"""通话里的纯判断：接听状态机、VAD 分段、上下文拼接、静默策略。

这里只放「不碰窗口、不碰麦克风、不碰模型、不写文件」的判断，方便脱离 QQ / 声卡 / 大模型单独跑测试
（python -m unittest test/logic.test.py）。真正的 IO 留在 auto_answer.py / call_loop.py 里。

约定：时间一律由调用方传进来（now / last_*），模块自己不读钟，测试才能确定性地跑。
"""
from __future__ import annotations

# ---------- 来电：看到窗口 → 点接听 / 不接 ----------

class CallGate:
    """来电窗口 + 绿色接听钮 → 决定点还是不点。

    状态：
        idle      没有来电窗口
        ringing   看到来电窗口（绿钮命中）
        answered  已经点过接听
        ended     这通电话结束了

    只做判断，动作（真的点 / --dry 只截图）留给调用方。
    """

    IDLE = "idle"
    RINGING = "ringing"
    ANSWERED = "answered"
    ENDED = "ended"

    def __init__(self, cooldown: float = 10.0, auto: bool = True):
        self.cooldown = float(cooldown)
        self.auto = bool(auto)
        self.state = self.IDLE
        self._last_click: dict[int, float] = {}

    def observe(self, hwnd: int, has_button: bool, now: float) -> str:
        """看一帧结果。返回动作：

        click     可以点（冷却过了、自动接听开着）
        cooldown  刚点过，10 秒内不重复点
        no-button 这个窗口不像来电
        disabled  自动接听关着，只看着不点
        """
        if has_button and self.state in (self.IDLE, self.ENDED):
            self.state = self.RINGING
        if not has_button:
            return "no-button"
        if not self.auto:
            return "disabled"
        last = self._last_click.get(hwnd, 0.0)
        if last and now - last < self.cooldown:
            return "cooldown"
        return "click"

    def mark_clicked(self, hwnd: int, now: float) -> None:
        self._last_click[hwnd] = float(now)
        self.state = self.ANSWERED

    def on_window_gone(self, hwnd: int) -> str:
        """窗口消失：接过的算这通结束，没接过的当没来过。"""
        if self.state == self.ANSWERED:
            self.state = self.ENDED
            return "ended"
        if self.state == self.RINGING:
            self.state = self.IDLE
            return "missed"
        return ""


# ---------- 听：一帧一帧攒出一句话 ----------

class VoiceSegmenter:
    """帧级 VAD：攒一段人声、静下来收句；她正在说话时对方一出声就是打断（barge-in）。

    阈值跟噪声地板走：安静环境门槛低，风扇声大门槛自动抬高，免得把底噪当人声。
    原来的写死在 call_loop 主循环里，搬出来是为了能拿一段 RMS 序列把状态机测一遍。
    """

    def __init__(
        self,
        sample_rate: int = 16000,
        frame_ms: int = 40,
        silence_end_ms: int = 600,
        min_speech_ms: int = 300,
        noise_floor: float = 0.006,
        floor_min: float = 0.008,
        floor_max: float = 0.05,
        floor_up: float = 0.02,
    ):
        self.sample_rate = int(sample_rate)
        self.frame_ms = int(frame_ms)
        self.silence_end_ms = int(silence_end_ms)
        self.min_speech_ms = int(min_speech_ms)
        self.noise = float(noise_floor)
        self.floor_min = float(floor_min)
        self.floor_max = float(floor_max)
        self.floor_up = float(floor_up)
        self.active = False
        self.utter_frames = 0
        self.silent_frames = 0

    # 噪声地板只在没人说话时更新，说话时跟着人声走会把门槛顶到天上去
    def _learn_noise(self, rms: float) -> None:
        if not self.active:
            self.noise = min(self.noise * (1.0 - self.floor_up) + rms * self.floor_up, self.floor_max)

    def threshold(self) -> float:
        return max(self.floor_min, self.noise * 3)

    @property
    def utter_ms(self) -> int:
        return self.utter_frames * self.frame_ms

    @property
    def silent_ms(self) -> int:
        return self.silent_frames * self.frame_ms

    def feed(self, rms: float, speaking: bool = False) -> dict:
        """喂一帧 RMS（0~1）。返回事件：

        kind  start / speech / silence / end
        barge_in 她正在说话时对方开口了，调用方该立刻打断播放
        long_enough 这段人声够不够长（短于 min_speech_ms 的当咳嗽、键盘声丢掉）
        """
        self._learn_noise(rms)
        event = {"kind": "silence", "barge_in": False, "long_enough": False,
                 "utter_ms": self.utter_ms, "silent_ms": self.silent_ms}

        if rms > self.threshold():
            started = not self.active
            if started:
                self.active = True
                self.utter_frames = 0
            self.silent_frames = 0
            self.utter_frames += 1
            event.update(kind="start" if started else "speech", barge_in=bool(speaking),
                         utter_ms=self.utter_ms, silent_ms=0)
            return event

        if not self.active:
            return event

        self.silent_frames += 1
        if self.silent_ms >= self.silence_end_ms:
            self.active = False
            event.update(kind="end", long_enough=self.utter_ms >= self.min_speech_ms,
                         utter_ms=self.utter_ms, silent_ms=self.silent_ms)
            return event
        event.update(silent_ms=self.silent_ms, utter_ms=self.utter_ms)
        return event

    def reset(self) -> None:
        self.active = False
        self.utter_frames = 0
        self.silent_frames = 0


# ---------- 上下文：拼给模型看的历史 ----------

def build_messages(system: str, history: list[dict], text: str, keep: int = 6) -> list[dict]:
    """system + 最近 keep 轮 + 这一句。keep 是消息条数，不是轮数（和原来 history[-6:] 一致）。"""
    return [{"role": "system", "content": system}] + list(history[-keep:]) + [{"role": "user", "content": text}]


def trim_history(history: list[dict], limit: int = 8) -> list[dict]:
    """记住这一问一答，但只留最后 limit 条，免得上下文越滚越长。"""
    return list(history[-limit:])


def append_turn(history: list[dict], text: str, reply: str, limit: int = 8) -> list[dict]:
    """一问一答落进历史，并裁到 limit 条。"""
    return trim_history([*history, {"role": "user", "content": text},
                         {"role": "assistant", "content": reply}], limit)


# ---------- 静默：先只听不说 / 一直没人说话 ----------

def idle_action(
    *,
    now: float,
    connected_at: float,
    silent_mode: bool,
    user_spoke: bool,
    speaking: bool,
    prompt_idx: int,
    idle_on: bool = True,
    idle_after_s: int = 14,
    silent_open_sec: int = 30,
    last_spoken_at: float = 0.0,
    last_flag: float = 0.0,
    call_open: bool = True,
    max_prompts: int = 3,
) -> str:
    """这一帧静音该做什么：

    open   她选了先只听不说，对面一直没出声，到点了 —— 先说一句
    idle   对方开过口又没动静 —— 催一句（最多 max_prompts 次）
    none   什么都不做
    """
    if speaking or not call_open:
        return "none"
    if silent_mode and not user_spoke:
        return "open" if now - connected_at >= silent_open_sec else "none"
    if user_spoke and idle_on and prompt_idx < max_prompts:
        quiet_since = max(last_spoken_at, last_flag)
        return "idle" if now - quiet_since > idle_after_s else "none"
    return "none"


def idle_prompt(prompts: list[str], prompt_idx: int) -> str:
    """催话文案；越界返回空串（调用方据此不再出声）。"""
    if 0 <= prompt_idx < len(prompts):
        return prompts[prompt_idx]
    return ""


def greet_is_silent(line: str) -> bool:
    """模型回「安静」就是她决定先只听不说。容忍方括号、括号、空白。"""
    if not line:
        return False
    return line.strip().strip("[]（）() ").strip() == "安静"


# ---------- 来电：她要不要接这通电话 ----------

# 来电窗标题里的动作词。长词在前，先剥长的，免得「语音通话」把「邀请你语音通话」剥成半截
_TITLE_NOISE = (
    "邀请你进行语音通话",
    "邀请你语音通话",
    "正在向你发起语音通话",
    "向你发起语音通话",
    "邀请你发起语音通话",
    "语音通话来电",
    "邀请你通话",
    "语音通话",
    "通话邀请",
    "正在呼叫",
    "来电",
)


def caller_from_title(title: str, unknown: str = "未知号码") -> str:
    """从来电窗口标题里认人。

    QQ 的来电窗标题一般是「<昵称> 邀请你语音通话」这类；剥掉动作词剩下的就是昵称。
    认不出来就返回 unknown —— 决策时按「未知号码」处理，不能因此就把人电话挂了。
    """
    t = (title or "").strip()
    if not t:
        return unknown
    for word in _TITLE_NOISE:
        t = t.replace(word, " ")
    t = " ".join(t.split())
    t = t.strip(" -—·:：()（）[]【】")
    if not t or t.lower() in ("qq", "腾讯qq", "腾讯 qq"):
        return unknown
    return t[:24]


def parse_verdict(text: str, wait_max: float = 5.0) -> dict | None:
    """把她那一行回话解析成决定。

    只认三种：接 / 不接 / 等N（秒）；后面可用「｜」接一句理由。
    返回 {"answer": True | False | None, "delay": 秒, "reason": 理由}；
    完全看不懂（空、闲聊、一大段解释）返回 None，交给兜底策略。
    """
    line = ""
    for raw in (text or "").splitlines():
        if raw.strip():
            line = raw.strip()
            break
    if not line:
        return None

    reason = ""
    for sep in ("｜", "|"):
        if sep in line:
            head, _, tail = line.partition(sep)
            line, reason = head.strip(), " ".join(tail.split())
            break
    low = line.lower()

    # 「不接」要先于「接」判，否则会被「接」抢走
    if any(k in line for k in ("不接", "挂断", "挂掉", "别接", "不接听")) or "no" in low or "decline" in low:
        return {"answer": False, "delay": 0.0, "reason": reason}

    for token in ("等", "wait"):
        idx = line.find(token)
        if idx < 0:
            continue
        digits = ""
        for ch in line[idx + len(token):]:
            if ch.isdigit() or ch == ".":
                digits += ch
            elif digits:
                break
        if digits:
            try:
                sec = float(digits)
            except ValueError:
                continue
            return {"answer": None, "delay": max(0.0, min(sec, float(wait_max))), "reason": reason}

    if any(k in line for k in ("接",)) or "yes" in low or "ok" in low or "answer" in low:
        return {"answer": True, "delay": 0.0, "reason": reason}
    return None


def decide_answer(policy: str = "decide", verdict: dict | None = None, on_error: str = "answer") -> dict:
    """策略 + 她的判断 → 动作。

    policy:
        always   总是接（模块原来的行为）
        never    一律不接
        decide   让她自己决定（默认）
    on_error: decide 时模型没回 / 回得看不懂怎么办 —— answer 先接上，skip 先不接
    返回 {"action": "answer" | "decline" | "wait", "delay": 秒, "why": 人话}
    """
    p = (policy or "decide").strip().lower()
    if p == "always":
        return {"action": "answer", "delay": 0.0, "why": "策略：总是接"}
    if p == "never":
        return {"action": "decline", "delay": 0.0, "why": "策略：都不接"}

    fallback_skip = (on_error or "answer").strip().lower() == "skip"
    if not verdict:
        return {"action": "decline" if fallback_skip else "answer", "delay": 0.0,
                "why": "她没给出判断，按兜底" + ("不接" if fallback_skip else "接上")}
    if verdict.get("answer") is True:
        return {"action": "answer", "delay": 0.0, "why": verdict.get("reason") or "她想接"}
    if verdict.get("answer") is False:
        return {"action": "decline", "delay": 0.0, "why": verdict.get("reason") or "她没接"}
    if float(verdict.get("delay") or 0) > 0:
        return {"action": "wait", "delay": float(verdict["delay"]),
                "why": verdict.get("reason") or "她想再响一会儿"}
    return {"action": "decline" if fallback_skip else "answer", "delay": 0.0,
            "why": "她的回答看不懂，按兜底" + ("不接" if fallback_skip else "接上")}


class AnswerDecider:
    """一通电话只问她一次，答案按窗口记住。

    状态：
        ask       这一帧第一次看到来电，调用方该去问她（调模型）
        pending   她说「等几秒」，还没到点
        answer    决定接了（points 由调用方真点）
        decline   决定不接，别再问
    """

    ASK = "ask"
    PENDING = "pending"
    ANSWER = "answer"
    DECLINE = "decline"

    def __init__(self, policy: str = "decide", on_error: str = "answer", wait_max: float = 5.0):
        self.policy = policy
        self.on_error = on_error
        self.wait_max = float(wait_max)
        self._by_hwnd: dict[int, dict] = {}

    def begin(self, hwnd: int, caller: str, now: float) -> str:
        """看一眼这个窗口现在是什么状态；第一次看到就返回 ask。"""
        cur = self._by_hwnd.get(hwnd)
        if cur:
            return cur["state"]
        self._by_hwnd[hwnd] = {
            "caller": caller, "asked_at": float(now), "state": self.ASK,
            "due": None, "action": None, "why": "", "decided_at": None,
        }
        return self.ASK

    def resolve(self, hwnd: int, verdict: dict | None, now: float) -> dict:
        """把她的判断落成状态；返回 {action, delay, why, caller}。"""
        cur = self._by_hwnd.get(hwnd)
        if not cur:
            self.begin(hwnd, "", now)
            cur = self._by_hwnd[hwnd]
        d = decide_answer(self.policy, verdict, self.on_error)
        cur["action"], cur["why"], cur["decided_at"] = d["action"], d["why"], float(now)
        if d["action"] == "wait":
            cur["state"] = self.PENDING
            cur["due"] = float(now) + float(d["delay"])
        else:
            cur["state"] = self.ANSWER if d["action"] == "answer" else self.DECLINE
        return {**d, "caller": cur["caller"]}

    def tick(self, hwnd: int, now: float) -> bool:
        """等够没：只有 pending 到点这一下返回 True（调用方据此真点）。"""
        cur = self._by_hwnd.get(hwnd)
        if not cur or cur["state"] != self.PENDING:
            return False
        if float(cur["due"] or 0) <= float(now):
            cur["state"] = self.ANSWER
            return True
        return False

    def state(self, hwnd: int) -> str:
        cur = self._by_hwnd.get(hwnd)
        return cur["state"] if cur else ""

    def result(self, hwnd: int) -> dict | None:
        cur = self._by_hwnd.get(hwnd)
        if not cur:
            return None
        return {"caller": cur["caller"], "action": cur["action"], "why": cur["why"],
                "asked_at": cur["asked_at"], "decided_at": cur["decided_at"]}

    def clear(self, hwnd: int | None = None) -> None:
        if hwnd is None:
            self._by_hwnd.clear()
        else:
            self._by_hwnd.pop(hwnd, None)
