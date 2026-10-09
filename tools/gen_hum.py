# -*- coding: utf-8 -*-
"""蛍光灯のハム音(仕様書 9.2 / Q-4)を生成する。

    python tools/gen_hum.py

出力: BackroomsRP/sounds/backrooms/hum.ogg (ffmpeg が無ければ hum.wav)

ちょうど 10.000 秒 = 200 tick。config.js の HUM_LEN_TICKS と一致していることを
起動時に検査する(ずれたら止まる。勝手に長さを変えない)。

シームレスループの作り方: 全成分の周波数を 1/10秒 = 0.1Hz の整数倍に揃える。
- 50/100/150/200Hz も AM の 0.7/2.3Hz も 0.1Hz の整数倍
- ノイズは rfft のビン(間隔がちょうど 0.1Hz)に直接書き込んで irfft するので、
  定義から 10 秒周期になる
これで末尾と先頭が完全に連続する。
"""
import re
import shutil
import subprocess
import tempfile
import wave
from pathlib import Path

import numpy as np

SR = 44100
LEN_TICKS = 200                      # config.js の HUM_LEN_TICKS と同じ値
DUR = LEN_TICKS / 20.0               # 10.000 秒
N = int(round(SR * DUR))             # 441000 サンプル
PEAK_DBFS = -12.0                    # 控えめ

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "BackroomsRP" / "sounds" / "backrooms"
CONFIG_JS = ROOT / "BackroomsBP" / "scripts" / "config.js"


def check_config():
    """config.js の HUM_LEN_TICKS と食い違ったまま作らない"""
    if not CONFIG_JS.exists():
        return
    m = re.search(r"HUM_LEN_TICKS\s*=\s*(\d+)", CONFIG_JS.read_text(encoding="utf-8"))
    assert m and int(m.group(1)) == LEN_TICKS, (
        f"config.js の HUM_LEN_TICKS={m.group(1) if m else '?'} と "
        f"gen_hum.py の LEN_TICKS={LEN_TICKS} が食い違っている"
    )


def tones(t):
    """50Hz とその倍音。10 秒でちょうど整数周回する"""
    y = np.zeros(N)
    for freq, amp in ((50.0, 1.00), (100.0, 0.45), (150.0, 0.20), (200.0, 0.11)):
        assert (freq * DUR) % 1.0 == 0.0, freq
        y += amp * np.sin(2.0 * np.pi * freq * t)
    return y


def band_noise(lo_hz, hi_hz, tilt, seed):
    """帯域制限ノイズ。周波数領域で組むので 10 秒周期が保証される"""
    bins = np.fft.rfftfreq(N, 1.0 / SR)
    rng = np.random.default_rng(seed)
    mag = np.zeros_like(bins)
    band = (bins >= lo_hz) & (bins <= hi_hz)
    mag[band] = (bins[band] / lo_hz) ** tilt          # 高域ほど落とす
    spec = mag * np.exp(1j * rng.uniform(0.0, 2.0 * np.pi, bins.size))
    spec[0] = 0.0                                     # DC 除去
    y = np.fft.irfft(spec, n=N)
    return y / np.max(np.abs(y))


def build():
    t = np.arange(N) / SR
    y = tones(t) + 0.30 * band_noise(60.0, 2400.0, -1.0, 20260921)
    # わずかな AM(蛍光灯のちらつき)。周波数はどちらも 0.1Hz の整数倍
    y *= 1.0 + 0.055 * np.sin(2.0 * np.pi * 0.7 * t) + 0.025 * np.sin(2.0 * np.pi * 2.3 * t)
    y *= (10.0 ** (PEAK_DBFS / 20.0)) / np.max(np.abs(y))

    assert y.size == N and N / SR == DUR, f"{y.size} samples"
    inner = np.abs(np.diff(y)).max()
    seam = abs(float(y[0] - y[-1]))
    assert seam <= inner, f"ループ継ぎ目が不連続: {seam:.3e} > {inner:.3e}"
    return y


def write_wav(path, y):
    pcm = np.round(y * 32767.0).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


def main():
    check_config()
    y = build()
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg:
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td) / "hum.wav"
            write_wav(tmp, y)
            out = OUT_DIR / "hum.ogg"
            subprocess.run(
                [ffmpeg, "-y", "-loglevel", "error", "-i", str(tmp),
                 "-c:a", "libvorbis", "-q:a", "5", str(out)],
                check=True,
            )
        (OUT_DIR / "hum.wav").unlink(missing_ok=True)
    else:
        out = OUT_DIR / "hum.wav"
        write_wav(out, y)
        print("ffmpeg が無いので wav で出力した。ogg に差し替えること")

    print(f"{out.name}: {DUR:.3f}s / {LEN_TICKS} tick / {out.stat().st_size} bytes")


if __name__ == "__main__":
    main()
