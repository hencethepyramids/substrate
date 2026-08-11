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
        return { y: hy, z: hz, weight: a.gesture.weight, active: a.gesture.active };
    });

const settle = (ms) => page.waitForTimeout(ms);

await settle(600);
const idle = await read();

const poses = {};
for (const [name, key] of Object.entries(KEYS)) {
    await page.keyboard.down(key);
    // Long enough for the blend to arrive: char.gestureBlend is a rate, so 600 ms at the
    // default 11/s is more than six time constants.
    await settle(700);
    poses[name] = await read();
    await page.keyboard.up(key);
    // And long enough to come back, which is the half nobody checks.
    await settle(700);
    poses[name].released = await read();
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

console.log("");
if (bad === 0) {
    console.log("ok — every verb moves the body, each pose means what it is called, and the arms");
    console.log("come back to the gait when the key comes up.");
} else {
    console.log(`${bad} failure(s)`);
    process.exitCode = 1;
}
