"""流式中文识别（sherpa-onnx zipformer int8），CPU 实时率很高。

用法：
    python asr.py --test "要合成的测试句子"
"""
import sys
import time
import wave
from pathlib import Path

import numpy as np

MODEL_DIR = Path(__file__).parent / "models" / "sherpa-zh"
SAMPLE_RATE = 16000

_recognizer = None


def recognizer():
    global _recognizer
    if _recognizer is None:
        import sherpa_onnx

        _recognizer = sherpa_onnx.OnlineRecognizer.from_transducer(
            tokens=str(MODEL_DIR / "tokens.txt"),
            encoder=str(MODEL_DIR / "encoder-epoch-99-avg-1.int8.onnx"),
            decoder=str(MODEL_DIR / "decoder-epoch-99-avg-1.onnx"),
            joiner=str(MODEL_DIR / "joiner-epoch-99-avg-1.int8.onnx"),
            num_threads=2,
            sample_rate=SAMPLE_RATE,
            feature_dim=80,
            decoding_method="greedy_search",
        )
    return _recognizer


def transcribe_pcm(pcm: np.ndarray, sr: int = SAMPLE_RATE) -> str:
    """一整段音频（float32, -1~1）转文字。"""
    if sr != SAMPLE_RATE:
        n = int(len(pcm) * SAMPLE_RATE / sr)
        pcm = np.interp(np.arange(n) * (sr / SAMPLE_RATE), np.arange(len(pcm)), pcm).astype(np.float32)
    rec = recognizer()
    stream = rec.create_stream()
    stream.accept_waveform(SAMPLE_RATE, pcm.astype(np.float32))
    stream.accept_waveform(SAMPLE_RATE, np.zeros(int(SAMPLE_RATE * 0.3), dtype=np.float32))  # 尾巴补齐
    stream.input_finished()
    while rec.is_ready(stream):
        rec.decode_stream(stream)
    return rec.get_result(stream).strip()


def load_wav(path: str) -> tuple[np.ndarray, int]:
    with wave.open(path) as f:
        sr = f.getframerate()
        data = np.frombuffer(f.readframes(f.getnframes()), dtype=np.int16).astype(np.float32) / 32768
    return data, sr


if __name__ == "__main__":
    if "--test" in sys.argv:
        from speak_stream import resample, synth

        text = sys.argv[sys.argv.index("--test") + 1]
        pcm = synth(text)  # 22050 单声道 int16
        pcm16 = resample(pcm, 48000, SAMPLE_RATE).astype(np.float32) / 32768
        t0 = time.time()
        got = transcribe_pcm(pcm16)
        dt = time.time() - t0
        print(f"原文: {text}")
        print(f"识别: {got}")
        print(f"耗时 {dt * 1000:.0f} ms，音频 {len(pcm16) / SAMPLE_RATE:.2f}s，实时率 {dt / (len(pcm16) / SAMPLE_RATE):.2f}x")
    elif len(sys.argv) > 1:
        pcm, sr = load_wav(sys.argv[1])
        print(transcribe_pcm(pcm, sr))
    else:
        print(__doc__)
