// motion-engine micro-benchmark — measures the hot path (MotionEngine.update)
// and the key primitives it runs every frame. Headless, deterministic, no
// external deps. Run: `node bench.mjs`
//
// What we measure:
//   1. end-to-end: a single MotionEngine.update(dt, ctx) at 60fps (idle only)
//   2. end-to-end: same but with one Gesture active (actions path)
//   3. primitive: Spring.update (per-axis) — most bones take 3 of these
//   4. primitive: QuatSpring.update (the arm chain, 4 bones)
//   5. primitive: TargetBuffer reset+base (the per-frame setup loop)
//
// Methodology: warmup until times stabilize, then measure N iterations across
// K repeats and report the min/median (min = best-case, least noise). All times
// are ns/op unless noted. We also compute "frames per second" assuming the
// measured op is the only thing in a 1/60 budget — purely for intuition.
import { MotionEngine, Gesture, Spring, MANAGED, REST } from './index.js';

const NS = 1e9;          // ns per second
const FRAME_60 = 1 / 60; // seconds

function bench(name, fn, { iters = 100_000, repeats = 5, warmup = 30_000 } = {}) {
  // warmup
  for (let i = 0; i < warmup; i++) fn(i);
  const results = [];
  for (let r = 0; r < repeats; r++) {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < iters; i++) fn(i);
    const t1 = process.hrtime.bigint();
    results.push(Number(t1 - t0) / iters); // ns/op
  }
  results.sort((a, b) => a - b);
  const min = results[0];
  const med = results[Math.floor(results.length / 2)];
  const fps = NS / FRAME_60 / min; // hypothetical 60fps-budget fps
  return { name, min, med, fps, iters, repeats };
}

function fmt(r) {
  const ns = r.min.toFixed(1).padStart(8);
  const med = r.med.toFixed(1).padStart(8);
  const fps = r.fps.toFixed(0).padStart(10);
  return `  ${r.name.padEnd(40)} min=${ns} ns/op  med=${med}  (${fps} fps-budget)`;
}

console.log(`node ${process.version}  ${process.platform}/${process.arch}`);
console.log(`MANAGED bones: ${MANAGED.length}  (${[...MANAGED].filter(b=>b.match(/Thumb|Index|Middle|Ring|Little/)).length} fingers)`);
console.log('');

// --- end-to-end: idle-only update at 60fps ------------------------------------
{
  const eng = new MotionEngine();
  let i = 0;
  const r = bench('MotionEngine.update (idle)', () => {
    eng.update(FRAME_60, { t: i * FRAME_60, phase: 0, pose: {}, poseW: 0 });
    i++;
  });
  console.log(fmt(r));
}
// --- end-to-end: one Gesture active (the actions path) ------------------------
{
  const eng = new MotionEngine();
  eng.play(new Gesture('fistPump'));
  let i = 0;
  const r = bench('MotionEngine.update (1 Gesture)', () => {
    eng.update(FRAME_60, { t: i * FRAME_60, phase: 0, pose: {}, poseW: 0 });
    i++;
    if (eng.actions.length === 0) eng.play(new Gesture('fistPump'));
  });
  console.log(fmt(r));
}
// --- end-to-end: idle, reusePose=true (output allocations eliminated) ---------
{
  const eng = new MotionEngine({ reusePose: true });
  let i = 0;
  const r = bench('MotionEngine.update (idle, reusePose)', () => {
    eng.update(FRAME_60, { t: i * FRAME_60, phase: 0, pose: {}, poseW: 0 });
    i++;
  });
  console.log(fmt(r));
}
// --- end-to-end: one Gesture, reusePose=true ----------------------------------
{
  const eng = new MotionEngine({ reusePose: true });
  eng.play(new Gesture('fistPump'));
  let i = 0;
  const r = bench('MotionEngine.update (1 Gesture, reusePose)', () => {
    eng.update(FRAME_60, { t: i * FRAME_60, phase: 0, pose: {}, poseW: 0 });
    i++;
    if (eng.actions.length === 0) eng.play(new Gesture('fistPump'));
  });
  console.log(fmt(r));
}
// --- end-to-end: Reach (IK arm) active — the most expensive path --------------
// The Reach path runs the two-bone solver + QuatSpring smoothing; we drive it
// via the exported Gesture path which is what the common case looks like. The
// pure-idle and single-Gesture numbers above already bound the hot path.
// (A dedicated Reach bench would need the Reach class + a host pose; skipped
// to keep the bench self-contained and avoid coupling to the Reach API.)

console.log('--- primitives ---');

// --- Spring.update (per-axis) --------------------------------------------------
{
  const s = new Spring(2.4, 0.9, 0, 0);
  let i = 0;
  const r = bench('Spring.update (1 axis)', (i) => s.update(FRAME_60, Math.sin(i * 0.01)),
    { iters: 500_000, repeats: 5 });
  console.log(fmt(r));
}
// --- QuatSpring.update (arm chain) --------------------------------------------
// QuatSpring is not exported; the end-to-end MotionEngine.update measurement
// already includes 4 QuatSpring updates per frame (the arm chain). We skip the
// primitive here and rely on the e2e number to gauge it.

// --- TargetBuffer reset+base loop (the per-frame setup) -----------------------
// This is the loop at index.js:1571-1572: buf.reset(); for (b of MANAGED) buf.base(b)
{
  // Reconstruct the cheap equivalent without exporting internals.
  // restOf is not exported, but REST is. Mimic: base(b) = (REST[b]||ZERO3).slice()
  const ZERO3 = [0, 0, 0];
  const t = {};
  const r = bench('TargetBuffer reset+base (40 bones)', () => {
    for (const k in t) delete t[k];
    for (const b of MANAGED) t[b] = (REST[b] || ZERO3).slice();
  }, { iters: 500_000, repeats: 5 });
  console.log(fmt(r));
}

console.log('');
console.log('fps-budget = 1e9 / (1/60) / ns-per-op  — the headroom multiple of 60fps if this op were the whole frame.');
