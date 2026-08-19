// Pure window-geometry math, kept separate from main.js so it can be unit
// tested without an Electron runtime.

/**
 * Resize a window's bounds while keeping it visually anchored: horizontal
 * centre and bottom edge stay put. Used when the user changes pet scale --
 * without this the pet jumps as its top-left corner stays fixed instead.
 */
export function resizedBoundsKeepingAnchor(bounds, newW, newH) {
  const cx = bounds.x + bounds.width / 2;
  const bottom = bounds.y + bounds.height;
  return {
    x: Math.round(cx - newW / 2),
    y: Math.round(bottom - newH),
    width: newW,
    height: newH,
  };
}

/**
 * Grow a window symmetrically in all four directions around the pet's
 * current centre, for the hover toolbar ring -- unlike growBoundsForBubble
 * (one side only) or the chat/todo panels (grows up, stays centred
 * horizontally), a ring of buttons needs room on every side of the sprite
 * at once while the sprite itself stays exactly where it was.
 */
export function growBoundsForRing(petRect, ringExtra) {
  return {
    x: petRect.x - ringExtra,
    y: petRect.y - ringExtra,
    width: petRect.width + ringExtra * 2,
    height: petRect.height + ringExtra * 2,
  };
}

/**
 * Where a drag-drop landed relative to the screen: side/top edges are a
 * perch (raven on a branch), the very bottom is a lie-down. Rects are
 * {x, y, width, height}; edgePx is how close counts as "at the edge".
 */
export function screenEdgeDropPose(petRect, workArea, edgePx) {
  const nearBottom = petRect.y + petRect.height >= workArea.y + workArea.height - edgePx;
  if (nearBottom) return 'lieDown';
  const nearLeft = petRect.x <= workArea.x + edgePx;
  const nearRight = petRect.x + petRect.width >= workArea.x + workArea.width - edgePx;
  const nearTop = petRect.y <= workArea.y + edgePx;
  if (nearLeft || nearRight || nearTop) return 'perch';
  return null;
}

/**
 * Where a drag-drop landed relative to some *other* app's window: resting
 * against its left/right side is a perch, resting on top of it (like a
 * little floor) is a lie-down. Mirrors screenEdgeDropPose's side/top vs.
 * top-as-floor split, just against a window instead of the screen.
 */
export function windowEdgeDropPose(petRect, winRect, edgePx) {
  const petLeft = petRect.x;
  const petRight = petRect.x + petRect.width;
  const petTop = petRect.y;
  const petBottom = petRect.y + petRect.height;
  const winLeft = winRect.x;
  const winRight = winRect.x + winRect.width;
  const winTop = winRect.y;
  const winBottom = winRect.y + winRect.height;

  const horizontalOverlap = petRight > winLeft - edgePx && petLeft < winRight + edgePx;
  const verticalOverlap = petBottom > winTop - edgePx && petTop < winBottom + edgePx;

  const nearTop = horizontalOverlap && Math.abs(petBottom - winTop) <= edgePx;
  if (nearTop) return 'lieDown';

  const nearLeft = Math.abs(petRight - winLeft) <= edgePx || Math.abs(petLeft - winLeft) <= edgePx;
  const nearRight = Math.abs(petLeft - winRight) <= edgePx || Math.abs(petRight - winRight) <= edgePx;
  if (verticalOverlap && (nearLeft || nearRight)) return 'perch';

  return null;
}

/**
 * Which side of the pet has room for a bubble of `neededSize` px, given the
 * pet's rect and the screen work area. Prefers top, then bottom, then
 * whichever of left/right has more room -- a bubble reads more naturally
 * above a character than beside it, so ties lean that way. Falls back to
 * whichever side has the *most* room (even if less than neededSize) when
 * nothing fits cleanly, rather than returning null and leaving the bubble
 * nowhere to go.
 */
export function pickBubbleSide(petRect, workArea, neededSize) {
  const spaceTop = petRect.y - workArea.y;
  const spaceBottom = workArea.y + workArea.height - (petRect.y + petRect.height);
  const spaceLeft = petRect.x - workArea.x;
  const spaceRight = workArea.x + workArea.width - (petRect.x + petRect.width);

  if (spaceTop >= neededSize) return 'top';
  if (spaceBottom >= neededSize) return 'bottom';
  if (spaceLeft >= neededSize && spaceLeft >= spaceRight) return 'left';
  if (spaceRight >= neededSize) return 'right';

  const best = Math.max(spaceTop, spaceBottom, spaceLeft, spaceRight);
  if (best === spaceTop) return 'top';
  if (best === spaceBottom) return 'bottom';
  return spaceLeft >= spaceRight ? 'left' : 'right';
}

/**
 * Grow a window's bounds to make room for a bubble on the given side,
 * keeping the pet's own sprite anchored at its current screen position --
 * the edge *opposite* the growth direction stays fixed, exactly like
 * resizedBoundsKeepingAnchor but generalised to any one of four sides
 * instead of always "keep centre+bottom".
 */
export function growBoundsForBubble(petRect, side, extra) {
  switch (side) {
    case 'top':
      return { x: petRect.x, y: petRect.y - extra, width: petRect.width, height: petRect.height + extra };
    case 'bottom':
      return { x: petRect.x, y: petRect.y, width: petRect.width, height: petRect.height + extra };
    case 'left':
      return { x: petRect.x - extra, y: petRect.y, width: petRect.width + extra, height: petRect.height };
    case 'right':
      return { x: petRect.x, y: petRect.y, width: petRect.width + extra, height: petRect.height };
    default:
      return { x: petRect.x, y: petRect.y, width: petRect.width, height: petRect.height };
  }
}

/**
 * Inverse of growBoundsForBubble: recover the pet's own rect from the
 * current (possibly already-grown) window bounds. Needed because the
 * bubble's required size changes continuously (status text updates, a tip
 * arrives/expires) -- without this, re-growing from the *already-grown*
 * bounds on every change would compound instead of resizing from the
 * pet's true, fixed sprite size each time.
 */
export function petRectFromGrownBounds(grownBounds, side, extra) {
  switch (side) {
    case 'top':
      return { x: grownBounds.x, y: grownBounds.y + extra, width: grownBounds.width, height: grownBounds.height - extra };
    case 'bottom':
      return { x: grownBounds.x, y: grownBounds.y, width: grownBounds.width, height: grownBounds.height - extra };
    case 'left':
      return { x: grownBounds.x + extra, y: grownBounds.y, width: grownBounds.width - extra, height: grownBounds.height };
    case 'right':
      return { x: grownBounds.x, y: grownBounds.y, width: grownBounds.width - extra, height: grownBounds.height };
    default:
      return { x: grownBounds.x, y: grownBounds.y, width: grownBounds.width, height: grownBounds.height };
  }
}
