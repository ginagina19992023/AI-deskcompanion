#!/usr/bin/env python3
"""
Mix a converted vocal track with an instrumental track into one finished
song -- aligns channel count and sample rate, sums the two, and only
scales down if the sum would actually clip.

Usage: python mix-tracks.py <vocals_path> <instrumental_path> <output_path> [vocal_gain] [instrumental_gain]
Output: JSON with the path to the mixed audio, or an error.
"""

import json
import sys
from pathlib import Path

try:
    import numpy as np
    import soundfile as sf
except ImportError as e:
    print(json.dumps({"error": f"依赖未安装: {e}"}), file=sys.stderr)
    sys.exit(1)


def _pad_to(arr, length):
    if len(arr) >= length:
        return arr
    pad_shape = (length - len(arr),) + arr.shape[1:]
    return np.concatenate([arr, np.zeros(pad_shape, dtype=arr.dtype)], axis=0)


def mix_tracks(vocals_path: str, instrumental_path: str, output_path: str, vocal_gain: float = 1.0, instrumental_gain: float = 1.0) -> dict:
    try:
        vocals, vsr = sf.read(vocals_path)
        instrumental, isr = sf.read(instrumental_path)

        # tools/voice-convert.py's RVC output is always mono (RVC expects
        # single-channel input and produces single-channel output); Demucs's
        # separated instrumental keeps the source's original channel count
        # (commonly stereo). Broadcast the mono vocal across every
        # instrumental channel rather than forcing the instrumental down to
        # mono -- that would throw away real stereo width in the backing
        # track for no reason.
        if vocals.ndim == 1 and instrumental.ndim > 1:
            vocals = np.repeat(vocals[:, None], instrumental.shape[1], axis=1)
        elif instrumental.ndim == 1 and vocals.ndim > 1:
            instrumental = np.repeat(instrumental[:, None], vocals.shape[1], axis=1)

        # Sample rates commonly differ -- the RVC vocoder's own output rate
        # (confirmed live: 48kHz) versus whatever the original source audio
        # was (Demucs preserves it, commonly 44.1kHz). Resample the
        # instrumental to match the vocal track's rate, not the other way
        # around -- the vocal is VITS's raw generated output, re-deriving
        # that would be lossier than resampling the (already lossily
        # separated) backing track a second time.
        if isr != vsr:
            import librosa
            instrumental = librosa.resample(instrumental.astype("float32").T, orig_sr=isr, target_sr=vsr).T
            isr = vsr

        # VITS's frame-quantized output rarely lands on the exact same
        # sample count as the source clip it was derived from (confirmed
        # live: a 6.2s input produced a 6.18s output). Pad the shorter
        # track with silence rather than trimming the longer one, so no
        # audio from either track is lost -- worst case a fraction of a
        # second of silence at the tail.
        n = max(len(vocals), len(instrumental))
        vocals = _pad_to(vocals.astype("float32"), n)
        instrumental = _pad_to(instrumental.astype("float32"), n)

        mixed = vocals * vocal_gain + instrumental * instrumental_gain

        # Only scale down if the sum actually clips -- a mix that's already
        # comfortably under full scale shouldn't get needlessly loudness-
        # boosted just because a normalization pass ran.
        peak = np.abs(mixed).max()
        if peak > 0.99:
            mixed = mixed * (0.99 / peak)

        Path(output_path).parent.mkdir(parents=True, exist_ok=True)
        sf.write(output_path, mixed, vsr)

        if not Path(output_path).exists():
            return {"error": f"合成完成但找不到输出文件: {output_path}"}

        return {"output": output_path}
    except Exception as e:
        return {"error": str(e)}


def main():
    if len(sys.argv) < 4:
        print(json.dumps({"error": "Usage: python mix-tracks.py <vocals_path> <instrumental_path> <output_path> [vocal_gain] [instrumental_gain]"}), file=sys.stderr)
        sys.exit(1)

    vocals_path = sys.argv[1]
    instrumental_path = sys.argv[2]
    output_path = sys.argv[3]
    vocal_gain = float(sys.argv[4]) if len(sys.argv) > 4 and sys.argv[4] else 1.0
    instrumental_gain = float(sys.argv[5]) if len(sys.argv) > 5 and sys.argv[5] else 1.0

    if not Path(vocals_path).exists():
        print(json.dumps({"error": f"人声文件不存在: {vocals_path}"}), file=sys.stderr)
        sys.exit(1)
    if not Path(instrumental_path).exists():
        print(json.dumps({"error": f"伴奏文件不存在: {instrumental_path}"}), file=sys.stderr)
        sys.exit(1)

    result = mix_tracks(vocals_path, instrumental_path, output_path, vocal_gain, instrumental_gain)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
