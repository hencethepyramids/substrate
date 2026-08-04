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
for (const a of process.argv.slice(2)) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) argv.set(m[1], m[2] ?? "true");
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
// The overlay is a wall of text over the picture; off unless asked for.
settings["ui.overlayOpen"] = argv.get("overlay") === "true";

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

await browser.close();

console.log(`adapter: ${adapter}`);
console.log(`booted:  ${booted}`);
console.log(`shot:    ${out}`);
console.log("--- console ---");
for (const line of log) console.log(line);

// A failed boot is a failed run. Anything else and the picture is worth looking at.
process.exit(booted ? 0 : 1);
