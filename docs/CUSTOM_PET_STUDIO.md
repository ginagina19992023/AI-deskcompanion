# Custom Pet Studio

Pet Studio turns a short character description plus 0–3 reference images into a pet pack that the existing **角色 → 导入角色包** flow can already consume.

The generator does **not** replace the current pet-pack contract. It deliberately produces the same files the app already understands:

```text
generated-pets/<pet-id>/
  spritesheet.png   # 1536x2288, 8 columns x 11 base rows
  pack.json         # character metadata + generic behavior defaults
  generation.json   # local generation provenance (model/mode/reference count)
```

`generated-pets/` is ignored by Git because generated art and character descriptions are user data.

## Start it

### Windows: double click

Run:

```text
PET-STUDIO.bat
```

The launcher starts a loopback-only server and opens:

```text
http://127.0.0.1:8732
```

### Terminal

```bash
npm run pet-studio
```

Pet Studio only requires Node.js 18+ for its own server. It uses Node's built-in `fetch`, `FormData` and `Blob`; there is no additional web-server dependency.

## OpenAI setup

The Studio never asks for an API key in the browser and never writes a key into `config.json`, `pack.json`, `generation.json` or Git. The server reads it from the environment:

```powershell
$env:OPENAI_API_KEY="..."
npm run pet-studio
```

For a persistent user-level environment variable on Windows, set it through Windows Environment Variables and then start a **new** terminal / launch the `.bat` again.

Optional environment variables:

```text
PET_IMAGE_MODEL        default: gpt-image-2
PET_IMAGE_QUALITY      default: medium
OPENAI_BASE_URL        default: https://api.openai.com/v1
PET_STUDIO_PORT        default: 8732
PET_STUDIO_NO_OPEN=1   do not auto-open the browser
```

The default is `gpt-image-2` because the current API model accepts image inputs/edits and flexible image sizes, which lets the Studio request the exact sprite geometry instead of relying only on post-resizing.

## Input

A user supplies:

1. **Name** — used for `displayName` and the default pack id.
2. **Description** — appearance + personality + clothes/accessories + species + voice/style. This is also used to build the default short chat persona in `pack.json`.
3. **0–3 reference images** — PNG/JPEG/WebP. One image is enough. Two or three different views usually improve identity consistency.
4. **Generation strategy** — Stable, Fast, or Manual.

Reference images are held in browser memory and sent to the configured image endpoint only after the user clicks **生成宠物**. The Studio does not copy reference images into `generated-pets/`.

## Three generation paths

### Stable mode (recommended)

With `gpt-image-2`, Stable mode is intentionally multi-stage:

1. Build an **identity anchor** from the description + all available references.
2. Use the identity anchor as the first/high-fidelity image input for four smaller sprite-sheet groups:
   - rows 0–2
   - rows 3–5
   - rows 6–8
   - rows 9–10
3. Stitch those groups locally in the browser into the exact final 1536x2288 atlas.

Why: asking one image call to simultaneously solve identity consistency, eleven action rows, exact grid geometry and animation continuity is a lot. Locking identity first and generating smaller row groups makes the constraints more local and easier to satisfy.

The last two-row group is requested as `1536x528`, with the real 416px sprite region at the top and transparent padding below. That keeps the generation request inside the image model's aspect-ratio / minimum-pixel constraints; the browser crops the padding before assembly.

### Fast mode

One image call creates the whole atlas.

With a flexible-size model the Studio requests the exact `1536x2288` canvas. With a legacy fixed-size model it requests a supported portrait size and normalizes the result to `1536x2288` locally.

Use this for cheap drafts and style exploration. Stable mode is preferable once the character design is close.

### Manual mode / no API

Manual mode makes **zero** image API calls. It generates the full production prompt and lets the user:

1. copy the prompt,
2. use ChatGPT or another image tool manually with the reference images,
3. export one image,
4. import that image back into Pet Studio.

The browser then normalizes it to the required atlas size and packages it normally. This is also the fallback for providers that do not expose a compatible image endpoint.

## Multi-reference fallback

The server first attempts the image edit call with all references.

If an endpoint rejects multi-image input with a request/format error, the Studio automatically retries with a single reference:

- during identity creation: the first user reference;
- during Stable action generation: the **identity anchor** (which is always placed first), so the already-fused character identity remains the source of truth.

This means the architecture does not depend on multi-reference support being universally available.

## Atlas contract

The existing app uses the base v2 atlas:

- final size: `1536x2288`
- grid: `8 columns x 11 rows`
- cell size: `192x208`
- frame counts: `[7, 8, 8, 4, 5, 8, 6, 6, 6, 8, 8]`

Rows generated by the Studio:

| Row | Used frames | Meaning |
| ---: | ---: | --- |
| 0 | 7 | idle |
| 1 | 8 | move right |
| 2 | 8 | move left |
| 3 | 4 | greeting / perform |
| 4 | 5 | celebrate / jump |
| 5 | 8 | annoyed / filler action |
| 6 | 6 | waiting |
| 7 | 6 | rest |
| 8 | 6 | work / review |
| 9 | 8 | look / turn A |
| 10 | 8 | look / turn B |

Unused cells in a row are prompted to stay transparent. The UI overlays a grid for inspection; the overlay is **not** baked into `spritesheet.png`.

## Import into the desktop pet

After **保存为角色包**, Pet Studio prints the created folder. In the normal desktop-pet control panel:

1. open **角色**,
2. click **＋ 导入角色包**,
3. choose the generated folder,
4. inspect/switch to the new pet.

The existing importer validates atlas dimensions and consumes `pack.json`, so generated pets enter through the same code path as hand-authored packs.

## Validation and quality expectations

The generator can enforce geometry in prompts and local assembly, but image models can still occasionally:

- let limbs cross a cell boundary,
- duplicate a character inside one cell,
- drift an accessory/color between actions,
- produce weak left/right motion distinction.

That is why Pet Studio keeps the grid visible by default. Treat generation as an art pipeline with inspection, not as a proof that every frame is automatically production-perfect.

Stable mode reduces those failure modes; it does not make them mathematically impossible.

## Code layout

```text
src/pet-generator.js          pure atlas/prompt/pack planning logic
tools/pet-studio/server.mjs   localhost server + OpenAI image calls + local pack writer
tools/pet-studio/index.html   browser UI + image stitching/normalization
PET-STUDIO.bat                Windows double-click launcher
test/pet-generator.test.js    generation-contract tests
```

The pure planning module does not import Electron/DOM/Node APIs, so it remains testable with the existing `node --test` suite.
