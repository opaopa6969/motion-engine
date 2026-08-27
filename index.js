// motion-engine — procedural human-motion engine for VRM avatars.
//
// GOAL: synthesize *natural* body action WITHOUT motion capture. Instead of
// playing back fixed clips (which read as stiff/repetitive and can't adapt to
// the actual table), we generate the pose every frame from a few primitives
// that COMBINE:
//
//   JointSpring  second-order spring dynamics → ease / anticipation / settle /
//                overshoot come out for free. This is what kills the "sin-wave
//                mechanical" feel of hand-keyed motion.
//   NoiseIdle    layered incommensurate sines → breathing, weight shift, micro
//                drift. A resting body is alive and non-repeating, not frozen.
//   EmotionPose  the emotion layer's micro-pose hints, weighted by its envelope.
//   Action       a transient motion (Gesture now; Reach/IK + Gaze in Phase 2).
//
// All of these write into ONE per-bone target buffer that the engine springs
// toward; a VRMA clip, when one is playing, is just an alternative "clip layer"
// that owns the bones for its duration (the host renderer drives that). Every
// value is a target Euler [x,y,z] (radians) in the bone's local NORMALIZED VRM
// space.
//
// AN INDEPENDENT, RENDERER-AGNOSTIC ENGINE: NO three.js / VRM / DOM import.
// Inputs are numbers + plain-data commands; OUTPUT is a plain-data Pose
// ({ boneName: [x,y,z] }) the host renderer applies to the actual VRM bones.
// Deterministic (sin-based noise, no Math.random) so it runs headless and is
// unit-testable without a browser — see test.mjs.

// ----------------------------------------------------------- managed skeleton

// --------------------------------------------------------------- finger rig (v0.5)
//
// v0.5 adds the FINGERS so a hand can open, grip an object, hold it and let go —
// the missing half of "reach in, grab a tile, carry it out and place it". Finger
// flexion (curl toward the palm) is a single-axis rotation about local Z in the
// normalized VRM rig; the sign flips per hand. Thumb opposes across the palm, so
// it gets its own small blend. A VRM that lacks some finger bones simply has them
// dropped by the renderer (getNormalizedBoneNode → null), so listing the full
// VRM-1.0 set here is safe even for hands modeled with fewer joints.
const FINGER_DEFS = [
  ['Thumb', ['Metacarpal', 'Proximal', 'Distal']],          // thumb has no "Intermediate"
  ['Index', ['Proximal', 'Intermediate', 'Distal']],
  ['Middle', ['Proximal', 'Intermediate', 'Distal']],
  ['Ring', ['Proximal', 'Intermediate', 'Distal']],
  ['Little', ['Proximal', 'Intermediate', 'Distal']],
];
const FINGER_SIDES = ['left', 'right'];
// per-segment curl gain (× the grip amount): the middle knuckle flexes most in a
// fist, the fingertip least; the thumb metacarpal barely moves.
const FLEX = { Metacarpal: 0.5, Proximal: 0.9, Intermediate: 1.15, Distal: 0.7 };
// base curl sign per hand (about local Z). If a given rig curls the WRONG way,
// flip it globally via gripPose's opts.flexSign (the host's one knob) rather than
// touching these.
const FLEX_SIGN = { left: 1, right: -1 };

function _fingerBones() {
  const out = [];
  for (const side of FINGER_SIDES) {
    for (const [f, segs] of FINGER_DEFS) for (const s of segs) out.push(`${side}${f}${s}`);
  }
  return out;
}
export const FINGER_BONES = Object.freeze(_fingerBones());

/**
 * Finger pose for one hand at a given grip amount.
 *   curl  0 = open/straight, ~1 = firm grip (a flat tile sits in a ~0.9 curl;
 *         clenching past 1 is a fist). Non-thumb fingers flex about local Z;
 *         the thumb adds a small opposition (Y) so it closes ACROSS the palm.
 *   opts.flexSign  global ±1 flip if a rig's fingers bend backward (host knob).
 * Returns plain Euler-per-bone data {bone:[x,y,z]} the engine/host applies.
 */
export function gripPose(side, curl, opts = {}) {
  const fs = opts.flexSign != null ? opts.flexSign : 1;
  const s = fs * (FLEX_SIGN[side] || 1);
  const out = {};
  for (const [f, segs] of FINGER_DEFS) {
    if (f === 'Thumb') continue;
    for (const seg of segs) out[`${side}${f}${seg}`] = [0, 0, s * curl * FLEX[seg]];
  }
  // thumb: curls less and rolls in toward the palm to oppose the fingers
  out[`${side}ThumbMetacarpal`] = [0, -s * curl * 0.30, s * curl * 0.20];
  out[`${side}ThumbProximal`] = [0, -s * curl * 0.20, s * curl * 0.40];
  out[`${side}ThumbDistal`] = [0, 0, s * curl * 0.45];
  return out;
}

// The humanoid bones this framework drives. v0.2: shoulders (clavicle) and hands
// (wrist) join so the reach chain is shoulder→upperArm→lowerArm→hand — letting
// the shoulder roll/swing and the wrist aim/snap/twist independently of the
// elbow. v0.5: the finger bones join for grip. v0.12: 'neck' joins so the
// full-body RootAct pitch distribution (spine/chest/neck/head, ported from
// kamishibai's ROOT_ACTS) has somewhere to put its share — the standard VRM
// humanoid names this bone, so it's a safe addition. Bones a given VRM lacks
// (clavicle is OPTIONAL in VRM; some hands have fewer finger joints) are simply
// dropped by the renderer, so listing them here is safe.
export const MANAGED = Object.freeze([
  'spine', 'chest', 'neck', 'head',
  'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand',
  'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand',
  ...FINGER_BONES,
]);

// Relaxed resting pose — the single source of truth for the host's rest pose.
// Brings the A/T-pose arms down to the sides. Bones absent here rest at
// identity [0,0,0].
const REST_FINGER_CURL = 0.14;   // a relaxed hand rests with a faint curl, not a flat board
export const REST = Object.freeze({
  leftUpperArm: [0, 0, 1.2],
  rightUpperArm: [0, 0, -1.2],
  leftLowerArm: [0, -0.3, 0],
  rightLowerArm: [0, 0.3, 0],
  ...gripPose('left', REST_FINGER_CURL),
  ...gripPose('right', REST_FINGER_CURL),
});
const ZERO3 = [0, 0, 0];
const restOf = (bone) => REST[bone] || ZERO3;

// A suggested BodyProfile the host can feed into IK actions (spread into opts).
// v0.6 carries jointLimits: the elbow's interior-angle range in radians, so a
// reach stops short of hyperextension (~π) or an over-folded arm (~0). The host
// passes `elbow` from here into new Reach/Place/Pick(...). Purely opt-in.
export const DEFAULT_BODY = Object.freeze({
  elbow: Object.freeze([0.35, 2.95]),   // ≈20°..169°: never locked straight, never fully clenched
  shoulder: 2.0,                        // upper arm stays within ~115° of its rest direction
});

// Per-bone spring frequency: a lead→lag CHAIN. Proximal bones are stiff/fast,
// distal bones soft/slow, so when a target moves the motion ripples
// shoulder→upperArm→lowerArm→hand with overlap — the #1 read of mass/weight.
// Bones absent here use the default (2.4).
const SPRING_F = {
  leftShoulder: 3.0, rightShoulder: 3.0,
  leftUpperArm: 2.7, rightUpperArm: 2.7,
  leftLowerArm: 2.3, rightLowerArm: 2.3,
  leftHand: 1.9, rightHand: 1.9,
};
// fingers are light + quick — a crisp open/close that settles fast (snappier than
// the arm chain so the grip reads as a deliberate grab, not a slow droop).
for (const b of FINGER_BONES) SPRING_F[b] = 4.2;

// Bones smoothed in ORIENTATION space (QuatSpring) instead of per-Euler-axis.
// The arm chain is the one place multiple axes swing together under IK; a
// per-axis spring gimbals/couples there and reads as a jolt. Everything else
// (torso pitch, head drift, single-axis finger curl) is fine per-axis.
const QUAT_SMOOTH = new Set([
  'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand',
  'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand',
]);

// ------------------------------------------------------------- spring dynamics

/**
 * Second-order dynamics for one scalar (a bone-axis angle): tracks a moving
 * target with position + velocity so motion eases in, settles, and (if under-
 * damped) overshoots — the organic quality you'd otherwise need mocap for.
 *
 *   f     natural frequency (Hz-ish): higher = snappier
 *   zeta  damping ratio: 1 = critical (no overshoot), <1 = lively bounce
 *   r     response: 0 = none, >0 anticipates the target's motion, <0 = lazy
 *
 * Semi-implicit integration with a stability clamp on k2 so large frame gaps
 * (tab refocus) can't blow up.
 */
export class Spring {
  constructor(f = 2.4, zeta = 0.9, r = 0, x0 = 0) {
    this.setParams(f, zeta, r);
    this.x = x0;   // last input target
    this.y = x0;   // current output
    this.yd = 0;   // current output velocity
  }
  setParams(f, zeta, r) {
    const w = 2 * Math.PI * f;
    this.k1 = zeta / (Math.PI * f);
    this.k2 = 1 / (w * w);
    this.k3 = (r * zeta) / w;
  }
  update(dt, x) {
    if (!(dt > 0)) return this.y;
    const xd = (x - this.x) / dt;   // estimate target velocity
    this.x = x;
    // clamp k2 so the integrator stays stable when dt is large
    const k2 = Math.max(this.k2, 1.1 * ((dt * dt) / 4 + (dt * this.k1) / 2));
    this.y += dt * this.yd;
    this.yd += (dt * (x + this.k3 * xd - this.y - this.k1 * this.yd)) / k2;
    return this.y;
  }
  reset(x0) { this.x = this.y = x0; this.yd = 0; }
}

// ----------------------------------------------------------------- pose buffer

// Cheap organic noise: sum of incommensurate sines → smooth, non-repeating,
// no lib. `seed` decorrelates each channel so joints don't move in lockstep.
function noise(t, seed) {
  return (
    Math.sin(t * 0.91 + seed) * 0.6 +
    Math.sin(t * 1.73 + seed * 1.7) * 0.3 +
    Math.sin(t * 2.39 + seed * 2.3) * 0.1
  );
}

/**
 * The per-frame target accumulator. Actions write into it; the scheduler then
 * springs the live pose toward `get(bone)`. Two write modes:
 *   add(bone, [dx,dy,dz])  additive offset over the accumulated target (idle,
 *                          emotion, gestures — they LAYER, unlike the old code
 *                          which overwrote arms wholesale)
 *   set(bone, [x,y,z])     hard override, last writer wins (Phase 2 IK arms)
 *
 * v0.12 adds a small NON-bone accumulator, `root`: RootAct's whole-body
 * channels that aren't a bone rotation at all (root translation `y`/`z`, the
 * whole-body side lean `tilt`, and the `lookDown` bridge to the expression
 * system) land here instead of in the bone target map, additive across any
 * overlapping RootActs — exactly like `add()`, just not FK'd through a bone.
 */
class TargetBuffer {
  constructor() {
    this.t = Object.create(null);
    this.overridden = new Set();
    this.root = { y: 0, z: 0, tilt: 0, lookDown: 0 };
    // pre-seed one mutable 3-array per managed bone so reset()/base() never
    // allocate (the per-frame hot path writes into these in place).
    for (const b of MANAGED) this.t[b] = [0, 0, 0];
    this._keys = MANAGED;
  }
  reset() {
    // Reinitialize every managed bone's target to its REST value in place.
    // The old code did reset() (zero everything) THEN a separate for-loop of
    // base(b) over MANAGED — but base() immediately overwrote the zeros, so
    // the zero pass was pure waste. Folding base into reset cuts one full
    // 42-iteration loop from the per-frame hot path.
    const t = this.t;
    for (const b of this._keys) {
      const r = REST[b] || ZERO3;
      const a = t[b];
      a[0] = r[0]; a[1] = r[1]; a[2] = r[2];
    }
    this.overridden.clear();
    this.root.y = 0; this.root.z = 0; this.root.tilt = 0; this.root.lookDown = 0;
  }
  base(bone) {
    const r = restOf(bone);
    const a = this.t[bone];
    a[0] = r[0]; a[1] = r[1]; a[2] = r[2];
  }
  add(bone, d, w = 1) {
    const a = this.t[bone];
    if (this.overridden.has(bone)) return;   // an override won this bone
    a[0] += d[0] * w; a[1] += d[1] * w; a[2] += d[2] * w;
  }
  // scalar-arg variant: lets the always-on layers (NoiseIdle/EmotionPose) add
  // without allocating a [x,y,z] literal every frame. w defaults to 1.
  add3(bone, x, y, z, w = 1) {
    const a = this.t[bone];
    if (this.overridden.has(bone)) return;
    a[0] += x * w; a[1] += y * w; a[2] += z * w;
  }
  set(bone, e) { const a = this.t[bone]; a[0] = e[0]; a[1] = e[1]; a[2] = e[2]; this.overridden.add(bone); }
  get(bone) { return this.t[bone] || ZERO3; }
  addRoot(ch, v) { this.root[ch] += v; }
}

// ------------------------------------------------------------- built-in layers

// Always-on living rest: breathing on the torso, slow head drift, a faint
// shoulder weight-shift. Small amplitudes — the point is "not a statue", not
// visible swaying. Stateless (reads ctx.t + ctx.phase).
class NoiseIdle {
  apply(buf, ctx) {
    const t = ctx.t + ctx.phase;
    const breath = Math.sin(t * 1.5);                       // ~0.24 Hz
    buf.add3('spine', breath * 0.014, 0, 0);
    buf.add3('chest', breath * 0.012, 0, 0);
    buf.add3('head', noise(t, 1.3) * 0.03, noise(t, 4.1) * 0.07, noise(t, 7.7) * 0.04);
    buf.add3('leftUpperArm', 0, 0, noise(t, 2.2) * 0.03);
    buf.add3('rightUpperArm', 0, 0, -noise(t, 5.6) * 0.03);
  }
}

// The emotion layer's body language: PoseHint (headPitch/Yaw/Roll, chestLift,
// shoulder) → bone deltas, scaled by the emotion's live envelope weight.
class EmotionPose {
  apply(buf, ctx) {
    const p = ctx.pose || {};
    const w = ctx.poseW != null ? ctx.poseW : 1;
    if (!w) return;
    buf.add3('head', (p.headPitch || 0) * w, (p.headYaw || 0) * w, (p.headRoll || 0) * w);
    buf.add3('chest', (p.chestLift || 0) * w, 0, 0);
    if (p.shoulder) {
      buf.add3('leftUpperArm', 0, 0, p.shoulder * w);
      buf.add3('rightUpperArm', 0, 0, -p.shoulder * w);
    }
  }
}

// --------------------------------------------------------------------- actions

// One-shot named gestures, expressed as bone DELTAS over rest with a sin-bell
// envelope across `dur`. Identical reach amounts to the old _applyGesture, but
// now (a) they LAYER over idle + emotion instead of overwriting the arms, and
// (b) the scheduler's springs smooth the target so the motion eases instead of
// tracking a raw sine — markedly less mechanical, same choreography.
const GESTURES = {
  // reach to the wall, draw, set a tile down
  tsumogiri: (e) => ({ rightUpperArm: [-e * 1.05, 0, e * 0.45], rightLowerArm: [0, e * 0.25, 0] }),
  // right hand up to the SIDE of the head, scratching. The forearm folds on its
  // natural FLEXION axis (+z on the T-pose-normalized rig, toward the biceps);
  // the old -y fold swung the hand around BEHIND the back on a real rig, which
  // read as a backward-bending elbow whenever the idle self-action fired.
  // Numbers fitted by FK against a real VRM (hand lands ~7cm off the head side).
  headScratch: (e, p) => ({
    rightUpperArm: [0, 0, e * 1.95],
    rightLowerArm: [0, 0, e * 1.82 + Math.sin(p * Math.PI * 7) * 0.14 * e],
    head: [0, 0, -e * 0.08],                       // a small sympathetic tilt
  }),
  // thrust the right fist upward (joy)
  fistPump: (e) => ({ rightUpperArm: [-e * 0.25, 0, e * 1.95] }),
  // shoulders drawn in (disappointment / sigh)
  slump: (e) => ({ leftUpperArm: [0, 0, -e * 0.22], rightUpperArm: [0, 0, e * 0.22] }),

  // v0.3 ------------------------------------------------------------------
  // startle: torso + head snap BACK, arms lift to guard (surprise / のけぞる).
  // Tuned so gain 1 reads as a clear flinch and the host's upper gain (~1.7)
  // stays a natural recoil without the springs overshooting into a back-flip.
  // ctx.gain dials it per character (reserved ×0.4 … dramatic ×1.7).
  recoil: (e) => ({
    spine: [-e * 0.16, 0, 0], chest: [-e * 0.26, 0, 0], head: [-e * 0.36, 0, 0],
    leftUpperArm: [-e * 0.3, 0, -e * 0.18], rightUpperArm: [-e * 0.3, 0, e * 0.18],
    leftLowerArm: [0, -e * 0.22, 0], rightLowerArm: [0, e * 0.22, 0],
  }),
  // fold the forearms across the chest (skeptical / closed-off / 腕組み). Long
  // dwell in the middle of the bell reads as "arms stay crossed" for a beat.
  crossArms: (e) => ({
    leftUpperArm: [-e * 0.45, 0, -e * 0.55], rightUpperArm: [-e * 0.45, 0, e * 0.55],
    leftLowerArm: [0, -e * 1.4, 0], rightLowerArm: [0, e * 1.4, 0],
    chest: [e * 0.05, 0, 0],
  }),
  // a single agreement nod — head dips down and back (相槌 / 頷き)
  nod: (e) => ({ head: [e * 0.42, 0, 0] }),
  // a quick "dunno" shrug — shoulders ride up, palms turn out, head tucks
  shrug: (e) => ({
    leftShoulder: [0, 0, e * 0.42], rightShoulder: [0, 0, -e * 0.42],
    leftUpperArm: [0, 0, e * 0.2], rightUpperArm: [0, 0, -e * 0.2],
    head: [e * 0.1, 0, 0],
  }),
  // lean the torso forward INTO the table — interest / pressing the read (体幹リード)
  lean: (e) => ({ spine: [e * 0.2, 0, 0], chest: [e * 0.17, 0, 0], head: [-e * 0.05, 0, 0] }),
  // a knowing head tilt + roll — smirk body language (したり顔 / 首をかしげる)
  smirkTilt: (e) => ({ head: [-e * 0.05, e * 0.18, e * 0.3] }),
  // a heavy breath out: chest deflates, head dips, shoulders ease down (落胆のため息)
  sigh: (e) => ({ chest: [e * 0.14, 0, 0], spine: [e * 0.07, 0, 0], head: [e * 0.13, 0, 0], leftUpperArm: [0, 0, -e * 0.1], rightUpperArm: [0, 0, e * 0.1] }),
  // tension leaving the body — shoulders drop, chest softens (安堵の息抜き)
  exhale: (e) => ({ chest: [e * 0.07, 0, 0], leftUpperArm: [0, 0, -e * 0.14], rightUpperArm: [0, 0, e * 0.14], head: [e * 0.05, 0, 0] }),

  // (v0.11: the arm-bearing acts clap/gutsPose/banzai/fistToForehead/ponder
  // moved to ARM_ACTS — IK-driven, pole-guaranteed elbows. See ArmAct below.)
  // やれやれ — head down, slowly shaking side to side, shoulders drawn in
  headShakeRue: (e, p) => ({
    head: [e * 0.3, Math.sin(p * Math.PI * 4) * 0.24 * e, 0],
    chest: [e * 0.06, 0, 0],
    leftUpperArm: [0, 0, -e * 0.12], rightUpperArm: [0, 0, e * 0.12],
  }),
  // 長考の頬杖 — head tilts onto the right hand at the cheek, the left forearm
  // folds across the belly to cup the right elbow
  ponder: (e) => ({
    head: [e * 0.1, e * 0.08, e * 0.24],
    rightUpperArm: [e * 0.35, 0, e * 1.0], rightLowerArm: [0, 0, e * 1.92],
    leftUpperArm: [-e * 0.28, 0, -e * 0.12], leftLowerArm: [0, -e * 1.25, 0],
    chest: [e * 0.05, 0, 0],
  }),
};
export const GESTURE_DUR = Object.freeze({
  tsumogiri: 1.4, headScratch: 1.8, fistPump: 1.0, slump: 1.5,
  recoil: 0.9, crossArms: 1.8, nod: 1.0, shrug: 1.2, lean: 1.5, smirkTilt: 1.4,
  sigh: 1.6, exhale: 1.4,
  // Compatibility metadata only: these four callbacks moved to ARM_ACTS in
  // v0.11. GESTURE_DUR is public, so keep its existing keys; they do not make
  // the names executable by Gesture. headShakeRue/ponder remain real gestures.
  clap: 2.0, gutsPose: 1.8, banzai: 1.6, fistToForehead: 2.3, headShakeRue: 2.2, ponder: 3.6,
});

// Anticipation + follow-through envelope for a one-shot swing. A real body
// GATHERS before it acts and OVERSHOOTS before it settles — the two animation
// principles the raw sin-bell (ease straight in, straight out) lacks, and the
// #1 thing that reads as "mechanical" when absent. Shape over p∈(0,1):
//   0 →(windup, opposite dir)→ −anticipate →(main swing)→ +1 →(settle)→ −overshoot → 0
// `windup`/`follow` are the fractions of the action's life spent gathering /
// following through; `anticipate`/`overshoot` are their depths. All tunable so
// later the SAME primitive dials from realistic (small) to anime-exaggerated
// (big). Pass {windup:0} to get the plain bell back.
const SWING_DEFAULTS = { windup: 0.15, follow: 0.14, anticipate: 0.18, overshoot: 0.12 };
export function swingEnv(p, opts) {
  const o = opts || SWING_DEFAULTS;
  const A = o.windup != null ? o.windup : SWING_DEFAULTS.windup;
  const B = o.follow != null ? o.follow : SWING_DEFAULTS.follow;
  const ant = o.anticipate != null ? o.anticipate : SWING_DEFAULTS.anticipate;
  const over = o.overshoot != null ? o.overshoot : SWING_DEFAULTS.overshoot;
  if (p <= 0 || p >= 1) return 0;
  if (A > 0 && p < A) return -ant * Math.sin((p / A) * Math.PI);                 // gather back
  if (B > 0 && p > 1 - B) return -over * Math.sin(((p - (1 - B)) / B) * Math.PI); // settle past rest
  const q = (p - A) / (1 - A - B || 1e-6);                                        // main swing
  return Math.sin(q * Math.PI);
}

// Per-gesture swing-envelope defaults. The generic windup/overshoot swings a
// gesture NEGATIVE of its delta — fine for sways and nods, but a gesture whose
// delta is elbow FLEXION would anticipate by HYPEREXTENDING the joint (逆反り).
// Flexion-dominant gestures opt out of the negative phases here; a caller's
// explicit `env` still wins.
const GESTURE_ENV = {
  headScratch: { windup: 0, anticipate: 0, follow: 0.1, overshoot: 0.04 },
  crossArms: { anticipate: 0.08, overshoot: 0.05 },   // folded forearms: keep the reverse sway subtle
  // Compatibility metadata for names moved to ARM_ACTS in v0.11. Gesture has
  // no callback for these four names and remains a no-op, but existing
  // constructed instances keep exposing their historical `env` values.
  // The v0.10 acting set is flexion-heavy — no negative phases (no 逆反り).
  clap: { windup: 0, anticipate: 0, follow: 0.1, overshoot: 0.04 },
  gutsPose: { windup: 0, anticipate: 0, follow: 0.12, overshoot: 0.05 },
  banzai: { windup: 0.1, anticipate: 0.08, follow: 0.12, overshoot: 0.05 },  // a small crouch before the throw reads well
  fistToForehead: { windup: 0, anticipate: 0, follow: 0.1, overshoot: 0.03 },
  ponder: { windup: 0, anticipate: 0, follow: 0.08, overshoot: 0.02 },
};

// ------------------------------------------------------------- arm acts (v0.11)
//
// ACTING BY INTENT, not by joint angles. Euler-delta gestures broke down for
// arms — multi-axis coordination through a raw retarget is unauthorable (a
// "clap" fitted on hand position alone met the hands via BACKWARD-BENT elbows,
// because nothing constrained the hinge). ArmAct drives the arms through the
// same machinery as Reach/Place: a HAND TARGET + a POLE (where the elbow
// points — anatomically guaranteed by the solver) + a wrist orientation + a
// finger curl. Targets are rig-independent: UNITS OF ARM LENGTH from the
// shoulder, along a host-measured BASIS {out, up, front} (unit vectors in the
// upper-arm parent-local frame; out = away from the body on that arm's side).
// The host measures geo once; the spec says WHAT the pose is, IK does the joints.
//
//   geo.right/left = { pU, pL, pH, restU, restL, restW?, flexSign?,
//                      basis: { out:[..], up:[..], front:[..] } }
export const ARM_ACTS = {
  // 拍手 — palms meet in front of the chest, tapping together on a beat
  clap: {
    dur: 2.0, env: { windup: 0, anticipate: 0, follow: 0.1, overshoot: 0.04 },
    bones: (e) => ({ head: [e * 0.06, 0, 0], chest: [e * 0.05, 0, 0] }),
    right: (e, p) => ({ at: [-0.04 - Math.max(0, Math.sin(p * Math.PI * 6)) * 0.05, -0.12, 0.5], pole: [0.5, -1, 0.15], curl: 0.1 }),
    left: (e, p) => ({ at: [-0.04 - Math.max(0, Math.sin(p * Math.PI * 6)) * 0.05, -0.12, 0.5], pole: [0.5, -1, 0.15], curl: 0.1 }),
  },
  // ガッツポーズ — the cinema-celebration meme: both fists pumped up beside the
  // head, elbows out, chest/head thrown back, a tight victorious shake
  gutsPose: {
    dur: 1.8, env: { windup: 0.08, anticipate: 0.1, follow: 0.12, overshoot: 0.05 },
    bones: (e) => ({ chest: [-e * 0.16, 0, 0], head: [-e * 0.2, 0, 0], spine: [-e * 0.06, 0, 0] }),
    right: (e, p) => ({ at: [0.38, 0.44 + Math.sin(p * Math.PI * 7) * 0.05, 0.22], pole: [1, -0.5, 0], curl: 0.85 }),
    left: (e, p) => ({ at: [0.38, 0.44 + Math.sin(p * Math.PI * 7) * 0.05, 0.22], pole: [1, -0.5, 0], curl: 0.85 }),
  },
  // 万歳 — both arms thrown high (IK has no axis clamp: FULL range), chin up
  banzai: {
    dur: 1.6, env: { windup: 0.12, anticipate: 0.12, follow: 0.12, overshoot: 0.06 },
    bones: (e) => ({ head: [-e * 0.22, 0, 0], chest: [-e * 0.1, 0, 0] }),
    right: (e) => ({ at: [0.25, 0.9, 0.18], pole: [1, -0.15, 0], curl: 0.15 }),
    left: (e) => ({ at: [0.25, 0.9, 0.18], pole: [1, -0.15, 0], curl: 0.15 }),
  },
  // 放銃の悔しさ — head drops, the right FIST comes up to the forehead
  fistToForehead: {
    dur: 2.3, env: { windup: 0, anticipate: 0, follow: 0.1, overshoot: 0.03 },
    bones: (e) => ({ head: [e * 0.4, 0, 0], spine: [e * 0.08, 0, 0], chest: [e * 0.09, 0, 0] }),
    right: (e) => ({ at: [-0.02, 0.22, 0.3], pole: [1, -0.55, 0], curl: 0.85, wrist: [0, 0, -0.5] }),
  },
  // 長考の頬杖 — head tilts onto the right hand at the cheek; the left forearm
  // folds across the belly, palm under the right elbow
  ponder: {
    dur: 3.6, env: { windup: 0, anticipate: 0, follow: 0.08, overshoot: 0.02 },
    bones: (e) => ({ head: [e * 0.1, e * 0.08, e * 0.24], chest: [e * 0.05, 0, 0] }),
    right: (e) => ({ at: [-0.06, 0.26, 0.2], pole: [1, -0.7, 0], curl: 0.3 }),
    left: (e) => ({ at: [-0.3, -0.12, 0.3], pole: [1, -0.9, 0], curl: 0.25 }),
  },

  // ---- v0.12: upstreamed 1:1 from kamishibai tools/vrm/arm-acts-extra.js
  // (read-only source; not modified there). That file self-documented as
  // "vendored motion-engine untouched, injected into ARM_ACTS at runtime via
  // Object.assign" — i.e. it was always meant to land here. Same coordinate
  // convention as the acts above (at = [out+, up+, front+], chest-basis
  // meters), same struct (dur/env/bones(e)/right,left(e,p) → {at,pole,curl}).
  // Teacher info preserved from the source: 演技指導 v3〜v5, バトルポーズ集
  // (battl1/gurdo), CMU mocap 111_37 for wave frequency.

  // 両手を頬に (ほくほく/泣き) — hands cupping both cheeks
  cheekHands: {
    dur: 2.6, env: { windup: 0.1, anticipate: 0.05, follow: 0.12, overshoot: 0.03 },
    bones: (e) => ({ head: [e * 0.08, 0, 0] }),
    right: (e) => ({ at: [0.10, 0.30, 0.26], pole: [1, -0.6, 0], curl: 0.25 }),
    left: (e) => ({ at: [0.10, 0.30, 0.26], pole: [1, -0.6, 0], curl: 0.25 }),
  },
  // 両手で顔を覆う (大泣き/照れ隠し/混乱)
  coverFace: {
    dur: 2.8, env: { windup: 0.1, anticipate: 0.08, follow: 0.12, overshoot: 0.03 },
    bones: (e) => ({ head: [e * 0.18, 0, 0], chest: [e * 0.05, 0, 0] }),
    right: (e) => ({ at: [0.02, 0.34, 0.30], pole: [1, -0.5, 0], curl: 0.2 }),
    left: (e) => ({ at: [0.02, 0.34, 0.30], pole: [1, -0.5, 0], curl: 0.2 }),
  },
  // 喉元に手 (ごくり/泣きそう)
  throatHand: {
    dur: 1.8, env: { windup: 0.08, anticipate: 0.05, follow: 0.12, overshoot: 0.02 },
    bones: (e) => ({ head: [e * 0.1, 0, 0] }),
    right: (e) => ({ at: [0.0, 0.14, 0.28], pole: [1, -0.6, 0], curl: 0.45 }),
  },
  // 手招き (早く早く)
  beckon: {
    dur: 1.6, env: { windup: 0.08, anticipate: 0.08, follow: 0.1, overshoot: 0.04 },
    bones: (e) => ({ head: [-e * 0.05, 0, 0] }),
    right: (e, p) => ({
      at: [0.18, 0.20, 0.42 - Math.max(0, Math.sin(p * Math.PI * 5)) * 0.10],
      pole: [1, -0.5, 0], curl: 0.3,
    }),
  },
  // 敬礼
  salute: {
    dur: 1.7, env: { windup: 0.1, anticipate: 0.1, follow: 0.1, overshoot: 0.04 },
    bones: (e) => ({ chest: [-e * 0.06, 0, 0], head: [-e * 0.05, 0, 0] }),
    right: (e) => ({ at: [0.13, 0.50, 0.16], pole: [1, -0.15, 0], curl: 0.15, wrist: [0, 0, -0.4] }),
  },
  // 手を振る (ばいばい/おーい)。周波数 ≈2Hz は CMU 111_37(実測の手振り)から採取。
  // 両手を上げて振る — 片手だと画面端のキャラは腕がフレーム外に出るため両手に
  waveHand: {
    dur: 2.4, env: { windup: 0.1, anticipate: 0.08, follow: 0.14, overshoot: 0.05 },
    bones: (e, p) => ({ head: [-e * 0.05, 0, e * 0.06], chest: [0, 0, e * Math.sin(p * Math.PI * 9) * 0.02] }),
    right: (e, p) => ({
      at: [0.22 + Math.sin(p * Math.PI * 9) * 0.16, 0.60, 0.20],
      pole: [1, -0.2, 0], curl: 0.08,
    }),
    left: (e, p) => ({
      at: [0.22 - Math.sin(p * Math.PI * 9) * 0.16, 0.60, 0.20],
      pole: [1, -0.2, 0], curl: 0.08,
    }),
  },
  // 片手を挙げる (質問/ひらめき/OK)
  raiseHand: {
    dur: 1.6, env: { windup: 0.1, anticipate: 0.1, follow: 0.12, overshoot: 0.05 },
    bones: (e) => ({ chest: [-e * 0.05, 0, 0], head: [-e * 0.08, 0, 0] }),
    right: (e) => ({ at: [0.24, 0.82, 0.15], pole: [1, -0.15, 0], curl: 0.15 }),
  },
  // 胸に手 (じーん/決意)
  chestHand: {
    dur: 2.4, env: { windup: 0.1, anticipate: 0.05, follow: 0.12, overshoot: 0.02 },
    bones: (e) => ({ head: [e * 0.12, 0, 0] }),
    right: (e) => ({ at: [-0.04, 0.10, 0.24], pole: [1, -0.6, 0], curl: 0.35 }),
  },
  // 両手を下腹の前で重ねる (丁寧なお辞儀の正式な手位置。やじろべえ回避)
  handsFolded: {
    dur: 3.4, env: { windup: 0.12, anticipate: 0.04, follow: 0.15, overshoot: 0.02 },
    right: (e) => ({ at: [-0.02, -0.16, 0.20], pole: [0.6, -1, 0.25], curl: 0.25 }),
    left: (e) => ({ at: [-0.02, -0.16, 0.235], pole: [0.6, -1, 0.25], curl: 0.25 }),   // 手前に重ねる
  },
  // 寒さ: 脇を閉めて両手を胸の前で合わせる「祈り」の形(演技指導v5)。肘を体側に
  // 絞る=こわばり。チビ体型でも破綻しない近距離ターゲット(体型ロバスト性の意図)
  armsColdClench: {
    dur: 4.0, env: { windup: 0.12, anticipate: 0.05, follow: 0.15, overshoot: 0.02 },
    bones: (e) => ({ head: [e * 0.06, 0, 0] }),
    right: (e) => ({ at: [0.07, 0.06, 0.20], pole: [0.15, -1, 0.05], curl: 0.7 }),
    left: (e) => ({ at: [0.07, 0.06, 0.225], pole: [0.15, -1, 0.05], curl: 0.7 }),
  },
  // 右手を腰に (しなを作る・どや等の土台)
  handOnHip: {
    dur: 4.0, env: { windup: 0.12, anticipate: 0.06, follow: 0.15, overshoot: 0.03 },
    right: (e) => ({ at: [0.15, -0.30, 0.06], pole: [1, 0.0, 0.1], curl: 0.45 }),   // 手は腰骨へ・肘は緩く横に張る
  },
  // ファイティングポーズ (バトルポーズ集 battl1 準拠: 両拳を顔の横に)
  fightFists: {
    dur: 3.0, env: { windup: 0.14, anticipate: 0.12, follow: 0.12, overshoot: 0.06 },
    bones: (e) => ({ chest: [-e * 0.05, 0, 0], head: [-e * 0.04, 0, 0] }),
    right: (e) => ({ at: [0.16, 0.30, 0.28], pole: [1, -0.4, 0], curl: 0.95 }),
    left: (e) => ({ at: [0.16, 0.30, 0.28], pole: [1, -0.4, 0], curl: 0.95 }),
  },
  // ガード (バトルポーズ集 gurdo 準拠: 利き拳を顔の前、逆拳を胸前)
  guardFists: {
    dur: 2.6, env: { windup: 0.10, anticipate: 0.10, follow: 0.12, overshoot: 0.04 },
    bones: (e) => ({ chest: [e * 0.04, 0, 0] }),
    right: (e) => ({ at: [0.03, 0.30, 0.32], pole: [1, -0.4, 0], curl: 0.95 }),
    left: (e) => ({ at: [0.06, 0.10, 0.28], pole: [0.8, -0.7, 0.2], curl: 0.95 }),
  },
  // スクリーンを指差す (あれ見て)
  pointScreen: {
    dur: 2.0, env: { windup: 0.12, anticipate: 0.1, follow: 0.1, overshoot: 0.05 },
    bones: (e) => ({ head: [-e * 0.1, 0, 0], chest: [-e * 0.04, 0, 0] }),
    right: (e) => ({ at: [0.12, 0.55, 0.45], pole: [1, -0.2, 0], curl: 0.7 }),
  },
};
Object.freeze(ARM_ACTS);

export class ArmAct {
  /**
   * @param name  key into ARM_ACTS
   * @param geo   { right?, left? } — per-side rig geometry incl. basis (host-measured)
   * @param dur   optional duration override
   */
  constructor(name, geo, dur) {
    this.name = name;
    this.spec = ARM_ACTS[name];
    this.geo = geo || {};
    this.dur = dur || (this.spec && this.spec.dur) || 1.5;
    this.t = 0;
    this.done = !this.spec;
    this._prep = {};
    for (const side of ['right', 'left']) {
      const g = this.geo[side];
      if (!g || !this.spec || !this.spec[side]) continue;
      const L = vlen(g.pL) + vlen(g.pH);
      this._prep[side] = {
        g, L,
        restU: qFromEulerXYZ(g.restU), restL: qFromEulerXYZ(g.restL),
        restW: qFromEulerXYZ(g.restW || ZERO3),
        up: side === 'left' ? 'leftUpperArm' : 'rightUpperArm',
        lo: side === 'left' ? 'leftLowerArm' : 'rightLowerArm',
        wr: side === 'left' ? 'leftHand' : 'rightHand',
      };
    }
  }
  _vec(g, c) {                                    // basis combo → parent-local vector
    const B = g.basis;
    return [
      c[0] * B.out[0] + c[1] * B.up[0] + c[2] * B.front[0],
      c[0] * B.out[1] + c[1] * B.up[1] + c[2] * B.front[1],
      c[0] * B.out[2] + c[1] * B.up[2] + c[2] * B.front[2],
    ];
  }
  apply(buf, ctx) {
    if (this.done) return;
    this.t += ctx.dt;
    const p = this.t / this.dur;
    if (p >= 1) { this.done = true; return; }
    const e = swingEnv(p, this.spec.env);
    const w = clamp(Math.abs(e), 0, 1);           // rest→IK engagement
    if (this.spec.bones) {
      const d = this.spec.bones(e, p);
      const gs = ctx.gain != null ? Math.max(0.2, Math.min(2.5, ctx.gain)) : 1;
      for (const b in d) buf.add(b, [clamp(d[b][0] * gs, -2.9, 2.9), clamp(d[b][1] * gs, -2.9, 2.9), clamp(d[b][2] * gs, -2.9, 2.9)]);
    }
    for (const side of ['right', 'left']) {
      const pr = this._prep[side];
      if (!pr) continue;
      const s = this.spec[side](e, p);
      const g = pr.g;
      const off = this._vec(g, [s.at[0] * pr.L, s.at[1] * pr.L, s.at[2] * pr.L]);
      const target = [g.pU[0] + off[0], g.pU[1] + off[1], g.pU[2] + off[2]];
      const pole = this._vec(g, s.pole || [0.5, -1, 0]);
      const sol = solveTwoBone(g.pU, g.pL, g.pH, pr.restU, pr.restL, target, { pole });
      buf.set(pr.up, qToEulerXYZ(qSlerp(pr.restU, sol.upperQ, w)));
      buf.set(pr.lo, qToEulerXYZ(qSlerp(pr.restL, sol.lowerQ, w)));
      if (s.wrist) buf.set(pr.wr, qToEulerXYZ(qSlerp(pr.restW, qMul(qFromEulerXYZ(s.wrist), pr.restW), w)));
      if (s.curl != null) {
        const gp = gripPose(side, REST_FINGER_CURL + s.curl * w * 0.8, { flexSign: g.flexSign });
        for (const b in gp) buf.set(b, gp[b]);
      }
    }
  }
}

export class Gesture {
  constructor(name, dur, env) {
    this.name = name;
    this.dur = dur || GESTURE_DUR[name] || 1.0;
    this.fn = GESTURES[name];
    this.env = env || GESTURE_ENV[name];             // anticipation/follow tuning (undefined = defaults)
    this.t = 0;
    this.done = !this.fn;
  }
  apply(buf, ctx) {
    if (this.done) return;
    this.t += ctx.dt;
    const p = this.t / this.dur;
    if (p >= 1) { this.done = true; return; }
    const e = swingEnv(p, this.env);   // windup → swing → follow-through
    const d = this.fn(e, p);
    // ctx.gain (v0.4) = how BIG this body reacts (大袈裟さ). The host feeds a
    // per-avatar expressiveness here so a reserved character barely flinches and
    // a dramatic one recoils hard — the same gesture, different personality.
    // Each scaled axis is clamped to a sane joint range (±2 rad) so gain can't
    // blow a big gesture (a full fistPump is ~1.95) past anatomy into a spring
    // explosion. Small gestures (recoil/nod) scale freely; big ones just cap.
    const g = ctx.gain != null ? Math.max(0.2, Math.min(2.5, ctx.gain)) : 1;
    for (const b in d) buf.add(b, [clamp(d[b][0] * g, -2, 2), clamp(d[b][1] * g, -2, 2), clamp(d[b][2] * g, -2, 2)]);
  }
}

// -------------------------------------------------------------- root acts (v0.12)
//
// FULL-BODY-IFICATION. Everything above (idle/emotion/Gesture/ArmAct) is upper-
// body: it never moves the character in the world or bends the spine. The
// "acting" that made scenes read as PERFORMED — jump/crouch/kneel/collapse,
// backstep, ずっこけ, the whole お辞儀(bow) family, しな, どうしよう/nodOff — lived
// entirely in the kamishibai HOST (tools/vrm/host.html's ROOT_ACTS), because it
// needed root translation + spine bend, which motion-engine didn't drive. This
// upstreams that vocabulary as a proper L2 primitive: a RootAct is just like a
// Gesture/ArmAct (queue it with `engine.play`, it's a bone-delta layer + a
// non-bone `root` layer, both spring-free since the shape is already baked into
// `f(p)` by `rhf`), so root/trunk acting composes with everything else instead
// of living beside it.
//
// CHANNELS ( = the return shape of a ROOT_ACTS entry's `f(p)` ):
//   y, z      root TRANSLATION (up, forward/back) — not a bone; consumed via
//             the Pose's separate `root` key (see MotionEngine.update), so a
//             host applies it to the avatar's whole-body transform.
//   yaw       head yaw (bone: `head`), e.g. a double-take shake.
//   pitch     TRUNK forward bend, distributed spine/chest/neck/head (0.35 /
//             0.30 / 0.20 / 0.15 — the CMU-calibrated split below) so the back
//             visibly rounds instead of just the head nodding.
//   tilt      whole-body SIDE lean/roll — not a bone; via Pose.root.tilt (a
//             host applies it to the avatar root, e.g. scene.rotation.z).
//   sh        shoulders drawn up symmetrically (肩すぼめ): bones
//             `leftShoulder`/`rightShoulder`.
//   hp        an EXTRA pitch on `head` alone, layered on top of `pitch`
//             (e.g. bowInsolent's chin-up-then-snap-down beat).
//   cr        chest ROLL (bone: `chest`, z-axis) — the しな(contrapposto) S-curve.
//   hr        head ROLL (bone: `head`, z-axis) — the counter-twist of しな.
//   lookDown  a bridge value (0..1), not a bone: the host feeds it to the VRM
//             standard expression `lookDown` (黒目を下げる) — via Pose.root.
//
// SIGN CONVENTION: `pitch`/`hp` are always POSITIVE = forward bend, and RootAct
// applies them to spine/chest/neck/head UNFLIPPED — this already matches
// motion-engine's own existing convention (compare Gesture `lean`, which also
// uses +spine/+chest for "lean forward"). kamishibai's host.html separately
// multiplies by a `BOW_SIGN = -1` before writing the bone — that is a quirk of
// ITS OWN pipeline (empirically measured 2026-07-12: its physics chain,
// xpbd-body, flips the sign somewhere between target-pose and applied-pose), NOT
// a motion-engine convention. Any host whose own rig/pipeline needs an
// equivalent correction applies it in ITS application layer, the same way
// kamishibai does — motion-engine's contract is just "pitch positive = the
// avatar bends forward, uninverted, in this engine's own Euler output."
//
// `cr`/`hr` are similarly UNMIRRORED here (kamishibai additionally flips them by
// the character's screen-seat side, `ch.x < 0 ? 1 : -1` — a staging decision
// that belongs to the host, not this engine).
//
// cam/noLook/pip metadata (kamishibai: camera pull-back during a deep bow/crouch,
// suppress eye-tracking during a bow, cut to a reaction inset) are NOT motion —
// they're kept as plain data on the ROOT_ACTS entry (and mirrored onto the
// RootAct instance) for a downstream camera/expression layer (kamishibai's own
// host, camera-engine, engi-engine) to read and interpret. motion-engine itself
// never looks at them.

// "rise-hold-fall": p∈[0,1] → an envelope that ramps 0→1 over the first `rise`
// fraction, holds at 1, then ramps back 1→0 over the last `fall` fraction. This
// is the one shaping primitive nearly every ROOT_ACTS entry calls internally
// (with its own rise/fall) instead of using swingEnv — root acting is about
// WEIGHT (a slow settle into a crouch, a held bow) more than about spring-like
// anticipation/overshoot, so a plain trapezoid reads truer here.
export function rhf(p, rise, fall) {
  if (p < rise) return rise > 0 ? p / rise : 1;
  if (p > 1 - fall) return fall > 0 ? Math.max(0, (1 - p) / fall) : 0;
  return 1;
}

// ROOT_ACTS vocabulary, ported 1:1 from kamishibai tools/vrm/host.html (read-
// only source; not modified). Each entry: { dur, cam?, noLook?, pip?, f(p) }.
export const ROOT_ACTS = {
  jump: { dur: 0.9, f: (p) => ({ y: Math.abs(Math.sin(p * Math.PI * 2)) * 0.14 }) },
  hop: { dur: 0.55, f: (p) => ({ y: Math.sin(Math.min(1, p) * Math.PI) * 0.20 }) },
  stomp: { dur: 1.3, f: (p) => ({ y: -Math.abs(Math.sin(p * Math.PI * 4)) * 0.05 }) },
  // cam:'pull' = a deep crouch/kneel/collapse pushes the head out of frame; the
  // host pulls the camera back + looks down slightly while it plays, then eases
  // back to the normal composition when it's done (user acting direction).
  crouch: { dur: 3.2, cam: 'pull', f: (p) => { const e = rhf(p, 0.18, 0.22); return { y: -0.38 * e, pitch: 0.45 * e }; } },
  kneel: { dur: 3.2, cam: 'pull', f: (p) => { const e = rhf(p, 0.25, 0.25); return { y: -0.50 * e, pitch: 0.30 * e }; } },
  collapse: { dur: 2.8, cam: 'pull', f: (p) => { const e = rhf(p, 0.15, 0.30); return { y: -0.42 * e, z: -0.15 * e, pitch: -0.25 * e }; } },
  backstep: { dur: 0.9, f: (p) => { const e = rhf(p, 0.3, 0.3); return { z: -0.14 * e }; } },
  zukkoke: { dur: 1.1, f: (p) => { const e = rhf(p, 0.2, 0.35); return { tilt: 0.40 * e, y: -0.08 * e }; } },
  zukkokeLite: { dur: 0.9, f: (p) => { const e = rhf(p, 0.2, 0.4); return { tilt: 0.22 * e }; } },
  // ---- お辞儀(bow) family (演技指導/user acting-direction feedback baked in) ----
  // pitch = trunk forward bend, distributed spine/chest/neck/head below (the back
  // visibly rounds); hp = an EXTRA pitch on the head alone; sh = shoulders drawn
  // up (肩をすぼめる). noLook = suppress eye-tracking while bowing (otherwise the
  // head gets pulled back toward the look target mid-bend, reading as "bent
  // forward but the face stays up" — wrong). The asymmetric down-fast/up-slow
  // (or down-slow/up-fast, per act) envelopes are CMU mocap-calibrated: a real
  // polite bow (CMU 111_02 / 113_02) goes down slowly (≈1.7s), holds (≈0.6s),
  // and comes back up faster.
  bow: { dur: 1.6, noLook: true, f: (p) => { const e = rhf(p, 0.40, 0.35); return { pitch: 0.26 * e }; } },
  bowDeep: {
    dur: 3.2, cam: 'pull', noLook: true,
    f: (p) => { const e = rhf(p, 0.50, 0.30); return { pitch: 1.5 * e, y: -0.05 * e, sh: 0.12 * e }; },
  },
  // ぺこっ (quick + shallow)
  bowQuick: { dur: 0.9, noLook: true, f: (p) => { const e = rhf(p, 0.18, 0.32); return { pitch: 0.44 * e, hp: 0.1 * e }; } },
  // 「謝ればいいんでしょ?」(user acting direction v3): chin lifts + eyes look down
  // (lookDown) in a defiant half-glance → holds (溜め) → snaps the head down in
  // one beat → springs right back up. The spine stays straight; it's all head.
  // `pip` marks it as a candidate for a reaction picture-in-picture cutaway.
  bowInsolent: {
    dur: 3.2, noLook: true, pip: true,
    f: (p) => {
      if (p < 0.38) {                                    // chin up + look down + hold
        const e = rhf(p / 0.38, 0.3, 0.02);
        return { hp: -0.16 * e, lookDown: 0.9 * e };
      }
      const q = (p - 0.38) / 0.62, e = rhf(q, 0.14, 0.42);  // snap down → spring back
      return { pitch: 0.22 * e, hp: 0.36 * e };
    },
  },
  // しな (contrapposto): hips/shoulders lean opposite ways (tilt), the head
  // counter-tilts further still (hr) — the classic S-curve pose.
  shina: {
    dur: 4.2,
    f: (p) => { const e = rhf(p, 0.22, 0.22); return { tilt: 0.12 * e, cr: -0.17 * e, hr: 0.20 * e }; },
  },
  // 恐縮 (deeply apologetic: shoulders draw in, an even slower/deeper bow)
  bowSorry: {
    dur: 3.8, cam: 'pull', noLook: true,
    f: (p) => { const e = rhf(p, 0.55, 0.25); return { pitch: 1.1 * e, sh: 0.3 * e, y: -0.04 * e }; },
  },
  doubletake: { dur: 0.8, f: (p) => ({ yaw: Math.sin(p * Math.PI * 3) * 0.30 }) },
  nodOff: { dur: 4.0, noLook: true, f: (p) => ({ pitch: Math.max(0, Math.sin(p * Math.PI * 2)) * 0.25, hp: 0.1 }) },
};
Object.freeze(ROOT_ACTS);

/**
 * A full-body root/trunk action: {dur, f(p) → channels}, played through the same
 * `engine.play(...)` queue as Gesture/ArmAct. Distributes the trunk channels
 * (pitch/hp/sh/yaw/cr/hr) onto MANAGED bones, and the true root channels
 * (y/z/tilt/lookDown, none of which are a bone) into the TargetBuffer's `root`
 * accumulator, which MotionEngine.update() surfaces as Pose.root — see #7's
 * compat plan; a consumer that never reads `pose.root` is unaffected.
 */
export class RootAct {
  constructor(name, dur) {
    this.name = name;
    this.spec = ROOT_ACTS[name];
    this.dur = dur || (this.spec && this.spec.dur) || 1.0;
    this.t = 0;
    this.done = !this.spec;
    // camera/expression hints: motion-engine's contract stops at exposing these
    // as plain data (see the section header above) — never interpreted here.
    this.cam = this.spec && this.spec.cam;
    this.noLook = !!(this.spec && this.spec.noLook);
    this.pip = !!(this.spec && this.spec.pip);
  }
  apply(buf, ctx) {
    if (this.done) return;
    this.t += ctx.dt;
    const p = this.t / this.dur;
    if (p >= 1) { this.done = true; return; }
    const o = this.spec.f(Math.max(0, p));
    // trunk forward-bend: spread over the spine chain so the back visibly rounds
    // (weights ported verbatim from kamishibai's host.html distribution).
    if (o.pitch) {
      buf.add('spine', [o.pitch * 0.35, 0, 0]);
      buf.add('chest', [o.pitch * 0.30, 0, 0]);
      buf.add('neck', [o.pitch * 0.20, 0, 0]);
      buf.add('head', [o.pitch * 0.15, 0, 0]);
    }
    if (o.hp) buf.add('head', [o.hp, 0, 0]);
    if (o.sh) { buf.add('leftShoulder', [0, 0, -o.sh]); buf.add('rightShoulder', [0, 0, o.sh]); }
    if (o.yaw) buf.add('head', [0, o.yaw, 0]);
    if (o.cr) buf.add('chest', [0, 0, o.cr]);
    if (o.hr) buf.add('head', [0, 0, o.hr]);
    if (o.y) buf.addRoot('y', o.y);
    if (o.z) buf.addRoot('z', o.z);
    if (o.tilt) buf.addRoot('tilt', o.tilt);
    if (o.lookDown) buf.addRoot('lookDown', o.lookDown);
  }
}

// ------------------------------------------------------- inverse kinematics (IK)
//
// Phase 2: a pure analytic two-bone IK solver so a hand can REACH an actual
// world point (the wall when drawing, the river slot when discarding) instead
// of swinging a canned arm. This is the capability a fixed clip can't have.
//
// All geometry is plain arrays in the upper-arm PARENT-local frame; the renderer
// measures the bone offsets + rest rotations from the VRM and converts the world
// target into that frame, so the engine stays three-free and FK-testable.

// minimal vector ops (plain [x,y,z])
const vsub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const vadd = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const vdot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const vcross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const vlen = (a) => Math.hypot(a[0], a[1], a[2]);
const vnorm = (a) => { const l = vlen(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const vscale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

// minimal quaternion ops (plain [x,y,z,w]); Euler uses three.js' 'XYZ' order so
// the output drops straight into bone.rotation.set(x,y,z) with no surprises.
function qMul(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}
const qConj = (q) => [-q[0], -q[1], -q[2], q[3]];
function qApply(q, p) {                                   // rotate vector p by q
  const tx = 2 * (q[1] * p[2] - q[2] * p[1]);
  const ty = 2 * (q[2] * p[0] - q[0] * p[2]);
  const tz = 2 * (q[0] * p[1] - q[1] * p[0]);
  return [
    p[0] + q[3] * tx + (q[1] * tz - q[2] * ty),
    p[1] + q[3] * ty + (q[2] * tx - q[0] * tz),
    p[2] + q[3] * tz + (q[0] * ty - q[1] * tx),
  ];
}
function qFromAxisAngle(axis, a) {
  const n = vnorm(axis); const h = a / 2; const s = Math.sin(h);
  return [n[0] * s, n[1] * s, n[2] * s, Math.cos(h)];
}
function qNorm(q) { const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1; return [q[0] / l, q[1] / l, q[2] / l, q[3] / l]; }
function qFromUnitVectors(a, b) {                         // shortest arc a→b (unit)
  const d = vdot(a, b);
  if (d < -0.999999) {                                    // antiparallel: any ⟂ axis
    let ax = vcross([1, 0, 0], a);
    if (vlen(ax) < 1e-6) ax = vcross([0, 1, 0], a);
    return qFromAxisAngle(ax, Math.PI);
  }
  const c = vcross(a, b);
  return qNorm([c[0], c[1], c[2], 1 + d]);
}
function qSlerp(a, b, t) {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  let bb = b;
  if (d < 0) { bb = [-b[0], -b[1], -b[2], -b[3]]; d = -d; }
  if (d > 0.9995) return qNorm([a[0] + (bb[0] - a[0]) * t, a[1] + (bb[1] - a[1]) * t, a[2] + (bb[2] - a[2]) * t, a[3] + (bb[3] - a[3]) * t]);
  const th = Math.acos(clamp(d, -1, 1)); const s = Math.sin(th);
  const wa = Math.sin((1 - t) * th) / s; const wb = Math.sin(t * th) / s;
  return [a[0] * wa + bb[0] * wb, a[1] * wa + bb[1] * wb, a[2] * wa + bb[2] * wb, a[3] * wa + bb[3] * wb];
}
export function qFromEulerXYZ(e) {
  const c1 = Math.cos(e[0] / 2), c2 = Math.cos(e[1] / 2), c3 = Math.cos(e[2] / 2);
  const s1 = Math.sin(e[0] / 2), s2 = Math.sin(e[1] / 2), s3 = Math.sin(e[2] / 2);
  return [
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 + s1 * s2 * c3,
    c1 * c2 * c3 - s1 * s2 * s3,
  ];
}
// in-place variant — writes the 4 quat components into `out` (length-4) instead
// of allocating. Used by the update() output loop for the arm-chain bones
// (QuatSpring target), eliminating 4 array allocations per frame.
function qFromEulerXYZInto(e, out) {
  const c1 = Math.cos(e[0] / 2), c2 = Math.cos(e[1] / 2), c3 = Math.cos(e[2] / 2);
  const s1 = Math.sin(e[0] / 2), s2 = Math.sin(e[1] / 2), s3 = Math.sin(e[2] / 2);
  out[0] = s1 * c2 * c3 + c1 * s2 * s3;
  out[1] = c1 * s2 * c3 - s1 * c2 * s3;
  out[2] = c1 * c2 * s3 + s1 * s2 * c3;
  out[3] = c1 * c2 * c3 - s1 * s2 * s3;
}
export function qToEulerXYZ(q) {
  const x = q[0], y = q[1], z = q[2], w = q[3];
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  const m11 = 1 - (yy + zz), m12 = xy - wz, m13 = xz + wy;
  const m22 = 1 - (xx + zz), m23 = yz - wx;
  const m32 = yz + wx, m33 = 1 - (xx + yy);
  const ey = Math.asin(clamp(m13, -1, 1));
  let ex, ez;
  if (Math.abs(m13) < 0.9999999) { ex = Math.atan2(-m23, m33); ez = Math.atan2(-m12, m11); }
  else { ex = Math.atan2(m32, m22); ez = 0; }
  return [ex, ey, ez];
}
// in-place variant of qToEulerXYZ — writes [ex,ey,ez] into `out` (a length-3
// array) instead of allocating. Used by the reusePose path to avoid per-bone
// array allocations in the output loop.
function qToEulerXYZInto(q, out) {
  const x = q[0], y = q[1], z = q[2], w = q[3];
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  const m11 = 1 - (yy + zz), m12 = xy - wz, m13 = xz + wy;
  const m22 = 1 - (xx + zz), m23 = yz - wx;
  const m32 = yz + wx, m33 = 1 - (xx + yy);
  out[1] = Math.asin(clamp(m13, -1, 1));
  if (Math.abs(m13) < 0.9999999) { out[0] = Math.atan2(-m23, m33); out[2] = Math.atan2(-m12, m11); }
  else { out[0] = Math.atan2(m32, m22); out[2] = 0; }
}

// rotation vector (axis*angle) ↔ quaternion, for orientation-space smoothing.
function qExp(v) {                                        // rotation vector → unit quat
  const th = vlen(v);
  if (th < 1e-8) return qNorm([v[0] / 2, v[1] / 2, v[2] / 2, 1]);
  const s = Math.sin(th / 2) / th;
  return [v[0] * s, v[1] * s, v[2] * s, Math.cos(th / 2)];
}
function qLog(q) {                                        // unit quat → rotation vector, |angle|≤π
  const vn = Math.hypot(q[0], q[1], q[2]);
  if (vn < 1e-8) return [0, 0, 0];
  let th = 2 * Math.atan2(vn, clamp(q[3], -1, 1));        // [0, 2π)
  if (th > Math.PI) th -= 2 * Math.PI;                    // → shortest [-π, π]
  const k = th / vn;
  return [q[0] * k, q[1] * k, q[2] * k];
}

/**
 * Second-order dynamics for an ORIENTATION (a bone's local rotation), the SO(3)
 * analogue of `Spring`. IK bones (the arm chain) can't be smoothed by springing
 * their three Euler axes independently — the axes couple and gimbal, so a big or
 * fast reach reads as a "カクッ" wobble/flip. This tracks a target quaternion the
 * proper way: the geodesic error → rotation vector → a critically-damped spring
 * on angular velocity → integrate the quat. Shortest-path, no gimbal, stable.
 *   f     natural frequency (higher = snappier)
 *   zeta  damping ratio (1 = critical, <1 = a little lively overshoot)
 */
class QuatSpring {
  constructor(f = 2.4, zeta = 0.9, e0 = ZERO3) {
    this.setParams(f, zeta);
    this.q = qNorm(qFromEulerXYZ(e0));
    this.w = [0, 0, 0];                                   // angular velocity (parent frame), rad/s
  }
  setParams(f, zeta) { const wn = 2 * Math.PI * f; this.kp = wn * wn; this.kd = 2 * zeta * wn; }
  update(dt, qT) {
    if (!(dt > 0)) return this.q;
    // SUBSTEP so the stiffness term stays stable no matter how big the frame gap
    // is. A single large step (a dropped frame / a slow headless render at ~5fps)
    // lets kp·e·h fling the orientation past the target and the arm flips; small
    // fixed substeps keep each kp·e·h tiny. At 60fps this is exactly one step
    // (h = 1/60), so normal playback is unchanged. Huge gaps are clamped first.
    let rem = dt < 0.25 ? dt : 0.25;                      // cap catastrophic gaps (tab refocus)
    const n = Math.min(32, Math.max(1, Math.ceil(rem / (1 / 60))));
    const h = rem / n;
    let t = qT;
    if (this.q[0] * qT[0] + this.q[1] * qT[1] + this.q[2] * qT[2] + this.q[3] * qT[3] < 0) {
      t = [-qT[0], -qT[1], -qT[2], -qT[3]];               // shortest path (constant target over the gap)
    }
    for (let s = 0; s < n; s++) {
      const e = qLog(qNorm(qMul(t, qConj(this.q))));      // error rotation vector
      for (let i = 0; i < 3; i++) {
        // semi-implicit in the damping term → unconditionally stable for any h
        this.w[i] = (this.w[i] + h * this.kp * e[i]) / (1 + h * this.kd);
        if (this.w[i] > 60) this.w[i] = 60; else if (this.w[i] < -60) this.w[i] = -60;
      }
      this.q = qNorm(qMul(qExp([this.w[0] * h, this.w[1] * h, this.w[2] * h]), this.q));
    }
    return this.q;
  }
  reset(e0) { this.q = qNorm(qFromEulerXYZ(e0)); this.w = [0, 0, 0]; }
}

/**
 * Forward kinematics of the hand for a two-bone arm — the inverse check for the
 * solver and the renderer's way to validate its measured geometry.
 * @returns {number[]} hand position in the parent-local frame
 */
export function fkHand(pU, pL, pH, upperQ, lowerQ) {
  const elbow = vadd(pU, qApply(upperQ, pL));
  return vadd(elbow, qApply(qMul(upperQ, lowerQ), pH));
}

/**
 * Analytic two-bone IK with a POLE VECTOR. Inputs in the upper-arm PARENT-local
 * frame:
 *   pU,pL,pH   bone local positions: shoulder(=upper pos), elbow offset, wrist offset
 *   restU,restL  rest LOCAL rotations (quaternions) of upper / lower arm
 *   target     desired hand position
 *   opts.pole  parent-frame direction the ELBOW is pushed toward (e.g. down-and-
 *              back for a seated reach). Default = the way the REST pose already
 *              bends, so a model's natural elbow direction is preserved.
 *
 * The pole is the fix for the old "elbow flips to a shortest-arc accident" feel:
 * the elbow is placed EXPLICITLY in the plane through the shoulder→target line
 * and the pole, by the law of cosines — so as the target sweeps, the elbow
 * tracks consistently on the pole side instead of rolling to whatever the
 * minimal swing happened to give. Then each bone is swung from its REST
 * direction to the solved direction (min-twist, preserving rest twist), which
 * keeps IK∘FK an exact identity on the reachable shell (verified in tests).
 *
 * Returns new LOCAL rotations {upperQ, lowerQ} placing the hand at `target`
 * (clamped to the reachable shell).
 */
export function solveTwoBone(pU, pL, pH, restU, restL, target, opts = {}) {
  const L1 = vlen(pL), L2 = vlen(pH);
  // rest geometry (parent frame): elbow/hand at rest + the rest bone DIRECTIONS
  // we swing away from. lowerWorldRest is the lower arm's rest WORLD rotation.
  const restElbow = vadd(pU, qApply(restU, pL));
  const lowerWorldRest = qMul(restU, restL);
  const restHand = vadd(restElbow, qApply(lowerWorldRest, pH));
  const restA = vnorm(vsub(restElbow, pU));            // upper-arm rest direction
  const restB = vnorm(vsub(restHand, restElbow));      // lower-arm rest direction

  // clamp the target into the arm's reachable shell (annulus |L1-L2| … L1+L2)
  let d = vlen(vsub(target, pU));
  d = clamp(d, Math.abs(L1 - L2) + 1e-4, (L1 + L2) * 0.9999);
  // joint limit (opt-in): keep the ELBOW's interior angle within [min,max] rad
  // (a real elbow neither hyperextends past ~π nor over-folds past ~0). Enforced
  // by mapping the angle range to a distance range via the law of cosines and
  // clamping d — so the hand stops SHORT of an anatomy-breaking pose instead of
  // reaching it. Default (no opts.elbow) = free, so existing behavior is intact.
  if (opts.elbow) {
    const dForAngle = (ang) => Math.sqrt(Math.max(0, L1 * L1 + L2 * L2 - 2 * L1 * L2 * Math.cos(ang)));
    const dA = dForAngle(opts.elbow[0]), dB = dForAngle(opts.elbow[1]);   // smaller angle → smaller d
    d = clamp(d, Math.min(dA, dB), Math.max(dA, dB));
  }
  const dir = vnorm(vsub(target, pU));                 // shoulder → target

  // POLE direction (elbow push). Default: the rest elbow's offset from the
  // shoulder→hand line, so the natural bend direction is kept. Host overrides
  // with opts.pole. Projected perpendicular to `dir` to lie in the bend plane.
  let pole = opts.pole;
  if (!pole) {
    const restHandDir = vnorm(vsub(restHand, pU));
    const off = vsub(vsub(restElbow, pU), vscale(restHandDir, vdot(vsub(restElbow, pU), restHandDir)));
    pole = vlen(off) > 1e-5 ? off : [0, -1, 0];        // straight rest → default down
  }
  let u = vsub(pole, vscale(dir, vdot(pole, dir)));    // component of pole ⟂ dir
  if (vlen(u) < 1e-6) {                                 // pole ∥ dir → pick any ⟂
    u = vcross(dir, [0, 1, 0]);
    if (vlen(u) < 1e-6) u = vcross(dir, [1, 0, 0]);
  }
  u = vnorm(u);

  // law of cosines: interior angle at the shoulder between dir and the upper arm.
  const cosA = clamp((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1);
  const angleA = Math.acos(cosA);
  let aUnit = vadd(vscale(dir, Math.cos(angleA)), vscale(u, Math.sin(angleA)));  // upper-arm dir
  // shoulder cone (opt-in): keep the upper arm within `shoulder` radians of its
  // rest direction. Beyond it, the arm can't swing further, so the hand stops
  // short (anatomical) — we slerp the upper-arm DIRECTION back onto the cone and
  // let the forearm still aim at the target from there.
  if (opts.shoulder) {
    const cAng = Math.acos(clamp(vdot(aUnit, restA), -1, 1));
    if (cAng > opts.shoulder && cAng > 1e-4) {
      const tt = opts.shoulder / cAng, s = Math.sin(cAng);
      aUnit = vnorm(vadd(vscale(restA, Math.sin((1 - tt) * cAng) / s), vscale(aUnit, Math.sin(tt * cAng) / s)));
    }
  }
  const elbow = vadd(pU, vscale(aUnit, L1));
  const bUnit = vnorm(vsub(target, elbow));            // lower-arm dir (hand lands on target)

  // swing each bone rest→solved, preserving rest twist. Exact IK∘FK identity:
  //   upperQ·pL  = L1·aUnit ,  (upperQ·lowerQ)·pH = L2·bUnit  ⇒ hand = target.
  const upperQ = qMul(qFromUnitVectors(restA, aUnit), restU);
  const lowerWorld = qMul(qFromUnitVectors(restB, bUnit), lowerWorldRest);
  const lowerQ = qMul(qConj(upperQ), lowerWorld);
  return { upperQ, lowerQ };
}

/**
 * A reach action: ease the hand to a target and back over `dur`, solving IK each
 * frame and blending rest→IK by a sin-bell. The renderer supplies the arm
 * geometry (measured once) and the target in the parent-local frame.
 *   geo = { pU, pL, pH, restU:[x,y,z], restL:[x,y,z] }   (rest rotations as Euler)
 */
export class Reach {
  constructor(side, geo, target, dur = 1.2, opts = {}) {
    this.side = side; this.geo = geo; this.target = target;
    this.dur = dur; this.t = 0; this.done = false; this.pole = opts.pole;
    this.elbow = opts.elbow; this.shoulder = opts.shoulder;   // optional joint limits
    this.colliders = opts.colliders;                // optional obstacle set (array | () => array)
    this.margin = opts.margin || 0;
    this.hold = opts.hold || 0;                    // fraction of dur to dwell at full reach
    this.up = side === 'left' ? 'leftUpperArm' : 'rightUpperArm';
    this.lo = side === 'left' ? 'leftLowerArm' : 'rightLowerArm';
    this.restU = qFromEulerXYZ(geo.restU);
    this.restL = qFromEulerXYZ(geo.restL);
  }
  apply(buf, ctx) {
    if (this.done) return;
    this.t += ctx.dt;
    const p = this.t / this.dur;
    if (p >= 1) { this.done = true; return; }
    // reach-out, optional dwell at full reach, reach-back
    let w;
    const h = this.hold / 2;
    if (p < 0.5 - h) w = Math.sin((p / (0.5 - h)) * (Math.PI / 2));
    else if (p > 0.5 + h) w = Math.sin(((1 - p) / (0.5 - h)) * (Math.PI / 2));
    else w = 1;
    const tgt = this.colliders ? projectOut(this.target, _cols(this.colliders), this.margin) : this.target;
    const { upperQ, lowerQ } = solveTwoBone(this.geo.pU, this.geo.pL, this.geo.pH, this.restU, this.restL, tgt, { pole: this.pole, elbow: this.elbow, shoulder: this.shoulder });
    buf.set(this.up, qToEulerXYZ(qSlerp(this.restU, upperQ, w)));
    buf.set(this.lo, qToEulerXYZ(qSlerp(this.restL, lowerQ, w)));
  }
}

// ------------------------------------------------------------------- place (v0.2)
//
// A weight-aware "place a tile" action: the discard read as body language. One
// reach is split into phases — windup → torso/shoulder LEAD + gravity ARC →
// CONTACT (wrist snap + settle sink) → DWELL (linger) → RELEASE (peel) — and the
// whole thing is parameterized so the SAME intent expresses differently:
// そっと置く / ねじ込む / ピシッとスナップ / なかなか離さない.
//
// Everything is still L2 (kinematics + spring smoothing): no forces, no mass —
// the "weight" is faked via overlap (the lead→lag spring chain), counter-lean,
// a vertical arc, asymmetric timing and a settle sink. Zero-dep, deterministic.

const _c01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const _smooth = (a, b, x) => { const t = _c01((x - a) / (b - a || 1e-6)); return t * t * (3 - 2 * t); };

// style presets → parameter bundles. Map a seat's emotion to one of these and
// the discard becomes a tell. Tune the numbers against the real avatars.
export const PLACE_STYLES = Object.freeze({
  gentle: { dur: 1.6, arc: 0.05, lead: 0.6, snap: 0.0, twist: 0.0, dwell: 0.18, release: 0.7, sink: 0.012 },
  snap: { dur: 1.0, arc: 0.04, lead: 0.5, snap: 0.9, twist: 0.0, dwell: 0.0, release: 0.2, sink: 0.006 },
  linger: { dur: 1.9, arc: 0.05, lead: 0.6, snap: 0.15, twist: 0.0, dwell: 0.5, release: 0.85, sink: 0.014 },
  jam: { dur: 0.9, arc: 0.02, lead: 0.5, snap: 0.4, twist: 0.7, dwell: 0.1, release: 0.25, sink: 0.02 },
  timid: { dur: 1.3, arc: 0.06, lead: 0.3, snap: 0.0, twist: 0.0, dwell: 0.1, release: 0.4, sink: 0.008 },
});

/**
 * Place a hand at `target` (parent-local) with weight + character.
 *   geo  = { pU, pL, pH, restU, restL, restW?:[x,y,z], pole? }
 *   opts = { style:'gentle'|'snap'|'linger'|'jam'|'timid', dur, arc, lead, snap,
 *            twist, dwell, release, sink, pole, wristAim:[x,y,z] }  (opts override style)
 */
export class Place {
  constructor(side, geo, target, opts = {}) {
    const st = PLACE_STYLES[opts.style] || PLACE_STYLES.gentle;
    this.p = Object.assign({}, st, opts);
    this.side = side; this.geo = geo; this.target = target;
    this.colliders = opts.colliders; this.margin = opts.margin || 0;
    this.dur = this.p.dur; this.t = 0; this.done = false;
    this.sign = side === 'left' ? 1 : -1;
    this.up = side === 'left' ? 'leftUpperArm' : 'rightUpperArm';
    this.lo = side === 'left' ? 'leftLowerArm' : 'rightLowerArm';
    this.sh = side === 'left' ? 'leftShoulder' : 'rightShoulder';
    this.wr = side === 'left' ? 'leftHand' : 'rightHand';
    this.restU = qFromEulerXYZ(geo.restU);
    this.restL = qFromEulerXYZ(geo.restL);
    this.restW = qFromEulerXYZ(geo.restW || ZERO3);
    this.start = fkHand(geo.pU, geo.pL, geo.pH, this.restU, this.restL);   // rest hand pos = arc origin
  }
  apply(buf, ctx) {
    if (this.done) return;
    this.t += ctx.dt;
    const p = this.t / this.dur;
    if (p >= 1) { this.done = true; return; }
    const P = this.p;
    const tArrive = 0.45;
    const tDwell = tArrive + Math.min(0.45, P.dwell);   // contact → dwell end

    // reach weight: (windup, opposite) → ease to 1 by arrival → hold through
    // dwell → peel back to 0. The windup is anticipation — the hand gathers back
    // a touch before it reaches out (w goes slightly NEGATIVE = past rest, away
    // from the target). release exponent grows with P.release → a slow, reluctant
    // let-go (linger). P.anticipate (default 0.1) tunes the gather depth; 0 = none.
    const antW = P.anticipate != null ? P.anticipate : 0.3;
    const antF = 0.2;                                   // windup = first 20% of the approach
    let w;
    if (p < tArrive) {
      const a = p / tArrive;
      if (antW > 0 && a < antF) w = -antW * Math.sin((a / antF) * Math.PI);         // gather back
      else { const q = antW > 0 ? (a - antF) / (1 - antF) : a; w = Math.sin(q * (Math.PI / 2)); }
    } else if (p < tDwell) {
      w = 1;
    } else {
      w = 1 - Math.pow((p - tDwell) / (1 - tDwell), 1 + P.release * 2.5);
      if (w < 0) w = 0;
    }

    // IK target: lerp start→target by reach weight, + a vertical lift arc
    // (hand lifts off then settles down), + a brief downward sink at contact.
    const tgt = [
      this.start[0] + (this.target[0] - this.start[0]) * w,
      this.start[1] + (this.target[1] - this.start[1]) * w,
      this.start[2] + (this.target[2] - this.start[2]) * w,
    ];
    tgt[1] += P.arc * Math.sin(_c01(p / tDwell) * Math.PI);                 // lift arc
    if (p >= tArrive && p < tDwell) tgt[1] -= P.sink * Math.sin(((p - tArrive) / (tDwell - tArrive)) * Math.PI);

    // solve IK + optional forearm twist (ねじ込む), engaged from contact on.
    // clamp the goal out of obstacles first so the hand rests ON the surface.
    const tgtC = this.colliders ? projectOut(tgt, _cols(this.colliders), this.margin) : tgt;
    const sol = solveTwoBone(this.geo.pU, this.geo.pL, this.geo.pH, this.restU, this.restL, tgtC, { pole: P.pole || this.geo.pole, elbow: P.elbow, shoulder: P.shoulder });
    const tw = P.twist * _smooth(tArrive - 0.12, tArrive, p) * (p < 1 ? 1 : 0);
    let lowerQ = sol.lowerQ;
    if (tw) lowerQ = qMul(lowerQ, qFromAxisAngle([0, 1, 0], tw * 0.5 * this.sign));
    // blend rest→IK by the MAGNITUDE of the reach weight: during the windup w<0
    // (goal behind rest), and we want the arm to actually reach that backward
    // goal, so the orientation engages by |w| toward the IK solution (not by the
    // signed w, which would cancel the backward target). For w≥0 this is identical.
    const bw = w < 0 ? -w : w;
    buf.set(this.up, qToEulerXYZ(qSlerp(this.restU, sol.upperQ, bw)));
    buf.set(this.lo, qToEulerXYZ(qSlerp(this.restL, lowerQ, bw)));

    // shoulder roll/swing: peaks DURING the swing, ~0 at contact so IK stays
    // accurate where it matters. Roll forward + a little swing toward the target.
    const swing = P.lead * Math.sin(_c01(p / tArrive) * Math.PI);
    buf.add(this.sh, [-swing * 0.18, swing * 0.12 * this.sign, 0]);

    // wrist: aim (finger direction, independent of the elbow) + snap flick at
    // contact + the place-twist carried into the hand.
    let wq = qMul(qFromEulerXYZ(P.wristAim || ZERO3), this.restW);
    const snap = P.snap * Math.max(0, 1 - Math.abs(p - tArrive) / 0.06);     // sharp spike at contact
    if (snap) wq = qMul(qFromAxisAngle([1, 0, 0], -snap * 0.5), wq);
    if (tw) wq = qMul(qFromAxisAngle([0, 1, 0], tw * 0.6 * this.sign), wq);
    buf.set(this.wr, qToEulerXYZ(wq));

    // torso LEAD + counter-lean (the "型を回転" weight shift), enveloped on swing
    buf.add('chest', [0, swing * 0.12 * this.sign, -swing * 0.05 * this.sign]);
    buf.add('spine', [0, swing * 0.06 * this.sign, 0]);
  }
}

// ------------------------------------------------------------------- grip (v0.5)
//
// Two finger primitives layered on the arm. `Grip` is the standalone open/close
// envelope (drive a hand on its own); `Pick` is the full discard gesture — reach
// INTO the own hand, close the fingers on a tile, sweep it out and release it
// over the river — one continuous timeline so it reads as a single grab→place,
// not two disconnected motions. The host supplies both targets in the upper-arm
// parent-local frame (same convention as Reach/Place) and follows the hand bone
// to carry the actual tile mesh.

/**
 * A standalone finger open/close envelope. `keys` are [p, curl] control points
 * over the action's life (p in 0..1); curl is smoothstep-interpolated. The
 * applied finger curl is base + curl*span, so the resting hand (base) stays
 * natural and a full grab approaches `base+span`.
 *   new Grip('right', { dur, keys:[[0,0],[0.4,1],[0.8,1],[1,0]], flexSign })
 */
export class Grip {
  constructor(side, opts = {}) {
    this.side = side;
    this.dur = opts.dur || 1.0;
    this.keys = opts.keys || [[0, 0], [1, 1]];
    this.flexSign = opts.flexSign;
    this.base = opts.base != null ? opts.base : REST_FINGER_CURL;
    this.span = opts.span != null ? opts.span : 0.82;
    this.t = 0; this.done = false;
  }
  curlAt(p) {
    const k = this.keys;
    if (p <= k[0][0]) return k[0][1];
    for (let i = 1; i < k.length; i++) {
      if (p <= k[i][0]) {
        const a = k[i - 1], b = k[i];
        const u = _c01((p - a[0]) / ((b[0] - a[0]) || 1e-6));
        return a[1] + (b[1] - a[1]) * (u * u * (3 - 2 * u));
      }
    }
    return k[k.length - 1][1];
  }
  apply(buf, ctx) {
    if (this.done) return;
    this.t += ctx.dt;
    const p = this.t / this.dur;
    if (p >= 1) { this.done = true; return; }
    const c = this.base + this.curlAt(p) * this.span;
    const gp = gripPose(this.side, c, { flexSign: this.flexSign });
    for (const b in gp) buf.set(b, gp[b]);
  }
}

// ------------------------------------------------------------------- pick (v0.5)
//
// The full discard as ONE action: rest → reach into the own hand → fingers close
// (grab) → sweep out over the river with a gravity arc → fingers open (release) →
// retract to rest. Drives the arm IK (shoulder/upperArm/lowerArm/wrist), the
// torso lead, and the finger grip together. `style` reuses the Place presets for
// the "manner" (gentle/snap/linger/jam/timid) of the placement half.

/**
 * @param geo  { pU, pL, pH, restU, restL, restW?, pole? } (measured from the rig)
 * @param opts { grab:[x,y,z], place:[x,y,z], dur?, style?, flexSign?, + Place overrides }
 *   grab/place are targets in the upper-arm PARENT-LOCAL frame.
 */
export class Pick {
  constructor(side, geo, opts = {}) {
    const st = PLACE_STYLES[opts.style] || PLACE_STYLES.gentle;
    this.p = Object.assign({}, st, opts);
    this.side = side; this.geo = geo;
    this.grab = opts.grab || [0, 0, 0];
    this.place = opts.place || [0, 0, 0];
    this.colliders = opts.colliders; this.margin = opts.margin || 0;
    this.dur = opts.dur || 2.1; this.t = 0; this.done = false;
    this.flexSign = opts.flexSign;
    this.sign = side === 'left' ? 1 : -1;
    this.up = side === 'left' ? 'leftUpperArm' : 'rightUpperArm';
    this.lo = side === 'left' ? 'leftLowerArm' : 'rightLowerArm';
    this.sh = side === 'left' ? 'leftShoulder' : 'rightShoulder';
    this.wr = side === 'left' ? 'leftHand' : 'rightHand';
    this.restU = qFromEulerXYZ(geo.restU);
    this.restL = qFromEulerXYZ(geo.restL);
    this.restW = qFromEulerXYZ(geo.restW || ZERO3);
    this.start = fkHand(geo.pU, geo.pL, geo.pH, this.restU, this.restL);   // rest hand pos
  }
  // phase fractions (of dur): arrive-at-grab, grip-closed/sweep-start,
  // arrive-at-place, released → retract.
  get _ph() { return { A: 0.26, B: 0.40, C: 0.74, D: 0.84 }; }
  apply(buf, ctx) {
    if (this.done) return;
    this.t += ctx.dt;
    const p = this.t / this.dur;
    if (p >= 1) { this.done = true; return; }
    const P = this.p; const { A, B, C, D } = this._ph;
    const lerp3 = (u, v, w) => [u[0] + (v[0] - u[0]) * w, u[1] + (v[1] - u[1]) * w, u[2] + (v[2] - u[2]) * w];

    // hand IK target + how fully the arm is extended (rest→IK blend)
    let pos, reachW;
    if (p < A) {                                   // rest → grab (into the own hand)
      // anticipation: the hand gathers back a touch before reaching in (w<0)
      const antW = P.anticipate != null ? P.anticipate : 0.3;
      const antF = 0.25;
      const a = p / A;
      let w;
      if (antW > 0 && a < antF) w = -antW * Math.sin((a / antF) * Math.PI);
      else { const q = antW > 0 ? (a - antF) / (1 - antF) : a; w = Math.sin(q * (Math.PI / 2)); }
      pos = lerp3(this.start, this.grab, w); reachW = w;
    } else if (p < C) {                            // dwell at grab (A..B), then sweep grab → place
      const wb = p < B ? 0 : _smooth(B, C, p);
      pos = lerp3(this.grab, this.place, wb); reachW = 1;
      pos[1] += P.arc * Math.sin(_c01((p - A) / (C - A)) * Math.PI);   // gravity lift arc over the sweep
    } else {                                       // place → retract to rest
      const w = Math.sin(_c01((p - C) / (1 - C)) * (Math.PI / 2));
      pos = lerp3(this.place, this.start, w); reachW = 1 - w;
    }
    if (p >= C - 0.05 && p < D) pos[1] -= P.sink * Math.sin(((p - (C - 0.05)) / (D - (C - 0.05))) * Math.PI);  // settle sink

    // keep the carrying hand out of obstacles (river tiles, the wall, the torso)
    if (this.colliders) pos = projectOut(pos, _cols(this.colliders), this.margin);
    const sol = solveTwoBone(this.geo.pU, this.geo.pL, this.geo.pH, this.restU, this.restL, pos, { pole: P.pole || this.geo.pole, elbow: P.elbow, shoulder: P.shoulder });
    const bw = reachW < 0 ? -reachW : reachW;    // engage IK by magnitude (windup goal is behind rest)
    buf.set(this.up, qToEulerXYZ(qSlerp(this.restU, sol.upperQ, bw)));
    buf.set(this.lo, qToEulerXYZ(qSlerp(this.restL, sol.lowerQ, bw)));

    // shoulder + torso lead peak mid-sweep (the weight shift carrying the tile out)
    const swing = P.lead * Math.sin(_c01((p - A) / (C - A)) * Math.PI);
    buf.add(this.sh, [-swing * 0.16, swing * 0.10 * this.sign, 0]);
    buf.add('chest', [0, swing * 0.10 * this.sign, -swing * 0.04 * this.sign]);
    buf.add('spine', [0, swing * 0.05 * this.sign, 0]);

    // wrist: aim + a release flick at let-go, faded with reach so it returns home
    let wq = qMul(qFromEulerXYZ(P.wristAim || ZERO3), this.restW);
    const snap = P.snap * Math.max(0, 1 - Math.abs(p - D) / 0.06);
    if (snap) wq = qMul(qFromAxisAngle([1, 0, 0], -snap * 0.4), wq);
    buf.set(this.wr, qToEulerXYZ(qSlerp(this.restW, wq, reachW)));

    // grip: open on approach → close to grab by B → hold through the sweep →
    // open to release at D. Curl rides on the resting curl so it eases home.
    let grab;
    if (p < B) grab = _smooth(A - 0.06, B, p);
    else if (p < D) grab = 1;
    else grab = 1 - _smooth(D, D + 0.08, p);
    const gp = gripPose(this.side, REST_FINGER_CURL + grab * 0.80, { flexSign: this.flexSign });
    for (const b in gp) buf.set(b, gp[b]);
  }
}

// --------------------------------------------------- collision / constraints
//
// Keep the reaching hand OUT of obstacles: the table surface, the tile WALL, the
// discarded tiles in the river, another player's hand, the avatar's own torso.
// Colliders are PLAIN DATA in the same frame as the IK target (the upper-arm
// parent-local frame), so the host measures them from the scene and hands them
// in — the engine stays three-free. Correction is a TARGET CLAMP: before the IK
// solves, the hand's goal is projected to the nearest point OUTSIDE every
// collider, so the solved arm physically can't reach into one — and the hand
// slides along the surface instead (resting on the table, sweeping along the
// wall). Cheaper and more stable than a post-pose push-out, and it keeps the arm
// IK-consistent (no bone yanked out of the chain).
//
// Shapes (each may carry its own extra `margin`):
//   { shape:'plane',   n:[x,y,z], o:[x,y,z] }    half-space; keep on +n side of o
//   { shape:'sphere',  c:[x,y,z], r }             keep outside the ball (a tile/head)
//   { shape:'capsule', a:[x,y,z], b:[x,y,z], r }  keep outside a fat segment (wall/forearm/torso)

function _closestOnSeg(p, a, b) {
  const ab = vsub(b, a);
  const t = clamp(vdot(vsub(p, a), ab) / (vdot(ab, ab) || 1), 0, 1);
  return vadd(a, vscale(ab, t));
}

// Push a point to the nearest surface just OUTSIDE one collider (+margin).
// Returns the SAME array reference when already clear (lets projectOut detect
// "no move" cheaply).
function _pushOut(p, col, margin) {
  const m = margin + (col.margin || 0);
  if (col.shape === 'plane') {
    const n = vnorm(col.n);
    const sd = vdot(vsub(p, col.o), n) - m;
    return sd < 0 ? vadd(p, vscale(n, -sd)) : p;
  }
  if (col.shape === 'sphere') {
    const v = vsub(p, col.c), L = vlen(v), R = col.r + m;
    if (L < R) return L > 1e-6 ? vadd(col.c, vscale(v, R / L)) : vadd(col.c, [0, R, 0]);
    return p;
  }
  if (col.shape === 'capsule') {
    const q = _closestOnSeg(p, col.a, col.b);
    const v = vsub(p, q), L = vlen(v), R = col.r + m;
    if (L < R) return L > 1e-6 ? vadd(q, vscale(v, R / L)) : vadd(q, [0, R, 0]);
    return p;
  }
  return p;
}

/**
 * Project a point to the nearest position OUTSIDE all colliders. Colliders can
 * overlap, so it relaxes over a few passes (a push out of one may poke into
 * another). Pure + deterministic. Returns a corrected point (equals `p` when
 * already clear).
 */
export function projectOut(p, colliders, margin = 0, passes = 3) {
  if (!colliders || !colliders.length) return p;
  let q = p;
  for (let k = 0; k < passes; k++) {
    let moved = false;
    for (const c of colliders) { const r = _pushOut(q, c, margin); if (r !== q) { q = r; moved = true; } }
    if (!moved) break;
  }
  return q;
}

// colliders may be a live array or a per-frame function (tiles fall, hands move)
function _cols(c) { return typeof c === 'function' ? c() : c; }

// The HAND displacement that lifts a whole SEGMENT (a bone, e.g. the forearm:
// a=elbow fixed, b=hand) out of the colliders. Sample along it; a sample at
// parameter t needs the hand to move by push/t to clear it (the segment pivots
// about the fixed elbow, so a mid-forearm obstacle needs ~2× the hand move).
// Returns the largest such hand displacement (null when the segment is clear).
function _segPush(a, b, cols, margin, samples = 4) {
  let best = null, bestNeed = 0;
  for (let i = 1; i <= samples; i++) {
    const t = i / samples;
    const p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    const q = projectOut(p, cols, margin);
    if (q !== p) {
      const need = vlen(vsub(q, p)) / Math.max(t, 0.34);   // hand move to lift this sample out
      if (need > bestNeed) { bestNeed = need; best = vscale(vnorm(vsub(q, p)), need); }
    }
  }
  return best;
}

/**
 * Build a post-pose CONSTRAINT (for engine.addConstraint) that keeps an arm's
 * hand out of obstacles AFTER the springs have run — so it catches the residual
 * penetration a goal-clamp can't: the sprung hand LAGS its (already-clamped)
 * goal and can cut a corner through an obstacle mid-swing. This FK's the hand
 * from the produced pose, and if it's inside any collider, re-solves two-bone IK
 * to the pushed-out point and writes the corrected upper/lower Euler back. It
 * corrects BOTH the hand point AND the forearm SEGMENT (elbow→hand), so a limb
 * swept across the body is lifted off a torso capsule, not just the fingertip.
 * Pass `colliders` as an array or a per-frame function; `geo` is the same
 * measured rig geometry the actions use ({ pU,pL,pH,restU,restL,pole?,elbow?,
 * shoulder? }).
 *   engine.addConstraint(makeArmConstraint({ side:'right', geo, colliders, margin }))
 */
export function makeArmConstraint(opts) {
  const { side, geo, margin = 0 } = opts;
  const up = side === 'left' ? 'leftUpperArm' : 'rightUpperArm';
  const lo = side === 'left' ? 'leftLowerArm' : 'rightLowerArm';
  const restU = qFromEulerXYZ(geo.restU), restL = qFromEulerXYZ(geo.restL);
  const solveOpts = { pole: geo.pole, elbow: geo.elbow, shoulder: geo.shoulder };
  return function armConstraint(pose) {
    const cols = _cols(opts.colliders);
    if (!cols || !cols.length || !pose[up] || !pose[lo]) return;
    const uq = qFromEulerXYZ(pose[up]), lq = qFromEulerXYZ(pose[lo]);
    const elbow = vadd(geo.pU, qApply(uq, geo.pL));
    const hand = fkHand(geo.pU, geo.pL, geo.pH, uq, lq);
    let fixed = projectOut(hand, cols, margin);        // 1) hand point out
    let moved = fixed !== hand;
    for (let pass = 0; pass < 2; pass++) {              // 2) lift the forearm segment out
      const push = _segPush(elbow, fixed, cols, margin);
      if (!push) break;
      fixed = vadd(fixed, push); moved = true;
    }
    if (!moved) return;
    const sol = solveTwoBone(geo.pU, geo.pL, geo.pH, restU, restL, fixed, solveOpts);
    pose[up] = qToEulerXYZ(sol.upperQ);
    pose[lo] = qToEulerXYZ(sol.lowerQ);
  };
}

// ------------------------------------------------------------------- scheduler

/**
 * Per-avatar motion engine: owner of all MANAGED bones. Each frame it rebuilds
 * the target pose (rest → idle → emotion → actions), springs the live pose
 * toward it, runs the constraint pass, and RETURNS the pose as plain data
 * ({ bone: [x,y,z] }). It never touches a VRM/three node — the renderer applies
 * the returned pose. One engine per avatar.
 */
export class MotionEngine {
  constructor(opts = {}) {
    this.idle = new NoiseIdle();
    this.emotion = new EmotionPose();
    this.actions = [];          // transient actions (gestures; later reach/gaze)
    this.constraints = [];      // post-pose passes: collision correction (Phase 4)
    // BodyProfile seam (v0.3): per-avatar physical params (joint limits, mass,
    // stiffness, bulk) that modulate every action — same intent, different body,
    // different motion. Stored but UNUSED in v0.2; jointLimit clamping etc. hang
    // off here later. The 'bulk' self-collider feeds the Phase 4 constraint pass.
    this.body = opts.body || null;
    this._buf = new TargetBuffer();
    this._c = { dt: 0, phase: 0, t: 0, pose: null, poseW: 0, gain: undefined }; // reused per frame
    // When the host consumes pose within the same frame and discards the
    // reference (the typical renderer path: apply to VRM bones, no caching), we
    // can reuse one pose object + one 3-array per bone across frames and avoid
    // 42 array allocations + 1 object per frame. OFF by default — the unit
    // tests hold multiple frames' poses simultaneously (trace.push), which a
    // reused pose would corrupt. Hosts that don't cache poses opt in.
    this._reusePose = !!opts.reusePose;
    if (this._reusePose) {
      this._pose = {};
      this._poseArr = {};                       // bone → reusable [x,y,z]
      for (const b of MANAGED) this._poseArr[b] = [0, 0, 0];
    }
    this._qT = [0, 0, 0, 0];                    // reusable quat target for QuatSpring.update
    this.springs = {};          // bone → [Spring x3]  (per-axis, most bones)
    this.qsprings = {};         // bone → QuatSpring    (arm chain, orientation space)
    for (const b of MANAGED) {
      const r = restOf(b);
      const f = SPRING_F[b] || 2.4;
      if (QUAT_SMOOTH.has(b)) this.qsprings[b] = new QuatSpring(f, 0.9, r);
      else this.springs[b] = [new Spring(f, 0.9, 0, r[0]), new Spring(f, 0.9, 0, r[1]), new Spring(f, 0.9, 0, r[2])];
    }
  }

  /** Queue a transient action (e.g. new Gesture('fistPump')). */
  play(action) { if (action) this.actions.push(action); }
  clear() { this.actions.length = 0; }

  /**
   * Register a constraint / collision-correction pass. fn(pose, ctx) runs AFTER
   * the springs have produced the pose, receiving the plain-data Pose to mutate
   * in place — push joints out of registered colliders, clamp reach, keep the
   * hand above the table edge. This is the seam Phase 4 fills (colliders are
   * passed as plain data; FK lives in the engine, never in three).
   */
  addConstraint(fn) { if (fn) this.constraints.push(fn); }

  /**
   * Reseed the springs from a given pose ({ bone: [x,y,z] }) — call when handing
   * the body back from a VRMA clip (pass the clip's final pose) so the
   * procedural motion eases out of it instead of snapping to rest.
   */
  syncFrom(pose) {
    if (!pose) return;
    for (const b of MANAGED) {
      const e = pose[b];
      if (!e) continue;
      if (QUAT_SMOOTH.has(b)) { this.qsprings[b].reset(e); continue; }
      const sp = this.springs[b];
      sp[0].reset(e[0]); sp[1].reset(e[1]); sp[2].reset(e[2]);
    }
  }

  /**
   * Advance one frame and RETURN the pose as plain data ({ bone: [x,y,z] }).
   * No three.js / VRM access — the renderer applies the returned pose.
   * @param {number} dt
   * @param {object} ctx  { t, phase, pose, poseW }
   * @returns {Object<string, number[]>}
   */
  update(dt, ctx) {
    // Reuse a single ctx-shaped object across frames instead of Object.assign
    // (the per-frame hot path). We copy only the fields layers read:
    // dt, phase, t, pose, poseW, gain — that's the full surface (grep ctx.).
    const c = this._c;
    c.dt = dt;
    if (ctx) {
      c.phase = ctx.phase != null ? ctx.phase : 0;
      c.t = ctx.t != null ? ctx.t : 0;
      c.pose = ctx.pose != null ? ctx.pose : null;
      c.poseW = ctx.poseW != null ? ctx.poseW : 0;
      c.gain = ctx.gain;                       // may be undefined — layers default to 1
    } else {
      c.phase = 0; c.t = 0; c.pose = null; c.poseW = 0; c.gain = undefined;
    }
    const buf = this._buf;
    buf.reset();   // reset() now also reinitializes every bone to rest in place

    this.idle.apply(buf, c);
    this.emotion.apply(buf, c);
    for (const a of this.actions) a.apply(buf, c);
    this.actions = this.actions.filter((a) => !a.done);

    let pose;
    if (this._reusePose) {
      pose = this._pose;
      const arrs = this._poseArr;
      const qT = this._qT;
      for (const b of MANAGED) {
        const tgt = buf.get(b);
        const a = arrs[b];
        if (QUAT_SMOOTH.has(b)) {
          qFromEulerXYZInto(tgt, qT);
          qToEulerXYZInto(this.qsprings[b].update(dt, qT), a);
        } else {
          const sp = this.springs[b];
          a[0] = sp[0].update(dt, tgt[0]);
          a[1] = sp[1].update(dt, tgt[1]);
          a[2] = sp[2].update(dt, tgt[2]);
        }
        pose[b] = a;
      }
      // root sub-object: reuse one stable object too (it's read via pose.root.y etc.)
      const r = this._poseRoot || (this._poseRoot = { y: 0, z: 0, tilt: 0, lookDown: 0 });
      r.y = buf.root.y; r.z = buf.root.z; r.tilt = buf.root.tilt; r.lookDown = clamp(buf.root.lookDown, 0, 1);
      pose.root = r;
    } else {
      pose = {};
      const qT = this._qT;
      for (const b of MANAGED) {
        const tgt = buf.get(b);
        if (QUAT_SMOOTH.has(b)) {                 // orientation-space smoothing (arm chain)
          qFromEulerXYZInto(tgt, qT);
          pose[b] = qToEulerXYZ(this.qsprings[b].update(dt, qT));
        } else {
          const sp = this.springs[b];
          pose[b] = [sp[0].update(dt, tgt[0]), sp[1].update(dt, tgt[1]), sp[2].update(dt, tgt[2])];
        }
      }
      pose.root = {
        y: buf.root.y,
        z: buf.root.z,
        tilt: buf.root.tilt,
        lookDown: clamp(buf.root.lookDown, 0, 1),
      };
    }

    // constraint / collision-correction pass (Phase 4): empty for now, but the
    // pipeline runs it every frame so IK reach + obstacle avoidance plug in here
    // without restructuring anything above.
    for (const fn of this.constraints) fn(pose, c);

    // pose.root was assigned above (either a fresh object or the reused one),
    // carrying the v0.12 full-body channels a RootAct wrote this frame under a
    // SEPARATE `root` key — never a bone name, so a consumer that only ever
    // reads `pose[boneName]` (getNormalizedBoneNode(bone) returns null for
    // 'root') is completely unaffected; only a host that opts in by reading
    // `pose.root` sees it.
    return pose;
  }
}
