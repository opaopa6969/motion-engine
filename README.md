**English** · [日本語](./README.ja.md)

# motion-engine

> Procedural human-motion engine for VRM avatars — **natural body action without motion capture.**

Instead of playing back fixed clips (which read as stiff/repetitive and can't adapt to the actual scene), this engine **synthesizes the pose every frame** from a few primitives that combine. It is **pure**: no `three.js` / VRM / DOM imports, no dependencies, deterministic. Inputs are plain numbers + commands; the output is a plain-data **Pose** (`{ boneName: [x, y, z] }`, plus a non-bone `root` key since v0.12 — see [Full-body contract](#full-body-contract-v012)) that your renderer applies to the VRM bones. Because it's renderer-free, it runs **headless** and is unit-tested in Node.

```js
import { MotionEngine, Gesture, Reach } from 'motion-engine';

const engine = new MotionEngine();           // one per avatar
engine.play(new Gesture('fistPump'));         // a one-shot gesture

// each frame:
const pose = engine.update(dt, { t, phase, pose: emotionPose, poseW });
// `phase` (default 0): per-avatar time offset for NoiseIdle — drifts the idle
// breathing/micro-motion out of phase across avatars so a crowd doesn't breathe
// in lockstep.
for (const bone in pose) {
  const node = vrm.humanoid.getNormalizedBoneNode(bone);
  if (node) node.rotation.set(pose[bone][0], pose[bone][1], pose[bone][2]);
}
vrm.update(dt);
```

## Why

`minimal primitives × combinatorial expressiveness`. Natural-looking motion without mocap comes from a handful of building blocks that layer:

| primitive | what it buys |
|---|---|
| **`Spring`** (2nd-order dynamics) | ease / anticipation / overshoot / settle for free — kills the "sin-wave mechanical" feel |
| **NoiseIdle** (incommensurate sines) | breathing, weight shift, micro-drift — a resting body is alive and non-repeating |
| **EmotionPose** | an emotion layer's micro-pose, weighted by its envelope |
| **`Gesture`** | one-shot named gestures, layered (not overwriting) on top of idle |
| **`Reach` + `solveTwoBone`** | analytic two-bone **IK** so a hand reaches an actual world point — the thing a fixed clip can't do |
| **`Place`** (v0.2) | a weight-aware "place a tile" action: windup → torso/shoulder lead + gravity arc → contact (wrist snap + settle sink) → dwell → peel. Style presets make the SAME intent read as そっと置く / ねじ込む / ピシッ / なかなか離さない — the discard as body-language tell |
| **`Grip` + `Pick`** (v0.5) | fingers. `Grip` is an open/close envelope; `Pick` is the whole discard as ONE motion — reach INTO the own hand, fingers close on a tile, sweep it out over the river with a gravity arc, fingers open to release, retract. Drives arm IK + torso + the finger curl together |
| **`RootAct`** (v0.12) | full-body acting: jump/hop/stomp, crouch/kneel/collapse, backstep, ずっこけ, the お辞儀(bow) family, しな, nodOff — root translation + spine bend, upstreamed 1:1 from kamishibai's host-side vocabulary. Layers with everything above like any other action |

All contributions composite into one per-bone target buffer; the springs smooth the result (a lead→lag chain gives overlap = weight); a post-pose **constraint pass** is the seam for collision correction.

## API

- `new MotionEngine()` → `update(dt, ctx)` returns a Pose; `play(action)`, `clear()` (v0.12, drops the queued actions), `syncFrom(pose)`, `addConstraint(fn)`. `ctx.gain` (v0.4, default 1, clamped 0.2–2.5) scales one-shot gesture amplitude — the per-avatar 大袈裟さ.
- `new Gesture(name, dur?, env?)` — `'tsumogiri' | 'headScratch' | 'fistPump' | 'slump' | 'recoil' | 'crossArms' | 'nod' | 'shrug' | 'lean' | 'smirkTilt' | 'sigh' | 'exhale' | 'clap' | 'gutsPose' | 'banzai' | 'fistToForehead' | 'headShakeRue' | 'ponder'`. `env` (v0.8) tunes anticipation/follow-through (`{windup, follow, anticipate, overshoot}`; `{windup:0}` = the plain bell).
- `swingEnv(p, opts?)` (v0.8) — the anticipation+follow-through envelope (windup opposite → swing → settle past rest); the reusable primitive behind gesture/discard "溜め". `Place`/`Pick` take `opts.anticipate` (gather depth, default 0.3).
- `new Reach(side, geo, target, dur?, opts?)` — IK reach; `geo = { pU, pL, pH, restU, restL }` measured from the rig by the host. `opts.pole` (v0.6) — a parent-frame direction the **elbow** is pushed toward (down-and-back for a seated reach); defaults to the rig's natural rest bend.
- `new Place(side, geo, target, opts?)` — v0.2 weight-aware placement. `geo` also takes `restW` (wrist) + `pole`. `opts.style` ∈ `PLACE_STYLES` (`gentle`/`snap`/`linger`/`jam`/`timid`); any of `{ arc, lead, snap, twist, dwell, release, sink, pole, wristAim, anticipate }` override (see `swingEnv` below for `anticipate`). Drives shoulder + wrist too.
- `new Grip(side, opts?)` — (v0.5) standalone finger open/close. `opts = { dur, keys:[[p,curl],…], flexSign, base, span }`; curl 0 = open, 1 = grip. `keys` are smoothstep-interpolated control points.
- `new Pick(side, geo, opts)` — (v0.5) the full discard in one timeline: reach into the own hand → fingers close → sweep out → fingers open → retract. `opts = { grab:[x,y,z], place:[x,y,z], dur?, style?, flexSign?, …Place overrides }`; `grab`/`place` are targets in the upper-arm parent-local frame. The host follows the hand bone each frame to carry the tile mesh.
- `gripPose(side, curl, opts?)` → `{ bone:[x,y,z] }` — finger Euler for a grip amount. `opts.flexSign` (±1) globally flips curl direction for a rig that bends the wrong way.
- `solveTwoBone(pU, pL, pH, restU, restL, target, opts?)` → `{ upperQ, lowerQ }` — pure analytic **pole-vector** IK (v0.6). `opts.pole` places the elbow explicitly (law of cosines) so it tracks consistently as the target sweeps instead of flipping to a shortest-arc accident; exact IK∘FK identity on the reachable shell. `opts.elbow = [min,max]` clamps the interior elbow angle (opt-in joint limit).
- `DEFAULT_BODY` (v0.6) — a suggested `BodyProfile` (`{ elbow:[0.35,2.95], shoulder:2.0 }`); spread its `elbow`/`shoulder` into `Reach`/`Place`/`Pick` opts to enable the joint limits.
- **collision** (v0.7): keep the reaching hand out of obstacles (table, tile wall, river tiles, another hand, own torso). Colliders are plain data in the IK target frame — `{shape:'plane',n,o}` / `{shape:'sphere',c,r}` / `{shape:'capsule',a,b,r}` (each may add its own `margin`). Two ways to use, layer both:
  - **goal-clamp** — pass `opts.colliders` (array or per-frame `()=>array`) to `Reach`/`Place`/`Pick`; the hand's goal is projected outside every collider each frame, so the hand rests on / slides along the surface. Cheap, needs no host wiring.
  - **post-pose** — `engine.addConstraint(makeArmConstraint({ side, geo, colliders, margin }))` FK's the sprung pose and re-IKs the hand out — catches the residual penetration a goal-clamp can't (the sprung hand lags its goal and cuts a corner mid-swing).
  - `projectOut(point, colliders, margin?, passes?)` — the underlying pure projection, exported for host-side use.
- `fkHand(pU, pL, pH, upperQ, lowerQ)` — forward kinematics (the IK round-trip check).
- `new ArmAct(name, geo, dur?)` — (v0.11) intent-driven arm acting from `ARM_ACTS`: hand target, pole, wrist orientation, and finger curl, solved through the same two-bone IK.
- `ARM_ACTS` — the exported arm-acting vocabulary, including `clap`, `gutsPose`, `banzai`, `fistToForehead`, `ponder` and the 14 extra arm acts.
- `makeArmConstraint({ side, geo, colliders, margin })` — post-pose arm collision constraint for `engine.addConstraint`.
- `new RootAct(name, dur?)` — (v0.12) full-body root/trunk acting: `'jump' | 'hop' | 'stomp' | 'crouch' | 'kneel' | 'collapse' | 'backstep' | 'zukkoke' | 'zukkokeLite' | 'bow' | 'bowDeep' | 'bowQuick' | 'bowInsolent' | 'shina' | 'bowSorry' | 'doubletake' | 'nodOff'` — played through `engine.play(...)` exactly like `Gesture`/`ArmAct`. Trunk channels (pitch/hp/sh/yaw/cr/hr) land on `MANAGED` bones (spine/chest/neck/head/shoulders); the true root channels (y/z/tilt/lookDown, none of which are a bone) land on `Pose.root`. See [Full-body contract](#full-body-contract-v012) for the channel table and the sign convention.
- `rhf(p, rise, fall)` — (v0.12) the "rise-hold-fall" trapezoid envelope most `ROOT_ACTS` entries shape themselves with (ramp 0→1 over `rise`, hold, ramp 1→0 over the last `fall`) — root acting reads as WEIGHT (a slow settle, a held bow) more than `swingEnv`'s spring-like anticipation/overshoot.
- `ROOT_ACTS` — the exported vocabulary table (`{ dur, cam?, noLook?, pip?, f(p) }` per entry). `cam`/`noLook`/`pip` are camera/expression HINTS, not motion — motion-engine keeps them as plain data (mirrored onto the `RootAct` instance) for a downstream camera/expression layer to interpret; it never reads them itself.
- helpers: `Spring`, `MANAGED`, `REST`, `FINGER_BONES`, `GESTURE_DUR`, `qFromEulerXYZ`, `qToEulerXYZ` (Euler uses three.js `'XYZ'` order).

## Full-body contract (v0.12)

Through v0.11 this engine was upper-body only — no root translation, no spine bend. That acting vocabulary (jump/crouch/kneel/bow/しな/…) lived instead in the *host* (kamishibai's `tools/vrm/host.html`, `ROOT_ACTS`). v0.12 upstreams it as `RootAct`, so it composes with `Gesture`/`ArmAct` through the same `engine.play(...)` queue instead of living beside them. Two compatibility rules made this additive, not breaking:

1. **`neck` joined `MANAGED`.** `RootAct`'s trunk-bend distribution needs somewhere to put its share of a bow's forward lean, spread over the whole spine chain the way a real back rounds. A consumer that doesn't know about `neck` simply never reads `pose.neck` — nothing else changes shape.
2. **`root` is a separate, non-bone key on `Pose`**, never a bone name: `pose.root = { y, z, tilt, lookDown }`. A `getNormalizedBoneNode('root')`-style lookup returns `null` for it (exactly like any other unrecognized name), so the common consumer pattern (`for (const bone in pose) { const node = vrm.humanoid.getNormalizedBoneNode(bone); if (node) ... }`) skips it automatically. `pose.root` is present (all-zero) even with no `RootAct` queued, so a host that wants it can read it unconditionally.

**Channel table** (the shape `ROOT_ACTS[name].f(p)` returns; any subset may be present):

| channel | meaning | where it lands |
|---|---|---|
| `y`, `z` | root translation (up, forward/back) | `Pose.root.y` / `Pose.root.z` — not a bone |
| `yaw` | head yaw (e.g. a double-take shake) | `head` bone, y-axis |
| `pitch` | trunk forward bend | split `spine 0.35 / chest 0.30 / neck 0.20 / head 0.15` (CMU-calibrated, ported verbatim from kamishibai) |
| `tilt` | whole-body side lean/roll | `Pose.root.tilt` — not a bone (a host applies it to the avatar root, e.g. `scene.rotation.z`) |
| `sh` | shoulders drawn up symmetrically (肩すぼめ) | `leftShoulder`/`rightShoulder`, z-axis, opposite signs |
| `hp` | an EXTRA pitch on the head alone, on top of `pitch` | `head` bone, x-axis |
| `cr` | chest roll (the しな S-curve) | `chest` bone, z-axis |
| `hr` | head roll (the しな counter-twist) | `head` bone, z-axis |
| `lookDown` | bridge value 0..1 for the VRM standard expression `lookDown` | `Pose.root.lookDown` — not a bone |

**Sign convention:** `pitch`/`hp` are always **positive = forward bend**, applied unflipped — this already matches this engine's own existing convention (compare `Gesture`'s `lean`, which also uses `+spine`/`+chest` for "lean forward"). kamishibai's `host.html` separately multiplies by a `BOW_SIGN = -1` before writing the bone; that is a quirk of *its own* pipeline (empirically measured 2026-07-12: its physics chain, `xpbd-body`, flips the sign somewhere between target-pose and applied-pose), **not** a motion-engine convention. Any host whose own rig/physics pipeline needs an equivalent correction applies it in *its* application layer, the same way kamishibai does. `cr`/`hr` are likewise unmirrored here — kamishibai additionally flips them by the character's screen-seat side, a staging decision that belongs to the host.

**`cam`/`noLook`/`pip`** metadata on a `ROOT_ACTS` entry (camera pull-back during a deep bow/crouch, suppress eye-tracking while bowing, mark a reaction-inset candidate) are exposed as plain data (`RootAct#cam`/`#noLook`/`#pip`) for a downstream camera/expression layer to read — motion-engine itself never interprets them.

**`schemaVersion`:** not added to `Pose` in v0.12 — the shape is still versioned by the package version, and the `root`-key addition is purely additive (rule 2 above), so there was no compatibility need forcing the issue. Revisit if a future breaking change to `Pose`'s shape needs an explicit marker.

## Use via CDN (no build step)

```html
<script type="importmap">
{ "imports": { "motion-engine": "https://cdn.jsdelivr.net/gh/opaopa6969/motion-engine@v0.1.0/index.js" } }
</script>
```

## MCP

motion-engine is available as an [MCP](https://modelcontextprotocol.io/) server (namespace `motion`) via the [volta-mcp](https://github.com/opaopa6969/volta-mcp) facade. Tools: `step`, `play`, `clear`, `solve_ik`, `grip_pose`, `list_acts`. Resources: `motion://spec`, `motion://guide`, `motion://pose_schema`. See [docs/mcp/DESIGN.md](docs/mcp/DESIGN.md) for the full spec.

```sh
node mcp/server.mjs --http 9201   # PORT env also supported
node mcp/test.mjs                  # e2e tests
```

## Test

```sh
node test.mjs     # or: npm test
node mcp/test.mjs # MCP e2e
```

Headless: deterministic pose stream, spring stability, gesture settle, and `IK ∘ FK = identity` (the solver lands the hand on the target).

## Benchmark

```sh
node bench.mjs    # or: npm run bench
```

Headless micro-benchmark of the per-frame hot path (`MotionEngine.update`) and its primitives, measured with `process.hrtime.bigint()` on Node 20, `linux/x64`. Methodology: 30k warmup iters, then 5×100k iters, report min/median ns/op (`fps-budget` = `1e9 / (1/60) / ns-per-op`, the headroom multiple of 60fps if this op were the whole frame).

| operation | baseline | optimized | Δ |
|---|---|---|---|
| `MotionEngine.update` (idle)              | 17.8 µs | 9.6 µs  | **-46%** |
| `MotionEngine.update` (1 Gesture)         | 18.0 µs | 9.3 µs  | **-48%** |
| `MotionEngine.update` (idle, `reusePose`) | 17.8 µs | 8.2 µs  | **-54%** |
| `Spring.update` (1 axis)                  |  17 ns  | 17 ns   | unchanged |
| `TargetBuffer reset+base` (42 bones)       |  5.0 µs | 3.8 µs  | **-24%** |

**What changed (v0.13 perf):** the per-frame hot path no longer allocates.
- `TargetBuffer` pre-seeds one mutable 3-array per managed bone and resets in place — `reset()` also reinitializes to rest values, folding a redundant 42-iteration zero-then-overwrite loop into one pass.
- `NoiseIdle` / `EmotionPose` use a scalar-arg `add3()` so the always-on layers never allocate a `[x,y,z]` literal per `add()`.
- `update()` reuses one `ctx`-shaped object across frames instead of `Object.assign`.
- The output loop uses in-place `qFromEulerXYZInto` / `qToEulerXYZInto` for the QuatSpring arm chain, eliminating 4 quat allocations per frame.
- **`new MotionEngine({ reusePose: true })`** opts into reusing the returned `pose` object + per-bone arrays across frames (42 fewer array allocations + 1 object per frame). OFF by default — the unit tests hold multiple frames' poses simultaneously (which a reused `pose` would corrupt); a renderer that consumes `pose` within the frame and discards the reference can opt in.

For comparison: `@pixiv/three-vrm`'s `vrm.update` (spring bone + bone updates, model-dependent) is measured at ~95µs–3.2ms/frame ([three-vrm PR #1539](https://github.com/pixiv/three-vrm/pull/1539), MIT, retrieved 2026-08-16); three.js `AnimationMixer.update` + `Skeleton.update` for a 25-bone model is hundreds of µs/frame ([three.js discourse #58196](https://discourse.threejs.org/t/optimization-of-large-amounts-100-1000-of-skinned-meshes-cpu-bottlenecks/58196), retrieved 2026-08-16). motion-engine's `update` at ~8–10µs/frame (42 bones, pure scalar) is well under one AnimationMixer's worth — it leaves the full 16.67ms 60fps budget essentially untouched.

## Status

Used by [netmahg](https://github.com/opaopa6969/netmahg) (3D mahjong). Scope: seated upper-body action, plus full-body acting since v0.12 (see below). **v0.3** adds a richer one-shot gesture set (recoil / crossArms / nod / shrug / lean / smirkTilt) so reactions and tells read as body language. **v0.4** adds `ctx.gain` — a per-avatar reaction amplitude (大袈裟さ) the host feeds from personality, so the *same* gesture reads as a reserved flinch or full-slapstick recoil depending on character (recoil is also beefed up to suit). **v0.6** rewrites the IK core to a **pole-vector solver**: the elbow is placed explicitly instead of drifting with a shortest-arc swing, killing the "unnatural elbow flip" during reaches — while keeping exact IK∘FK identity.

**v0.6** also smooths the arm chain in **orientation space** (a `QuatSpring`) instead of springing three Euler axes independently — the axes couple/gimbal on a big swing and read as a jolt; the SO(3) spring tracks the target quaternion shortest-path, so reaches swing smoothly (bounded jerk, tested). And it fills the `BodyProfile` seam with an opt-in **elbow joint limit** (`DEFAULT_BODY.elbow`) — a reach stops short of a hyperextended or over-folded arm instead of hitting anatomy-breaking poses.

**v0.7** adds **collision correction** (the `addConstraint` seam is now filled): the reaching hand is kept out of arbitrary obstacles — the table, the tile wall, the discarded tiles in the river, another player's hand, the avatar's own torso — via plain-data colliders the host feeds in. Two layers: a cheap per-frame **goal-clamp** on the action (`opts.colliders`) and a robust **post-pose re-IK** constraint (`makeArmConstraint`) that catches spring-lag penetration.

**v0.8** adds **anticipation + follow-through** — the two animation principles the raw sin-bell lacked. A body now GATHERS before it acts and OVERSHOOTS before it settles: one-shot gestures use `swingEnv` (windup opposite → swing → settle past rest), and `Place`/`Pick` gather the hand backward before the reach (`opts.anticipate`, default 0.3; 0 opts out). The envelope is one tunable primitive, so the SAME knob later dials from realistic (small) to anime-exaggerated (big) — the seam for the "誇張" half of the goal.

**v0.9** adds a **shoulder-cone joint limit** (`opts.shoulder`, `DEFAULT_BODY.shoulder`) — the upper arm can't swing past an anatomical cone from rest — and extends the collision constraint to the **whole arm**: `makeArmConstraint` now lifts the FOREARM segment (elbow→hand) out of a collider, not just the fingertip, so a limb swept across the body rides over a torso capsule (self-collision, the plain-data path that pairs with xpbd-body). **v0.9.1** makes `QuatSpring` **substep large frame gaps** — a dropped frame / a slow (~5fps) headless render no longer lets the stiffness term fling the arm past its target and flip (caught by in-engine screenshot QA); at 60fps it's exactly one step, so normal playback is byte-identical.

**v0.11** adds `ArmAct` — acting BY INTENT (a hand target + a pole + a wrist orientation + a finger curl), not by hand-tuned Euler deltas, so multi-axis arm poses (clap, banzai, ガッツポーズ, …) get anatomically-guaranteed elbows via the same solver as `Reach`/`Place`.

**v0.12** is the **full-body-ification**: `RootAct` upstreams kamishibai's host-side root/trunk acting vocabulary (jump/crouch/kneel/collapse/backstep/ずっこけ/the お辞儀 family/しな/nodOff — 17 acts) as a first-class primitive, and `ARM_ACTS` gains 14 more hand/arm acts (cheekHands/coverFace/throatHand/beckon/salute/waveHand/raiseHand/chestHand/handsFolded/armsColdClench/handOnHip/fightFists/guardFists/pointScreen) upstreamed from kamishibai's own `arm-acts-extra.js`, which had always self-documented as vendored-motion-engine-plus-injection — i.e. it was always meant to land here. See [Full-body contract](#full-body-contract-v012) for the new `Pose.root` key and the compatibility rules that make this additive, not breaking.

Roadmap (next): (1) **wrist world-leveling** so a placed tile lies flat on the table (rig-specific — tuned in-engine). (2) host wiring: feed real tile/wall/torso colliders + measured elbow pole from `render3d`, bump the importmap to the new tag, and visually tune (the game-side integration). (3) retire kamishibai's own vendored `ROOT_ACTS`/`arm-acts-extra.js` copies now that the upstream has them (tracked separately — a host-side change, out of scope here).

## License

MIT
