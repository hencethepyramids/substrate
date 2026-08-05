#!/usr/bin/env node
//
// A contact sheet of one gait cycle.
//
// EVERY ANIMATION PROBLEM THIS PROJECT HAS HAD WAS INVISIBLE IN A SINGLE STILL. The legs
// locked straight at 97% extension, the feet detached from the shins, the figure took ten
// steps a second — all of it measured fine on some axis, all of it looked wrong in motion,
// and a screenshot of one frozen instant showed none of it. checkGait can prove a foot
// does not slide and a stride paces out; it cannot see rhythm, or weight, or whether a
// body looks like it is carrying itself.
//
// So this samples a whole cycle. It slows the simulation right down, walks the character,
// waits for the right foot's phase to cross each of N evenly spaced marks, and screenshots
// there — so the frames are evenly spaced in GAIT PHASE rather than in wall-clock time,
// which is the only spacing that means anything when the cadence changes with speed.
// Then it tiles them into one image.
//
//   node scripts/filmstrip.mjs --frames=12 --out=shots/gait-walk.png
//   node scripts/filmstrip.mjs --sprint=true --out=shots/gait-run.png
//
// Side-on by default, because a gait read from behind hides the entire sagittal plane —
// which is where a walk cycle actually happens.

import { chromium } from "playwright-core";
import { mkdirSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const URL = process.env.SUBSTRATE_URL ?? "http://localhost:4173/";
const argv = new Map();
for (const a of process.argv.slice(2)) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) argv.set(m[1], m[2] ?? "true");
}

const frames = Number(argv.get("frames") ?? 12);
const cols = Number(argv.get("cols") ?? 4);
const sprint = argv.get("sprint") === "true";
const out = argv.get("out") ?? "shots/filmstrip.png";

function findChromium() {
    if (process.env.SUBSTRATE_CHROME) return process.env.SUBSTRATE_CHROME;
    const root = join(process.env.LOCALAPPDATA ?? "", "ms-playwright");
    if (!existsSync(root)) return null;
    for (const d of readdirSync(root)
        .filter((x) => /^chromium-\d+$/.test(x))
        .sort()
        .reverse()) {
        const exe = join(root, d, "chrome-win64", "chrome.exe");
        if (existsSync(exe)) return exe;
    }
    return null;
}

const exe = findChromium();
if (!exe) {
    console.error("no full chromium found — set SUBSTRATE_CHROME to a chrome.exe");
    process.exit(1);
}

const browser = await chromium.launch({
    executablePath: exe,
    headless: true,
    args: ["--headless=new", "--enable-unsafe-webgpu", "--enable-features=Vulkan,WebGPU", "--use-angle=d3d11", "--no-sandbox", "--no-first-run"],
});
const page = await browser.newPage({ viewport: { width: 760, height: 760 } });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));

await page.addInitScript(
    ([key, value]) => {
        try {
            localStorage.setItem(key, JSON.stringify(value));
        } catch {
            /* defaults are fine */
        }
    },
    [
        "substrate.settings.v4",
        {
            "world.biome": "snow",
            "world.sunElevation": 28,
            "ui.overlayOpen": false,
            // The cloak covers the whole back half of the figure from the side, which is
            // exactly the half a gait is read from.
            "sys.cloth": false,
            "cam.armLength": 5.0,
            "cam.height": 1.5,
        },
    ],
);

await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForFunction(() => (window.__substrateDispose ?? null) !== null, null, { timeout: 90000 });

// Start somewhere FLAT. A walk cycle filmed on a hillside is a walk cycle plus a climb
// cost plus a slope lean, and none of those are the thing being looked at.
await page.evaluate(() => {
    const app = window.__substrate;
    const f = app.terrain.field;
    let best = { x: 0, z: 0, grade: 1e9 };
    for (let i = 0; i < 3000; i++) {
        const a = Math.random() * Math.PI * 2;
        const r = Math.sqrt(Math.random()) * 260;
        const x = Math.cos(a) * r;
        const z = Math.sin(a) * r;
        const d = 1.5;
        const gx = (f.sampleHeight(x + d, z) - f.sampleHeight(x - d, z)) / (2 * d);
        const gz = (f.sampleHeight(x, z + d) - f.sampleHeight(x, z - d)) / (2 * d);
        const grade = Math.hypot(gx, gz);
        if (grade < best.grade) best = { x, z, grade };
    }
    app.mover.teleport(best.x, best.z);
    app.mover.position.y = app.gait.groundAt(best.x, best.z);
    app.gait.resync(app.mover);
    app.wake.resync(app.mover);
    app.rig.snap();
});
await page.waitForTimeout(300);

// Walk at full speed first, so the facing has settled and the gait is in its steady state
// before anything is sampled. A filmstrip of the acceleration ramp is a filmstrip of a
// transient.
await page.keyboard.down("w");
if (sprint) await page.keyboard.down("Shift");
await page.waitForTimeout(2500);
console.log("after W: speed", (await page.evaluate(() => window.__substrate.mover.speed)).toFixed(2));

// SIDE ON, WITHOUT TURNING THE CHARACTER. Movement is camera-relative, so simply
// rotating the camera makes the figure turn to follow it and the view swings straight
// back to behind — which is what the first version of this did. Rotating the camera a
// quarter turn and switching to strafe cancels exactly: with yaw' = yaw + 90 degrees the
// camera's right becomes the old forward negated, so holding A travels the same world
// direction as W did. Same input path, different vantage.
await page.keyboard.up("w");
await page.evaluate(() => {
    const app = window.__substrate;
    app.rig.yaw = app.mover.facing + Math.PI / 2;
});
await page.keyboard.down("a");
await page.waitForTimeout(1600);
console.log("after strafe: speed", (await page.evaluate(() => window.__substrate.mover.speed)).toFixed(2), "stride", (await page.evaluate(() => window.__substrate.gait.stride)).toFixed(2));

// SHOOT AT FULL SPEED AND SORT AFTERWARDS.
//
// Waiting for the phase to reach each mark needs the simulation slowed down enough that a
// screenshot fits inside one cycle, and slowing it collapsed the walk: the character came
// out of a 30-second capture at a fifth of the speed it went in at. Shooting flat out and
// recording the phase each frame HAPPENED to land on, then picking the frames nearest the
// marks, needs no slowdown at all. Consecutive screenshots land a fifth of a cycle apart
// and the phases scatter, so a few dozen shots cover the cycle densely.
const pool = [];
for (let i = 0; i < frames * 4; i++) {
    const phase = await page.evaluate(() => window.__substrate.gait.phaseOf(0));
    pool.push({ phase, png: (await page.screenshot()).toString("base64") });
}

const shots = [];
for (let i = 0; i < frames; i++) {
    const want = i / frames;
    let best = pool[0];
    let bestGap = 2;
    for (const c of pool) {
        // Circular distance — phase 0.99 is next to phase 0.01, not a cycle away from it.
        const raw = Math.abs(c.phase - want);
        const gap = Math.min(raw, 1 - raw);
        if (gap < bestGap) {
            bestGap = gap;
            best = c;
        }
    }
    shots.push(best.png);
}

await page.keyboard.up("a");
if (sprint) await page.keyboard.up("Shift");

// Tile them, in the page, using the browser's own image decoding. Each frame is cropped to
// a tall box around the middle, because the figure is what is being looked at and 760
// pixels of dune either side of it is not.
const sheet = await page.evaluate(
    async ([list, columns]) => {
        const bitmaps = [];
        for (const d of list) bitmaps.push(await createImageBitmap(await (await fetch("data:image/png;base64," + d)).blob()));
        const cropW = 300;
        const cropH = 460;
        const sx = Math.round((bitmaps[0].width - cropW) / 2);
        const sy = Math.round(bitmaps[0].height * 0.5 - cropH * 0.62);
        const rows = Math.ceil(bitmaps.length / columns);
        const canvas = new OffscreenCanvas(cropW * columns, cropH * rows);
        const g = canvas.getContext("2d");
        g.fillStyle = "#0b0e12";
        g.fillRect(0, 0, canvas.width, canvas.height);
        for (let i = 0; i < bitmaps.length; i++) {
            const cx = (i % columns) * cropW;
            const cy = Math.floor(i / columns) * cropH;
            g.drawImage(bitmaps[i], sx, sy, cropW, cropH, cx, cy, cropW, cropH);
            g.fillStyle = "rgba(255,255,255,0.55)";
            g.font = "16px monospace";
            g.fillText(String(i), cx + 8, cy + 22);
            g.strokeStyle = "rgba(255,255,255,0.12)";
            g.strokeRect(cx + 0.5, cy + 0.5, cropW - 1, cropH - 1);
        }
        const blob = await canvas.convertToBlob({ type: "image/png" });
        const buf = new Uint8Array(await blob.arrayBuffer());
        let s = "";
        for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
        return btoa(s);
    },
    [shots, cols],
);

const info = await page.evaluate(() => ({
    stride: window.__substrate.gait.stride,
    duty: window.__substrate.gait.duty,
    speed: window.__substrate.mover.speed,
}));

await browser.close();

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, Buffer.from(sheet, "base64"));
console.log(`${frames} frames across one cycle -> ${out}`);
console.log(`stride ${info.stride.toFixed(2)} m, duty ${info.duty.toFixed(2)}`);
