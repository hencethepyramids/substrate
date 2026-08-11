#!/usr/bin/env node
//
// Does the weather actually take the work back?
//
// Phase 14 is about opposition, and the claim is easy to make and easy to fake. Wind that
// merely LOOKS violent is a particle effect; wind that undoes a build has to be measured
// against the same build left alone, because a snow mound settles on its own for several
// seconds after the last shovelful and that settling would happily be reported as erosion.
//
// So this raises the identical pile twice, from the same call with the same volume at the
// same place, and gives one of them a storm. The number that matters is the DIFFERENCE.
//
//   node scripts/probeWeather.mjs
//
// Runs in snow by default, which is where the mechanism reads most clearly and also where
// the design question lives: a snow pile is nearly permanent in a calm and loses about half
// of itself to a storm, so there is something worth protecting and a reason to hurry.
// `--biome=desert` is the other end — sand loses 70% to its own decay whether or not
// anything is blowing, so the storm is a smaller share of a pile that was never going to
// last. Both are the same code and the same numbers; only the element block differs.

import { chromium } from "playwright-core";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const URL = process.env.SUBSTRATE_URL ?? "http://localhost:5173/";
const argv = new Map();
for (const a of process.argv.slice(2)) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) argv.set(m[1], m[2] ?? "true");
}
const biome = argv.get("biome") ?? "snow";
const seconds = Number(argv.get("seconds") ?? 14);

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

const result = await page.evaluate(
    async ({ biome, seconds }) => {
        const app = window.__substrate;
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const wait = () => new Promise((r) => requestAnimationFrame(() => r()));

        app.settings.set("world.biome", biome);
        app.settings.set("sys.air", true);
        app.settings.set("sys.airborne", true);
        // The scheduler is what is being tested in the other direction; here the wind is
        // pinned by hand so the two runs differ by ONE number and not by where in a cycle
        // they happened to start.
        app.settings.set("sys.weather", false);
        for (let i = 0; i < 120 && app.terrain.field.baking; i++) await sleep(100);
        await sleep(1200);

        const cohesion = app.substrate._element.substrate.cohesion;
        const site = { x: app.mover.position.x + 6, z: app.mover.position.z + 6 };

        // MEASURED AS A VOLUME OVER THE WHOLE BUFFER, not as a height at a point, and the
        // first version of this probe got it wrong in a way worth recording: it asked
        // gait.groundAt(site), which reads the CPU ground-probe TILE — four metres wide and
        // centred on the character. The site was eight metres away, so every reading came
        // back as the bare heightfield and both runs reported an identical 3.704 m and zero
        // erosion. A perfectly steady number from an instrument pointed at the wrong place.
        //
        // Summing the depression channel needs no row order, no tile, and no assumption
        // about where anything is: material lifted off the ground and carried away simply
        // stops being in the sum.
        const front = (sys) => sys._targets[sys._front];
        const size = app.settings.get("substrate.resolution");
        const cell = (app.settings.get("substrate.extent") / size) ** 2;
        // RESTRICTED TO A DISC AROUND THE SITE, and the version that summed the whole window
        // was wrong in a way that reversed the answer. Wind does not only strip a pile, it
        // builds DRIFTS elsewhere — so a whole-window sum counts the material the storm piled
        // up somewhere else as though the pile still had it, and snow duly reported that a
        // storm LEFT MORE STANDING than a calm did. It is measuring the weather's total
        // effect on the window when the question is what happened to the thing that was
        // built.
        const texel = app.settings.get("substrate.extent") / size;
        const R = 4;
        const proudVolume = async (flip) => {
            const d = await front(app.substrate).readPixels(0, 0, null, true, false, 0, 0, size, size);
            const o = app.substrate.origin;
            let v = 0;
            for (let row = 0; row < size; row++) {
                const r = flip ? size - 1 - row : row;
                const wz = o.y + (r + 0.5) * texel;
                if (Math.abs(wz - site.z) > R) continue;
                for (let col = 0; col < size; col++) {
                    const wx = o.x + (col + 0.5) * texel;
                    if ((wx - site.x) ** 2 + (wz - site.z) ** 2 > R * R) continue;
                    const h = d[(row * size + col) * 4];
                    // Depression is positive for a hollow, so material proud is negative.
                    if (h < 0) v -= h;
                }
            }
            return v * cell;
        };

        /**
         * Raise one pile and watch it for `seconds` under a given wind.
         *
         * IDENTICAL IN BOTH RUNS DOWN TO THE CALL, which is what makes the comparison mean
         * anything: same place, same volume, same number of deposits, same settle time
         * before the clock starts. The only difference between the two is the wind.
         */
        let flip = null;
        const build = async (wind) => {
            app.substrate.reset();
            app.settings.set("world.windStrength", 0);
            await sleep(500);
            for (let i = 0; i < 16; i++) {
                app.substrate.scoop(site.x, site.z, 1.1, -0.09);
                await wait();
            }
            // Let it settle to its own angle of repose BEFORE the clock starts. Otherwise
            // the first seconds of the storm run are measuring slump, which happens either
            // way, and the storm would be credited with it.
            await sleep(2500);
            // Row order is chosen by measurement, once, against a pile that is definitely
            // there: the wrong hypothesis puts the disc mirrored about the window centre,
            // where there is nothing, and reads near zero.
            if (flip === null) flip = (await proudVolume(true)) > (await proudVolume(false));
            const before = await proudVolume(flip);
            app.settings.set("world.windStrength", wind);
            await sleep(seconds * 1000);
            const after = await proudVolume(flip);
            app.settings.set("world.windStrength", 0);
            return { before, after, lost: before - after };
        };

        const calm = await build(0.05);
        const storm = await build(0.95);

        // And the scheduler, separately: does the cycle actually reach a storm and come back
        // to a calm, and does it drive the one slider it claims to?
        app.settings.set("sys.weather", true);
        app.settings.set("weather.period", 8);
        const seen = new Set();
        let peakWind = 0;
        let minWind = 1;
        for (let i = 0; i < 90; i++) {
            seen.add(app.weather.sky);
            const w = app.settings.get("world.windStrength");
            peakWind = Math.max(peakWind, w);
            minWind = Math.min(minWind, w);
            await sleep(100);
        }

        return {
            biome,
            cohesion,
            calm,
            storm,
            flip,
            cycle: { seen: [...seen], peakWind, minWind, storms: app.weather.storms },
            settings: { calmWind: app.settings.get("weather.calmWind"), stormWind: app.settings.get("weather.stormWind") },
        };
    },
    { biome, seconds },
);

await browser.close();

const r = result;
console.log(`${r.biome} (cohesion ${r.cohesion}) — the same pile, raised twice, watched for ${seconds}s`);
console.log(`  calm   ${r.calm.before.toFixed(3)} m3 standing proud -> ${r.calm.after.toFixed(3)}   lost ${(r.calm.lost * 1000).toFixed(1)} litres`);
console.log(`  storm  ${r.storm.before.toFixed(3)} m3 standing proud -> ${r.storm.after.toFixed(3)}   lost ${(r.storm.lost * 1000).toFixed(1)} litres`);
const extra = r.storm.lost - r.calm.lost;
const pct = r.storm.before > 1e-6 ? (extra / r.storm.before) * 100 : 0;
console.log(`  -> the storm took ${(extra * 1000).toFixed(1)} litres more than standing still did (${pct.toFixed(1)}% of the pile)`);
console.log("");
console.log(`the cycle — period 8 s, sampled for 9 s`);
console.log(`  saw: ${r.cycle.seen.join(", ")}`);
console.log(`  world.windStrength ranged ${r.cycle.minWind.toFixed(2)} to ${r.cycle.peakWind.toFixed(2)} (calm ${r.settings.calmWind}, storm ${r.settings.stormWind})`);
console.log("");

let bad = 0;
const claim = (ok, text) => {
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${text}`);
    if (!ok) bad++;
};

// THE WHOLE POINT. Not "the pile got shorter" — a pile gets shorter on its own — but that
// the wind took MORE than the same pile lost while nothing was happening to it.
claim(r.storm.before > 0.5, `the pile was actually built (${r.storm.before.toFixed(3)} m3 standing proud)`);
claim(extra > 0.02, `a storm undoes work the calm does not (${(extra * 1000).toFixed(1)} litres beyond the control)`);
// A driver that reached its peak but never let go would be a tax rather than weather, and
// the calm is the half the design rests on.
claim(r.cycle.seen.includes("storm"), `the cycle reaches a storm`);
claim(r.cycle.seen.includes("calm"), `and comes back to flat calm`);
claim(r.cycle.storms >= 1, `storms are counted (${r.cycle.storms})`);
// It writes the one number it claims to write, rather than holding a private copy — the
// same contract the wheel zoom keeps with cam.armLength.
claim(r.cycle.peakWind > r.settings.stormWind * 0.8, `it drives world.windStrength up to the storm setting (${r.cycle.peakWind.toFixed(2)})`);
claim(r.cycle.minWind < r.settings.calmWind + 0.05, `and hands it back in the lull (${r.cycle.minWind.toFixed(2)})`);

console.log("");
if (bad === 0) {
    console.log("ok — the weather takes back more than time alone does, and the cycle has a real");
    console.log("calm in it rather than blowing forever.");
} else {
    console.log(`${bad} failure(s)`);
    process.exitCode = 1;
}
