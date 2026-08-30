// Generates a listening sample for every MiMo-V2.5-TTS preset voice, using
// a butler-appropriate line so they can be compared directly against the
// Edge Chinese voices already sampled in data/voice-samples/. Run with:
//   node tools/generate-mimo-samples.js
import { readFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { synthesizeMimo, MIMO_PRESET_VOICES } from '../src/voice-tts-mimo.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const configPath = join(root, 'config.json');
const outDir = join(root, 'data', 'voice-samples');
mkdirSync(outDir, { recursive: true });

const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
const apiKey = cfg.voice?.mimo?.apiKey;
if (!apiKey) {
  console.error('config.json 里 voice.mimo.apiKey 是空的，先把 Key 填进去再跑这个脚本');
  process.exit(1);
}

const TEST_TEXT_ZH = '哦呀哦呀，少爷，今天气色看着倒是不错，是发生了什么好事吗？';
const TEST_TEXT_EN = 'Good evening, my lord. How was your day?';
// Only style tags that make sense for a composed butler character -- the
// full STYLE_PRESETS list in the mimo-tts reference client also has
// options like "大笑"/"哭泣" that don't fit this use case.
const BUTLER_STYLE_TAGS = ['', '磁性', '沉稳', '温柔'];

async function main() {
  console.log(`输出目录: ${outDir}\n`);
  const results = [];

  for (const { id, label } of MIMO_PRESET_VOICES) {
    const isEnglish = /^[A-Z]/.test(id) && id !== 'mimo_default';
    const text = isEnglish ? TEST_TEXT_EN : TEST_TEXT_ZH;
    const tagsToTry = isEnglish ? [''] : BUTLER_STYLE_TAGS;

    for (const styleTag of tagsToTry) {
      const tagSuffix = styleTag ? `-${styleTag}` : '';
      const safeId = id.replace(/[^a-zA-Z0-9一-鿿_]/g, '_');
      const outPath = join(outDir, `mimo-${safeId}${tagSuffix}.wav`);
      process.stdout.write(`生成: ${label}${styleTag ? ` (${styleTag})` : ''} ... `);
      try {
        const result = await synthesizeMimo(text, { apiKey, voice: id, styleTag });
        copyFileSync(result.filePath, outPath);
        console.log('OK');
        results.push({ label, styleTag, ok: true, path: outPath });
      } catch (err) {
        console.log(`FAILED: ${err.message}`);
        results.push({ label, styleTag, ok: false, error: err.message });
      }
    }
  }

  console.log('\n汇总:');
  const okCount = results.filter((r) => r.ok).length;
  for (const r of results) {
    console.log(`  [${r.ok ? 'OK' : 'FAIL'}] ${r.label}${r.styleTag ? ` (${r.styleTag})` : ''}`);
  }
  console.log(`\n${okCount}/${results.length} 生成成功，文件在 ${outDir}`);
}

main();
