"""
Procedurally restyle the raven rows (1, 2, 5) of the sebastian-raven atlas.

No image-generation tool is available in this environment, so this is a
pixel-processing pass on the existing painted/shaded raven art, not a redraw.
It cannot fully match a hand-drawn flat-vector reference; it can shrink,
slim, flatten the shading, and add a crimson outline matching the butler's
linework. Everything outside rows 1/2/5 (butler poses, head-turn rows) is
copied through byte-identical.

Usage:
    python restyle_raven.py <input_atlas.webp> <output_atlas.webp> [--contact-sheet out.png]
"""

import argparse
import sys

from PIL import Image

CW, CH, COLS, ROWS = 192, 208, 8, 11
RAVEN_ROWS = {1, 2, 5}
ROW_FRAME_COUNTS = [7, 8, 8, 4, 5, 8, 6, 6, 6, 8, 8]

# Sampled from the butler's own linework (row 0). See sebastian-desktop-pet
# README for the measurement.
OUTLINE_RGB = (120, 24, 32)

# Target size for the restyled raven relative to the original content bbox.
SCALE_H = 0.60  # overall shrink
SLIM_X = 0.82  # extra horizontal squeeze on top of SCALE_H, for a leaner body
OUTLINE_PX = 2  # outline thickness in the working (upscaled) resolution
UPSCALE = 3  # work at higher res so a 2px outline isn't blocky at 192x208


def flatten_shading(rgba):
    """Push mid/dark tones toward flat near-black bands; keep the red eye
    as the one bright accent, echoing the reference's solid-body + bright-eye
    silhouette language without trying to redraw the eye shape itself."""
    px = rgba.load()
    w, h = rgba.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a == 0:
                continue
            is_eye = r > 110 and r > g + 30 and r > b + 15
            if is_eye:
                continue
            lum = 0.299 * r + 0.587 * g + 0.114 * b
            if lum < 55:
                nr, ng, nb = 14, 11, 15
            elif lum < 110:
                nr, ng, nb = 26, 20, 24
            else:
                nr, ng, nb = 42, 32, 36
            px[x, y] = (nr, ng, nb, a)
    return rgba


def add_outline(rgba, thickness, color):
    """Dilate the alpha mask outward and fill the new ring with `color`,
    alpha-weighted by the mask's own alpha for a soft anti-aliased edge."""
    w, h = rgba.size
    alpha = rgba.split()[3]
    from PIL import ImageFilter

    dilated = alpha
    for _ in range(thickness):
        dilated = dilated.filter(ImageFilter.MaxFilter(3))

    out = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    src_px = rgba.load()
    dil_px = dilated.load()
    out_px = out.load()
    for y in range(h):
        for x in range(w):
            sa = src_px[x, y][3]
            da = dil_px[x, y]
            if da == 0:
                continue
            if sa > 40:
                out_px[x, y] = src_px[x, y]
            else:
                out_px[x, y] = (color[0], color[1], color[2], da)
    return out


def restyle_frame(cell):
    """cell: RGBA Image, CWxCH. Returns a new RGBA Image, CWxCH."""
    bbox = cell.getbbox()
    if bbox is None:
        return cell.copy()

    content = cell.crop(bbox)
    bw, bh = content.size
    feet_y = bbox[3]  # keep the same ground line so the walk cycle doesn't pop
    cx = (bbox[0] + bbox[2]) / 2  # keep the same horizontal anchor

    target_h = max(1, round(bh * SCALE_H))
    target_w = max(1, round(bw * SCALE_H * SLIM_X))

    work = content.resize(
        (target_w * UPSCALE, target_h * UPSCALE), Image.LANCZOS
    ).convert("RGBA")
    work = flatten_shading(work)
    work = add_outline(work, OUTLINE_PX * UPSCALE // 2 or 1, OUTLINE_RGB)
    work = work.resize((target_w, target_h), Image.LANCZOS)

    out = Image.new("RGBA", (CW, CH), (0, 0, 0, 0))
    px = out.width
    paste_x = round(cx - target_w / 2)
    paste_y = round(feet_y - target_h)
    out.alpha_composite(work, (paste_x, paste_y))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("output")
    ap.add_argument("--contact-sheet")
    args = ap.parse_args()

    src = Image.open(args.input).convert("RGBA")
    if src.size != (COLS * CW, ROWS * CH):
        print(f"unexpected atlas size {src.size}", file=sys.stderr)
        sys.exit(1)

    out = src.copy()
    changed = []
    for r in RAVEN_ROWS:
        for c in range(ROW_FRAME_COUNTS[r]):
            x0, y0 = c * CW, r * CH
            cell = src.crop((x0, y0, x0 + CW, y0 + CH))
            new_cell = restyle_frame(cell)
            out.paste((0, 0, 0, 0), (x0, y0, x0 + CW, y0 + CH))
            out.alpha_composite(new_cell, (x0, y0))
            changed.append((r, c))

    out.save(args.output, "WEBP", lossless=True)
    print(f"wrote {args.output} ({len(changed)} raven frames restyled)")

    if args.contact_sheet:
        rows_shown = sorted(RAVEN_ROWS)
        sheet = Image.new(
            "RGBA", (max(ROW_FRAME_COUNTS[r] for r in rows_shown) * CW, len(rows_shown) * CH * 2),
            (255, 255, 255, 255),
        )
        for i, r in enumerate(rows_shown):
            for c in range(ROW_FRAME_COUNTS[r]):
                x0, y0 = c * CW, r * CH
                sheet.alpha_composite(src.crop((x0, y0, x0 + CW, y0 + CH)), (c * CW, i * CH * 2))
                sheet.alpha_composite(out.crop((x0, y0, x0 + CW, y0 + CH)), (c * CW, i * CH * 2 + CH))
        sheet.convert("RGB").save(args.contact_sheet)
        print(f"wrote contact sheet {args.contact_sheet} (top=before, bottom=after per row)")


if __name__ == "__main__":
    main()
