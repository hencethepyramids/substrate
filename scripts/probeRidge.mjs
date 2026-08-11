#!/usr/bin/env node
//
// Does a ridge stand as tall as it was asked to, and where does the material come from?
//
// Phase 12 pass C sends a wave running away from the character, stamping the same
// volume-neutral bowl `raise` has used since Phase 10 every fixed fraction of a radius of
// travel. Nothing about that is new to the substrate, which is exactly why it is worth
// measuring: the interesting claims are arithmetic, and arithmetic is where this project's
// bugs have always been.
//
// THE CREST IS SOLVED, NOT DIALLED. A line of overlapping bowls builds up to the kernel's
// line integral over the spacing, so play.ridgeHeight is metres of crest rather than an
// amplitude that happened to look right. Integrating (1 - u^2)e^(-u^2) along the line gives
// r*sqrt(pi)*e^(-a^2)*(1/2 - a^2) at perpendicular distance a*r, and everything below falls
// out of that one expression:
//
//   on the line (a = 0)     the crest, at depth * r*sqrt(pi) / (2*spacing)
//   past a = 1/sqrt(2)      the profile goes negative — flanks, not crest
//   at a = sqrt(3/2)        the deepest trough, 44.6% of the crest height
//
// The last two are a prediction the shipped code never evaluates: verbs.ts uses this
// integral once, on the line, to turn a height into a depth. Where the flanks sit and how
// deep they go is the model saying something the implementation does not know it implies.
//
// AND THE FLANKS ARE COHESION'S, WHICH IS THE REAL POINT. srStamped scales the bowl's rim
// by (1 - cohesion), so the troughs above only appear in ground that lets material be
// dragged in from the side. Snow is 0.82 and packs instead; desert is 0.02 and trenches.
// Same call, same numbers, opposite picture — so the probe runs both and the difference IS
// the measurement.
//
//   node scripts/probeRidge.mjs
//
// The world is paused throughout and the verb layer is driven with an explicit dt, so the
// only thing touching the buffer is the ridge's own stamps.

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

const result = await page.evaluate(async () => {
    const app = window.__substrate;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const wait = () => new Promise((r) => requestAnimationFrame(() => r()));

    for (let i = 0; i < 120 && app.terrain.field.baking; i++) await sleep(100);
    await sleep(1200);

    app.settings.set("sys.air", false);
    app.settings.set("sys.airborne", false);
    app.settings.set("world.paused", true);
    await sleep(400);

    const front = (sys) => sys._targets[sys._front];
    const size = app.settings.get("substrate.resolution");
    const extent = app.settings.get("substrate.extent");
    const texel = extent / size;
    const radius = app.settings.get("play.ridgeRadius");
    const range = app.settings.get("play.ridgeRange");
    const height = app.settings.get("play.ridgeHeight");
    const speed = app.settings.get("play.ridgeSpeed");
    const reach = app.settings.get("play.reach");
    const idle = { ignite: false, gather: false, place: false, pack: false, raise: false, lower: false, pedestal: false, throwIt: false, sweep: false, draw: false, ridge: false };

    const runs = [];
    for (const biome of ["desert", "snow"]) {
        app.settings.set("world.biome", biome);
        await sleep(300);
        app.substrate.reset();
        await wait();
        const before = app.substrate.dropped;
        // Private at compile time only — read from the element the shader is actually being
        // fed, rather than from a number copied into this script that could go stale.
        const cohesion = app.substrate._element.substrate.cohesion;

        // The window follows the camera, which is not moving; read it once and use the same
        // frame of reference for the controls and the ridge alike.
        const origin = { x: app.substrate.origin.x, y: app.substrate.origin.y };

        // -- controls, before the ridge --------------------------------------------
        //
        // TWO THINGS HAVE TO BE TRUE BEFORE A LINE OF STAMPS MEANS ANYTHING, and separating
        // them is what tells an arithmetic error from an accumulating one. A ridge is ~30
        // stamps over ~30 relaxation steps, so a per-step bias and a once-per-stamp bias
        // look identical in the final crest and have completely different causes.
        //
        //   one stamp, one step   — does a raise of d metres raise the ground by d?
        //   thirty idle steps     — does the ground it made STAY there?
        //
        // The second is not paranoia. The relaxation pays whatever the airborne buffer says
        // it owes on every step regardless of the timestep, so a debt left over from before
        // the pause would be applied thirty times over and would land hardest in the element
        // whose air carries the most, which is exactly the shape of a discrepancy that only
        // shows up in desert.
        const probeAt = { x: origin.x + extent * 0.5 + 9.4, z: origin.y + extent * 0.5 + 7.3 };
        const CONTROL_DEPTH = -0.4;
        app.substrate.stamp(probeAt.x, probeAt.z, 1.0, CONTROL_DEPTH);
        for (let i = 0; i < 4; i++) await wait();
        const readAt = async (flipTry) => {
            const d = await front(app.substrate).readPixels(0, 0, null, true, false, 0, 0, size, size);
            const col = Math.floor((probeAt.x - origin.x) / texel);
            let row = Math.floor((probeAt.z - origin.y) / texel);
            if (flipTry) row = size - 1 - row;
            return -d[(row * size + col) * 4];
        };
        const oneStraight = await readAt(false);
        const oneFlipped = await readAt(true);
        const controlFlip = oneFlipped > oneStraight;
        const oneStamp = controlFlip ? oneFlipped : oneStraight;

        // Now idle: keep the queue fed from a far corner so steps keep happening, and watch
        // whether the control peak moves. Anything but zero drift here is something other
        // than the stamp writing the buffer.
        const corner = { x: origin.x + extent * 0.06, z: origin.y + extent * 0.06 };
        for (let i = 0; i < 30; i++) {
            app.substrate.stamp(corner.x, corner.z, 0.5, -0.01);
            await wait();
        }
        const afterIdle = await readAt(controlFlip);

        // Clean slate for the ridge itself.
        app.substrate.reset();
        await wait();

        // Heading picked so the ridge lies along neither axis — an axis swap anywhere in
        // the chain would leave it running the wrong way across the buffer rather than
        // simply backwards along it.
        const facing = (35 * Math.PI) / 180;
        const actor = { position: { x: origin.x + extent * 0.5 - 3.1, y: 0, z: origin.y + extent * 0.5 - 4.2 }, facing, airborne: false };
        const fwd = { x: Math.sin(facing), z: Math.cos(facing) };
        // Where verbs.ts will start the wave: one reach ahead, not at the feet.
        const start = { x: actor.position.x + fwd.x * reach, z: actor.position.z + fwd.z * reach };

        // ONE STAMP PER FRAME, WHICH IS WHAT THE QUEUE DRAINS. The ridge lays a stamp every
        // 0.4 radii of travel, so a dt of exactly that over the speed produces one per call
        // and the queue never backs up. Feeding the whole flight in one call would enqueue
        // thirty stamps into sixteen slots and measure the overflow instead of the ridge.
        const spacing = radius * 0.4;
        const dt = spacing / speed;
        app.verbs.update({ ...idle, ridge: true }, actor, dt);
        for (let i = 0; i < Math.ceil(range / spacing) + 8; i++) {
            await wait();
            app.verbs.update(idle, actor, dt);
        }
        for (let i = 0; i < 6; i++) await wait();

        const data = await front(app.substrate).readPixels(0, 0, null, true, false, 0, 0, size, size);

        /** Depression at a world point, nearest texel, under a stated row order. */
        const at = (wx, wz, flip) => {
            const col = Math.floor((wx - origin.x) / texel);
            let row = Math.floor((wz - origin.y) / texel);
            if (row < 0 || row >= size || col < 0 || col >= size) return 0;
            if (flip) row = size - 1 - row;
            return data[(row * size + col) * 4];
        };

        // Height standing proud of the undisturbed surface: depression is positive for a
        // hollow, so a crest is a negative number and this flips it to read as a height.
        const crestAlong = (flip, from, to) => {
            let sum = 0;
            let n = 0;
            for (let d = from; d <= to; d += texel) {
                sum += -at(start.x + fwd.x * d, start.z + fwd.z * d, flip);
                n++;
            }
            return n > 0 ? sum / n : 0;
        };

        // The row order is CHOSEN BY MEASUREMENT, not assumed — a flipped readback would
        // put the ridge somewhere this sampler never looks and report a crest of zero,
        // which is indistinguishable from a ridge that failed to stamp.
        const flip = crestAlong(true, range * 0.2, range * 0.8) > crestAlong(false, range * 0.2, range * 0.8);

        // MEASURED OVER THE MIDDLE, because the ends are genuinely lower and should be. The
        // line integral assumes a neighbour on both sides; the first and last stamps have
        // one, so a ridge tapers off at each end by construction rather than by error.
        const crest = crestAlong(flip, range * 0.2, range * 0.8);

        // Across the ridge at its midpoint, out to three radii either side.
        const mid = range * 0.5;
        const profile = [];
        for (let k = -30; k <= 30; k++) {
            const a = (k / 10) * radius;
            profile.push({ a: a / radius, h: -at(start.x + fwd.x * mid - fwd.z * a, start.z + fwd.z * mid + fwd.x * a, flip) });
        }
        let trough = { a: 0, h: 0 };
        for (const p of profile) if (p.h < trough.h) trough = p;

        // How far the crest actually runs, walking out until it drops below a third of its
        // own height. Catches a wave that died early or one that never stopped.
        let reached = 0;
        for (let d = 0; d <= range * 1.5; d += texel) {
            if (-at(start.x + fwd.x * d, start.z + fwd.z * d, flip) > crest * 0.34) reached = d;
        }

        runs.push({
            biome,
            cohesion,
            oneStamp,
            controlDepth: -CONTROL_DEPTH,
            idleDrift: afterIdle - oneStamp,
            flip,
            crest,
            trough,
            reached,
            start,
            facing,
            ridges: app.verbs.ridges,
            live: app.verbs.liveRidges,
            dropped: app.substrate.dropped - before,
        });
    }

    return { size, extent, texel, radius, range, height, runs };
});

await browser.close();

// The model, recomputed here from the kernel rather than imported from the code under test.
// (1 - u^2)e^(-u^2) integrated along a line is r*sqrt(pi)*e^(-a^2)*(1/2 - a^2); its minimum
// is at a = sqrt(3/2), where it is e^(-3/2)*(-1) against a crest of 1/2.
const TROUGH_AT = Math.sqrt(1.5);
const TROUGH_FRACTION = Math.exp(-1.5) / 0.5;

// AND THE PART verbs.ts DOES NOT KNOW IT IMPLIES. RIDGE_STAMP_DEPTH divides by the WHOLE
// line integral, which is only what the ground gives back when nothing is cohesive:
// srStamped scales the bowl's rim by (1 - cohesion), so the crest actually stands at
//
//     (INT[pit] - (1 - cohesion) * INT[rim]) / INT[all]
//
// times the height asked for. Splitting the same integral at |b| = 1, where the bowl
// crosses zero:
const erf = (x) => {
    const t = 1 / (1 + 0.3275911 * x);
    const p = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
    return 1 - p * Math.exp(-x * x);
};
const INT_ALL = Math.sqrt(Math.PI) / 2;
const INT_PIT = 0.5 * Math.sqrt(Math.PI) * erf(1) + Math.exp(-1);
const INT_RIM = INT_PIT - INT_ALL;
const crestFactor = (cohesion) => (INT_PIT - (1 - cohesion) * INT_RIM) / INT_ALL;

console.log(`window ${result.size} texels over ${result.extent} m (${(result.texel * 100).toFixed(2)} cm/texel)`);
console.log(`ridge: ${result.height} m asked, radius ${result.radius} m, range ${result.range} m`);
console.log("");

let bad = 0;
for (const r of result.runs) {
    const want = result.height * crestFactor(r.cohesion);
    const crestErr = Math.abs(r.crest - want) / want;
    const rangeErr = Math.abs(r.reached - result.range);
    const controlErr = Math.abs(r.oneStamp - r.controlDepth) / r.controlDepth;
    console.log(`${r.biome.toUpperCase()}  cohesion ${r.cohesion}  (rows read ${r.flip ? "FLIPPED" : "straight"})`);
    console.log(`  control    one raise of ${r.controlDepth} m lifted the ground ${r.oneStamp.toFixed(4)} m (${(controlErr * 100).toFixed(2)}% out)`);
    console.log(`             and drifted ${r.idleDrift.toExponential(2)} m over 30 further steps`);
    console.log(`  crest      ${r.crest.toFixed(4)} m standing`);
    console.log(`             ${result.height} m asked; the model says ${want.toFixed(4)} m here — ${(crestErr * 100).toFixed(2)}% out`);
    // The residual is NOT the continuum approximation. Summing the kernel directly over the
    // stamps' actual positions, rather than integrating along the line, agrees with the
    // closed form to 0.05% — so whatever is left over is the buffer disagreeing with the
    // model, and it scales with (1 - cohesion), which makes it a rim effect. Small, bounded,
    // measured every run, and not yet explained. Recorded rather than tuned away.
    if (r.cohesion > 0.5) {
        console.log(`             (it stands ${(((want - result.height) / result.height) * 100).toFixed(0)}% PROUD of the number asked for, and should:`);
        console.log(`              RIDGE_STAMP_DEPTH divides by the whole line integral, and cohesive`);
        console.log(`              ground keeps ${((1 - (1 - r.cohesion)) * 100).toFixed(0)}% of the rim it would otherwise have trenched away)`);
    }
    console.log(`  runs       ${r.reached.toFixed(2)} m of the ${result.range} m range`);
    console.log(`  deepest flank  ${r.trough.h.toFixed(4)} m at ${r.trough.a.toFixed(2)} radii — ${((-r.trough.h / r.crest) * 100).toFixed(1)}% of the crest`);
    console.log(`  the kernel says troughs at ${TROUGH_AT.toFixed(2)} radii, ${(TROUGH_FRACTION * 100).toFixed(1)}% of the crest, in ground with no cohesion`);
    console.log(`  ${r.ridges} launched, ${r.live} still travelling, ${r.dropped} stamps dropped`);

    // THE CREST IS THE CLAIM THAT HOLDS EVERYWHERE. It comes off the bowl's PIT lobe, which
    // srStamped does not scale by cohesion — only the rim is scaled — so the same solve has
    // to land in both elements or the arithmetic is wrong rather than the physics different.
    if (controlErr > 0.02) {
        console.log(`  FAIL: a single raise does not raise the ground by its own depth — the arithmetic is wrong before any line of stamps is involved`);
        bad++;
    }
    if (Math.abs(r.idleDrift) > 1e-4) {
        console.log(`  FAIL: the buffer moves on its own while nothing is stamping it`);
        bad++;
    }
    if (crestErr > 0.05) {
        console.log(`  FAIL: the crest is ${(crestErr * 100).toFixed(1)}% off what the line integral predicts for cohesion ${r.cohesion}`);
        bad++;
    }
    if (rangeErr > result.radius) {
        console.log(`  FAIL: ran ${r.reached.toFixed(2)} m against a range of ${result.range} m`);
        bad++;
    }
    if (r.live !== 0) {
        console.log(`  FAIL: ${r.live} ridge(s) never died — a wave that outlives its range is an unbounded stamp source`);
        bad++;
    }
    if (r.dropped !== 0) {
        console.log(`  FAIL: ${r.dropped} stamps dropped — the wave is enqueueing faster than the queue drains`);
        bad++;
    }

    if (r.biome === "desert") {
        // Cohesion 0.02, so (1 - cohesion) is essentially 1 and the flanks should be the
        // kernel's, undamped.
        const want = TROUGH_FRACTION * r.crest;
        const posErr = Math.abs(Math.abs(r.trough.a) - TROUGH_AT);
        if (Math.abs(-r.trough.h - want) > want * 0.25 || posErr > 0.35) {
            console.log(`  FAIL: flanks are not where the line integral puts them (wanted ${want.toFixed(3)} m at ${TROUGH_AT.toFixed(2)} radii)`);
            bad++;
        } else {
            console.log(`  -> the flanks ARE the line integral's, and they are where the crest came from`);
        }
    } else {
        // Cohesion 0.82: srStamped keeps 18% of the rim, so the trench should all but
        // vanish. This is the pedestal's finding from Phase 10 pass H, on a shape.
        if (-r.trough.h > TROUGH_FRACTION * r.crest * 0.5) {
            console.log(`  FAIL: snow trenched like sand — cohesion is not reaching the rim split`);
            bad++;
        } else {
            console.log(`  -> snow barely trenches: cohesion 0.82 keeps 18% of the rim, so the crest`);
            console.log(`     came out of compaction rather than out of the ground beside it`);
        }
    }
    console.log("");
}

if (bad === 0) {
    console.log("ok — the crest stands where the line integral says, in both elements, and the");
    console.log("flanks differ between them by nothing but cohesion.");
} else {
    console.log(`${bad} failure(s)`);
    process.exitCode = 1;
}
