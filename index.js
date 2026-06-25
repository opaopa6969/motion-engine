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
// elbow. v0.5: the finger bones join for grip. Bones a given VRM lacks (clavicle
// is OPTIONAL in VRM; some hands have fewer finger joints) are simply dropped by
// the renderer, so listing them here is safe.
export const MANAGED = Object.freeze([
  'spine', 'chest', 'head',
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
 */
class TargetBuffer {
  constructor() { this.t = {}; this.overridden = new Set(); }
  reset() { this.t = {}; this.overridden.clear(); }
  base(bone) { this.t[bone] = restOf(bone).slice(); }
  add(bone, d, w = 1) {
    const a = this.t[bone] || (this.t[bone] = [0, 0, 0]);
    if (this.overridden.has(bone)) return;   // an override won this bone
    a[0] += d[0] * w; a[1] += d[1] * w; a[2] += d[2] * w;
  }
  set(bone, e) { this.t[bone] = e.slice(); this.overridden.add(bone); }
  get(bone) { return this.t[bone] || ZERO3; }
}

// ------------------------------------------------------------- built-in layers

// Always-on living rest: breathing on the torso, slow head drift, a faint
// shoulder weight-shift. Small amplitudes — the point is "not a statue", not
// visible swaying. Stateless (reads ctx.t + ctx.phase).
class NoiseIdle {
  apply(buf, ctx) {
    const t = ctx.t + ctx.phase;
    const breath = Math.sin(t * 1.5);                       // ~0.24 Hz
    buf.add('spine', [breath * 0.014, 0, 0]);
    buf.add('chest', [breath * 0.012, 0, 0]);
    buf.add('head', [noise(t, 1.3) * 0.03, noise(t, 4.1) * 0.07, noise(t, 7.7) * 0.04]);
    buf.add('leftUpperArm', [0, 0, noise(t, 2.2) * 0.03]);
    buf.add('rightUpperArm', [0, 0, -noise(t, 5.6) * 0.03]);
  }
}

// The emotion layer's body language: PoseHint (headPitch/Yaw/Roll, chestLift,
// shoulder) → bone deltas, scaled by the emotion's live envelope weight.
class EmotionPose {
  apply(buf, ctx) {
    const p = ctx.pose || {};
    const w = ctx.poseW != null ? ctx.poseW : 1;
    if (!w) return;
    buf.add('head', [(p.headPitch || 0) * w, (p.headYaw || 0) * w, (p.headRoll || 0) * w]);
    buf.add('chest', [(p.chestLift || 0) * w, 0, 0]);
    if (p.shoulder) {
      buf.add('leftUpperArm', [0, 0, p.shoulder * w]);
      buf.add('rightUpperArm', [0, 0, -p.shoulder * w]);
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
  // right hand up to the head, small wiggle
  headScratch: (e, p) => ({
    rightUpperArm: [-e * 0.35, 0, e * 1.35],
    rightLowerArm: [0, -e * 1.7 + Math.sin(p * Math.PI * 7) * 0.18 * e, 0],
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
};
export const GESTURE_DUR = Object.freeze({
  tsumogiri: 1.4, headScratch: 1.8, fistPump: 1.0, slump: 1.5,
  recoil: 0.9, crossArms: 1.8, nod: 1.0, shrug: 1.2, lean: 1.5, smirkTilt: 1.4,
  sigh: 1.6, exhale: 1.4,
});

export class Gesture {
  constructor(name, dur) {
    this.name = name;
    this.dur = dur || GESTURE_DUR[name] || 1.0;
    this.fn = GESTURES[name];
    this.t = 0;
    this.done = !this.fn;
  }
  apply(buf, ctx) {
    if (this.done) return;
    this.t += ctx.dt;
    const p = this.t / this.dur;
    if (p >= 1) { this.done = true; return; }
    const e = Math.sin(Math.min(1, p) * Math.PI);   // 0 → 1 → 0
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
 * Analytic two-bone IK. Inputs in the upper-arm PARENT-local frame:
 *   pU,pL,pH   bone local positions: shoulder(=upper pos), elbow offset, wrist offset
 *   restU,restL  rest LOCAL rotations (quaternions) of upper / lower arm
 *   target     desired hand position
 * Returns new LOCAL rotations {upperQ, lowerQ} placing the hand at `target`
 * (clamped to the reachable shell). Verified by fkHand round-trip in tests.
 */
export function solveTwoBone(pU, pL, pH, restU, restL, target, opts = {}) {
  const L1 = vlen(pL), L2 = vlen(pH);
  const restElbow = vadd(pU, qApply(restU, pL));
  const restHand = vadd(restElbow, qApply(qMul(restU, restL), pH));
  const restHandV = vsub(restHand, pU);
  let hinge = vcross(vsub(restElbow, pU), vsub(restHand, restElbow));
  if (vlen(hinge) < 1e-6) hinge = opts.pole || [0, 0, 1];   // straight arm → pole hint
  hinge = vnorm(hinge);
  let d = vlen(vsub(target, pU));
  d = clamp(d, Math.abs(L1 - L2) + 1e-3, (L1 + L2) * 0.999);
  const tdir = vnorm(vsub(target, pU));
  const interior = (dist) => Math.acos(clamp((L1 * L1 + L2 * L2 - dist * dist) / (2 * L1 * L2), -1, 1));
  const dBend = interior(d) - interior(vlen(restHandV));     // elbow delta to hit distance d
  const bendP = qFromAxisAngle(hinge, -dBend);               // bend in parent frame
  const lowerSegBent = qApply(bendP, vsub(restHand, restElbow));
  const handBentV = vadd(vsub(restElbow, pU), lowerSegBent);
  const swingP = qFromUnitVectors(vnorm(handBentV), tdir);   // aim the bent arm at target
  const upperQ = qMul(swingP, restU);
  const hingeChild = qApply(qConj(restU), hinge);            // hinge in upper-arm child space
  const lowerQ = qMul(qFromAxisAngle(hingeChild, -dBend), restL);
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
    const { upperQ, lowerQ } = solveTwoBone(this.geo.pU, this.geo.pL, this.geo.pH, this.restU, this.restL, this.target, { pole: this.pole });
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

    // reach weight: ease to 1 by arrival, hold through dwell, peel back to 0.
    // release exponent grows with P.release → a slow, reluctant let-go (linger).
    let w;
    if (p < tArrive) w = Math.sin((p / tArrive) * (Math.PI / 2));
    else if (p < tDwell) w = 1;
    else w = 1 - Math.pow((p - tDwell) / (1 - tDwell), 1 + P.release * 2.5);
    w = _c01(w);

    // IK target: lerp start→target by reach weight, + a vertical lift arc
    // (hand lifts off then settles down), + a brief downward sink at contact.
    const tgt = [
      this.start[0] + (this.target[0] - this.start[0]) * w,
      this.start[1] + (this.target[1] - this.start[1]) * w,
      this.start[2] + (this.target[2] - this.start[2]) * w,
    ];
    tgt[1] += P.arc * Math.sin(_c01(p / tDwell) * Math.PI);                 // lift arc
    if (p >= tArrive && p < tDwell) tgt[1] -= P.sink * Math.sin(((p - tArrive) / (tDwell - tArrive)) * Math.PI);

    // solve IK + optional forearm twist (ねじ込む), engaged from contact on
    const sol = solveTwoBone(this.geo.pU, this.geo.pL, this.geo.pH, this.restU, this.restL, tgt, { pole: P.pole || this.geo.pole });
    const tw = P.twist * _smooth(tArrive - 0.12, tArrive, p) * (p < 1 ? 1 : 0);
    let lowerQ = sol.lowerQ;
    if (tw) lowerQ = qMul(lowerQ, qFromAxisAngle([0, 1, 0], tw * 0.5 * this.sign));
    buf.set(this.up, qToEulerXYZ(qSlerp(this.restU, sol.upperQ, w)));
    buf.set(this.lo, qToEulerXYZ(qSlerp(this.restL, lowerQ, w)));

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
      const w = Math.sin((p / A) * (Math.PI / 2));
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

    const sol = solveTwoBone(this.geo.pU, this.geo.pL, this.geo.pH, this.restU, this.restL, pos, { pole: P.pole || this.geo.pole });
    buf.set(this.up, qToEulerXYZ(qSlerp(this.restU, sol.upperQ, reachW)));
    buf.set(this.lo, qToEulerXYZ(qSlerp(this.restL, sol.lowerQ, reachW)));

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
    this.springs = {};          // bone → [Spring x3]
    for (const b of MANAGED) {
      const r = restOf(b);
      const f = SPRING_F[b] || 2.4;
      this.springs[b] = [new Spring(f, 0.9, 0, r[0]), new Spring(f, 0.9, 0, r[1]), new Spring(f, 0.9, 0, r[2])];
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
    const c = Object.assign({ dt, phase: 0, t: 0 }, ctx);
    const buf = this._buf;
    buf.reset();
    for (const b of MANAGED) buf.base(b);

    this.idle.apply(buf, c);
    this.emotion.apply(buf, c);
    for (const a of this.actions) a.apply(buf, c);
    this.actions = this.actions.filter((a) => !a.done);

    const pose = {};
    for (const b of MANAGED) {
      const tgt = buf.get(b);
      const sp = this.springs[b];
      pose[b] = [sp[0].update(dt, tgt[0]), sp[1].update(dt, tgt[1]), sp[2].update(dt, tgt[2])];
    }

    // constraint / collision-correction pass (Phase 4): empty for now, but the
    // pipeline runs it every frame so IK reach + obstacle avoidance plug in here
    // without restructuring anything above.
    for (const fn of this.constraints) fn(pose, c);
    return pose;
  }
}
