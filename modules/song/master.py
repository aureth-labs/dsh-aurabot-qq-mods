# 翻唱母带链：人声激励 → 压缩/混响 → 伴奏跟调移调 → 混音 → 临场感高架 → -14 LUFS + 峰值夹紧。
# 移植自 dafish 唱歌包 master.py（原样移植自君若唱歌 auto_master.py，参数都是对方实测出来的，别随手改）：
#   · 激励源 3 kHz + 高架 2.5 kHz：中文辅音（s/sh/x/c/q/ch/z/zh/j）能量在 2-4 kHz，
#     实测把「2-8k / 0-1k」清晰度比值从 4% 抬到 13.7%；原来写 7k/9.5k 等于空房间点灯
#   · RVC 模型输入端做 EQ 无用（输出频谱被强行拉回训练集音色），清晰度只能加在模型之后
#   · 压缩阈值 -18 dB / attack 8ms / release 120ms，混响 room 0.15 / damping 0.7
#   · 混音上再补一道 +5.5 dB / 2.5 kHz 线性高架（只补人声会被伴奏低频稀释）
#   · 最后两遍式 -14 LUFS + 峰值 0.95 夹紧（QQ 语音条响度一致）
# 与原版的差异：不做变调决策（pitch 由调用方 pitch.py 算好传入），人声已由 RVC 按该半音数转过，
#   这里只负责把**伴奏移同样的半音数**——不移的话人声和伴奏跑调整个大二度。
# 用法： python master.py <RVC人声wav> <伴奏wav> <输出mp3> <变调半音> [--reverb 0.3]
# 输出一行 JSON：{"ok":true,"loudness_before":...,"peak":...}
import json
import os
import shutil
import subprocess
import sys
import warnings
from pathlib import Path

import librosa
import numpy as np
import pyloudnorm as pyln
import soundfile as sf
from pedalboard import Compressor, Pedalboard, Reverb

warnings.filterwarnings("ignore")


def _resolve_ffmpeg() -> str:
    """找 ffmpeg：SING_FFMPEG 环境变量 → 脚本旁 bin → PATH。"""
    env = os.environ.get("SING_FFMPEG")
    if env and Path(env).is_file():
        return env
    exe = "ffmpeg.exe" if os.name == "nt" else "ffmpeg"
    base = Path(__file__).resolve().parent
    for cand in (base / "bin" / exe, base.parent / "bin" / exe, base / exe):
        if cand.is_file():
            return str(cand)
    return shutil.which("ffmpeg") or exe


FFMPEG = _resolve_ffmpeg()

# 混音临场感高架：实测混音里 2-4 kHz 只占 2-4%（人声提升被伴奏低频稀释）。
# 原版 dafish 用 +5.5 dB；这里默认降到 3.0 dB —— 原因见下。
#
# ★ 2026-11-03 修正（实测「听着比以前差」）：
#   dafish 的 6.0 dB 高架 + 5.5 dB 混音高架，是在**真人录音棚干声**上标定的。
#   我们的输入是 **RVC 换声输出**，频谱本来就更薄更亮，再套同一套参数会叠加过量。
#   实测 last_rvc.wav 走原链：3 kHz +13.2 dB、6 kHz +17.7 dB、8 kHz +15.8 dB，
#   峰值 0.99→1.84；落到成品上 2-4 kHz 能量占比 21.2%→34.7%、频谱质心 1294→1586 Hz，
#   听感就是「刺、齿音重、发尖」。而注释自己写着「超过 7 dB 开始齿音刺耳」——
#   原实现却在最平坦（flatness<0.02）时自动选 7.74 dB 档，正好越过红线。
#   现在：分档上限压回 dafish 实测过的 0.7 档，混音高架降到 3.0 dB，并开放命令行覆盖。
MIX_PRESENCE_DB = 3.0


def presence_filter(db: float) -> str:
    return f"highshelf=g={db:.1f}:f=2500"


MIX_PRESENCE = presence_filter(MIX_PRESENCE_DB)



def shift_audio(src: Path, dst: Path, semitones: int, sr: int | None = None) -> None:
    """保持时长地移调。

    ★ 2026-11-03 修正：原来用 asetrate+atempo。asetrate 是「改播放速度」，
    共振峰跟着一起移动，降调时相当于给伴奏做了个低通 —— 实测 -5 半音后
    8 kHz 以上能量从 9.27% 掉到 3.84%（-58%），伴奏发闷、鼓变糊。
    而 81 次点歌的自动变调**全是降调**（-1~-6），等于每首都伤一次。

    改用 ffmpeg 的 rubberband（相位声码器，保时长 + 保共振峰）：
    同条件 -5 半音，>8 kHz 只掉到 6.28%（-32%），音色明显更接近原版。
    rubberband 不可用时自动回落 asetrate+atempo，功能不受影响。
    """
    if semitones == 0:
        subprocess.run([str(FFMPEG), "-y", "-loglevel", "error", "-i", str(src),
                        "-ar", "44100", str(dst)], check=True)
        return
    r = 2 ** (semitones / 12)
    rb = f"rubberband=pitch={r:.6f}:formant=preserved:transients=smooth,aresample=44100"
    try:
        subprocess.run([str(FFMPEG), "-y", "-loglevel", "error", "-i", str(src),
                        "-af", rb, "-ar", "44100", str(dst)], check=True)
        return
    except subprocess.CalledProcessError:
        # 这个 ffmpeg 没编 rubberband，走老路（音质差一档，但功能不受影响）
        print(f"[master] rubberband 不可用，伴奏移调回落到 asetrate（{semitones} 半音）", file=sys.stderr)
    if sr is None:
        sr = int(sf.info(str(src)).samplerate)
    af = f"asetrate={sr}*{r:.6f},atempo={1 / r:.6f},aresample=44100"
    subprocess.run([str(FFMPEG), "-y", "-loglevel", "error", "-i", str(src),
                    "-af", af, "-ar", "44100", str(dst)], check=True)


def excite(src: Path, dst: Path, amount: float, scale: float = 1.0) -> None:
    """补高频，频段按实测定。

    amount 由频谱平坦度推导，取值 0.4 / 0.55 / 0.7（原版是 0.45/0.7/0.9，
    0.9 档是外推的、没有实测支撑，且会越过「7 dB 齿音红线」，已废弃）。
    0.7 那档对应实测过的 aexciter 0.55 / 高架 6.0 dB，其余按同一比例缩放。
    scale 是外部再缩放（面板/命令行调「激励强度」用），1.0 = 按实测档位。
    末尾必须挂限幅：高架最多加 6 dB，能把峰值顶到 0 dBFS，int16 一旦削波
    就是硬失真，后面补不回来。净增益保持 0 dB（-6/+6 对消），不然人声/伴奏比例会变。
    """
    amount = amount * scale
    if amount <= 0:
        # 激励强度为 0：只统一采样率，完全不碰频谱。
        # 这样「不激励」是真的原声，不会被 aexciter/highshelf 的残留处理带偏。
        subprocess.run([str(FFMPEG), "-y", "-loglevel", "error", "-i", str(src),
                        "-ar", "44100", str(dst)], check=True)
        return
    ex = amount * 0.78
    shelf = amount * 8.6
    af = (f"volume=-6dB,"
          f"aexciter=amount={ex:.2f}:drive=6.0:freq=3000:ceil=10000:blend=0.20,"
          f"highshelf=g={shelf:.1f}:f=2500,volume=6dB,"
          f"alimiter=limit=0.85:attack=0.5:release=40:level=false")
    subprocess.run([str(FFMPEG), "-y", "-loglevel", "error", "-i", str(src),
                    "-af", af, "-ar", "44100", str(dst)], check=True)


def _presence_shelf(mix: np.ndarray, sr: int, work: Path, db: float = MIX_PRESENCE_DB) -> np.ndarray:
    """给整首歌混音加一道临场感高架（线性 EQ，不产生谐波失真）。

    走 ffmpeg 而不是自己卷积，是为了保住双声道与原有声道顺序。
    中间文件用 float32 写，避免 int16 在响度标准化之前就先削掉峰值。
    """
    raw = work / "_pre_shelf.wav"
    eqd = work / "_post_shelf.wav"
    sf.write(str(raw), mix, sr, subtype="FLOAT")
    subprocess.run([str(FFMPEG), "-y", "-loglevel", "error", "-i", str(raw),
                    "-af", presence_filter(db), "-c:a", "pcm_f32le", str(eqd)], check=True)
    y, _ = sf.read(str(eqd), always_2d=True, dtype="float32")
    return y


def analyze_voice(path: Path) -> dict:
    """只测母带需要的量：频谱平坦度（决定激励强度）和动态（决定混响/压缩比）。
    变调决策在 pitch.py 里做过了，这里不重复跑 pyin。"""
    y, sr = sf.read(str(path), always_2d=True, dtype="float32")
    y = y.mean(axis=1)
    if sr != 16000:
        y = librosa.resample(y, orig_sr=sr, target_sr=16000)
    S = np.abs(librosa.stft(y, n_fft=1024, hop_length=256))
    flat = float(np.mean(librosa.feature.spectral_flatness(S=S)))
    rms = librosa.feature.rms(y=y, frame_length=1024, hop_length=256)[0]
    loud = rms[rms > np.percentile(rms, 40)]
    rms_db = 20 * np.log10(np.maximum(loud, 1e-9)) if loud.size > 10 else np.array([-60.0])
    dyn = float(np.percentile(rms_db, 95) - np.percentile(rms_db, 10))
    # 平坦度越低，说明气息越少，越需要激励补高频。
    # 上限 0.7（= aexciter 0.55 / 高架 6.0 dB），这是 dafish 唯一实测过的档位；
    # 原来的 0.9 档是线性外推，实测 6 kHz 会被抬到 +17.7 dB，齿音刺耳。
    excite = 0.7 if flat < 0.02 else (0.55 if flat < 0.06 else 0.4)
    # 动态越小说明被压得越狠，混响要少一点避免更糊；动态过大需要更强压缩
    reverb_wet = 0.20 if dyn > 8 else 0.15
    ratio = 3.0 if dyn > 12 else (2.5 if dyn > 8 else 2.0)
    return {"flatness": flat, "dynamic_db": dyn,
            "excite_amount": excite, "reverb_wet": reverb_wet, "compress_ratio": ratio}


def master(vocal: Path, acc: Path, out_mp3: Path, pitch: int, info: dict,
           work: Path, reverb_override: float | None = None,
           vocal_vol: float = 1.0, inst_vol: float = 0.8,
           excite_scale: float = 1.0, presence_db: float = MIX_PRESENCE_DB,
           lufs: float = -16.0) -> dict:
    work.mkdir(exist_ok=True)

    # 1. 伴奏跟调：人声已被 RVC 移了 pitch，伴奏不移就跑调
    #    inst_vol = 0（清唱）时伴奏根本进不了混音，跳过整曲解码和移调
    silent_inst = inst_vol <= 0
    if not silent_inst:
        sr_a = int(sf.info(str(acc)).samplerate)
        acc_shifted = work / "acc_shifted.wav"
        shift_audio(acc, acc_shifted, pitch, sr=sr_a)

    # 2. 人声激励（excite_scale 由面板「激励强度」控制）
    voc_exc = work / "voc_excited.wav"
    excite(vocal, voc_exc, info["excite_amount"], scale=excite_scale)

    # 3. 压缩 + 混响（pedalboard，与 AICoverGen 同引擎）
    v, sr = sf.read(str(voc_exc), always_2d=True, dtype="float32")
    mono = v.mean(axis=1)
    wet = info["reverb_wet"] if reverb_override is None else reverb_override
    board = Pedalboard([
        Compressor(threshold_db=-18, ratio=info["compress_ratio"],
                   attack_ms=8, release_ms=120),
        Reverb(room_size=0.15, damping=0.7,
               wet_level=wet, dry_level=1.0 - wet, width=1.0),
    ])
    processed = np.asarray(board(mono, sr), dtype="float32")

    # 4. 混音（shift_audio 统一输出 44.1k）：人声/伴奏各自按面板音量缩放，
    #    相对比例在这里定死，后面的 LUFS 标准化只整体抬降、不改比例
    if silent_inst:
        # 清唱：只有人声，长度也不再被伴奏截断
        mix = np.stack([processed, processed], axis=1) * vocal_vol
    else:
        a, sr_a = sf.read(str(acc_shifted), always_2d=True, dtype="float32")
        if sr_a != sr:
            a = librosa.resample(a.T, orig_sr=sr_a, target_sr=sr).T
        n = min(len(processed), len(a))
        vocal_st = np.stack([processed[:n], processed[:n]], axis=1)
        mix = vocal_st * vocal_vol + a[:n] * inst_vol

    # 5. 混音临场感高架
    mix = _presence_shelf(mix, sr, work, db=presence_db)

    # 6. 响度标准化（两遍式，避免单遍 loudnorm 过冲）+ 峰值夹紧
    #    -14 LUFS 是音乐平台标准，但 QQ 语音条会二次转码（silk/amr），
    #    留 2 dB 余量更稳：默认 -16，可用 --lufs 覆盖。
    meter = pyln.Meter(sr)
    loud = meter.integrated_loudness(mix)
    if np.isfinite(loud) and loud > -70:
        mix = pyln.normalize.loudness(mix, loud, lufs)
    peak = float(np.max(np.abs(mix)))
    if peak > 0.95:
        mix = mix * (0.95 / peak)

    tmp_wav = work / "mix.wav"
    sf.write(str(tmp_wav), mix, sr)
    subprocess.run([str(FFMPEG), "-y", "-loglevel", "error", "-i", str(tmp_wav),
                    "-ar", "44100", "-c:a", "libmp3lame", "-b:a", "192k",
                    str(out_mp3)], check=True)

    return {"ok": True, "output": str(out_mp3),
            "loudness_before": round(float(loud), 1), "peak": round(peak, 3)}


def main() -> int:
    args = sys.argv[1:]
    reverb = None
    vocal_vol, inst_vol = 1.0, 0.8
    excite_scale, presence_db, lufs = 1.0, MIX_PRESENCE_DB, -16.0
    opts = {"--reverb", "--vol", "--inst-vol", "--excite", "--presence", "--lufs"}
    i = 0
    while i < len(args):
        key = args[i]
        if key in opts and i + 1 < len(args):
            val = float(args[i + 1])
            if key == "--reverb": reverb = val
            elif key == "--vol": vocal_vol = val
            elif key == "--inst-vol": inst_vol = val
            elif key == "--excite": excite_scale = max(0.0, min(1.5, val))
            elif key == "--presence": presence_db = max(0.0, min(8.0, val))
            elif key == "--lufs": lufs = max(-30.0, min(-8.0, val))
            args = args[:i] + args[i + 2:]
        else:
            i += 1
    if len(args) < 4:
        print(json.dumps({"error": "用法: master.py <RVC人声> <伴奏> <输出mp3> <pitch> [--reverb 0.3] [--vol 1] [--inst-vol 0.8] [--excite 1.0] [--presence 3.0] [--lufs -16]"}), flush=True)
        return 2
    vocal, acc, out = Path(args[0]).absolute(), Path(args[1]).absolute(), Path(args[2]).absolute()
    pitch = int(args[3])
    try:
        info = analyze_voice(vocal)
        r = master(vocal, acc, out, pitch, info, out.with_suffix(""), reverb,
                   vocal_vol=vocal_vol, inst_vol=inst_vol,
                   excite_scale=excite_scale, presence_db=presence_db, lufs=lufs)
        r["analysis"] = {k: round(v, 4) if isinstance(v, float) else v for k, v in info.items()}
        r["pitch"] = pitch
        print(json.dumps(r, ensure_ascii=False), flush=True)
        return 0
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"error": f"{type(exc).__name__}: {exc}"}), flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
