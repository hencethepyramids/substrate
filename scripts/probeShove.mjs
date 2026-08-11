#!/usr/bin/env node
//
// Does a shove move the volume it was asked to, in the direction it was asked to?
//
// Phase 12 pass A adds the one substrate operation that is not radially symmetric: material
// taken from one place and put down in another. Two things about it can be wrong in ways
// that look perfectly healthy from a screenshot.
//
// THE VOLUME. The kernel is one Gaussian minus the same Gaussian somewhere else, and where
// the two overlap they cancel — so the material that actually crosses from source to sink
// is erf(|v| / radius) of a Gaussian, not all of it. A naive pi*r^2 amplitude solve is
// therefore SHORT, by 48% at a displacement of one radius, and the shove is still perfectly
// volume-neutral while being short: what it lifts it delivers, it just lifts less than you
// asked for. Nothing downstream can notice. So the probe asks for a known volume at two
// geometries — one where the lobes barely overlap and one where they overlap badly — and
// measures what arrived.
//
// THE DIRECTION. This project has shipped a self-consistent mirror twice (the heightfield's
// Z flip, the sky LUT's v flip), and a shove that transports along +Z when told +X would
// pass every volume check above perfectly. So the bearing is measured too — and because a
// readback's row order is exactly the kind of thing that produces such a mirror, the script
// CALIBRATES that order first, against a radially symmetric scoop at a known world point,
// rather than assuming it. An instrument this project trusts is one that has been pointed
// at a known answer first.
//
//   node scripts/probeShove.mjs
//
// Runs the world PAUSED, which makes dt zero: no slump, no diffusion, no decay, no gait.
// One stamp and nothing else, which is the same condition the boot probe measures under.

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

    // THE AIR IS THE ONE THING THAT STILL WRITES DEPRESSION AT dt = 0. The relaxation pays
    // whatever the airborne buffer says it owes on every step regardless of the timestep, so
    // a stale debt left over from before the pause would land on top of the measurement.
    // Off, and the clean-field check at the end is what confirms it stayed off.
    app.settings.set("sys.air", false);
    app.settings.set("sys.airborne", false);
    app.settings.set("world.paused", true);
    await sleep(400);

    // Private at compile time only; this is a measurement harness reaching in on purpose.
    const front = (sys) => sys._targets[sys._front];
    const size = app.settings.get("substrate.resolution");
    const extent = app.settings.get("substrate.extent");
    const texel = extent / size;
    const cell = texel * texel;

    /** One relaxation step lands the queued stamp; the frames after it are no-ops at dt = 0. */
    const settle = async () => {
        for (let i = 0; i < 4; i++) await wait();
        return front(app.substrate).readPixels(0, 0, null, true, false, 0, 0, size, size);
    };

    /**
     * Reduce the depression channel to volumes and centroids, under a stated row order.
     *
     * `flip` is the hypothesis being tested, not a correction believed in advance — which
     * row a readback calls zero is a property of the driver, and the caller picks the
     * hypothesis by measuring a known input rather than by asserting one.
     */
    const reduce = (data, origin, flip) => {
        let lifted = 0;
        let dropped = 0;
        let sx = 0;
        let sz = 0;
        let dx = 0;
        let dz = 0;
        for (let row = 0; row < size; row++) {
            const r = flip ? size - 1 - row : row;
            const wz = origin.y + (r + 0.5) * texel;
            for (let col = 0; col < size; col++) {
                const d = data[(row * size + col) * 4];
                if (d === 0) continue;
                const wx = origin.x + (col + 0.5) * texel;
                const v = d * cell;
                if (v > 0) {
                    lifted += v;
                    sx += wx * v;
                    sz += wz * v;
                } else {
                    dropped -= v;
                    dx += wx * -v;
                    dz += wz * -v;
                }
            }
        }
        return {
            lifted,
            dropped,
            net: lifted - dropped,
            source: lifted > 1e-9 ? { x: sx / lifted, z: sz / lifted } : null,
            sink: dropped > 1e-9 ? { x: dx / dropped, z: dz / dropped } : null,
        };
    };

    /** Largest depression anywhere further than `keepOut` metres from `cx, cz`. */
    const strayMax = (data, origin, flip, cx, cz, keepOut) => {
        let worst = 0;
        for (let row = 0; row < size; row++) {
            const r = flip ? size - 1 - row : row;
            const wz = origin.y + (r + 0.5) * texel;
            for (let col = 0; col < size; col++) {
                const d = data[(row * size + col) * 4];
                if (d === 0) continue;
                const wx = origin.x + (col + 0.5) * texel;
                if ((wx - cx) ** 2 + (wz - cz) ** 2 < keepOut * keepOut) continue;
                worst = Math.max(worst, Math.abs(d));
            }
        }
        return worst;
    };

    const origin = { x: app.substrate.origin.x, y: app.substrate.origin.y };
    const midX = origin.x + extent * 0.5;
    const midZ = origin.y + extent * 0.5;

    // -- calibration: a scoop at a known point, to fix the row order -----------------
    //
    // Offset asymmetrically from the window centre in both axes, so a Z mirror, an X mirror
    // and an axis swap each move the answer by metres rather than by nothing.
    const calX = midX + 4.3;
    const calZ = midZ - 2.7;
    app.substrate.reset();
    await wait();
    app.substrate.scoop(calX, calZ, 1.0, 0.4);
    const calData = await settle();
    const calStraight = reduce(calData, origin, false);
    const calFlipped = reduce(calData, origin, true);
    const errOf = (m) => (m.source === null ? Infinity : Math.hypot(m.source.x - calX, m.source.z - calZ));
    const flip = errOf(calFlipped) < errOf(calStraight);
    const calibration = {
        asked: { x: calX, z: calZ },
        straight: { found: calStraight.source, error: errOf(calStraight) },
        flipped: { found: calFlipped.source, error: errOf(calFlipped) },
        flip,
        volume: (flip ? calFlipped : calStraight).lifted,
    };

    // -- the shoves ------------------------------------------------------------------
    //
    // Two geometries with the same asked-for volume and the same bearing. The first has its
    // lobes far enough apart that the overlap correction is nearly 1 and a naive solve would
    // look fine; the second has them a single radius apart, where the correction is the
    // difference between delivering what was asked and delivering half of it.
    const bearing = Math.atan2(1.0, 2.0); // dx 2, dz 1 — asymmetric in both axes.
    const cases = [];
    for (const g of [
        { name: "long", radius: 0.8, len: 3.2, volume: 0.5 },
        { name: "short", radius: 1.2, len: 1.2, volume: 0.5 },
    ]) {
        const vx = Math.cos(bearing) * g.len;
        const vz = Math.sin(bearing) * g.len;
        const fromX = midX - vx * 0.5;
        const fromZ = midZ - vz * 0.5;

        app.substrate.reset();
        await wait();
        app.substrate.shove(fromX, fromZ, g.radius, vx, vz, g.volume);
        const data = await settle();
        const m = reduce(data, origin, flip);

        cases.push({
            ...g,
            asked: { fromX, fromZ, toX: fromX + vx, toZ: fromZ + vz, vx, vz },
            lifted: m.lifted,
            dropped: m.dropped,
            net: m.net,
            source: m.source,
            sink: m.sink,
            // The bearing the buffer actually transported along, source centroid to sink
            // centroid. Independent of both the volume solve and the amplitude.
            measured: m.source && m.sink ? Math.atan2(m.sink.z - m.source.z, m.sink.x - m.source.x) : null,
            separation: m.source && m.sink ? Math.hypot(m.sink.x - m.source.x, m.sink.z - m.source.z) : null,
            stray: strayMax(data, origin, flip, midX, midZ, g.len * 0.5 + g.radius * 4),
        });
    }

    return { size, extent, texel, origin, bearing, calibration, cases, steps: app.substrate.steps, dropped: app.substrate.dropped };
});

await browser.close();

const deg = (r) => ((r * 180) / Math.PI).toFixed(2);
const c = result.calibration;

/** Abramowitz & Stegun 7.1.26. Deliberately a second copy — see the prediction below. */
function erf(x) {
    const t = 1 / (1 + 0.3275911 * x);
    const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
    return 1 - poly * Math.exp(-x * x);
}

console.log(`window: ${result.size} texels over ${result.extent} m — ${(result.texel * 100).toFixed(2)} cm per texel`);
console.log("");
console.log("CALIBRATION — a scoop of 0.400 m3 at a known point, to fix the readback's row order");
console.log(`  asked at      x ${c.asked.x.toFixed(3)}  z ${c.asked.z.toFixed(3)}`);
console.log(`  rows straight x ${c.straight.found?.x.toFixed(3)}  z ${c.straight.found?.z.toFixed(3)}   error ${c.straight.error.toFixed(3)} m`);
console.log(`  rows flipped  x ${c.flipped.found?.x.toFixed(3)}  z ${c.flipped.found?.z.toFixed(3)}   error ${c.flipped.error.toFixed(3)} m`);
console.log(`  -> reading rows ${c.flip ? "FLIPPED" : "straight"}; the scoop lifted ${c.volume.toFixed(4)} m3 of the 0.4 asked`);

let bad = 0;
const chosenError = c.flip ? c.flipped.error : c.straight.error;
if (chosenError > result.texel * 4) {
    console.log("  FAIL: neither row order finds the scoop where it was put — the mapping is wrong in some other way");
    bad++;
}

for (const k of result.cases) {
    const ratio = k.volume > 0 ? k.lifted / k.volume : 0;
    const naive = 1 / (k.lifted / k.volume);
    console.log("");
    console.log(`SHOVE (${k.name}) — ${k.volume.toFixed(3)} m3, radius ${k.radius} m, displaced ${k.len} m (${(k.len / k.radius).toFixed(2)} radii)`);
    console.log(`  from  x ${k.asked.fromX.toFixed(3)}  z ${k.asked.fromZ.toFixed(3)}      to  x ${k.asked.toX.toFixed(3)}  z ${k.asked.toZ.toFixed(3)}`);
    console.log(`  lifted  ${k.lifted.toFixed(4)} m3      delivered ${k.dropped.toFixed(4)} m3      net ${k.net.toExponential(2)} m3`);
    console.log(`  volume delivered: ${(ratio * 100).toFixed(2)}% of what was asked`);
    console.log(`  source centroid  x ${k.source.x.toFixed(3)}  z ${k.source.z.toFixed(3)}`);
    // AN INDEPENDENT PREDICTION, and the strongest line in this probe.
    //
    // The centroids do NOT sit at the two points the caller named, and should not: the
    // lobes cancel across the bisector, so what survives on each side has its centre of
    // mass pushed outward, to len / erf(len / 2r). That comes from the kernel's FIRST
    // moment, where the amplitude solve comes from its zeroth, and nothing in the shipped
    // code computes it at all — the shader has no erf in it and substrate.ts uses erf only
    // to scale an amplitude. So this is the model predicting a number the implementation
    // never mentions, which is a different and much better test than checking that the code
    // agrees with itself.
    const predicted = k.len / erf(k.len / (2 * k.radius));
    console.log(`  sink centroid    x ${k.sink.x.toFixed(3)}  z ${k.sink.z.toFixed(3)}`);
    console.log(`  centroid separation ${k.separation.toFixed(3)} m — the model says len/erf(len/2r) = ${predicted.toFixed(3)} m, not the ${k.len.toFixed(3)} m asked`);
    if (Math.abs(k.separation - predicted) > result.texel * 2) {
        console.log(`  FAIL: centroids ${Math.abs(k.separation - predicted).toFixed(3)} m from where the kernel's first moment puts them`);
        bad++;
    }
    console.log(`  bearing: asked ${deg(result.bearing)} deg, measured ${deg(k.measured)} deg`);
    console.log(`  field is clean beyond the lobes: max stray depression ${k.stray.toExponential(2)} m`);

    // NEUTRALITY IS THE CHEAP CLAIM — the kernel is odd about the bisector, so it holds by
    // construction and would survive any amount of wrongness in the amplitude solve.
    if (Math.abs(k.net) > k.volume * 0.01) {
        console.log(`  FAIL: not volume-neutral — ${k.net.toExponential(2)} m3 appeared from nowhere`);
        bad++;
    }
    // THE VOLUME IS THE REAL ONE. Without the erf correction this reads erf(len/2r) —
    // 99.5% for the long case, which is why the long case alone would not have caught it,
    // and 52% for the short one.
    if (Math.abs(ratio - 1) > 0.03) {
        console.log(`  FAIL: delivered ${(ratio * 100).toFixed(1)}% of the asked volume — the amplitude solve is off by 1/${naive.toFixed(3)}`);
        bad++;
    }
    // THE DIRECTION, which every volume check above is blind to.
    let dAng = k.measured - result.bearing;
    while (dAng > Math.PI) dAng -= 2 * Math.PI;
    while (dAng < -Math.PI) dAng += 2 * Math.PI;
    if (Math.abs(dAng) > 0.02) {
        console.log(`  FAIL: transported along ${deg(k.measured)} deg, ${deg(dAng)} deg off the bearing it was given`);
        bad++;
    }
    if (k.stray > 1e-4) {
        console.log(`  FAIL: something other than the shove is writing depression`);
        bad++;
    }
}

console.log("");
if (result.dropped > 0) {
    console.log(`FAIL: the substrate queue dropped ${result.dropped} stamps`);
    bad++;
}
if (bad === 0) {
    console.log("ok — the shove moves the volume it is given, along the bearing it is given,");
    console.log("and creates nothing. Directional transport is real.");
} else {
    console.log(`${bad} failure(s)`);
    process.exitCode = 1;
}
