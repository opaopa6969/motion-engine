**English** · [日本語](./theory.ja.md)

# Explaining motion theory to a middle schooler

Cast

- **Yu** — 8th grader. Loves games. Fires off blunt, naive questions without mercy.
- **Me** — the developer building this engine. Answers while building it.

---

**Yu**: "Hey, the characters in this mahjong game move like they're actually alive. Did you record all that motion?"

**Me**: "Nope, no recording at all. You know motion capture, right — strap sensors on a person and record how they move? This is built without any of that."

**Yu**: "None? Then how are the hands moving?"

**Me**: "It's computed on the spot, every single frame. ...Though, honestly, it was terrible at first."

**Yu**: "Terrible how?"

**Me**: "Yeah. At first, to make the body sway, I used something called a sine wave — a wave shape — to make it wobble. And it turned into... a complete 'robot doing radio calisthenics.' I was devastated."

**Yu**: "Ha, what does that even mean."

**Me**: "It's too regular. Clunk, clunk, the exact same motion repeating. Real humans don't move like that. That's when I started asking: 'okay, so what's actually different about a real body?' That's today's topic."

## The spring-and-weight thing

**Me**: "First question. Ever held one end of a ruler on a desk and flicked the other end?"

**Yu**: "Yeah, the boing-boing thing."

**Me**: "Right — it snaps, overshoots, comes back, overshoots a little again... and gradually settles down. That 'natural way of settling' is hugely important."

**Yu**: "Why's it important?"

**Me**: "Because the sine-wave radio calisthenics doesn't have that 'overshoot and come back' at all. It moves straight to the target and stops dead. Looks mechanical, right? But a real arm has momentum, it overshoots a bit, then comes back. That tiny lag is what reads as 'weight' or 'being alive.'"

**Yu**: "I see. So should everything just boing-boing then?"

**Me**: "That's exactly the trick. You know door closers? The thing on top of a door that closes it slowly by itself?"

**Yu**: "Oh, the one that closes without slamming?"

**Me**: "That one doesn't boing-boing at all — it glides shut, quiet and smooth. Same 'spring and weight' mechanism, but one boings and the other glides. What do you think the difference is?"

**Yu**: "...how strong the brakes are?"

**Me**: "Nailed it. The technical term is 'damping' — basically, how hard the brakes bite. Weak brakes: boing-boing like the ruler. Strong brakes: smooth like the door closer. Just by turning these two dials — 'spring strength' and 'brake strength' — you can make anything from energetic motion to calm motion."

**Yu**: "Two dials for all of it? That's kind of amazing."

**Me**: "This is secret number one. In this engine there's a part called `Spring` that does exactly this. When an arm lifts, it's pulled toward the target angle by a spring. That alone produces 'snap into acceleration, overshoot a bit, settle' for free. No need to hand-key every little step."

## Adding waves of different periods

**Yu**: "But even standing still, it's moving a tiny bit, right? What's that about?"

**Me**: "Good eye. That's secret number two. ...Learning from that radio-calisthenics disaster — if you only use one wave, it's guaranteed to repeat. The same shape loops. Real humans don't loop."

**Yu**: "So what do you do?"

**Me**: "Add together several waves with different periods. Say, breathing is a slow wave, weight shifting is an even slower wave, and tiny finger jitter is a fast wave. Add all three together."

**Yu**: "What happens when you add them?"

**Me**: "This is the fun part. When you add waves whose periods don't divide evenly into each other, the shape never repeats the same way twice. The wobble just keeps changing, forever."

**Yu**: "Why does not-dividing-evenly stop it from repeating?"

**Me**: "Say one wave has a 3-second period and the other has a 3.7-second period. For both to line up back to 'exactly the same shape as the start' at the same moment takes a really long time. If you pick fractional numbers like 3.1 or 3.7, it effectively never comes back around. So it never loops."

**Yu**: "Huh. So you're deliberately exploiting the mismatch."

**Me**: "Exactly. There's another option for generating that kind of signal — noise, using randomness, like rolling dice — but I deliberately don't use that. Just adding waves together. That way, 'same conditions in, exact same motion out, every time' is guaranteed, which makes it testable. That part's really for development's sake."

## Stacking layers

**Yu**: "Springs, and adding waves together. You said there was one more thing."

**Me**: "Secret number three is 'layering.' You know how, when drawing, you stack a bunch of transparent sheets?"

**Yu**: "Like animation cels?"

**Me**: "Exactly that. Motion works the same way — layer one is 'breathing,' layer two is 'posture from emotion,' layer three is a one-shot bit like a 'fist pump.' Add them all together and you get the final pose."

**Yu**: "You add them instead of overwriting?"

**Me**: "That part matters a lot. It used to overwrite. Do a fist pump, and breathing would just vanish. Breathing would suddenly snap to a dead stop and it looked unnatural. Now it adds, so during a fist pump the character is still visibly breathing, and the emotion is still riding along too. Even with few building blocks, stacking them multiplies the range of expression."

**Yu**: "Springs, adding waves, stacking layers. Those three, huh."

**Me**: "Those three are what build 'a living body with no recording.' Not some flashy mechanism — just simple parts combined. That's what I like about it."

## So where's this in the code?

**Yu**: "Where is this actually in the program?"

**Me**: "Open the file called `index.js` — the spring is a class called `Spring`, the wave-adding is a function called `noise` plus `NoiseIdle`, and the layering mechanism is the `add` on `TargetBuffer`. Once you get today's three ideas, you can read exactly what's happening where in that file. Not bad, for something that started out as robot calisthenics."
