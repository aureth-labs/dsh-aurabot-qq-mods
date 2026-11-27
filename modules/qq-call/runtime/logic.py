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
