**English** · [日本語](./from-theory-to-model.ja.md)

# From theory to engine/model — motion-engine design doc

Intended reader: someone who can implement things. This describes, in terms of the actual current implementation, how the theory — "2nd-order dynamics · superposition of incommensurate sine waves · layered composition of a small set of primitives" — is translated into concrete code in `index.js`. Not a pie-in-the-sky design doc; the design rationale for code that is running right now.

The theory's three pillars, and the implementation that carries each:

| theory | implementation |
|---|---|
| 2nd-order dynamics (spring-damper) | `Spring` / `QuatSpring` |
| superposition of incommensurate sine waves | `noise()` / `NoiseIdle` |
| layered composition of a small set of primitives | `TargetBuffer` + the `MotionEngine.update` pipeline |

The design constraints this all sits under are the same as the README: **pure / zero dependencies / no `three.js`, VRM, or DOM imports / deterministic (`Math.random` forbidden) / unit-testable headless**. The output is a plain-data Pose with bone rotations `{ boneName: [x,y,z] }` (radians, normalized VRM local space, three.js `'XYZ'` Euler order) plus the non-bone `root` record `{ y, z, tilt, lookDown }`. The host-side renderer applies bone records to the VRM and may apply `root` to its avatar root / expression layer.

---

## 1. 2nd-order system → Spring's discrete update equation

The theory: "integrate a 2nd-order system (mass-spring-damper) heading toward a target, and acceleration, overshoot, and settle come for free." This gets laid over every bone instead of a flat sine.

### Scalar version: `Spring`

Three parameters:

- `f` — natural frequency (Hz-ish). Larger = snappier.
- `zeta` — damping ratio. `1` = critically damped (no overshoot), `<1` = bouncy.
- `r` — response. `0` is honest tracking, `>0` looks ahead, `<0` lags lazily.

Internal coefficients (`setParams`):

```
w  = 2π f
k1 = zeta / (π f)          // velocity damping term
k2 = 1 / w²                // inertia term
k3 = (r zeta) / w          // target-velocity lookahead
```

The update equation is semi-implicit integration. The velocity of the target `x` is estimated by finite difference, a **stabilizing clamp** is applied to `k2`, and then the 2nd-order system is advanced one step:

```
xd = (x - this.x) / dt                      // estimate target velocity
k2 = max(k2, 1.1·(dt²/4 + dt·k1/2))         // lower bound so a big dt can't blow up
y  += dt · yd
yd += dt·(x + k3·xd - y - k1·yd) / k2
```

The `k2` clamp is the crux. Even if `dt` spikes (e.g. returning from a backgrounded tab), raising the inertia term's lower bound in proportion to `dt` keeps the integration from exploding. A test feeds it a 100-second `dt` spike and confirms no NaN / no divergence.

### Orientation version: `QuatSpring` (v0.6)

Only the arm chain (shoulder→upperArm→lowerArm→hand) has a problem: **spring-tracking the 3 Euler axes independently lets the axes couple/gimbal and jerk**. So it's promoted to a 2nd-order system on SO(3):

1. Take the **geodesic error** between the target quaternion `qT` and the current `q` down to a rotation vector: `e = log(qT · conj(q))` (shortest path, `|angle| ≤ π`).
2. Apply a critically-damped spring to the angular velocity `w` (`kp = wn²`, `kd = 2·zeta·wn`). The damping term is made semi-implicit for unconditional stability: `w = (w + h·kp·e) / (1 + h·kd)`.
3. Integrate with `q = normalize(exp(w·h) · q)`.

**Substepping (v0.9.1)**: a single frame's `dt` is chopped into `1/60` increments. Even over a large gap like 5fps, `kp·e·h` stays small, which stops the stiffness term from overshooting the target and flipping the arm. At 60fps it's exactly one step, so normal playback is byte-identical (no regression). Huge gaps are clamped to `0.25s` first.

### Which bones get smoothed which way

- `QUAT_SMOOTH` (the arm chain's 8 bones) → `QuatSpring`
- everything else (torso pitch, head drift, single-axis finger curl) → per-axis `Spring` × 3

Frequencies are designed as a lead→lag **chain** (`SPRING_F`): proximal joints are fast (shoulder 3.0), distal joints are slow (hand 1.9). When the target moves, the effect propagates from shoulder to hand with a lag, and this **overlap is the first cue for "weight."** Fingers are light and fast (4.2).

---

## 2. Choosing incommensurate frequencies → noise / NoiseIdle

The theory: "add sine waves whose periods don't divide evenly, and the shape never repeats." The implementation, `noise(t, seed)`:

```js
sin(t·0.91 + seed)·0.6 + sin(t·1.73 + seed·1.7)·0.3 + sin(t·2.39 + seed·2.3)·0.1
```

Guidelines for choosing them:

- **Keep the frequency ratios away from simple rational approximations.** `0.91 / 1.73 / 2.39` are not simple integer ratios of each other. A simple ratio means a short common period, and the loop becomes visible.
- **Amplitudes form a decaying series** (`0.6 / 0.3 / 0.1`). The low frequency is the main component; the high frequency is fine jitter. They sum to `1.0`.
- **`seed` decorrelates each channel.** The same `noise` gets reused across the head's 3 axes and both arms, but with different `seed`s (head: 1.3/4.1/7.7, arms: 2.2/5.6), so joints don't move in lockstep.
- **`Math.random` is never used.** Randomness would break determinism and testability. Sine superposition alone satisfies "smooth, non-repeating, cheap, deterministic" all at once.

`NoiseIdle` is the always-on "living rest": torso breathing (`sin(t·1.5)` ≈ 0.24Hz), head drift, small shoulder weight-shift. **Amplitude stays small** (if it reads as visibly swaying, that's a failure — the goal is only "not a statue"). It's stateless, computed purely from `ctx.t + ctx.phase`.

---

## 3. Layered composition → TargetBuffer, composition order, and weights

The theory: "layer a small set of primitives." The core of the implementation is `TargetBuffer`: a per-frame **target-pose accumulator**. Two write modes:

- `add(bone, [dx,dy,dz], w)` — an **additive offset** on top of rest (idle, emotion, gesture). Layers don't overwrite; they **sum**.
- `set(bone, e)` — a **hard overwrite** (the IK family: Reach/Place/Pick/ArmAct). Records the bone in the `overridden` set, so subsequent `add` calls on that bone are ignored (IK wins).

Each bone in `MANAGED` starts every frame from `base(bone)` (= laying down `REST`), then composes in this order (`MotionEngine.update`):

```
rest(base) → NoiseIdle → EmotionPose → actions[] → (spring smoothing) → constraints[]
```

**Rationale for the composition order and weights**:

1. **Idle / emotion are additive** (a sense of being alive, and emotion, always ride underneath as a base layer). The emotion layer scales by the envelope weight `ctx.poseW`.
2. **Gesture is also additive**, "layering" on top of idle (it used to overwrite the arms, which killed breathing). Amplitude is scaled by `ctx.gain` (clamped 0.2–2.5) = the per-character "over-the-topness." Each axis is clamped to `±2 rad` so gain can't blow the spring up.
3. **IK actions use `set`.** The reach point can't be expressed additively (you can't place a hand at a specific world coordinate by summing joint angles), so this is the one place a last-writer-wins overwrite happens.
4. **Spring smoothing** tracks the target last. This is where ease/overshoot/chain-lag actually appear. **Composition builds the ideal target; smoothing supplies the physics** — that's the division of labor.
5. **`constraints[]`** (post-pose) run after smoothing. They're the seam that pushes the hand back out via FK→re-IK when the spring's lag lets it fail to catch up to the goal and dig into an obstacle.

---

## 4. Data structures

### Pose (output)

```
{ [boneName]: [x, y, z], root: { y, z, tilt, lookDown } }
// bone values: Euler radians, three.js 'XYZ' order, normalized VRM local
```

Bone keys are listed in `MANAGED`; `root` is deliberately not a bone name and is always present, zeroed when no `RootAct` is active. Bones the VRM doesn't have (clavicle is optional; some hands have fewer finger joints) simply fall through as `getNormalizedBoneNode → null` on the renderer side, so it's safe to enumerate the full set. A host that enumerates all pose keys must skip `root` or check for a bone node before applying rotation.

### Rig geometry (IK input)

The IK family takes everything in the upper-arm's **parent-local frame** (to keep the engine three-free, the host measures it once and passes it in):

```
geo = { pU, pL, pH,          // shoulder position / elbow offset / wrist offset
        restU, restL,        // upper/lower rest local rotation (Euler)
        restW?, pole?,       // wrist rest / elbow pole direction
        basis? }             // {out, up, front} unit vectors, for ArmAct
```

`DEFAULT_BODY` is a suggested `BodyProfile` (`elbow:[0.35,2.95]`, `shoulder:2.0`). It's spread into action opts as an opt-in joint limit.

### Primitives (actions)

Each action has an `apply(buf, ctx)` and a common shape: it self-advances via `t += ctx.dt`, and sets `done` once `p = t/dur ≥ 1`. `MotionEngine.update` filters `done` actions every frame.

- **`Gesture`** — a named one-shot bit. `GESTURES[name](e, p)` returns a bone delta, multiplied by the `swingEnv` envelope `e`, and `buf.add`s it.
- **`ArmAct`** (v0.11) — acts out an intent. Instead of joint-angle deltas, it specifies "hand target + pole + wrist + curl" in rig-independent **arm-length units × basis**, and solves the joints via `solveTwoBone` (no more elbow flip).
- **`Reach` / `Place` / `Pick`** — IK reach / weight-aware placement / the whole grab-carry-place sequence. Solves `solveTwoBone` every frame and `set`s.
- **`Grip`** — finger open/close envelope. Control points `keys=[[p,curl],…]` interpolated with smoothstep.
- **`Spring` / `QuatSpring`** — smoothing components (held by the engine, not an action).

### Anticipation/follow-through: `swingEnv` (v0.8)

The one tunable primitive for the "gather" and "overshoot" the raw sine bell lacked:

```
0 →(windup, opposite direction)→ −anticipate →(main swing)→ +1 →(settle)→ −overshoot → 0
```

`windup/follow` are the fraction of the lifetime spent on gather/follow; `anticipate/overshoot` are their depth. **The same knob is later the seam that dials between "realistic (small)" and "anime-exaggerated (large)."** Gestures that are flexion-dominant (where a reverse bend would show) opt out of the negative phase via `GESTURE_ENV`.

### The IK solver `solveTwoBone` (v0.6)

A purely analytic **pole-vector** two-bone IK. It places the elbow **explicitly** using the law of cosines inside "the plane spanned by the shoulder→target line and the pole," so as the target sweeps, the elbow consistently tracks toward the pole side (no more flipping on a shortest-arc accident). Each bone swings from its rest direction to the solved direction via the minimal twist, so **IK∘FK is exactly the identity on the reachable shell** (tested). Opt-in `elbow` (elbow-angle clamp) and `shoulder` (shoulder-cone limit).

---

## 5. Testing approach

`test.mjs`, run via `node test.mjs` (= `npm test`). The design's central claim is **you need neither a browser nor three.js**. What it checks:

1. **Determinism** — the same input produces a byte-identical pose stream (proof there's no `Math.random`).
2. **Well-formedness** — every `MANAGED` bone and every `Pose.root` channel is finite every frame.
3. **Idle is alive** — the head actually drifts (`>0.01`) but doesn't run wild (bounded `<0.3`).
4. **One-shot gestures settle** — a gesture reaches its peak and then returns to within `<0.08` of rest.
5. **Spring stability** — no NaN / divergence under a huge `dt` spike.
6. **Emotion shows up** — the micro-pose scaled by `poseW` appears on the head.
7. **IK∘FK = identity** — the solver lands the hand exactly on the target (on the reachable shell).

Principle for adding a new primitive: **(a) it must be drivable headless** (`apply(buf, ctx)` takes only numbers and plain data), **(b) deterministic** (no randomness; time comes from `ctx.t/phase`), **(c) its invariants are asserted** (it settles / stays bounded / IK lands on target / the spring doesn't diverge). Satisfy these three and it plugs into the existing pipeline with no restructuring.
