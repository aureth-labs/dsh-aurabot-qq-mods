"""判断一段人声轨「单声部模型能不能唱」。

为什么需要：分离模型对多声部/和声（合唱、叠录人声）只能分出一条轨，
里面几条人声叠在一起，RVC 只能跟其中一条，其余变成糊音/噪音。
参数怎么调都救不回来——只能换一段独唱。

判据来自本机实测对照（22.05kHz、pyin、fmin 65 / fmax 1200）：

    来源                  有声占比  置信中位  F0 跨度
    mvovb23a               56%      0.03     13.0 半音
    mvtocld9               84%      0.48      7.3
    mvtps295               72%      0.24     11.9
    mvwsoijf               87%      0.37      5.0
    波西米亚·歌剧段         56%      0.01     21.7   ← 唱不了

正常歌跨度都在 13 半音以内，歌剧段 21.7。所以判据取「跨度 > 16 半音
且 置信中位 < 0.10」——两个条件同时成立才算多声部，避免误伤说唱/念白这类
置信度本来就低的歌（它们跨度不大）。

输出一行 JSON（run() 取最后一行）：
    {"ok":true,"dur":40.0,"voiced":0.56,"conf_med":0.01,"conf_mean":0.12,"span":21.7,"mono":false}

用法: probe.py <人声wav>
"""
import json
import sys
import warnings

warnings.filterwarnings("ignore")

import librosa
import numpy as np
import soundfile as sf

SR = 22050
SPAN_BAD = 16.0   # 半音
CONF_BAD = 0.10   # pyin 置信中位


def main() -> int:
    if len(sys.argv) < 2:
        print(json.dumps({"error": "用法: probe.py <人声wav>"}), flush=True)
        return 2
    try:
        y, sr = sf.read(sys.argv[1], always_2d=True, dtype="float32")
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"error": f"{type(exc).__name__}: {exc}"}), flush=True)
        return 1

    m = y.mean(axis=1)
    if sr != SR:
        m = librosa.resample(m, orig_sr=sr, target_sr=SR)

    f0, _vf, vp = librosa.pyin(m, fmin=65, fmax=1200, sr=SR,
                               frame_length=1024, hop_length=512, fill_na=np.nan)
    fin = np.isfinite(f0)
    v = f0[fin]

    # 几乎没有稳定音高（纯念白 / 气声 / 静音）：不判多声部，交给调用方按原样处理
    if len(v) < 20:
        print(json.dumps({"ok": True, "dur": round(len(m) / SR, 2), "voiced": 0.0,
                          "conf_med": 0.0, "conf_mean": 0.0, "span": 0.0,
                          "mono": True, "reason": "几乎没有稳定音高"}, ensure_ascii=False), flush=True)
        return 0

    p10, p90 = float(np.percentile(v, 10)), float(np.percentile(v, 90))
    span = float(12 * np.log2(p90 / p10)) if p10 > 0 else 0.0
    conf_med = float(np.nanmedian(vp))
    conf_mean = float(np.nanmean(vp))

    print(json.dumps({
        "ok": True,
        "dur": round(len(m) / SR, 2),
        "voiced": round(float(fin.sum()) / len(f0), 3),
        "conf_med": round(conf_med, 3),
        "conf_mean": round(conf_mean, 3),
        "span": round(span, 1),
        "mono": not (span > SPAN_BAD and conf_med < CONF_BAD),
    }, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
