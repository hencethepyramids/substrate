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
     *
     * `base` is a snapshot taken before the operation, or null. Measuring the DIFFERENCE is
     * what lets a shove be measured on ground that is not flat — which pass E needs, because
     * the whole question there is what a shove does differently when there is already loose
     * material lying where it bites.
     */
    const reduce = (data, base, origin, flip) => {
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
                const i = (row * size + col) * 4;
                const d = base === null ? data[i] : data[i] - base[i];
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
    const strayMax = (data, base, origin, flip, cx, cz, keepOut) => {
        let worst = 0;
        for (let row = 0; row < size; row++) {
            const r = flip ? size - 1 - row : row;
            const wz = origin.y + (r + 0.5) * texel;
            for (let col = 0; col < size; col++) {
                const i = (row * size + col) * 4;
                const d = base === null ? data[i] : data[i] - base[i];
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
    const calStraight = reduce(calData, null, origin, false);
    const calFlipped = reduce(calData, null, origin, true);
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
        // ON FULLY LOOSE GROUND, since pass E. These two cases exist to test the AMPLITUDE
        // SOLVE — that the erf correction makes "half a cubic metre" true at any
        // displacement — and the gate would otherwise scale both answers by the element's
        // cohesion and hide the thing being measured. A broad shallow layer of loose
        // material puts srMobile at 1 across both lobes, so what is left is the arithmetic.
        // The gate itself is measured separately, at the bottom.
        app.substrate.scoop(midX, midZ, 6.0, -0.1 * Math.PI * 36);
        for (let i = 0; i < 4; i++) await wait();
        const before = await settle();
        app.substrate.shove(fromX, fromZ, g.radius, vx, vz, g.volume);
        const data = await settle();
        const m = reduce(data, before, origin, flip);

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
            // THE BEARING THE SUBSTRATE WAS ACTUALLY ASKED FOR, which since pass E is not
            // quite the one the caller named. shove() snaps the displacement to whole texels
            // so the sink can read the source's state without filtering, and a 1.2 m
            // displacement on a 6.25 cm grid cannot land on an arbitrary angle — it is off
            // by up to 1.5 degrees by construction. Recomputed here from the texel size
            // rather than taken from the code under test, and reported alongside the asked
            // bearing so the snap is visible instead of hidden in a tolerance.
            snapped: Math.atan2(Math.round(vz / texel) * texel, Math.round(vx / texel) * texel),
            measured: m.source && m.sink ? Math.atan2(m.sink.z - m.source.z, m.sink.x - m.source.x) : null,
            separation: m.source && m.sink ? Math.hypot(m.sink.x - m.source.x, m.sink.z - m.source.z) : null,
            stray: strayMax(data, before, origin, flip, midX, midZ, g.len * 0.5 + g.radius * 4),
        });
    }

    // -- the verbs -------------------------------------------------------------------
    //
    // Pass A proved the substrate can carry material along a bearing. This asks the
    // separate question pass B is responsible for: does the SWEEP hand it the bearing the
    // character is actually facing?
    //
    // That wiring is the classic silent failure — forward is (sin, cos) of the facing angle
    // here, and a shader, a gait and a camera rig in this project each have their own
    // opinion about which way round that goes. Swap the pair or flip a sign and the verb
    // still sweeps, still conserves, still reads 100% of its volume, and pushes the drift
    // sideways instead of away from you. Nothing but a bearing measurement finds it.
    //
    // DRIVEN THROUGH THE REAL VERB LAYER WITH A SYNTHETIC ACTOR AND AN EXPLICIT dt, which
    // is the whole trick here. The world stays paused, so the frame loop feeds the verbs a
    // dt of zero and they do nothing; calling update() directly with a dt of our own runs
    // the shipped code path — real settings, real reach, real facing convention — against a
    // buffer that nothing else is touching. Verbs.update takes an Actor interface rather
    // than the Mover for exactly this reason, so no character has to be moved to test it.
    const idle = { ignite: false, gather: false, place: false, pack: false, raise: false, lower: false, pedestal: false, throwIt: false, sweep: false, draw: false };
    const reach = app.settings.get("play.reach");
    const sweepLen = app.settings.get("play.sweepDistance");
    const verbs = [];
    for (const heading of [0, 90, 180, 270, 35]) {
        const facing = (heading * Math.PI) / 180;
        // Deliberately NOT the window centre, and never the origin: a verb that ignored the
        // actor's position entirely would land on the centre and look correct there.
        const actor = { position: { x: midX + 1.7, y: 0, z: midZ - 1.1 }, facing, airborne: false };
        const fwd = { x: Math.sin(facing), z: Math.cos(facing) };

        for (const which of ["sweep", "draw"]) {
            app.substrate.reset();
            await wait();
            app.verbs.update({ ...idle, [which]: true }, actor, 0.4);
            const data = await settle();
            const m = reduce(data, null, origin, flip);
            if (m.source === null || m.sink === null) {
                verbs.push({ heading, which, empty: true });
                continue;
            }
            verbs.push({
                heading,
                which,
                lifted: m.lifted,
                net: m.net,
                measured: Math.atan2(m.sink.z - m.source.z, m.sink.x - m.source.x),
                // Away from the character for a sweep, back toward them for a draw.
                // Snapped exactly as the geometry cases are: the verb hands shove() a
                // displacement in metres and shove() puts it on the texel grid.
                expected: (() => {
                    const s = which === "sweep" ? 1 : -1;
                    const dx = Math.round((s * fwd.x * sweepLen) / texel) * texel;
                    const dz = Math.round((s * fwd.z * sweepLen) / texel) * texel;
                    return Math.atan2(dz, dx);
                })(),
                // THE MIDPOINT IS EXACT. The kernel is antisymmetric about its centre, so
                // whatever the overlap does to each lobe's centre of mass it does equally to
                // both, and the two centroids straddle the stamp centre exactly. Both verbs
                // put that centre one reach plus half a throw ahead of the character —
                // which is also what says the sweep started from the actor rather than from
                // wherever the window happened to be.
                mid: { x: (m.source.x + m.sink.x) * 0.5, z: (m.source.z + m.sink.z) * 0.5 },
                wantMid: { x: actor.position.x + fwd.x * (reach + sweepLen * 0.5), z: actor.position.z + fwd.z * (reach + sweepLen * 0.5) },
            });
        }
    }

    // -- the gate --------------------------------------------------------------------
    //
    // Pass E stops a shove from carrying bare ground as willingly as a drift. The decision is
    // made per texel in the relaxation, because it has to be: verbs.ts picks where to sweep
    // a frame earlier, on the CPU, and cannot see what is lying there.
    //
    // TWO CLAIMS, AND THEY PULL IN OPPOSITE DIRECTIONS. The shove must now deliver LESS than
    // it was asked for over ground that resists — and it must still deliver exactly what it
    // lifted, whatever the ground decides. A gate that broke conservation would be easy to
    // write and impossible to spot: the sweep would just quietly mine material.
    //
    // Measured against the element rather than against a number typed in here. Undisturbed
    // ground gives up (1 - cohesion) of the rate, so snow at 0.82 should deliver about a
    // fifth of what desert at 0.02 does through the identical call — and ground already
    // carrying loose material should deliver all of it in either.
    const gate = [];
    for (const biome of ["snow", "desert"]) {
        app.settings.set("world.biome", biome);
        await sleep(300);
        const cohesion = app.substrate._element.substrate.cohesion;
        for (const loose of [false, true]) {
            app.substrate.reset();
            await wait();
            if (loose) {
                // A broad shallow layer of loose material over the whole bite. Wide on
                // purpose: the mass has to be flat across the source lobe, or the measurement
                // reads the edge of the deposit rather than the gate.
                app.substrate.scoop(midX, midZ, 3.0, -0.1 * Math.PI * 9);
                for (let i = 0; i < 4; i++) await wait();
            }
            // The baseline is taken AFTER the deposit, so the difference is the shove alone.
            const before = await settle();
            app.substrate.shove(midX - 0.8, midZ - 0.4, 1.0, 1.6, 0.8, 0.4);
            const after = await settle();
            const m = reduce(after, before, origin, flip);
            gate.push({ biome, cohesion, loose, lifted: m.lifted, dropped: m.dropped, net: m.net, asked: 0.4 });
        }
    }

    // -- does the error compound? ----------------------------------------------------
    //
    // THE QUESTION THAT ACTUALLY MATTERS, and the one a single shove cannot answer. Pass A's
    // kernel evaluated both lobes in the SAME invocation, so their float32 rounding cancelled
    // and a shove conserved to 1e-15. Pass E's gather cannot: the sink reads a mobility from
    // another texel, so the two ends are computed by different invocations and the net now
    // wanders a fraction of a percent either way.
    //
    // A fraction of a percent per shove is harmless noise or a runaway, depending entirely on
    // whether it has a sign. Sweep is HELD — sixty shoves a second — so a biased error
    // compounds into a world that quietly breeds or eats material, which is precisely the
    // failure checkConserve.mjs exists to catch. Twenty shoves in a row, and the test is
    // whether the total drifts twenty times as far as one does or stays put.
    app.settings.set("world.biome", "snow");
    await sleep(300);
    app.substrate.reset();
    await wait();
    const compound = [];
    let moved = 0;
    for (let i = 1; i <= 20; i++) {
        app.substrate.shove(midX - 0.8, midZ - 0.4, 1.0, 1.6, 0.8, 0.1);
        moved += 0.1;
        for (let k = 0; k < 3; k++) await wait();
        if (i === 1 || i === 5 || i === 10 || i === 20) {
            const m = reduce(await settle(), null, origin, flip);
            compound.push({ n: i, net: m.net, lifted: m.lifted, asked: moved });
        }
    }

    return { size, extent, texel, origin, bearing, calibration, cases, verbs, gate, compound, sweptTotal: app.verbs.swept, steps: app.substrate.steps, dropped: app.substrate.dropped };
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
    console.log(`  bearing: asked ${deg(result.bearing)} deg, snapped to ${deg(k.snapped)} deg by the texel grid, measured ${deg(k.measured)} deg`);
    console.log(`  field is clean beyond the lobes: max stray depression ${k.stray.toExponential(2)} m`);

    // NEUTRALITY IS THE CHEAP CLAIM — the kernel is odd about the bisector, so it holds by
    // construction and would survive any amount of wrongness in the amplitude solve.
    if (Math.abs(k.net) > k.volume * 0.015) {
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
    let dAng = k.measured - k.snapped;
    while (dAng > Math.PI) dAng -= 2 * Math.PI;
    while (dAng < -Math.PI) dAng += 2 * Math.PI;
    if (Math.abs(dAng) > 0.02) {
        console.log(`  FAIL: transported along ${deg(k.measured)} deg, ${deg(dAng)} deg off the SNAPPED bearing it was given`);
        bad++;
    }
    if (k.stray > 1e-4) {
        console.log(`  FAIL: something other than the shove is writing depression`);
        bad++;
    }
}

console.log("");
console.log("THE VERBS — does the sweep carry material along the bearing the character faces?");
console.log(`  ${result.sweptTotal.toFixed(3)} m3 ASKED for across the headings below — what the ground actually gave up is the gate section`);
for (const v of result.verbs) {
    if (v.empty) {
        console.log(`  ${String(v.heading).padStart(3)} deg ${v.which.padEnd(5)}  FAIL: moved nothing at all`);
        bad++;
        continue;
    }
    let dAng = v.measured - v.expected;
    while (dAng > Math.PI) dAng -= 2 * Math.PI;
    while (dAng < -Math.PI) dAng += 2 * Math.PI;
    const midErr = Math.hypot(v.mid.x - v.wantMid.x, v.mid.z - v.wantMid.z);
    const ok = Math.abs(dAng) <= 0.02 && midErr <= result.texel * 3 && Math.abs(v.net) <= v.lifted * 0.015;
    console.log(
        `  ${String(v.heading).padStart(3)} deg ${v.which.padEnd(5)}  carried ${v.lifted.toFixed(4)} m3 along ${deg(v.measured).padStart(7)} deg ` +
            `(wanted ${deg(v.expected).padStart(7)}, off ${deg(dAng).padStart(6)})  net ${(v.net/v.lifted*100).toFixed(3)}%  centre ${midErr < 0.01 ? "exact" : `${(midErr * 100).toFixed(1)} cm out`}   ${ok ? "ok" : "FAIL"}`,
    );
    if (!ok) bad++;
}

console.log("");
console.log("THE GATE — does a shove take less from ground that holds together?");
for (const g of result.gate) {
    const frac = g.lifted / g.asked;
    // Undisturbed ground moves at (1 - cohesion); ground already carrying loose material
    // moves at the full rate. Both come from the element, not from this script.
    const want = g.loose ? 1 : 1 - g.cohesion;
    const conserved = Math.abs(g.net) <= Math.max(g.lifted, 1e-9) * 0.01;
    const ok = Math.abs(frac - want) <= 0.08 && conserved;
    console.log(
        `  ${g.biome.padEnd(7)} cohesion ${String(g.cohesion).padEnd(5)} ${(g.loose ? "loose" : "bare").padEnd(5)}  ` +
            `moved ${g.lifted.toFixed(4)} of ${g.asked} m3 = ${(frac * 100).toFixed(1)}%  (element says ${(want * 100).toFixed(0)}%)  ` +
            `net ${g.net.toExponential(1)}  ${ok ? "ok" : "FAIL"}`,
    );
    if (!ok) bad++;
}
const bare = result.gate.filter((g) => !g.loose);
if (bare.length === 2 && bare[0].lifted > 1e-9) {
    console.log(`  -> bare desert moves ${(bare[1].lifted / bare[0].lifted).toFixed(2)}x what bare snow does through the identical call`);
}

console.log("");
console.log("DOES IT COMPOUND? — twenty held shoves, which is a third of a second of sweeping");
for (const c of result.compound) {
    console.log(`  after ${String(c.n).padStart(2)}: net ${c.net.toExponential(2)} m3 against ${c.lifted.toFixed(4)} m3 standing (${((c.net / Math.max(c.lifted, 1e-9)) * 100).toFixed(2)}%)`);
}
if (result.compound.length >= 2) {
    const first = result.compound[0];
    const last = result.compound[result.compound.length - 1];
    // A BIASED error grows with the number of shoves; noise does not. Twenty shoves is
    // twenty times the opportunity, so a per-shove bias would show up as roughly twenty
    // times the first net rather than as the same number wandering.
    const growth = Math.abs(last.net) / Math.max(Math.abs(first.net), 1e-12);
    console.log(`  -> ${last.n}x the shoves moved the net by ${growth.toFixed(1)}x — a per-shove bias would be about ${last.n}x`);
    // THE THRESHOLD IS NOT A TASTE JUDGEMENT. checkConserve.mjs already fixed this
    // project's standard: material lost to an open boundary is a tuning matter, material
    // CREATED compounds and is a runaway. Pass A conserved to 1e-15 — fifteen orders
    // better than this — so any steady signed drift here is a regression against a property
    // that was previously exact, not merely a small number.
    const rate = last.net / Math.max(last.lifted, 1e-12);
    if (Math.abs(rate) > 0.001) {
        console.log(`  FAIL: ${(Math.abs(rate) * 100).toFixed(2)}% of what is standing was ${rate < 0 ? "CREATED" : "lost"}, and it grew with the shove count.`);
        console.log(`        Pass A conserved this to 1e-15. The gather formulation does not, and a held`);
        console.log(`        sweep runs sixty of these a second.`);
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
