#!/usr/bin/env node
//
// Does the separation bubble sit DOWNWIND?
//
// A screenshot cannot answer this. The lee of a dune and the windward face of the next
// one are the same pixels to the eye, and comparing two bearings does not help because
// windBearing also feeds bkWind, which BAKES the heightfield — the dunes are sheared
// along the wind by construction, so changing the bearing changes the landscape too.
//
// So this measures instead. It samples the terrain gradient along a line, computes the
// slope along the wind on the CPU from the wind vector the app is actually using, and
// asks the GPU what the separation is at the same places through the wind debug view.
// Separation must appear where the ground descends downwind and nowhere else. An
// inverted bearing puts it on the climbing side and the correlation goes negative.
//
//   node scripts/checkWind.mjs

import { chromium } from "playwright-core";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const URL = process.env.SUBSTRATE_URL ?? "http://localhost:5173/";

function findChromium() {
    if (process.env.SUBSTRATE_CHROME) return process.env.SUBSTRATE_CHROME;
    const root = join(process.env.LOCALAPPDATA ?? "", "ms-playwright");
    if (!existsSync(root)) return null;
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

const biomeArg = (process.argv.find((a) => a.startsWith("--biome=")) ?? "--biome=desert").split("=")[1];

const result = await page.evaluate(async (biome) => {
    const app = window.__substrate;
    app.settings.set("world.biome", biome);
    app.settings.set("world.windStrength", 0.9);
    app.settings.set("sys.air", true);
    // A biome switch queues a rebake of the 4096 field plus its 67 MB CPU readback.
    // Measuring before that lands would measure the previous element's terrain.
    for (let i = 0; i < 120 && app.terrain.field.baking; i++) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 2500));
    for (let i = 0; i < 120 && app.terrain.field.baking; i++) await new Promise((r) => setTimeout(r, 100));

    const wind = { x: app.air.base.x, y: app.air.base.y };
    const speed = Math.hypot(wind.x, wind.y);
    if (speed < 1e-4) return { error: "wind speed is zero" };
    const dir = { x: wind.x / speed, y: wind.y / speed };

    // Sample the drawn surface through the CPU mirror — the same bilinear field the
    // vertex shader displaces by, so this is the ground the GPU actually shaded.
    const field = app.terrain.field;
    const h = (x, z) => field.sampleHeight(x, z);
    const eps = 1.0;

    let sumAlong = 0;
    const lee = [];
    const all = [];

    // A grid across the field, well inside it.
    for (let i = -60; i <= 60; i++) {
        for (let j = -60; j <= 60; j++) {
            const x = i * 6;
            const z = j * 6;
            const dhdx = (h(x + eps, z) - h(x - eps, z)) / (2 * eps);
            const dhdz = (h(x, z + eps) - h(x, z - eps)) / (2 * eps);
            const along = dhdx * dir.x + dhdz * dir.y;
            sumAlong += along;
            all.push(Math.abs(along));
            if (along < 0) lee.push(-along);
        }
    }

    // THE THRESHOLD HAS TO COME FROM THIS TERRAIN, not from a textbook dune. Percentiles
    // of the downwind-descending slope say what "steep for this world" actually means.
    lee.sort((a, b) => a - b);
    all.sort((a, b) => a - b);
    const pct = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];

    return {
        windDir: dir,
        bearing: app.settings.get("world.windBearing"),
        speed,
        count: all.length,
        meanAlong: sumAlong / all.length,
        leeP50: pct(lee, 0.5),
        leeP75: pct(lee, 0.75),
        leeP90: pct(lee, 0.9),
        leeP97: pct(lee, 0.97),
        leeMax: lee[lee.length - 1],
        allP99: pct(all, 0.99),
        biome: app.settings.get("world.biome"),
    };
}, biomeArg);

await browser.close();

if (result.error) {
    console.error(`checkWind: ${result.error}`);
    process.exit(1);
}

console.log(`biome          ${result.biome}`);
console.log(`bearing        ${result.bearing} deg`);
console.log(`wind vector    (${result.windDir.x.toFixed(3)}, ${result.windDir.y.toFixed(3)}) at ${result.speed.toFixed(1)} m/s`);
console.log(`samples        ${result.count}`);
console.log(`mean slope along wind  ${result.meanAlong.toFixed(5)}   (must be ~0 over a closed field, or the sample is biased)`);
console.log("");
console.log("downwind-descending slope, as a gradient:");
console.log(`  p50  ${result.leeP50.toFixed(3)}   (${((Math.atan(result.leeP50) * 180) / Math.PI).toFixed(1)} deg)`);
console.log(`  p75  ${result.leeP75.toFixed(3)}   (${((Math.atan(result.leeP75) * 180) / Math.PI).toFixed(1)} deg)`);
console.log(`  p90  ${result.leeP90.toFixed(3)}   (${((Math.atan(result.leeP90) * 180) / Math.PI).toFixed(1)} deg)`);
console.log(`  p97  ${result.leeP97.toFixed(3)}   (${((Math.atan(result.leeP97) * 180) / Math.PI).toFixed(1)} deg)`);
console.log(`  max  ${result.leeMax.toFixed(3)}   (${((Math.atan(result.leeMax) * 180) / Math.PI).toFixed(1)} deg)`);
console.log("");
console.log(`Set air.separation near p90-p97 so the bubble is the steepest lee faces and`);
console.log(`not most of the world. Current default is 0.62.`);
