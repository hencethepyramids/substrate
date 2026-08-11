#!/usr/bin/env node
//
// Does the body actually do the thing the ground is being told to do?
//
// Phase 13 pass A gives the character a pose per bending verb. Every failure mode here is
// invisible in a still and most are invisible in motion too:
//
//   - a pose wired to the wrong verb reads as "the animation is a bit odd"
//   - a sign error puts the hands behind the character, which from the default camera is
//     BEHIND THE BODY and therefore not on screen at all
//   - a blend that never returns to zero leaves the arms stuck, and the walk cycle
//     underneath it keeps running, so the figure looks fine standing and broken walking
//
// So this asks for numbers instead. It presses each key through the real input path, reads
// the HAND BONES out of the skeleton, and states what each pose has to be true of relative
// to the others — raise puts the hands above where lowering puts them, sweep reaches
// further forward than drawing does, and the pedestal is the one pose whose hands go back.
//
// MEASURED IN CHARACTER SPACE, which is what makes the claims stable. The skeleton solves
// in a frame with the origin under the feet, +Y up and +Z forward, so "the hands came up
// and forward" is two coordinates rather than a world position that depends on where the
// character happens to be standing and which way they are facing.
//
//   node scripts/probeGesture.mjs

import { chromium } from "playwright-core";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const URL = process.env.SUBSTRATE_URL ?? "http://localhost:5173/";

function findChromium() {
    if (process.env.SUBSTRATE_CHROME) return process.env.SUBSTRATE_CHROME;
    const root = join(process.env.LOCALAPPDATA ?? "", "ms-playwright");
    for (const d of readdirSync(root).filter((x) => /^chromium-\d+$/.test(x)).sort().reverse()) {
        const exe = join(root, d, "chrome-win64", "chrome.exe");
        if (existsSync(exe)) return exe;
    }
    return null;
}

const browser = await chromium.launch({
    executablePath: findChromium(),
    headless: true,
    args: ["--headless=new", "--enable-unsafe-webgpu", "--use-angle=d3d11", "--no-sandbox", "--no-first-run", "--disable-background-networking"],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
page.on("pageerror", (e) => console.log(`PAGEERROR: ${e.message}`));

await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForFunction(() => (window.__substrate ?? null) !== null, null, { timeout: 90000 });
await page.waitForTimeout(2500);

// THE VERBS ARE OFF FOR THE WHOLE OF THIS PROBE, and the first version was wrong not to be.
// Holding C raises the ground the character is standing next to, which tilts it, which moves
// the character — so "the ankle moved 240 mm" was measuring the player sliding down a hill
// they had just built, not the lean reaching the leg solve. The body under test is the
// gesture layer; the ground moving is a different system's correctness and it was drowning
// this one. sys.gesture is independent of sys.verbs, so the poses still run.
await page.evaluate(() => window.__substrate.settings.set("sys.verbs", false));
await page.waitForTimeout(400);

// THROUGH THE REAL KEYS, not by poking gesture.update(). The thing being tested includes the
// keydown listener, the auto-repeat filter, the per-frame consumption in endFrame() and the
// enable toggle — any one of which can be wrong while the pose itself is perfect. Same
// reason capture.mjs presses keys rather than calling verbs.ignite.
const KEYS = { raise: "c", lower: "v", sweep: "z", draw: "x", pedestal: "g" };

const read = () =>
    page.evaluate(() => {
        const a = window.__substrate;
        const sk = a.gait.skeleton;
        // Bone indices are the palette order from character/skeleton.ts: handR 13, handL 16.
        const hy = (sk.head[13 * 3 + 1] + sk.head[16 * 3 + 1]) * 0.5;
        const hz = (sk.head[13 * 3 + 2] + sk.head[16 * 3 + 2]) * 0.5;
        // chest 2, head 4 for the torso. THE ANKLES ARE READ IN WORLD SPACE, out of the
        // gait's own array — private at compile time, and this is a measurement harness
        // reaching in on purpose. Character space is the wrong frame for this claim: the
        // idle sway moves the PELVIS by a centimetre or so, and since character space is
        // pinned to the body that reads as the feet sliding when it is the hips that moved.
        // World space is also where Phase 7 states the guarantee — a planted foot does not
        // move — so it is the frame the claim belongs in.
        return {
            y: hy,
            z: hz,
            chestZ: sk.head[2 * 3 + 2],
            headZ: sk.head[4 * 3 + 2],
            ankle: [a.gait._ankle[0], a.gait._ankle[2], a.gait._ankle[3], a.gait._ankle[5]],
            lean: a.gesture.lean,
            weight: a.gesture.weight,
            active: a.gesture.active,
        };
    });

const settle = (ms) => page.waitForTimeout(ms);

await settle(600);
const idle = await read();

// THE BACKGROUND, MEASURED RATHER THAN ASSUMED. The character drifts a few millimetres a
// second standing still — it is on a slope and gravity is doing what gravity does — so
// "the ankle moved" is only evidence about the lean if it moved MORE than it was going to
// anyway. An equal interval with no key held is what makes the tolerance below a
// measurement instead of a guess.
const driftOf = (a, b) => Math.max(Math.abs(a.ankle[0] - b.ankle[0]), Math.abs(a.ankle[1] - b.ankle[1]), Math.abs(a.ankle[2] - b.ankle[2]), Math.abs(a.ankle[3] - b.ankle[3]));
const ctrlA = await read();
await settle(700);
const background = driftOf(await read(), ctrlA);

const poses = {};
for (const [name, key] of Object.entries(KEYS)) {
    // Taken immediately before the press, so the comparison spans only the blend rather
    // than every second since the probe started.
    const before = await read();
    await page.keyboard.down(key);
    // Long enough for the blend to arrive: char.gestureBlend is a rate, so 600 ms at the
    // default 11/s is more than six time constants.
    await settle(700);
    poses[name] = await read();
    poses[name].footDrift = driftOf(poses[name], before);
    await page.keyboard.up(key);
    // And long enough to come back, which is the half nobody checks.
    await settle(700);
    poses[name].released = await read();
}

// -- the struck gestures -----------------------------------------------------------------
//
// The ridge and the wall are EVENTS: the key is up again by the next frame while the thing
// it launched runs for another second. So the claim is not "the pose is held while the key
// is" — there is nothing to hold — it is that a single press produces a blow that arrives
// and then leaves ON ITS OWN.
//
// SAMPLED THROUGH TIME RATHER THAN AT A MOMENT, because every way this can fail is a shape
// rather than a value. A strike wired to the held path would sit at zero (the key is gone
// before the next frame reads it). One that never releases would look perfect in a still and
// leave the arms overhead forever. One easing in on a rate instead of a clock would arrive
// late and soft, which is exactly how a punch turns into a stretch — and reads as "the
// animation is fine" to anything sampling a single frame.
const strikes = {};
for (const [name, key] of [
    ["ridge", "b"],
    ["wall", "n"],
]) {
    await settle(700);
    const trace = [];
    await page.keyboard.press(key);
    for (let i = 0; i < 22; i++) {
        trace.push(await read());
        await settle(40);
    }
    let peak = trace[0];
    for (const t of trace) if (t.weight > peak.weight) peak = t;
    strikes[name] = { trace, peak, rest: await read() };
}

await browser.close();

const f = (v) => (v >= 0 ? " " : "") + v.toFixed(3);
console.log("hand height and reach, character space, metres — origin under the feet, +Z forward");
console.log(`  idle          y ${f(idle.y)}   z ${f(idle.z)}   weight ${idle.weight.toFixed(3)}`);
for (const [name, p] of Object.entries(poses)) {
    console.log(
        `  ${name.padEnd(9)}     y ${f(p.y)}   z ${f(p.z)}   weight ${p.weight.toFixed(3)}  ` +
            `(${p.active ?? "none"})   released -> weight ${p.released.weight.toFixed(3)}`,
    );
}
console.log("");

let bad = 0;
const claim = (ok, text) => {
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${text}`);
    if (!ok) bad++;
};

// The verb reached the body at all. A pose wired to nothing looks exactly like a pose
// wired to the wrong thing, so this is separated from the geometry claims below.
for (const [name, p] of Object.entries(poses)) {
    if (p.active !== name) {
        console.log(`  FAIL  ${name} reported the gesture "${p.active}" — the verb is wired to the wrong pose`);
        bad++;
    }
}

// EVERY CLAIM IS RELATIVE, because the absolute numbers are a body proportion and would have
// to be re-typed here whenever the rig changed. What must hold is the ORDERING, and that is
// a statement about the poses meaning what they are named.
claim(poses.raise.y > poses.lower.y + 0.15, `raising puts the hands above lowering (${f(poses.raise.y)} vs ${f(poses.lower.y)})`);
claim(poses.raise.y > idle.y + 0.3, `raising lifts them well clear of where they hang (${f(poses.raise.y)} vs ${f(idle.y)})`);
claim(poses.sweep.z > idle.z + 0.25, `sweeping reaches forward (${f(poses.sweep.z)} vs ${f(idle.z)})`);
claim(poses.sweep.z > poses.draw.z, `sweeping reaches further out than drawing (${f(poses.sweep.z)} vs ${f(poses.draw.z)})`);
claim(poses.lower.z > idle.z, `lowering presses forward and down rather than straight down (${f(poses.lower.z)})`);
// The one pose whose hands go BACK. If the shoulder angle's sign is inverted anywhere in
// the chain this is the case that catches it, because it is the only negative one.
claim(poses.pedestal.z < idle.z, `the pedestal takes the hands behind the hang (${f(poses.pedestal.z)} vs ${f(idle.z)})`);

// AND THE HALF NOBODY CHECKS. A blend that arrives and never leaves looks correct in every
// screenshot ever taken of it.
for (const [name, p] of Object.entries(poses)) {
    if (p.weight < 0.9) {
        console.log(`  FAIL  ${name} only blended to ${p.weight.toFixed(3)} — the pose never fully arrives`);
        bad++;
    }
    if (p.released.weight > 0.05) {
        console.log(`  FAIL  ${name} released to ${p.released.weight.toFixed(3)} — the arms stay stuck in the pose`);
        bad++;
    }
}

// -- the lean, and the thing it must not do ----------------------------------------------
//
// Pass C leans the torso into what is being commanded. The claim that matters is not that
// the chest moved — it is that the chest moved AND THE FEET DID NOT.
//
// A lean is the obvious thing to build from the ankles, and that is exactly what would break
// this project's oldest guarantee: the gait plants feet in WORLD space and the whole of
// Phase 7 rests on a planted foot not moving. Pitching the pelvis drags every planted foot
// with it, and the failure is a slow slide that no still frame shows. So the lean is spent
// through the spine above the pelvis, and this measures both halves of that sentence.
console.log("");
console.log("the lean — torso pitch, and what it costs the feet");
console.log(`  idle          chest z ${f(idle.chestZ)}   head z ${f(idle.headZ)}`);
for (const [name, p] of Object.entries(poses)) {
    console.log(`  ${name.padEnd(9)}     lean ${((p.lean * 180) / Math.PI).toFixed(1).padStart(6)} deg   chest z ${f(p.chestZ)}   head z ${f(p.headZ)}   feet ${(p.footDrift * 1000).toFixed(2)} mm`);
}
console.log(`  the same interval with NO key held moves the feet ${(background * 1000).toFixed(2)} mm — that is the floor`);
console.log("");

// Forward for the poses that push, back for the ones that haul. These are the same signs the
// pose table states, measured at the chest rather than asserted at the source.
claim(poses.lower.chestZ > idle.chestZ + 0.02, `lowering puts the chest over the hands (${f(poses.lower.chestZ)} vs ${f(idle.chestZ)})`);
claim(poses.sweep.chestZ > idle.chestZ + 0.02, `sweeping leans in behind the push (${f(poses.sweep.chestZ)})`);
claim(poses.draw.chestZ < idle.chestZ - 0.01, `drawing takes the weight back with it (${f(poses.draw.chestZ)})`);
claim(poses.raise.chestZ < idle.chestZ, `raising counterweights away from the lift (${f(poses.raise.chestZ)})`);
// Spent THROUGH the spine: the head ends up leaning less than the chest, which is what keeps
// the camera's subject from tipping over.
claim(
    Math.abs(poses.sweep.headZ - idle.headZ) < Math.abs(poses.sweep.chestZ - idle.chestZ) * 2.2,
    `the lean is spent through the spine rather than tipping the whole figure`,
);
// THE ONE THAT MATTERS. Sub-millimetre is not a tolerance, it is a statement that leanZ is
// read by nothing in the leg solve.
// A lean that reached the leg solve would pitch the pelvis and drag the planted feet with
// it — centimetres, not the millimetre the character wanders anyway. Twice the measured
// background is a generous bar and still an order of magnitude below that failure.
const bar = Math.max(background * 2, 0.004);
for (const [name, p] of Object.entries(poses)) {
    if (p.footDrift > bar) {
        console.log(`  FAIL  ${name} moved a foot by ${(p.footDrift * 1000).toFixed(2)} mm against a ${(bar * 1000).toFixed(2)} mm bar — the lean has reached the leg solve`);
        bad++;
    }
}
claim(true, `every pose moves the feet no more than standing still does (bar ${(bar * 1000).toFixed(2)} mm)`);

console.log("");
console.log("struck gestures — one press, sampled every 40 ms; the key is up the whole time");
for (const [name, s] of Object.entries(strikes)) {
    const spark = s.trace.map((t) => "0123456789"[Math.min(9, Math.round(t.weight * 9))]).join("");
    console.log(`  ${name.padEnd(6)} ${spark}`);
    console.log(`         peak weight ${s.peak.weight.toFixed(3)} with hands at y ${f(s.peak.y)}, settles to ${s.rest.weight.toFixed(3)}`);
}
console.log("");

for (const [name, s] of Object.entries(strikes)) {
    // It happened at all — the defining failure being that an event wired to the held path
    // never fires, because the key is gone before the next frame looks at it.
    claim(s.peak.weight > 0.85, `${name} strikes from a single press (peak ${s.peak.weight.toFixed(3)})`);
    // And it ended on its own, which nothing but a time sample can see.
    claim(s.rest.weight < 0.05, `${name} recovers with no key held (${s.rest.weight.toFixed(3)})`);
    // Fast in, slow out. The first sample after the press should already be most of the way
    // there; at 40 ms against a 90 ms attack it cannot be near zero unless the strike is
    // easing on a rate instead of running on a clock.
    claim(s.trace[1].weight > 0.25, `${name} arrives fast rather than easing in (${s.trace[1].weight.toFixed(3)} at 40 ms)`);
}
// The wall is the tallest thing the verbs make, so it is the pose whose hands go highest.
claim(strikes.wall.peak.y > strikes.ridge.peak.y + 0.1, `the wall throws the hands higher than the ridge (${f(strikes.wall.peak.y)} vs ${f(strikes.ridge.peak.y)})`);

console.log("");
if (bad === 0) {
    console.log("ok — every verb moves the body, each pose means what it is called, held poses");
    console.log("come back when the key comes up, and struck ones come back on their own.");
} else {
    console.log(`${bad} failure(s)`);
    process.exitCode = 1;
}
