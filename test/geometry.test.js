import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resizedBoundsKeepingAnchor,
  screenEdgeDropPose,
  windowEdgeDropPose,
  pickBubbleSide,
  growBoundsForBubble,
  petRectFromGrownBounds,
  growBoundsForRing,
} from '../src/geometry.js';

test('shrinking keeps the horizontal centre and the bottom edge fixed', () => {
  const bounds = { x: 100, y: 100, width: 200, height: 200 }; // centre x=200, bottom y=300
  const r = resizedBoundsKeepingAnchor(bounds, 100, 100);
  assert.deepEqual(r, { x: 150, y: 200, width: 100, height: 100 });
  assert.equal(r.x + r.width / 2, 200, 'centre must be unchanged');
  assert.equal(r.y + r.height, 300, 'bottom edge must be unchanged');
});

test('growing keeps the same anchor', () => {
  const bounds = { x: 100, y: 100, width: 200, height: 200 };
  const r = resizedBoundsKeepingAnchor(bounds, 400, 400);
  assert.equal(r.x + r.width / 2, 200);
  assert.equal(r.y + r.height, 300);
});

test('an unchanged size is a no-op on position', () => {
  const bounds = { x: 37, y: 51, width: 192, height: 208 };
  const r = resizedBoundsKeepingAnchor(bounds, 192, 208);
  assert.deepEqual(r, bounds);
});

test('growBoundsForRing: grows equally on all four sides, keeping the sprite centred', () => {
  const petRect = { x: 100, y: 100, width: 160, height: 180 };
  const r = growBoundsForRing(petRect, 40);
  assert.deepEqual(r, { x: 60, y: 60, width: 240, height: 260 });
  // The pet's own centre point must be unchanged.
  assert.equal(r.x + r.width / 2, petRect.x + petRect.width / 2);
  assert.equal(r.y + r.height / 2, petRect.y + petRect.height / 2);
});

test('growBoundsForRing: zero extra is a no-op', () => {
  const petRect = { x: 5, y: 5, width: 50, height: 50 };
  assert.deepEqual(growBoundsForRing(petRect, 0), petRect);
});

const workArea = { x: 0, y: 0, width: 1920, height: 1080 };
const petSize = { width: 192, height: 208 };

test('screenEdgeDropPose: dropped in the middle of the screen is not a pose', () => {
  const pet = { x: 900, y: 500, ...petSize };
  assert.equal(screenEdgeDropPose(pet, workArea, 24), null);
});

test('screenEdgeDropPose: left/right/top edges perch; only the bottom lies down', () => {
  assert.equal(screenEdgeDropPose({ x: 0, y: 500, ...petSize }, workArea, 24), 'perch');
  assert.equal(screenEdgeDropPose({ x: 1920 - petSize.width, y: 500, ...petSize }, workArea, 24), 'perch');
  assert.equal(screenEdgeDropPose({ x: 900, y: 0, ...petSize }, workArea, 24), 'perch');
  assert.equal(screenEdgeDropPose({ x: 900, y: 1080 - petSize.height, ...petSize }, workArea, 24), 'lieDown');
});

test('screenEdgeDropPose: bottom-left corner is a lie-down, not a perch -- bottom wins', () => {
  assert.equal(screenEdgeDropPose({ x: 0, y: 1080 - petSize.height, ...petSize }, workArea, 24), 'lieDown');
});

const otherWindow = { x: 400, y: 200, width: 800, height: 600 }; // spans x 400-1200, y 200-800

test('windowEdgeDropPose: far from any window is not a pose', () => {
  const pet = { x: 0, y: 0, ...petSize };
  assert.equal(windowEdgeDropPose(pet, otherWindow, 30), null);
});

test('windowEdgeDropPose: resting against the window\'s left or right side perches', () => {
  const atLeftSide = { x: otherWindow.x - petSize.width, y: 500, ...petSize };
  assert.equal(windowEdgeDropPose(atLeftSide, otherWindow, 30), 'perch');
  const atRightSide = { x: otherWindow.x + otherWindow.width, y: 500, ...petSize };
  assert.equal(windowEdgeDropPose(atRightSide, otherWindow, 30), 'perch');
});

test('windowEdgeDropPose: standing on top of the window lies down, even overlapping its side', () => {
  // Sitting right at the top-left corner: both "near left" and "near top"
  // are geometrically true, but landing *on* the window should read as
  // using it as a floor, not perching off its side.
  const onTop = { x: otherWindow.x - 10, y: otherWindow.y - petSize.height, ...petSize };
  assert.equal(windowEdgeDropPose(onTop, otherWindow, 30), 'lieDown');
});

test('windowEdgeDropPose: side proximity only counts when vertically overlapping the window', () => {
  // Level with the window's left edge on the x-axis, but far enough above
  // it on the y-axis that it isn't really "beside" or "on top of" it.
  const aboveNotBeside = { x: otherWindow.x - petSize.width, y: otherWindow.y - 300, ...petSize };
  assert.equal(windowEdgeDropPose(aboveNotBeside, otherWindow, 30), null);
});

test('pickBubbleSide: prefers top when there is room above', () => {
  const pet = { x: 900, y: 500, ...petSize };
  assert.equal(pickBubbleSide(pet, workArea, 100), 'top');
});

test('pickBubbleSide: falls back to bottom when pinned to the top edge', () => {
  const pet = { x: 900, y: 0, ...petSize };
  assert.equal(pickBubbleSide(pet, workArea, 100), 'bottom');
});

test('pickBubbleSide: falls back to a side when pinned to both top and bottom (short screen)', () => {
  const shortArea = { x: 0, y: 0, width: 1920, height: 300 };
  // Pet fills almost the whole height -- neither top nor bottom has 100px.
  const pet = { x: 900, y: 40, width: 192, height: 220 };
  const side = pickBubbleSide(pet, shortArea, 100);
  assert.ok(side === 'left' || side === 'right', `expected a horizontal fallback, got ${side}`);
});

test('pickBubbleSide: picks whichever horizontal side has more room when pinned top and bottom', () => {
  const shortArea = { x: 0, y: 0, width: 1920, height: 300 };
  // Pet sits far to the left -- much more room on the right than the left.
  const pet = { x: 20, y: 40, width: 192, height: 220 };
  assert.equal(pickBubbleSide(pet, shortArea, 100), 'right');
});

test('pickBubbleSide: never returns null even when nothing fits cleanly', () => {
  const tinyArea = { x: 0, y: 0, width: 250, height: 250 };
  const pet = { x: 20, y: 20, width: 200, height: 200 };
  const side = pickBubbleSide(pet, tinyArea, 500);
  assert.ok(['top', 'bottom', 'left', 'right'].includes(side));
});

test('growBoundsForBubble: top/bottom keep width and x fixed, grow height', () => {
  const pet = { x: 100, y: 100, width: 160, height: 180 };
  assert.deepEqual(growBoundsForBubble(pet, 'top', 40), { x: 100, y: 60, width: 160, height: 220 });
  assert.deepEqual(growBoundsForBubble(pet, 'bottom', 40), { x: 100, y: 100, width: 160, height: 220 });
});

test('growBoundsForBubble: left/right keep height and y fixed, grow width', () => {
  const pet = { x: 100, y: 100, width: 160, height: 180 };
  assert.deepEqual(growBoundsForBubble(pet, 'left', 50), { x: 50, y: 100, width: 210, height: 180 });
  assert.deepEqual(growBoundsForBubble(pet, 'right', 50), { x: 100, y: 100, width: 210, height: 180 });
});

test('growBoundsForBubble: the sprite\'s own screen position never moves -- only the growth edge shifts', () => {
  const pet = { x: 300, y: 300, width: 160, height: 180 };
  for (const side of ['top', 'bottom', 'left', 'right']) {
    const grown = growBoundsForBubble(pet, side, 60);
    // The pet's own rect (opposite edge from growth) must still be found
    // somewhere within the grown bounds, unmoved.
    if (side === 'top' || side === 'bottom') {
      assert.equal(grown.x, pet.x);
      assert.equal(grown.width, pet.width);
    } else {
      assert.equal(grown.y, pet.y);
      assert.equal(grown.height, pet.height);
    }
  }
});

test('petRectFromGrownBounds undoes growBoundsForBubble exactly, for every side', () => {
  const pet = { x: 300, y: 300, width: 160, height: 180 };
  for (const side of ['top', 'bottom', 'left', 'right']) {
    const grown = growBoundsForBubble(pet, side, 60);
    const recovered = petRectFromGrownBounds(grown, side, 60);
    assert.deepEqual(recovered, pet, `round-trip failed for side ${side}`);
  }
});

test('petRectFromGrownBounds with side=null is a no-op, matching growBoundsForBubble default', () => {
  const bounds = { x: 10, y: 20, width: 160, height: 180 };
  assert.deepEqual(petRectFromGrownBounds(bounds, null, 0), bounds);
});
