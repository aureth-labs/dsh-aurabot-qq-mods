# 自动变调：读干声，用 librosa.pyin 估基频，把中位音高夹到模型舒适区。
# 输出一行：shift 中位Hz p95Hz
# 检测框架照搬 dafish 唱歌包（其参数来自实测），舒适区沿用本项目 270~320Hz：
#   · 检测上限 1300Hz —— 老版自相关写死 600Hz，>600Hz 的女高音会折成低八度，
#     中位读数掉一半，变调方向直接反（《左手指月》实测最高 1240Hz 案例）
#   · 低音歌八度纠错：pyin 偶尔把男声锁在二次谐波上（读高一倍）；只在中位<400Hz
#     时和 260Hz 窄带读数对一次，谱能量确认是真高八度才采信——高音歌本来就在高频，
#     再比只会把它按回低八度
#   · p95 天花板 480Hz：只盯中位数会把最高的几句顶出模型音域，表现是某一句
#     突然劈掉；天花板最多把整首往下拉 3 个半音，不然为了一句高音主歌压得太低
import os
import sys
import wave

import numpy as np


def main():
    if len(sys.argv) < 2:
        print("0 0 0")
        return
    with wave.open(sys.argv[1], "rb") as w:
        sr, ch, n = w.getframerate(), w.getnchannels(), w.getnframes()
        a = np.frombuffer(w.readframes(n), dtype=np.int16).astype(np.float32) / 32768.0
    if ch == 2:
        a = a.reshape(-1, 2).mean(axis=1)
    if len(a) < 16000:
        print("0 0 0")
        return

    import warnings
    warnings.filterwarnings("ignore")
    import librosa

    fmax = float(os.environ.get("SONG_PITCH_FMAX", "1300"))
    ceiling = float(os.environ.get("SONG_PITCH_CEILING_HZ", "480"))

    def pyin_stats(y, fmax_hz):
        f0, _, _ = librosa.pyin(y, fmin=65, fmax=fmax_hz, sr=16000,
                                frame_length=1024, hop_length=256, fill_na=np.nan)
        mask = np.isfinite(f0)
        if mask.sum() < 10:
            return 0.0, 0.0
        v = f0[mask]
        return float(np.median(v)), float(np.percentile(v, 95))

    if sr != 16000:
        y16 = librosa.resample(a, orig_sr=sr, target_sr=16000)
    else:
        y16 = a

    med, p95 = pyin_stats(y16, fmax)
    if med <= 0:
        print("0 0 0")
        return
    # 低音歌八度纠错：中位<400Hz 才做，且谱能量验证 260Hz 窄带确实有货
    if med < 400:
        lo_med, lo_95 = pyin_stats(y16, 260)
        if lo_med > 0 and 1.75 <= med / lo_med <= 2.25:
            spec = np.abs(librosa.stft(y16, n_fft=2048, hop_length=512)).mean(axis=1)
            freqs = librosa.fft_frequencies(sr=16000, n_fft=2048)

            def band(f):
                m = (freqs >= f * 0.94) & (freqs <= f * 1.06)
                return float(spec[m].mean()) if m.any() else 0.0

            if band(lo_med) >= 0.25 * band(med):
                med, p95 = lo_med, lo_95

    # ★ 2026-11-03 重写：原逻辑「把中位夹到 270~320Hz」对女声源是有害的。
    # 实测 81 次点歌 **100% 都是降调**（-1~-6），因为女声流行歌中位普遍 300~460Hz，
    # 一律被压到 320 以下，整首降 2~6 个半音 —— 低沉、发闷。
    # 而且降调时伴奏必须跟着移调（否则跑调），移得越多音质损失越大，
    # 等于"每首歌都被削一刀"。dafish 自己的规则也写着「差 1~3 个半音不值得改整首」。
    #
    # 现在按「源是男声还是女声」分档，而不是硬夹区间：
    #   · 中位 < 220Hz  → 男声源，升到 270~320（女声模型的舒适区）
    #   · 220 ~ 480Hz   → 女声源，不动
    #   · > 480Hz       → 可能检测偏高（谐波锁定），最多降 2 个半音
    MALE_MAX = float(os.environ.get("SONG_PITCH_MALE_MAX", "220"))
    FEMALE_MIN = float(os.environ.get("SONG_PITCH_FEMALE_MIN", "480"))
    if med < MALE_MAX:
        target = min(320.0, max(270.0, med))
        shift = 12 * np.log2(target / med)
    elif med > FEMALE_MIN:
        shift = max(-2.0, 12 * np.log2(440.0 / med))
    else:
        shift = 0.0
    # 高音天花板：只约束**升调**（防止升上去把最高的几句顶出模型音域）；
    # 降调时它会把整首再往下压，正是原逻辑越修越闷的原因。
    if shift > 0 and p95 > 0 and ceiling > 0:
        ceil_semis = 12 * np.log2(ceiling / p95)
        shift = min(shift, max(ceil_semis, 0.0))
    # 差 1 个半音不值得动整首歌：移调本身有音质代价
    if abs(shift) < 2:
        shift = 0.0
    shift = int(round(shift))
    shift = max(-12, min(12, shift))

    print("%d %.0f %.0f" % (shift, med, p95))


main()
