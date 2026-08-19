import { HEAD_FRAME_COUNT } from './atlas.js';

export const HEAD_DEPTH = 280;
export const DEG_PER_FRAME = 360 / HEAD_FRAME_COUNT; // 22.5
export const HYSTERESIS_DEG = 8;
export const MAX_TILT_DEG = 5;
export const TILT_GAIN = 0.25;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const toDeg = (rad) => (rad * 180) / Math.PI;

// Horizontal only: rows 9/10 are a yaw sweep, there is no pitch art.
// dy is accepted so callers can pass a full delta, but only dx affects yaw.
//
// Two mappings:
//   depth model (fullTurnPx = 0) -- atan2 against a virtual eye depth. Natural,
//     but it saturates fast: with depth 280 the head is already near its limit
//     by ~260px and then ignores the cursor entirely.
//   linear (fullTurnPx > 0) -- yaw is proportional to horizontal distance and
//     hits 90 degrees exactly at fullTurnPx. Tracks the cursor across the whole
//     screen and actually uses all 16 frames.
export function yawToCursor(dx, _dy, fullTurnPx = 0) {
  if (fullTurnPx > 0) return clamp(dx / fullTurnPx, -1, 1) * 90;
  return clamp(toDeg(Math.atan2(dx, HEAD_DEPTH)), -90, 90);
}

/**
 * Extends yaw magnitude beyond the plain +/-90 turn when the cursor is below
 * the head, reaching into k=5..7 / k=9..11 -- frames that were previously
 * never selected at all. Those frames are not "back of head": the art bows
 * the head down and to the side as it turns, eyes downcast, so they read as
 * "looking down" once actually shown. There is no upward-tilt art anywhere
 * in the atlas, so dy < 0 (cursor above) intentionally does not extend past
 * the normal +/-90 turn -- only "below" has anywhere further to go.
 *
 * The vertical and horizontal contributions are combined with max(), not
 * addition: "how far below" alone can drive the magnitude all the way to
 * maxTotalDeg. An earlier version added a small downward bonus on top of the
 * horizontal magnitude, which meant reaching the deep-bow frames required
 * the cursor to be *both* far to the side *and* far below at once -- for the
 * common case of "mostly below, only slightly to a side" it never crossed
 * the 90-degree line into bow territory and just looked like an ordinary
 * turn. dx still decides which side to bow toward (via its sign); dy alone
 * decides how deep.
 */
export function extendedYawForCursor(dx, dy, opts = {}) {
  const { fullTurnPx = 0, lookDownPx = 0, maxTotalDeg = 150 } = opts;
  if (dy <= 0 || lookDownPx <= 0) return yawToCursor(dx, dy, fullTurnPx);

  const horizMag = fullTurnPx > 0 ? clamp(Math.abs(dx) / fullTurnPx, 0, 1) * 90 : 0;
  const downT = clamp(dy / lookDownPx, 0, 1);
  const vertMag = downT * maxTotalDeg;
  const mag = Math.min(Math.max(horizMag, vertMag), maxTotalDeg);
  const sign = dx !== 0 ? Math.sign(dx) : 1;
  return sign * mag;
}

export function smoothYaw(current, target, dt, tau) {
  if (dt <= 0) return current;
  return current + (target - current) * (1 - Math.exp(-dt / tau));
}

export function yawToFrame(yaw) {
  const wrapped = ((yaw % 360) + 360) % 360;
  return Math.round(wrapped / DEG_PER_FRAME) % HEAD_FRAME_COUNT;
}

// Shortest distance between two frame indices on the 16-frame ring.
function ringDistance(a, b) {
  const raw = Math.abs(a - b) % HEAD_FRAME_COUNT;
  return Math.min(raw, HEAD_FRAME_COUNT - raw);
}

export function pickFrame(prevFrame, yaw, hysteresisDeg = HYSTERESIS_DEG) {
  const target = yawToFrame(yaw);
  if (target === prevFrame) return prevFrame;
  // Damp single-frame jitter only; larger moves are real intent.
  if (hysteresisDeg > 0 && ringDistance(prevFrame, target) === 1) {
    if (angleGap(yaw, target * DEG_PER_FRAME) > hysteresisDeg) return prevFrame;
  }
  return target;
}

/** Smallest absolute angular distance between two headings, in degrees. */
export function angleGap(a, b) {
  let d = Math.abs((((a - b) % 360) + 360) % 360);
  if (d > 180) d = 360 - d;
  return d;
}

/**
 * Signed offset of the true yaw from the frame actually being shown, in
 * [-11.25, +11.25]. Frames land every 22.5 degrees, so without this the head
 * visibly steps between poses instead of tracking. Callers turn this into a
 * small continuous nudge that fills the gap.
 */
export function subFrameResidual(yaw, frame) {
  let d = (((yaw - frame * DEG_PER_FRAME) % 360) + 360) % 360;
  if (d > 180) d -= 360;
  return Math.max(-DEG_PER_FRAME / 2, Math.min(DEG_PER_FRAME / 2, d));
}

export function tiltFromCursor(dy) {
  return clamp(toDeg(Math.atan2(dy, HEAD_DEPTH)) * TILT_GAIN, -MAX_TILT_DEG, MAX_TILT_DEG);
}

export function isFollowing(dx, dy, radius) {
  return Math.hypot(dx, dy) <= radius;
}

/**
 * Gaze controller. Pure: no DOM, no timers -- the caller drives it with a
 * delta so it can be tested deterministically.
 *
 * The personality knobs live here:
 *   tau         how quickly the head catches up (low = alert, high = languid)
 *   deadzone    yaw below this keeps the idle animation instead of a turn frame
 *   radius      how far away a cursor still gets noticed
 *   attentionMs how long the gaze holds before losing interest (0 = never)
 *   reengageDist how far the cursor must move to win a lost gaze back
 */
export function createGaze({
  mode = 'frames',
  tau = 0.12,
  deadzone = 8,
  radius = 700,
  attentionMs = 0,
  reengageDist = 120,
  maxLeanPx = 0,
  hysteresis = HYSTERESIS_DEG,
  subFrameGain = 0,
  fullTurnPx = 0,
  lookDownPx = 0,
  maxTotalDeg = 150,
} = {}) {
  let yaw = 0;
  let frame = 0;
  let tilt = 0;
  let lean = 0;
  let followMs = 0;
  let aloof = false;
  let aloofAnchor = null;

  return {
    get yaw() {
      return yaw;
    },
    get frame() {
      return frame;
    },
    get tilt() {
      return tilt;
    },
    get lean() {
      return lean;
    },
    get mode() {
      return mode;
    },
    get aloof() {
      return aloof;
    },
    reset() {
      followMs = 0;
      aloof = false;
      aloofAnchor = null;
    },
    /**
     * @param dx,dy cursor delta from the head centre
     * @param dt seconds
     * @param enabled whether the current state permits looking at all
     * @returns {{ yaw, frame, tilt, engaged }} engaged = actively looking
     */
    update(dx, dy, dt, enabled) {
      const inRange = enabled && isFollowing(dx, dy, radius);

      if (!inRange) {
        followMs = 0;
        aloof = false;
        aloofAnchor = null;
      } else if (aloof) {
        // A big enough move re-earns attention.
        const moved = Math.hypot(dx - aloofAnchor.dx, dy - aloofAnchor.dy);
        if (moved >= reengageDist) {
          aloof = false;
          followMs = 0;
        }
      } else {
        followMs += dt * 1000;
        if (attentionMs > 0 && followMs >= attentionMs) {
          aloof = true;
          aloofAnchor = { dx, dy };
        }
      }

      const engaged = inRange && !aloof;
      const target = engaged
        ? extendedYawForCursor(dx, dy, { fullTurnPx, lookDownPx, maxTotalDeg })
        : 0;
      yaw = smoothYaw(yaw, target, dt, tau);
      frame = pickFrame(frame, yaw, hysteresis);
      tilt = engaged ? tiltFromCursor(dy) : smoothYaw(tilt, 0, dt, tau);

      const leanTarget = engaged ? clamp(dx / radius, -1, 1) * maxLeanPx : 0;
      lean = smoothYaw(lean, leanTarget, dt, tau);

      const showTurnFrame = mode === 'frames' && Math.abs(yaw) >= deadzone;
      // Fills the 22.5-degree gap between frames so the head tracks smoothly
      // instead of snapping from pose to pose.
      const residual = showTurnFrame ? subFrameResidual(yaw, frame) : 0;

      return {
        yaw,
        frame,
        tilt,
        lean,
        engaged,
        residual,
        subFrameTilt: residual * subFrameGain,
        showTurnFrame,
      };
    },
  };
}
