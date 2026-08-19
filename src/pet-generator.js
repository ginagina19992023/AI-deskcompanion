import { ATLAS, BASE_ROWS, ROW_FRAME_COUNTS } from './atlas.js';

export const PET_ATLAS = Object.freeze({
  width: ATLAS.width,
  height: BASE_ROWS * ATLAS.cellH,
  cols: ATLAS.cols,
  rows: BASE_ROWS,
  cellW: ATLAS.cellW,
  cellH: ATLAS.cellH,
});

export const CHROMA_KEY = '#00FF00';

export const BASE_ROW_SPECS = Object.freeze([
  { row: 0, key: 'idle', frames: ROW_FRAME_COUNTS[0], label: '待机', brief: 'neutral standing idle; tiny breathing or weight shifts' },
  { row: 1, key: 'run-right', frames: ROW_FRAME_COUNTS[1], label: '向右移动', brief: 'full-body walk/run cycle facing right' },
  { row: 2, key: 'run-left', frames: ROW_FRAME_COUNTS[2], label: '向左移动', brief: 'full-body walk/run cycle facing left' },
  { row: 3, key: 'perform', frames: ROW_FRAME_COUNTS[3], label: '打招呼 / 表演', brief: 'greeting, wave, bow, flourish, or signature gesture' },
  { row: 4, key: 'celebrate', frames: ROW_FRAME_COUNTS[4], label: '庆祝 / 跳跃', brief: 'short celebratory or energetic action' },
  { row: 5, key: 'annoyed', frames: ROW_FRAME_COUNTS[5], label: '不悦 / 小动作', brief: 'annoyed, curious, pecking, fidgeting, or character-specific filler action' },
  { row: 6, key: 'waiting', frames: ROW_FRAME_COUNTS[6], label: '等待', brief: 'waiting or holding pose suitable for “waiting for approval”' },
  { row: 7, key: 'rest', frames: ROW_FRAME_COUNTS[7], label: '休息', brief: 'calm rest, doze, bow, sit, or quiet character-specific action' },
  { row: 8, key: 'review', frames: ROW_FRAME_COUNTS[8], label: '工作 / 审阅', brief: 'focused work, review, thinking, reading, or tool-use action' },
  { row: 9, key: 'look-a', frames: ROW_FRAME_COUNTS[9], label: '观察 A', brief: 'subtle look/turn sequence, first half of a continuous attention loop' },
  { row: 10, key: 'look-b', frames: ROW_FRAME_COUNTS[10], label: '观察 B', brief: 'subtle look/turn sequence, second half of the continuous attention loop' },
]);

export const STABLE_GROUPS = Object.freeze([
  Object.freeze({ startRow: 0, endRow: 2, size: '1536x624', crop: Object.freeze({ x: 0, y: 0, width: 1536, height: 624 }) }),
  Object.freeze({ startRow: 3, endRow: 5, size: '1536x624', crop: Object.freeze({ x: 0, y: 0, width: 1536, height: 624 }) }),
  Object.freeze({ startRow: 6, endRow: 8, size: '1536x624', crop: Object.freeze({ x: 0, y: 0, width: 1536, height: 624 }) }),
  // gpt-image-2 requires <=3:1 aspect ratio and a minimum pixel count. 1536x416
  // is too wide/short, so the API image has 112 px of empty background at
  // the bottom and the Studio crops only the top 416 px into the final atlas.
  Object.freeze({ startRow: 9, endRow: 10, size: '1536x528', crop: Object.freeze({ x: 0, y: 0, width: 1536, height: 416 }) }),
]);

const DEFAULT_PROFILE = Object.freeze({
  performRows: [3, 4],
  restRow: 7,
  fillerRow: 5,
  weights: { wander: 0.45, perform: 0.3, filler: 0.15, rest: 0.1 },
  idleDwellMs: [7000, 16000],
  performMs: 2600,
  fillerMs: 4000,
  restMs: 7000,
  wanderSpeed: 90,
  spinEnabled: true,
  visitChance: 0,
  edgePerchChance: 0,
  lieDownChance: 0,
});

const DEFAULT_GAZE = Object.freeze({
  mode: 'lean',
  tau: 0.2,
  deadzone: 10,
  radius: 600,
  attentionMs: 1500,
  maxLeanPx: 6,
  hysteresis: 5,
  subFrameGain: 0,
  fullTurnPx: 480,
});

const DEFAULT_CLAUDE_ROWS = Object.freeze({ working: 3, review: 8, waiting: 6, error: 5 });

export function slugifyPetId(value) {
  const slug = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || `pet-${Date.now()}`;
}

function cleanDescription(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, 2400);
}

function identityHeader(name, description, referenceCount) {
  const refs = referenceCount > 0
    ? `Use the ${referenceCount} supplied reference image${referenceCount > 1 ? 's' : ''} as identity evidence. Reconcile them into ONE coherent character; preserve stable face, silhouette, colors, clothing/accessories and species traits.`
    : 'No reference image is supplied. Derive a single coherent character identity only from the text description and keep it unchanged across every frame.';
  return [
    `Character name: ${name}.`,
    `Character description: ${description || 'A charming desktop companion with a clear, memorable silhouette.'}`,
    refs,
  ].join('\n');
}

export function modelSupportsFlexibleImageSize(model) {
  return /^gpt-image-2(?:$|-)/.test(String(model ?? ''));
}

export function generationBackgroundMode(model) {
  // The Image API currently rejects background=transparent for gpt-image-2.
  // Keep the newest model for its flexible sizes and multi-image identity work,
  // then remove only edge-connected chroma locally in the Studio canvas.
  return modelSupportsFlexibleImageSize(model) ? 'chroma-key' : 'transparent';
}

function emptyBackgroundPhrase(backgroundMode) {
  return backgroundMode === 'chroma-key'
    ? `solid chroma-key background ${CHROMA_KEY}`
    : 'full transparency';
}

function rowContractLines(rows = BASE_ROW_SPECS, backgroundMode = 'transparent') {
  const empty = emptyBackgroundPhrase(backgroundMode);
  return rows
    .map((r) => `- global row ${r.row}: ${r.label}; ${r.frames} used frame(s); ${r.brief}. Every unused cell after frame ${r.frames - 1} must contain ONLY ${empty}.`)
    .join('\n');
}

function artDirection(backgroundMode = 'transparent') {
  const backgroundLines = backgroundMode === 'chroma-key'
    ? [
        `- use one perfectly flat, uniform chroma-key background: ${CHROMA_KEY} (RGB 0,255,0) across every background/empty pixel; no gradient, texture, glow, vignette, floor, cast shadow, or scenery.`,
        `- reserve the exact color ${CHROMA_KEY} for removable background whenever possible. If the character is naturally green, keep its real greens visibly different from the exact key and preserve a clear silhouette boundary.`,
      ]
    : [
        '- transparent background only; every background/empty pixel must have zero alpha. No scenery, floor, cast shadow outside the character, or opaque matte.',
      ];
  return [
    'ART DIRECTION:',
    '- 2D desktop-pet sprite art with a clean readable silhouette at small size.',
    ...backgroundLines,
    '- no borders, grid lines, captions, labels, numbers, UI, or text.',
    '- same character model, proportions, costume, palette and rendering style in every cell.',
    '- keep the full character inside each 192x208 cell with comfortable empty margins; no body part may cross into a neighboring cell.',
    '- animation frames should progress smoothly rather than being unrelated poses.',
    '- do not invent extra characters, duplicate the character inside one cell, or change species/outfit between actions.',
  ].join('\n');
}

export function buildIdentityPrompt({ name = 'Custom Pet', description = '', referenceCount = 0, backgroundMode = 'transparent' } = {}) {
  const safeName = String(name || 'Custom Pet').trim().slice(0, 120);
  const safeDescription = cleanDescription(description);
  const background = backgroundMode === 'chroma-key'
    ? `Use a perfectly flat uniform ${CHROMA_KEY} (RGB 0,255,0) chroma-key background. No gradient, shadow, floor, text or decoration. Keep the character separated from the canvas edges.`
    : 'Keep the background fully transparent. No shadow, floor, prose, labels, typography, decorative frame or scene.';
  return [
    'Create a CHARACTER IDENTITY BOARD that will be used as the visual anchor for a desktop-pet sprite sheet.',
    identityHeader(safeName, safeDescription, referenceCount),
    'Show the same character clearly in a neutral front/three-quarter view plus a few compact expression/detail callouts in ONE image.',
    'Prioritize identity fidelity, silhouette, face, costume, accessories and color consistency over dramatic composition.',
    background,
  ].join('\n\n');
}

export function buildFullAtlasPrompt({ name = 'Custom Pet', description = '', referenceCount = 0, backgroundMode = 'transparent' } = {}) {
  const safeName = String(name || 'Custom Pet').trim().slice(0, 120);
  const safeDescription = cleanDescription(description);
  const sheetType = backgroundMode === 'chroma-key' ? 'chroma-keyed' : 'transparent';
  return [
    `Create ONE production-ready ${sheetType} sprite sheet for the desktop pet “${safeName}”.`,
    identityHeader(safeName, safeDescription, referenceCount),
    `CANVAS CONTRACT: ${PET_ATLAS.width}x${PET_ATLAS.height}px, exactly ${PET_ATLAS.cols} columns x ${PET_ATLAS.rows} rows. Each cell is exactly ${PET_ATLAS.cellW}x${PET_ATLAS.cellH}px. Read left-to-right within each row.`,
    'ROW CONTRACT:',
    rowContractLines(BASE_ROW_SPECS, backgroundMode),
    artDirection(backgroundMode),
    'This is an asset sheet, not an illustration. Geometry and frame consistency are more important than decorative detail.',
  ].join('\n\n');
}

export function buildGroupPrompt({ name = 'Custom Pet', description = '', referenceCount = 0, startRow, endRow, backgroundMode = 'transparent' } = {}) {
  const group = STABLE_GROUPS.find((g) => g.startRow === startRow && g.endRow === endRow);
  if (!group) throw new RangeError(`unsupported row group: ${startRow}-${endRow}`);
  const safeName = String(name || 'Custom Pet').trim().slice(0, 120);
  const safeDescription = cleanDescription(description);
  const rows = BASE_ROW_SPECS.filter((r) => r.row >= startRow && r.row <= endRow);
  const localRows = rows.length;
  const visibleHeight = localRows * PET_ATLAS.cellH;
  const requestHeight = Number(group.size.split('x')[1]);
  const empty = emptyBackgroundPhrase(backgroundMode);
  const paddingNote = group.crop.height < requestHeight
    ? `Only the TOP ${visibleHeight}px contains the ${localRows} sprite rows. The remaining bottom ${requestHeight - visibleHeight}px MUST contain ONLY ${empty}.`
    : 'Use the entire canvas for the sprite rows; there is no extra padding.';
  const sheetType = backgroundMode === 'chroma-key' ? 'CHROMA-KEYED' : 'TRANSPARENT';
  return [
    `Create a ${sheetType} SPRITE-SHEET ROW GROUP for “${safeName}”.`,
    identityHeader(safeName, safeDescription, referenceCount),
    `OUTPUT CANVAS: ${group.size}. Make exactly 8 columns. The visible sprite grid uses ${localRows} row(s), each cell exactly 192x208px, beginning at the top-left pixel. ${paddingNote}`,
    'The supplied identity-board image is the PRIMARY visual authority. Copy its character design faithfully rather than redesigning it.',
    'GLOBAL ROWS INCLUDED IN THIS IMAGE:',
    rowContractLines(rows, backgroundMode),
    artDirection(backgroundMode),
    'Do not draw grid lines. The row/cell geometry is implicit; empty cells must use the specified removable background.',
  ].join('\n\n');
}

export function buildGenerationPlan({
  name = 'Custom Pet',
  description = '',
  referenceCount = 0,
  mode = 'stable',
  model = 'gpt-image-2',
} = {}) {
  const refs = Math.max(0, Math.min(3, Number(referenceCount) || 0));
  const flexible = modelSupportsFlexibleImageSize(model);
  const apiBackgroundMode = generationBackgroundMode(model);
  const common = {
    name: String(name || 'Custom Pet').trim().slice(0, 120),
    description: cleanDescription(description),
    referenceCount: refs,
    model,
    finalAtlas: { ...PET_ATLAS },
  };

  if (mode === 'manual') {
    const backgroundMode = 'transparent';
    return {
      ...common,
      mode: 'manual',
      strategy: 'prompt-and-import',
      backgroundMode,
      estimatedImageCalls: 0,
      fullAtlasPrompt: buildFullAtlasPrompt({ ...common, backgroundMode }),
      notes: ['Generate the image in any capable image tool, then import it into Pet Studio; the browser normalizes it to the exact atlas size.'],
    };
  }

  if (mode === 'fast') {
    const backgroundMode = apiBackgroundMode;
    return {
      ...common,
      mode: 'fast',
      strategy: 'single-atlas-call',
      backgroundMode,
      estimatedImageCalls: 1,
      requestSize: flexible ? `${PET_ATLAS.width}x${PET_ATLAS.height}` : '1024x1536',
      fullAtlasPrompt: buildFullAtlasPrompt({ ...common, backgroundMode }),
      notes: [
        ...(flexible ? [] : ['Selected model has fixed legacy image sizes; the Studio will resize the returned image to the atlas contract.']),
        ...(backgroundMode === 'chroma-key' ? [`${model} does not provide native transparent output here; the Studio removes edge-connected ${CHROMA_KEY} locally before saving the final transparent PNG.`] : []),
      ],
    };
  }

  if (flexible) {
    const backgroundMode = apiBackgroundMode;
    return {
      ...common,
      mode: 'stable',
      strategy: 'identity-anchor-plus-row-groups',
      backgroundMode,
      estimatedImageCalls: 1 + STABLE_GROUPS.length,
      identityPrompt: buildIdentityPrompt({ ...common, backgroundMode }),
      groups: STABLE_GROUPS.map((g) => ({
        ...g,
        crop: { ...g.crop },
        prompt: buildGroupPrompt({
          ...common,
          startRow: g.startRow,
          endRow: g.endRow,
          referenceCount: Math.max(1, refs),
          backgroundMode,
        }),
      })),
      notes: [
        'Identity is locked first, then four smaller row groups are generated and stitched locally for better character/layout consistency.',
        ...(backgroundMode === 'chroma-key' ? [`The Studio removes only edge-connected ${CHROMA_KEY} locally, preserving enclosed green details better than a global color delete.`] : []),
      ],
    };
  }

  const backgroundMode = apiBackgroundMode;
  return {
    ...common,
    mode: 'stable',
    strategy: 'identity-anchor-plus-single-atlas',
    backgroundMode,
    estimatedImageCalls: 2,
    identityPrompt: buildIdentityPrompt({ ...common, backgroundMode }),
    requestSize: '1024x1536',
    fullAtlasPrompt: buildFullAtlasPrompt({ ...common, referenceCount: 1, backgroundMode }),
    notes: ['Selected model does not support the flexible row-group sizes, so Stable mode still locks identity first, then makes one atlas call and normalizes locally.'],
  };
}

export function buildPackJson({ name = 'Custom Pet', id, description = '' } = {}) {
  const displayName = String(name || 'Custom Pet').trim().slice(0, 120);
  const safeDescription = cleanDescription(description);
  const petId = slugifyPetId(id || displayName);
  return {
    id: petId,
    displayName,
    chatSystemPrompt: `你是桌面宠物「${displayName}」。角色设定：${safeDescription || '保持鲜明、友好且有自己的个性。'} 回复简短自然，通常一到两句话；保持角色口吻，不要声称自己是语言模型。`,
    hasExtendedRows: false,
    ravenRows: [],
    gaze: { ...DEFAULT_GAZE },
    profile: {
      ...DEFAULT_PROFILE,
      performRows: [...DEFAULT_PROFILE.performRows],
      idleDwellMs: [...DEFAULT_PROFILE.idleDwellMs],
      weights: { ...DEFAULT_PROFILE.weights },
    },
    claudeStatusRows: { ...DEFAULT_CLAUDE_ROWS },
    rowLabels: BASE_ROW_SPECS.map((r) => r.label),
  };
}
