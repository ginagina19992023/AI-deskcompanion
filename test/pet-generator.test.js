import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PET_ATLAS,
  BASE_ROW_SPECS,
  CHROMA_KEY,
  STABLE_GROUPS,
  buildGenerationPlan,
  buildPackJson,
  buildFullAtlasPrompt,
  generationBackgroundMode,
  modelSupportsFlexibleImageSize,
  slugifyPetId,
} from '../src/pet-generator.js';

test('base custom-pet atlas matches the existing 8x11 import contract', () => {
  assert.deepEqual(PET_ATLAS, {
    width: 1536,
    height: 2288,
    cols: 8,
    rows: 11,
    cellW: 192,
    cellH: 208,
  });
  assert.equal(BASE_ROW_SPECS.length, 11);
  assert.deepEqual(BASE_ROW_SPECS.map((r) => r.frames), [7, 8, 8, 4, 5, 8, 6, 6, 6, 8, 8]);
});

test('stable row groups cover every base row and crop back to 2288 px exactly', () => {
  const rows = STABLE_GROUPS.flatMap((g) => Array.from({ length: g.endRow - g.startRow + 1 }, (_, i) => g.startRow + i));
  assert.deepEqual(rows, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(STABLE_GROUPS.reduce((sum, g) => sum + g.crop.height, 0), 2288);
  assert.equal(STABLE_GROUPS.at(-1).size, '1536x528');
  assert.equal(STABLE_GROUPS.at(-1).crop.height, 416);
});

test('gpt-image-2 uses flexible sizes and local chroma extraction', () => {
  assert.equal(modelSupportsFlexibleImageSize('gpt-image-2'), true);
  assert.equal(generationBackgroundMode('gpt-image-2'), 'chroma-key');
  const plan = buildGenerationPlan({ name: 'Mochi', description: 'cream cat', referenceCount: 2, mode: 'fast', model: 'gpt-image-2' });
  assert.equal(plan.strategy, 'single-atlas-call');
  assert.equal(plan.requestSize, '1536x2288');
  assert.equal(plan.referenceCount, 2);
  assert.equal(plan.backgroundMode, 'chroma-key');
  assert.match(plan.fullAtlasPrompt, new RegExp(CHROMA_KEY.replace('#', '\\#'), 'i'));
  assert.match(plan.fullAtlasPrompt, /chroma-key/i);
});

test('stable gpt-image-2 mode locks identity then produces four chroma-key row groups', () => {
  const plan = buildGenerationPlan({ name: 'Mochi', description: 'cream cat', referenceCount: 3, mode: 'stable', model: 'gpt-image-2' });
  assert.equal(plan.strategy, 'identity-anchor-plus-row-groups');
  assert.equal(plan.backgroundMode, 'chroma-key');
  assert.equal(plan.estimatedImageCalls, 5);
  assert.equal(plan.groups.length, 4);
  assert.match(plan.identityPrompt, /CHARACTER IDENTITY BOARD/);
  assert.match(plan.identityPrompt, /RGB 0,255,0/);
  assert.match(plan.groups[0].prompt, /PRIMARY visual authority/);
  assert.match(plan.groups[0].prompt, /chroma-key/i);
});

test('legacy image models keep native transparency and fixed-size fallback', () => {
  assert.equal(modelSupportsFlexibleImageSize('gpt-image-1.5'), false);
  assert.equal(generationBackgroundMode('gpt-image-1.5'), 'transparent');
  const plan = buildGenerationPlan({ name: 'Mochi', description: 'cream cat', mode: 'stable', model: 'gpt-image-1.5' });
  assert.equal(plan.strategy, 'identity-anchor-plus-single-atlas');
  assert.equal(plan.backgroundMode, 'transparent');
  assert.equal(plan.requestSize, '1024x1536');
  assert.equal(plan.estimatedImageCalls, 2);
  assert.match(plan.fullAtlasPrompt, /full transparency/i);
});

test('manual mode produces a native-transparent full prompt without an image call', () => {
  const plan = buildGenerationPlan({ name: 'Mochi', description: 'cream cat', mode: 'manual', model: 'gpt-image-2' });
  assert.equal(plan.strategy, 'prompt-and-import');
  assert.equal(plan.backgroundMode, 'transparent');
  assert.equal(plan.estimatedImageCalls, 0);
  assert.match(plan.fullAtlasPrompt, /1536x2288/);
  assert.match(plan.fullAtlasPrompt, /zero alpha/i);
});

test('full atlas prompt carries row geometry and transparent-unused-cell rule', () => {
  const prompt = buildFullAtlasPrompt({ name: 'Mochi', description: 'cream cat', referenceCount: 1, backgroundMode: 'transparent' });
  assert.match(prompt, /8 columns x 11 rows/);
  assert.match(prompt, /192x208/);
  assert.match(prompt, /unused cell.*full transparency/i);
});

test('pack.json produced by Studio is accepted by the current generic importer shape', () => {
  const pack = buildPackJson({ name: 'Mochi Cat', description: 'cream cat with a green bow tie' });
  assert.equal(pack.id, 'mochi-cat');
  assert.equal(pack.displayName, 'Mochi Cat');
  assert.equal(pack.hasExtendedRows, false);
  assert.equal(pack.gaze.mode, 'lean');
  assert.equal(pack.rowLabels.length, 11);
  assert.deepEqual(pack.claudeStatusRows, { working: 3, review: 8, waiting: 6, error: 5 });
});

test('slugifyPetId keeps IDs filesystem-friendly', () => {
  assert.equal(slugifyPetId('  My Pet !!!  '), 'my-pet');
  assert.equal(slugifyPetId('猫猫 01'), '猫猫-01');
});
