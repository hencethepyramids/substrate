#!/usr/bin/env node
//
// Drive the real thing in a real browser and bring back a picture and a console.
//
// This project's expensive bugs are all runtime GPU bugs, and every one of them so far
// was found by a human looking at a screenshot: the faceted normals, the diamond glint
// tiles, the blown highlight, the separation blanketing every lee face. All four were
// plainly visible in a single still. This closes that loop.
//
// What it CANNOT do is tell you the frame is fast. A headless adapter is not your card,
// so it prints whatever adapter it got and you should distrust any timing from it. The
// GPU pass numbers still come from a human with the overlay open.
//
//   node scripts/capture.mjs --view=wind --biome=desert --sun=8 --out=shots/wind.png
//
// Settings are injected through localStorage before the page loads, which is why no
// hook into the app is needed: core/settings.ts already reads exactly that key.

import { chromium } from "playwright-core";
import { mkdirSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

const STORAGE_KEY = "substrate.settings.v4";
const URL = process.env.SUBSTRATE_URL ?? "http://localhost:5173/";

const argv = new Map();
/** Repeatable `--set key=value`, so any control can be driven without a new flag. */
const overrides = [];
for (const a of process.argv.slice(2)) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    // LOUDLY, because the alternative cost me an afternoon. `--set sys.substrate=false`
    // with a space parses as two arguments, the second of which does not start with `--`;
    // the old loop skipped it and captured a scene with the subsystem still on. Nothing
    // said so, and the resulting image was a perfectly plausible answer to a question
    // nobody had asked. A capture that quietly ignores half its arguments is not an
    // instrument, so an argument this cannot parse is now fatal.
    if (!m) {
        console.error(`capture: cannot parse argument "${a}" — flags are --name or --name=value, and overrides are --set=key=value with no space`);
        process.exit(2);
    }
    if (m[1] === "set") overrides.push(m[2] ?? "");
    else argv.set(m[1], m[2] ?? "true");
}

/** The full browser, never the headless shell — the shell has no GPU and so no WebGPU. */
function findChromium() {
    if (process.env.SUBSTRATE_CHROME) return process.env.SUBSTRATE_CHROME;
    const root = join(process.env.LOCALAPPDATA ?? "", "ms-playwright");
    if (!existsSync(root)) return null;
    const dirs = readdirSync(root)
        .filter((d) => /^chromium-\d+$/.test(d))
        .sort()
        .reverse();
    for (const d of dirs) {
        const exe = join(root, d, "chrome-win64", "chrome.exe");
        if (existsSync(exe)) return exe;
    }
    return null;
}

const settings = {};
if (argv.has("view")) settings["debug.view"] = argv.get("view");
if (argv.has("biome")) settings["world.biome"] = argv.get("biome");
if (argv.has("sun")) settings["world.sunElevation"] = Number(argv.get("sun"));
if (argv.has("wind")) settings["world.windStrength"] = Number(argv.get("wind"));
if (argv.has("bearing")) settings["world.windBearing"] = Number(argv.get("bearing"));
if (argv.has("tonemap")) settings["post.tonemap"] = argv.get("tonemap");
// A/B DIFFS NEED A STILL SUBJECT. Two captures of the same build differ by a mean of
// about 2 levels over a third of the frame, because the substrate, the smoke, the embers
// and the spray all advance by however many frames fit in the settle window — and the
// number of frames that fit is a property of the machine, not of the code. That noise is
// larger than most of what a post pass legitimately changes, so a diff taken without this
// flag measures the weather rather than the change. `--freeze` pauses the simulation from
// the first frame, which makes the image a function of the camera, the sun and the
// heightfield, all of which are deterministic.
if (argv.get("freeze") === "true") settings["world.paused"] = true;
// The overlay is a wall of text over the picture; off unless asked for.
settings["ui.overlayOpen"] = argv.get("overlay") === "true";

for (const o of overrides) {
    const eq = o.indexOf("=");
    if (eq < 0) continue;
    const key = o.slice(0, eq);
    const raw = o.slice(eq + 1);
    settings[key] = raw === "true" ? true : raw === "false" ? false : Number.isNaN(Number(raw)) ? raw : Number(raw);
}

const out = argv.get("out") ?? "shots/capture.png";
const settleMs = Number(argv.get("settle") ?? 2500);
const headed = argv.get("headed") === "true";

const exe = findChromium();
if (!exe) {
    console.error("no full chromium found — set SUBSTRATE_CHROME to a chrome.exe");
    process.exit(1);
}

const browser = await chromium.launch({
    executablePath: exe,
    headless: !headed,
    args: [
        "--headless=new",
        "--enable-unsafe-webgpu",
        "--enable-features=Vulkan,WebGPU",
        "--use-angle=d3d11",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--disable-component-update",
        "--no-sandbox",
    ].filter((a) => headed !== true || a !== "--headless=new"),
});

const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const page = await context.newPage();

const log = [];
page.on("console", (m) => log.push(`${m.type()}: ${m.text()}`));
page.on("pageerror", (e) => log.push(`PAGEERROR: ${e.message}`));

await page.addInitScript(
    ([key, value]) => {
        try {
            localStorage.setItem(key, JSON.stringify(value));
        } catch {
            /* private mode: defaults are fine */
        }
    },
    [STORAGE_KEY, settings],
);

let booted = false;
try {
    await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    // The boot summary is the app telling us every pipeline compiled. Waiting on it
    // rather than on a fixed delay is what makes this honest about failure.
    await page.waitForFunction(() => (window.__substrateDispose ?? null) !== null, null, { timeout: 90000 });
    booted = true;
} catch (err) {
    log.push(`BOOT FAILED: ${err.message}`);
}

// Optionally break the ground first. Nothing is airborne over undisturbed terrain —
// the substrate starts empty, there is no loose mass, and every transport view is
// correctly black. So a carve is the setup for most of Phase 5's questions.
const carves = Number(argv.get("carve") ?? 0);
if (carves > 0) {
    await page.evaluate(async (n) => {
        const app = window.__substrate;
        const wait = () => new Promise((r) => requestAnimationFrame(() => r()));
        // A line laid ACROSS the wind, upwind of the camera, so its plume blows into
        // view rather than away from it.
        const w = app.air.base;
        const speed = Math.hypot(w.x, w.y) || 1;
        const dir = { x: w.x / speed, y: w.y / speed };
        const across = { x: -dir.y, y: dir.x };
        for (let i = 0; i < n; i++) {
            const t = (i - n / 2) * 1.1;
            const x = across.x * t - dir.x * 9;
            const z = across.y * t - dir.y * 9;
            app.substrate.stamp(x, z, 0.9, 0.5);
            await wait();
        }
    }, carves);
}

// Optionally drop a pit right where the character stands — the Phase 3 acceptance test,
// and the quickest way to see whether the clipmap is displacing by the buffer at all.
if (argv.has("pit")) {
    await page.evaluate(async (depth) => {
        const app = window.__substrate;
        const wait = () => new Promise((r) => requestAnimationFrame(() => r()));
        // A trench in front of the camera rather than a round hole: a long edge shows a
        // silhouette, and a silhouette is the thing a normal map cannot fake.
        for (let i = 0; i < 12; i++) {
            const t = (i - 6) * 0.55;
            app.substrate.stamp(app.mover.position.x + t, app.mover.position.z + 3.5, 0.85, depth);
            await wait();
        }
    }, Number(argv.get("pit")) || 0.6);
}

// Optionally start on the steepest ground nearby. Sliding is a hill mechanic, so testing
// it on the gentle ground at the origin measures nothing — this project's terrain has a
// median slope around nine degrees and the interesting faces have to be gone and found.
if (argv.has("steep")) {
    const found = await page.evaluate((radius) => {
        const app = window.__substrate;
        const f = app.terrain.field;
        let best = { x: 0, z: 0, grade: -1 };
        for (let i = 0; i < 4000; i++) {
            const a = Math.random() * Math.PI * 2;
            const r = Math.sqrt(Math.random()) * radius;
            const x = Math.cos(a) * r;
            const z = Math.sin(a) * r;
            const d = 0.6;
            const gx = (f.sampleHeight(x + d, z) - f.sampleHeight(x - d, z)) / (2 * d);
            const gz = (f.sampleHeight(x, z + d) - f.sampleHeight(x, z - d)) / (2 * d);
            const grade = Math.hypot(gx, gz);
            if (grade > best.grade) best = { x, z, grade };
        }
        app.mover.teleport(best.x, best.z);
        app.mover.position.y = app.gait.groundAt(best.x, best.z);
        app.gait.resync(app.mover);
        app.wake.resync(app.mover);
        app.rig.snap();
        return { x: best.x, z: best.z, deg: (Math.atan(best.grade) * 180) / Math.PI };
    }, Number(argv.get("steep")) || 300);
    console.log(`steep start: ${found.deg.toFixed(1)} deg at ${found.x.toFixed(0)}, ${found.z.toFixed(0)}`);
}

// Aim the camera, for Phase 9's questions. Light shafts only exist when the sun is on or
// near the screen, so "does this effect work" is not answerable without being able to
// point at the sky the sun is actually in. Degrees, applied before the settle so the rig
// has arrived by the time the shot is taken.
if (argv.has("yaw") || argv.has("pitch")) {
    await page.evaluate(
        ({ yaw, pitch }) => {
            const app = window.__substrate;
            if (yaw !== null) app.rig.yaw = (yaw * Math.PI) / 180;
            if (pitch !== null) app.rig.pitch = (pitch * Math.PI) / 180;
            app.rig.snap();
        },
        { yaw: argv.has("yaw") ? Number(argv.get("yaw")) : null, pitch: argv.has("pitch") ? Number(argv.get("pitch")) : null },
    );
}

// Optionally set fire to the ground first, for Phase 6's questions.
if (argv.has("ignite")) {
    await page.evaluate((rate) => {
        const app = window.__substrate;
        if (rate > 0) app.settings.set("fire.igniteRate", rate);
        app.fire.ignite(app.mover.position.x, app.mover.position.z, app.settings.get("fire.igniteRadius"), app.settings.get("fire.igniteRate"));
    }, Number(argv.get("ignite")) || 0);
}

// Optionally walk first, for Phase 7's questions. A still of a standing figure says
// nothing about a gait, and neither does one of a figure teleported along a line — the
// stride is phased on ground travelled, so it has to actually travel. Real key events
// through the real Input class, because a gait driven by poking the mover would not be
// exercising the path that ships.
// Peak speed over the run, not the speed at the end of it. A slide down a face is over
// by the time it reaches the bottom, and sampling there measures the flat ground it
// stopped on rather than the hill it came down.
await page
    .evaluate(() => {
        window.__peak = 0;
        const tick = () => {
            window.__peak = Math.max(window.__peak, window.__substrate.mover.speed);
            window.__peakRaf = requestAnimationFrame(tick);
        };
        tick();
    })
    .catch(() => {});

const walkMs = Number(argv.get("walk") ?? 0);
// Optionally turn while walking, for Phase 8's questions — a wake only carves when the
// path curves. Driven through the rig at a controlled rate rather than through lookX,
// because the look path is gated on pointer lock that a headless run never gets.
const turnRate = (Number(argv.get("turn") ?? 0) * Math.PI) / 180;
if (turnRate !== 0) {
    await page.evaluate((r) => {
        const app = window.__substrate;
        let last = performance.now();
        const spin = () => {
            const now = performance.now();
            app.rig.yaw += r * ((now - last) / 1000);
            last = now;
            window.__spinRaf = requestAnimationFrame(spin);
        };
        spin();
    }, turnRate);
}
if (walkMs > 0) {
    const key = argv.get("walkKey") ?? "w";
    await page.keyboard.down(key);
    if (argv.get("sprint") === "true") await page.keyboard.down("Shift");
    if (argv.get("slide") === "true") await page.keyboard.down("Control");
    await page.waitForTimeout(walkMs);
    // Held through the screenshot when asked, so the shot catches a foot mid-swing
    // rather than the settled stand the figure relaxes into a moment after stopping.
    if (argv.get("keepWalking") !== "true") {
        await page.keyboard.up(key);
        if (argv.get("sprint") === "true") await page.keyboard.up("Shift");
        if (argv.get("slide") === "true") await page.keyboard.up("Control");
    }
}

// A VERB, THROUGH THE REAL INPUT PATH. Not `app.verbs.ignite(...)` — pressing the key is
// what makes this an end-to-end check: it exercises the keydown listener, the auto-repeat
// filter, the per-frame consumption in endFrame(), the enable toggle and the aiming, any
// one of which can be wrong while the call underneath is perfect.
if (argv.has("press")) {
    await page.keyboard.press(argv.get("press"));
    await page.waitForTimeout(250);
    const v = await page.evaluate(() => {
        const a = window.__substrate;
        const dx = a.verbs.target.x - a.mover.position.x;
        const dz = a.verbs.target.z - a.mover.position.z;
        return {
            n: a.verbs.ignitions,
            reach: Math.hypot(dx, dz),
            // The target's bearing must BE the facing angle: target = position +
            // (sin f, cos f) * reach, so atan2(dx, dz) inverts to exactly f.
            bearing: Math.atan2(dx, dz),
            facing: a.mover.facing,
            want: a.settings.get("play.reach"),
        };
    });
    const off = Math.abs(((v.bearing - v.facing + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
    const ok = v.n === 1 && Math.abs(v.reach - v.want) < 1e-3 && off < 1e-4;
    console.log(`verbs: ${v.n} ignition(s), aimed ${v.reach.toFixed(3)} m out (want ${v.want}), bearing off facing by ${off.toFixed(6)} rad ${ok ? "(OK)" : "*** WRONG ***"}`);
}

// Let the sky bake, the substrate settle and a few frames of wind blow through.
await page.waitForTimeout(settleMs);

mkdirSync(dirname(out), { recursive: true });
await page.screenshot({ path: out });

const adapter = await page
    .evaluate(async () => {
        if (!navigator.gpu) return "no navigator.gpu";
        const a = await navigator.gpu.requestAdapter();
        if (!a) return "no adapter";
        const i = a.info ?? {};
        return `${i.vendor ?? "?"} / ${i.architecture ?? "?"} / ${i.description ?? "?"}`;
    })
    .catch((e) => `probe failed: ${e.message}`);

const queue = await page.evaluate(() => ({ pending: window.__substrate.substrate.pending, dropped: window.__substrate.substrate.dropped, speed: window.__substrate.mover.speed, peak: window.__peak ?? 0, sliding: window.__substrate.mover.sliding, mass: window.__substrate.groundProbe.massAt(window.__substrate.mover.position.x, window.__substrate.mover.position.z) })).catch(() => null);

await browser.close();

console.log(`adapter: ${adapter}`);
// A wake lays stamps far faster than a footfall does, and the queue drains one per
// relaxation step — so a non-zero drop count is the channel coming out patchy.
if (queue) console.log(`stamps:  ${queue.pending} pending, ${queue.dropped} dropped; peak speed ${queue.peak.toFixed(2)} m/s, final ${queue.speed.toFixed(2)}${queue.sliding ? " (sliding)" : ""}; loose mass under the feet ${queue.mass.toFixed(4)}`);
console.log(`booted:  ${booted}`);
console.log(`shot:    ${out}`);
console.log("--- console ---");
for (const line of log) console.log(line);

// A failed boot is a failed run. Anything else and the picture is worth looking at.
process.exit(booted ? 0 : 1);
