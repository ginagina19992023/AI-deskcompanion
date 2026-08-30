#!/usr/bin/env python3
"""
Whisper-based singing transcription: extract lyrics and note sequence from audio.
Usage: python whisper-transcribe.py <audio_file>
Output: JSON with lyrics and detected note sequence (F0 contour)
"""

import json
import sys
import numpy as np
from pathlib import Path

try:
    import whisper
except ImportError:
    print(json.dumps({"error": "whisper not installed. Run: pip install openai-whisper"}), file=sys.stderr)
    sys.exit(1)

try:
    import librosa
except ImportError:
    print(json.dumps({"error": "librosa not installed. Run: pip install librosa"}), file=sys.stderr)
    sys.exit(1)

try:
    import pyworld
except ImportError:
    print(json.dumps({"error": "pyworld not installed. Run: pip install pyworld"}), file=sys.stderr)
    sys.exit(1)


def transcribe_lyrics(audio_path: str, model_size: str = "base") -> dict:
    """Transcribe lyrics from audio using Whisper."""
    try:
        model = whisper.load_model(model_size)
        result = model.transcribe(audio_path, language="zh")
        return {
            "text": result["text"],
            "segments": [
                {
                    "start": seg["start"],
                    "end": seg["end"],
                    "text": seg["text"],
                }
                for seg in result["segments"]
            ],
        }
    except Exception as e:
        return {"error": str(e)}


def extract_f0_contour(audio_path: str, hop_length: int = 512) -> dict:
    """Extract fundamental frequency (pitch) contour from audio."""
    try:
        y, sr = librosa.load(audio_path, sr=None)

        # Use pyworld to extract F0
        _f0, t = pyworld.dio(y, sr, frame_period=hop_length / sr * 1000)
        f0 = pyworld.stonemask(y, _f0, t, sr)

        # Convert to time-frequency representation (simplified note detection)
        # Zero out unvoiced parts
        f0_voiced = np.where(f0 > 0, f0, 0)

        # Convert to MIDI note numbers (A0 = 21, middle C = 60)
        def hz_to_midi(hz):
            if hz <= 0:
                return None
            return 12 * np.log2(hz / 440) + 69

        midi_notes = [hz_to_midi(f) if f > 0 else None for f in f0_voiced]

        # Resample to match time with transcription segments
        times = librosa.frames_to_time(np.arange(len(f0)), sr=sr, hop_length=hop_length)

        return {
            "times": times.tolist(),
            "f0_hz": f0_voiced.tolist(),
            "midi_notes": midi_notes,
            "sample_rate": sr,
        }
    except Exception as e:
        return {"error": str(e)}


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: python whisper-transcribe.py <audio_file>"}), file=sys.stderr)
        sys.exit(1)

    audio_path = sys.argv[1]

    if not Path(audio_path).exists():
        print(json.dumps({"error": f"File not found: {audio_path}"}), file=sys.stderr)
        sys.exit(1)

    lyrics_result = transcribe_lyrics(audio_path)
    f0_result = extract_f0_contour(audio_path)

    output = {
        "lyrics": lyrics_result,
        "pitch": f0_result,
    }

    print(json.dumps(output, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
