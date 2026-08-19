// Geometry of the Codex v2 pet atlas.
//
// Measured cell-by-cell from both shipped pets (sebastian-raven and
// ciel-young-master); the numbers below are identical for both and are
// corroborated by ciel-young-master-pet/validation.json.
//
// NOTE: the vendored hatch-pet contract in ~/.codex/vendor_imports describes
// the *v1* atlas (8x9, 1536x1872) and its validate_atlas.py will reject a v2
// sheet. Do not validate these sheets with it.
//
// sebastian-raven only: rows 11-12 are a Codex-generated extension (not
// present on ciel-young-master), adding true perch/lie-down art. See
// Documents/Codex/2026-08-05/ban/work/sebastian-raven-extension/final/
// validation-13rows.json -- 6 used frames each, rows 0-10 verified
// byte-identical (old_rows_exact) so this only grows the atlas.

export const ATLAS = Object.freeze({
  width: 1536,
  height: 2704,
  cols: 8,
  rows: 13,
  cellW: 192,
  cellH: 208,
});

// Every pet's sheet has at least these 11 rows; only sebastian-raven has
// grown to the full 13 (rows 11-12). Sheet-height validation (renderer.js
// loadPet) accepts anything between BASE_ROWS and ATLAS.rows rows tall.
export const BASE_ROWS = 11;

export const ROWS = Object.freeze({
  IDLE: 0,
  RUN_RIGHT: 1,
  RUN_LEFT: 2,
  WAVING: 3,
  JUMPING: 4,
  PECK: 5,
  WAITING: 6,
  DOZE: 7,
  REVIEW: 8,
  TURN_A: 9, // look-000-to-157.5
  TURN_B: 10, // look-180-to-337.5
  PERCH: 11, // sebastian-raven only: gripping a branch, true front view
  LIE_DOWN: 12, // sebastian-raven only: side-lying, breathing idle
});

// Row 0 is 7 frames in v2. The v1 contract says 6 -- do not "correct" this.
export const ROW_FRAME_COUNTS = Object.freeze([7, 8, 8, 4, 5, 8, 6, 6, 6, 8, 8, 6, 6]);

export const HEAD_FRAME_COUNT = 16;

export function frameRect(row, col) {
  if (!Number.isInteger(row) || row < 0 || row >= ATLAS.rows) {
    throw new RangeError(`row out of range: ${row}`);
  }
  if (!Number.isInteger(col) || col < 0 || col >= ROW_FRAME_COUNTS[row]) {
    throw new RangeError(
      `col ${col} out of range for row ${row} (has ${ROW_FRAME_COUNTS[row]} frames)`,
    );
  }
  return {
    sx: col * ATLAS.cellW,
    sy: row * ATLAS.cellH,
    sw: ATLAS.cellW,
    sh: ATLAS.cellH,
  };
}

// k = 0..15 spans rows 9 and 10 as one continuous 360 degree yaw sweep.
export function headFrameRect(k) {
  if (!Number.isInteger(k) || k < 0 || k >= HEAD_FRAME_COUNT) {
    throw new RangeError(`head frame index out of range: ${k}`);
  }
  return k < 8 ? frameRect(ROWS.TURN_A, k) : frameRect(ROWS.TURN_B, k - 8);
}
