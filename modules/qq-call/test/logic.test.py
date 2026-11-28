"""runtime/logic.py 的离线测试：不碰 QQ、不碰声卡、不碰模型。

跑法（模块目录下）：
    python -m unittest test/logic.test.py -v
或直接：
    python test/logic.test.py
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "runtime"))

import logic  # noqa: E402


class CallGateTest(unittest.TestCase):
    """① 来电事件 → 接听 / 不接。"""

    def setUp(self):
        self.gate = logic.CallGate(cooldown=10.0, auto=True)

    def test_不是绿钮就不点(self):
        self.assertEqual(self.gate.observe(1001, False, 100.0), "no-button")
        self.assertEqual(self.gate.state, logic.CallGate.IDLE)

    def test_看到绿钮就点并进入已接听(self):
        self.assertEqual(self.gate.observe(1001, True, 100.0), "click")
        self.assertEqual(self.gate.state, logic.CallGate.RINGING)
        self.gate.mark_clicked(1001, 100.0)
        self.assertEqual(self.gate.state, logic.CallGate.ANSWERED)

    def test_点过之后十秒内不重复点(self):
        self.gate.observe(1001, True, 100.0)
        self.gate.mark_clicked(1001, 100.0)
        self.assertEqual(self.gate.observe(1001, True, 101.0), "cooldown")
        self.assertEqual(self.gate.observe(1001, True, 109.9), "cooldown")
        self.assertEqual(self.gate.observe(1001, True, 110.5), "click")

    def test_冷却按窗口算_另一个窗口不受影响(self):
        self.gate.observe(1001, True, 100.0)
        self.gate.mark_clicked(1001, 100.0)
        self.assertEqual(self.gate.observe(1002, True, 100.0), "click")

    def test_自动接听关着就只看着(self):
        gate = logic.CallGate(cooldown=10.0, auto=False)
        self.assertEqual(gate.observe(1001, True, 100.0), "disabled")
        self.assertEqual(gate.state, logic.CallGate.RINGING)  # 知道有来电，但不动手
        self.assertEqual(gate.observe(1001, True, 100.0), "disabled")

    def test_窗口消失_接过的算结束(self):
        self.gate.observe(1001, True, 100.0)
        self.gate.mark_clicked(1001, 100.0)
        self.assertEqual(self.gate.on_window_gone(1001), "ended")
        self.assertEqual(self.gate.state, logic.CallGate.ENDED)

    def test_窗口消失_没接过的当没来过(self):
        self.gate.observe(1001, True, 100.0)
        self.assertEqual(self.gate.on_window_gone(1001), "missed")
        self.assertEqual(self.gate.state, logic.CallGate.IDLE)

    def test_结束后再来电报到新状态(self):
        self.gate.observe(1001, True, 100.0)
        self.gate.mark_clicked(1001, 100.0)
        self.gate.on_window_gone(1001)
        self.assertEqual(self.gate.state, logic.CallGate.ENDED)
        self.assertEqual(self.gate.observe(1001, True, 200.0), "click")
        self.assertEqual(self.gate.state, logic.CallGate.RINGING)


class VoiceSegmenterTest(unittest.TestCase):
    """② 一帧帧攒出一句；她说话时对方插话就是打断。"""

    def setUp(self):
        self.seg = logic.VoiceSegmenter()

    def 语音帧(self, n, rms=0.10):
        events = []
        for _ in range(n):
            events.append(self.seg.feed(rms, speaking=False))
        return events

    def 静音帧(self, n, rms=0.001):
        events = []
        for _ in range(n):
            events.append(self.seg.feed(rms, speaking=False))
        return events

    def test_一直静音不出事件(self):
        events = self.静音帧(30)
        self.assertTrue(all(e["kind"] == "silence" for e in events))
        self.assertFalse(self.seg.active)

    def test_开口那一帧是start_之后是speech(self):
        events = self.语音帧(3)
        self.assertEqual(events[0]["kind"], "start")
        self.assertEqual(events[1]["kind"], "speech")
        self.assertEqual(events[2]["kind"], "speech")
        self.assertEqual(events[0]["utter_ms"], 40)

    def test_静音够600毫秒才收句(self):
        events = self.语音帧(8)          # 320ms，够长
        self.assertTrue(self.seg.active)
        tail = self.静音帧(14)           # 560ms，还不到 600
        self.assertFalse(any(e["kind"] == "end" for e in tail))
        events = self.静音帧(1)          # 第 15 帧，600ms
        self.assertEqual(events[0]["kind"], "end")
        self.assertTrue(events[0]["long_enough"])
        self.assertFalse(self.seg.active)

    def test_太短的人声当咳嗽丢掉(self):
        self.语音帧(2)                   # 80ms
        end = self.静音帧(15)[-1]
        self.assertEqual(end["kind"], "end")
        self.assertFalse(end["long_enough"])

    def test_她说话时对方开口就是打断(self):
        event = self.seg.feed(0.10, speaking=True)
        self.assertEqual(event["kind"], "start")
        self.assertTrue(event["barge_in"])

        event = self.seg.feed(0.10, speaking=False)
        self.assertFalse(event["barge_in"])

    def test_静音帧不是打断(self):
        self.seg.feed(0.10, speaking=True)
        event = self.seg.feed(0.001, speaking=True)
        self.assertFalse(event["barge_in"])

    def test_底噪大时门槛自动抬高(self):
        # 风扇声 0.015：一开始低于 0.018 的门槛，攒一会儿把地板抬起来
        for _ in range(60):
            self.seg.feed(0.015)
        self.assertGreater(self.seg.threshold(), 0.03)
        self.assertGreaterEqual(self.seg.noise, 0.012)
        # 抬起来之后，0.02 的底噪不再被当成人声
        event = self.seg.feed(0.020)
        self.assertEqual(event["kind"], "silence")
        self.assertFalse(self.seg.active)

    def test_reset_清掉段内状态(self):
        self.语音帧(5)
        self.seg.reset()
        self.assertFalse(self.seg.active)
        self.assertEqual(self.seg.utter_ms, 0)


class MessagesTest(unittest.TestCase):
    """上下文拼接：system 在最前，只带最近几句，记住后裁到 8 条。"""

    def test_system_在最前_只带最近6条(self):
        history = [{"role": "user" if i % 2 == 0 else "assistant", "content": f"m{i}"} for i in range(10)]
        got = logic.build_messages("你是她", history, "现在这句")
        self.assertEqual(got[0], {"role": "system", "content": "你是她"})
        self.assertEqual(len(got), 1 + 6 + 1)
        self.assertEqual(got[1]["content"], "m4")
        self.assertEqual(got[-1], {"role": "user", "content": "现在这句"})

    def test_历史短就全带上(self):
        got = logic.build_messages("sys", [{"role": "user", "content": "上一句"}], "这一句")
        self.assertEqual([m["content"] for m in got], ["sys", "上一句", "这一句"])

    def test_记住之后裁到8条(self):
        history = [{"role": "user", "content": f"m{i}"} for i in range(10)]
        got = logic.append_turn(history, "问", "答")
        self.assertEqual(len(got), 8)
        self.assertEqual(got[-2:], [{"role": "user", "content": "问"}, {"role": "assistant", "content": "答"}])

    def test_不记住就不改历史(self):
        history = [{"role": "user", "content": "x"}]
        self.assertEqual(logic.build_messages("sys", history, "临时")[-1]["content"], "临时")
        self.assertEqual(len(history), 1)


class IdleTest(unittest.TestCase):
    """静默策略：先只听不说到点开口；对方开过口才催话，催三次就安静。"""

    def 判(self, **kw):
        base = dict(
            now=100.0, connected_at=100.0, silent_mode=False, user_spoke=False,
            speaking=False, prompt_idx=0, idle_on=True, idle_after_s=14,
            silent_open_sec=30, last_spoken_at=100.0, last_flag=100.0, call_open=True,
        )
        base.update(kw)
        return logic.idle_action(**base)

    def test_没接通没人说话就不出声(self):
        self.assertEqual(self.判(), "none")

    def test_先只听不说_三十秒后开口(self):
        self.assertEqual(self.判(silent_mode=True, now=125.0), "none")
        self.assertEqual(self.判(silent_mode=True, now=131.0), "open")

    def test_对方开过口就不再走先听不说的分支(self):
        # 对方一旦开过口，就不该再「一直没人说话」地干等着，而是按催话节奏走
        self.assertEqual(self.判(silent_mode=True, user_spoke=True, now=105.0), "none")
        self.assertEqual(self.判(silent_mode=True, user_spoke=True, now=200.0), "idle")

    def test_对方不吭声十四秒后催一句(self):
        self.assertEqual(self.判(user_spoke=True, now=112.0), "none")
        self.assertEqual(self.判(user_spoke=True, now=115.0), "idle")

    def test_催三次就停(self):
        self.assertEqual(self.判(user_spoke=True, now=115.0, prompt_idx=2), "idle")
        self.assertEqual(self.判(user_spoke=True, now=115.0, prompt_idx=3), "none")

    def test_她在说话或电话已经关掉就不催(self):
        self.assertEqual(self.判(user_spoke=True, now=115.0, speaking=True), "none")
        self.assertEqual(self.判(user_spoke=True, now=115.0, call_open=False), "none")

    def test_催话开关关掉不催(self):
        self.assertEqual(self.判(user_spoke=True, now=115.0, idle_on=False), "none")

    def test_催话文案越界返回空(self):
        self.assertEqual(logic.idle_prompt(["a", "b", "c"], 0), "a")
        self.assertEqual(logic.idle_prompt(["a", "b", "c"], 3), "")


class GreetTest(unittest.TestCase):
    """模型想不出来时回「安静」= 她决定先听着。"""

    def test_认安静(self):
        for line in ["安静", " 安静 ", "（安静）", "[安静]"]:
            self.assertTrue(logic.greet_is_silent(line), line)

    def test_不认别的(self):
        for line in ["", "安静一点", "我先安静听着", None]:
            self.assertFalse(logic.greet_is_silent(line))


class CallerTest(unittest.TestCase):
    """来电窗口标题 → 是谁打来的。"""

    def test_常见标题(self):
        self.assertEqual(logic.caller_from_title("小明 邀请你语音通话"), "小明")
        self.assertEqual(logic.caller_from_title("  阿澜 正在向你发起语音通话 "), "阿澜")

    def test_认不出来就是未知号码(self):
        self.assertEqual(logic.caller_from_title(""), "未知号码")
        self.assertEqual(logic.caller_from_title("语音通话"), "未知号码")
        self.assertEqual(logic.caller_from_title("QQ"), "未知号码")

    def test_太长的截断(self):
        self.assertEqual(len(logic.caller_from_title("一" * 40)), 24)


class VerdictTest(unittest.TestCase):
    """她那一行回话 → 接 / 不接 / 等几秒。"""

    def test_接(self):
        self.assertTrue(logic.parse_verdict("接")["answer"])

    def test_不接不会被接抢走(self):
        self.assertFalse(logic.parse_verdict("不接")["answer"])

    def test_带理由(self):
        got = logic.parse_verdict("接｜想你了")
        self.assertTrue(got["answer"])
        self.assertEqual(got["reason"], "想你了")

    def test_等几秒(self):
        got = logic.parse_verdict("等3")
        self.assertIsNone(got["answer"])
        self.assertEqual(got["delay"], 3.0)

    def test_等也封顶(self):
        got = logic.parse_verdict("等 9｜再响会儿", wait_max=5)
        self.assertEqual(got["delay"], 5.0)
        self.assertEqual(got["reason"], "再响会儿")

    def test_看不懂返回None(self):
        self.assertIsNone(logic.parse_verdict(""))
        self.assertIsNone(logic.parse_verdict("今天有点困，算了吧"))

    def test_英文也算(self):
        self.assertFalse(logic.parse_verdict("no")["answer"])


class DecideTest(unittest.TestCase):
    """策略 + 她的判断 → 动作。"""

    def test_总是接(self):
        self.assertEqual(logic.decide_answer("always", None)["action"], "answer")

    def test_一律不接(self):
        self.assertEqual(logic.decide_answer("never", {"answer": True})["action"], "decline")

    def test_她说不接就不接(self):
        got = logic.decide_answer("decide", {"answer": False, "reason": "不想聊"})
        self.assertEqual(got["action"], "decline")
        self.assertEqual(got["why"], "不想聊")

    def test_她说接就接(self):
        self.assertEqual(logic.decide_answer("decide", {"answer": True})["action"], "answer")

    def test_她说等就是等(self):
        got = logic.decide_answer("decide", {"answer": None, "delay": 3})
        self.assertEqual(got["action"], "wait")
        self.assertEqual(got["delay"], 3.0)

    def test_没判断按兜底(self):
        self.assertEqual(logic.decide_answer("decide", None, "answer")["action"], "answer")
        self.assertEqual(logic.decide_answer("decide", None, "skip")["action"], "decline")

    def test_看不懂也按兜底(self):
        self.assertEqual(logic.decide_answer("decide", {"answer": None, "delay": 0}, "answer")["action"], "answer")
        self.assertEqual(logic.decide_answer("decide", {"answer": None, "delay": 0}, "skip")["action"], "decline")


class DeciderTest(unittest.TestCase):
    """一通电话只问她一次；「等几秒」要真的等到点才接。"""

    def test_第一次看到就问(self):
        d = logic.AnswerDecider()
        self.assertEqual(d.begin(2001, "小明", 100.0), d.ASK)

    def test_问过就不再问(self):
        d = logic.AnswerDecider()
        d.begin(2001, "小明", 100.0)
        d.resolve(2001, {"answer": True}, 101.0)
        self.assertEqual(d.begin(2001, "小明", 102.0), d.ANSWER)

    def test_不接就一直不接(self):
        d = logic.AnswerDecider()
        d.begin(2001, "小明", 100.0)
        d.resolve(2001, {"answer": False, "reason": "在忙"}, 101.0)
        self.assertEqual(d.begin(2001, "小明", 103.0), d.DECLINE)
        self.assertEqual(d.state(2001), d.DECLINE)

    def test_等几秒到点才接(self):
        d = logic.AnswerDecider(policy="decide", wait_max=5)
        d.begin(2001, "小明", 100.0)
        d.resolve(2001, {"answer": None, "delay": 3}, 101.0)
        self.assertEqual(d.begin(2001, "小明", 101.5), d.PENDING)
        self.assertFalse(d.tick(2001, 103.0))   # 3 秒还没到
        self.assertTrue(d.tick(2001, 104.2))    # 到了
        self.assertEqual(d.begin(2001, "小明", 104.5), d.ANSWER)

    def test_结果带着来电人(self):
        d = logic.AnswerDecider()
        d.begin(2001, "小明", 100.0)
        r = d.resolve(2001, {"answer": True}, 101.0)
        self.assertEqual(r["caller"], "小明")
        self.assertEqual(d.result(2001)["caller"], "小明")

    def test_窗口消失就清掉(self):
        d = logic.AnswerDecider()
        d.begin(2001, "小明", 100.0)
        d.resolve(2001, {"answer": False}, 101.0)
        d.clear(2001)
        self.assertEqual(d.begin(2001, "小明", 200.0), d.ASK)

    def test_总是接就不用她判断(self):
        d = logic.AnswerDecider(policy="always")
        d.begin(2001, "小明", 100.0)
        r = d.resolve(2001, None, 101.0)
        self.assertEqual(r["action"], "answer")
        self.assertEqual(r["why"], "策略：总是接")


if __name__ == "__main__":
    unittest.main(verbosity=2)
