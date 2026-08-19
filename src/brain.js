import { ROWS } from './atlas.js';

export const STATES = Object.freeze({
  IDLE: 'IDLE',
  PERFORM: 'PERFORM',
  FILLER: 'FILLER',
  REST: 'REST',
  WANDER: 'WANDER',
  DRAG: 'DRAG',
  SPIN: 'SPIN',
});

export function allowsHeadFollow(state) {
  return state === STATES.IDLE;
}

/**
 * A behaviour profile is the pet's personality expressed as numbers. Row
 * meanings differ per pet even though the atlas geometry is shared -- e.g.
 * row 7 is Sebastian's closed-eye bow but Ciel serving tea -- so the rows
 * are part of the profile, not hardcoded.
 */
export const DEFAULT_PROFILE = Object.freeze({
  performRows: [ROWS.WAVING, ROWS.WAITING, ROWS.REVIEW, ROWS.JUMPING],
  restRow: ROWS.DOZE,
  fillerRow: ROWS.PECK,
  weights: { wander: 0.45, perform: 0.33, filler: 0.12, rest: 0.1 },
  idleDwellMs: [8000, 20000],
  performMs: 2600,
  fillerMs: 4000,
  restMs: 9000,
  spinMs: 1800,
  spinEnabled: false,
  spinIdleMs: 60000,
  spinChance: 0.03,
});

/**
 * Pure behaviour state machine. The caller drives it with a delta and a
 * context so it can be tested deterministically.
 *
 * ctx: { userIdleMs, cursorMoved, arrived }
 */
export function createBrain({ rng = Math.random, profile = {} } = {}) {
  const p = { ...DEFAULT_PROFILE, ...profile };
  const w = { ...DEFAULT_PROFILE.weights, ...(profile.weights ?? {}) };

  let state = STATES.IDLE;
  let elapsed = 0;
  let dwell = rollDwell();
  let performRow = p.performRows[0];
  // null means "use the profile's ordinary restRow" -- only set when the
  // caller forces REST for a specific pose (edge-perch, lie-down) rather
  // than letting choose() pick REST on its own.
  let restRowOverride = null;
  // A forced pose (edge-perch, lie-down) is entered right after the pet's
  // own window just moved a lot (wander arrival, drag release) -- the very
  // next cursorMoved reading is often a stale artefact of that motion, not
  // real mouse input, and would otherwise bounce straight back to IDLE
  // before the pose is ever seen. Ordinary REST (chosen by the idle state
  // machine while stationary) still wakes on the first real cursor move.
  let restIgnoresCursorMoved = false;

  function rollDwell() {
    const [lo, hi] = p.idleDwellMs;
    return lo + rng() * (hi - lo);
  }

  function enter(next, opts = {}) {
    state = next;
    elapsed = 0;
    if (next === STATES.IDLE) dwell = rollDwell();
    if (next === STATES.PERFORM) {
      performRow = Number.isInteger(opts.performRow)
        ? opts.performRow
        : p.performRows[Math.floor(rng() * p.performRows.length)];
    }
    if (next === STATES.REST) {
      restRowOverride = Number.isInteger(opts.restRow) ? opts.restRow : null;
      restIgnoresCursorMoved = !!opts.ignoreCursorMoved;
    }
  }

  function choose(ctx) {
    if (p.spinEnabled && (ctx.userIdleMs ?? 0) >= p.spinIdleMs && rng() < p.spinChance) {
      return STATES.SPIN;
    }
    // Both live user toggles, default true. randomActionsEnabled=false means
    // "no spontaneous themed poses" (perform/filler zeroed). wanderEnabled
    // is load-bearing, not cosmetic: main.js silently no-ops a wander-start
    // request while wandering is administratively disabled (paused, or
    // cfg.wander:false), so if this ever picked WANDER anyway the brain
    // would sit frozen mid-stride forever -- it would ask to move, be
    // ignored, and never receive the "arrived" event that lets it leave
    // WANDER. Excluding it from the roll here is what actually prevents
    // that, not anything on the main-process side.
    const randomActionsEnabled = ctx.randomActionsEnabled !== false;
    const wanderEnabled = ctx.wanderEnabled !== false;
    const performW = randomActionsEnabled ? w.perform : 0;
    const fillerW = randomActionsEnabled ? w.filler : 0;
    const wanderW = wanderEnabled ? w.wander : 0;
    // Normalise so the weights are readable as intent rather than cumulative
    // thresholds that must be kept in sync by hand.
    const total = wanderW + performW + fillerW + w.rest;
    if (total <= 0) return STATES.REST; // everything disabled -- just settle
    let roll = rng() * total;
    if ((roll -= wanderW) < 0) return STATES.WANDER;
    if ((roll -= performW) < 0) return STATES.PERFORM;
    if ((roll -= fillerW) < 0) return STATES.FILLER;
    return STATES.REST;
  }

  return {
    get state() {
      return state;
    },
    get profile() {
      return p;
    },
    currentRow({ movingRight = true } = {}) {
      switch (state) {
        case STATES.WANDER:
        case STATES.DRAG:
          return movingRight ? ROWS.RUN_RIGHT : ROWS.RUN_LEFT;
        case STATES.PERFORM:
          return performRow;
        case STATES.FILLER:
          return p.fillerRow;
        case STATES.REST:
          return restRowOverride ?? p.restRow;
        case STATES.SPIN:
          return ROWS.TURN_A;
        case STATES.IDLE:
        default:
          return ROWS.IDLE;
      }
    },
    forceState(next, opts) {
      enter(next, opts);
    },
    update(dtMs, ctx = {}) {
      const before = state;
      elapsed += dtMs;

      switch (state) {
        case STATES.DRAG:
          break; // left only via forceState
        case STATES.WANDER:
          if (ctx.arrived) enter(STATES.IDLE);
          break;
        case STATES.PERFORM:
          if (elapsed >= p.performMs) enter(STATES.IDLE);
          break;
        case STATES.FILLER:
          if (elapsed >= p.fillerMs) enter(STATES.IDLE);
          break;
        case STATES.REST:
          if ((ctx.cursorMoved && !restIgnoresCursorMoved) || elapsed >= p.restMs) enter(STATES.IDLE);
          break;
        case STATES.SPIN:
          if (elapsed >= p.spinMs) enter(STATES.IDLE);
          break;
        case STATES.IDLE:
        default:
          if (elapsed >= dwell) enter(choose(ctx));
          break;
      }

      return { state, changed: state !== before };
    },
  };
}
