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

All contributions composite into one per-bone target buffer; the springs smooth the result (a lead→lag chain gives overlap = weight); a post-pose **constraint pass** is the seam for collision correction.

## API

- `new MotionEngine()` → `update(dt, ctx)` returns a Pose; `play(action)`, `syncFrom(pose)`, `addConstraint(fn)`.
- `new Gesture(name, dur?)` — `'tsumogiri' | 'headScratch' | 'fistPump' | 'slump'`.
- `new Reach(side, geo, target, dur?, opts?)` — IK reach; `geo = { pU, pL, pH, restU, restL }` measured from the rig by the host.
- `new Place(side, geo, target, opts?)` — v0.2 weight-aware placement. `geo` also takes `restW` (wrist) + `pole`. `opts.style` ∈ `PLACE_STYLES` (`gentle`/`snap`/`linger`/`jam`/`timid`); any of `{ arc, lead, snap, twist, dwell, release, sink, pole, wristAim }` override. Drives shoulder + wrist too.
- `solveTwoBone(pU, pL, pH, restU, restL, target, opts?)` → `{ upperQ, lowerQ }` — pure analytic IK.
- `fkHand(pU, pL, pH, upperQ, lowerQ)` — forward kinematics (the IK round-trip check).
- helpers: `Spring`, `MANAGED`, `REST`, `GESTURE_DUR`, `qFromEulerXYZ`, `qToEulerXYZ` (Euler uses three.js `'XYZ'` order).

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

Used by [netmahg](https://github.com/opaopa6969/netmahg) (3D mahjong). Scope: seated upper-body action. Roadmap: events→action wiring, collision-correction constraint pass.

## License

MIT
