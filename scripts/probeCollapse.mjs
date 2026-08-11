#!/usr/bin/env node
//
// How tall can you build before it comes down?
//
// Phase 14 pass B gives cohesion a budget. Until now it was a licence: spCohesionAt carries
// the repose angle toward vertical and says nothing about how much is stacked on top, so a
// snow face held at 78 degrees whether it was one metre tall or thirty. A tower to the
// buffer's own ceiling stood there indefinitely, which is the last thing in this project
// that a player could do and never be told no.
//
// TWO QUESTIONS, AND THE SECOND ONE IS THE RISK. The first is whether tall piles now fail —
// easy to arrange and easy to see. The second is whether anything that used to stand STILL
// stands: the rule is meant to change only what happens above the critical height, and every
// result measured before it existed was measured below one. A collapse rule that also
// quietly slumped every bootprint and berm in the world would look like a success in the
// first measurement and be a disaster.
//
//   node scripts/probeCollapse.mjs
//
// Builds columns of increasing height in one element, lets them settle, and reports what is
// left of each. The knee in that column is the critical height.

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
    async ({ biome }) => {
        const app = window.__substrate;
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const wait = () => new Promise((r) => requestAnimationFrame(() => r()));

        app.settings.set("world.biome", biome);
        // No wind: the question is whether it stands under its OWN weight. Pass A already
        // measured what weather takes, and leaving it on here would mix the two.
        app.settings.set("sys.air", false);
        app.settings.set("sys.airborne", false);
        app.settings.set("world.windStrength", 0);
        for (let i = 0; i < 120 && app.terrain.field.baking; i++) await sleep(100);
        await sleep(1200);

        const cohesion = app.substrate._element.substrate.cohesion;
        const front = (sys) => sys._targets[sys._front];
        const size = app.settings.get("substrate.resolution");
        const texel = app.settings.get("substrate.extent") / size;
        const site = { x: app.substrate.origin.x + 32, z: app.substrate.origin.y + 32 };

        /** Tallest thing standing proud within a disc of the site, metres. */
        const peak = async (flip) => {
            const d = await front(app.substrate).readPixels(0, 0, null, true, false, 0, 0, size, size);
            const o = app.substrate.origin;
            let best = 0;
            for (let row = 0; row < size; row++) {
                const r = flip ? size - 1 - row : row;
                const wz = o.y + (r + 0.5) * texel;
                if (Math.abs(wz - site.z) > 5) continue;
                for (let col = 0; col < size; col++) {
                    const wx = o.x + (col + 0.5) * texel;
                    if ((wx - site.x) ** 2 + (wz - site.z) ** 2 > 25) continue;
                    best = Math.max(best, -d[(row * size + col) * 4]);
                }
            }
            return best;
        };

        let flip = null;
        const runs = [];
        // RAISED WITH THE SAME stamp() THE `C` VERB USES, in one shot rather than over time,
        // so the pile starts at a known height and everything after is the ground's own
        // answer to it rather than a race between building and slumping.
        for (const want of [0.5, 1.0, 1.6, 2.4, 3.2, 4.0]) {
            app.substrate.reset();
            await wait();
            app.substrate.stamp(site.x, site.z, 1.0, -want);
            for (let i = 0; i < 4; i++) await wait();
            if (flip === null) flip = (await peak(true)) > (await peak(false));
            const raised = await peak(flip);
            // Long enough for a failing face to have failed. Slump is a rate, so a column
            // that is going to come down is most of the way down in a couple of seconds.
            await sleep(4000);
            const stood = await peak(flip);
            runs.push({ want, raised, stood, kept: raised > 1e-6 ? stood / raised : 0 });
        }

        return { biome, cohesion, runs, flip };
    },
    { biome },
);

await browser.close();

const r = result;
console.log(`${r.biome} (cohesion ${r.cohesion}) — columns raised in one stamp, then left alone for 4 s`);
console.log("");
console.log("   asked    raised     stood    kept");
for (const x of r.runs) {
    console.log(`  ${x.want.toFixed(2)} m   ${x.raised.toFixed(3)} m   ${x.stood.toFixed(3)} m   ${(x.kept * 100).toFixed(0)}%`);
}
console.log("");

// The model's own number, recomputed here rather than read out of the shader.
const critical = r.cohesion * 2.6;
console.log(`  the model puts the critical height at cohesion * 2.6 = ${critical.toFixed(2)} m,`);
console.log(`  with the face fully gone by ${(critical * 1.5).toFixed(2)} m`);
console.log("");

let bad = 0;
const claim = (ok, text) => {
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${text}`);
    if (!ok) bad++;
};

const below = r.runs.filter((x) => x.raised < critical * 0.95);
const above = r.runs.filter((x) => x.raised > critical * 1.6);

// THE REGRESSION HALF, and it is the one worth having. Everything this project measured
// before the rule existed was measured below a critical height, and all of it has to be
// untouched — a collapse rule that also slumped every print and berm would pass the
// interesting claim below and ruin the world.
claim(
    below.length > 0 && below.every((x) => x.kept > 0.9),
    `everything under the critical height still stands (${below.map((x) => `${(x.kept * 100).toFixed(0)}%`).join(", ")})`,
);
// And the new half.
claim(above.length > 0 && above.every((x) => x.kept < 0.8), `everything well over it comes down (${above.map((x) => `${(x.kept * 100).toFixed(0)}%`).join(", ")})`);
// A rule that merely capped the height would leave every tall column at exactly the same
// number; a rule that FAILS leaves less standing the more was stacked.
const tall = r.runs[r.runs.length - 1];
const mid = r.runs[r.runs.length - 2];
claim(tall.kept <= mid.kept + 0.02, `the taller the pile the less of it survives (${(mid.kept * 100).toFixed(0)}% then ${(tall.kept * 100).toFixed(0)}%)`);

console.log("");
if (bad === 0) {
    console.log("ok — cohesion has a budget now. Under it nothing changed; over it the face fails");
    console.log("under its own weight, which is the one thing a player could not previously be told.");
} else {
    console.log(`${bad} failure(s)`);
    process.exitCode = 1;
}
