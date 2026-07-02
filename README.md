# motion-engine

> Procedural human-motion engine for VRM avatars — **natural body action without motion capture.**

Instead of playing back fixed clips (which read as stiff/repetitive and can't adapt to the actual scene), this engine **synthesizes the pose every frame** from a few primitives that combine. It is **pure**: no `three.js` / VRM / DOM imports, no dependencies, deterministic. Inputs are plain numbers + commands; the output is a plain-data **Pose** (`{ boneName: [x, y, z] }`) that your renderer applies to the VRM bones. Because it's renderer-free, it runs **headless** and is unit-tested in Node.

```js
import { MotionEngine, Gesture, Reach } from 'motion-engine';

const engine = new MotionEngine();           // one per avatar
engine.play(new Gesture('fistPump'));         // a one-shot gesture

// each frame:
const pose = engine.update(dt, { t, phase, pose: emotionPose, poseW });
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

All contributions composite into one per-bone target buffer; the springs smooth the result (a lead→lag chain gives overlap = weight); a post-pose **constraint pass** is the seam for collision correction.

## API

- `new MotionEngine()` → `update(dt, ctx)` returns a Pose; `play(action)`, `syncFrom(pose)`, `addConstraint(fn)`. `ctx.gain` (v0.4, default 1, clamped 0.2–2.5) scales one-shot gesture amplitude — the per-avatar 大袈裟さ.
- `new Gesture(name, dur?, env?)` — `'tsumogiri' | 'headScratch' | 'fistPump' | 'slump'` and (v0.3) `'recoil' | 'crossArms' | 'nod' | 'shrug' | 'lean' | 'smirkTilt'`. `env` (v0.8) tunes anticipation/follow-through (`{windup, follow, anticipate, overshoot}`; `{windup:0}` = the plain bell).
- `swingEnv(p, opts?)` (v0.8) — the anticipation+follow-through envelope (windup opposite → swing → settle past rest); the reusable primitive behind gesture/discard "溜め". `Place`/`Pick` take `opts.anticipate` (gather depth, default 0.3).
- `new Reach(side, geo, target, dur?, opts?)` — IK reach; `geo = { pU, pL, pH, restU, restL }` measured from the rig by the host. `opts.pole` (v0.6) — a parent-frame direction the **elbow** is pushed toward (down-and-back for a seated reach); defaults to the rig's natural rest bend.
- `new Place(side, geo, target, opts?)` — v0.2 weight-aware placement. `geo` also takes `restW` (wrist) + `pole`. `opts.style` ∈ `PLACE_STYLES` (`gentle`/`snap`/`linger`/`jam`/`timid`); any of `{ arc, lead, snap, twist, dwell, release, sink, pole, wristAim }` override. Drives shoulder + wrist too.
- `new Grip(side, opts?)` — (v0.5) standalone finger open/close. `opts = { dur, keys:[[p,curl],…], flexSign, base, span }`; curl 0 = open, 1 = grip. `keys` are smoothstep-interpolated control points.
- `new Pick(side, geo, opts)` — (v0.5) the full discard in one timeline: reach into the own hand → fingers close → sweep out → fingers open → retract. `opts = { grab:[x,y,z], place:[x,y,z], dur?, style?, flexSign?, …Place overrides }`; `grab`/`place` are targets in the upper-arm parent-local frame. The host follows the hand bone each frame to carry the tile mesh.
- `gripPose(side, curl, opts?)` → `{ bone:[x,y,z] }` — finger Euler for a grip amount. `opts.flexSign` (±1) globally flips curl direction for a rig that bends the wrong way.
- `solveTwoBone(pU, pL, pH, restU, restL, target, opts?)` → `{ upperQ, lowerQ }` — pure analytic **pole-vector** IK (v0.6). `opts.pole` places the elbow explicitly (law of cosines) so it tracks consistently as the target sweeps instead of flipping to a shortest-arc accident; exact IK∘FK identity on the reachable shell. `opts.elbow = [min,max]` clamps the interior elbow angle (opt-in joint limit).
- `DEFAULT_BODY` (v0.6) — a suggested `BodyProfile` (`{ elbow:[0.35,2.95] }`); spread its `elbow` into `Reach`/`Place`/`Pick` opts to enable the joint limit.
- **collision** (v0.7): keep the reaching hand out of obstacles (table, tile wall, river tiles, another hand, own torso). Colliders are plain data in the IK target frame — `{shape:'plane',n,o}` / `{shape:'sphere',c,r}` / `{shape:'capsule',a,b,r}` (each may add its own `margin`). Two ways to use, layer both:
  - **goal-clamp** — pass `opts.colliders` (array or per-frame `()=>array`) to `Reach`/`Place`/`Pick`; the hand's goal is projected outside every collider each frame, so the hand rests on / slides along the surface. Cheap, needs no host wiring.
  - **post-pose** — `engine.addConstraint(makeArmConstraint({ side, geo, colliders, margin }))` FK's the sprung pose and re-IKs the hand out — catches the residual penetration a goal-clamp can't (the sprung hand lags its goal and cuts a corner mid-swing).
  - `projectOut(point, colliders, margin?, passes?)` — the underlying pure projection, exported for host-side use.
- `fkHand(pU, pL, pH, upperQ, lowerQ)` — forward kinematics (the IK round-trip check).
- helpers: `Spring`, `MANAGED`, `REST`, `FINGER_BONES`, `GESTURE_DUR`, `qFromEulerXYZ`, `qToEulerXYZ` (Euler uses three.js `'XYZ'` order).

## Use via CDN (no build step)

```html
<script type="importmap">
{ "imports": { "motion-engine": "https://cdn.jsdelivr.net/gh/opaopa6969/motion-engine@v0.1.0/index.js" } }
</script>
```

## Test

```sh
node test.mjs     # or: npm test
```

Headless: deterministic pose stream, spring stability, gesture settle, and `IK ∘ FK = identity` (the solver lands the hand on the target).

## Status

Used by [netmahg](https://github.com/opaopa6969/netmahg) (3D mahjong). Scope: seated upper-body action. **v0.3** adds a richer one-shot gesture set (recoil / crossArms / nod / shrug / lean / smirkTilt) so reactions and tells read as body language. **v0.4** adds `ctx.gain` — a per-avatar reaction amplitude (大袈裟さ) the host feeds from personality, so the *same* gesture reads as a reserved flinch or full-slapstick recoil depending on character (recoil is also beefed up to suit). **v0.6** rewrites the IK core to a **pole-vector solver**: the elbow is placed explicitly instead of drifting with a shortest-arc swing, killing the "unnatural elbow flip" during reaches — while keeping exact IK∘FK identity.

**v0.6** also smooths the arm chain in **orientation space** (a `QuatSpring`) instead of springing three Euler axes independently — the axes couple/gimbal on a big swing and read as a jolt; the SO(3) spring tracks the target quaternion shortest-path, so reaches swing smoothly (bounded jerk, tested). And it fills the `BodyProfile` seam with an opt-in **elbow joint limit** (`DEFAULT_BODY.elbow`) — a reach stops short of a hyperextended or over-folded arm instead of hitting anatomy-breaking poses.

**v0.7** adds **collision correction** (the `addConstraint` seam is now filled): the reaching hand is kept out of arbitrary obstacles — the table, the tile wall, the discarded tiles in the river, another player's hand, the avatar's own torso — via plain-data colliders the host feeds in. Two layers: a cheap per-frame **goal-clamp** on the action (`opts.colliders`) and a robust **post-pose re-IK** constraint (`makeArmConstraint`) that catches spring-lag penetration.

**v0.8** adds **anticipation + follow-through** — the two animation principles the raw sin-bell lacked. A body now GATHERS before it acts and OVERSHOOTS before it settles: one-shot gestures use `swingEnv` (windup opposite → swing → settle past rest), and `Place`/`Pick` gather the hand backward before the reach (`opts.anticipate`, default 0.3; 0 opts out). The envelope is one tunable primitive, so the SAME knob later dials from realistic (small) to anime-exaggerated (big) — the seam for the "誇張" half of the goal.

Roadmap (next, for "less mechanical"): (1) shoulder-cone limit + wrist world-leveling so a placed tile lies flat. (2) self-collision capsules driven from xpbd-body. (3) host wiring: feed real tile/wall/torso colliders + measured elbow pole from `render3d` (the game-side integration + in-engine visual tuning).

## License

MIT
