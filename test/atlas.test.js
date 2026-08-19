import test from 'node:test';
import assert from 'node:assert/strict';
import { ATLAS, BASE_ROWS, ROWS, ROW_FRAME_COUNTS, frameRect, headFrameRect } from '../src/atlas.js';

test('atlas geometry constants are self-consistent', () => {
  assert.equal(ATLAS.width, 1536);
  assert.equal(ATLAS.height, 2704);
  assert.equal(ATLAS.cols * ATLAS.cellW, ATLAS.width);
  assert.equal(ATLAS.rows * ATLAS.cellH, ATLAS.height);
  // ciel-young-master hasn't grown past the original 11 rows yet.
  assert.equal(BASE_ROWS, 11);
  assert.ok(BASE_ROWS <= ATLAS.rows);
});

test('row frame counts match both measured atlases', () => {
  assert.deepEqual([...ROW_FRAME_COUNTS], [7, 8, 8, 4, 5, 8, 6, 6, 6, 8, 8, 6, 6]);
  assert.equal(ROW_FRAME_COUNTS.length, ATLAS.rows);
  assert.equal(ROW_FRAME_COUNTS[ROWS.IDLE], 7, 'idle is 7 frames in v2, not the v1 contract 6');
  assert.equal(ROW_FRAME_COUNTS[ROWS.PERCH], 6, 'sebastian-raven-only perch row, 6 frames');
  assert.equal(ROW_FRAME_COUNTS[ROWS.LIE_DOWN], 6, 'sebastian-raven-only lie-down row, 6 frames');
});

test('frameRect computes source rectangles', () => {
  assert.deepEqual(frameRect(0, 0), { sx: 0, sy: 0, sw: 192, sh: 208 });
  assert.deepEqual(frameRect(1, 3), { sx: 576, sy: 208, sw: 192, sh: 208 });
  assert.deepEqual(frameRect(10, 7), { sx: 1344, sy: 2080, sw: 192, sh: 208 });
});

test('frameRect rejects out-of-range access', () => {
  assert.throws(() => frameRect(13, 0), RangeError);
  assert.throws(() => frameRect(-1, 0), RangeError);
  assert.throws(() => frameRect(3, 4), RangeError, 'row 3 only has 4 frames');
  assert.throws(() => frameRect(0, 7), RangeError, 'row 0 only has 7 frames');
  assert.throws(() => frameRect(11, 6), RangeError, 'perch row only has 6 frames');
});

test('frameRect computes source rectangles for the new perch/lie-down rows', () => {
  assert.deepEqual(frameRect(11, 0), { sx: 0, sy: 11 * 208, sw: 192, sh: 208 });
  assert.deepEqual(frameRect(12, 5), { sx: 5 * 192, sy: 12 * 208, sw: 192, sh: 208 });
});

test('headFrameRect maps k=0..15 across rows 9 and 10', () => {
  assert.deepEqual(headFrameRect(0), frameRect(ROWS.TURN_A, 0));
  assert.deepEqual(headFrameRect(7), frameRect(ROWS.TURN_A, 7));
  assert.deepEqual(headFrameRect(8), frameRect(ROWS.TURN_B, 0));
  assert.deepEqual(headFrameRect(15), frameRect(ROWS.TURN_B, 7));
});

test('headFrameRect rejects out-of-range k', () => {
  assert.throws(() => headFrameRect(16), RangeError);
  assert.throws(() => headFrameRect(-1), RangeError);
});
