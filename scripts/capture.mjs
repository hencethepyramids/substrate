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

// GATHER, MOVE, PLACE — the conservation test for Phase 10's carrying verbs.
// Holds the dig key, steps aside, holds the place key, and reports the books. The claim is
// exact and has no tuning in it: every cubic metre that left the ground has to come back,
// and the hands have to end empty.
if (argv.has("dig")) {
    const ms = Number(argv.get("dig")) || 800;
    await page.keyboard.down("q");
    await page.waitForTimeout(ms);
    await page.keyboard.up("q");
    const held = await page.evaluate(() => window.__substrate.verbs.carried);
    // Step aside so the heap goes somewhere other than the hole it came from.
    await page.keyboard.down("d");
    await page.waitForTimeout(600);
    await page.keyboard.up("d");
    await page.waitForTimeout(200);
    await page.keyboard.down("f");
    await page.waitForTimeout(ms * 2);
    await page.keyboard.up("f");
    const v = await page.evaluate(() => {
        const a = window.__substrate;
        return { carried: a.verbs.carried, gathered: a.verbs.gathered, placed: a.verbs.placed, cap: a.settings.get("play.carryCapacity"), dropped: a.substrate.dropped };
    });
    const balanced = Math.abs(v.gathered - v.placed) < 1e-9 && v.carried < 1e-9;
    console.log(
        `verbs: gathered ${v.gathered.toFixed(6)} m3, placed ${v.placed.toFixed(6)} m3, still held ${v.carried.toFixed(9)} ` +
            `(peak ${held.toFixed(6)} vs capacity ${v.cap}), stamps dropped ${v.dropped} ${balanced ? "(BALANCED)" : "*** DOES NOT BALANCE ***"}`,
    );
}

// Tread the ground down in front of the character. Compaction drives roughness, so this
// is also the setup for checking that Phase 9's reflections appear where Phase 10 packs.
if (argv.has("packFor")) {
    await page.keyboard.down("r");
    await page.waitForTimeout(Number(argv.get("packFor")) || 800);
    await page.keyboard.up("r");
    const v = await page.evaluate(() => ({ packed: window.__substrate.verbs.packed, x: window.__substrate.verbs.target.x, z: window.__substrate.verbs.target.z }));
    console.log(`verbs: packed ${v.packed.toFixed(3)} at ${v.x.toFixed(2)}, ${v.z.toFixed(2)}`);
}

// CARRY MATERIAL SIDEWAYS. `--sweepFor=<ms>` holds Z, `--drawFor=<ms>` holds X, and the
// pair is the first thing in this project that moves ground in a DIRECTION rather than
// about a point. The picture to look for is two features rather than one: a hollow where
// the material left and a ridge one throw further out where it arrived. A single crater
// means the transport collapsed and the shove is behaving as a scoop.
for (const [flag, key, name] of [
    ["sweepFor", "z", "swept away"],
    ["drawFor", "x", "drawn back"],
]) {
    if (!argv.has(flag)) continue;
    await page.keyboard.down(key);
    await page.waitForTimeout(Number(argv.get(flag)) || 1200);
    await page.keyboard.up(key);
    const v = await page.evaluate(() => ({
        swept: window.__substrate.verbs.swept,
        x: window.__substrate.verbs.target.x,
        z: window.__substrate.verbs.target.z,
        facing: window.__substrate.mover.facing,
        dist: window.__substrate.settings.get("play.sweepDistance"),
        dropped: window.__substrate.substrate.dropped,
    }));
    // Where the far end of the transport ended up, so the console says what the picture
    // should show rather than leaving it to the eye.
    const fx = Math.sin(v.facing) * v.dist;
    const fz = Math.cos(v.facing) * v.dist;
    console.log(
        `verbs: ${v.swept.toFixed(4)} m3 ${name} from ${v.x.toFixed(2)}, ${v.z.toFixed(2)} ` +
            `to ${(v.x + fx).toFixed(2)}, ${(v.z + fz).toFixed(2)} (${v.dist} m along facing), stamps dropped ${v.dropped}`,
    );
}

// SEND A RIDGE. One press, and the wave travels on its own for as long as its range lasts —
// so unlike every other bending verb this needs a WAIT rather than a hold. `--ridge` presses
// B and gives the wave time to arrive; `--ridge=<ms>` shortens that to catch it still
// running, which is the only way to photograph a crest that has not finished being laid.
if (argv.has("ridge")) {
    await page.keyboard.press("b");
    await page.waitForTimeout(Number(argv.get("ridge")) || 2200);
    const v = await page.evaluate(() => ({
        n: window.__substrate.verbs.ridges,
        live: window.__substrate.verbs.liveRidges,
        laid: window.__substrate.verbs.ridgeLength,
        range: window.__substrate.settings.get("play.ridgeRange"),
        dropped: window.__substrate.substrate.dropped,
    }));
    console.log(
        `verbs: ${v.n} ridge(s) launched, ${v.live} still running, ${v.laid.toFixed(2)} m of crest laid ` +
            `over a ${v.range} m range, stamps dropped ${v.dropped}`,
    );
}

// THROW UP A WALL. Like the ridge this is a press and a wait, but what the wait is FOR is
// different: a ridge is finished once it has been laid, and a wall's interesting moment is
// afterwards. Whether a 1.3 m barrier over a 0.7 m radius stands or slumps back toward the
// angle of repose is the element's business, so `--wall=<ms>` is really a settling time.
if (argv.has("wall")) {
    await page.keyboard.press("n");
    await page.waitForTimeout(Number(argv.get("wall")) || 1800);
    const v = await page.evaluate(() => {
        const a = window.__substrate;
        const t = a.verbs.target;
        const len = a.settings.get("play.wallLength");
        const f = a.mover.facing;
        // Sample the crest at the centre and at both ends, through the same CPU mirror the
        // character stands on, so the console says whether it is still standing.
        const across = { x: Math.cos(f), z: -Math.sin(f) };
        const h = (d) => a.gait.groundAt(t.x + across.x * d, t.z + across.z * d);
        return { n: a.verbs.walls, live: a.verbs.liveRidges, dropped: a.substrate.dropped, len, mid: h(0), end: h(len * 0.4), off: h(len * 0.9) };
    });
    console.log(
        `verbs: ${v.n} wall(s), ${v.live} lines running, ${v.len} m span — crest stands ${(v.mid - v.off).toFixed(3)} m at the middle ` +
            `and ${(v.end - v.off).toFixed(3)} m at ${(v.len * 0.4).toFixed(1)} m out, stamps dropped ${v.dropped}`,
    );
}

// GATHER, THROW, LAND. Two claims, and neither has a tuning constant in it: the volume
// that left the hands has to be the volume that reaches the ground, and the heap has to
// come down on the bearing it was thrown along. A projectile that loses its load, or one
// launched along the wrong axis, fails one of them outright.
if (argv.has("throw")) {
    await page.keyboard.down("q");
    await page.waitForTimeout(900);
    await page.keyboard.up("q");
    const before = await page.evaluate(() => ({
        carried: window.__substrate.verbs.carried,
        x: window.__substrate.mover.position.x,
        z: window.__substrate.mover.position.z,
        facing: window.__substrate.mover.facing,
    }));
    await page.keyboard.press("t");
    // Long enough for the whole arc by default; `--throw=<ms>` shortens it to catch the
    // projectile still in the air, which is the only way to photograph the thing that pass
    // E exists to draw. The report below tells the two cases apart rather than insisting on
    // a landing, so a mid-air run is a measurement and not a failure.
    await page.waitForTimeout(Number(argv.get("throw")) || 2000);
    const v = await page.evaluate(() => ({
        thrown: window.__substrate.verbs.thrown,
        landed: window.__substrate.verbs.landed,
        landings: window.__substrate.verbs.landings,
        carried: window.__substrate.verbs.carried,
        lx: window.__substrate.verbs.lastLanding.x,
        lz: window.__substrate.verbs.lastLanding.z,
    }));
    const dx = v.lx - before.x;
    const dz = v.lz - before.z;
    const range = Math.hypot(dx, dz);
    const off = Math.abs(((Math.atan2(dx, dz) - before.facing + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
    const air = await page.evaluate(() => window.__substrate.verbs.inFlight);
    if (air > 0) {
        // Still up. Nothing has landed, so the only claim available is that the volume is
        // accounted for somewhere — and "in the air" is somewhere.
        console.log(`verbs: ${air} in the air, ${v.thrown.toFixed(6)} m3 thrown and ${v.landed.toFixed(6)} m3 landed so far (mid-flight)`);
    } else {
        const ok = v.landings === 1 && Math.abs(v.thrown - v.landed) < 1e-9 && v.carried === 0 && off < 1e-3;
        console.log(
            `verbs: threw ${v.thrown.toFixed(6)} m3, landed ${v.landed.toFixed(6)} m3 after ${range.toFixed(2)} m, ` +
                `${v.landings} landing(s), bearing off facing by ${off.toFixed(6)} rad ${ok ? "(CONSERVED)" : "*** LOST IN FLIGHT ***"}`,
        );
    }
}

// Hold the gather key and STOP, leaving material in the hands — the one verb state that
// has no representation in the world, and therefore the only one whose readout has to be
// checked by reading the overlay rather than by looking at the ground.
if (argv.has("gatherFor")) {
    // Ground height at the aim point BEFORE anything is dug, so the hole can be measured
    // rather than eyeballed.
    await page.evaluate(() => {
        const a = window.__substrate;
        window.__digBefore = a.gait.groundAt(a.verbs.target.x, a.verbs.target.z);
    });
    await page.keyboard.down("q");
    await page.waitForTimeout(Number(argv.get("gatherFor")) || 500);
    await page.keyboard.up("q");
    await page.waitForTimeout(150);
    const v = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll(".sb-sec *")).map((e) => e.textContent ?? "");
        const a = window.__substrate;
        return {
            carried: a.verbs.carried,
            row: rows.find((t) => t.includes("/") && t.includes("L")) ?? "(not rendered)",
            // How deep the hole actually got, measured through the same ground query the
            // character stands on — so this is the surface the game believes in, not the
            // buffer's own idea of itself.
            hole: window.__digBefore - a.gait.groundAt(a.verbs.target.x, a.verbs.target.z),
            radius: a.settings.get("play.digRadius"),
        };
    });
    // The closed form the scoop kernel is built on: a Gaussian of radius r carrying
    // `volume` peaks at volume / (pi * r^2). If the ground has not moved by about that
    // much, the geometry is not being displaced and the verb only looks like it works.
    const want = v.carried / (Math.PI * v.radius * v.radius);
    console.log(
        `verbs: carrying ${(v.carried * 1000).toFixed(0)} L, overlay reads "${v.row}"; ` +
            `hole ${(v.hole * 100).toFixed(1)} cm deep vs ${(want * 100).toFixed(1)} cm predicted`,
    );
}

// BUILD A MOUND, by hand and by throw, and check the game layer counted both. The claim
// that matters is not the arithmetic — it is that a thrown load and a placed one arrive at
// the same scoreboard, which is the reason both were routed through one deposit hook.
if (argv.has("build")) {
    const rounds = Number(argv.get("build")) || 2;
    // Count the goal layer's announcements by wrapping whatever main.ts already installed,
    // rather than replacing it — so this measures the real handlers on their real path. A
    // completion that fires every frame after the target is reached would show up here as a
    // count in the hundreds, and is the failure a latch exists to prevent.
    await page.evaluate(() => {
        const g = window.__substrate.goals;
        window.__calls = { founded: 0, complete: 0 };
        const f = g.onFounded;
        const c = g.onComplete;
        g.onFounded = (x, z) => {
            window.__calls.founded++;
            f?.(x, z);
        };
        g.onComplete = (l) => {
            window.__calls.complete++;
            c?.(l);
        };
    });
    for (let i = 0; i < rounds; i++) {
        // WALK OFF THE SITE TO DIG. The verbs aim at one point in front of the character,
        // so gathering and placing without moving digs the very hole being filled — which
        // is exactly what the first run of this did, leaving the site half a metre BELOW
        // where it started. A borrow pit has to be somewhere else, which is true of real
        // earthworks and is now true of the harness.
        if (i > 0) {
            await page.keyboard.down("s");
            await page.waitForTimeout(700);
            await page.keyboard.up("s");
        }
        await page.keyboard.down("q");
        await page.waitForTimeout(900);
        await page.keyboard.up("q");
        // Back to the site to unload.
        await page.keyboard.down("w");
        await page.waitForTimeout(700);
        await page.keyboard.up("w");
        // Alternate: place it at your feet, then throw the next one downrange. A throw
        // lands well outside the site radius, so the second half also checks that a load
        // delivered somewhere else is recorded as strayed rather than silently credited.
        await page.keyboard.down("f");
        await page.waitForTimeout(1200);
        await page.keyboard.up("f");
    }
    const g = await page.evaluate(() => {
        const a = window.__substrate;
        return {
            started: a.goals.started,
            delivered: a.goals.delivered,
            strayed: a.goals.strayed,
            progress: a.goals.progress,
            placed: a.verbs.placed,
            landed: a.verbs.landed,
            complete: a.goals.complete,
            calls: window.__calls,
            peak: a.goals.peakHeight,
            now: a.goals.height,
            settled: a.goals.settled,
        };
    });
    // Everything the verbs put on the ground has to appear on the scoreboard as either
    // delivered or strayed. A deposit that reached neither is a hook that did not fire.
    const accounted = g.delivered + g.strayed;
    const moved = g.placed + g.landed;
    const ok = g.started && Math.abs(accounted - moved) < 1e-9;
    console.log(
        `goals: ${(g.delivered * 1000).toFixed(0)} L on site, ${(g.strayed * 1000).toFixed(0)} L strayed, ` +
            `${(g.progress * 100).toFixed(0)}% of target; verbs moved ${(moved * 1000).toFixed(0)} L ` +
            `${ok ? "(ALL ACCOUNTED)" : "*** A DEPOSIT WENT UNCOUNTED ***"}`,
    );
    // Founded exactly once however many loads arrive; complete exactly once if at all.
    const announced = g.calls.founded === 1 && g.calls.complete === (g.complete ? 1 : 0);
    console.log(`goals: mound peaked at ${g.peak.toFixed(3)} m, now ${g.now.toFixed(3)} m, settled ${(g.settled * 100).toFixed(1)} cm`);
    console.log(
        `goals: announced founded x${g.calls.founded}, complete x${g.calls.complete} ` +
            `(mound ${g.complete ? "finished" : "unfinished"}) ${announced ? "(ONCE EACH)" : "*** REPEATED OR MISSED ***"}`,
    );
}

// A LEAP, measured. Airborne has to become true, the character has to actually rise, and
// the landing has to punch a crater — three claims, none of which a screenshot settles.
if (argv.has("leap")) {
    const base = await page.evaluate(() => window.__substrate.mover.position.y);
    await page.keyboard.press("Space");
    await page.waitForTimeout(120);
    const air = await page.evaluate(() => ({ up: window.__substrate.mover.airborne, y: window.__substrate.mover.position.y, vy: window.__substrate.mover.velocityY }));
    await page.waitForTimeout(1400);
    const land = await page.evaluate(() => {
        const a = window.__substrate;
        return { up: a.mover.airborne, y: a.mover.position.y, ground: a.gait.groundAt(a.mover.position.x, a.mover.position.z) };
    });
    console.log(`leap: airborne ${air.up} at +${(air.y - base).toFixed(3)} m rising ${air.vy.toFixed(2)} m/s; landed ${!land.up}, ground now ${((land.ground - base) * 100).toFixed(1)} cm vs start`);
}

// BEND THE GROUND. Hold the raise key and measure what the terrain actually did, at the
// point commanded and at the ring it drew from - because volume-neutral means both should
// move, in opposite directions, and a pillar that rose out of nothing would be the bug.
if (argv.has("bend")) {
    const ms = Number(argv.get("bend")) || 900;
    const before = await page.evaluate(() => {
        const a = window.__substrate;
        const t = a.verbs.target;
        const r = a.settings.get("play.bendRadius");
        return { c: a.gait.groundAt(t.x, t.z), rim: a.gait.groundAt(t.x + r * 1.22, t.z), x: t.x, z: t.z, r };
    });
    await page.keyboard.down(argv.get("bend") === "down" ? "v" : "c");
    await page.waitForTimeout(ms);
    await page.keyboard.up(argv.get("bend") === "down" ? "v" : "c");
    await page.waitForTimeout(200);
    const after = await page.evaluate((b) => {
        const a = window.__substrate;
        return { c: a.gait.groundAt(b.x, b.z), rim: a.gait.groundAt(b.x + b.r * 1.22, b.z), bent: a.verbs.bent };
    }, before);
    const centre = after.c - before.c;
    const rim = after.rim - before.rim;
    console.log(
        `bend: centre ${(centre * 100).toFixed(1)} cm, rim ${(rim * 100).toFixed(1)} cm, commanded ${after.bent.toFixed(2)} m ` +
            `${centre > 0.05 && rim < 0 ? "(RAISED, AND THE RING PAID FOR IT)" : "*** no displacement ***"}`,
    );
}

// THE PEDESTAL, AND THE LEAP OFF IT. Two claims: the character rides the ground it raises,
// and a jump from the top clears more than a jump from the flat. The second is the one
// worth measuring, because nothing anywhere adds the pedestal height to the jump - if it
// composes, it composes because the mover reads the surface it is actually standing on.
if (argv.has("pedestal")) {
    const ms = Number(argv.get("pedestal")) || 1400;
    const base = await page.evaluate(() => window.__substrate.mover.position.y);
    await page.keyboard.down("g");
    await page.waitForTimeout(ms);
    await page.keyboard.up("g");
    const top = await page.evaluate(() => window.__substrate.mover.position.y);
    await page.keyboard.press("Space");
    await page.waitForTimeout(130);
    const air = await page.evaluate(() => ({ y: window.__substrate.mover.position.y, up: window.__substrate.mover.airborne }));
    console.log(
        `pedestal: rode ${((top - base) * 100).toFixed(1)} cm up, leapt from there to ${((air.y - base) * 100).toFixed(1)} cm above the flat ` +
            `(airborne ${air.up}) ${top - base > 0.3 && air.y > top ? "(RODE IT, THEN LAUNCHED)" : "*** did not compose ***"}`,
    );
}

// Let the sky bake, the substrate settle and a few frames of wind blow through.
// HELD THROUGH THE SHUTTER. Every other verb flag here presses and releases, which is
// right for anything that leaves a mark on the ground — the mark outlives the key. A
// GESTURE does not: the arms relax back into the gait the moment the key comes up, so a
// shot of a bending pose has to be taken with the key still down.
if (argv.has("hold")) {
    await page.keyboard.down(argv.get("hold"));
    await page.waitForTimeout(500);
}

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
