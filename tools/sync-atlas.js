// Refresh the local atlas copies used by tools/preview.html.
//
// The app reads the bundled sheets by default and may use user-imported sheets
// from config.json. These copies exist only so the browser QA page can load
// them over HTTP, which file:// URLs cannot do from an HTTP-served page.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const localConfigPath = join(root, 'config.json');
const defaultConfigPath = join(root, 'config.default.json');
const cfg = JSON.parse(readFileSync(existsSync(localConfigPath) ? localConfigPath : defaultConfigPath, 'utf8'));
const outDir = join(root, 'tools', 'atlas');

mkdirSync(outDir, { recursive: true });

let failed = 0;
for (const pet of cfg.pets) {
  const dest = join(outDir, `${pet.id}.webp`);
  try {
    const source = isAbsolute(pet.spritesheetPath) ? pet.spritesheetPath : join(root, pet.spritesheetPath);
    writeFileSync(dest, readFileSync(source));
    console.log(`ok   ${pet.id}  <- ${pet.spritesheetPath}`);
  } catch (err) {
    failed++;
    console.error(`FAIL ${pet.id}  <- ${pet.spritesheetPath}\n     ${err.message}`);
  }
}

process.exit(failed ? 1 : 0);
