#!/usr/bin/env python3
"""
Clarity enhancement for RVC-converted vocals -- the VITS vocoder's output
commonly reads as "muffled" compared to the source recording (less high-
frequency detail survives the encode/decode round-trip than a real mic
captures). This applies a presence boost (shelf-style lift above ~3.5kHz)
and a small low-end cut (removes sub-200Hz buildup that reads as "muddy"
and masks the boosted highs), both driven by a single 0-1 strength knob.

Usage: python enhance-vocal.py <input_path> <output_path> [strength]
  strength: 0.0 (no change) to 1.0 (full effect), default 0.6
Output: JSON with the path to the enhanced audio, or an error.
"""

import json
import sys
from pathlib import Path

try:
    import numpy as np
    import soundfile as sf
    from scipy.signal import butter, sosfilt
except ImportError as e:
    print(json.dumps({"error": f"依赖未安装: {e}"}), file=sys.stderr)
    sys.exit(1)


def enhance_vocal(input_path: str, output_path: str, strength: float = 0.6) -> dict:
    try:
        strength = max(0.0, min(1.0, strength))
        audio, sr = sf.read(input_path)
        mono = audio.ndim == 1
        work = audio.astype("float32")
        if mono:
            work = work[:, None]

        # Presence boost: extract everything above the cutoff with a
        # high-pass filter, then add a scaled copy back on top of the
        # original -- a cheap way to approximate a high-shelf EQ without
        # pulling in a full filter-design dependency.
        max_boost_db = 6.0
        boost_db = strength * max_boost_db
        boost_factor = 10 ** (boost_db / 20) - 1
        if boost_factor > 0:
            sos_high = butter(2, 3500, btype='high', fs=sr, output='sos')
            presence = sosfilt(sos_high, work, axis=0)
            work = work + presence * boost_factor

        # Low-end cut: sub-200Hz buildup reads as "muddy" and masks the
        # presence boost above -- a gentle high-pass keeps the fundamental
        # intact while clearing out rumble.
        max_cut_hz = 120
        cut_hz = 40 + strength * (max_cut_hz - 40)
        sos_low = butter(2, cut_hz, btype='high', fs=sr, output='sos')
        work = sosfilt(sos_low, work, axis=0)

        # Re-normalize only if the boost pushed us into clipping -- a mix
        # that was already comfortably under full scale shouldn't get
        # needlessly loudness-boosted just because this pass ran.
        peak = np.abs(work).max()
        if peak > 0.99:
            work = work * (0.99 / peak)

        if mono:
            work = work[:, 0]

        Path(output_path).parent.mkdir(parents=True, exist_ok=True)
        sf.write(output_path, work, sr)

        if not Path(output_path).exists():
            return {"error": f"处理完成但找不到输出文件: {output_path}"}

        return {"output": output_path}
    except Exception as e:
        return {"error": str(e)}


def main():
    if len(sys.argv) < 3:
        print(json.dumps({"error": "Usage: python enhance-vocal.py <input_path> <output_path> [strength]"}), file=sys.stderr)
        sys.exit(1)

    input_path = sys.argv[1]
    output_path = sys.argv[2]
    strength = float(sys.argv[3]) if len(sys.argv) > 3 and sys.argv[3] else 0.6

    if not Path(input_path).exists():
        print(json.dumps({"error": f"输入文件不存在: {input_path}"}), file=sys.stderr)
        sys.exit(1)

    result = enhance_vocal(input_path, output_path, strength)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
