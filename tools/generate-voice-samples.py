#!/usr/bin/env python3
"""Generate voice samples for all Chinese voices for user selection."""

import asyncio
import os
import sys
from edge_tts import Communicate
from pathlib import Path

# Ensure UTF-8 output on Windows
if sys.platform == 'win32':
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

# All available Chinese voices
CHINESE_VOICES = [
    ('zh-CN-YunjianNeural', '云健 (激情，运动解说风)'),
    ('zh-CN-YunxiNeural', '云希 (活泼，小说朗读风)'),
    ('zh-CN-YunxiaNeural', '云霞 (可爱，动画风)'),
    ('zh-CN-YunyangNeural', '云阳 (专业，新闻播报风)'),
    ('zh-CN-YunfengNeural', '云风 (稳重，叙事风)'),
    ('zh-CN-YunhaoNeural', '云浩 (磁性，电台风)'),
]

TEST_TEXT = "晚上好，少爷。今天过得还算体面吧？"
OUTPUT_DIR = Path(__file__).parent.parent / "data" / "voice-samples"

async def generate_sample(voice_name: str, label: str):
    """Generate a voice sample."""
    output_file = OUTPUT_DIR / f"{voice_name.replace('Neural', '')}.wav"

    print(f"Generating: {label}...", end=" ", flush=True)

    try:
        comm = Communicate(TEST_TEXT, voice=voice_name, rate="-8%")

        with open(output_file, "wb") as f:
            async for chunk in comm.stream():
                if chunk["type"] == "audio":
                    f.write(chunk["data"])

        size = output_file.stat().st_size / 1024
        print(f"OK ({size:.1f}KB)")
        return True
    except Exception as e:
        print(f"FAILED: {e}")
        return False

async def main():
    """Generate all voice samples."""
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    print(f"Generating Chinese voice samples to: {OUTPUT_DIR}")
    print(f"Test text: {TEST_TEXT}")
    print("-" * 60)

    results = []
    for voice_name, label in CHINESE_VOICES:
        success = await generate_sample(voice_name, label)
        results.append((label, success))

    print("-" * 60)
    print("Summary:")
    success_count = sum(1 for _, success in results if success)
    for label, success in results:
        status = "OK" if success else "FAIL"
        print(f"  [{status}] {label}")

    print(f"\nTotal: {success_count}/{len(CHINESE_VOICES)} generated successfully")

    if success_count == len(CHINESE_VOICES):
        print("\nAll samples generated! Listen to them and choose your favorite voice.")
        print(f"Files location: {OUTPUT_DIR}")

if __name__ == "__main__":
    asyncio.run(main())
