#!/usr/bin/env python3
"""
Vocal separation: split an audio file into a vocals track and an
instrumental-only (accompaniment) track using Demucs.
Usage: python vocal-remove.py <audio_file> <output_dir>
Output: JSON with paths to the separated vocals.wav and no_vocals.wav
"""

import json
import sys
import shutil
from pathlib import Path

try:
    import demucs.separate
except ImportError:
    print(json.dumps({"error": "demucs not installed. Run: pip install demucs"}), file=sys.stderr)
    sys.exit(1)


def separate_audio(audio_path: str, output_dir: str, model: str = "htdemucs") -> dict:
    """Run Demucs two-stem separation (vocals vs everything else)."""
    try:
        out_root = Path(output_dir)
        out_root.mkdir(parents=True, exist_ok=True)

        stem_name = Path(audio_path).stem
        result_dir = out_root / model / stem_name
        vocals_path = result_dir / "vocals.wav"
        instrumental_path = result_dir / "no_vocals.wav"

        # Re-running on the same song is common (re-trying a voice
        # conversion, or just re-opening the dashboard) -- Demucs itself
        # doesn't skip already-separated output, so this check is what
        # actually saves the several-minutes-on-CPU re-run.
        if vocals_path.exists() and instrumental_path.exists():
            return {
                "vocals": str(vocals_path),
                "instrumental": str(instrumental_path),
                "cached": True,
            }

        # --two-stems=vocals gives exactly vocals.wav + no_vocals.wav instead
        # of the full four-stem (drums/bass/other/vocals) split -- that's all
        # a "backing track" needs, and it's roughly 2x faster than the default.
        demucs.separate.main([
            "--two-stems", "vocals",
            "-n", model,
            "-o", str(out_root),
            audio_path,
        ])

        if not instrumental_path.exists():
            return {"error": f"分离完成但找不到输出文件: {instrumental_path}"}

        return {
            "vocals": str(vocals_path),
            "instrumental": str(instrumental_path),
        }
    except Exception as e:
        return {"error": str(e)}


def main():
    if len(sys.argv) < 3:
        print(json.dumps({"error": "Usage: python vocal-remove.py <audio_file> <output_dir>"}), file=sys.stderr)
        sys.exit(1)

    audio_path = sys.argv[1]
    output_dir = sys.argv[2]

    if not Path(audio_path).exists():
        print(json.dumps({"error": f"File not found: {audio_path}"}), file=sys.stderr)
        sys.exit(1)

    result = separate_audio(audio_path, output_dir)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
