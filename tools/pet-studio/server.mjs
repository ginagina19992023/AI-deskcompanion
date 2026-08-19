import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import {
  buildGenerationPlan,
  buildPackJson,
  generationBackgroundMode,
  slugifyPetId,
} from '../../src/pet-generator.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const generatedRoot = join(repoRoot, 'generated-pets');
const indexPath = join(here, 'index.html');
const host = '127.0.0.1';
const port = Number(process.env.PET_STUDIO_PORT || 8732);
const model = process.env.PET_IMAGE_MODEL || process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2';
const quality = process.env.PET_IMAGE_QUALITY || 'medium';
const apiKey = process.env.OPENAI_API_KEY || '';
const apiBase = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
const maxJsonBytes = 72 * 1024 * 1024;
const maxReferenceBytes = 16 * 1024 * 1024;

mkdirSync(generatedRoot, { recursive: true });

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxJsonBytes) {
        reject(new HttpError(413, '请求太大：参考图的 base64 请求总量请控制在约 70MB 内。'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (err) {
        reject(new HttpError(400, `JSON 解析失败：${err.message}`));
      }
    });
    req.on('error', reject);
  });
}

function parseDataUrl(dataUrl, name = 'reference.png') {
  const match = /^data:(image\/(?:png|jpeg|jpg|webp));base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(dataUrl || ''));
  if (!match) throw new HttpError(400, `无法读取参考图 ${name}，仅支持 PNG/JPEG/WebP。`);
  const mime = match[1].toLowerCase().replace('image/jpg', 'image/jpeg');
  const buffer = Buffer.from(match[2].replace(/\s+/g, ''), 'base64');
  if (!buffer.length) throw new HttpError(400, `参考图 ${name} 是空文件。`);
  if (buffer.length > maxReferenceBytes) throw new HttpError(413, `参考图 ${name} 超过 16MB，请先压缩。`);
  return { buffer, mime, name };
}

function pngDimensions(buffer) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(signature)) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function isGptImage2(value = model) {
  return /^gpt-image-2(?:$|-)/.test(String(value));
}

function appendSharedImageFields(form, { prompt, size }) {
  form.append('model', model);
  form.append('prompt', prompt);
  form.append('n', '1');
  form.append('size', size);
  form.append('quality', quality);
  form.append('output_format', 'png');
  if (!isGptImage2()) form.append('background', 'transparent');
}

async function openAIImage({ prompt, references = [], size, inputFidelity = 'high' }) {
  if (!apiKey) throw new HttpError(400, '没有检测到 OPENAI_API_KEY。可以先用「手动模式」生成提示词，再把外部生成结果导回 Pet Studio。');
  if (typeof fetch !== 'function' || typeof FormData === 'undefined' || typeof Blob === 'undefined') {
    throw new HttpError(500, 'Pet Studio 需要 Node.js 18+（需要内置 fetch/FormData/Blob）。');
  }

  const hasReferences = references.length > 0;
  const endpoint = `${apiBase}/images/${hasReferences ? 'edits' : 'generations'}`;
  const headers = { Authorization: `Bearer ${apiKey}` };
  let body;

  if (hasReferences) {
    const form = new FormData();
    appendSharedImageFields(form, { prompt, size });
    // gpt-image-2 image inputs are always high fidelity and reject an
    // explicit input_fidelity parameter. Older GPT Image models accept it.
    if (!isGptImage2()) form.append('input_fidelity', inputFidelity);
    for (let i = 0; i < references.length; i++) {
      const ref = references[i];
      form.append('image[]', new Blob([ref.buffer], { type: ref.mime }), ref.name || `reference-${i + 1}.png`);
    }
    body = form;
  } else {
    headers['Content-Type'] = 'application/json';
    const payload = {
      model,
      prompt,
      n: 1,
      size,
      quality,
      output_format: 'png',
    };
    // gpt-image-2 currently rejects background=transparent; its prompt uses
    // a chroma key and the browser turns edge-connected key pixels into alpha.
    if (!isGptImage2()) payload.background = 'transparent';
    body = JSON.stringify(payload);
  }

  const response = await fetch(endpoint, { method: 'POST', headers, body });
  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const message = payload?.error?.message || payload?.message || `HTTP ${response.status}`;
    const err = new HttpError(response.status, `图像 API 调用失败：${message}`);
    err.apiStatus = response.status;
    throw err;
  }
  const base64 = payload?.data?.[0]?.b64_json;
  if (!base64) throw new HttpError(502, '图像 API 返回成功，但没有收到 b64_json 图片数据。');
  return { base64, mime: 'image/png' };
}

async function openAIImageWithReferenceFallback(options, warnings) {
  try {
    return await openAIImage(options);
  } catch (err) {
    const retryableReferenceError = [400, 413, 415, 422].includes(err.apiStatus || err.status);
    if (options.references.length <= 1 || !retryableReferenceError) throw err;
    warnings.push('当前图像端点没有接受多张参考图，已自动降级为只使用第一张（若是稳定模式，第一张会是已经融合身份的 identity anchor）。');
    return openAIImage({ ...options, references: [options.references[0]] });
  }
}

function generatedImageAsReference(image, name = 'identity-anchor.png') {
  return { buffer: Buffer.from(image.base64, 'base64'), mime: image.mime || 'image/png', name };
}

async function generatePet(body) {
  const name = String(body.name || '').trim();
  const description = String(body.description || '').trim();
  const mode = ['fast', 'stable'].includes(body.mode) ? body.mode : 'stable';
  if (!name) throw new HttpError(400, '请先给宠物起一个名字。');
  if (!description) throw new HttpError(400, '请写一段外观/性格介绍，这会成为角色一致性的主要文字约束。');
  const rawReferences = Array.isArray(body.references) ? body.references.slice(0, 3) : [];
  const references = rawReferences.map((ref, index) => parseDataUrl(ref.dataUrl, ref.name || `reference-${index + 1}.png`));
  const plan = buildGenerationPlan({ name, description, referenceCount: references.length, mode, model });
  const warnings = [];

  if (plan.strategy === 'single-atlas-call') {
    const atlas = await openAIImageWithReferenceFallback(
      { prompt: plan.fullAtlasPrompt, references, size: plan.requestSize },
      warnings,
    );
    return {
      ok: true,
      plan,
      warnings,
      result: { type: 'atlas', image: atlas, requestedSize: plan.requestSize },
    };
  }

  const anchor = await openAIImageWithReferenceFallback(
    { prompt: plan.identityPrompt, references, size: '1024x1024' },
    warnings,
  );
  const anchorRef = generatedImageAsReference(anchor);

  if (plan.strategy === 'identity-anchor-plus-single-atlas') {
    const atlasReferences = [anchorRef, ...references];
    const atlas = await openAIImageWithReferenceFallback(
      { prompt: plan.fullAtlasPrompt, references: atlasReferences, size: plan.requestSize },
      warnings,
    );
    return {
      ok: true,
      plan,
      warnings,
      identityAnchor: anchor,
      result: { type: 'atlas', image: atlas, requestedSize: plan.requestSize },
    };
  }

  const groups = [];
  for (const group of plan.groups) {
    const groupReferences = [anchorRef, ...references];
    const image = await openAIImageWithReferenceFallback(
      { prompt: group.prompt, references: groupReferences, size: group.size },
      warnings,
    );
    groups.push({
      startRow: group.startRow,
      endRow: group.endRow,
      requestedSize: group.size,
      crop: group.crop,
      image,
    });
  }
  return {
    ok: true,
    plan,
    warnings,
    identityAnchor: anchor,
    result: { type: 'groups', groups },
  };
}

function uniqueOutputDir(baseId) {
  const safeBase = slugifyPetId(baseId);
  let candidate = join(generatedRoot, safeBase);
  if (!existsSync(candidate)) return candidate;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '').replace('T', '-');
  candidate = join(generatedRoot, `${safeBase}-${stamp}`);
  let suffix = 2;
  while (existsSync(candidate)) candidate = join(generatedRoot, `${safeBase}-${stamp}-${suffix++}`);
  return candidate;
}

function savePack(body) {
  const name = String(body.name || '').trim();
  const description = String(body.description || '').trim();
  if (!name) throw new HttpError(400, '缺少宠物名字。');
  const image = parseDataUrl(body.imageDataUrl, 'spritesheet.png');
  if (image.mime !== 'image/png') throw new HttpError(400, '最终图集必须由 Studio 画布导出为 PNG。');
  const dims = pngDimensions(image.buffer);
  if (!dims || dims.width !== 1536 || dims.height !== 2288) {
    throw new HttpError(400, `最终图集尺寸必须是 1536x2288，实际是 ${dims ? `${dims.width}x${dims.height}` : '无法识别的 PNG'}。`);
  }

  const pack = buildPackJson({ name, id: body.id, description });
  const outDir = uniqueOutputDir(pack.id);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'spritesheet.png'), image.buffer);
  writeFileSync(join(outDir, 'pack.json'), `${JSON.stringify(pack, null, 2)}\n`, 'utf8');
  writeFileSync(
    join(outDir, 'generation.json'),
    `${JSON.stringify({
      createdAt: new Date().toISOString(),
      generator: 'AI Desk Companion Pet Studio',
      model: body.generationMeta?.model || model,
      quality,
      mode: body.generationMeta?.mode || body.mode || 'manual-import',
      strategy: body.generationMeta?.strategy || null,
      backgroundMode: body.generationMeta?.backgroundMode || generationBackgroundMode(body.generationMeta?.model || model),
      referenceCount: Number(body.generationMeta?.referenceCount) || 0,
      description,
    }, null, 2)}\n`,
    'utf8',
  );
  return {
    ok: true,
    id: pack.id,
    path: outDir,
    relativePath: relative(repoRoot, outDir),
    files: ['spritesheet.png', 'pack.json', 'generation.json'],
  };
}

function ensureGeneratedPath(candidate) {
  const resolved = resolve(candidate || generatedRoot);
  const rootWithSep = generatedRoot.endsWith(sep) ? generatedRoot : `${generatedRoot}${sep}`;
  if (resolved !== generatedRoot && !resolved.startsWith(rootWithSep)) throw new HttpError(400, '只能打开 generated-pets 目录中的路径。');
  return resolved;
}

function openLocalPath(path) {
  const target = ensureGeneratedPath(path);
  let child;
  if (process.platform === 'win32') child = spawn('explorer.exe', [target], { detached: true, stdio: 'ignore', windowsHide: true });
  else if (process.platform === 'darwin') child = spawn('open', [target], { detached: true, stdio: 'ignore' });
  else child = spawn('xdg-open', [target], { detached: true, stdio: 'ignore' });
  child.unref();
  return { ok: true, path: target };
}

function openBrowser(url) {
  try {
    let child;
    if (process.platform === 'win32') child = spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true });
    else if (process.platform === 'darwin') child = spawn('open', [url], { detached: true, stdio: 'ignore' });
    else child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch {
    // The URL is printed below as a reliable fallback.
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${host}:${port}`);
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const html = readFileSync(indexPath);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Length': html.length,
      });
      res.end(html);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/status') {
      sendJson(res, 200, {
        ok: true,
        hasApiKey: !!apiKey,
        model,
        quality,
        backgroundMode: generationBackgroundMode(model),
        generatedRoot,
        apiBaseHost: (() => {
          try { return new URL(apiBase).host; } catch { return 'custom'; }
        })(),
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/plan') {
      const body = await readJson(req);
      const references = Array.isArray(body.references) ? body.references : [];
      const plan = buildGenerationPlan({
        name: body.name,
        description: body.description,
        referenceCount: Math.min(3, references.length || Number(body.referenceCount) || 0),
        mode: body.mode || 'stable',
        model,
      });
      sendJson(res, 200, { ok: true, plan, pack: buildPackJson({ name: body.name, id: body.id, description: body.description }) });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/generate') {
      const body = await readJson(req);
      sendJson(res, 200, await generatePet(body));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/save-pack') {
      const body = await readJson(req);
      sendJson(res, 200, savePack(body));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/open-folder') {
      const body = await readJson(req);
      sendJson(res, 200, openLocalPath(body.path));
      return;
    }
    sendJson(res, 404, { ok: false, error: 'Not found' });
  } catch (err) {
    const status = Number(err.status) || 500;
    console.error('[pet-studio]', err);
    sendJson(res, status, { ok: false, error: err.message || '未知错误' });
  }
});

server.listen(port, host, () => {
  const url = `http://${host}:${port}`;
  console.log('');
  console.log('AI Desk Companion · Pet Studio');
  console.log(`  ${url}`);
  console.log(`  model: ${model} / quality: ${quality}`);
  console.log(`  background: ${generationBackgroundMode(model)}${isGptImage2() ? ' (local chroma → alpha)' : ' (native API transparency)'}`);
  console.log(`  OPENAI_API_KEY: ${apiKey ? 'detected' : 'not set (manual mode still works)'}`);
  console.log(`  output: ${generatedRoot}`);
  console.log('');
  if (process.env.PET_STUDIO_NO_OPEN !== '1') openBrowser(url);
});
