#!/usr/bin/env node
//
// Is material conserved as it moves between the ground and the air?
//
// Phase 5 pass B2 closes a loop between two ping-ponged buffers: the air lifts mass off
// the ground and the ground pays it back where it settles. Both halves claim to move
// exactly the same amount the other way. A leak there is invisible for a long time and
// then the world is quietly missing a dune, so it is worth measuring rather than
// asserting.
//
// Run in volcanic: its decay half-life is 1e9 seconds, so nothing evaporates and the
// only things moving material are slump, diffusion and the air -- all of which conserve.
// Carve once, then watch the total.
//
//   node scripts/checkConserve.mjs

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

    app.settings.set("world.biome", "volcanic");
    app.settings.set("world.windStrength", 0.9);
    app.settings.set("sys.air", true);
    // --no-air runs the control: with the loop open, only slump, diffusion and decay
    // touch mass, and in volcanic all three conserve. If the total still moves, the leak
    // predates Phase 5 entirely.
    const flags = new URLSearchParams(location.search);
    app.settings.set("sys.airborne", !flags.has("noair"));
    // --uniform flattens the flow: no gusts, no slope speed-up, no separation. The
    // backward trace is then a pure shift, which semi-Lagrangian advects exactly. If the
    // drift collapses here, the leak is the advection's divergence and not the exchange.
    if (flags.has("uniform")) {
        app.settings.set("air.gustAmount", 0);
        app.settings.set("air.speedup", 0);
        app.settings.set("air.separation", 2);
    }
    for (let i = 0; i < 120 && app.terrain.field.baking; i++) await sleep(100);
    await sleep(2500);
    for (let i = 0; i < 120 && app.terrain.field.baking; i++) await sleep(100);

    // Private at compile time only; this is a measurement harness reaching in on purpose.
    const front = (sys) => sys._targets[sys._front];
    const size = app.settings.get("substrate.resolution");

    const total = async () => {
        const g = await front(app.substrate).readPixels(0, 0, null, true, false, 0, 0, size, size);
        const a = await front(app.airborne).readPixels(0, 0, null, true, false, 0, 0, size, size);
        let ground = 0;
        let air = 0;
        // G of the substrate is loose mass; R of the airborne buffer is what is up.
        for (let i = 0; i < g.length; i += 4) ground += g[i + 1];
        for (let i = 0; i < a.length; i += 4) air += a[i];
        return { ground, air };
    };

    // Carve a line so there is something loose to move.
    const wait = () => new Promise((r) => requestAnimationFrame(() => r()));
    for (let i = 0; i < 14; i++) {
        app.substrate.stamp((i - 7) * 1.1, 0, 0.9, 0.5);
        await wait();
    }
    await sleep(600);

    // SHORT INTERVALS, AND THAT IS THE POINT. The window is 64 m and the wind is 16 m/s,
    // so a parcel crosses it in about two seconds and leaves through an open boundary.
    // Measuring over ten seconds therefore measures the boundary, not conservation, and
    // reported a 44% "leak" for material that had simply blown away. Sample before the
    // first parcel can reach the edge and the only thing left to see is creation.
    const t0 = await total();
    await sleep(400);
    const t1 = await total();
    await sleep(400);
    const t2 = await total();

    return {
        t0,
        t1,
        t2,
        steps: app.substrate.steps,
        airSteps: app.airborne.steps,
        airborneOn: app.settings.get("sys.airborne"),
    };
}, );

await browser.close();

const fmt = (t) => `ground ${t.ground.toFixed(1)}  air ${t.air.toFixed(1)}  total ${(t.ground + t.air).toFixed(1)}`;
console.log(`airborne coupling: ${result.airborneOn ? "ON" : "OFF (control)"}`);
console.log(`steps: substrate ${result.steps}, airborne ${result.airSteps}  — these must match, or an exchange is applied more than once`);
console.log(`t+0.0s  ${fmt(result.t0)}`);
console.log(`t+0.4s  ${fmt(result.t1)}`);
console.log(`t+0.8s  ${fmt(result.t2)}`);

const a = result.t0.ground + result.t0.air;
const c = result.t2.ground + result.t2.air;
const drift = a > 1e-6 ? (c - a) / a : 0;
console.log("");
console.log(`drift: ${(drift * 100).toFixed(2)}%`);
console.log("");
// THIS IS A DIAGNOSTIC, NOT A PASS/FAIL, and pretending otherwise wasted a round.
// Exact conservation is not a property this model has: the window has an OPEN boundary
// that material legitimately blows out of, and the advection is semi-Lagrangian on a
// divergent 2D field standing in for a vertical flux it does not represent. Loss is
// expected and is a tuning matter.
//
// GAIN IS NOT. Material appearing from nowhere compounds, and a world that breeds sand
// is a runaway rather than a wrong number. Plain semi-Lagrangian duplicates in divergent
// flow and did exactly that at +50%; the Jacobian of the backward trace is what stops it.
// So the only hard assertion here is the one-sided one.
if (drift > 0.05) {
    console.log("FAIL: material is being CREATED. Check the advection Jacobian — plain");
    console.log("semi-Lagrangian duplicates wherever the flow diverges.");
    process.exitCode = 1;
} else {
    console.log(`no creation (drift is ${drift <= 0 ? "negative" : "within noise"}). Loss here is the open boundary`);
    console.log("plus the 2D advection, both expected. See the note in substrateRelax.fragment.wgsl.");
}
